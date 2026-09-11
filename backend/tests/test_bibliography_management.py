import json
from pathlib import Path

import pytest

from conftest import make_doc, make_docs_repo, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.library.bib_import import importBibtex, importFromBibtex
from refora_server.library.importer import createImporter
from refora_server.repositories.errors import RepoError
from refora_server.services.export import toBibtex


def test_citation_keys_survive_selection_order_metadata_edits_and_restart():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    first = documents["insert"](make_doc(id="one", title="Learning One", authors="Jane Smith", year="2024"))
    second = documents["insert"](make_doc(id="two", title="Learning Two", authors="Jane Smith", year="2024"))
    assert first["citekey"] != second["citekey"]
    for sequence in ([first], [first, second], [second, first]):
        assert f'{{{first["citekey"]},' in toBibtex(sequence)
    documents["update"]("one", {"title": "Another title"})
    assert make_docs_repo(db)["get"]("one")["citekey"] == first["citekey"]
    edited = documents["update"]("one", {"citekey": "MyPaper:2024"})
    assert "{MyPaper:2024," in toBibtex([edited])
    with pytest.raises(RepoError, match="already used"):
        documents["update"]("two", {"citekey": "MyPaper:2024"})
    with pytest.raises(RepoError, match="Citation key"):
        documents["update"]("one", {"citekey": "bad,key"})


def test_citekey_migration_backfills_existing_documents_once():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    documents["insert"](make_doc(id="one", title="Learning One", authors="Jane Smith", year="2024"))
    documents["insert"](make_doc(id="two", title="Learning Two", authors="Jane Smith", year="2024"))
    db.execute("DROP INDEX uq_documents_citekey")
    db.execute("ALTER TABLE documents DROP COLUMN citekey")
    db.execute("PRAGMA user_version = 44")
    run_migrations(_SqliteAdapter(db))
    keys = [doc["citekey"] for doc in documents["list"]({"mode": "all"})]
    assert len(set(keys)) == 2
    assert all(key.startswith("smith2024learning") for key in keys)
    run_migrations(_SqliteAdapter(db))
    assert [doc["citekey"] for doc in documents["list"]({"mode": "all"})] == keys


def test_bibtex_preserves_original_keys_and_deduplicates_normalized_identifiers():
    documents = make_docs_repo(open_migrated_db())
    first = importBibtex({"documents": documents}, '@article{Original:Key,title={First},doi={https://doi.org/10.1234/ABC}}')
    second = importBibtex({"documents": documents}, '@article{DifferentKey,title={Changed},doi={doi:10.1234/abc}}')
    document = documents["get"](first["imported"][0])
    assert second["skipped"] == [document["id"]]
    assert document["citekey"] == "Original:Key"
    assert document["title"] == "First"
    assert document["note"] is None
    another = importBibtex({"documents": documents}, '@article{Original:Key,title={Unrelated},doi={10.1234/other}}')
    assert documents["get"](another["imported"][0])["citekey"] == "Original:Key-2"


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["zotero", "mendeley"])
async def test_repeated_attachment_free_import_then_pdf_preserves_document(tmp_path, source):
    db = open_migrated_db()
    library = tmp_path / "library"
    documents = make_docs_repo(db, str(library))
    bib = tmp_path / "export.bib"
    content = '@article{SavedKey,title={Saved paper},doi={10.1234/example}}'
    bib.write_text(content)
    repos = {"documents": documents}
    deps = {"getLibraryFolder": lambda: str(library)}
    first = await importFromBibtex(repos, str(bib), source, deps=deps)
    document_id = first["added"][0]
    documents["update"](document_id, {"note": "Reading notes"})
    second = await importFromBibtex(repos, str(bib), source, deps=deps)
    assert second["added"] == []
    assert second["skipped"] == [document_id]
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\npaper")
    bib.write_text(content[:-1] + f',file={{{pdf}}}' + '}')
    attached = await importFromBibtex(repos, str(bib), source, deps=deps)
    assert attached["errors"] == []
    assert attached["added"] == [document_id]
    document = documents["get"](document_id)
    assert document["note"] == "Reading notes"
    assert document["citekey"] == "SavedKey"
    assert document["fileMissing"] == 0
    assert Path(document["filePath"]).read_bytes() == pdf.read_bytes()
    assert len(documents["list"]({"mode": "all"})) == 1


