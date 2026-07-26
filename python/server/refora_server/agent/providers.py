from __future__ import annotations

from typing import Any, TypedDict

from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from langchain_openai import ChatOpenAI


class AgentProviderConfig(TypedDict, total=False):
    model: str
    baseUrl: str
    apiKey: str
    useResponsesApi: bool
    modelKwargs: dict[str, Any]
    reasoning: dict[str, Any] | None
    temperature: float | None
    maxTokens: int | None


def create_model(config: dict[str, Any]) -> ChatOpenAI:
    options: dict[str, Any] = {
        "model": config["model"],
        "api_key": config["apiKey"],
        "base_url": config["baseUrl"],
        "streaming": True,
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
    return create_deep_agent(
        model=model,
        tools=tools,
        system_prompt=request.get("systemPrompt") or None,
        backend=StateBackend(),
        interrupt_on={
            "prepare_paper_ocr": True,
            "publish_workspace_artifacts": True,
            "install_runtime_packages": True,
            "propose_workspace_memory_update": True,
        },
    )


def build_agent_factory() -> Any:
    return create_agent