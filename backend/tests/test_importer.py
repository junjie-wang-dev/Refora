from pathlib import Path

import pytest

from conftest import make_docs_repo, open_migrated_db
from refora_server.library.importer import createImporter


def _pdf(path: Path, content: bytes) -> None:
    path.write_bytes(b"%PDF-1.7\n" + content)


@pytest.mark.asyncio
async def test_import_files_copies_and_deduplicates_by_hash(tmp_path: Path) -> None:
    library = tmp_path / "library"
    first = tmp_path / "first.pdf"
    duplicate = tmp_path / "duplicate.pdf"
    _pdf(first, b"same")
    _pdf(duplicate, b"same")
    progress = []
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "emitProgress": progress.append,
            "validatePdf": lambda _path: None,
            "extractPdfMetadata": lambda _path: {"title": "Extracted title", "metadataSource": "pdf"},
        },
    )

    result = await importer["importFiles"]([str(first), str(duplicate), "relative.pdf"])

    assert len(result["imported"]) == 1
    assert result["skipped"] == [str(duplicate.resolve()), "relative.pdf"]
    assert result["errors"] == []
    document = documents["get"](result["imported"][0])
    assert document is not None
    assert document["title"] == "Extracted title"
    assert document["metadataStatus"] == "done"
    assert Path(document["filePath"]).parent == library
    assert Path(document["filePath"]).exists()
    assert [event["current"] for event in progress] == [1, 2, 3]


@pytest.mark.asyncio
async def test_watched_duplicate_skips_pdf_validation(tmp_path: Path) -> None:
    library = tmp_path / "library"
    first = tmp_path / "first.pdf"
    duplicate = tmp_path / "duplicate.pdf"
    _pdf(first, b"same")
    _pdf(duplicate, b"same")
    validated: list[str] = []
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda path: validated.append(path),
        },
    )

    first_result = await importer["importFiles"]([str(first)], True)
    duplicate_result = await importer["importFiles"]([str(duplicate)], True)

    assert len(first_result["imported"]) == 1
    assert duplicate_result["skipped"] == [str(duplicate.resolve())]
    assert validated == [str(first.resolve())]


@pytest.mark.asyncio
async def test_import_folder_honors_recursive_flag(tmp_path: Path) -> None:
    library = tmp_path / "library"
    folder = tmp_path / "source"
    nested = folder / "nested"
    nested.mkdir(parents=True)
    _pdf(folder / "one.pdf", b"one")
    _pdf(nested / "two.pdf", b"two")
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    first = await importer["importFolder"](str(folder), False)
    second = await importer["importFolder"](str(folder), True)

    assert len(first["imported"]) == 1
    assert len(second["imported"]) == 1
    assert len(documents["list"]({"mode": "all"})) == 2


@pytest.mark.asyncio
async def test_import_files_rejects_corrupted_pdf(tmp_path: Path) -> None:
    library = tmp_path / "library"
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-1.7\nnot a pdf")
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {"getLibraryFolder": lambda: str(library)},
    )

    result = await importer["importFiles"]([str(source)])

    assert result["imported"] == []
    assert result["skipped"] == []
    assert result["errors"][0]["path"] == str(source)
    assert "corrupted" in result["errors"][0]["message"]


@pytest.mark.asyncio
async def test_manual_duplicate_can_be_imported_anyway(tmp_path: Path) -> None:
    library = tmp_path / "library"
    first = tmp_path / "first.pdf"
    duplicate = tmp_path / "duplicate.pdf"
    _pdf(first, b"same")
    _pdf(duplicate, b"same")
    decisions: list[str] = []
    documents = make_docs_repo(open_migrated_db(), str(library))

    async def confirm(file_name: str) -> bool:
        decisions.append(file_name)
        return False

    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
            "confirmDuplicate": confirm,
        },
    )

    first_result = await importer["importFiles"]([str(first)])
    second_result = await importer["importFiles"]([str(duplicate)])

    assert len(first_result["imported"]) == 1
    assert len(second_result["imported"]) == 1
    assert decisions == ["duplicate.pdf"]
