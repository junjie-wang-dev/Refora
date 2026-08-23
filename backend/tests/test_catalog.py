from refora_server.providers.catalog import (
    inferModelCapabilities,
    isLikelyChatModel,
    pickDefaultModel,
    reasoningEffortsForModel,
)


def test_infer_reasoning_for_openai_gpt5():
    caps = inferModelCapabilities("openai", "gpt-5.6-terra")
    assert caps["supportsReasoning"] is True
    assert caps["reasoningEfforts"] == [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]


def test_infer_reasoning_for_plain_chat_model():
    caps = inferModelCapabilities("custom", "my-chat-model")
    assert caps["supportsReasoning"] is True
    assert caps["reasoningEfforts"] == [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]


def test_infer_no_reasoning_when_preset_has_no_reasoning_levels():
    caps = inferModelCapabilities("mistral", "mistral-large-latest")
    assert caps["supportsReasoning"] is False
    assert caps["reasoningEfforts"] == []


def test_infer_vision_from_model_id():
    caps = inferModelCapabilities("custom", "some-model-vl")
    assert caps["supportsVision"] is True


def test_infer_vision_from_hint_overrides_regex():
    caps = inferModelCapabilities("custom", "plain-model", {"supportsVision": True})
    assert caps["supportsVision"] is True


def test_infer_tools_for_chat_model():
    caps = inferModelCapabilities("custom", "chat-model")
    assert caps["supportsTools"] is True


def test_infer_no_tools_for_embedding_model():
    caps = inferModelCapabilities("custom", "text-embedding-3")
    assert caps["supportsTools"] is False


def test_infer_tools_from_supported_parameters():
    caps = inferModelCapabilities(
        "custom", "plain-model", {"supportedParameters": ["tools"]}
    )
    assert caps["supportsTools"] is True


def test_supported_parameters_deduped_and_sorted():
    caps = inferModelCapabilities(
        "custom", "m", {"supportedParameters": ["tools", "temperature", "tools"]}
    )
    assert caps["supportedParameters"] == ["temperature", "tools"]


def test_reasoning_via_parameter_hint():
    caps = inferModelCapabilities(
        "openrouter",
        "some-unknown-model",
        {"supportedParameters": ["reasoning"]},
    )
    assert caps["supportsReasoning"] is True


def test_reasoning_efforts_for_glm_52():
    assert reasoningEffortsForModel("glm", "glm-5.2") == [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]


def test_reasoning_efforts_for_deepseek_v4_flash():
    assert reasoningEffortsForModel("deepseek", "deepseek-v4-flash") == [
        "none",
        "high",
        "max",
    ]


def test_reasoning_efforts_for_kimi_k26():
    assert reasoningEffortsForModel("kimi", "kimi-k2.6") == ["none", "high"]


def test_reasoning_efforts_for_provider_alias():
    assert reasoningEffortsForModel("custom", "xopkimik26") == [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]


def test_is_likely_chat_model():
    assert isLikelyChatModel("gpt-5.6-terra") is True
    assert isLikelyChatModel("text-embedding-3") is False
    assert isLikelyChatModel("whisper-1") is False


def test_pick_default_model_prefers_preset_default_when_present():
    from refora_server.providers.catalog import getProviderPreset

    preset = getProviderPreset("openai")
    assert pickDefaultModel(preset, ["gpt-5.6-terra", "other"]) == "gpt-5.6-terra"


def test_pick_default_model_falls_back_to_first_chat_model():
    from refora_server.providers.catalog import getProviderPreset

    preset = getProviderPreset("openai")
    assert pickDefaultModel(preset, ["text-embedding-3", "gpt-chat"]) == "gpt-chat"
