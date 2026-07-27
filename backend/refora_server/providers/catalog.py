from __future__ import annotations

import re
from typing import Any

OPENAI_EFFORTS: list[str] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]

PROVIDER_PRESETS: list[dict[str, Any]] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "mark": "OA",
        "description": "GPT models through the native Responses API",
        "baseUrl": "https://api.openai.com/v1",
        "apiProtocol": "openai-responses",
        "reasoningControl": "openai",
        "reasoningEfforts": OPENAI_EFFORTS,
        "defaultReasoningEffort": "medium",
        "defaultModel": "gpt-5.6-terra",
        "apiKeyRequired": True,
        "popular": True,
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "mark": "DS",
        "description": "DeepSeek chat and hybrid thinking models",
        "baseUrl": "https://api.deepseek.com",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "thinking",
        "reasoningEfforts": ["none", "high", "max"],
        "defaultReasoningEffort": "high",
        "defaultModel": "deepseek-v4-flash",
        "apiKeyRequired": True,
        "popular": True,
    },
    {
        "id": "kimi",
        "name": "Kimi",
        "mark": "KM",
        "description": "Moonshot long-context and thinking models",
        "baseUrl": "https://api.moonshot.cn/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "thinking",
        "reasoningEfforts": ["none", "high"],
        "defaultReasoningEffort": "high",
        "defaultModel": "kimi-k2.6",
        "apiKeyRequired": True,
        "popular": True,
    },
    {
        "id": "ollama-cloud",
        "name": "Ollama Cloud",
        "mark": "OC",
        "description": "Cloud models through a signed-in local Ollama service",
        "baseUrl": "http://localhost:11434/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": ["none", "low", "medium", "high"],
        "defaultReasoningEffort": "medium",
        "defaultModel": "gpt-oss:120b-cloud",
        "apiKeyRequired": False,
        "popular": True,
    },
    {
        "id": "ollama-local",
        "name": "Ollama Local",
        "mark": "OL",
        "description": "Models running privately on this Mac",
        "baseUrl": "http://localhost:11434/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": ["none", "low", "medium", "high"],
        "defaultReasoningEffort": "medium",
        "defaultModel": "gpt-oss:20b",
        "apiKeyRequired": False,
        "popular": True,
    },
    {
        "id": "glm",
        "name": "GLM",
        "mark": "GL",
        "description": "Zhipu GLM reasoning and agent models",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "thinking",
        "reasoningEfforts": OPENAI_EFFORTS,
        "defaultReasoningEffort": "high",
        "defaultModel": "glm-5.2",
        "apiKeyRequired": True,
        "popular": True,
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "mark": "OR",
        "description": "Hundreds of models behind one API key",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": OPENAI_EFFORTS,
        "defaultReasoningEffort": "medium",
        "defaultModel": "openai/gpt-5.4-mini",
        "apiKeyRequired": True,
        "popular": True,
    },
    {
        "id": "qwen",
        "name": "Qwen",
        "mark": "QW",
        "description": "Alibaba Model Studio Qwen models",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "enable-thinking",
        "reasoningEfforts": ["none", "high"],
        "defaultReasoningEffort": "high",
        "defaultModel": "qwen3.7-plus",
        "apiKeyRequired": True,
        "popular": False,
    },
    {
        "id": "siliconflow",
        "name": "SiliconFlow",
        "mark": "SF",
        "description": "Fast access to leading open models",
        "baseUrl": "https://api.siliconflow.cn/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": ["none", "low", "medium", "high"],
        "defaultReasoningEffort": "high",
        "defaultModel": "deepseek-ai/DeepSeek-R1",
        "apiKeyRequired": True,
        "popular": False,
    },
    {
        "id": "together",
        "name": "Together AI",
        "mark": "TG",
        "description": "Open models with serverless inference",
        "baseUrl": "https://api.together.ai/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": ["none", "low", "medium", "high", "max"],
        "defaultReasoningEffort": "medium",
        "defaultModel": "openai/gpt-oss-20b",
        "apiKeyRequired": True,
        "popular": False,
    },
    {
        "id": "groq",
        "name": "Groq",
        "mark": "GQ",
        "description": "Low-latency OpenAI-compatible inference",
        "baseUrl": "https://api.groq.com/openai/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": ["none", "low", "medium", "high"],
        "defaultReasoningEffort": "medium",
        "defaultModel": "openai/gpt-oss-20b",
        "apiKeyRequired": True,
        "popular": False,
    },
    {
        "id": "mistral",
        "name": "Mistral AI",
        "mark": "MI",
        "description": "Mistral chat, code, and reasoning models",
        "baseUrl": "https://api.mistral.ai/v1",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "none",
        "reasoningEfforts": [],
        "defaultReasoningEffort": "none",
        "defaultModel": "mistral-large-latest",
        "apiKeyRequired": True,
        "popular": False,
    },
    {
        "id": "custom",
        "name": "Custom provider",
        "mark": "+",
        "description": "Any Responses or OpenAI-compatible endpoint",
        "baseUrl": "",
        "apiProtocol": "openai-compatible",
        "reasoningControl": "openai",
        "reasoningEfforts": OPENAI_EFFORTS,
        "defaultReasoningEffort": "medium",
        "defaultModel": "",
        "apiKeyRequired": False,
        "popular": False,
    },
]

