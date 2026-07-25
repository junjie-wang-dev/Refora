from pathlib import Path

from conftest import make_docs_repo, open_migrated_db
from refora_server.library.importer import createImporter


def _pdf(path: Path, content: bytes) -> None:
    path.write_bytes(b"%PDF-1.7\n" + content)


def test_import_files_copies_and_deduplicates_by_hash(tmp_path: Path) -> None:
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
            "extractPdfMetadata": lambda _path: {"title": "Extracted title", "metadataSource": "pdf"},
        },
    )

    result = importer["importFiles"]([str(first), str(duplicate), "relative.pdf"])

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


def test_import_folder_honors_recursive_flag(tmp_path: Path) -> None:
    library = tmp_path / "library"
    folder = tmp_path / "source"
    nested = folder / "nested"
    nested.mkdir(parents=True)
    _pdf(folder / "one.pdf", b"one")
    _pdf(nested / "two.pdf", b"two")
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter({"documents": documents}, {"getLibraryFolder": lambda: str(library)})

    first = importer["importFolder"](str(folder), False)
    second = importer["importFolder"](str(folder), True)

    assert len(first["imported"]) == 1
    assert len(second["imported"]) == 1
    assert len(documents["list"]({"mode": "all"})) == 2
