from __future__ import annotations

import json
from typing import Any

TOOL_HISTORY_OUTPUT_MAX = 3000
HISTORY_TOKEN_BUDGET = 8000
HISTORY_MIN_MESSAGES = 2
HISTORY_MAX_MESSAGES = 50


def parseToolPayload(content: str) -> dict[str, Any]:
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError):
        return {"name": "unknown", "toolCallId": None, "input": content, "output": content}
    if not isinstance(parsed, dict):
        return {"name": "unknown", "toolCallId": None, "input": content, "output": content}
    name = parsed["name"] if isinstance(parsed.get("name"), str) else "unknown"
    raw_input = parsed.get("input")
    if isinstance(raw_input, str):
        input_value: str | None = raw_input
    elif raw_input is not None:
        input_value = json.dumps(raw_input)
    else:
        input_value = None
    raw_output = parsed.get("output")
    if isinstance(raw_output, str):
        output_value: str | None = raw_output
    elif raw_output is not None:
        output_value = json.dumps(raw_output)
    else:
        output_value = None
    tool_call_id = parsed["toolCallId"] if isinstance(parsed.get("toolCallId"), str) else None
    return {
        "name": name,
        "toolCallId": tool_call_id,
        "input": input_value,
        "output": output_value,
    }


def truncateOutput(output: str, max: int) -> str:
    if len(output) <= max:
        return output
    return f"{output[:max]}\n...[truncated]"


def estimateTokens(text: str) -> int:
    cjk = sum(
        1
        for char in text
        if (
            "\u3400" <= char <= "\u9fff"
            or "\u3040" <= char <= "\u30ff"
            or "\uac00" <= char <= "\ud7af"
        )
    )
    return cjk + (len(text) - cjk + 3) // 4


def _message_budget_text(message: dict[str, Any]) -> str:
    values: list[Any] = [message.get("content") or ""]
    if isinstance(message.get("tool_calls"), list):
        values.append(message["tool_calls"])
    try:
        return json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(values)


def _history_units(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    units: list[list[dict[str, Any]]] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        calls = message.get("tool_calls") if message.get("role") == "assistant" else None
        if not isinstance(calls, list) or not calls:
            units.append([message])
            index += 1
            continue
        call_ids = {
            call.get("id")
            for call in calls
            if isinstance(call, dict) and isinstance(call.get("id"), str)
        }
        unit = [message]
        cursor = index + 1
        while cursor < len(messages):
            candidate = messages[cursor]
            if (
                candidate.get("role") != "tool"
                or candidate.get("tool_call_id") not in call_ids
            ):
                break
            unit.append(candidate)
            cursor += 1
        units.append(unit)
        index = cursor
    return units


def truncateHistoryByTokens(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = HISTORY_TOKEN_BUDGET,
    min_messages: int = HISTORY_MIN_MESSAGES,
    max_messages: int = HISTORY_MAX_MESSAGES,
) -> list[dict[str, Any]]:
    if not messages:
        return []
    selected: list[list[dict[str, Any]]] = []
    used_tokens = 0
    used_messages = 0
    for unit in reversed(_history_units(messages)):
        unit_tokens = sum(estimateTokens(_message_budget_text(message)) + 4 for message in unit)
        if used_messages and used_messages + len(unit) > max_messages:
            break
        if used_messages >= min_messages and used_tokens + unit_tokens > max_tokens:
            break
        selected.insert(0, unit)
        used_tokens += unit_tokens
        used_messages += len(unit)
    result = [dict(message) for unit in selected for message in unit]
    sanitizeToolCallPairs(result)
    while result and result[0].get("role") == "tool":
        result.pop(0)
    return result


def lastIsAiWithToolCall(
    msgs: list[dict[str, Any]], tool_call_id: str, name: str
) -> bool:
    if not msgs:
        return False
    last = msgs[-1]
    if last.get("role") != "assistant":
        return False
    calls = last.get("tool_calls")
    if not isinstance(calls, list) or len(calls) == 0:
        return False
    return any(
        isinstance(c, dict) and c.get("id") == tool_call_id and c.get("name") == name
        for c in calls
    )


def safeParseArgs(input_value: str | None) -> dict[str, Any]:
    if input_value is None:
        return {}
    try:
        parsed = json.loads(input_value)
    except (ValueError, TypeError):
        return {"raw": input_value}
    if isinstance(parsed, dict) and not isinstance(parsed, list):
        return parsed
    return {"raw": input_value}


def historyToMessages(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        role = row.get("role")
        content = row.get("content") or ""
        if role == "user":
            out.append({"role": "user", "content": content})
            continue
        if role == "assistant":
            out.append({"role": "assistant", "content": content})
            continue
        if role == "tool":
            parsed = parseToolPayload(content)
            tool_call_id = parsed["toolCallId"] or f"legacy_{row.get('id')}"
            name = parsed["name"] or "unknown"
            if not lastIsAiWithToolCall(out, tool_call_id, name):
                out.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": tool_call_id,
                                "name": name,
                                "args": safeParseArgs(parsed["input"]),
                            }
                        ],
                    }
                )
            out.append(
                {
                    "role": "tool",
                    "content": truncateOutput(parsed["output"] or "", TOOL_HISTORY_OUTPUT_MAX),
                    "tool_call_id": tool_call_id,
                    "name": name,
                }
            )
    sanitizeToolCallPairs(out)
    return out


def sanitizeToolCallPairs(messages: list[dict[str, Any]]) -> None:
    known_tool_call_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") == "assistant":
            calls = msg.get("tool_calls")
            if isinstance(calls, list):
                for c in calls:
                    if isinstance(c, dict) and c.get("id"):
                        known_tool_call_ids.add(c["id"])

    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") == "tool" and msg.get("tool_call_id"):
            if msg["tool_call_id"] not in known_tool_call_ids:
                del messages[i]

    satisfied_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") == "tool" and msg.get("tool_call_id"):
            satisfied_ids.add(msg["tool_call_id"])

    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") != "assistant":
            continue
        calls = msg.get("tool_calls")
        if not isinstance(calls, list) or len(calls) == 0:
            continue
        unpaired = [
            c for c in calls if isinstance(c, dict) and c.get("id") and c["id"] not in satisfied_ids
        ]
        if len(unpaired) == 0:
            continue
        if len(unpaired) == len(calls):
            del messages[i]
        else:
            placeholders = [
                {
                    "role": "tool",
                    "content": "[Tool result unavailable]",
                    "tool_call_id": c["id"],
                    "name": c.get("name") or "unknown",
                }
                for c in unpaired
            ]
            messages[i + 1 : i + 1] = placeholders
            for c in unpaired:
                satisfied_ids.add(c["id"])


def createChatHistoryService(repos: Any, deps: Any | None = None):
    def buildHistoryMessages(threadId: str) -> list[dict[str, Any]]:
        rows = repos["chat"]["listMessages"](threadId)
        return historyToMessages(rows)

    return {"buildHistoryMessages": buildHistoryMessages}
