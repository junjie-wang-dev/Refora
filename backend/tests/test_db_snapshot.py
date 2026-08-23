from __future__ import annotations

import json
import sqlite3
import stat
from pathlib import Path

import pytest

from refora_server.agent.db_snapshot import cleanup_snapshot, create_db_snapshot
from refora_server.agent.readonly_files import write_readonly_files_manifest


def test_create_db_snapshot_is_queryable_readonly_and_cleanup_removes_it(
    tmp_path: Path,
):
    source_path = tmp_path / "library.sqlite"
    with sqlite3.connect(source_path) as source:
        source.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT)")
        source.execute("INSERT INTO documents VALUES ('doc-1', 'Paper')")
    snapshot_path = tmp_path / "readonly" / "refora-readonly.db"

    created_path = create_db_snapshot(source_path, snapshot_path)

    assert created_path == snapshot_path.resolve()
    assert stat.S_IMODE(snapshot_path.stat().st_mode) == 0o400
    snapshot_uri = f"{snapshot_path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(snapshot_uri, uri=True) as snapshot:
        assert snapshot.execute("SELECT id, title FROM documents").fetchall() == [
            ("doc-1", "Paper")
        ]
        assert snapshot.execute(
            "SELECT schemaVersion, scope, workspaceId FROM refora_readonly_context"
        ).fetchone() == (2, "library", None)
        with pytest.raises(sqlite3.OperationalError):
            snapshot.execute("INSERT INTO documents VALUES ('doc-2', 'Other')")

    cleanup_snapshot(snapshot_path)
    cleanup_snapshot(snapshot_path)
    assert not snapshot_path.exists()


def test_write_readonly_files_manifest_lists_workspace_files_and_revision(
    tmp_path: Path,
):
    document_path = tmp_path / "paper.pdf"
    document_path.write_bytes(b"document")
    asset_path = tmp_path / "figure.png"
    asset_path.write_bytes(b"asset")
    missing_path = tmp_path / "missing.pdf"
    documents_repo = {
        "list": lambda filter: [
            {
                "id": "doc-1",
                "fileName": "paper.pdf",
                "filePath": str(document_path),
                "fileHash": "document-hash",
                "fileSize": 8,
                "updatedAt": 10,
            },
            {
                "id": "missing",
                "fileName": "missing.pdf",
                "filePath": str(missing_path),
                "fileHash": "missing-hash",
                "fileSize": 0,
                "updatedAt": 11,
            },
        ]
    }
    assets_repo = {
        "list": lambda workspace_id: [
            {
                "id": "asset-1",
                "workspaceId": workspace_id,
                "fileName": "figure.png",
                "filePath": str(asset_path),
                "fileHash": "asset-hash",
                "fileSize": 5,
                "mimeType": "image/png",
                "updatedAt": 20,
            }
        ]
    }
    workspace_items_repo = {
        "list": lambda workspace_id: [
            {
                "id": "item-1",
                "workspaceId": workspace_id,
                "kind": "document",
                "docId": "doc-1",
            }
        ]
    }
    manifest_path = tmp_path / "readonly" / "readonly-files.json"

    manifest = write_readonly_files_manifest(
        "workspace-1",
        documents_repo,
        assets_repo,
        manifest_path,
        workspace_items_repo,
    )

    assert stat.S_IMODE(manifest_path.stat().st_mode) == 0o400
    assert json.loads(manifest_path.read_text(encoding="utf-8")) == manifest
    assert manifest["version"] == 2
    assert manifest["scope"] == "workspace"
    assert manifest["workspaceId"] == "workspace-1"
    assert len(manifest["revision"]) == 64
    assert manifest["files"] == [
        {
            "id": "asset-1",
            "workspaceId": "workspace-1",
            "fileName": "figure.png",
            "fileHash": "asset-hash",
            "path": str(asset_path),
            "mimeType": "image/png",
            "size": 5,
            "kind": "asset",
            "updatedAt": 20,
        },
        {
            "id": "doc-1",
            "workspaceId": None,
            "fileName": "paper.pdf",
            "fileHash": "document-hash",
            "path": str(document_path),
            "mimeType": "application/pdf",
            "size": 8,
            "kind": "document",
            "updatedAt": 10,
        },
    ]


def test_workspace_snapshot_excludes_other_workspaces_and_sensitive_tables(tmp_path):
    source_path = tmp_path / "library.sqlite"
    with sqlite3.connect(source_path) as source:
        source.executescript(
            """
            CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE document_categories (documentId TEXT, categoryId TEXT);
            CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE workspace_items (
              id TEXT PRIMARY KEY, workspaceId TEXT, kind TEXT, docId TEXT,
              reportId TEXT, noteId TEXT, assetId TEXT
            );
            CREATE TABLE workspace_notes (id TEXT PRIMARY KEY, workspaceId TEXT, contentMd TEXT);
            CREATE TABLE ai_reports (id TEXT PRIMARY KEY, workspaceId TEXT, contentMd TEXT);
            CREATE TABLE chat_messages (id TEXT PRIMARY KEY, content TEXT);
            CREATE TABLE ai_providers (id TEXT PRIMARY KEY, apiKeyEnc BLOB);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO documents VALUES ('doc-1', 'Selected'), ('doc-2', 'Private');
            INSERT INTO categories VALUES ('cat-1', 'Selected'), ('cat-2', 'Private');
            INSERT INTO document_categories VALUES ('doc-1', 'cat-1'), ('doc-2', 'cat-2');
            INSERT INTO workspaces VALUES ('workspace-1', 'Selected'), ('workspace-2', 'Private');
            INSERT INTO workspace_items VALUES
              ('item-1', 'workspace-1', 'document', 'doc-1', NULL, NULL, NULL),
              ('item-2', 'workspace-2', 'document', 'doc-2', NULL, NULL, NULL);
            INSERT INTO workspace_notes VALUES
              ('note-1', 'workspace-1', 'Selected'),
              ('note-2', 'workspace-2', 'Private');
            INSERT INTO ai_reports VALUES
              ('report-1', 'workspace-1', 'Selected'),
              ('report-2', 'workspace-2', 'Private');
            INSERT INTO chat_messages VALUES ('message-1', 'Private chat');
            INSERT INTO ai_providers VALUES ('provider-1', X'0102');
            INSERT INTO settings VALUES ('proxyUrl', 'private');
            """
        )
    snapshot_path = tmp_path / "readonly" / "workspace.db"

    create_db_snapshot(source_path, snapshot_path, "workspace-1")

    with sqlite3.connect(snapshot_path) as snapshot:
        tables = {
            row[0]
            for row in snapshot.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert "chat_messages" not in tables
        assert "ai_providers" not in tables
        assert "settings" not in tables
        assert snapshot.execute("SELECT id FROM documents").fetchall() == [("doc-1",)]
        assert snapshot.execute("SELECT id FROM workspaces").fetchall() == [
            ("workspace-1",)
        ]
        assert snapshot.execute("SELECT id FROM workspace_notes").fetchall() == [
            ("note-1",)
        ]
        assert snapshot.execute("SELECT id FROM ai_reports").fetchall() == [
            ("report-1",)
        ]
        assert snapshot.execute(
            "SELECT schemaVersion, scope, workspaceId FROM refora_readonly_context"
        ).fetchone() == (2, "workspace", "workspace-1")
