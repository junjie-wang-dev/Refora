from __future__ import annotations

import json
from typing import Any, TypedDict

from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from deepagents.backends import StateBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI

from refora_server.agent.permissions import PermissionEngine
from refora_server.services.agent_memory import curated_memory_context


_DISABLED_BUILTIN_TOOLS = frozenset(
    {"task", "ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"}
)

register_harness_profile(
    "openai",
    HarnessProfile(
        excluded_tools=_DISABLED_BUILTIN_TOOLS,
        general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False),
    ),
)


class PermissionMiddleware(AgentMiddleware):
    def __init__(self, engine: PermissionEngine) -> None:
        self.engine = engine

    def _decision(self, request: Any):
        tool_call = request.tool_call
        return self.engine.evaluate(tool_call["name"], tool_call.get("args"))

    def _denied(self, request: Any, reason: str) -> ToolMessage:
        tool_call = request.tool_call
        return ToolMessage(
            content=json.dumps(
                {
                    "error": {
                        "code": "permission_denied",
                        "message": reason,
                    }
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            name=tool_call["name"],
            tool_call_id=tool_call["id"],
            status="error",
        )

    def wrap_tool_call(self, request: Any, handler: Any) -> Any:
        decision = self._decision(request)
        if not decision.allowed and not decision.needs_user:
            return self._denied(request, decision.reason)
        return handler(request)

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        decision = self._decision(request)
        if not decision.allowed and not decision.needs_user:
            return self._denied(request, decision.reason)
        return await handler(request)


class AgentProviderConfig(TypedDict, total=False):
    model: str
    baseUrl: str
    apiKey: str
    useResponsesApi: bool
    modelKwargs: dict[str, Any]
    reasoning: dict[str, Any] | None
    temperature: float | None
    maxTokens: int | None
    streaming: bool


def create_model(config: dict[str, Any]) -> ChatOpenAI:
    options: dict[str, Any] = {
        "model": config["model"],
        "api_key": config["apiKey"],
        "base_url": config["baseUrl"],
        "streaming": config.get("streaming", True) is not False,
        "use_responses_api": config.get("useResponsesApi", False),
        "model_kwargs": dict(config.get("modelKwargs") or {}),
    }
    if config.get("temperature") is not None:
        options["temperature"] = config["temperature"]
    if config.get("maxTokens") is not None:
        options["max_completion_tokens"] = config["maxTokens"]
    if isinstance(config.get("reasoning"), dict):
        options["reasoning"] = config["reasoning"]
    return ChatOpenAI(**options)


def create_agent(model: ChatOpenAI, tools: list[Any], request: dict[str, Any]) -> Any:
    permission_engine = PermissionEngine(sandbox_root=request.get("sandboxRoot"))
    memory_context = curated_memory_context(
        request.get("memories"),
        include_research=request.get("includeResearchMemory") is True,
    )
    system_prompt = request.get("systemPrompt") or ""
    if memory_context:
        system_prompt = f"{system_prompt}\n\n{memory_context}" if system_prompt else memory_context

    def permission_required(tool_name: str):
        def evaluate(call: Any) -> bool:
            tool_call = getattr(call, "tool_call", None)
            arguments = tool_call.get("args") if isinstance(tool_call, dict) else {}
            return not permission_engine.evaluate(tool_name, arguments).allowed

        return evaluate

    interrupt_on = {
        tool.name: {
            "allowed_decisions": (
                ["approve", "edit", "reject"]
                if tool.name == "propose_workspace_memory_update"
                else ["approve", "reject"]
            ),
            "description": f"Tool execution requires approval: {tool.name}",
            "when": permission_required(tool.name),
        }
        for tool in tools
    }
    return create_deep_agent(
        model=model,
        tools=tools,
        system_prompt=system_prompt or None,
        backend=StateBackend(),
        skills=None,
        subagents=[],
        permissions=[
            FilesystemPermission(
                operations=["read", "write"],
                paths=["/**"],
                mode="deny",
            )
        ],
        middleware=[PermissionMiddleware(permission_engine)],
        interrupt_on=interrupt_on,
    )


def build_agent_factory() -> Any:
    return create_agent
