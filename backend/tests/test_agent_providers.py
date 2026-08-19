from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from deepagents.backends import CompositeBackend
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import Field

from refora_server.agent import providers
from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.sandbox_backend import ReforaFilesystemBackend
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools


class RecordingOpenAIModel(FakeMessagesListChatModel):
    bound_tool_names: list[list[str]] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.bound_tool_names.append(
            [
                str(tool.get("name") or tool.get("type"))
                if isinstance(tool, dict)
                else tool.name
                for tool in tools
            ]
        )
        return self

    def _get_ls_params(self, **kwargs):
        return {
            "ls_provider": "openai",
            "ls_model_name": "test-model",
            "ls_model_type": "chat",
        }


def _subagent_graphs(agent):
    task = agent.nodes["tools"].bound._tools_by_name["task"]
    for cell in task.func.__closure__ or ():
        value = cell.cell_contents
        if isinstance(value, dict) and set(value) == {
            "general-purpose",
            "researcher",
            "analyst",
            "data-analyst",
        }:
            return value
    raise AssertionError("Compiled subagent graphs were not found")


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


def test_create_model_places_custom_reasoning_fields_in_extra_body() -> None:
    config: dict[str, Any] = {
        "model": "xopkimik26",
        "baseUrl": "https://example.test/v1",
        "apiKey": "test-key",
        "useResponsesApi": False,
        "modelKwargs": {},
        "extraBody": {"enable_thinking": True},
        "temperature": None,
        "maxTokens": None,
    }

    model = providers.create_model(config)
    payload = model._get_request_payload("Explain this")

    assert model.extra_body == {"enable_thinking": True}
    assert model.model_kwargs == {}
    assert payload["extra_body"] == {"enable_thinking": True}
    assert "enable_thinking" not in payload


def test_create_model_sends_and_preserves_compatible_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        chunks = [
            {
                "id": "chunk-1",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "xopkimik26",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": None,
                        "delta": {
                            "role": "assistant",
                            "content": "",
                            "reasoning_content": "provider reasoning",
                        },
                    }
                ],
            },
            {
                "id": "chunk-2",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "xopkimik26",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": None,
                        "delta": {"content": "Visible answer"},
                    }
                ],
            },
            {
                "id": "chunk-3",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "xopkimik26",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "delta": {"content": ""},
                    }
                ],
            },
        ]
        body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        body += "data: [DONE]\n\n"
        return httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/event-stream"},
            request=request,
        )

    async def run() -> list[Any]:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        original = providers.ChatOpenAI
        monkeypatch.setattr(
            providers,
            "ChatOpenAI",
            lambda **kwargs: original(**kwargs, http_async_client=client),
        )
        model = providers.create_model(
            {
                "model": "xopkimik26",
                "baseUrl": "https://example.test/v1",
                "apiKey": "test-key",
                "useResponsesApi": False,
                "modelKwargs": {},
                "extraBody": {
                    "enable_thinking": True,
                    "reasoning_effort": "max",
                },
                "temperature": None,
                "maxTokens": None,
            }
        )
        result = [chunk async for chunk in model.astream("Explain this")]
        await client.aclose()
        return result

    streamed = asyncio.run(run())

    assert captured["enable_thinking"] is True
    assert captured["reasoning_effort"] == "max"
    assert "extra_body" not in captured
    assert streamed[0].additional_kwargs["reasoning_content"] == "provider reasoning"
    assert "".join(chunk.text for chunk in streamed) == "Visible answer"


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


