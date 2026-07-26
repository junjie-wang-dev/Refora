from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Mapping
from typing import Any


def value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def call(source: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    fn = value(source, name)
    if not callable(fn):
        raise ValueError(f"Agent dependency is unavailable: {name}")
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(result)
        raise RuntimeError("Async agent tools must be invoked outside an active event loop")
    return result


def ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    if not isinstance(value, str):
        return []
    try:
        decoded = json.loads(value)
        if isinstance(decoded, list):
            return [item for item in decoded if isinstance(item, str) and item]
    except ValueError:
        pass
    return [item.strip() for item in value.split(",") if item.strip()]


def repo(source: Any, name: str) -> Any:
    r = value(source, name) if isinstance(source, Mapping) else value(getattr(source, "repos", source), name)
    if r is None:
        raise ValueError(f"Repository is unavailable: {name}")
    return r


def object_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


def workspace(source: Any) -> str:
    ctx = getattr(source, "context", source)
    workspace_id = value(ctx, "workspace_id") or value(ctx, "workspaceId")
    if not workspace_id:
        raise ValueError("A Workspace must be selected for this tool")
    return workspace_id