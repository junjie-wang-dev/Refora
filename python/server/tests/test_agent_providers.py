from __future__ import annotations

from types import SimpleNamespace
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


def test_create_model_can_disable_streaming(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_init(self: Any, *args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr("refora_server.agent.providers.ChatOpenAI.__init__", fake_init)

    providers.create_model(
        {
            "model": "gpt-4o",
            "baseUrl": "https://example.test/v1",
            "apiKey": "test-key",
            "streaming": False,
        }
    )

    assert captured["streaming"] is False


def test_build_agent_factory_returns_create_agent() -> None:
    assert providers.build_agent_factory() is providers.create_agent


def test_create_agent_routes_every_exposed_tool_through_permission_evaluation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_deep_agent(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return kwargs

    monkeypatch.setattr(providers, "create_deep_agent", fake_create_deep_agent)
    tools = [
        SimpleNamespace(name="search_library"),
        SimpleNamespace(name="generate_report"),
        SimpleNamespace(name="prepare_paper_ocr"),
        SimpleNamespace(name="propose_workspace_memory_update"),
        SimpleNamespace(name="__execute"),
    ]

    providers.create_agent(
        object(),
        tools,
        {
            "sandboxRoot": "/tmp/refora-sandbox",
            "systemPrompt": "prompt",
            "memories": {
                "/brief.md": "Compare methods.",
                "/research.md": "Follow the robustness lead.",
            },
            "includeResearchMemory": True,
        },
    )

    assert captured["skills"] is None
    assert captured["subagents"] == []
    permission = captured["permissions"][0]
    assert permission.operations == ["read", "write"]
    assert permission.paths == ["/**"]
    assert permission.mode == "deny"
    policies = captured["interrupt_on"]
    assert set(policies) == {tool.name for tool in tools}
    assert policies["search_library"]["when"](
        SimpleNamespace(tool_call={"args": {"query": "paper"}})
    ) is False
    assert policies["generate_report"]["when"](
        SimpleNamespace(tool_call={"args": {"title": "Report"}})
    ) is True
    assert policies["propose_workspace_memory_update"]["allowed_decisions"] == [
        "approve",
        "edit",
        "reject",
    ]
    assert "Compare methods." in captured["system_prompt"]
    assert "Follow the robustness lead." in captured["system_prompt"]
    assert policies["prepare_paper_ocr"]["when"](
        SimpleNamespace(tool_call={"args": {"docId": "doc-1"}})
    ) is True
    assert policies["__execute"]["when"](
        SimpleNamespace(tool_call={"args": {"command": "python script.py"}})
    ) is True
    assert policies["generate_report"]["when"](
        SimpleNamespace(tool_call={"args": {"path": "/outside/report.md"}})
    ) is True

    executed: list[bool] = []
    middleware = captured["middleware"][0]
    denied = middleware.wrap_tool_call(
        SimpleNamespace(
            tool_call={
                "name": "generate_report",
                "args": {"path": "/outside/report.md"},
                "id": "call-1",
            }
        ),
        lambda _request: executed.append(True),
    )
    assert denied.status == "error"
    assert '"code":"permission_denied"' in denied.content
    assert executed == []


def test_builtin_filesystem_execution_and_subagent_tools_are_disabled() -> None:
    assert providers._DISABLED_BUILTIN_TOOLS == {
        "task",
        "ls",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "execute",
    }
