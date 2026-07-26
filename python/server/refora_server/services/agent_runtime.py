from __future__ import annotations

import asyncio
import inspect
import json
import os
import sqlite3
import time
import uuid
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.serde.base import SerializerProtocol
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver

from refora_server.academic.types import ACADEMIC_RESEARCH_TOOL_NAMES
from refora_server.agent.engine import RunStateMachine
from refora_server.agent.engine_schema import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_INTERRUPTED,
    RUN_STATUS_QUEUED,
    RUN_STATUS_RUNNING,
    TRACE_STATUS_CANCELLED,
    TRACE_STATUS_DONE,
    TRACE_STATUS_ERROR,
    TRACE_STATUS_INTERRUPTED,
    TRACE_STATUS_RUNNING,
    is_terminal_run,
    protocol_status,
)
from refora_server.services.agent_memory import MAX_MEMORY_FILE_CHARS, normalize_memory_path
from refora_server.services.chat_history import parseToolPayload


_SECRET_KEYS = {"apiKey", "api_key", "authorization", "Authorization"}
_ACADEMIC_TOOL_NAMES = frozenset(ACADEMIC_RESEARCH_TOOL_NAMES)
ACADEMIC_PERSISTENCE_REDACTION = (
    "[Academic research data omitted from persistent agent state]"
)


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _truncate(value: Any, limit: int = 4000) -> str | None:
    if value is None:
        return None
    text = _as_text(value)
    return text if len(text) <= limit else text[:limit]


def _without_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key in _SECRET_KEYS else _without_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_without_secrets(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_without_secrets(item) for item in value)
    return value


def _academic_call_name(value: Any) -> str | None:
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    name = mapping.get("name")
    if isinstance(name, str) and name in _ACADEMIC_TOOL_NAMES:
        return name
    function = mapping.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        if isinstance(name, str) and name in _ACADEMIC_TOOL_NAMES:
            return name
    return None


def _collect_academic_tool_call_ids(value: Any, result: set[str], seen: set[int]) -> None:
    if value is None or isinstance(value, (str, int, float, bool, bytes)):
        return
    identity = id(value)
    if identity in seen:
        return
    seen.add(identity)
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    if _academic_call_name(mapping):
        call_id = mapping.get("id") or mapping.get("tool_call_id")
        if isinstance(call_id, str):
            result.add(call_id)
    if isinstance(value, dict):
        values = value.values()
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = (
            getattr(value, name, None)
            for name in (
                "content",
                "tool_calls",
                "invalid_tool_calls",
                "additional_kwargs",
                "response_metadata",
            )
        )
    for item in values:
        _collect_academic_tool_call_ids(item, result, seen)


def _sanitize_academic_checkpoint_value(value: Any) -> Any:
    academic_ids: set[str] = set()
    _collect_academic_tool_call_ids(value, academic_ids, set())

    def sanitize(current: Any) -> Any:
        if isinstance(current, ToolMessage):
            if (
                current.name in _ACADEMIC_TOOL_NAMES
                or current.tool_call_id in academic_ids
            ):
                return current.model_copy(
                    update={
                        "content": ACADEMIC_PERSISTENCE_REDACTION,
                        "artifact": None,
                    }
                )
            return current
        if isinstance(current, AIMessage):
            return current.model_copy(
                update={
                    "content": sanitize(current.content),
                    "tool_calls": sanitize(current.tool_calls),
                    "invalid_tool_calls": sanitize(current.invalid_tool_calls),
                    "additional_kwargs": sanitize(current.additional_kwargs),
                    "response_metadata": sanitize(current.response_metadata),
                }
            )
        if isinstance(current, list):
            return [sanitize(item) for item in current]
        if isinstance(current, tuple):
            return tuple(sanitize(item) for item in current)
        if not isinstance(current, dict):
            return current
        if _academic_call_name(current):
            redacted = {key: sanitize(item) for key, item in current.items()}
            if "args" in redacted:
                redacted["args"] = {"omitted": True}
            if "input" in redacted:
                redacted["input"] = {"omitted": True}
            if "arguments" in redacted:
                redacted["arguments"] = json.dumps({"omitted": True})
            if "output" in redacted:
                redacted["output"] = ACADEMIC_PERSISTENCE_REDACTION
            if "result" in redacted:
                redacted["result"] = ACADEMIC_PERSISTENCE_REDACTION
            function = redacted.get("function")
            if isinstance(function, dict):
                redacted["function"] = {
                    **function,
                    "arguments": json.dumps({"omitted": True}),
                }
            return redacted
        return {key: sanitize(item) for key, item in current.items()}

    return sanitize(value)


class AcademicRedactingSerializer(SerializerProtocol):
    def __init__(self) -> None:
        self._delegate = JsonPlusSerializer()

    def dumps_typed(self, obj: Any) -> tuple[str, bytes]:
        return self._delegate.dumps_typed(_sanitize_academic_checkpoint_value(obj))

    def loads_typed(self, data: tuple[str, bytes]) -> Any:
        return self._delegate.loads_typed(data)


