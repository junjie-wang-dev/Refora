import sqlite3
import threading
import uuid
from typing import Any, Callable

from refora_server.repositories.agent_interrupts import createAgentInterruptsRepository
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


def create_repositories(db: Any, deps: RepositoryDeps | None = None) -> dict[str, Any]:
    if deps is None:
        deps = RepositoryDeps()
    transaction_lock = threading.RLock()

    def transaction(operation: Callable[[], Any]) -> Any:
        with transaction_lock:
            nested = bool(getattr(db, "in_transaction", False))
            savepoint = f"refora_{uuid.uuid4().hex}" if nested else None
            try:
                if savepoint is None:
                    db.execute("BEGIN IMMEDIATE")
                else:
                    db.execute(f"SAVEPOINT {savepoint}")
                result = operation()
                if savepoint is None:
                    db.execute("COMMIT")
                else:
                    db.execute(f"RELEASE SAVEPOINT {savepoint}")
                return result
            except BaseException:
                if savepoint is None:
                    if bool(getattr(db, "in_transaction", False)):
                        db.execute("ROLLBACK")
                else:
                    try:
                        db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    except sqlite3.Error:
                        pass
                    try:
                        db.execute(f"RELEASE SAVEPOINT {savepoint}")
                    except sqlite3.Error:
                        pass
                raise

    documents = createDocumentsRepository(
        db,
        {
            "getLibraryFolder": deps.getLibraryFolder,
            "getSearchMode": deps.getSearchMode,
        },
    )
    categories = createCategoriesRepository(db)
    settings = create_settings_repository(db)
    watchFolders = createWatchFoldersRepository(db)
    aiProviders = createAiProvidersRepository(db)
    workspaces = createWorkspacesRepository(db)
    documentOcr = createDocumentOcrRepository(db)
    pdfAnnotations = createPdfAnnotationsRepository(db)
    webSearchConfig = createWebSearchConfigRepository(db)
    aiSummaries = createAiSummariesRepository(db)
    aiReports = createAiReportsRepository(db)
    workspaceNotes = createWorkspaceNotesRepository(db)
    workspaceAssets = createWorkspaceAssetsRepository(db)
    workspaceCanvas = createWorkspaceCanvasRepository(db)
    workspaceItems = createWorkspaceItemsRepository(db)
    workspaceConnections = createWorkspaceConnectionsRepository(db)
    chat = createChatRepository(db)
    agentRuns = createAgentRunsRepository(db)
    agentTraces = createAgentTracesRepository(db)
    agentInterrupts = createAgentInterruptsRepository(db)
    agentToolEffects = createAgentToolEffectsRepository(db)
    agentMemories = createAgentMemoriesRepository(db)
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
    }
