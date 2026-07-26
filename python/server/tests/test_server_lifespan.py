from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from fastapi import FastAPI

from refora_server.server.connector import ConnectorBroker
from refora_server.server.lifespan import create_lifespan


async def test_lifespan_initializes_and_closes_resources(monkeypatch) -> None:
    db = object()
    open_database = Mock(return_value=(db, object()))
    close_database = Mock()
    repos = {"documents": object()}
    create_repositories = Mock(return_value=repos)
    events = Mock(flush=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    runtime = object()

    monkeypatch.setattr("refora_server.server.lifespan.open_database", open_database)
    monkeypatch.setattr("refora_server.server.lifespan.close_database", close_database)
    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", create_repositories)
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createLibraryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createThreadTitleService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", Mock(return_value=runtime))

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library"))
    async with app.router.lifespan_context(app):
        assert app.state.db is db
        assert app.state.repos is repos
        assert app.state.library_folder == "/tmp/library"
        assert app.state.connector is connector
        assert app.state.event_bus is events
        assert app.state.agent_runtime is runtime

    open_database.assert_called_once_with("/tmp/refora.db")
    connector.cancel_pending.assert_awaited_once()
    events.flush.assert_awaited_once()
    close_database.assert_called_once_with(db)


async def test_lifespan_closes_runner_owned_database(monkeypatch) -> None:
    db = object()
    close_database = Mock()

    monkeypatch.setattr("refora_server.server.lifespan.close_database", close_database)
    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", Mock(return_value={}))
    events = Mock(flush=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createLibraryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createThreadTitleService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", Mock(return_value={}))

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))
    async with app.router.lifespan_context(app):
        assert app.state.db is db

    close_database.assert_not_called()


async def test_lifespan_wires_agent_runtime_factories(monkeypatch) -> None:
    db = object()
    repos = {"documents": object()}
    events = Mock(flush=AsyncMock(), broadcast=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    runtime_factory = Mock(return_value={})
    tool_factory = Mock(
        return_value=[
            SimpleNamespace(name="search_library"),
            SimpleNamespace(name="prepare_paper_ocr"),
        ]
    )
    model_factory = Mock(return_value="model")
    agent_factory = Mock(return_value="agent")

    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", Mock(return_value=repos))
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createLibraryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr(
        "refora_server.server.lifespan.createThreadTitleService",
        Mock(return_value={"generateThreadTitle": Mock()}),
    )
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", runtime_factory)
    monkeypatch.setattr("refora_server.server.lifespan.create_agent_tools", tool_factory)
    monkeypatch.setattr("refora_server.agent.providers.ChatOpenAI", model_factory)
    monkeypatch.setattr("refora_server.agent.providers.create_deep_agent", agent_factory)

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))
    async with app.router.lifespan_context(app):
        dependencies = runtime_factory.call_args.args[1]
        request = {
            "runId": "run-1",
            "threadId": "thread-1",
            "workspaceId": None,
            "enabledToolNames": ["search_library"],
            "systemPrompt": "Use the library.",
        }

        assert dependencies["createTools"](request) == [tool_factory.return_value[0]]
        tool_factory.assert_called_once()
        context = tool_factory.call_args.args[0]
        assert context.run_id == "run-1"
        assert context.thread_id == "thread-1"
        assert tool_factory.call_args.args[1]["repos"] is repos

        assert dependencies["createModel"](
            {
                "model": "test-model",
                "apiKey": "test-key",
                "baseUrl": "https://example.test/v1",
                "useResponsesApi": True,
                "modelKwargs": {"reasoning_effort": "high"},
                "reasoning": {"effort": "high", "summary": "auto"},
                "temperature": 0.2,
                "maxTokens": 123,
            }
        ) == "model"
        model_factory.assert_called_once_with(
            model="test-model",
            api_key="test-key",
            base_url="https://example.test/v1",
            streaming=True,
            use_responses_api=True,
            model_kwargs={"reasoning_effort": "high"},
            reasoning={"effort": "high", "summary": "auto"},
            temperature=0.2,
            max_completion_tokens=123,
        )

        assert dependencies["createAgent"]("model", ["tool"], request) == "agent"
        agent_factory.assert_called_once()
        assert agent_factory.call_args.kwargs["model"] == "model"
        assert agent_factory.call_args.kwargs["tools"] == ["tool"]
        assert agent_factory.call_args.kwargs["system_prompt"] == "Use the library."
        assert set(agent_factory.call_args.kwargs["interrupt_on"]) == {
            "prepare_paper_ocr",
            "publish_workspace_artifacts",
            "install_runtime_packages",
            "propose_workspace_memory_update",
        }


async def test_connector_cancels_pending_requests() -> None:
    events = Mock()
    events.broadcast = AsyncMock()
    connector = ConnectorBroker(events)
    request = asyncio.create_task(connector.open_path("/tmp/example"))
    await asyncio.sleep(0)

    await connector.cancel_pending()

    assert await request == {
        "ok": False,
        "error": {"code": "connector_shutdown", "message": "Server is shutting down"},
    }