def test_create_model_supplies_placeholder_key_for_local_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_init(self: Any, *args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr("refora_server.agent.providers.ChatOpenAI.__init__", fake_init)

    providers.create_model(
        {
            "model": "llama3.2",
            "baseUrl": "http://127.0.0.1:11434/v1",
            "apiKey": "",
        }
    )

    assert captured["api_key"] == "local-provider"


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
        SimpleNamespace(name="search_documents"),
        SimpleNamespace(name="generate_report"),
        SimpleNamespace(name="prepare_paper_ocr"),
        SimpleNamespace(name="propose_workspace_memory_update"),
        SimpleNamespace(name="__execute"),
        SimpleNamespace(name="write_todos"),
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
    assert {subagent["name"] for subagent in captured["subagents"]} == {
        "general-purpose",
        "researcher",
        "analyst",
        "data-analyst",
    }
    for subagent in captured["subagents"]:
        assert [tool.name for tool in subagent["tools"]] == ["search_documents"]
        assert subagent["interrupt_on"] == {}
    assert isinstance(captured["backend"], CompositeBackend)
    assert isinstance(captured["backend"].default, ReforaFilesystemBackend)
    memory_backend = captured["backend"].routes["/memories/"]
    assert (
        memory_backend.read("/brief.md").file_data["content"]
        == "Compare methods."
    )
    assert captured["memory"] == [
        "/memories/brief.md",
        "/memories/preferences.md",
        "/memories/decisions.md",
        "/memories/glossary.md",
        "/memories/research.md",
    ]
    assert captured["permissions"][0].mode == "deny"
    assert captured["permissions"][0].paths == ["/memories/**"]
    permission = captured["permissions"][1]
    assert permission.operations == ["read", "write"]
    assert permission.paths == ["/**"]
    assert permission.mode == "allow"
    policies = captured["interrupt_on"]
    assert set(policies) == {
        "search_documents",
        "generate_report",
        "prepare_paper_ocr",
        "propose_workspace_memory_update",
        "__execute",
    }
    assert [tool.name for tool in captured["tools"]] == [
        "search_documents",
        "generate_report",
        "prepare_paper_ocr",
        "propose_workspace_memory_update",
        "__execute",
    ]
    assert policies["search_documents"]["when"](
        SimpleNamespace(tool_call={"args": {"query": "paper"}})
    ) is False
    assert policies["generate_report"]["when"](
        SimpleNamespace(tool_call={"args": {"title": "Report"}})
    ) is False
    assert policies["propose_workspace_memory_update"]["allowed_decisions"] == [
        "approve",
        "edit",
        "reject",
    ]
    assert "/memories/" in captured["system_prompt"]
    assert "Prefer ls, read_file, write_file" in captured["system_prompt"]
    assert "$REFORA_OUTPUTS" in captured["system_prompt"]
    for subagent in captured["subagents"]:
        assert "/memories/" in subagent["system_prompt"]
    assert policies["prepare_paper_ocr"]["when"](
        SimpleNamespace(tool_call={"args": {"docId": "doc-1"}})
    ) is True
    assert policies["__execute"]["when"](
        SimpleNamespace(tool_call={"args": {"command": "python script.py"}})
    ) is False
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


def test_create_agent_binds_native_web_search_without_local_tool_collision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_deep_agent(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return kwargs

    monkeypatch.setattr(providers, "create_deep_agent", fake_create_deep_agent)
    local_search = SimpleNamespace(name="web_search")
    library_search = SimpleNamespace(name="search_documents")

    providers.create_agent(
        object(),
        [local_search, library_search],
        {
            "sandboxRoot": "/tmp/refora-sandbox",
            "systemPrompt": "prompt",
            "memories": {},
            "useNativeWebSearch": True,
        },
    )

    assert local_search not in captured["tools"]
    assert library_search in captured["tools"]
    assert {"type": "web_search"} in captured["tools"]
    assert set(captured["interrupt_on"]) == {"search_documents"}
    for subagent in captured["subagents"]:
        assert local_search not in subagent["tools"]
        assert library_search in subagent["tools"]
        assert {"type": "web_search"} in subagent["tools"]


def test_only_builtin_execute_is_disabled() -> None:
    assert providers._DISABLED_BUILTIN_TOOLS == {"execute"}


def test_real_deep_agent_uses_stateful_todos_and_restricted_subagents(tmp_path) -> None:
    responses = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "write_todos",
                    "args": {
                        "todos": [
                            {"content": "Inspect evidence", "status": "in_progress"}
                        ]
                    },
                    "id": "todo-1",
                    "type": "tool_call",
                }
            ],
        ),
        AIMessage(content="Todo recorded"),
        AIMessage(content="Subagent done"),
        AIMessage(content="Subagent done"),
        AIMessage(content="Subagent done"),
        AIMessage(content="Subagent done"),
    ]
    model = RecordingOpenAIModel(responses=responses)
    tools = create_agent_tools(AgentToolContext(run_id="run-1"), {})
    graph = providers.create_agent(
        model,
        tools,
        {
            "sandboxRoot": str((tmp_path / "sandbox").resolve()),
            "systemPrompt": "Research carefully.",
            "memories": {},
        },
    )

    result = graph.invoke({"messages": [HumanMessage(content="Plan the work")]})

    assert result["todos"] == [
        {"content": "Inspect evidence", "status": "in_progress"}
    ]
    main_tool_list = model.bound_tool_names[0]
    main_tools = set(main_tool_list)
    assert {
        "write_todos",
        "ls",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "task",
        "__execute",
    } <= main_tools
    assert "execute" not in main_tools
    assert main_tool_list.count("write_todos") == 1

    subagent_graphs = _subagent_graphs(graph)
    for subagent in subagent_graphs.values():
        before = len(model.bound_tool_names)
        subagent.invoke({"messages": [HumanMessage(content="Analyze this")]})
        available = set(model.bound_tool_names[before])
        refora_names = {
            name for name in available if name in {tool.name for tool in tools}
        }
        assert refora_names
        assert all(classify(name) is RiskClass.READ for name in refora_names)
        assert {
            "ls",
            "read_file",
            "write_file",
            "edit_file",
            "glob",
            "grep",
            "write_todos",
        } <= available
        assert "execute" not in available
        assert "task" not in available


