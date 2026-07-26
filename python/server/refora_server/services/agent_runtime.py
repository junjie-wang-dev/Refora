from __future__ import annotations

import asyncio
import inspect
import json
import os
import sqlite3
import time
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any

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
    TRACE_STATUS_RUNNING,
    is_terminal_run,
    protocol_status,
)
from langgraph.checkpoint.sqlite import SqliteSaver


_SECRET_KEYS = {"apiKey", "api_key", "authorization", "Authorization"}


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


def _tool_message_texts(result: Any, state: dict[str, Any]) -> list[str]:
    sources = [result]
    values = state.get("values") if isinstance(state, dict) else None
    if isinstance(values, dict):
        sources.append(values)
    texts: list[str] = []
    for source in sources:
        messages = source.get("messages") if isinstance(source, dict) else None
        if not isinstance(messages, list):
            continue
        for message in messages:
            role = (
                message.get("role") or message.get("type")
                if isinstance(message, dict)
                else getattr(message, "role", None) or getattr(message, "type", None)
            )
            if role not in {"tool", "ToolMessage"}:
                continue
            text = _message_text(
                message.get("content")
                if isinstance(message, dict)
                else getattr(message, "content", None)
            )
            if text and text not in texts:
                texts.append(text)
    return texts


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
    resume_contexts: dict[str, dict[str, Any]] = {}
    clock: Callable[[], int] = deps.get("clock") or _now_ms
    create_tools = deps.get("createTools") or deps.get("create_tools")
    create_model = deps.get("createModel") or deps.get("create_model")
    create_agent = deps.get("createAgent") or deps.get("create_agent")
    stream_factory = deps.get("stream")
    emit = deps.get("emit")
    logger = deps.get("logger")
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
        await emit_event("ai.chat.run-status", {"runId": run_id, "status": protocol_status(status)})

    async def emit_trace(request: dict[str, Any], event: dict[str, Any]) -> None:
        await emit_event(
            "ai.chat.trace",
            {
                "runId": request["runId"],
                "name": event.get("name") if isinstance(event.get("name"), str) else "agent",
                "parentIds": [value for value in event.get("parent_ids", event.get("parentIds", [])) if isinstance(value, str)],
                "data": _without_secrets(event.get("data") if isinstance(event.get("data"), dict) else {}),
                "tags": [value for value in event.get("tags", []) if isinstance(value, str)],
                "metadata": _without_secrets(event.get("metadata") if isinstance(event.get("metadata"), dict) else {}),
            },
        )

    def add_trace(request: dict[str, Any], seq: int, kind: str, name: str | None, status: str, data: Any = None, checkpoint: str | None = None) -> dict[str, Any]:
        return repos["agentTraces"]["addStep"](
            {
                "threadId": request["threadId"],
                "runId": request["runId"],
                "kind": kind,
                "name": name,
                "input": None,
                "output": _truncate(_without_secrets(data)),
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
            agent.checkpointer = SqliteSaver(connection)
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
        await emit_event("ai.chat.interrupted", {"runId": run_id, "threadId": request["threadId"]})
        await emit_status(run_id, RUN_STATUS_INTERRUPTED)
        return {"runId": run_id, "status": RUN_STATUS_INTERRUPTED, "interrupt": interrupt, "state": state}

    async def finish_completed(request: dict[str, Any], result: Any, state: dict[str, Any], run_trace: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        text = _result_text(result)
        for tool_text in _tool_message_texts(result, state):
            repos["chat"]["addMessage"](request["threadId"], "tool", tool_text)
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
        await emit_event("ai.chat.done", {"runId": run_id, "threadId": request["threadId"], "result": _without_secrets(result), "state": _without_secrets(state)})
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
            await emit_event("ai.chat.error", {"runId": run_id, "threadId": request["threadId"], "error": {"code": "agent_failed", "message": error}})
        await emit_status(run_id, status)
        return {"runId": run_id, "status": status, "run": run, "error": error}

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
                        await emit_event("ai.chat.token", {"runId": run_id, "threadId": thread_id, "delta": delta})
                    continue
                if event_name in {"reasoning", "thinking"}:
                    delta = _event_delta(event, True)
                    if delta:
                        await emit_event("ai.chat.reasoning", {"runId": run_id, "threadId": thread_id, "delta": delta})
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
                if event_name in {"error", "on_chain_error", "on_tool_error"}:
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
                await emit_trace(request, event)
                checkpoint = _checkpoint_id(event)
                add_trace(request, seq, "tool" if "tool" in event_name else "model", event.get("name") if isinstance(event.get("name"), str) else event_name or "agent", TRACE_STATUS_DONE, event.get("data"), checkpoint)
                seq += 1
            if control["cancelled"]:
                return await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", run_trace)
            snapshot = await agent_state(agent, request)
            if snapshot:
                state = snapshot
                values = snapshot.get("values")
                if isinstance(values, dict) and values.get("messages"):
                    result = values
            if interrupted or _interrupt_actions(state):
                return await finish_interrupted(request, state, run_trace)
            return await finish_completed(request, result, state, run_trace)
        except asyncio.CancelledError:
            return await terminalize(request, RUN_STATUS_CANCELLED, "Cancelled", run_trace)
        except Exception as error:
            message = _as_text(error)
            api_key = provider.get("apiKey") if isinstance(provider, dict) else None
            if isinstance(api_key, str) and api_key:
                message = message.replace(api_key, "[redacted]")
            warn(f"agent runtime failed run={run_id}")
            return await terminalize(request, RUN_STATUS_CANCELLED if control["cancelled"] else RUN_STATUS_FAILED, message or "Agent execution failed", run_trace)
        finally:
            active.pop(run_id, None)
            if checkpoint_connection is not None:
                checkpoint_connection.close()
            persisted = repos["agentRuns"]["get"](run_id)
            if persisted is None or persisted.get("status") != RUN_STATUS_INTERRUPTED:
                resume_contexts.pop(run_id, None)

    async def send(request: dict[str, Any]) -> dict[str, Any]:
        return await run(request, "send")

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
        for decision, action in zip(decisions, interrupt["actions"]):
            decision_type = decision.get("type") if isinstance(decision, dict) else None
            if decision_type not in action.get("allowedDecisions", []):
                return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": "Interrupt decision is not allowed"}
        repos["agentInterrupts"]["resolve"](interrupt["id"], decisions)
        stored = resume_contexts.get(run_id, {})
        thread = repos["chat"]["getThread"](persisted["threadId"])
        request = {
            **stored,
            **request,
            "threadId": persisted["threadId"],
            "workspaceId": stored.get("workspaceId")
            if "workspaceId" in stored
            else (thread.get("workspaceId") if thread else None),
            "checkpointBefore": interrupt.get("checkpointId")
            or persisted.get("checkpointAfter"),
        }
        return await run(request, "resume", existing_run=True)

    async def cancel(run_id: str) -> dict[str, Any]:
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

    def destroy() -> None:
        for control in active.values():
            control["cancelled"] = True
        resume_contexts.clear()

    return {"send": send, "run": run, "resume": resume, "cancel": cancel, "destroy": destroy}


async def _iterate(values: Iterable[Any]):
    for value in values:
        yield value
