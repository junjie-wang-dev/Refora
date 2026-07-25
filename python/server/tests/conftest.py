import os
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_SQL = REPO_ROOT / "src" / "main" / "db" / "schema.sql"
MIGRATIONS_DIR = REPO_ROOT / "src" / "main" / "db" / "migrations"

DOCUMENT_COLUMN_MIGRATIONS = [
    "0004_add_pages_issue.sql",
    "0012_add_affiliations.sql",
    "0022_add_arxiv_id.sql",
]


def open_schema_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
    for name in DOCUMENT_COLUMN_MIGRATIONS:
        path = MIGRATIONS_DIR / name
        db.executescript(path.read_text(encoding="utf-8"))
    return db


def open_migrated_db() -> sqlite3.Connection:
    from refora_server.db.connection import _SqliteAdapter
    from refora_server.db.migrations import run_migrations

    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    run_migrations(_SqliteAdapter(db))
    return db


def make_docs_repo(db: sqlite3.Connection, library_folder: str = "", search_mode: str = "trigram"):
    from refora_server.repositories.documents import createDocumentsRepository

    return createDocumentsRepository(
        db,
        {
            "getLibraryFolder": lambda: library_folder,
            "getSearchMode": lambda: search_mode,
        },
    )


def make_cats_repo(db: sqlite3.Connection):
    from refora_server.repositories.categories import createCategoriesRepository

    return createCategoriesRepository(db)


def make_workspaces_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspaces import createWorkspacesRepository

    return createWorkspacesRepository(db)


def make_watch_folders_repo(db: sqlite3.Connection):
    from refora_server.repositories.watch_folders import createWatchFoldersRepository

    return createWatchFoldersRepository(db)


def make_doc(
    *,
    id: str = "doc-1",
    file_path: str = "/lib/paper.pdf",
    original_folder_path: str = "/lib",
    file_name: str = "paper.pdf",
    file_size: int = 1234,
    file_hash: str | None = "hash-doc-1",
    title: str | None = None,
    authors: str | None = None,
    year: str | None = None,
    venue: str | None = None,
    volume: str | None = None,
    issue: str | None = None,
    pages: str | None = None,
    abstract: str | None = None,
    keywords: str | None = None,
    url: str | None = None,
    doi: str | None = None,
    arxiv_id: str | None = None,
    note: str | None = None,
    affiliations: str | None = None,
    starred: int = 0,
    added_at: int = 1_000_000,
    last_read_at: int | None = None,
    updated_at: int | None = None,
    metadata_source: str | None = None,
    metadata_status: str = "pending",
    metadata_attempts: int = 0,
    edited_fields: list | None = None,
    remote_values: dict | None = None,
    file_missing: int = 0,
) -> dict:
    return {
        "id": id,
        "filePath": file_path,
        "originalFolderPath": original_folder_path,
        "fileName": file_name,
        "fileSize": file_size,
        "fileHash": file_hash,
        "title": title,
        "authors": authors,
        "year": year,
        "venue": venue,
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "abstract": abstract,
        "keywords": keywords,
        "url": url,
        "doi": doi,
        "arxivId": arxiv_id,
        "note": note,
        "affiliations": affiliations,
        "starred": starred,
        "addedAt": added_at,
        "lastReadAt": last_read_at,
        "updatedAt": updated_at if updated_at is not None else added_at,
        "metadataSource": metadata_source,
        "metadataStatus": metadata_status,
        "metadataAttempts": metadata_attempts,
        "editedFields": edited_fields if edited_fields is not None else [],
        "remoteValues": remote_values,
        "fileMissing": file_missing,
    }


OCR_MIGRATION = "0021_document_ocr.sql"


def open_ocr_db() -> sqlite3.Connection:
    db = open_schema_db()
    ocr_path = MIGRATIONS_DIR / OCR_MIGRATION
    db.executescript(ocr_path.read_text(encoding="utf-8"))
    return db


def make_ocr_repo(db: sqlite3.Connection):
    from refora_server.repositories.document_ocr import createDocumentOcrRepository

    return createDocumentOcrRepository(db)


def make_workspace_notes_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspace_notes import createWorkspaceNotesRepository

    return createWorkspaceNotesRepository(db)


def make_workspace_assets_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspace_assets import createWorkspaceAssetsRepository

    return createWorkspaceAssetsRepository(db)


def make_workspace_canvas_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspace_canvas import createWorkspaceCanvasRepository

    return createWorkspaceCanvasRepository(db)


def make_workspace_items_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspace_items import createWorkspaceItemsRepository

    return createWorkspaceItemsRepository(db)