def _checkpoint_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    direct = value.get("checkpointId") or value.get("checkpoint_id")
    if isinstance(direct, str) and direct:
        return direct
    config = value.get("config")
    if isinstance(config, dict):
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            checkpoint = configurable.get("checkpoint_id") or configurable.get("checkpointId")
            if isinstance(checkpoint, str) and checkpoint:
                return checkpoint
    return None


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(_message_text(part.get("text") if isinstance(part, dict) else part) for part in value)
    if isinstance(value, dict):
        return _message_text(value.get("text") or value.get("content"))
    content = getattr(value, "content", None)
    return _message_text(content) if content is not None else ""


def _result_text(result: Any) -> str:
    if isinstance(result, dict):
        messages = result.get("messages")
        if isinstance(messages, list) and messages:
            return _message_text(messages[-1].get("content") if isinstance(messages[-1], dict) else messages[-1])
        for key in ("content", "text", "output"):
            if key in result:
                return _message_text(result[key])
    return _message_text(result)


def _tool_history_records(result: Any, state: dict[str, Any]) -> list[dict[str, str | None]]:
    sources = [result]
    values = state.get("values") if isinstance(state, dict) else None
    if isinstance(values, dict):
        sources.append(values)
    calls: dict[str, dict[str, str | None]] = {}
    records: list[dict[str, str | None]] = []
    for source in sources:
        messages = source.get("messages") if isinstance(source, dict) else None
        if not isinstance(messages, list):
            continue
        for message in messages:
            mapping = message if isinstance(message, dict) else _as_mapping(message)
            role = (
                mapping.get("role") or mapping.get("type")
                if mapping
                else getattr(message, "role", None) or getattr(message, "type", None)
            )
            if role in {"assistant", "ai", "AIMessage"}:
                tool_calls = mapping.get("tool_calls") or getattr(message, "tool_calls", None)
                if isinstance(tool_calls, list):
                    for tool_call in tool_calls:
                        call = tool_call if isinstance(tool_call, dict) else _as_mapping(tool_call)
                        call_id = call.get("id")
                        name = call.get("name")
                        if not isinstance(call_id, str) or not isinstance(name, str):
                            continue
                        calls[call_id] = {
                            "name": name,
                            "toolCallId": call_id,
                            "input": _as_text(call.get("args")),
                            "output": None,
                        }
                continue
            if role not in {"tool", "ToolMessage"}:
                continue
            call_id = (
                mapping.get("tool_call_id")
                or mapping.get("toolCallId")
                or getattr(message, "tool_call_id", None)
            )
            name = mapping.get("name") or getattr(message, "name", None)
            if not isinstance(call_id, str) or not call_id:
                continue
            record = dict(calls.get(call_id) or {})
            if isinstance(name, str):
                record["name"] = name
            if record.get("name") in _ACADEMIC_TOOL_NAMES:
                continue
            record["toolCallId"] = call_id
            record["output"] = _message_text(
                mapping.get("content")
                if mapping
                else getattr(message, "content", None)
            )
            if isinstance(record.get("name"), str):
                records.append(record)
    return records


def _tool_event_name(event: dict[str, Any]) -> str | None:
    data = event.get("data")
    data = data if isinstance(data, dict) else {}
    name = event.get("name") or data.get("name")
    return name if isinstance(name, str) and name else None


def _tool_event_key(event: dict[str, Any], name: str | None) -> str:
    run_id = event.get("run_id")
    if isinstance(run_id, str) and run_id:
        return run_id
    return f"tool-name:{name or 'unknown'}"


def _tool_event_values(event: dict[str, Any]) -> tuple[Any, Any]:
    data = event.get("data")
    data = data if isinstance(data, dict) else {}
    raw_input = data.get("input", data.get("inputs"))
    if isinstance(raw_input, dict) and set(raw_input).issubset(
        {"input", "tool_call_id", "id", "name"}
    ):
        raw_input = raw_input.get("input")
    raw_output = data.get("output", data.get("outputs", data.get("error")))
    return raw_input, raw_output


def _tool_event_record(event: dict[str, Any]) -> dict[str, str | None] | None:
    data = event.get("data")
    data = data if isinstance(data, dict) else {}
    name = _tool_event_name(event)
    if name is None or name in _ACADEMIC_TOOL_NAMES:
        return None
    raw_input, raw_output = _tool_event_values(event)
    raw_input = _without_secrets(raw_input)
    raw_output = _without_secrets(raw_output)
    output_mapping = raw_output if isinstance(raw_output, dict) else _as_mapping(raw_output)
    call_id = data.get("tool_call_id")
    if not isinstance(call_id, str) and isinstance(data.get("input"), dict):
        call_id = data["input"].get("tool_call_id")
    if not isinstance(call_id, str) and output_mapping:
        call_id = output_mapping.get("tool_call_id") or output_mapping.get("toolCallId")
    if not isinstance(call_id, str):
        call_id = data.get("id")
    if not isinstance(call_id, str):
        call_id = event.get("run_id")
    if not isinstance(call_id, str) or not call_id:
        call_id = str(uuid.uuid4())
    output = (
        _message_text(output_mapping.get("content"))
        if output_mapping and "content" in output_mapping
        else _as_text(raw_output)
    )
    return {
        "name": name,
        "toolCallId": call_id,
        "input": _as_text(raw_input) if raw_input is not None else None,
        "output": output,
    }


