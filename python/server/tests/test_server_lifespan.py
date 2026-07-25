from __future__ import annotations

import asyncio
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