@pytest.mark.asyncio
async def test_pdf_import_uses_identifier_and_attaches_to_metadata_only_entry(tmp_path):
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    document = documents["insert"](make_doc(id="existing", file_path="", file_hash=None, file_missing=1, doi="10.1234/ABC", note="Keep me"))
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\npaper")
    importer = createImporter({"documents": documents}, {"getLibraryFolder": lambda: str(library), "validatePdf": lambda _: None, "extractPdfMetadata": lambda _: {"doi": "https://doi.org/10.1234/abc"}})
    result = await importer["importFiles"]([str(pdf)])
    assert result["imported"] == [document["id"]]
    assert documents["get"]("existing")["note"] == "Keep me"
    other = tmp_path / "other.pdf"
    other.write_bytes(b"%PDF-1.4\nanother version")
    result = await importer["importFiles"]([str(other)])
    assert result["skipped"] == [str(other)]
    assert len(documents["list"]({"mode": "all"})) == 1


def test_merge_preserves_notes_categories_annotations_and_workspace_links():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    documents["insert"](make_doc(id="target", title="Primary", note="First note", file_hash="same"))
    documents["insert"](make_doc(id="source", title="Other", note="Second note", file_hash="same", starred=1))
    db.execute("INSERT INTO categories(id,name,sortOrder,createdAt) VALUES ('category','Reading',0,1)")
    db.execute("INSERT INTO document_categories(documentId,categoryId) VALUES ('source','category')")
    db.execute("INSERT INTO pdf_annotations VALUES ('source',?,1)", [json.dumps([{"id": "annotation", "pageNumber": 1}])])
    db.execute("INSERT INTO workspaces(id,name,createdAt,updatedAt) VALUES ('workspace','Desk',1,1)")
    db.execute("INSERT INTO workspace_items(id,workspaceId,kind,docId,sortOrder,addedAt) VALUES ('card','workspace','document','source',0,1)")
    merged = documents["merge"]("target", ["source"])
    assert merged["title"] == "Primary"
    assert merged["note"] == "First note\n\nSecond note"
    assert merged["starred"] == 1
    assert documents["get"]("source") is None
    assert db.execute("SELECT documentId FROM document_categories").fetchone()[0] == "target"
    assert json.loads(db.execute("SELECT annotationsJson FROM pdf_annotations WHERE documentId='target'").fetchone()[0])[0]["id"] == "annotation"
    assert db.execute("SELECT docId FROM workspace_items WHERE id='card'").fetchone()[0] == "target"
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_merge_rolls_back_all_sources_when_annotations_use_different_pdf():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    for document_id in ("target", "first", "second"):
        documents["insert"](make_doc(id=document_id, file_hash=document_id, note=document_id))
    db.execute("INSERT INTO pdf_annotations VALUES ('second',?,1)", [json.dumps([{"id": "annotation"}])])
    with pytest.raises(RepoError, match="different content"):
        documents["merge"]("target", ["first", "second"])
    assert len(documents["list"]({"mode": "all"})) == 3
    assert documents["get"]("target")["note"] == "target"


def test_deleted_document_citation_key_is_reserved_for_restore():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    db.execute("INSERT INTO deleted_documents VALUES ('deleted',1,?)", [json.dumps({"records": {"documents": [{"id": "old", "citekey": "reserved"}]}})])
    document = documents["insert"]({**make_doc(id="new"), "citekey": "reserved"})
    assert document["citekey"] == "reserved-2"
    with pytest.raises(RepoError, match="already used"):
        documents["update"]("new", {"citekey": "reserved"})


@pytest.mark.asyncio
async def test_default_pdf_import_extracts_identity_without_injected_metadata(tmp_path):
    from pypdf import PdfWriter

    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    importer = createImporter({"documents": documents}, {"getLibraryFolder": lambda: str(library)})
    for index in range(2):
        writer = PdfWriter()
        writer.add_blank_page(width=100 + index, height=100)
        writer.add_metadata({"/Title": "Paper", "/doi": "10.1234/identity"})
        path = tmp_path / f"version-{index}.pdf"
        writer.write(path)
        result = await importer["importFiles"]([str(path)])
        assert not result["errors"]
        assert len(result["imported"]) == (1 if index == 0 else 0)
    document = documents["list"]({"mode": "all"})[0]
    assert document["doi"] == "10.1234/identity"
    assert document["metadataStatus"] == "pending"


