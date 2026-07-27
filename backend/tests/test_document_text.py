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


class _FakeReader:
    def __init__(self, *, is_encrypted=False, pages=None, extract_error=None):
        self._is_encrypted = is_encrypted
        self.pages = pages or []
        self._extract_error = extract_error

    @property
    def is_encrypted(self):
        return self._is_encrypted


class _EncryptedReader:
    @property
    def is_encrypted(self):
        return True

    pages = []


def _make_repos(tmp_path, file_hash="hash-1"):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    return {
        "documents": {
            "get": lambda document_id: {
                "id": document_id,
                "filePath": str(pdf),
                "fileHash": file_hash,
            }
        },
        "aiSummaries": {
            "getFullText": lambda document_id: None,
            "setFullText": lambda document_id, text, h: None,
        },
    }


@pytest.mark.asyncio
async def test_encrypted_pdf_raises_encrypted_error_code(tmp_path):
    from pypdf.errors import WrongPasswordError

    repos = _make_repos(tmp_path)
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: (_ for _ in ()).throw(WrongPasswordError("password required"))},
    )

    with pytest.raises(RepoError) as exc:
        await service["getOrExtract"]("doc-1")
    assert exc.value.code == "encrypted"


@pytest.mark.asyncio
async def test_encrypted_pdf_detected_via_is_encrypted_raises_encrypted(tmp_path):
    repos = _make_repos(tmp_path)
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: _EncryptedReader()},
    )

    with pytest.raises(RepoError) as exc:
        await service["getOrExtract"]("doc-1")
    assert exc.value.code == "encrypted"


@pytest.mark.asyncio
async def test_corrupted_pdf_raises_corrupted_error_code(tmp_path):
    from pypdf.errors import PdfReadError

    repos = _make_repos(tmp_path)
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: (_ for _ in ()).throw(PdfReadError("invalid pdf structure"))},
    )

    with pytest.raises(RepoError) as exc:
        await service["getOrExtract"]("doc-1")
    assert exc.value.code == "corrupted"


@pytest.mark.asyncio
async def test_extract_text_failure_during_page_extraction_raises_corrupted(tmp_path):
    repos = _make_repos(tmp_path)

    def make_reader(path):
        page = SimpleNamespace(
            extract_text=lambda: (_ for _ in ()).throw(Exception("boom")),
        )
        return SimpleNamespace(is_encrypted=False, pages=[page])

    service = createDocumentTextService(repos, {"reader_factory": make_reader})

    with pytest.raises(RepoError) as exc:
        await service["getOrExtract"]("doc-1")
    assert exc.value.code == "corrupted"


@pytest.mark.asyncio
async def test_successful_extraction_returns_text(tmp_path):
    repos = _make_repos(tmp_path)
    pages = [
        SimpleNamespace(extract_text=lambda: "Hello world"),
    ]
    service = createDocumentTextService(
        repos,
        {"reader_factory": lambda path: _FakeReader(pages=pages)},
    )

    assert await service["getOrExtract"]("doc-1") == "Hello world"
