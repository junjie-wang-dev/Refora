from __future__ import annotations

import sqlite3
import threading
import uuid
from typing import Any, Callable

from refora_server.repositories.agent_interrupts import createAgentInterruptsRepository
from refora_server.repositories.agent_profiles import (
    createAgentProfilesRepository,
    createAgentRuntimeSessionsRepository,
)
from refora_server.repositories.agent_memories import createAgentMemoriesRepository
from refora_server.repositories.agent_runs import createAgentRunsRepository
from refora_server.repositories.agent_tool_effects import createAgentToolEffectsRepository
from refora_server.repositories.agent_traces import createAgentTracesRepository
from refora_server.repositories.ai_providers import createAiProvidersRepository
from refora_server.repositories.ai_reports import createAiReportsRepository
from refora_server.repositories.ai_summaries import createAiSummariesRepository
from refora_server.repositories.categories import createCategoriesRepository
from refora_server.repositories.chat import createChatRepository
from refora_server.repositories.document_ocr import createDocumentOcrRepository
from refora_server.repositories.documents import createDocumentsRepository
from refora_server.repositories.pdf_annotations import createPdfAnnotationsRepository
from refora_server.repositories.settings import create_settings_repository
from refora_server.repositories.watch_folders import createWatchFoldersRepository
from refora_server.repositories.web_search_config import createWebSearchConfigRepository
from refora_server.repositories.workspaces import createWorkspacesRepository
from refora_server.repositories.workspace_assets import createWorkspaceAssetsRepository
from refora_server.repositories.workspace_canvas import createWorkspaceCanvasRepository
from refora_server.repositories.workspace_connections import createWorkspaceConnectionsRepository
from refora_server.repositories.workspace_items import createWorkspaceItemsRepository
from refora_server.repositories.workspace_notes import createWorkspaceNotesRepository


class RepositoryDeps:
    def __init__(
        self,
        getLibraryFolder: Callable[[], str] | None = None,
        getSearchMode: Callable[[], str] | None = None,
    ) -> None:
        self.getLibraryFolder = getLibraryFolder or (lambda: "")
        self.getSearchMode = getSearchMode or (lambda: "trigram")


class _SerializedCursor:
    def __init__(self, cursor: Any, lock: threading.RLock) -> None:
        self._cursor = cursor
        self._lock = lock

    def fetchone(self) -> Any:
        with self._lock:
            return self._cursor.fetchone()

    def fetchmany(self, size: int | None = None) -> Any:
        with self._lock:
            if size is None:
                return self._cursor.fetchmany()
            return self._cursor.fetchmany(size)

    def fetchall(self) -> Any:
        with self._lock:
            return self._cursor.fetchall()

    def close(self) -> None:
        with self._lock:
            self._cursor.close()

    def __iter__(self) -> _SerializedCursor:
        return self

    def __next__(self) -> Any:
        with self._lock:
            return next(self._cursor)

    def __getattr__(self, name: str) -> Any:
        with self._lock:
            return getattr(self._cursor, name)


class _SerializedConnection:
    def __init__(self, db: Any, lock: threading.RLock) -> None:
        self._db = db
        self._lock = lock

    @property
    def in_transaction(self) -> bool:
        with self._lock:
            return bool(getattr(self._db, "in_transaction", False))

    def execute(self, *args: Any, **kwargs: Any) -> _SerializedCursor:
        with self._lock:
            return _SerializedCursor(self._db.execute(*args, **kwargs), self._lock)

    def executemany(self, *args: Any, **kwargs: Any) -> _SerializedCursor:
        with self._lock:
            return _SerializedCursor(
                self._db.executemany(*args, **kwargs), self._lock
            )

    def executescript(self, *args: Any, **kwargs: Any) -> _SerializedCursor:
        with self._lock:
            return _SerializedCursor(
                self._db.executescript(*args, **kwargs), self._lock
            )

    def __getattr__(self, name: str) -> Any:
        with self._lock:
            return getattr(self._db, name)


