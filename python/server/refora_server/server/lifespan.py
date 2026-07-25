from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from refora_server.db.connection import close_database, get_search_mode, open_database
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.server.connector import create_connector_broker
from refora_server.server.events import create_event_bus
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.ai_summary import createAiSummaryService
from refora_server.services.chat_history import createChatHistoryService
from refora_server.services.export import createExportService
from refora_server.services.library import createLibraryService
from refora_server.services.thread_title import createThreadTitleService
from refora_server.services.watcher import createWatcherService
from refora_server.services.web_search import createWebSearchService
from refora_server.services.workspaces import createWorkspacesService
from refora_server.library.importer import createImporter


def create_lifespan(
    db_path: str,
    library_folder: str,
    db: Any | None = None,
):
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = db
        owns_database = database is None
        if database is None:
            database, _ = open_database(db_path)
        app.state.db = database
        app.state.db_path = db_path
        app.state.library_folder = library_folder
        repos = create_repositories(
            database,
            RepositoryDeps(
                getLibraryFolder=lambda: app.state.library_folder,
                getSearchMode=get_search_mode,
            ),
        )
        events = create_event_bus()
        connector = create_connector_broker(events)
        emit = events.broadcast
        complete_repos = {"documents", "settings", "watchFolders", "categories", "webSearchConfig"}.issubset(repos)
        importer = {}
        watcher = {}
        exporter = {}
        web_search = {}
        library = createLibraryService(repos, {"emit": lambda event, data: emit(event, data)})
        if complete_repos:
            importer = createImporter(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "emitProgress": lambda data: emit("import.progress", data),
                },
            )
            watcher = createWatcherService(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "onNewPdf": lambda paths: importer["importFiles"](paths, True),
                },
            )
            exporter = createExportService(repos)
            web_search = createWebSearchService(repos, {})
        services = {
            "library": library,
            "importer": importer,
            "watcher": watcher,
            "export": exporter,
            "webSearch": web_search,
            "aiProviders": createAiProvidersService(repos),
            "aiSummary": createAiSummaryService(repos),
            "chatHistory": createChatHistoryService(repos),
            "threadTitle": createThreadTitleService(repos),
            "workspaces": createWorkspacesService(
                repos,
                {
                    "connector": connector,
                    "getSandboxPath": lambda workspace_id: f"{app.state.library_folder}/.refora/sandboxes/{workspace_id}",
                },
            ),
        }
        agent_runtime = createAgentRuntime(repos, {"emit": events.broadcast, "connector": connector})
        app.state.repos = repos
        app.state.services = services
        app.state.event_bus = events
        app.state.connector = connector
        app.state.agent_runtime = agent_runtime
        if hasattr(app.state, "require_token"):
            from refora_server.server.app import configure_app

            configure_app(app)
        try:
            yield
        finally:
            await connector.cancel_pending()
            await events.flush()
            if owns_database:
                close_database(database)

    return lifespan
