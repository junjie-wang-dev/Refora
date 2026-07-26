from __future__ import annotations

from typing import Any, Callable

ToolHandler = Callable[[Any, dict[str, Any]], Any]


class ToolGroup:
    name: str = ""
    handlers: dict[str, ToolHandler] = {}
    schemas: dict[str, dict[str, Any]] = {}
    descriptions: dict[str, str] = {}

    @classmethod
    def register(cls, registry: dict[str, tuple[ToolHandler, dict[str, Any], str]]) -> None:
        for tool_name, handler in cls.handlers.items():
            schema = cls.schemas.get(tool_name, {"type": "object", "properties": {}, "required": [], "additionalProperties": False})
            description = cls.descriptions.get(tool_name, tool_name.replace("_", " "))
            registry[tool_name] = (handler, schema, description)


def collect_registry(*groups: type[ToolGroup]) -> dict[str, tuple[ToolHandler, dict[str, Any], str]]:
    registry: dict[str, tuple[ToolHandler, dict[str, Any], str]] = {}
    for group in groups:
        group.register(registry)
    return registry


def object_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}