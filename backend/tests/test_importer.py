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
    stored = Path(document["filePath"])
    assert stored.parent == library
    assert stored.name == "first.pdf"
    assert stored.exists()
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
async def test_import_folder_skips_hidden_managed_and_symlinked_pdfs(tmp_path: Path) -> None:
    library = tmp_path / "library"
    folder = tmp_path / "source"
    folder.mkdir()
    visible = folder / "visible.pdf"
    _pdf(visible, b"visible")
    hidden = folder / ".hidden" / "hidden.pdf"
    hidden.parent.mkdir()
    _pdf(hidden, b"hidden")
    managed = folder / "refora-assets" / "derived.pdf"
    managed.parent.mkdir()
    _pdf(managed, b"managed")
    outside = tmp_path / "outside.pdf"
    _pdf(outside, b"outside")
    symlink = folder / "linked.pdf"
    symlink.symlink_to(outside)
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFolder"](str(folder), True)

    assert len(result["imported"]) == 1
    assert result["skipped"] == []
    assert result["errors"] == []


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
async def test_manual_duplicate_is_deduplicated_by_content_hash(tmp_path: Path) -> None:
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
    assert second_result["imported"] == []
    assert second_result["skipped"] == [str(duplicate.resolve())]
    assert decisions == []


@pytest.mark.asyncio
async def test_import_rejects_a_source_changed_while_hashing(tmp_path: Path) -> None:
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

    assert result["imported"] == []
    assert result["errors"] == [
        {"path": str(source), "message": "PDF changed during import"}
    ]
    assert hashed_paths == [str(source.resolve())]


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
    assert "outside the library root" in result["errors"][0]["message"]
    assert source.exists()


@pytest.mark.asyncio
async def test_database_failure_removes_the_unreferenced_library_copy(tmp_path: Path) -> None:
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
async def test_normalize_managed_files_moves_content_objects_to_the_library_root(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    source = library / "objects" / "sha256" / "ab" / f"{'a' * 64}.pdf"
    source.parent.mkdir(parents=True)
    _pdf(source, b"legacy")
    file_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    db = open_migrated_db()
    repos = create_repositories(
        db,
        RepositoryDeps(getLibraryFolder=lambda: str(library)),
    )
    repos["documents"]["insert"](
        make_doc(
            id="legacy-doc",
            file_path=str(source),
            file_name="Readable Name.pdf",
            file_size=source.stat().st_size,
            file_hash=file_hash,
        )
    )
    importer = createImporter(
        repos,
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["normalizeManagedFiles"]()

    assert result == {"normalized": 1, "errors": []}
    document = repos["documents"]["get"]("legacy-doc")
    assert document is not None
    assert document["fileName"] == "Readable Name.pdf"
    assert Path(document["filePath"]) == library / "Readable Name.pdf"
    assert not source.exists()
    assert not (library / "objects").exists()


@pytest.mark.asyncio
async def test_normalize_managed_files_migrates_all_records_sharing_one_object(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    source = library / "objects" / "sha256" / "ab" / f"{'b' * 64}.pdf"
    source.parent.mkdir(parents=True)
    _pdf(source, b"shared")
    file_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    db = open_migrated_db()
    repos = create_repositories(
        db,
        RepositoryDeps(getLibraryFolder=lambda: str(library)),
    )
    for document_id, file_name in (("first", "First.pdf"), ("second", "Second.pdf")):
        repos["documents"]["insert"](
            make_doc(
                id=document_id,
                file_path=str(source),
                file_name=file_name,
                file_size=source.stat().st_size,
                file_hash=file_hash,
            )
        )
    importer = createImporter(
        repos,
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["normalizeManagedFiles"]()

    assert result == {"normalized": 2, "errors": []}
    assert Path(repos["documents"]["get"]("first")["filePath"]) == library / "First.pdf"
    assert Path(repos["documents"]["get"]("second")["filePath"]) == library / "Second.pdf"
    assert not source.exists()
    assert not (library / "objects").exists()


@pytest.mark.asyncio
async def test_normalize_managed_files_does_not_rewrite_root_records(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    source = library / "paper.pdf"
    _pdf(source, b"root")
    db = open_migrated_db()
    repos = create_repositories(
        db,
        RepositoryDeps(getLibraryFolder=lambda: str(library)),
    )
    repos["documents"]["insert"](
        make_doc(
            id="root-doc",
            file_path=str(source),
            file_name=source.name,
            file_size=source.stat().st_size,
            file_hash=hashlib.sha256(source.read_bytes()).hexdigest(),
        )
    )
    before = repos["documents"]["get"]("root-doc")
    importer = createImporter(
        repos,
        {
            "getLibraryFolder": lambda: str(library),
            "hashPdf": lambda _path: (_ for _ in ()).throw(
                AssertionError("root PDF must not be rehashed")
            ),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["normalizeManagedFiles"]()

    after = repos["documents"]["get"]("root-doc")
    assert result == {"normalized": 0, "errors": []}
    assert after["updatedAt"] == before["updatedAt"]


@pytest.mark.asyncio
async def test_import_files_keep_readable_names_and_never_overwrite_collisions(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    first = tmp_path / "first" / "paper.pdf"
    second = tmp_path / "second" / "paper.pdf"
    first.parent.mkdir()
    second.parent.mkdir()
    _pdf(first, b"first")
    _pdf(second, b"second")
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter(
        {"documents": documents},
        {
            "getLibraryFolder": lambda: str(library),
            "validatePdf": lambda _path: None,
        },
    )

    result = await importer["importFiles"]([str(first), str(second)])

    assert len(result["imported"]) == 2
    assert result["errors"] == []
    stored = sorted(Path(item["filePath"]) for item in documents["list"]({"mode": "all"}))
    assert stored == [library / "paper (1).pdf", library / "paper.pdf"]
    assert {path.read_bytes() for path in stored} == {first.read_bytes(), second.read_bytes()}


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
