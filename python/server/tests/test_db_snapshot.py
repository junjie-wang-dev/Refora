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
    manifest_path = tmp_path / "readonly" / "readonly-files.json"

    manifest = write_readonly_files_manifest(
        "workspace-1", documents_repo, assets_repo, manifest_path
    )

    assert stat.S_IMODE(manifest_path.stat().st_mode) == 0o400
    assert json.loads(manifest_path.read_text(encoding="utf-8")) == manifest
    assert manifest["version"] == 1
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
