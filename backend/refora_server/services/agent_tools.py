from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from langchain_core.runnables.config import RunnableConfig, ensure_config, patch_config
from langchain_core.tools import StructuredTool

from refora_server.agent.engine_schema import (
    TOOL_EFFECT_STATUS_DONE,
    TOOL_EFFECT_STATUS_ERROR,
)
from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.application_catalog import APPLICATION_ACTIONS, APPLICATION_OPERATIONS
from refora_server.agent.tools.application_protocol import (
    ApplicationInputError, action_schema, dispatch_application, tool_description,
)
from refora_server.agent.tools.academic import AcademicTools
from refora_server.agent.tools.application import ApplicationTools
from refora_server.agent.tools.common import value
from refora_server.agent.tools.library import LibraryTools
from refora_server.agent.tools.ocr_memory import (
    OcrMemoryTools,
    memory_update_description,
    memory_update_schema,
)
from refora_server.agent.tools.registry import collect_registry
from refora_server.agent.tools.sandbox import SandboxTools
from refora_server.agent.tools.web import WebTools
from refora_server.agent.tools.workspace import WorkspaceTools


@dataclass(frozen=True)
class AgentToolContext:
    run_id: str
    thread_id: str | None = None
    workspace_id: str | None = None


_TOOL_CALL_ID_CONFIG_KEY = "_refora_tool_call_id"


def _with_tool_call_id(config: RunnableConfig | None, tool_call_id: str | None) -> RunnableConfig:
    base = ensure_config(config)
    if not tool_call_id:
        return base
    configurable = dict(base.get("configurable") or {})
    configurable[_TOOL_CALL_ID_CONFIG_KEY] = tool_call_id
    return patch_config(base, configurable=configurable)


def _tool_call_id_from(input: Any, config: RunnableConfig | None) -> str | None:
    if isinstance(input, dict) and input.get("type") == "tool_call" and isinstance(input.get("id"), str):
        return input["id"]
    configurable = (config or {}).get("configurable") or {}
    value = configurable.get(_TOOL_CALL_ID_CONFIG_KEY)
    return value if isinstance(value, str) else None