_REASONING_TOKEN_RE = re.compile(
    r"gpt-5|gpt-oss|\bo[134](?:\b|-)|reason|thinking|deepseek-r1|deepseek-v4|qwq|qwen3|glm-[45]|magistral",
    re.IGNORECASE,
)
_PARAMETER_REASONING_KEYS = {
    "reasoning",
    "reasoning_effort",
    "include_reasoning",
    "thinking",
    "enable_thinking",
}
_VISION_RE = re.compile(
    r"vision|vl|gpt-4o|gpt-5|gemini|pixtral|llava|qwen.*vl|kimi-k2\.[5-7]",
    re.IGNORECASE,
)
_NON_TOOL_RE = re.compile(
    r"embed|moderation|rerank|whisper|tts|image|audio|guard", re.IGNORECASE
)
_NON_CHAT_RE = re.compile(
    r"embed|moderation|rerank|whisper|transcri|tts|image|dall-e|realtime|audio|guard",
    re.IGNORECASE,
)
_KIMI_RE = re.compile(r"k2\.7-code|thinking", re.IGNORECASE)
_KIMI_VERSION_RE = re.compile(r"k2\.6|k2\.5", re.IGNORECASE)
_DEEPSEEK_RE = re.compile(r"v4-(?:flash|pro)|reasoner", re.IGNORECASE)
_GLM_52_RE = re.compile(r"glm-5\.2", re.IGNORECASE)
_GLM_OTHER_RE = re.compile(r"glm-(?:5\.1|5|4\.[5-7])", re.IGNORECASE)
_GPT_OSS_RE = re.compile(r"gpt-oss", re.IGNORECASE)
_QWEN3_RE = re.compile(r"qwen3", re.IGNORECASE)
_DEEPSEEK_THINK_RE = re.compile(r"qwen3|deepseek|reason|thinking", re.IGNORECASE)


def getProviderPreset(id: str) -> dict[str, Any]:
    for preset in PROVIDER_PRESETS:
        if preset["id"] == id:
            return preset
    return PROVIDER_PRESETS[-1]


def providerRequiresApiKey(id: str) -> bool:
    return bool(getProviderPreset(id)["apiKeyRequired"])


def _has_reasoning_token(model_id: str) -> bool:
    return bool(_REASONING_TOKEN_RE.search(model_id))


def reasoningEffortsForModel(
    preset_id: str,
    model_id: str,
    supports_reasoning_hint: bool = False,
) -> list[str]:
    id_ = model_id.lower()
    if preset_id == "kimi":
        if _KIMI_RE.search(id_):
            return ["high"]
        return ["none", "high"] if _KIMI_VERSION_RE.search(id_) else []
    if preset_id == "deepseek":
        if _DEEPSEEK_RE.search(id_):
            return ["none", "high", "max"]
        return []
    if preset_id == "glm":
        if _GLM_52_RE.search(id_):
            return list(OPENAI_EFFORTS)
        return ["none", "high"] if _GLM_OTHER_RE.search(id_) else []
    if _GPT_OSS_RE.search(id_):
        return ["low", "medium", "high"]
    if preset_id == "groq" and _QWEN3_RE.search(id_):
        return ["none", "high"]
    if preset_id in ("ollama-local", "ollama-cloud"):
        if _DEEPSEEK_THINK_RE.search(id_):
            return ["none", "high"]
    if preset_id == "qwen":
        return ["none", "high"] if _QWEN3_RE.search(id_) else []
    if preset_id == "openai":
        return list(OPENAI_EFFORTS) if _has_reasoning_token(id_) else []
    if preset_id == "openrouter" and (
        supports_reasoning_hint or _has_reasoning_token(id_)
    ):
        return list(OPENAI_EFFORTS)
    if supports_reasoning_hint or _has_reasoning_token(id_):
        return list(getProviderPreset(preset_id)["reasoningEfforts"])
    return []


def inferModelCapabilities(
    preset_id: str,
    model_id: str,
    hints: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if hints is None:
        hints = {}
    supported_parameters = sorted(set(hints.get("supportedParameters") or []))
    parameter_reasoning = any(
        param in _PARAMETER_REASONING_KEYS for param in supported_parameters
    )
    reasoning_efforts = reasoningEffortsForModel(
        preset_id,
        model_id,
        hints.get("supportsReasoning") is True or parameter_reasoning,
    )
    id_ = model_id.lower()
    return {
        "supportsReasoning": len(reasoning_efforts) > 0,
        "reasoningEfforts": reasoning_efforts,
        "supportsVision": hints.get("supportsVision") is True
        or bool(_VISION_RE.search(id_)),
        "supportsTools": hints.get("supportsTools") is True
        or "tools" in supported_parameters
        or not _NON_TOOL_RE.search(id_),
        "supportedParameters": supported_parameters,
    }


def isLikelyChatModel(model_id: str) -> bool:
    return not _NON_CHAT_RE.search(model_id)


def pickDefaultModel(preset: dict[str, Any], model_ids: list[str]) -> str:
    default_model = preset["defaultModel"]
    if default_model in model_ids:
        return default_model
    for mid in model_ids:
        if isLikelyChatModel(mid):
            return mid
    return default_model
