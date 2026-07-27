from __future__ import annotations

from typing import Any

import pytest

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
