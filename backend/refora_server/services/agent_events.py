from __future__ import annotations

import json
import uuid
from typing import Any

from refora_server.services.agent_checkpoint import _is_academic_tool_name
from refora_server.services.agent_memory import (
    MAX_MEMORY_FILE_CHARS,
    normalize_memory_path,
)
from refora_server.services.chat_history import parseToolPayload


_SECRET_KEYS = {"apiKey", "api_key", "authorization", "Authorization"}
_STREAMED_ACTIVITY_TOOL_NAMES = frozenset(
    {"write_file", "edit_file", "write_todos"}
)


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
            checkpoint = configurable.get("checkpoint_id") or configurable.get(
                "checkpointId"
            )
            if isinstance(checkpoint, str) and checkpoint:
                return checkpoint
    return None


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(
            _message_text(part.get("text") if isinstance(part, dict) else part)
            for part in value
        )
    if isinstance(value, dict):
        return _message_text(value.get("text") or value.get("content"))
    content = getattr(value, "content", None)
    return _message_text(content) if content is not None else ""


def _segment_separator(before: str, after: str) -> str:
    if not before or not after:
        return ""
    trailing = len(before) - len(before.rstrip("\n"))
    leading = len(after) - len(after.lstrip("\n"))
    return "\n" * max(0, 2 - trailing - leading)


def _result_text(result: Any) -> str:
    if isinstance(result, dict):
        messages = result.get("messages")
        if isinstance(messages, list) and messages:
            return _message_text(
                messages[-1].get("content")
                if isinstance(messages[-1], dict)
                else messages[-1]
            )
        for key in ("content", "text", "output"):
            if key in result:
                return _message_text(result[key])
    return _message_text(result)


def _tool_history_records(
    result: Any, state: dict[str, Any]
) -> list[dict[str, str | None]]:
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
                tool_calls = mapping.get("tool_calls") or getattr(
                    message, "tool_calls", None
                )
                if isinstance(tool_calls, list):
                    for tool_call in tool_calls:
                        call = (
                            tool_call
                            if isinstance(tool_call, dict)
                            else _as_mapping(tool_call)
                        )
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
            if _is_academic_tool_name(record.get("name")):
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
        value for value in event.get("parent_ids") or [] if isinstance(value, str)
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


def _tool_event_record(
    event: dict[str, Any],
) -> dict[str, str | None] | None:
    data = event.get("data")
    data = data if isinstance(data, dict) else {}
    name = _tool_event_name(event)
    if name is None or _is_academic_tool_name(name):
        return None
    raw_input, raw_output = _tool_event_values(event)
    raw_input = _without_secrets(raw_input)
    raw_output = _without_secrets(raw_output)
    output_mapping = (
        raw_output if isinstance(raw_output, dict) else _as_mapping(raw_output)
    )
    call_id = data.get("tool_call_id")
    if not isinstance(call_id, str) and isinstance(data.get("input"), dict):
        call_id = data["input"].get("tool_call_id")
    if not isinstance(call_id, str) and output_mapping:
        call_id = output_mapping.get("tool_call_id") or output_mapping.get(
            "toolCallId"
        )
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
            "outputTokens": (
                "output_tokens",
                "outputTokens",
                "completion_tokens",
            ),
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
            or _is_academic_tool_name(name)
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


def _streamed_tool_call_previews(value: Any) -> list[tuple[int, str]]:
    mapping = _as_mapping(value)
    chunks = mapping.get("tool_call_chunks")
    if not isinstance(chunks, list):
        chunks = mapping.get("tool_calls")
    if not isinstance(chunks, list):
        return []

    previews: list[tuple[int, str]] = []
    for position, chunk in enumerate(chunks):
        call = _as_mapping(chunk)
        name = call.get("name")
        if not isinstance(name, str) or name not in _STREAMED_ACTIVITY_TOOL_NAMES:
            continue
        index = call.get("index")
        slot = (
            index
            if isinstance(index, int) and not isinstance(index, bool)
            else position
        )
        previews.append((slot, name))
    return previews


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
                if not isinstance(request, dict) or not isinstance(
                    request.get("name"), str
                ):
                    continue
                config = (
                    configs[index]
                    if index < len(configs) and isinstance(configs[index], dict)
                    else {}
                )
                allowed = config.get("allowedDecisions") or config.get(
                    "allowed_decisions"
                )
                decisions = (
                    [
                        value
                        for value in allowed
                        if value in {"approve", "edit", "reject"}
                    ]
                    if isinstance(allowed, list)
                    else ["approve", "reject"]
                )
                action = {
                    "name": request["name"],
                    "args": (
                        request.get("args")
                        if isinstance(request.get("args"), dict)
                        else {}
                    ),
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


def _reasoning_value_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_reasoning_value_text(item) for item in value)
    mapping = _as_mapping(value)
    if not mapping:
        return ""
    for key in ("reasoning", "reasoning_content", "thinking"):
        text = _reasoning_value_text(mapping.get(key))
        if text:
            return text
    block_type = mapping.get("type")
    if isinstance(block_type, str) and (
        block_type == "reasoning"
        or block_type == "thinking"
        or block_type == "reasoning_content"
        or block_type == "summary_text"
        or block_type == "reasoning_summary"
        or block_type.startswith("reasoning.")
    ):
        for key in ("text", "content", "delta", "summary"):
            text = _reasoning_value_text(mapping.get(key))
            if text:
                return text
    summary = mapping.get("summary")
    if isinstance(summary, (dict, list)):
        return _reasoning_value_text(summary)
    return ""


def _chunk_reasoning_text(chunk: Any) -> str:
    if isinstance(chunk, list):
        for item in chunk:
            text = _chunk_reasoning_text(item)
            if text:
                return text
        return ""
    mapping = _as_mapping(chunk)
    for key in (
        "reasoning_content",
        "reasoning",
        "thinking",
        "reasoning_details",
    ):
        text = _reasoning_value_text(mapping.get(key))
        if text:
            return text
    additional = mapping.get("additional_kwargs") or getattr(
        chunk, "additional_kwargs", None
    )
    if isinstance(additional, dict):
        for key in (
            "reasoning_content",
            "reasoning",
            "thinking",
            "reasoning_details",
        ):
            text = _reasoning_value_text(additional.get(key))
            if text:
                return text
    content = (
        mapping.get("content")
        if "content" in mapping
        else getattr(chunk, "content", None)
    )
    if isinstance(content, dict):
        text = _reasoning_value_text(content)
        if text:
            return text
    if isinstance(content, list):
        text = "".join(
            _reasoning_value_text(block)
            for block in content
            if isinstance(block, dict)
        )
        if text:
            return text
    try:
        content_blocks = getattr(chunk, "content_blocks", None)
    except Exception:
        content_blocks = None
    if isinstance(content_blocks, list):
        text = "".join(
            _reasoning_value_text(block)
            for block in content_blocks
            if isinstance(block, dict)
        )
        if text:
            return text
    for key in ("message", "chunk", "output"):
        nested = mapping.get(key)
        if nested is not None and nested is not chunk:
            text = _chunk_reasoning_text(nested)
            if text:
                return text
    generations = mapping.get("generations")
    if isinstance(generations, list):
        for generation in generations:
            text = _chunk_reasoning_text(generation)
            if text:
                return text
    return ""


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
        if chunk is not None:
            if reasoning:
                return _chunk_reasoning_text(chunk)
            return _message_text(
                chunk.get("content") if isinstance(chunk, dict) else chunk
            )
    return ""
