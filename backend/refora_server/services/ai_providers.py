from __future__ import annotations

from typing import Any, Callable

import httpx

from refora_server.providers.catalog import (
    getProviderPreset,
    inferModelCapabilities,
    providerRequiresApiKey,
)
from refora_server.services.ai_summary import build_provider_reasoning_options
from refora_server.repositories.errors import RepoError

TEST_TIMEOUT_MS = 8_000


def normalize_base_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    try:
        from urllib.parse import urlparse

        parsed = urlparse(raw)
    except Exception:
        raise RepoError("invalid_input", "Base URL must be a valid HTTP or HTTPS URL")
    if parsed.scheme not in ("http", "https"):
        raise RepoError("invalid_input", "Base URL must use HTTP or HTTPS")
    return raw


def _fetch_models_from_endpoint(
    base_url: str,
    api_key: str,
    *,
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    base = base_url.rstrip("/")
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    client = client_factory(httpx.Client) if client_factory else httpx.Client
    try:
        with client(timeout=TEST_TIMEOUT_MS / 1000) as session:
            response = session.get(f"{base}/models", headers=headers)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if response.status_code >= 400:
        return {"ok": False, "error": f"HTTP {response.status_code}"}
    try:
        body = response.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    raw_models = body.get("data") if isinstance(body, dict) else None
    if not isinstance(raw_models, list):
        raw_models = []
    models: list[dict[str, Any]] = []
    for model in raw_models:
        if isinstance(model, dict) and isinstance(model.get("id"), str):
            models.append(model)
    return {"ok": True, "models": models}


def createAiProvidersService(repos: Any, deps: Any | None = None):
    deps = deps or {}
    client_factory = deps.get("client_factory") if isinstance(deps, dict) else None
    logger = deps.get("logger") if isinstance(deps, dict) else None

    def _warn(message: str) -> None:
        if logger is not None:
            try:
                logger.warning(message)
            except Exception:
                pass

    def list() -> list[dict[str, Any]]:
        return repos["aiProviders"]["list"]()

    def getProvider(providerId: str) -> dict[str, Any]:
        raw = repos["aiProviders"]["getRaw"](providerId)
        if raw is None:
            raise RepoError("not_found", f"provider not found: {providerId}")
        mapped = dict(raw)
        mapped["hasKey"] = mapped.get("apiKeyEnc") is not None
        mapped.pop("apiKeyEnc", None)
        return mapped

    def testProvider(providerId: str, apiKey: str = "") -> dict[str, Any]:
        try:
            raw = repos["aiProviders"]["getRaw"](providerId)
            if raw is None:
                return {"ok": False}
            provider = _map_raw_to_provider(raw)
            key = (apiKey or "").strip()
            if not key and providerRequiresApiKey(provider["presetId"]):
                return {"ok": False}
            result = _fetch_models_from_endpoint(
                provider["baseUrl"], key, client_factory=client_factory
            )
            if not result["ok"]:
                return {"ok": False}
            return {"ok": True, "model": provider["model"]}
        except Exception as e:
            _warn(f"aiProviders:testProvider failed: {e}")
            return {"ok": False}

    def listModels(providerId: str, apiKey: str = "") -> dict[str, Any]:
        try:
            raw = repos["aiProviders"]["getRaw"](providerId)
            if raw is None:
                return {"ok": False, "models": [], "error": "Provider not found"}
            provider = _map_raw_to_provider(raw)
            key = (apiKey or "").strip()
            if not key and providerRequiresApiKey(provider["presetId"]):
                return {"ok": False, "models": [], "error": "API key is required"}
            if not provider["baseUrl"]:
                return {"ok": False, "models": [], "error": "Base URL is required"}
            normalized = normalize_base_url(provider["baseUrl"])
            result = _fetch_models_from_endpoint(
                normalized, key, client_factory=client_factory
            )
            if not result["ok"]:
                return {"ok": False, "models": [], "error": result.get("error", "")}
            seen: set[str] = set()
            models: list[str] = []
            for model in result["models"]:
                model_id = model.get("id", "").strip() if isinstance(model.get("id"), str) else ""
                if not model_id or model_id in seen:
                    continue
                seen.add(model_id)
                models.append(model_id)
            models.sort()
            return {"ok": True, "models": models}
        except Exception as e:
            _warn(f"aiProviders:listModels failed: {e}")
            return {"ok": False, "models": [], "error": str(e)}

    def buildProviderConfig(
        providerId: str,
        apiKey: str,
        *,
        model_id: str | None = None,
        features: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        provider = resolveProvider(providerId, apiKey)
        key = provider["apiKey"]
        model = (model_id or "").strip() or (provider.get("model") or "")
        if not model:
            raise RepoError("invalid_input", "Model is required")
        requested = features or {}
        requested_effort = requested.get("reasoningEffort")
        if isinstance(requested_effort, str):
            provider["reasoningEffort"] = requested_effort
        if provider.get("reasoningControl") == "none":
            provider["reasoningEffort"] = "none"
        capabilities = inferModelCapabilities(provider["presetId"], model)
        supports_reasoning = capabilities.get("supportsReasoning") is True
        if isinstance(requested_effort, str):
            deep_thinking = requested_effort != "none"
        else:
            deep_thinking = requested.get("deepThinking") is True
        reasoning_options = build_provider_reasoning_options(
            provider,
            deep_thinking if supports_reasoning else None,
        )
        config: dict[str, Any] = {
            "model": model,
            "baseUrl": normalize_base_url(provider["baseUrl"]),
            "apiKey": key,
            "useResponsesApi": reasoning_options["useResponsesApi"],
            "modelKwargs": reasoning_options["modelKwargs"],
            "temperature": None
            if supports_reasoning
            else provider.get("temperature"),
            "maxTokens": provider.get("maxTokens"),
        }
        if reasoning_options.get("reasoning") is not None:
            config["reasoning"] = reasoning_options["reasoning"]
        return config

    def resolveProvider(providerId: str, apiKey: str) -> dict[str, Any]:
        raw = repos["aiProviders"]["getRaw"](providerId)
        if raw is None:
            raise RepoError("not_found", f"provider not found: {providerId}")
        provider = _map_raw_to_provider(raw)
        key = apiKey.strip()
        if not key and providerRequiresApiKey(provider["presetId"]):
            raise RepoError("invalid_input", "API key is required")
        provider.pop("apiKeyEnc", None)
        provider["apiKey"] = key
        return provider

    def getEncryptedApiKey(providerId: str) -> bytes | None:
        raw = repos["aiProviders"]["getRaw"](providerId)
        if raw is None:
            raise RepoError("not_found", f"provider not found: {providerId}")
        return raw.get("apiKeyEnc")

    return {
        "list": list,
        "getProvider": getProvider,
        "testProvider": testProvider,
        "listModels": listModels,
        "resolveProvider": resolveProvider,
        "buildProviderConfig": buildProviderConfig,
        "getEncryptedApiKey": getEncryptedApiKey,
    }


def _map_raw_to_provider(raw: dict[str, Any]) -> dict[str, Any]:
    preset_id = raw.get("presetId") or "custom"
    return {
        "id": raw.get("id"),
        "presetId": preset_id,
        "name": raw.get("name"),
        "baseUrl": raw.get("baseUrl") or getProviderPreset(preset_id)["baseUrl"],
        "apiProtocol": raw.get("apiProtocol"),
        "reasoningControl": raw.get("reasoningControl"),
        "reasoningEffort": raw.get("reasoningEffort"),
        "model": raw.get("model"),
        "baseModel": raw.get("baseModel"),
        "variant": raw.get("variant"),
        "variantFormat": raw.get("variantFormat"),
        "temperature": raw.get("temperature"),
        "maxTokens": raw.get("maxTokens"),
        "apiKeyEnc": raw.get("apiKeyEnc"),
    }
