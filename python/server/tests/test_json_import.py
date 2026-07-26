from pathlib import Path

import pytest

from conftest import make_cats_repo, make_doc, make_docs_repo, open_migrated_db
from refora_server.library.json_import import importFromJson, parseExportJson, sanitizeImportedDoc
from refora_server.repositories import RepositoryDeps, create_repositories


def test_json_import_sanitizes_paths_and_assigns_categories(tmp_path: Path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    paper = library / "paper.pdf"
    paper.write_bytes(b"%PDF-1.7\ncontent")
    db = open_migrated_db()
    documents = make_docs_repo(db, str(library))
    categories = make_cats_repo(db)
    payload = {
        "version": 1,
        "documents": [
            {
                "id": "doc-imported",
                "filePath": "paper.pdf",
                "title": "Imported paper",
                "metadataStatus": "done",
                "editedFields": ["title", "not-a-field"],
            },
            {"id": "outside", "filePath": "../outside.pdf"},
        ],
        "categories": [{"id": "old-cat", "name": "Reading"}],
        "documentCategories": [{"documentId": "doc-imported", "categoryId": "old-cat"}],
    }

    result = importFromJson({"documents": documents, "categories": categories}, payload, deps={"getLibraryFolder": lambda: str(library)})

    assert result == {"imported": 1}
    document = documents["get"]("doc-imported")
    assert document is not None
    assert document["filePath"] == str(paper)
    assert document["fileMissing"] == 0
    assert document["editedFields"] == ["title"]
    category = categories["list"]()[0]
    assert categories["listForDocument"]("doc-imported") == [category]


def test_json_parser_and_sanitizer_reject_invalid_inputs(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="documents"):
        parseExportJson("{}")
    assert sanitizeImportedDoc({"id": "x", "filePath": "relative.pdf"}, "") is None
    assert sanitizeImportedDoc({"id": "x", "filePath": str(tmp_path / "not-pdf.txt")}, str(tmp_path)) is None


def test_replace_import_rolls_back_all_changes_on_insert_failure(tmp_path: Path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    db = open_migrated_db()
    repos = create_repositories(
        db,
        RepositoryDeps(getLibraryFolder=lambda: str(library)),
    )
    repos["documents"]["insert"](
        make_doc(id="existing", file_path=str(library / "existing.pdf"))
    )
    category = repos["categories"]["create"]("Existing")
    duplicate = {
        "id": "duplicate",
        "filePath": str(library / "missing.pdf"),
        "title": "Duplicate",
    }
    payload = {
        "documents": [duplicate, duplicate],
        "categories": [{"id": "new", "name": "New"}],
        "documentCategories": [],
    }

    with pytest.raises(Exception):
        importFromJson(
            repos,
            payload,
            "replace",
            {"getLibraryFolder": lambda: str(library)},
        )

    assert repos["documents"]["get"]("existing") is not None
    assert repos["categories"]["list"]() == [category]