def create_repositories(db: Any, deps: RepositoryDeps | None = None) -> dict[str, Any]:
    if deps is None:
        deps = RepositoryDeps()
    transaction_lock = threading.RLock()
    serialized_db = _SerializedConnection(db, transaction_lock)

    def transaction(operation: Callable[[], Any]) -> Any:
        with transaction_lock:
            nested = serialized_db.in_transaction
            savepoint = f"refora_{uuid.uuid4().hex}" if nested else None
            try:
                if savepoint is None:
                    serialized_db.execute("BEGIN IMMEDIATE")
                else:
                    serialized_db.execute(f"SAVEPOINT {savepoint}")
                result = operation()
                if savepoint is None:
                    serialized_db.execute("COMMIT")
                else:
                    serialized_db.execute(f"RELEASE SAVEPOINT {savepoint}")
                return result
            except BaseException:
                if savepoint is None:
                    if serialized_db.in_transaction:
                        serialized_db.execute("ROLLBACK")
                else:
                    try:
                        serialized_db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    except sqlite3.Error:
                        pass
                    try:
                        serialized_db.execute(f"RELEASE SAVEPOINT {savepoint}")
                    except sqlite3.Error:
                        pass
                raise

    documents = createDocumentsRepository(
        serialized_db,
        {
            "getLibraryFolder": deps.getLibraryFolder,
            "getSearchMode": deps.getSearchMode,
        },
    )
    categories = createCategoriesRepository(serialized_db)
    settings = create_settings_repository(serialized_db)
    watchFolders = createWatchFoldersRepository(serialized_db)
    aiProviders = createAiProvidersRepository(serialized_db)
    workspaces = createWorkspacesRepository(serialized_db)
    documentOcr = createDocumentOcrRepository(serialized_db)
    pdfAnnotations = createPdfAnnotationsRepository(serialized_db)
    webSearchConfig = createWebSearchConfigRepository(serialized_db)
    aiSummaries = createAiSummariesRepository(serialized_db)
    aiReports = createAiReportsRepository(serialized_db)
    workspaceNotes = createWorkspaceNotesRepository(serialized_db)
    workspaceAssets = createWorkspaceAssetsRepository(serialized_db)
    workspaceCanvas = createWorkspaceCanvasRepository(serialized_db)
    workspaceItems = createWorkspaceItemsRepository(serialized_db)
    workspaceConnections = createWorkspaceConnectionsRepository(serialized_db)
    chat = createChatRepository(serialized_db)
    agentRuns = createAgentRunsRepository(serialized_db)
    agentTraces = createAgentTracesRepository(serialized_db)
    agentInterrupts = createAgentInterruptsRepository(serialized_db)
    agentToolEffects = createAgentToolEffectsRepository(serialized_db)
    agentMemories = createAgentMemoriesRepository(serialized_db)
    agentProfiles = createAgentProfilesRepository(serialized_db)
    agentRuntimeSessions = createAgentRuntimeSessionsRepository(serialized_db)
    return {
        "transaction": transaction,
        "documents": documents,
        "categories": categories,
        "settings": settings,
        "watchFolders": watchFolders,
        "aiProviders": aiProviders,
        "workspaces": workspaces,
        "documentOcr": documentOcr,
        "pdfAnnotations": pdfAnnotations,
        "webSearchConfig": webSearchConfig,
        "aiSummaries": aiSummaries,
        "aiReports": aiReports,
        "workspaceNotes": workspaceNotes,
        "workspaceAssets": workspaceAssets,
        "workspaceCanvas": workspaceCanvas,
        "workspaceItems": workspaceItems,
        "workspaceConnections": workspaceConnections,
        "chat": chat,
        "agentRuns": agentRuns,
        "agentTraces": agentTraces,
        "agentInterrupts": agentInterrupts,
        "agentToolEffects": agentToolEffects,
        "agentMemories": agentMemories,
        "agentProfiles": agentProfiles,
        "agentRuntimeSessions": agentRuntimeSessions,
    }
