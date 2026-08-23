import hashlib
from pathlib import Path

import pytest

from conftest import make_doc, make_docs_repo, open_migrated_db
import refora_server.library.importer as importer_module
from refora_server.library.importer import createImporter
from refora_server.repositories import RepositoryDeps, create_repositories


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
    imported = documents["get"](first_result["imported"][0])
    assert imported is not None
    assert validated == [imported["filePath"]]


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


@pytest.mark.asyncio
async def test_import_identity_is_computed_from_the_library_copy(tmp_path: Path) -> None:
    library = tmp_path / "library"
    source = tmp_path / "source.pdf"
    _pdf(source, b"original")
    hashed_paths: list[str] = []
    documents = make_docs_repo(open_migrated_db(), str(library))

    def hash_pdf(path: str) -> str:
        hashed_paths.append(path)
        source.write_bytes(b"%PDF-1.7\nchanged after copy")
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "hashPdf": hash_pdf,
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(source)])

    document = documents["get"](result["imported"][0])
    assert document is not None
    stored = Path(document["filePath"])
    assert hashed_paths == [str(stored)]
    assert stored.read_bytes() == b"%PDF-1.7\noriginal"
    assert document["fileSize"] == stored.stat().st_size
    assert document["fileHash"] == hashlib.sha256(stored.read_bytes()).hexdigest()


@pytest.mark.asyncio
async def test_failed_copy_never_publishes_a_partial_pdf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    library = tmp_path / "library"
    source = tmp_path / "source.pdf"
    _pdf(source, b"content")
    documents = make_docs_repo(open_migrated_db(), str(library))

    def fail_copy(input_file, output_file, _length):
        output_file.write(input_file.read(4))
        raise OSError("copy interrupted")

    monkeypatch.setattr(importer_module.shutil, "copyfileobj", fail_copy)
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(source)])

    assert result["imported"] == []
    assert result["errors"] == [{"path": str(source), "message": "copy interrupted"}]
    assert list(library.iterdir()) == []


@pytest.mark.asyncio
async def test_invalid_copy_result_never_deletes_the_source_pdf(tmp_path: Path) -> None:
    library = tmp_path / "library"
    source = tmp_path / "source.pdf"
    _pdf(source, b"content")
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "copyToLibrary": lambda path, _folder: path,
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(source)])

    assert result["imported"] == []
    assert "outside the library folder" in result["errors"][0]["message"]
    assert source.exists()


@pytest.mark.asyncio
async def test_database_failure_removes_the_published_library_copy(tmp_path: Path) -> None:
    library = tmp_path / "library"
    source = tmp_path / "source.pdf"
    _pdf(source, b"content")
    documents = make_docs_repo(open_migrated_db(), str(library))
    failing_documents = dict(documents)

    def fail_insert(_document):
        raise RuntimeError("database unavailable")

    failing_documents["insert"] = fail_insert
    importer = createImporter(
        {"documents": failing_documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(source)])

    assert result["imported"] == []
    assert result["errors"] == [
        {"path": str(source), "message": "database unavailable"}
    ]
    assert list(library.iterdir()) == []
    assert source.exists()


@pytest.mark.asyncio
async def test_watched_existing_path_refreshes_replaced_file_identity(tmp_path: Path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    pdf = library / "paper.pdf"
    _pdf(pdf, b"old")
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
    replacement = library / "replacement.pdf"
    _pdf(replacement, b"new")
    replacement.replace(pdf)
    importer = createImporter(
        repos,
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(pdf)], True)

    document = repos["documents"]["get"]("paper")
    assert result["skipped"] == [str(pdf)]
    assert document["fileHash"] == hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert document["fileHash"] != old_hash
    assert document["fileInode"] == pdf.stat().st_ino
    assert repos["aiSummaries"]["getFullText"]("paper") is None
