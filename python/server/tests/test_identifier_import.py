from pathlib import Path
import socket

import pytest

from conftest import make_docs_repo, open_migrated_db
from refora_server.library import identifier_import
from refora_server.library.identifier_import import (
    detectIdentifierType,
    downloadPdf,
    extractDoi,
    importByIdentifier,
    isSafeUrl,
)


@pytest.mark.asyncio
async def test_import_identifier_uses_mocked_academic_metadata(tmp_path: Path) -> None:
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    requested = []

    async def fetch_arxiv(arxiv_id: str):
        requested.append(arxiv_id)
        return {
            "title": "Mocked Paper",
            "authors": "Ada Lovelace",
            "year": "2024",
            "abstract": "A test paper",
            "arxivId": arxiv_id,
            "metadataSource": "arxiv",
            "pdfUrl": "https://example.com/mocked.pdf",
        }

    async def download(_url: str, directory: str, filename: str) -> str:
        path = Path(directory) / filename
        path.write_bytes(b"%PDF-1.7\n" + b"x" * 120)
        return str(path.resolve())

    deps = {
        "getLibraryFolder": lambda: str(library),
        "fetchArxivMetadata": fetch_arxiv,
        "downloadPdf": download,
        "isSafeUrl": lambda _url: True,
    }

    document_id = await importByIdentifier({"documents": documents}, "arXiv:2401.12345", deps)

    assert requested == ["2401.12345"]
    document = documents["get"](document_id)
    assert document is not None
    assert document["title"] == "Mocked Paper"
    assert document["arxivId"] == "2401.12345"
    assert Path(document["filePath"]).exists()
    with pytest.raises(ValueError, match="already"):
        await importByIdentifier({"documents": documents}, "2401.12345", deps)


@pytest.mark.asyncio
async def test_doi_import_uses_crossref_metadata_and_pdf_link(tmp_path: Path) -> None:
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    requested: list[str] = []
    downloaded: list[str] = []

    async def fetch_doi(doi: str):
        requested.append(doi)
        return {
            "title": "Crossref Paper",
            "authors": "Lovelace, Ada",
            "year": "2025",
            "venue": "CVPR",
            "doi": doi,
            "arxivId": "2401.12345",
            "metadataSource": "crossref",
            "pdfUrl": "https://publisher.example/paper.pdf",
        }

    async def download(url: str, directory: str, filename: str) -> str:
        downloaded.append(url)
        path = Path(directory) / filename
        path.write_bytes(b"%PDF-1.7\n" + b"x" * 120)
        return str(path.resolve())

    document_id = await importByIdentifier(
        {"documents": documents},
        "10.1000/example",
        {
            "getLibraryFolder": lambda: str(library),
            "fetchDoiMetadata": fetch_doi,
            "downloadPdf": download,
            "isSafeUrl": lambda _url: True,
        },
    )

    assert requested == ["10.1000/example"]
    assert downloaded == ["https://publisher.example/paper.pdf"]
    document = documents["get"](document_id)
    assert document is not None
    assert document["title"] == "Crossref Paper"
    assert document["metadataSource"] == "crossref"
    assert document["arxivId"] == "2401.12345"


def test_identifier_detection_and_doi_extraction() -> None:
    assert detectIdentifierType("https://doi.org/10.1000/example") == "doi"
    assert detectIdentifierType("978-1-4028-9462-6") == "isbn"
    assert extractDoi("doi: 10.1000/example") == "10.1000/example"


@pytest.mark.asyncio
async def test_safe_url_rejects_any_private_dns_answer(monkeypatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ],
    )

    assert await isSafeUrl("https://papers.example/paper.pdf") is False


@pytest.mark.asyncio
async def test_download_pins_each_redirect_to_validated_address(tmp_path, monkeypatch) -> None:
    resolved: list[str] = []
    requested: list[tuple[str, str]] = []

    async def resolve(url: str) -> tuple[str, int]:
        resolved.append(url)
        return ("8.8.8.8", 4) if len(resolved) == 1 else ("1.1.1.1", 4)

    def request(url: str, address: str, destination: Path):
        requested.append((url, address))
        if len(requested) == 1:
            return 302, "/final.pdf", None
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"%PDF-1.7\n" + b"x" * 120)
        return 200, None, None

    monkeypatch.setattr(identifier_import, "resolvePublicAddress", resolve)
    monkeypatch.setattr(identifier_import, "_pinned_request", request)

    path = await downloadPdf(
        "https://papers.example/start",
        str(tmp_path),
        "paper.pdf",
    )

    assert Path(path).is_file()
    assert requested == [
        ("https://papers.example/start", "8.8.8.8"),
        ("https://papers.example/final.pdf", "1.1.1.1"),
    ]
