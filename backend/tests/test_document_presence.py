from __future__ import annotations

import hashlib
from typing import Any

import pytest

from conftest import make_doc, open_migrated_db
from refora_server.repositories import RepositoryDeps, create_repositories

from refora_server.services.document_presence import (
    create_document_presence_service,
)


@pytest.mark.asyncio
async def test_document_presence_updates_missing_state_and_emits(tmp_path) -> None:
    existing = tmp_path / "existing.pdf"
    existing.write_bytes(b"%PDF")
    documents = {
        "missing": {
            "id": "missing",
            "filePath": str(tmp_path / "missing.pdf"),
            "fileMissing": 0,
        },
        "restored": {
            "id": "restored",
            "filePath": str(existing),
            "fileMissing": 1,
        },
    }
    emitted: list[tuple[str, dict[str, Any]]] = []

    def list_documents(_filter: dict[str, Any]) -> list[dict[str, Any]]:
        return [dict(document) for document in documents.values()]

    def set_missing(document_id: str, missing: bool) -> None:
        documents[document_id]["fileMissing"] = 1 if missing else 0

    async def emit(name: str, document: dict[str, Any]) -> None:
        emitted.append((name, dict(document)))

    service = create_document_presence_service(
        {
            "documents": {
                "list": list_documents,
                "setFileMissing": set_missing,
                "get": lambda document_id: dict(documents[document_id]),
            }
        },
        emit=emit,
    )

    changed = await service["checkNow"]()

    assert {document["id"] for document in changed} == {"missing", "restored"}
    assert documents["missing"]["fileMissing"] == 1
    assert documents["restored"]["fileMissing"] == 0
    assert [event for event, _document in emitted] == [
        "document.updated",
        "document.updated",
    ]


@pytest.mark.asyncio
async def test_document_presence_refreshes_replaced_pdf_and_invalidates_cached_content(
    tmp_path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    pdf = library / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7\nold")
    old_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
    db = open_migrated_db()
    repos = create_repositories(
        db,
        RepositoryDeps(getLibraryFolder=lambda: str(library)),
    )
    repos["documents"]["insert"](
        make_doc(
            id="paper",
            file_path=str(pdf),
            file_name=pdf.name,
            file_size=pdf.stat().st_size,
            file_hash=old_hash,
        )
    )
    repos["aiSummaries"]["setFullText"]("paper", "old text", old_hash)
    repos["aiSummaries"]["setSummary"]("paper", "model", {"summary": "old"})
    repos["documentOcr"]["insertResult"](
        {
            "id": "result-old",
            "documentId": "paper",
            "resultKey": "key-old",
            "sourceHash": old_hash,
            "mineruVersion": "1",
            "modelRevision": "1",
            "profile": "balanced",
            "optionsHash": "options",
            "schemaVersion": 1,
            "relativeRoot": "root",
            "markdownRelativePath": "document.md",
            "blocksRelativePath": "blocks.jsonl",
            "manifestRelativePath": "manifest.json",
            "createdAt": 1,
        }
    )
    replacement = library / "replacement.pdf"
    replacement.write_bytes(b"%PDF-1.7\nnew content")
    replacement.replace(pdf)
    emitted: list[dict[str, Any]] = []
    service = create_document_presence_service(
        repos,
        emit=lambda _event, document: emitted.append(document),
    )

    changed = await service["checkNow"]()

    new_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert [document["id"] for document in changed] == ["paper"]
    assert changed[0]["fileHash"] == new_hash
    assert changed[0]["fileInode"] == pdf.stat().st_ino
    assert emitted[0]["fileHash"] == new_hash
    assert repos["aiSummaries"]["getSummary"]("paper") is None
    assert repos["aiSummaries"]["getFullText"]("paper") is None
    assert repos["documentOcr"]["getResult"]("paper", new_hash) is None
