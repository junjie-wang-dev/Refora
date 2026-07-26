from __future__ import annotations

from typing import Any

import pytest

from refora_server.agent import providers


def test_create_model_with_reasoning_sets_key_attributes() -> None:
    config: dict[str, Any] = {
        "model": "gpt-4o",
        "baseUrl": "https://example.test/v1",
        "apiKey": "test-key",
        "useResponsesApi": True,
        "modelKwargs": {"extra_option": "x"},
        "reasoning": {"effort": "high", "summary": "auto"},
        "temperature": 0.2,
        "maxTokens": 123,
    }

    model = providers.create_model(config)

    assert model.model_name == "gpt-4o"
    assert model.use_responses_api is True
    assert model.streaming is True
    assert model.temperature == 0.2
    assert model.model_kwargs == {"extra_option": "x"}
    assert model.reasoning == {"effort": "high", "summary": "auto"}


def test_create_model_temperature_none_omits_temperature_kwarg(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_init(self: Any, *args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr("refora_server.agent.providers.ChatOpenAI.__init__", fake_init)

    config: dict[str, Any] = {
        "model": "gpt-4o",
        "baseUrl": "https://example.test/v1",
        "apiKey": "test-key",
        "useResponsesApi": False,
        "modelKwargs": {},
        "temperature": None,
        "maxTokens": None,
    }

    providers.create_model(config)

    assert "temperature" not in captured
    assert captured["model"] == "gpt-4o"
    assert captured["api_key"] == "test-key"
    assert captured["base_url"] == "https://example.test/v1"
    assert captured["streaming"] is True
    assert captured["use_responses_api"] is False
    assert captured["model_kwargs"] == {}
    assert "reasoning" not in captured
    assert "max_completion_tokens" not in captured


def test_create_model_use_responses_api_true_sets_attribute() -> None:
    config: dict[str, Any] = {
        "model": "gpt-4o",
        "baseUrl": "https://example.test/v1",
        "apiKey": "test-key",
        "useResponsesApi": True,
        "modelKwargs": {},
        "temperature": None,
        "maxTokens": None,
    }

    model = providers.create_model(config)

    assert model.use_responses_api is True


def test_build_agent_factory_returns_create_agent() -> None:
    assert providers.build_agent_factory() is providers.create_agent