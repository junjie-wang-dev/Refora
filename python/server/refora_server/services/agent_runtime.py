from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import sqlite3
import time
import uuid
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any

import aiosqlite
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.serde.base import SerializerProtocol
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from refora_server.academic.types import ACADEMIC_RESEARCH_TOOL_NAMES
from refora_server.agent.academic_artifacts import (
    ACADEMIC_ARTIFACT_MARKER_KEY,
    AcademicArtifactStore,
    academic_artifact_id_from_marker,
)
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
    def __init__(self, artifact_store: AcademicArtifactStore | None = None) -> None:
        self._delegate = JsonPlusSerializer()
        self._artifact_store = artifact_store

    def dumps_typed(self, obj: Any) -> tuple[str, bytes]:
        if self._artifact_store is None:
            return self._delegate.dumps_typed(_sanitize_academic_checkpoint_value(obj))
        return self._delegate.dumps_typed(
            _externalize_academic_checkpoint_value(
                obj, self._delegate, self._artifact_store
            )
        )

    def loads_typed(self, data: tuple[str, bytes]) -> Any:
        value = self._delegate.loads_typed(data)
        if self._artifact_store is None:
            return value
        return _hydrate_academic_checkpoint_value(
            value, self._delegate, self._artifact_store
        )


def _academic_message_marker(value: Any) -> str | None:
    if not isinstance(value, (AIMessage, ToolMessage)):
        return None
    metadata = value.response_metadata
    marker = metadata.get(ACADEMIC_ARTIFACT_MARKER_KEY) if isinstance(metadata, dict) else None
    return marker if academic_artifact_id_from_marker(marker) is not None else None


def _with_academic_message_marker(value: AIMessage | ToolMessage, marker: str) -> Any:
    metadata = {
        **(value.response_metadata if isinstance(value.response_metadata, dict) else {}),
        ACADEMIC_ARTIFACT_MARKER_KEY: marker,
    }
    return value.model_copy(update={"response_metadata": metadata})


def _without_academic_message_marker(value: AIMessage | ToolMessage) -> Any:
    metadata = dict(value.response_metadata or {})
    metadata.pop(ACADEMIC_ARTIFACT_MARKER_KEY, None)
    return value.model_copy(update={"response_metadata": metadata})


def _has_academic_checkpoint_value(
    value: Any, academic_ids: set[str], seen: set[int] | None = None
) -> bool:
    if value is None or isinstance(value, (str, int, float, bool, bytes)):
        return False
    seen = seen if seen is not None else set()
    identity = id(value)
    if identity in seen:
        return False
    seen.add(identity)
    if isinstance(value, ToolMessage):
        return value.name in _ACADEMIC_TOOL_NAMES or value.tool_call_id in academic_ids
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    if _academic_call_name(mapping):
        return True
    tool_call_id = mapping.get("tool_call_id") or mapping.get("toolCallId")
    if isinstance(tool_call_id, str) and tool_call_id in academic_ids:
        return True
    if isinstance(value, dict):
        values = value.values()
    elif isinstance(value, (list, tuple, set)):
        values = value
    elif isinstance(value, AIMessage):
        values = (
            value.content,
            value.tool_calls,
            value.invalid_tool_calls,
            value.additional_kwargs,
            value.response_metadata,
        )
    else:
        return False
    return any(_has_academic_checkpoint_value(item, academic_ids, seen) for item in values)


def _externalize_academic_checkpoint_value(
    value: Any, delegate: JsonPlusSerializer, artifact_store: AcademicArtifactStore
) -> Any:
    academic_ids: set[str] = set()
    _collect_academic_tool_call_ids(value, academic_ids, set())

    def store(current: Any) -> str:
        type_name, data = delegate.dumps_typed(current)
        return artifact_store.write(type_name, data)

    def visit(current: Any) -> Any:
        if isinstance(current, ToolMessage):
            if current.name in _ACADEMIC_TOOL_NAMES or current.tool_call_id in academic_ids:
                return _with_academic_message_marker(
                    _sanitize_academic_checkpoint_value(current), store(current)
                )
            return current
        if isinstance(current, AIMessage):
            if not _has_academic_checkpoint_value(current, academic_ids):
                return current
            return _with_academic_message_marker(
                _sanitize_academic_checkpoint_value(current), store(current)
            )
        if isinstance(current, list):
            return [visit(item) for item in current]
        if isinstance(current, tuple):
            return tuple(visit(item) for item in current)
        if not isinstance(current, dict):
            return current
        if _academic_call_name(current):
            return {
                ACADEMIC_ARTIFACT_MARKER_KEY: store(current),
                "fallback": _sanitize_academic_checkpoint_value(current),
            }
        return {key: visit(item) for key, item in current.items()}

    return visit(value)