def make_workspace_connections_repo(db: sqlite3.Connection):
    from refora_server.repositories.workspace_connections import createWorkspaceConnectionsRepository

    return createWorkspaceConnectionsRepository(db)


def make_chat_repo(db: sqlite3.Connection):
    from refora_server.repositories.chat import createChatRepository

    return createChatRepository(db)


def make_agent_runs_repo(db: sqlite3.Connection):
    from refora_server.repositories.agent_runs import createAgentRunsRepository

    return createAgentRunsRepository(db)


def make_agent_traces_repo(db: sqlite3.Connection):
    from refora_server.repositories.agent_traces import createAgentTracesRepository

    return createAgentTracesRepository(db)


def make_agent_interrupts_repo(db: sqlite3.Connection):
    from refora_server.repositories.agent_interrupts import createAgentInterruptsRepository

    return createAgentInterruptsRepository(db)


def make_agent_tool_effects_repo(db: sqlite3.Connection):
    from refora_server.repositories.agent_tool_effects import (
        createAgentToolEffectsRepository,
    )

    return createAgentToolEffectsRepository(db)


def make_agent_memories_repo(db: sqlite3.Connection):
    from refora_server.repositories.agent_memories import createAgentMemoriesRepository

    return createAgentMemoriesRepository(db)


def insert_thread(
    db: sqlite3.Connection,
    *,
    id: str = "thread-1",
    workspaceId: str | None = None,
    providerId: str = "provider-1",
    createdAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO chat_threads (id, workspaceId, providerId, createdAt) "
        "VALUES (?, ?, ?, ?)",
        [id, workspaceId, providerId, createdAt],
    )
    return id


def insert_message(
    db: sqlite3.Connection,
    *,
    threadId: str,
    id: str = "msg-1",
    role: str = "user",
    content: str = "hi",
    createdAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO chat_messages (id, threadId, role, content, createdAt) "
        "VALUES (?, ?, ?, ?, ?)",
        [id, threadId, role, content, createdAt],
    )
    return id


def insert_run(
    db: sqlite3.Connection,
    *,
    id: str = "run-1",
    threadId: str,
    providerId: str = "provider-1",
    modelId: str = "model-1",
    status: str = "running",
    startedAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO agent_runs "
        "(id, threadId, providerId, modelId, status, startedAt) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [id, threadId, providerId, modelId, status, startedAt],
    )
    return id


def insert_report(
    db: sqlite3.Connection,
    *,
    id: str = "report-1",
    workspaceId: str,
    title: str = "Report",
    contentMd: str = "# Report",
    sourceDocIds: str = "[]",
    model: str | None = None,
    createdAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO ai_reports (id, workspaceId, title, contentMd, sourceDocIds, model, createdAt) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, workspaceId, title, contentMd, sourceDocIds, model, createdAt],
    )
    return id


def insert_note(
    db: sqlite3.Connection,
    *,
    id: str = "note-1",
    workspaceId: str,
    title: str = "Note",
    contentMd: str = "",
    createdAt: int = 1_000_000,
    updatedAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO workspace_notes (id, workspaceId, title, contentMd, createdAt, updatedAt) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [id, workspaceId, title, contentMd, createdAt, updatedAt],
    )
    return id


def insert_asset(
    db: sqlite3.Connection,
    *,
    id: str = "asset-1",
    workspaceId: str,
    fileName: str = "file.png",
    filePath: str | None = None,
    sourcePath: str = "/lib/source.png",
    mimeType: str = "image/png",
    previewKind: str = "image",
    fileSize: int = 100,
    fileHash: str = "hash-asset",
    fileMissing: int = 0,
    createdAt: int = 1_000_000,
    updatedAt: int = 1_000_000,
) -> str:
    db.execute(
        "INSERT INTO workspace_assets "
        "(id, workspaceId, fileName, filePath, sourcePath, mimeType, previewKind, fileSize, fileHash, fileMissing, createdAt, updatedAt) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            id,
            workspaceId,
            fileName,
            filePath if filePath is not None else f"/lib/assets/{id}/{fileName}",
            sourcePath,
            mimeType,
            previewKind,
            fileSize,
            fileHash,
            fileMissing,
            createdAt,
            updatedAt,
        ],
    )
    return id


def insert_doc(db: sqlite3.Connection, *, id: str = "doc-1", added_at: int = 1_000_000) -> str:
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, fileSize, fileHash, addedAt, updatedAt, metadataStatus) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, f"/lib/{id}.pdf", "/lib", f"{id}.pdf", 1234, f"hash-{id}", added_at, added_at, "pending"],
    )
    return id