def _persist_tool_history(
    repos: dict[str, Any],
    thread_id: str,
    records: list[dict[str, str | None]],
) -> None:
    persisted_ids = {
        parsed["toolCallId"]
        for row in repos["chat"]["listMessages"](thread_id)
        if row.get("role") == "tool"
        for parsed in [parseToolPayload(row.get("content") or "")]
        if isinstance(parsed.get("toolCallId"), str)
    }
    for record in records:
        tool_call_id = record.get("toolCallId")
        name = record.get("name")
        if (
            not isinstance(tool_call_id, str)
            or not isinstance(name, str)
            or name in _ACADEMIC_TOOL_NAMES
            or tool_call_id in persisted_ids
        ):
            continue
        repos["chat"]["addMessage"](
            thread_id,
            "tool",
            json.dumps(
                {
                    "v": 2,
                    "name": name,
                    "toolCallId": tool_call_id,
                    "input": record.get("input"),
                    "output": record.get("output"),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        persisted_ids.add(tool_call_id)


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    return {}


def _serializable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_serializable(item) for item in value]
    data = _as_mapping(value)
    if data:
        return _serializable(data)
    content = getattr(value, "content", None)
    if content is not None:
        result = {"content": _serializable(content)}
        message_type = getattr(value, "type", None)
        if isinstance(message_type, str):
            result["type"] = message_type
        return result
    return str(value)


def _state_snapshot(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    config = _serializable(getattr(value, "config", {}))
    values = _serializable(getattr(value, "values", {}))
    tasks: list[dict[str, Any]] = []
    for task in getattr(value, "tasks", ()):
        interrupts: list[dict[str, Any]] = []
        for interrupt in getattr(task, "interrupts", ()):
            interrupt_value = _serializable(getattr(interrupt, "value", interrupt))
            interrupt_id = getattr(interrupt, "id", None)
            entry: dict[str, Any] = {"value": interrupt_value}
            if isinstance(interrupt_id, str):
                entry["id"] = interrupt_id
            interrupts.append(entry)
        entry = {"interrupts": interrupts}
        for name in ("id", "name"):
            item = getattr(task, name, None)
            if isinstance(item, str):
                entry[name] = item
        tasks.append(entry)
    result: dict[str, Any] = {
        "config": config if isinstance(config, dict) else {},
        "values": values if isinstance(values, dict) else {},
        "tasks": tasks,
    }
    next_nodes = getattr(value, "next", ())
    if isinstance(next_nodes, (list, tuple)):
        result["next"] = [node for node in next_nodes if isinstance(node, str)]
    return result


def _interrupt_actions(state: Any) -> list[dict[str, Any]]:
    if not isinstance(state, dict):
        return []
    actions: list[dict[str, Any]] = []
    for task in state.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        for interrupt in task.get("interrupts") or []:
            value = interrupt.get("value") if isinstance(interrupt, dict) else None
            if not isinstance(value, dict):
                continue
            requests = value.get("actionRequests") or value.get("action_requests") or []
            configs = value.get("reviewConfigs") or value.get("review_configs") or []
            for index, request in enumerate(requests):
                if not isinstance(request, dict) or not isinstance(request.get("name"), str):
                    continue
                config = configs[index] if index < len(configs) and isinstance(configs[index], dict) else {}
                allowed = config.get("allowedDecisions") or config.get("allowed_decisions")
                decisions = [value for value in allowed if value in {"approve", "edit", "reject"}] if isinstance(allowed, list) else ["approve", "reject"]
                action = {
                    "name": request["name"],
                    "args": request.get("args") if isinstance(request.get("args"), dict) else {},
                    "allowedDecisions": decisions,
                }
                if isinstance(request.get("description"), str):
                    action["description"] = request["description"]
                actions.append(action)
    return actions


def _resume_decision(
    decision: Any,
    action: dict[str, Any],
    workspace_id: str | None,
) -> dict[str, Any]:
    if not isinstance(decision, dict):
        raise ValueError("Interrupt decision must be an object")
    decision_type = decision.get("type")
    if decision_type not in action.get("allowedDecisions", []):
        raise ValueError("Interrupt decision is not allowed")
    if decision_type != "edit":
        return {"type": decision_type}
    edited_action = decision.get("editedAction") or decision.get("edited_action")
    if not isinstance(edited_action, dict):
        raise ValueError("Edited approval requires an edited action")
    if edited_action.get("name") != action.get("name"):
        raise ValueError("Edited approval cannot change the action name")
    args = edited_action.get("args")
    if not isinstance(args, dict):
        raise ValueError("Edited approval arguments must be an object")
    if edited_action["name"] == "propose_workspace_memory_update":
        if set(args) != {"path", "content", "rationale"}:
            raise ValueError("Edited memory proposal arguments are invalid")
        normalize_memory_path(args.get("path"), workspace_id)
        content = args.get("content")
        rationale = args.get("rationale")
        if not isinstance(content, str) or len(content) > MAX_MEMORY_FILE_CHARS:
            raise ValueError("Edited memory proposal content is invalid")
        if (
            not isinstance(rationale, str)
            or not rationale.strip()
            or len(rationale) > 1000
        ):
            raise ValueError("Edited memory proposal rationale is invalid")
    return {
        "type": "edit",
        "edited_action": {
            "name": edited_action["name"],
            "args": dict(args),
        },
    }


def _event_delta(event: dict[str, Any], reasoning: bool) -> str:
    keys = ("reasoning", "reasoning_content", "thinking", "delta") if reasoning else ("delta", "token", "content", "text")
    for key in keys:
        value = event.get(key)
        if isinstance(value, str):
            return value
    data = event.get("data")
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, str):
                return value
        chunk = data.get("chunk") or data.get("output")
        if isinstance(chunk, dict):
            additional = chunk.get("additional_kwargs")
            if reasoning and isinstance(additional, dict):
                value = additional.get("reasoning_content")
                if isinstance(value, str):
                    return value
            return _message_text(chunk.get("content"))
        if chunk is not None:
            additional = getattr(chunk, "additional_kwargs", None)
            if reasoning and isinstance(additional, dict):
                value = additional.get("reasoning_content")
                if isinstance(value, str):
                    return value
            return _message_text(chunk)
    return ""


def createAgentRuntime(repos: dict[str, Any], deps: dict[str, Any] | None = None):
    deps = deps or {}
    active: dict[str, dict[str, Any]] = {}
    background_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
    resume_contexts: dict[str, dict[str, Any]] = {}
    clock: Callable[[], int] = deps.get("clock") or _now_ms
    create_tools = deps.get("createTools") or deps.get("create_tools")
    create_model = deps.get("createModel") or deps.get("create_model")
    create_agent = deps.get("createAgent") or deps.get("create_agent")
    stream_factory = deps.get("stream")
    emit = deps.get("emit")
    logger = deps.get("logger")
    cancel_run = deps.get("cancelRun") or deps.get("cancel_run")
    finish_run = deps.get("finishRun") or deps.get("finish_run")
    state_machine = RunStateMachine(repos["agentRuns"], repos["agentTraces"], clock)

    async def emit_event(name: str, payload: dict[str, Any]) -> None:
        safe_payload = _without_secrets(_serializable(payload))
        try:
            if emit is not None:
                await _await(emit(name, safe_payload))
            callback = deps.get("on" + "".join(part.title() for part in name.split(".")))
            if callback is not None:
                await _await(callback(safe_payload))
        except Exception:
            return

    def warn(message: str) -> None:
        if logger is not None:
            try:
                logger.warning(message)
            except Exception:
                return

    async def emit_status(run_id: str, status: str) -> None:
        run = repos["agentRuns"]["get"](run_id)
        payload = {"runId": run_id, "status": protocol_status(status)}
        if run is not None:
            payload["threadId"] = run["threadId"]
        await emit_event("ai.chat.run-status", payload)

    async def emit_trace(request: dict[str, Any], step: dict[str, Any]) -> None:
        await emit_event(
            "ai.chat.trace",
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "step": _without_secrets(step),
            },
        )

    def add_trace(
        request: dict[str, Any],
        seq: int,
        kind: str,
        name: str | None,
        status: str,
        data: Any = None,
        checkpoint: str | None = None,
        input_data: Any = None,
    ) -> dict[str, Any]:
        safe_data = (
            ACADEMIC_PERSISTENCE_REDACTION
            if name in _ACADEMIC_TOOL_NAMES
            else _without_secrets(data)
        )
        safe_input = (
            None
            if name in _ACADEMIC_TOOL_NAMES
            else _without_secrets(input_data)
        )
        return repos["agentTraces"]["addStep"](
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "kind": kind,
                "name": name,
                "input": _truncate(safe_input),
                "output": _truncate(safe_data),
                "status": status,
                "startedAt": clock(),
                "endedAt": clock() if status != TRACE_STATUS_RUNNING else None,
                "seq": seq,
                "checkpointId": checkpoint,
            }
        )

    def close_open_traces(run_id: str, status: str, message: str) -> None:
        for step in repos["agentTraces"]["listByRun"](run_id):
            if step.get("status") == TRACE_STATUS_RUNNING:
                repos["agentTraces"]["updateStep"](
                    step["id"], {"status": status, "output": _truncate(message), "endedAt": clock()}
                )

    async def create_runtime_agent(request: dict[str, Any]) -> Any:
        if create_tools is None:
            raise RuntimeError("createTools dependency is not configured")
        tools = await _await(create_tools(request))
        provider = dict(request.get("provider") or {})
        model = await _await(create_model(provider)) if create_model is not None else None
        if create_agent is None:
            raise RuntimeError("createAgent dependency is not configured")
        return await _await(create_agent(model, tools, request))

    def runtime_config(request: dict[str, Any]) -> dict[str, Any]:
        configurable = {"thread_id": request["threadId"]}
        checkpoint = request.get("checkpointBefore")
        if isinstance(checkpoint, str) and checkpoint:
            configurable["checkpoint_id"] = checkpoint
        return {
            "configurable": configurable,
            "recursion_limit": int(request.get("recursionLimit") or 50),
        }

    def configure_checkpoint(agent: Any, request: dict[str, Any]) -> sqlite3.Connection | None:
        checkpoint_path = request.get("checkpointPath")
        if not isinstance(checkpoint_path, str) or not checkpoint_path:
            return None
        if getattr(agent, "checkpointer", None) is not None:
            return None
        try:
            parent = os.path.dirname(os.path.abspath(checkpoint_path))
            os.makedirs(parent, mode=0o700, exist_ok=True)
            connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
            agent.checkpointer = SqliteSaver(
                connection,
                serde=AcademicRedactingSerializer(),
            )
            return connection
        except (AttributeError, OSError, sqlite3.Error):
            return None

    async def agent_state(agent: Any, request: dict[str, Any]) -> dict[str, Any]:
        for method_name in ("aget_state", "get_state"):
            method = getattr(agent, method_name, None)
            if not callable(method):
                continue
            try:
                return _state_snapshot(await _await(method(runtime_config(request))))
            except Exception:
                continue
        return {}

    async def event_stream(agent: Any, request: dict[str, Any], mode: str) -> AsyncIterable[Any]:
        if stream_factory is not None:
            return await _await(stream_factory(agent, request, mode))
        if hasattr(agent, "astream_events"):
            invocation: Any = {"messages": request.get("messages") or []}
            if mode == "resume":
                invocation = {"resume": {"decisions": request.get("decisions") or []}}
            return agent.astream_events(
                invocation, config=runtime_config(request), version="v2"
            )
        if hasattr(agent, "stream"):
            return await _await(agent.stream(request, mode))
        raise RuntimeError("Agent does not provide a stream")

    async def finish_interrupted(request: dict[str, Any], state: dict[str, Any], run_trace: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        actions = _interrupt_actions(state)
        trace_steps = repos["agentTraces"]["listByRun"](run_id)
        matched_actions: set[str] = set()
        for step in trace_steps:
            if step.get("kind") != "tool" or step.get("status") != TRACE_STATUS_RUNNING:
                continue
            updated = repos["agentTraces"]["updateStep"](
                step["id"],
                {
                    "status": TRACE_STATUS_INTERRUPTED,
                    "output": "Awaiting user approval",
                    "endedAt": clock(),
                },
            )
            if updated is not None:
                if isinstance(updated.get("name"), str):
                    matched_actions.add(updated["name"])
                await emit_trace(request, updated)
        next_seq = max((int(step.get("seq") or 0) for step in trace_steps), default=0) + 1
        for action in actions:
            if action["name"] in matched_actions:
                continue
            step = add_trace(
                request,
                next_seq,
                "tool",
                action["name"],
                TRACE_STATUS_INTERRUPTED,
                "Awaiting user approval",
                checkpoint,
                action.get("args"),
            )
            await emit_trace(request, step)
            next_seq += 1
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_INTERRUPTED,
            {"checkpointAfter": checkpoint, "endedAt": clock()},
            run_trace,
            trace_output="Interrupted",
        )
        interrupt = repos["agentInterrupts"]["create"](
            {"runId": run_id, "threadId": request["threadId"], "checkpointId": checkpoint, "actions": actions}
        )
        await emit_event(
            "ai.chat.interrupted",
            {
                "runId": run_id,
                "threadId": request["threadId"],
                "interrupt": interrupt,
            },
        )
        await emit_status(run_id, RUN_STATUS_INTERRUPTED)
        return {"runId": run_id, "status": RUN_STATUS_INTERRUPTED, "interrupt": interrupt, "state": state}

    async def finish_completed(
        request: dict[str, Any],
        result: Any,
        state: dict[str, Any],
        run_trace: dict[str, Any],
        tool_history: list[dict[str, str | None]],
    ) -> dict[str, Any]:
        run_id = request["runId"]
        text = _result_text(result)
        _persist_tool_history(
            repos,
            request["threadId"],
            [*tool_history, *_tool_history_records(result, state)],
        )
        message = repos["chat"]["addMessage"](request["threadId"], "assistant", text)
        checkpoint = _checkpoint_id(state) or request.get("checkpointBefore")
        repos["chat"]["updateAgentState"](request["threadId"], checkpoint, int(deps.get("agentStateVersion", 1)))
        run, _trace = state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_COMPLETED,
            {
                "checkpointAfter": checkpoint,
                "assistantMessageId": message["id"],
                "endedAt": clock(),
            },
            run_trace,
            trace_output=_truncate(text),
        )
        title = None
        title_source = deps.get("generateTitle") or deps.get("generate_title")
        thread = repos["chat"]["getThread"](request["threadId"])
        if title_source is not None and thread and not thread.get("title"):
            candidate = await _await(title_source(request["threadId"], dict(request.get("provider") or {})))
            if isinstance(candidate, str) and candidate.strip():
                title = candidate.strip()[:100]
                repos["chat"]["updateTitle"](request["threadId"], title)
                await emit_event("ai.chat.title-updated", {"threadId": request["threadId"], "title": title})
        await emit_event(
            "ai.chat.done",
            {"runId": run_id, "threadId": request["threadId"], "finalText": text},
        )
        await emit_status(run_id, RUN_STATUS_COMPLETED)
        return {"runId": run_id, "status": RUN_STATUS_COMPLETED, "run": run, "result": result, "state": state, "title": title}

    async def terminalize(request: dict[str, Any], status: str, error: str, run_trace: dict[str, Any] | None) -> dict[str, Any]:
        run_id = request["runId"]
        close_open_traces(run_id, TRACE_STATUS_CANCELLED if status == RUN_STATUS_CANCELLED else TRACE_STATUS_ERROR, error)
        current = RUN_STATUS_RUNNING
        if run_trace is None:
            persisted = repos["agentRuns"]["get"](run_id)
            current = persisted["status"] if persisted else current
        run, _trace = state_machine.transition(
            run_id,
            current,
            status,
            {"endedAt": clock(), "error": error},
            run_trace,
            trace_output=_truncate(error),
        )
        if status == RUN_STATUS_FAILED:
            await emit_event(
                "ai.chat.error",
                {"runId": run_id, "threadId": request["threadId"], "message": error},
            )
        if status == RUN_STATUS_CANCELLED:
            await emit_event(
                "ai.chat.done",
                {
                    "runId": run_id,
                    "threadId": request["threadId"],
                    "finalText": "[Response cancelled by user]",
                },
            )
        await emit_status(run_id, status)
        return {"runId": run_id, "status": status, "run": run, "error": error}

    async def restore_interrupted(
        request: dict[str, Any],
        error: str,
        run_trace: dict[str, Any],
    ) -> dict[str, Any]:
        run_id = request["runId"]
        close_open_traces(run_id, TRACE_STATUS_ERROR, error)
        run, _trace = state_machine.transition(
            run_id,
            RUN_STATUS_RUNNING,
            RUN_STATUS_INTERRUPTED,
            {"endedAt": None, "error": error},
            run_trace,
            trace_output=_truncate(error),
        )
        await emit_event(
            "ai.chat.error",
            {"runId": run_id, "threadId": request["threadId"], "message": error},
        )
        await emit_status(run_id, RUN_STATUS_INTERRUPTED)
        return {
            "runId": run_id,
            "status": RUN_STATUS_INTERRUPTED,
            "run": run,
            "error": error,
        }

    async def run(request: dict[str, Any], mode: str = "send", existing_run: bool = False) -> dict[str, Any]:
        request = dict(request)
        run_id = request.get("runId")
        thread_id = request.get("threadId")
        if not isinstance(run_id, str) or not run_id or not isinstance(thread_id, str) or not thread_id:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "runId and threadId are required"}
        thread = repos["chat"]["getThread"](thread_id)
        if thread is None:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "Thread not found"}
        provider = request.get("provider") if isinstance(request.get("provider"), dict) else {}
        model = provider.get("model") if isinstance(provider.get("model"), str) else ""
        control = {"cancelled": False, "agent": None}
        active[run_id] = control
        user_message = None
        run_trace: dict[str, Any] | None = None
        checkpoint_connection: sqlite3.Connection | None = None
        tool_history: list[dict[str, str | None]] = []
        open_tool_traces: dict[str, str] = {}
        try:
            if not existing_run:
                resume_contexts[run_id] = {
                    key: value
                    for key, value in request.items()
                    if key not in {"messages", "decisions"}
                }
                for message in reversed(request.get("messages") or []):
                    if isinstance(message, dict) and message.get("role") in {"user", "human"}:
                        content = _message_text(message.get("content"))
                        if content:
                            user_message = repos["chat"]["addMessage"](thread_id, "user", content)
                        break
                repos["agentRuns"]["create"](
                    {
                        "id": run_id,
                        "threadId": thread_id,
                        "providerId": thread["providerId"],
                        "modelId": model,
                        "status": RUN_STATUS_QUEUED,
                        "checkpointBefore": request.get("checkpointBefore"),
                        "replacesRunId": request.get("replaceRunId"),
                        "userMessageId": user_message["id"] if user_message else None,
                        "startedAt": clock(),
                    }
                )
                await emit_status(run_id, RUN_STATUS_QUEUED)
            persisted = repos["agentRuns"]["get"](run_id)
            current_status = persisted["status"] if persisted else RUN_STATUS_QUEUED
            state_machine.transition(run_id, current_status, RUN_STATUS_RUNNING, {"endedAt": None, "error": None})
            await emit_status(run_id, RUN_STATUS_RUNNING)
            run_trace = add_trace(request, 0, "run", "agent", TRACE_STATUS_RUNNING, checkpoint=request.get("checkpointBefore"))
            agent = await create_runtime_agent(request)
            control["agent"] = agent
            checkpoint_connection = configure_checkpoint(agent, request)
            stream = await event_stream(agent, request, mode)
            if not isinstance(stream, AsyncIterable):
                if not isinstance(stream, Iterable):
                    raise RuntimeError("Agent stream is not iterable")
                events: AsyncIterable[Any] = _iterate(stream)
            else:
                events = stream
            seq = 1
            result: Any = None
            state: dict[str, Any] = {}
            interrupted = False
            async for raw in events:
                if control["cancelled"]:
                    return await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", run_trace)
                event = raw if isinstance(raw, dict) else {"event": "trace", "data": raw}
                event_name = str(event.get("event") or event.get("type") or "")
                if event_name in {"token", "on_chat_model_stream"}:
                    delta = _event_delta(event, False)
                    if delta:
                        await emit_event(
                            "ai.chat.token",
                            {"runId": run_id, "threadId": thread_id, "token": delta},
                        )
                    continue
                if event_name in {"reasoning", "thinking"}:
                    delta = _event_delta(event, True)
                    if delta:
                        await emit_event(
                            "ai.chat.reasoning",
                            {"runId": run_id, "threadId": thread_id, "token": delta},
                        )
                    continue
                if event_name in {"done", "complete", "result"}:
                    result = event.get("result", event.get("data"))
                    candidate_state = event.get("state")
                    if isinstance(candidate_state, dict):
                        state = candidate_state
                    continue
                if event_name == "on_chain_end":
                    data = event.get("data")
                    if isinstance(data, dict) and data.get("output") is not None:
                        result = data["output"]
                if event_name == "on_tool_start":
                    name = _tool_event_name(event)
                    trace_input, _ = _tool_event_values(event)
                    step = add_trace(
                        request,
                        seq,
                        "tool",
                        name,
                        TRACE_STATUS_RUNNING,
                        checkpoint=_checkpoint_id(event),
                        input_data=trace_input,
                    )
                    open_tool_traces[_tool_event_key(event, name)] = step["id"]
                    await emit_trace(request, step)
                    seq += 1
                    continue
                if event_name == "on_tool_end":
                    record = _tool_event_record(event)
                    if record is not None:
                        tool_history.append(record)
                    name = _tool_event_name(event)
                    _, trace_output = _tool_event_values(event)
                    safe_output = (
                        ACADEMIC_PERSISTENCE_REDACTION
                        if name in _ACADEMIC_TOOL_NAMES
                        else _without_secrets(trace_output)
                    )
                    trace_id = open_tool_traces.pop(
                        _tool_event_key(event, name),
                        None,
                    )
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {
                                "status": TRACE_STATUS_DONE,
                                "output": _truncate(safe_output),
                                "endedAt": clock(),
                            },
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "tool",
                            name,
                            TRACE_STATUS_DONE,
                            trace_output,
                            _checkpoint_id(event),
                        )
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    continue
                if event_name == "on_tool_error":
                    record = _tool_event_record(event)
                    if record is not None:
                        tool_history.append(record)
                    name = _tool_event_name(event)
                    _, trace_output = _tool_event_values(event)
                    detail = event.get("error") or trace_output or event.get("data") or "Agent execution failed"
                    safe_output = (
                        ACADEMIC_PERSISTENCE_REDACTION
                        if name in _ACADEMIC_TOOL_NAMES
                        else _without_secrets(detail)
                    )
                    trace_id = open_tool_traces.pop(
                        _tool_event_key(event, name),
                        None,
                    )
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {
                                "status": TRACE_STATUS_ERROR,
                                "output": _truncate(safe_output),
                                "endedAt": clock(),
                            },
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "tool",
                            name,
                            TRACE_STATUS_ERROR,
                            detail,
                            _checkpoint_id(event),
                        )
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    raise RuntimeError(_as_text(detail))
                if event_name in {"error", "on_chain_error"}:
                    detail = event.get("error") or event.get("data") or "Agent execution failed"
                    raise RuntimeError(_as_text(detail))
                if event_name in {"interrupted", "interrupt"}:
                    candidate_state = event.get("state") or event.get("data")
                    state = candidate_state if isinstance(candidate_state, dict) else state
                    interrupted = True
                    continue
                if event_name in {"title-updated", "title_updated"}:
                    data = event.get("data")
                    title = event.get("title")
                    if not isinstance(title, str) and isinstance(data, dict):
                        title = data.get("title")
                    if isinstance(title, str) and title.strip():
                        repos["chat"]["updateTitle"](thread_id, title.strip()[:100])
                        await emit_event("ai.chat.title-updated", {"threadId": thread_id, "title": title.strip()[:100]})
                    continue
                checkpoint = _checkpoint_id(event)
                step = add_trace(
                    request,
                    seq,
                    "tool" if "tool" in event_name else "llm",
                    event.get("name")
                    if isinstance(event.get("name"), str)
                    else event_name or "agent",
                    TRACE_STATUS_DONE,
                    event.get("data"),
                    checkpoint,
                )
                await emit_trace(request, step)
                seq += 1
            if control["cancelled"]:
                return await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", run_trace)
            snapshot = await agent_state(agent, request)
            if snapshot:
                state = snapshot
                values = snapshot.get("values")
                if isinstance(values, dict) and values.get("messages"):
                    result = values
            interrupt_id = request.get("resolveInterruptId")
            if isinstance(interrupt_id, str) and interrupt_id:
                repos["agentInterrupts"]["resolve"](
                    interrupt_id,
                    request.get("resolveInterruptDecisions") or [],
                )
            if interrupted or _interrupt_actions(state):
                return await finish_interrupted(request, state, run_trace)
            return await finish_completed(request, result, state, run_trace, tool_history)
        except asyncio.CancelledError:
            return await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", run_trace)
        except Exception as error:
            message = _as_text(error)
            api_key = provider.get("apiKey") if isinstance(provider, dict) else None
            if isinstance(api_key, str) and api_key:
                message = message.replace(api_key, "[redacted]")
            warn(f"agent runtime failed run={run_id}")
            if (
                mode == "resume"
                and isinstance(request.get("resolveInterruptId"), str)
                and run_trace is not None
                and not control["cancelled"]
            ):
                return await restore_interrupted(
                    request,
                    message or "Agent resume failed",
                    run_trace,
                )
            return await terminalize(request, RUN_STATUS_CANCELLED if control["cancelled"] else RUN_STATUS_FAILED, message or "Agent execution failed", run_trace)
        finally:
            active.pop(run_id, None)
            if finish_run is not None:
                try:
                    await _await(finish_run(run_id))
                except Exception:
                    pass
            if checkpoint_connection is not None:
                checkpoint_connection.close()
            persisted = repos["agentRuns"]["get"](run_id)
            if persisted is None or persisted.get("status") != RUN_STATUS_INTERRUPTED:
                resume_contexts.pop(run_id, None)

    async def send(request: dict[str, Any]) -> dict[str, Any]:
        return await run(request, "send")

    async def start(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(send(request))
        background_tasks[run_id] = task
        task.add_done_callback(lambda completed, rid=run_id: background_tasks.pop(rid, None))
        await asyncio.sleep(0)
        return {"runId": run_id, "threadId": request["threadId"]}

    async def resume(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "runId is required"}
        persisted = repos["agentRuns"]["get"](run_id)
        interrupt = repos["agentInterrupts"]["getPendingByRun"](run_id)
        if persisted is None or interrupt is None:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "No pending interrupt for run"}
        decisions = request.get("decisions")
        if not isinstance(decisions, list) or len(decisions) != len(interrupt["actions"]):
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "Interrupt decisions do not match pending actions"}
        thread = repos["chat"]["getThread"](persisted["threadId"])
        try:
            normalized_decisions = [
                _resume_decision(
                    decision,
                    action,
                    thread.get("workspaceId") if thread else None,
                )
                for decision, action in zip(decisions, interrupt["actions"])
            ]
        except ValueError as error:
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": str(error)}
        stored = resume_contexts.get(run_id, {})
        request = {
            **stored,
            **request,
            "decisions": normalized_decisions,
            "resolveInterruptId": interrupt["id"],
            "resolveInterruptDecisions": decisions,
            "threadId": persisted["threadId"],
            "workspaceId": stored.get("workspaceId")
            if "workspaceId" in stored
            else (thread.get("workspaceId") if thread else None),
            "checkpointBefore": interrupt.get("checkpointId")
            or persisted.get("checkpointAfter"),
        }
        return await run(request, "resume", existing_run=True)

    async def start_resume(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(resume(request))
        background_tasks[run_id] = task
        task.add_done_callback(lambda completed, rid=run_id: background_tasks.pop(rid, None))
        await asyncio.sleep(0)
        return {"runId": run_id}

    async def cancel(run_id: str) -> dict[str, Any]:
        if cancel_run is not None:
            try:
                await _await(cancel_run(run_id))
            except Exception:
                pass
        control = active.get(run_id)
        if control is None:
            run = repos["agentRuns"]["get"](run_id)
            if run is None or is_terminal_run(run["status"]):
                return {"runId": run_id, "cancelled": False}
            request = {"runId": run_id, "threadId": run["threadId"]}
            await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", None)
            resume_contexts.pop(run_id, None)
            return {"runId": run_id, "cancelled": True}
        control["cancelled"] = True
        agent = control.get("agent")
        for method_name in ("cancel", "abort", "aclose"):
            method = getattr(agent, method_name, None)
            if callable(method):
                try:
                    await _await(method())
                except Exception:
                    pass
                break
        return {"runId": run_id, "cancelled": True}

    async def delete_thread(thread_id: str) -> None:
        runs = repos["agentRuns"]["listByThread"](thread_id)
        run_ids = [
            run["id"]
            for run in runs
            if isinstance(run.get("id"), str)
        ]
        for run_id in run_ids:
            if run_id in background_tasks or run_id in active:
                await cancel(run_id)
        tasks = [
            background_tasks[run_id]
            for run_id in run_ids
            if run_id in background_tasks
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for run_id in run_ids:
            background_tasks.pop(run_id, None)
            resume_contexts.pop(run_id, None)

        checkpoint_path = deps.get("checkpointPath") or deps.get("checkpoint_path")
        if not isinstance(checkpoint_path, str) or not os.path.isfile(checkpoint_path):
            return
        connection = sqlite3.connect(checkpoint_path)
        try:
            connection.execute("PRAGMA busy_timeout = 5000")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if not {"checkpoints", "writes"}.issubset(tables):
                return
            with connection:
                connection.execute(
                    "DELETE FROM writes WHERE thread_id = ?",
                    [thread_id],
                )
                connection.execute(
                    "DELETE FROM checkpoints WHERE thread_id = ?",
                    [thread_id],
                )
        finally:
            connection.close()

    async def destroy() -> None:
        for run_id, control in active.items():
            control["cancelled"] = True
            if cancel_run is not None:
                try:
                    await _await(cancel_run(run_id))
                except Exception:
                    pass
        tasks = list(background_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        background_tasks.clear()
        resume_contexts.clear()

    return {
        "send": send,
        "start": start,
        "run": run,
        "resume": resume,
        "startResume": start_resume,
        "cancel": cancel,
        "deleteThread": delete_thread,
        "destroy": destroy,
    }


async def _iterate(values: Iterable[Any]):
    for value in values:
        yield value
