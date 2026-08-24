from __future__ import annotations

from typing import Any, TypedDict


class ProviderConfigInput(TypedDict, total=False):
    id: str
    name: str
    model: str
    baseModel: str
    variant: str
    variantFormat: str
    baseUrl: str
    apiKey: str
    apiKeyEnc: bytes | None
    apiProtocol: str
    presetId: str
    reasoningControl: str
    reasoningEffort: str
    temperature: float | None
    maxTokens: int | None
    __text: str


class ProviderReasoningOptions(TypedDict, total=False):
    useResponsesApi: bool
    modelKwargs: dict[str, Any]
    reasoning: dict[str, Any]
    extraBody: dict[str, Any]


class ProviderRuntimeConfig(TypedDict, total=False):
    model: str
    baseUrl: str | None
    apiKey: str | None
    useResponsesApi: bool
    modelKwargs: dict[str, Any]
    reasoning: dict[str, Any]
    extraBody: dict[str, Any]
    temperature: float | None
    maxTokens: int | None
    streaming: bool


def build_provider_reasoning_options(
    provider: ProviderConfigInput, deep_thinking: bool | None
) -> ProviderReasoningOptions:
    model_kwargs: dict[str, Any] = {}
    extra_body: dict[str, Any] = {}
    reasoning: dict[str, Any] | None = None
    reasoning_effort = provider.get("reasoningEffort")
    reasoning_control = provider.get("reasoningControl")
    api_protocol = provider.get("apiProtocol")
    preset_id = provider.get("presetId")

    if deep_thinking is True and reasoning_effort != "none":
        if reasoning_control == "openai":
            if api_protocol == "openai-responses":
                reasoning = {"effort": reasoning_effort, "summary": "auto"}
            else:
                model_kwargs["reasoning_effort"] = reasoning_effort
        if reasoning_control == "thinking":
            extra_body["thinking"] = {"type": "enabled"}
            if preset_id != "kimi":
                extra_body["reasoning_effort"] = reasoning_effort
        if reasoning_control == "enable-thinking":
            extra_body["enable_thinking"] = True
            extra_body["reasoning_effort"] = reasoning_effort

    if deep_thinking is False:
        if reasoning_control == "thinking":
            extra_body["thinking"] = {"type": "disabled"}
        if reasoning_control == "enable-thinking":
            extra_body["enable_thinking"] = False

    result: ProviderReasoningOptions = {
        "useResponsesApi": api_protocol == "openai-responses",
        "modelKwargs": model_kwargs,
    }
    if reasoning is not None:
        result["reasoning"] = reasoning
    if extra_body:
        result["extraBody"] = extra_body
    return result


def build_provider_config(
    provider: ProviderConfigInput,
    *,
    model_id: str | None = None,
    deep_thinking: bool | None = None,
    max_tokens: int | None = None,
) -> ProviderRuntimeConfig:
    model = (model_id or "").strip() or (provider.get("model") or "")
    reasoning_options = build_provider_reasoning_options(provider, deep_thinking)
    final_max_tokens = max_tokens if max_tokens is not None else provider.get("maxTokens")
    config: ProviderRuntimeConfig = {
        "model": model,
        "baseUrl": provider.get("baseUrl"),
        "apiKey": provider.get("apiKey"),
        "useResponsesApi": reasoning_options["useResponsesApi"],
        "modelKwargs": reasoning_options["modelKwargs"],
        "temperature": provider.get("temperature"),
        "maxTokens": final_max_tokens,
    }
    if reasoning_options.get("extraBody") is not None:
        config["extraBody"] = reasoning_options["extraBody"]
    if reasoning_options.get("reasoning") is not None:
        config["reasoning"] = reasoning_options["reasoning"]
    return config