def test_real_deep_agent_binds_native_web_search_once(tmp_path) -> None:
    model = RecordingOpenAIModel(responses=[AIMessage(content="Finished")])
    tools = create_agent_tools(AgentToolContext(run_id="run-native"), {})
    graph = providers.create_agent(
        model,
        tools,
        {
            "sandboxRoot": str((tmp_path / "sandbox").resolve()),
            "systemPrompt": "Research current information.",
            "memories": {},
            "useNativeWebSearch": True,
        },
    )

    graph.invoke({"messages": [HumanMessage(content="Find current evidence")]})

    assert model.bound_tool_names[0].count("web_search") == 1


def test_real_deep_agent_files_persist_and_cannot_escape_backend(tmp_path) -> None:
    root = (tmp_path / "sandbox").resolve()
    model = RecordingOpenAIModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "write_file",
                        "args": {
                            "file_path": "/outputs/report.md",
                            "content": "persisted",
                        },
                        "id": "write-ok",
                        "type": "tool_call",
                    },
                    {
                        "name": "write_file",
                        "args": {
                            "file_path": "/etc/refora-escape",
                            "content": "blocked",
                        },
                        "id": "write-blocked",
                        "type": "tool_call",
                    },
                ],
            ),
            AIMessage(content="Finished"),
        ]
    )
    graph = providers.create_agent(
        model,
        [],
        {
            "sandboxRoot": str(root),
            "systemPrompt": "Use sandbox files.",
            "memories": {},
        },
    )

    result = graph.invoke({"messages": [HumanMessage(content="Write both files")]})

    assert (root / "outputs" / "report.md").read_text() == "persisted"
    tool_messages = [
        message for message in result["messages"] if isinstance(message, ToolMessage)
    ]
    assert len(tool_messages) == 2
    assert tool_messages[1].status == "error"
    assert "approved directory" in tool_messages[1].content
    second = ReforaFilesystemBackend(root)
    assert second.read("/outputs/report.md").file_data["content"] == "persisted"


def _make_streaming_model() -> Any:
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model="gpt-4o",
        api_key="test-key",
        base_url="https://example.test/v1",
        streaming=True,
    )


def test_create_model_patches_streaming_role_normalizer() -> None:
    model = providers.create_model(
        {
            "model": "gpt-4o",
            "baseUrl": "https://example.test/v1",
            "apiKey": "test-key",
            "streaming": True,
        }
    )
    assert callable(getattr(model, "_convert_chunk_to_generation_chunk", None))


def test_streaming_role_patch_injects_assistant_when_role_missing() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    chunk = {"choices": [{"delta": {"content": "hello"}, "index": 0, "finish_reason": None}]}
    generation = model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert generation is not None
    assert isinstance(generation.message, AIMessageChunk)
    assert generation.message.content == "hello"


def test_streaming_role_patch_mutates_delta_to_assistant() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    delta = {"content": "world"}
    chunk = {"choices": [{"delta": delta, "index": 0, "finish_reason": None}]}
    model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert delta.get("role") == "assistant"


def test_streaming_role_patch_preserves_explicit_role() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    delta = {"role": "assistant", "content": "keep"}
    chunk = {"choices": [{"delta": delta, "index": 0, "finish_reason": None}]}
    generation = model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert generation is not None
    assert isinstance(generation.message, AIMessageChunk)
    assert delta["role"] == "assistant"


def test_streaming_role_patch_preserves_reasoning_content() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    delta = {"content": "", "reasoning_content": "provider thought"}
    chunk = {"choices": [{"delta": delta, "index": 0, "finish_reason": None}]}
    generation = model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert generation is not None
    assert generation.message.additional_kwargs["reasoning_content"] == "provider thought"


def test_streaming_role_patch_preserves_reasoning_details() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    details = [{"type": "reasoning.text", "text": "provider details"}]
    delta = {"content": "", "reasoning_details": details}
    chunk = {"choices": [{"delta": delta, "index": 0, "finish_reason": None}]}
    generation = model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert generation is not None
    assert generation.message.additional_kwargs["reasoning_details"] == details


def test_streaming_role_patch_handles_chunk_without_choices() -> None:
    from langchain_core.messages import AIMessageChunk

    model = _make_streaming_model()
    providers._normalize_compatible_streaming_roles(model)

    chunk = {"choices": []}
    generation = model._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, {})

    assert generation is not None


def test_normalize_streaming_roles_safe_on_missing_method() -> None:
    class NoConvert:
        pass

    target = NoConvert()
    result = providers._normalize_compatible_streaming_roles(target)
    assert result is target
    assert not hasattr(target, "_convert_chunk_to_generation_chunk")
