from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from refora_server.agent.tools.common import object_schema
from refora_server.agent.tools.registry import ToolGroup


def write_todos(executor: Any, args: dict[str, Any]) -> Any:
    todos = args.get("todos")
    if not isinstance(todos, list) or any(not isinstance(todo, Mapping) or not isinstance(todo.get("content"), str) or todo.get("status") not in {"pending", "in_progress", "completed"} for todo in todos):
        raise ValueError("Todos are invalid")
    executor.todos = [{"content": todo["content"].strip(), "status": todo["status"]} for todo in todos if todo["content"].strip()]
    return {"todos": executor.todos}


class TodoTools(ToolGroup):
    name = "todo"
    handlers = {"write_todos": write_todos}
    descriptions = {"write_todos": "Write the agent todo list."}
    schemas = {"write_todos": object_schema({"todos": {"type": "array"}})}