def test_merge_refuses_active_ocr_without_changing_documents():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    for identifier in ("target", "source"):
        documents["insert"](make_doc(id=identifier))
    db.execute("INSERT INTO document_ocr_jobs(id,documentId,resultKey,sourceHash,profile,status,stage,createdAt,updatedAt) VALUES ('job','source','result','hash','balanced','running','parsing',1,1)")
    with pytest.raises(RepoError, match="Wait for OCR"):
        documents["merge"]("target", ["source"])
    assert len(documents["list"]({"mode": "all"})) == 2


@pytest.mark.asyncio
async def test_merge_cleanup_only_trashes_unreferenced_library_pdfs(tmp_path):
    from refora_server.services.merge_cleanup import trash_merged_pdfs

    library = tmp_path / "library"
    library.mkdir()
    primary_path = library / "primary.pdf"
    duplicate_path = library / "duplicate.pdf"
    referenced_path = library / "referenced.pdf"
    outside_path = tmp_path / "outside.pdf"
    for path in (primary_path, duplicate_path, referenced_path, outside_path):
        path.write_bytes(b"%PDF-1.4")
    trashed = []
    documents = {"findByPath": lambda path: {"id": "another"} if path == str(referenced_path) else None}
    settings = {"get": lambda _key, _default: str(library)}
    connector = {"trashItem": lambda path: trashed.append(path)}
    await trash_merged_pdfs(documents, settings, connector, [{"filePath": str(path)} for path in (primary_path, duplicate_path, duplicate_path, referenced_path, outside_path)], {"filePath": str(primary_path)})
    assert trashed == [str(duplicate_path)]
    assert primary_path.exists()
    assert outside_path.exists()


@pytest.mark.asyncio
async def test_merge_remembers_source_hashes_across_repeated_merges_and_reimport(tmp_path):
    from refora_server.library.importer import hashPdf

    db = open_migrated_db()
    library = tmp_path / "library"
    library.mkdir()
    documents = make_docs_repo(db, str(library))
    paths = [library / f"version-{number}.pdf" for number in range(3)]
    for number, path in enumerate(paths):
        path.write_bytes(f"%PDF-1.4\nversion {number}".encode())
        documents["insert"](make_doc(id=str(number), file_path=str(path), file_hash=hashPdf(str(path))))
    documents["merge"]("0", ["1"])
    documents["merge"]("2", ["0"])
    documents = make_docs_repo(db, str(library))
    assert documents["findByHash"](hashPdf(str(paths[1])))["id"] == "2"
    importer = createImporter({"documents": documents}, {"getLibraryFolder": lambda: str(library), "validatePdf": lambda _: None})
    result = await importer["importFiles"]([str(paths[0]), str(paths[1])])
    assert result["imported"] == []
    assert len(result["skipped"]) == 2
    assert len(documents["list"]({"mode": "all"})) == 1
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_merge_refuses_annotations_when_pdf_hashes_are_unknown():
    db = open_migrated_db()
    documents = make_docs_repo(db)
    for identifier in ("target", "source"):
        documents["insert"](make_doc(id=identifier, file_hash=None))
    db.execute("INSERT INTO pdf_annotations VALUES ('source',?,1)", [json.dumps([{"id": "annotation"}])])
    with pytest.raises(RepoError, match="different content"):
        documents["merge"]("target", ["source"])
    assert documents["get"]("source") is not None


@pytest.mark.asyncio
async def test_alias_pdf_does_not_replace_missing_primary_pdf_and_invalidate_annotations(tmp_path):
    from refora_server.library.importer import hashPdf

    library = tmp_path / "library"
    library.mkdir()
    db = open_migrated_db()
    documents = make_docs_repo(db, str(library))
    source_path = library / "source.pdf"
    source_path.write_bytes(b"%PDF-1.4\nother version")
    documents["insert"](make_doc(id="primary", file_path=str(library / "missing.pdf"), file_hash="canonical", file_missing=1))
    documents["insert"](make_doc(id="source", file_path=str(source_path), file_hash=hashPdf(str(source_path))))
    db.execute("INSERT INTO pdf_annotations VALUES ('primary',?,1)", [json.dumps([{"id": "annotation"}])])
    documents["merge"]("primary", ["source"])
    importer = createImporter({"documents": documents}, {"getLibraryFolder": lambda: str(library)})
    result = await importer["importFiles"]([str(source_path)])
    assert result["imported"] == []
    assert documents["get"]("primary")["fileHash"] == "canonical"
    assert documents["get"]("primary")["fileMissing"] == 1
