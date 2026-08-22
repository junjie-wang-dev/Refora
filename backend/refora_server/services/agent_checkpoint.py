from __future__ import annotations

import json
import os
import re
import sqlite3
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.serde.base import SerializerProtocol
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from refora_server.academic.types import ACADEMIC_RESEARCH_TOOL_NAMES
from refora_server.agent.academic_artifacts import (
    ACADEMIC_ARTIFACT_MARKER_KEY,
    AcademicArtifactStore,
    academic_artifact_id_from_marker,
)


_ACADEMIC_TOOL_NAMES = frozenset(ACADEMIC_RESEARCH_TOOL_NAMES)
ACADEMIC_PERSISTENCE_REDACTION = (
    "[Academic research data omitted from persistent agent state]"
)


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


def _is_academic_tool_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.removeprefix("refora.") in _ACADEMIC_TOOL_NAMES
    )


def _academic_call_name(value: Any) -> str | None:
    mapping = value if isinstance(value, dict) else _as_mapping(value)
    name = mapping.get("name")
    if _is_academic_tool_name(name):
        return name
    function = mapping.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        if _is_academic_tool_name(name):
            return name
    return None


def _collect_academic_tool_call_ids(
    value: Any, result: set[str], seen: set[int]
) -> None:
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
                _is_academic_tool_name(current.name)
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
    marker = (
        metadata.get(ACADEMIC_ARTIFACT_MARKER_KEY)
        if isinstance(metadata, dict)
        else None
    )
    return marker if academic_artifact_id_from_marker(marker) is not None else None


def _with_academic_message_marker(
    value: AIMessage | ToolMessage, marker: str
) -> Any:
    metadata = {
        **(
            value.response_metadata
            if isinstance(value.response_metadata, dict)
            else {}
        ),
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
        return _is_academic_tool_name(value.name) or value.tool_call_id in academic_ids
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
    return any(
        _has_academic_checkpoint_value(item, academic_ids, seen) for item in values
    )


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
            if _is_academic_tool_name(current.name) or current.tool_call_id in academic_ids:
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
        if (
            academic_artifact_id_from_marker(marker) is not None
            and "fallback" in current
        ):
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
                ids.update(
                    match.group(1)
                    for match in _ACADEMIC_ARTIFACT_MARKER_RE.finditer(text)
                )
        return ids
    except sqlite3.Error:
        return set()
    finally:
        connection.close()


def _prune_academic_artifacts(checkpoint_path: str) -> None:
    store = AcademicArtifactStore(_checkpoint_artifact_root(checkpoint_path))
    store.prune_artifacts(_artifact_ids_in_checkpoint_database(checkpoint_path))
