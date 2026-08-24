from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _load_catalog() -> dict[str, Any]:
    path = Path(__file__).with_name("catalog.json")
    with path.open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise RuntimeError("Provider catalog must be an object")
    return value


_CATALOG = _load_catalog()
OPENAI_EFFORTS: list[str] = list(_CATALOG["openAiEfforts"])
PROVIDER_PRESETS: list[dict[str, Any]] = list(_CATALOG["presets"])
_REASONING_RULES: list[dict[str, Any]] = list(_CATALOG["reasoningRules"])
_VISION_RE = re.compile(_CATALOG["visionPattern"], re.IGNORECASE)
_NON_TOOL_RE = re.compile(_CATALOG["nonToolPattern"], re.IGNORECASE)
_NON_CHAT_RE = re.compile(_CATALOG["nonChatPattern"], re.IGNORECASE)


def getProviderPreset(id: str) -> dict[str, Any]:
    for preset in PROVIDER_PRESETS:
        if preset["id"] == id:
            return preset
    return PROVIDER_PRESETS[-1]


def providerRequiresApiKey(id: str) -> bool:
    return bool(getProviderPreset(id)["apiKeyRequired"])


def reasoningEffortsForModel(preset_id: str, model_id: str) -> list[str]:
    for rule in _REASONING_RULES:
        providers = rule.get("providers")
        if providers is not None and preset_id not in providers:
            continue
        if re.search(rule["pattern"], model_id, re.IGNORECASE):
            return list(rule["efforts"])
    return list(getProviderPreset(preset_id)["reasoningEfforts"])


def inferModelCapabilities(
    preset_id: str,
    model_id: str,
    hints: dict[str, Any] | None = None,
) -> dict[str, Any]:
    hints = hints or {}
    supported_parameters = sorted(set(hints.get("supportedParameters") or []))
    reasoning_efforts = reasoningEffortsForModel(preset_id, model_id)
    supports_reasoning = hints.get("supportsReasoning")
    return {
        "supportsReasoning": (
            supports_reasoning
            if isinstance(supports_reasoning, bool)
            else len(reasoning_efforts) > 0
        ),
        "reasoningEfforts": reasoning_efforts,
        "supportsVision": hints.get("supportsVision") is True
        or bool(_VISION_RE.search(model_id)),
        "supportsTools": hints.get("supportsTools") is True
        or "tools" in supported_parameters
        or not _NON_TOOL_RE.search(model_id),
        "supportedParameters": supported_parameters,
    }


def isLikelyChatModel(model_id: str) -> bool:
    return not _NON_CHAT_RE.search(model_id)


def pickDefaultModel(preset: dict[str, Any], model_ids: list[str]) -> str:
    default_model = preset["defaultModel"]
    if default_model in model_ids:
        return default_model
    for model_id in model_ids:
        if isLikelyChatModel(model_id):
            return model_id
    return default_model
