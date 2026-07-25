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