from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from langchain_core.tools import StructuredTool

from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.tools.academic import AcademicTools
from refora_server.agent.tools.common import value
from refora_server.agent.tools.library import LibraryTools
from refora_server.agent.tools.ocr_memory import OcrMemoryTools
from refora_server.agent.tools.registry import collect_registry
from refora_server.agent.tools.sandbox import SandboxTools
from refora_server.agent.tools.todo import TodoTools
from refora_server.agent.tools.web import WebTools
from refora_server.agent.tools.workspace import WorkspaceTools


@dataclass(frozen=True)
class AgentToolContext:
    run_id: str
    thread_id: str | None = None
    workspace_id: str | None = None


_REGISTRY = collect_registry(
    LibraryTools,
    WorkspaceTools,
    OcrMemoryTools,
    SandboxTools,
    AcademicTools,
    WebTools,
    TodoTools,
)


class AgentToolExecutor:
    def __init__(self, context: AgentToolContext, deps: Any) -> None:
        self.context = context
        self.deps = deps
        self.repos = value(deps, "repos", deps)
        self.todos: list[dict[str, str]] = []

    def execute(self, name: str, arguments: Mapping[str, Any] | None = None, tool_call_id: str | None = None) -> str:
        arguments = dict(arguments or {})
        try:
            risk = classify(name)
            if risk is RiskClass.EXTERNAL:
                approval = value(self.deps, "interrupt")
                if not callable(approval):
                    raise ValueError(f"Approval handler is unavailable for {name}")
                result = self._call_dep("interrupt", name, arguments)
                if result is not None:
                    return _json(result)
            if risk is not RiskClass.READ:
                return self._effect(name, arguments, tool_call_id)
            return _json(self._dispatch(name, arguments))
        except Exception as error:
            return _error(error)

    def _call_dep(self, name: str, *args: Any, **kwargs: Any) -> Any:
        fn = value(self.deps, name)
        if not callable(fn):
            raise ValueError(f"Agent dependency is unavailable: {name}")
        return fn(*args, **kwargs)

    def _effect(self, name: str, arguments: dict[str, Any], tool_call_id: str | None) -> str:
        if not tool_call_id:
            return _json(self._dispatch(name, arguments))
        effects = value(self.repos, "agentToolEffects")
        if effects is None:
            raise ValueError("Agent tool effects repository is unavailable")
        _get = value(effects, "get")
        _begin = value(effects, "begin")
        _finish = value(effects, "finish")
        existing = _get(self.context.run_id, tool_call_id)
        if existing and existing["status"] == "done" and isinstance(existing.get("result"), str):
            return existing["result"]
        if existing and existing["status"] == "running":
            return _json({"error": "This tool call has an unknown outcome from an interrupted run."})
        _begin({"runId": self.context.run_id, "toolCallId": tool_call_id, "toolName": name, "workspaceId": self.context.workspace_id})
        try:
            result = _json(self._dispatch(name, arguments))
        except Exception as error:
            _finish(self.context.run_id, tool_call_id, "error", str(error))
            raise
        _finish(self.context.run_id, tool_call_id, "done", result)
        return result

    def _dispatch(self, name: str, args: dict[str, Any]) -> Any:
        entry = _REGISTRY.get(name)
        if entry is None:
            raise ValueError(f"Unsupported agent tool: {name}")
        handler, _schema, _description = entry
        return handler(self, args)


def _json(value: Any) -> str:
    from refora_server.academic.types import to_json
    return json.dumps(to_json(value), ensure_ascii=False, separators=(",", ":"))


def _error(error: Exception) -> str:
    return _json({"error": {"code": getattr(error, "code", "agent_tool_failed"), "message": str(error)}})


def create_agent_tools(context: AgentToolContext, deps: Any) -> list[StructuredTool]:
    executor = AgentToolExecutor(context, deps)
    tools: list[StructuredTool] = []
    for name, (_handler, schema, description) in _REGISTRY.items():
        def make_tool(n: str = name) -> Any:
            def invoke(**arguments: Any) -> str:
                tool_call_id = arguments.pop("_refora_tool_call_id", None)
                return executor.execute(n, arguments, tool_call_id)
            return invoke
        tools.append(StructuredTool(name=name, description=description, args_schema=schema, func=make_tool()))
    return tools