def _hydrate_academic_checkpoint_value(
    value: Any, delegate: JsonPlusSerializer, artifact_store: AcademicArtifactStore
) -> Any:
    def load(marker: str) -> Any | None:
        stored = artifact_store.read(marker)
        return delegate.loads_typed((stored.type, stored.data)) if stored else None

    def visit(current: Any) -> Any:
        marker = _academic_message_marker(current)
        if marker is not None:
            restored = load(marker)
            return (
                restored
                if restored is not None
                else _without_academic_message_marker(current)
            )
        if isinstance(current, list):
            return [visit(item) for item in current]
        if isinstance(current, tuple):
            return tuple(visit(item) for item in current)
        if not isinstance(current, dict):
            return current
        marker = current.get(ACADEMIC_ARTIFACT_MARKER_KEY)
        if academic_artifact_id_from_marker(marker) is not None and "fallback" in current:
            restored = load(marker)
            return restored if restored is not None else visit(current["fallback"])
        return {key: visit(item) for key, item in current.items()}

    return visit(value)


_ACADEMIC_ARTIFACT_MARKER_RE = re.compile(
    r"refora-academic-artifact:v1:([a-f0-9]{64})"
)


def _checkpoint_artifact_root(checkpoint_path: str) -> str:
    return os.path.join(
        os.path.dirname(os.path.abspath(checkpoint_path)), "academic-artifacts"
    )