class _ToolCallAwareTool(StructuredTool):
    def invoke(  # type: ignore[override]
        self,
        input: Any,
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> Any:
        return super().invoke(input, _with_tool_call_id(config, _tool_call_id_from(input, config)), **kwargs)

    async def ainvoke(  # type: ignore[override]
        self,
        input: Any,
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> Any:
        return await super().ainvoke(input, _with_tool_call_id(config, _tool_call_id_from(input, config)), **kwargs)


_REGISTRY = collect_registry(
    LibraryTools,
    WorkspaceTools,
    ApplicationTools,
    OcrMemoryTools,
    SandboxTools,
    AcademicTools,
    WebTools,
)


def agent_tool_names() -> tuple[str, ...]:
    return (*APPLICATION_ACTIONS, *(name for name in _REGISTRY if name not in APPLICATION_OPERATIONS))


class AgentToolExecutor:
    def __init__(self, context: AgentToolContext, deps: Any) -> None:
        self.context = context
        self.deps = deps
        self.repos = value(deps, "repos", deps)

    def execute(self, name: str, arguments: Mapping[str, Any] | None = None, tool_call_id: str | None = None) -> str:
        arguments = dict(arguments or {})
        try:
            risk = classify(name, arguments=arguments)
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
        _begin = value(effects, "begin")
        _finish = value(effects, "finish")
        claimed = _begin(
            {
                "runId": self.context.run_id,
                "toolCallId": tool_call_id,
                "toolName": name,
                "workspaceId": self.context.workspace_id,
            }
        )
        if claimed is None:
            existing = value(effects, "get")(self.context.run_id, tool_call_id)
            if existing and existing["status"] == TOOL_EFFECT_STATUS_DONE and isinstance(existing.get("result"), str):
                return existing["result"]
            return _json({"error": "This tool call has an unknown outcome from an interrupted run."})
        try:
            result = _json(self._dispatch(name, arguments))
        except Exception as error:
            _finish(self.context.run_id, tool_call_id, TOOL_EFFECT_STATUS_ERROR, str(error))
            raise
        _finish(self.context.run_id, tool_call_id, TOOL_EFFECT_STATUS_DONE, result)
        return result

    def _dispatch(self, name: str, args: dict[str, Any]) -> Any:
        if name in APPLICATION_ACTIONS:
            return dispatch_application(self, name, args, _REGISTRY)
        entry = _REGISTRY.get(name)
        if entry is None:
            raise ValueError(f"Unsupported agent tool: {name}")
        handler, _schema, _description = entry
        return handler(self, args)


def _json(value: Any) -> str:
    from refora_server.academic.types import to_json
    return json.dumps(to_json(value), ensure_ascii=False, separators=(",", ":"))


def _error(error: Exception) -> str:
    return _json({"error": {"code": getattr(error, "code", "agent_tool_failed"), "message": str(error), **({"details": error.details} if isinstance(error, ApplicationInputError) else {})}})


def create_agent_tools(context: AgentToolContext, deps: Any, *, legacy_names: tuple[str, ...] = ()) -> list[StructuredTool]:
    executor = AgentToolExecutor(context, deps)
    tools: list[StructuredTool] = []
    names = dict.fromkeys((*agent_tool_names(), *(name for name in legacy_names if name in APPLICATION_OPERATIONS)))
    for name in names:
        if name in APPLICATION_ACTIONS:
            schema = action_schema(tuple(APPLICATION_ACTIONS[name]))
            description = tool_description(name)
        else:
            _handler, schema, description = _REGISTRY[name]
        if name == "propose_workspace_memory_update":
            schema = memory_update_schema(context.workspace_id)
            description = memory_update_description(context.workspace_id)

        def make_tool(n: str = name) -> Any:
            def invoke(config: RunnableConfig, **arguments: Any) -> str:
                tool_call_id = _tool_call_id_from(arguments, config)
                arguments.pop(_TOOL_CALL_ID_CONFIG_KEY, None)
                return executor.execute(n, arguments, tool_call_id)
            return invoke
        tools.append(_ToolCallAwareTool(name=name, description=description, args_schema=schema, func=make_tool()))
    return tools


def restrict_application_tool(tool: StructuredTool, actions: tuple[str, ...]) -> StructuredTool:
    original = tool.func
    current = tool.args_schema['properties']['action']['enum']
    actions = tuple(action for action in actions if action in current and action != 'help')

    def invoke(config: RunnableConfig, **arguments: Any) -> str:
        action = arguments.get('action')
        selected = (arguments.get('parameters') or {}).get('action') if isinstance(arguments.get('parameters', {}), dict) else None
        if (action != 'help' and action not in actions) or (action == 'help' and selected is not None and selected not in actions):
            return _error(ApplicationInputError('Action is not available in this tool context', tool=tool.name))
        result = original(config, **arguments)
        if action == 'help':
            parsed = json.loads(result)
            if 'actions' in parsed:
                parsed['actions'] = [entry for entry in parsed['actions'] if entry['action'] in actions]
            return _json(parsed)
        return result
    return tool.model_copy(update={'args_schema': action_schema(actions), 'func': invoke})


def readonly_agent_tools(tools: list[Any]) -> list[Any]:
    result = []
    for tool in tools:
        if tool.name in APPLICATION_ACTIONS:
            actions = tuple(action for action, operation in APPLICATION_ACTIONS[tool.name].items() if classify(operation) in {RiskClass.READ, RiskClass.NETWORK_READ})
            result.append(restrict_application_tool(tool, actions))
        elif classify(tool.name) in {RiskClass.READ, RiskClass.NETWORK_READ}:
            result.append(tool)
    return result


def select_agent_tools(tools: list[Any], enabled: set[str]) -> list[Any]:
    result = []
    for tool in tools:
        if tool.name in enabled:
            result.append(tool)
        elif tool.name in APPLICATION_ACTIONS:
            actions = tuple(action for action, operation in APPLICATION_ACTIONS[tool.name].items() if operation in enabled)
            if actions:
                result.append(restrict_application_tool(tool, actions))
    return result
