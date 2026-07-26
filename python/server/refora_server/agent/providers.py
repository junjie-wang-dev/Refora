from __future__ import annotations

import json
from typing import Any, TypedDict

from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from deepagents.backends import CompositeBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI

from refora_server.agent.permissions import PermissionEngine
from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.sandbox_backend import create_refora_filesystem_backend
from refora_server.services.agent_memory import (
    GLOBAL_MEMORY_PATHS,
    MEMORY_PATHS,
    ReadonlyMemoryBackend,
)


_DISABLED_BUILTIN_TOOLS = frozenset({"execute"})
_SUBAGENT_PROFILES = (
    (
        "general-purpose",
        "Handle broad delegated research and synthesis tasks.",
        "Complete the delegated task using read-only Refora tools and sandbox files.",
    ),
    (
        "researcher",
        "Find and evaluate relevant academic and Web evidence.",
        "Research the delegated question, compare sources, and report evidence with identifiers.",
    ),
    (
        "analyst",
        "Analyze papers, claims, methods, and structured evidence.",
        "Analyze the delegated material carefully and return a concise supported synthesis.",
    ),
    (
        "data-analyst",
        "Inspect and transform research data stored in sandbox files.",
        "Analyze sandbox data with available file tools and return methods, findings, and limitations.",
    ),
)

register_harness_profile(
    "openai",
    HarnessProfile(
        excluded_tools=_DISABLED_BUILTIN_TOOLS,
        general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=True),
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
    api_key = config.get("apiKey")
    if not isinstance(api_key, str) or not api_key:
        api_key = "local-provider"
    options: dict[str, Any] = {
        "model": config["model"],
        "api_key": api_key,
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
    filesystem_backend = create_refora_filesystem_backend(request["sandboxRoot"])
    backend = CompositeBackend(
        default=filesystem_backend,
        routes={
            "/memories/": ReadonlyMemoryBackend(request.get("memories") or {})
        },
    )
    refora_tools = [tool for tool in tools if tool.name != "write_todos"]
    read_tools = [
        tool for tool in refora_tools if classify(tool.name) is RiskClass.READ
    ]
    filesystem_permissions = [
        FilesystemPermission(
            operations=["write"],
            paths=["/memories/**"],
            mode="deny",
        ),
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/**"],
            mode="allow",
        )
    ]
    subagents = [
        {
            "name": name,
            "description": description,
            "system_prompt": (
                f"{prompt} Curated user-approved context is available read-only "
                "under /memories/. Read relevant memory files before making claims "
                "about preferences, prior decisions, terminology, or research state."
            ),
            "tools": read_tools,
            "permissions": filesystem_permissions,
            "interrupt_on": {},
        }
        for name, description, prompt in _SUBAGENT_PROFILES
    ]
    system_prompt = request.get("systemPrompt") or ""
    system_prompt = (
        f"{system_prompt}\n\nCurated user-approved context is mounted read-only "
        "under /memories/. Use propose_workspace_memory_update for changes."
    )
    memory_paths = (
        MEMORY_PATHS
        if request.get("includeResearchMemory") is True
        else GLOBAL_MEMORY_PATHS
    )

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
        for tool in refora_tools
    }
    return create_deep_agent(
        model=model,
        tools=refora_tools,
        system_prompt=system_prompt or None,
        backend=backend,
        skills=None,
        memory=[f"/memories{path}" for path in memory_paths],
        subagents=subagents,
        permissions=filesystem_permissions,
        middleware=[PermissionMiddleware(permission_engine)],
        interrupt_on=interrupt_on,
    )


def build_agent_factory() -> Any:
    return create_agent