def _artifact_ids_in_checkpoint_database(
    checkpoint_path: str, thread_id: str | None = None
) -> set[str]:
    if not os.path.isfile(checkpoint_path):
        return set()
    connection = sqlite3.connect(checkpoint_path)
    try:
        ids: set[str] = set()
        for table, column in (
            ("checkpoints", "checkpoint"),
            ("checkpoints", "metadata"),
            ("writes", "value"),
        ):
            columns = {
                row[1]
                for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if column not in columns:
                continue
            query = f"SELECT {column} FROM {table}"
            values: list[object] = []
            if thread_id is not None and "thread_id" in columns:
                query += " WHERE thread_id = ?"
                values.append(thread_id)
            for (value,) in connection.execute(query, values):
                if isinstance(value, str):
                    text = value
                elif isinstance(value, bytes):
                    text = value.decode("utf-8", errors="ignore")
                else:
                    continue
                ids.update(match.group(1) for match in _ACADEMIC_ARTIFACT_MARKER_RE.finditer(text))
        return ids
    except sqlite3.Error:
        return set()
    finally:
        connection.close()


def _prune_academic_artifacts(checkpoint_path: str) -> None:
    store = AcademicArtifactStore(_checkpoint_artifact_root(checkpoint_path))
    store.prune_artifacts(_artifact_ids_in_checkpoint_database(checkpoint_path))


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


def _event_key(event: dict[str, Any], name: str) -> str:
    run_id = event.get("run_id")
    if isinstance(run_id, str) and run_id:
        return run_id
    return f"{name}:{event.get('name') or 'unknown'}"


def _trace_context(
    event: dict[str, Any],
    open_event_traces: dict[str, str],
) -> dict[str, Any]:
    parent_ids = [
        value
        for value in event.get("parent_ids") or []
        if isinstance(value, str)
    ]
    parent_step_id = next(
        (
            open_event_traces[parent_id]
            for parent_id in reversed(parent_ids)
            if parent_id in open_event_traces
        ),
        None,
    )
    metadata = event.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    agent_name = metadata.get("lc_agent_name")
    namespace = metadata.get("langgraph_checkpoint_ns")
    return {
        "parentStepId": parent_step_id,
        "agentName": agent_name if isinstance(agent_name, str) else None,
        "namespace": namespace if isinstance(namespace, str) else None,
        "depth": len(parent_ids),
    }


def _subagent_name(event: dict[str, Any]) -> str | None:
    raw_input, _ = _tool_event_values(event)
    if not isinstance(raw_input, dict):
        return None
    for key in ("subagent_type", "agent", "agent_name", "name"):
        value = raw_input.get(key)
        if isinstance(value, str) and value:
            return value
    return None


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


def _tool_output_failed(value: Any) -> bool:
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    if mapping:
        status = mapping.get("status")
        if status == "error":
            return True
        content = mapping.get("content")
        if content is not None and content is not value:
            return _tool_output_failed(content)
        if mapping.get("error") is not None:
            return True
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
        return _tool_output_failed(decoded)
    return False


def _token_usage(value: Any, seen: set[int] | None = None) -> dict[str, int]:
    if value is None or isinstance(value, (str, int, float, bool, bytes)):
        return {}
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return {}
    seen.add(identity)
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    usage = mapping.get("usage_metadata") or mapping.get("usageMetadata")
    if usage is None:
        usage = getattr(value, "usage_metadata", None)
    usage_mapping = usage if isinstance(usage, dict) else _as_mapping(usage)
    if usage_mapping:
        aliases = {
            "inputTokens": ("input_tokens", "inputTokens", "prompt_tokens"),
            "outputTokens": ("output_tokens", "outputTokens", "completion_tokens"),
            "totalTokens": ("total_tokens", "totalTokens"),
        }
        result: dict[str, int] = {}
        for target, keys in aliases.items():
            token_count = next(
                (
                    usage_mapping[key]
                    for key in keys
                    if isinstance(usage_mapping.get(key), int)
                ),
                None,
            )
            if token_count is not None:
                result[target] = token_count
        if result:
            return result
    if isinstance(value, dict):
        children = value.values()
    elif isinstance(value, (list, tuple)):
        children = value
    else:
        children = (
            getattr(value, key, None)
            for key in ("message", "generations", "output", "chunk")
        )
    for child in children:
        result = _token_usage(child, seen)
        if result:
            return result
    return {}


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
    keys = (
        ("reasoning", "reasoning_content", "thinking")
        if reasoning
        else ("delta", "token", "content", "text")
    )
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
            return "" if reasoning else _message_text(chunk.get("content"))
        if chunk is not None:
            additional = getattr(chunk, "additional_kwargs", None)
            if reasoning and isinstance(additional, dict):
                value = additional.get("reasoning_content")
                if isinstance(value, str):
                    return value
            return "" if reasoning else _message_text(chunk)
    return ""


def createAgentRuntime(repos: dict[str, Any], deps: dict[str, Any] | None = None):
    deps = deps or {}
    configured_checkpoint_path = deps.get("checkpointPath") or deps.get("checkpoint_path")
    if isinstance(configured_checkpoint_path, str) and configured_checkpoint_path:
        try:
            _prune_academic_artifacts(configured_checkpoint_path)
        except OSError:
            pass
    active: dict[str, dict[str, Any]] = {}
    active_by_thread: dict[str, str] = {}
    background_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
    title_tasks: set[asyncio.Task[Any]] = set()
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
        payload = {"runId": run_id, "status": status}
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
        parent_step_id: str | None = None,
        agent_name: str | None = None,
        namespace: str | None = None,
        depth: int = 0,
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
                "parentStepId": parent_step_id,
                "agentName": agent_name,
                "namespace": namespace,
                "depth": depth,
                "checkpointId": checkpoint,
            }
        )

    def close_open_traces(run_id: str, status: str, message: str) -> None:
        for step in repos["agentTraces"]["listByRun"](run_id):
            if step.get("status") == TRACE_STATUS_RUNNING:
                repos["agentTraces"]["updateStep"](
                    step["id"],
                    {
                        "status": status,
                        "output": step.get("output") or _truncate(message),
                        "endedAt": clock(),
                    },
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
        if (
            request.get("recoverLatestCheckpoint") is not True
            and isinstance(checkpoint, str)
            and checkpoint
        ):
            configurable["checkpoint_id"] = checkpoint
        return {
            "configurable": configurable,
            "recursion_limit": int(request.get("recursionLimit") or 50),
        }

    async def configure_checkpoint(
        agent: Any, request: dict[str, Any]
    ) -> aiosqlite.Connection | None:
        checkpoint_path = request.get("checkpointPath")
        if not isinstance(checkpoint_path, str) or not checkpoint_path:
            return None
        if getattr(agent, "checkpointer", None) is not None:
            return None
        try:
            parent = os.path.dirname(os.path.abspath(checkpoint_path))
            os.makedirs(parent, mode=0o700, exist_ok=True)
            connection = await aiosqlite.connect(checkpoint_path)
            agent.checkpointer = AsyncSqliteSaver(
                connection,
                serde=AcademicRedactingSerializer(
                    AcademicArtifactStore(_checkpoint_artifact_root(checkpoint_path))
                ),
            )
            return connection
        except (AttributeError, OSError, aiosqlite.Error):
            return None

    async def agent_state(agent: Any, request: dict[str, Any]) -> dict[str, Any]:
        config = runtime_config(request)
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            configurable.pop("checkpoint_id", None)
        for method_name in ("aget_state", "get_state"):
            method = getattr(agent, method_name, None)
            if not callable(method):
                continue
            try:
                return _state_snapshot(await _await(method(config)))
            except Exception:
                continue
        return {}

    async def event_stream(agent: Any, request: dict[str, Any], mode: str) -> AsyncIterable[Any]:
        if stream_factory is not None:
            return await _await(stream_factory(agent, request, mode))
        if hasattr(agent, "astream_events"):
            invocation: Any = {"messages": request.get("messages") or []}
            if mode == "resume":
                invocation = Command(
                    resume={"decisions": request.get("decisions") or []}
                )
            elif mode == "recover":
                invocation = None
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
        partial: str = "",
    ) -> dict[str, Any]:
        run_id = request["runId"]
        text = _result_text(result) or partial or "No response generated."
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
        await emit_event(
            "ai.chat.done",
            {"runId": run_id, "threadId": request["threadId"], "finalText": text},
        )
        await emit_status(run_id, RUN_STATUS_COMPLETED)
        title_source = deps.get("generateTitle") or deps.get("generate_title")
        thread = repos["chat"]["getThread"](request["threadId"])
        if title_source is not None and thread and not thread.get("title"):
            async def generate_title() -> None:
                try:
                    candidate = await _await(
                        title_source(
                            request["threadId"],
                            dict(request.get("provider") or {}),
                        )
                    )
                    current_thread = repos["chat"]["getThread"](request["threadId"])
                    current_run = active_by_thread.get(request["threadId"])
                    if (
                        not isinstance(candidate, str)
                        or not candidate.strip()
                        or current_thread is None
                        or current_thread.get("title")
                        or current_run not in {None, run_id}
                    ):
                        return
                    resolved = candidate.strip()[:100]
                    repos["chat"]["updateTitle"](request["threadId"], resolved)
                    await emit_event(
                        "ai.chat.title-updated",
                        {"threadId": request["threadId"], "title": resolved},
                    )
                except Exception:
                    return

            task = asyncio.create_task(generate_title())
            title_tasks.add(task)
            task.add_done_callback(title_tasks.discard)
            await asyncio.sleep(0)
            if task.done() and not task.cancelled():
                try:
                    task.result()
                except Exception:
                    pass
                refreshed = repos["chat"]["getThread"](request["threadId"])
                title = refreshed.get("title") if refreshed else None
        return {
            "runId": run_id,
            "status": RUN_STATUS_COMPLETED,
            "run": run,
            "result": result,
            "state": state,
            "title": title,
        }

    async def terminalize(
        request: dict[str, Any],
        status: str,
        error: str,
        run_trace: dict[str, Any] | None,
        partial: str = "",
    ) -> dict[str, Any]:
        run_id = request["runId"]
        close_open_traces(run_id, TRACE_STATUS_CANCELLED if status == RUN_STATUS_CANCELLED else TRACE_STATUS_ERROR, error)
        current = RUN_STATUS_RUNNING
        if run_trace is None:
            persisted = repos["agentRuns"]["get"](run_id)
            current = persisted["status"] if persisted else current
        final_text = partial
        if final_text and status == RUN_STATUS_FAILED:
            final_text = f"{final_text}\n\n[Response interrupted: {error}]"
        if (
            not final_text
            and status == RUN_STATUS_CANCELLED
            and "newer run" not in error
        ):
            final_text = "[Response cancelled by user]"
        assistant_message = None
        if final_text:
            assistant_message = repos["chat"]["addMessage"](
                request["threadId"], "assistant", final_text
            )
        patch = {"endedAt": clock(), "error": error}
        if assistant_message is not None:
            patch["assistantMessageId"] = assistant_message["id"]
        run, _trace = state_machine.transition(
            run_id,
            current,
            status,
            patch,
            run_trace,
            trace_output=_truncate(final_text or error),
        )
        if status == RUN_STATUS_FAILED:
            error_payload = {
                "runId": run_id,
                "threadId": request["threadId"],
                "message": error,
            }
            if final_text:
                error_payload["partialText"] = final_text
            await emit_event(
                "ai.chat.error",
                error_payload,
            )
        if final_text:
            await emit_event(
                "ai.chat.done",
                {
                    "runId": run_id,
                    "threadId": request["threadId"],
                    "finalText": final_text,
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
        existing_active = active_by_thread.get(thread_id)
        if mode == "resume" and existing_active not in {None, run_id}:
            message = "Agent is already running for this conversation"
            await emit_event(
                "ai.chat.error",
                {"runId": run_id, "threadId": thread_id, "message": message},
            )
            await emit_status(run_id, RUN_STATUS_INTERRUPTED)
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        if mode == "send" and existing_active not in {None, run_id}:
            active_by_thread[thread_id] = run_id
            previous = active.get(existing_active)
            if previous is not None:
                previous["cancelled"] = True
                previous["stop_reason"] = "superseded"
                previous_agent = previous.get("agent")
                for method_name in ("cancel", "abort", "aclose"):
                    method = getattr(previous_agent, method_name, None)
                    if callable(method):
                        try:
                            await _await(method())
                        except Exception:
                            pass
                        break
                if cancel_run is not None:
                    try:
                        await _await(cancel_run(existing_active))
                    except Exception:
                        pass
        control = {
            "cancelled": False,
            "agent": None,
            "thread_id": thread_id,
            "stop_reason": None,
        }
        active[run_id] = control
        active_by_thread[thread_id] = run_id
        user_message = None
        run_trace: dict[str, Any] | None = None
        checkpoint_connection: aiosqlite.Connection | None = None
        tool_history: list[dict[str, str | None]] = []
        open_tool_traces: dict[str, str] = {}
        open_llm_traces: dict[str, str] = {}
        open_event_traces: dict[str, str] = {}
        partial_text = (
            "".join(
                step.get("output") or ""
                for step in repos["agentTraces"]["listByRun"](run_id)
                if step.get("kind") == "message"
            )
            if mode == "recover"
            else ""
        )

        def is_current() -> bool:
            return active_by_thread.get(thread_id) == run_id

        def llm_step_id(event: dict[str, Any]) -> str | None:
            direct = open_llm_traces.get(_event_key(event, "llm"))
            if direct is not None:
                return direct
            parent_ids = event.get("parent_ids")
            if isinstance(parent_ids, list):
                for parent_id in reversed(parent_ids):
                    if isinstance(parent_id, str) and parent_id in open_llm_traces:
                        return open_llm_traces[parent_id]
            return None

        try:
            if mode == "recover":
                close_open_traces(
                    run_id,
                    TRACE_STATUS_CANCELLED,
                    "Python sidecar restarted; continuing from the latest checkpoint",
                )
            if not existing_run:
                resume_contexts[run_id] = {
                    key: value
                    for key, value in request.items()
                    if key not in {"messages", "decisions"}
                }
                user_content = ""
                for message in reversed(request.get("messages") or []):
                    if isinstance(message, dict) and message.get("role") in {"user", "human"}:
                        user_content = _message_text(message.get("content"))
                        break

                def persist_new_run() -> None:
                    nonlocal user_message
                    if request.get("replaceLastExchange") is True:
                        repos["chat"]["deleteLastExchange"](thread_id)
                        replace_run_id = request.get("replaceRunId")
                        if isinstance(replace_run_id, str) and replace_run_id:
                            repos["agentTraces"]["deleteByRun"](
                                thread_id, replace_run_id
                            )
                        repos["chat"]["updateAgentState"](
                            thread_id,
                            request.get("checkpointBefore"),
                            int(deps.get("agentStateVersion", 1)),
                        )
                    if user_content:
                        user_message = repos["chat"]["addMessage"](
                            thread_id, "user", user_content
                        )
                    repos["agentRuns"]["create"](
                        {
                            "id": run_id,
                            "threadId": thread_id,
                            "providerId": request.get("providerId")
                            or thread["providerId"],
                            "modelId": model,
                            "status": RUN_STATUS_QUEUED,
                            "checkpointBefore": request.get("checkpointBefore"),
                            "replacesRunId": request.get("replaceRunId"),
                            "userMessageId": user_message["id"]
                            if user_message
                            else None,
                            "startedAt": clock(),
                        }
                    )

                transaction = repos.get("transaction")
                if callable(transaction):
                    transaction(persist_new_run)
                else:
                    persist_new_run()
                await emit_status(run_id, RUN_STATUS_QUEUED)
            persisted = repos["agentRuns"]["get"](run_id)
            current_status = persisted["status"] if persisted else RUN_STATUS_QUEUED
            state_machine.transition(run_id, current_status, RUN_STATUS_RUNNING, {"endedAt": None, "error": None})
            await emit_status(run_id, RUN_STATUS_RUNNING)
            run_trace = add_trace(request, 0, "run", "agent", TRACE_STATUS_RUNNING, checkpoint=request.get("checkpointBefore"))
            agent = await create_runtime_agent(request)
            control["agent"] = agent
            checkpoint_connection = await configure_checkpoint(agent, request)
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
            active_content: dict[str, Any] | None = None

            async def finish_active_content(
                status: str = TRACE_STATUS_DONE,
            ) -> None:
                nonlocal active_content
                if active_content is None:
                    return
                step = repos["agentTraces"]["updateStep"](
                    active_content["id"],
                    {
                        "status": status,
                        "output": active_content["text"],
                        "endedAt": clock(),
                    },
                )
                if step is not None:
                    await emit_trace(request, step)
                active_content = None

            async def append_content(
                kind: str,
                name: str,
                delta: str,
                event: dict[str, Any],
            ) -> str:
                nonlocal active_content, seq
                if active_content is not None and active_content["kind"] != kind:
                    await finish_active_content()
                if active_content is None:
                    context = _trace_context(event, open_event_traces)
                    parent_step_id = llm_step_id(event) or context["parentStepId"]
                    step = add_trace(
                        request,
                        seq,
                        kind,
                        name,
                        TRACE_STATUS_RUNNING,
                        parent_step_id=parent_step_id,
                        agent_name=context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    seq += 1
                    active_content = {
                        "id": step["id"],
                        "kind": kind,
                        "text": "",
                    }
                    await emit_trace(request, step)
                active_content["text"] += delta
                repos["agentTraces"]["updateStep"](
                    active_content["id"],
                    {"output": active_content["text"]},
                )
                return active_content["id"]

            async for raw in events:
                if control["cancelled"]:
                    reason = (
                        "Cancelled because a newer run replaced this run"
                        if control.get("stop_reason") == "superseded"
                        else "Cancelled"
                    )
                    return await terminalize(
                        request,
                        RUN_STATUS_CANCELLED,
                        reason,
                        run_trace,
                        partial_text if is_current() else "",
                    )
                event = raw if isinstance(raw, dict) else {"event": "trace", "data": raw}
                event_name = str(event.get("event") or event.get("type") or "")
                if event_name in {"token", "on_chat_model_stream"}:
                    reasoning_delta = _event_delta(event, True)
                    if reasoning_delta:
                        step_id = await append_content(
                            "reasoning",
                            "model_reasoning",
                            reasoning_delta,
                            event,
                        )
                        payload = {
                            "runId": run_id,
                            "threadId": thread_id,
                            "token": reasoning_delta,
                        }
                        if step_id is not None:
                            payload["stepId"] = step_id
                        await emit_event("ai.chat.reasoning", payload)
                    delta = _event_delta(event, False)
                    if delta:
                        partial_text += delta
                        step_id = await append_content(
                            "message",
                            "assistant_message",
                            delta,
                            event,
                        )
                        payload = {
                            "runId": run_id,
                            "threadId": thread_id,
                            "token": delta,
                        }
                        if step_id is not None:
                            payload["stepId"] = step_id
                        await emit_event("ai.chat.token", payload)
                    continue
                if event_name in {"reasoning", "thinking"}:
                    delta = _event_delta(event, True)
                    if not delta and isinstance(event.get("delta"), str):
                        delta = event["delta"]
                    if delta:
                        step_id = await append_content(
                            "reasoning",
                            "model_reasoning",
                            delta,
                            event,
                        )
                        payload = {
                            "runId": run_id,
                            "threadId": thread_id,
                            "token": delta,
                        }
                        payload["stepId"] = step_id
                        await emit_event("ai.chat.reasoning", payload)
                    continue
                if event_name == "on_chat_model_start":
                    context = _trace_context(event, open_event_traces)
                    step = add_trace(
                        request,
                        seq,
                        "llm",
                        _tool_event_name(event) or "model",
                        TRACE_STATUS_RUNNING,
                        checkpoint=_checkpoint_id(event),
                        input_data=(event.get("data") or {}).get("input")
                        if isinstance(event.get("data"), dict)
                        else None,
                        parent_step_id=context["parentStepId"],
                        agent_name=context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    event_key = _event_key(event, "llm")
                    open_llm_traces[event_key] = step["id"]
                    open_event_traces[event_key] = step["id"]
                    await emit_trace(request, step)
                    seq += 1
                    continue
                if event_name in {"on_chat_model_end", "on_chat_model_error"}:
                    failed = event_name == "on_chat_model_error"
                    detail = event.get("error")
                    event_data = event.get("data")
                    if detail is None and isinstance(event_data, dict):
                        detail = event_data.get("error") or event_data.get("output")
                    event_key = _event_key(event, "llm")
                    trace_id = open_llm_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
                    patch = {
                        "status": TRACE_STATUS_ERROR if failed else TRACE_STATUS_DONE,
                        "output": _truncate(detail),
                        "endedAt": clock(),
                        **_token_usage(event_data),
                    }
                    step = (
                        repos["agentTraces"]["updateStep"](trace_id, patch)
                        if trace_id is not None
                        else add_trace(
                            request,
                            seq,
                            "llm",
                            _tool_event_name(event) or "model",
                            patch["status"],
                            detail,
                            _checkpoint_id(event),
                        )
                    )
                    if trace_id is None:
                        seq += 1
                    if step is not None:
                        await emit_trace(request, step)
                    if failed:
                        raise RuntimeError(_as_text(detail or "Model execution failed"))
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
                    context = _trace_context(event, open_event_traces)
                    is_subagent = name == "task"
                    step = add_trace(
                        request,
                        seq,
                        "subagent"
                        if is_subagent
                        else ("todo" if name == "write_todos" else "tool"),
                        name,
                        TRACE_STATUS_RUNNING,
                        checkpoint=_checkpoint_id(event),
                        input_data=trace_input,
                        parent_step_id=context["parentStepId"],
                        agent_name=_subagent_name(event)
                        if is_subagent
                        else context["agentName"],
                        namespace=context["namespace"],
                        depth=context["depth"],
                    )
                    event_key = _tool_event_key(event, name)
                    open_tool_traces[event_key] = step["id"]
                    open_event_traces[event_key] = step["id"]
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
                    failed = _tool_output_failed(trace_output)
                    status = TRACE_STATUS_ERROR if failed else TRACE_STATUS_DONE
                    event_key = _tool_event_key(event, name)
                    trace_id = open_tool_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
                    if trace_id is not None:
                        step = repos["agentTraces"]["updateStep"](
                            trace_id,
                            {
                                "status": status,
                                "output": _truncate(safe_output),
                                "endedAt": clock(),
                            },
                        )
                    else:
                        step = add_trace(
                            request,
                            seq,
                            "subagent"
                            if name == "task"
                            else ("todo" if name == "write_todos" else "tool"),
                            name,
                            status,
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
                    event_key = _tool_event_key(event, name)
                    trace_id = open_tool_traces.pop(event_key, None)
                    open_event_traces.pop(event_key, None)
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
                            "subagent"
                            if name == "task"
                            else ("todo" if name == "write_todos" else "tool"),
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
                context = _trace_context(event, open_event_traces)
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
                    parent_step_id=context["parentStepId"],
                    agent_name=context["agentName"],
                    namespace=context["namespace"],
                    depth=context["depth"],
                )
                await emit_trace(request, step)
                seq += 1
            if control["cancelled"]:
                reason = (
                    "Cancelled because a newer run replaced this run"
                    if control.get("stop_reason") == "superseded"
                    else "Cancelled"
                )
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    reason,
                    run_trace,
                    partial_text if is_current() else "",
                )
            if not is_current():
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    "Cancelled because a newer run replaced this run",
                    run_trace,
                )
            snapshot = await agent_state(agent, request)
            if not is_current():
                return await terminalize(
                    request,
                    RUN_STATUS_CANCELLED,
                    "Cancelled because a newer run replaced this run",
                    run_trace,
                )
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
                await finish_active_content()
                return await finish_interrupted(request, state, run_trace)
            await finish_active_content()
            return await finish_completed(
                request,
                result,
                state,
                run_trace,
                tool_history,
                partial_text,
            )
        except asyncio.CancelledError:
            return await terminalize(
                request,
                RUN_STATUS_CANCELLED,
                "Cancelled",
                run_trace,
                partial_text if is_current() else "",
            )
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
            return await terminalize(
                request,
                RUN_STATUS_CANCELLED if control["cancelled"] else RUN_STATUS_FAILED,
                message or "Agent execution failed",
                run_trace,
                partial_text if is_current() else "",
            )
        finally:
            active.pop(run_id, None)
            if active_by_thread.get(thread_id) == run_id:
                active_by_thread.pop(thread_id, None)
            if finish_run is not None:
                try:
                    await _await(finish_run(run_id))
                except Exception:
                    pass
            if checkpoint_connection is not None:
                await checkpoint_connection.close()
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
            message = "No pending interrupt for run"
            if persisted is not None:
                await emit_event(
                    "ai.chat.error",
                    {
                        "runId": run_id,
                        "threadId": persisted["threadId"],
                        "message": message,
                    },
                )
                await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        decisions = request.get("decisions")
        if not isinstance(decisions, list) or len(decisions) != len(interrupt["actions"]):
            message = "Interrupt decisions do not match pending actions"
            await emit_event(
                "ai.chat.error",
                {
                    "runId": run_id,
                    "threadId": persisted["threadId"],
                    "message": message,
                },
            )
            await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
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
            message = str(error)
            await emit_event(
                "ai.chat.error",
                {
                    "runId": run_id,
                    "threadId": persisted["threadId"],
                    "message": message,
                },
            )
            await emit_status(run_id, persisted["status"])
            return {"runId": run_id, "status": RUN_STATUS_FAILED, "error": message}
        stored = resume_contexts.get(run_id, {})
        request = {
            **request,
            **stored,
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

    async def recover(request: dict[str, Any]) -> dict[str, Any]:
        checkpoint_path = request.get("checkpointPath")
        if isinstance(checkpoint_path, str) and checkpoint_path:
            try:
                await asyncio.to_thread(_prune_academic_artifacts, checkpoint_path)
            except OSError:
                pass
        mode = (
            "recover"
            if request.get("recoverLatestCheckpoint") is True
            else "restart"
        )
        return await run(request, mode, existing_run=True)

    async def start_recover(request: dict[str, Any]) -> dict[str, Any]:
        run_id = request["runId"]
        if run_id in background_tasks and not background_tasks[run_id].done():
            raise ValueError("Run is already active")
        task = asyncio.create_task(recover(request))
        background_tasks[run_id] = task
        task.add_done_callback(
            lambda completed, rid=run_id: background_tasks.pop(rid, None)
        )
        await asyncio.sleep(0)
        return {"runId": run_id, "threadId": request["threadId"]}

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
        artifact_store = AcademicArtifactStore(
            _checkpoint_artifact_root(checkpoint_path)
        )
        candidate_artifact_ids = _artifact_ids_in_checkpoint_database(
            checkpoint_path, thread_id
        )
        connection = sqlite3.connect(checkpoint_path)
        try:
            connection.execute("PRAGMA busy_timeout = 5000")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if {"checkpoints", "writes"}.issubset(tables):
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
        artifact_store.delete_thread_artifacts(
            candidate_artifact_ids,
            _artifact_ids_in_checkpoint_database(checkpoint_path),
        )

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
        pending_titles = list(title_tasks)
        for task in pending_titles:
            task.cancel()
        if pending_titles:
            await asyncio.gather(*pending_titles, return_exceptions=True)
        background_tasks.clear()
        title_tasks.clear()
        resume_contexts.clear()

    return {
        "send": send,
        "start": start,
        "run": run,
        "resume": resume,
        "startResume": start_resume,
        "recover": recover,
        "startRecover": start_recover,
        "cancel": cancel,
        "deleteThread": delete_thread,
        "destroy": destroy,
    }


async def _iterate(values: Iterable[Any]):
    for value in values:
        yield value
