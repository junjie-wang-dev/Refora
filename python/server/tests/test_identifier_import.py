from pathlib import Path

import pytest

from conftest import make_docs_repo, open_migrated_db
from refora_server.library.identifier_import import (
    detectIdentifierType,
    extractDoi,
    importByIdentifier,
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


def test_identifier_detection_and_doi_extraction() -> None:
    assert detectIdentifierType("https://doi.org/10.1000/example") == "doi"
    assert detectIdentifierType("978-1-4028-9462-6") == "isbn"
    assert extractDoi("doi: 10.1000/example") == "10.1000/example"
