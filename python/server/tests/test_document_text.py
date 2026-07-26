from __future__ import annotations

from types import SimpleNamespace

import pytest

from refora_server.db.errors import RepoError
from refora_server.services.document_text import createDocumentTextService


class FakeSummaries:
    def __init__(self, cached=None):
        self.cached = cached
        self.saved = []

    def getFullText(self, document_id):
        return self.cached

    def setFullText(self, document_id, text, file_hash):
        self.saved.append((document_id, text, file_hash))
        self.cached = {"text": text, "hash": file_hash}


@pytest.mark.asyncio
async def test_reuses_full_text_cache_when_file_hash_matches(tmp_path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    summaries = FakeSummaries({"text": "cached", "hash": "hash-1"})
    repos = {
        "documents": {
            "get": lambda document_id: {
                "id": document_id,
                "filePath": str(pdf),
                "fileHash": "hash-1",
            }
        },
        "aiSummaries": {
            "getFullText": summaries.getFullText,
            "setFullText": summaries.setFullText,
        },
    }
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: (_ for _ in ()).throw(AssertionError(path))},
    )

    assert await service["getOrExtract"]("doc-1") == "cached"
    assert summaries.saved == []


@pytest.mark.asyncio
async def test_extracts_all_pages_and_replaces_stale_cache(tmp_path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    summaries = FakeSummaries({"text": "stale", "hash": "old-hash"})
    repos = {
        "documents": {
            "get": lambda document_id: {
                "id": document_id,
                "filePath": str(pdf),
                "fileHash": "new-hash",
            }
        },
        "aiSummaries": {
            "getFullText": summaries.getFullText,
            "setFullText": summaries.setFullText,
        },
    }
    pages = [
        SimpleNamespace(extract_text=lambda: " First page "),
        SimpleNamespace(extract_text=lambda: ""),
        SimpleNamespace(extract_text=lambda: "Second page"),
    ]
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: SimpleNamespace(pages=pages)},
    )

    assert await service["getOrExtract"]("doc-1") == "First page\n\nSecond page"
    assert summaries.saved == [
        ("doc-1", "First page\n\nSecond page", "new-hash")
    ]


@pytest.mark.asyncio
async def test_rejects_missing_and_non_pdf_paths(tmp_path):
    text = tmp_path / "paper.txt"
    text.write_text("not a PDF")
    repos = {
        "documents": {
            "get": lambda document_id: {
                "id": document_id,
                "filePath": str(text),
                "fileHash": "hash-1",
            }
            if document_id == "doc-1"
            else None
        },
        "aiSummaries": {"getFullText": lambda document_id: None},
    }
    service = createDocumentTextService(repos)

    with pytest.raises(RepoError, match="document not found"):
        await service["getOrExtract"]("missing")
    with pytest.raises(RepoError, match="must be a PDF"):
        await service["getOrExtract"]("doc-1")
