import pytest

from conftest import make_doc, make_docs_repo, open_schema_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_schema_db()
    yield db
    db.close()


def _insert(db, **overrides):
    repo = make_docs_repo(db, library_folder="/lib")
    doc = make_doc(**overrides)
    return repo["insert"](doc), repo


def test_list_all_returns_all_documents_ordered_by_addedAt_desc(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", added_at=100))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", added_at=300))
    repo["insert"](make_doc(id="c", file_path="/lib/c.pdf", file_name="c.pdf", added_at=200))
    docs = repo["list"]({"mode": "all"})
    assert [d["id"] for d in docs] == ["b", "c", "a"]


def test_list_with_sort_field(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="zebra"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", title="apple"))
    docs = repo["list"]({"mode": "all", "sort": {"field": "title", "dir": "asc"}})
    assert [d["id"] for d in docs] == ["b", "a"]


def test_list_pushes_pagination_and_starred_filter_into_sql(db):
    repo = make_docs_repo(db, library_folder="/lib")
    for index in range(8):
        repo["insert"](
            make_doc(
                id=f"doc-{index}",
                file_path=f"/lib/{index}.pdf",
                file_name=f"{index}.pdf",
                starred=index % 2,
                added_at=100 - index,
            )
        )
    statements: list[str] = []
    db.set_trace_callback(statements.append)

    docs = repo["list"](
        {"mode": "all", "starred": False, "limit": 2, "offset": 1}
    )

    assert [document["id"] for document in docs] == ["doc-2", "doc-4"]
    select = next(statement for statement in statements if "FROM documents" in statement)
    assert "starred = 0" in select
    assert "LIMIT 2 OFFSET 1" in select


def test_list_offset_without_limit_is_applied_by_sql(db):
    repo = make_docs_repo(db, library_folder="/lib")
    for index in range(4):
        repo["insert"](
            make_doc(
                id=f"doc-{index}",
                file_path=f"/lib/{index}.pdf",
                file_name=f"{index}.pdf",
                added_at=100 - index,
            )
        )

    docs = repo["list"]({"mode": "all", "offset": 2})

    assert [document["id"] for document in docs] == ["doc-2", "doc-3"]


def test_list_recentlyRead_filters_lastReadAt(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", last_read_at=500))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", last_read_at=None))
    docs = repo["list"]({"mode": "recentlyRead"})
    assert [d["id"] for d in docs] == ["a"]
    assert docs[0]["lastReadAt"] == 500


def test_list_starred_filters_starred(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", starred=1))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", starred=0))
    docs = repo["list"]({"mode": "starred"})
    assert [d["id"] for d in docs] == ["a"]


def test_list_recentlyAdded_filters_last_7_days(db):
    import time

    repo = make_docs_repo(db, library_folder="/lib")
    now = int(time.time() * 1000)
    repo["insert"](
        make_doc(id="recent", file_path="/lib/r.pdf", file_name="r.pdf", added_at=now)
    )
    repo["insert"](
        make_doc(id="old", file_path="/lib/o.pdf", file_name="o.pdf", added_at=now - 8 * 24 * 60 * 60 * 1000)
    )
    docs = repo["list"]({"mode": "recentlyAdded"})
    assert [d["id"] for d in docs] == ["recent"]


def test_list_category_filters_by_category_id(db):
    from conftest import make_cats_repo

    repo = make_docs_repo(db, library_folder="/lib")
    cats = make_cats_repo(db)
    cat = cats["create"]("Physics")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    cats["assign"]("a", cat["id"])
    docs = repo["list"]({"mode": "category", "categoryId": cat["id"]})
    assert [d["id"] for d in docs] == ["a"]


def test_counts(db):
    import time

    repo = make_docs_repo(db, library_folder="/lib")
    now = int(time.time() * 1000)
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", starred=1, last_read_at=100, added_at=now))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", added_at=now - 8 * 24 * 60 * 60 * 1000))
    c = repo["counts"]()
    assert c["all"] == 2
    assert c["recentlyRead"] == 1
    assert c["starred"] == 1
    assert c["recentlyAdded"] == 1


def test_get_returns_none_for_missing(db):
    repo = make_docs_repo(db, library_folder="/lib")
    assert repo["get"]("missing") is None


def test_get_returns_document_with_resolved_path(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    doc = repo["get"]("a")
    assert doc is not None
    assert doc["id"] == "a"
    assert doc["filePath"] == "/lib/a.pdf"
    assert doc["fileName"] == "a.pdf"


def test_insert_stores_relative_path(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/sub/a.pdf", file_name="a.pdf"))
    cur = db.execute("SELECT filePath FROM documents WHERE id = ?", ["a"])
    assert cur.fetchone()["filePath"] == "sub/a.pdf"
    doc = repo["get"]("a")
    assert doc["filePath"] == "/lib/sub/a.pdf"


def test_insert_outside_library_keeps_absolute(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/other/a.pdf", file_name="a.pdf"))
    cur = db.execute("SELECT filePath FROM documents WHERE id = ?", ["a"])
    assert cur.fetchone()["filePath"] == "/other/a.pdf"


def test_update_changes_field_and_records_edited(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    doc = repo["update"]("a", {"title": "New Title"})
    assert doc["title"] == "New Title"
    assert "title" in doc["editedFields"]
    doc2 = repo["get"]("a")
    assert doc2["title"] == "New Title"
    assert "title" in doc2["editedFields"]


def test_update_empty_value_removes_from_edited(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["update"]("a", {"title": "X"})
    doc = repo["update"]("a", {"title": ""})
    assert doc["title"] == ""
    assert "title" not in doc["editedFields"]


def test_update_forbidden_field_raises(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    with pytest.raises(RepoError) as exc:
        repo["update"]("a", {"id": "hacked"})
    assert exc.value.code == "forbidden_field"


def test_update_non_string_value_raises(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    with pytest.raises(RepoError) as exc:
        repo["update"]("a", {"title": 123})
    assert exc.value.code == "invalid_value"


def test_update_missing_doc_raises(db):
    repo = make_docs_repo(db, library_folder="/lib")
    with pytest.raises(RepoError) as exc:
        repo["update"]("missing", {"title": "x"})
    assert exc.value.code == "not_found"


def test_update_no_keys_returns_current(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="Keep"))
    doc = repo["update"]("a", {})
    assert doc["title"] == "Keep"
    assert doc["editedFields"] == []


def test_delete_removes_row(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["delete"]("a")
    assert repo["get"]("a") is None


def test_bulkDelete_removes_rows(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    repo["insert"](make_doc(id="c", file_path="/lib/c.pdf", file_name="c.pdf"))
    repo["bulkDelete"](["a", "c"])
    remaining = [d["id"] for d in repo["list"]({"mode": "all"})]
    assert remaining == ["b"]


def test_bulkDelete_empty_is_noop(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["bulkDelete"]([])
    assert repo["counts"]()["all"] == 0


def test_deleteAll_clears_table(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    repo["deleteAll"]()
    assert repo["counts"]()["all"] == 0


def test_setStarred(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", starred=0))
    repo["setStarred"]("a", True)
    assert repo["get"]("a")["starred"] == 1
    repo["setStarred"]("a", False)
    assert repo["get"]("a")["starred"] == 0


def test_findByPath_matches_relative(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/sub/a.pdf", file_name="a.pdf"))
    doc = repo["findByPath"]("/lib/sub/a.pdf")
    assert doc is not None
    assert doc["id"] == "a"


def test_findByPath_returns_none_for_missing(db):
    repo = make_docs_repo(db, library_folder="/lib")
    assert repo["findByPath"]("/lib/none.pdf") is None


def test_findByHash(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", file_hash="abc123"))
    doc = repo["findByHash"]("abc123")
    assert doc is not None
    assert doc["id"] == "a"
    assert repo["findByHash"]("nope") is None


def test_updateFilePath_updates_relative_and_filename(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["updateFilePath"]("a", "/lib/moved/b.pdf", "b.pdf")
    cur = db.execute("SELECT filePath, fileName FROM documents WHERE id = ?", ["a"])
    row = cur.fetchone()
    assert row["filePath"] == "moved/b.pdf"
    assert row["fileName"] == "b.pdf"


def test_updateFileIdentity(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", file_size=100, file_hash="old", file_missing=1))
    repo["updateFileIdentity"]("a", "/lib/x.pdf", "x.pdf", 999, "newhash")
    doc = repo["get"]("a")
    assert doc["fileName"] == "x.pdf"
    assert doc["fileSize"] == 999
    assert doc["fileHash"] == "newhash"
    assert doc["fileMissing"] == 0


def test_setMetadataStatus_without_source(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["setMetadataStatus"]("a", "done")
    doc = repo["get"]("a")
    assert doc["metadataStatus"] == "done"
    assert doc["metadataSource"] is None


def test_setMetadataStatus_with_source(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["setMetadataStatus"]("a", "done", "crossref")
    doc = repo["get"]("a")
    assert doc["metadataStatus"] == "done"
    assert doc["metadataSource"] == "crossref"


def test_incrementMetadataAttempts(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", metadata_attempts=2))
    n = repo["incrementMetadataAttempts"]("a")
    assert n == 3
    assert repo["get"]("a")["metadataAttempts"] == 3


def test_setLastReadAt(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", last_read_at=None))
    repo["setLastReadAt"]("a", 12345)
    assert repo["get"]("a")["lastReadAt"] == 12345
    repo["setLastReadAt"]("a", None)
    assert repo["get"]("a")["lastReadAt"] is None


def test_setFileMissing(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", file_missing=0))
    repo["setFileMissing"]("a", True)
    assert repo["get"]("a")["fileMissing"] == 1
    repo["setFileMissing"]("a", False)
    assert repo["get"]("a")["fileMissing"] == 0


def test_getResumableMetadataRows(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="pending", file_path="/lib/p.pdf", file_name="p.pdf", metadata_status="pending"))
    repo["insert"](make_doc(id="failed-retry", file_path="/lib/f1.pdf", file_name="f1.pdf", metadata_status="failed", metadata_attempts=2))
    repo["insert"](make_doc(id="failed-done", file_path="/lib/f2.pdf", file_name="f2.pdf", metadata_status="failed", metadata_attempts=3))
    repo["insert"](make_doc(id="done", file_path="/lib/d.pdf", file_name="d.pdf", metadata_status="done"))
    rows = repo["getResumableMetadataRows"]()
    ids = {d["id"] for d in rows}
    assert ids == {"pending", "failed-retry"}


def test_setRemoteValues(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    repo["setRemoteValues"]("a", {"title": {"value": "T", "source": "crossref"}})
    doc = repo["get"]("a")
    assert doc["remoteValues"] == {"title": {"value": "T", "source": "crossref"}}
    repo["setRemoteValues"]("a", None)
    assert repo["get"]("a")["remoteValues"] is None


def test_authors_are_normalized_on_insert_update_and_remote_metadata(db):
    repo = make_docs_repo(db, library_folder="/lib")
    inserted = repo["insert"](
        make_doc(
            id="a",
            file_path="/lib/a.pdf",
            file_name="a.pdf",
            authors="Lin, Ming C.; Qiao, Yi-Ling",
        )
    )
    assert inserted["authors"] == "Ming C. Lin; Yi-Ling Qiao"

    updated = repo["update"]("a", {"authors": "Son, Sanghyun; Zhou, Yang"})
    assert updated["authors"] == "Sanghyun Son; Yang Zhou"

    repo["setRemoteValues"](
        "a",
        {"authors": {"value": "Fisher, Matthew", "source": "dblp"}},
    )
    assert repo["get"]("a")["remoteValues"]["authors"]["value"] == "Matthew Fisher"


def test_applyMetadataFields_updates_and_sets_status(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    doc = repo["applyMetadataFields"](
        "a",
        {"title": "Computed", "authors": "A. Author"},
        {"title": {"value": "Computed", "source": "crossref"}},
        "done",
        "crossref",
    )
    assert doc["title"] == "Computed"
    assert doc["authors"] == "A. Author"
    assert doc["metadataStatus"] == "done"
    assert doc["metadataSource"] == "crossref"
    assert doc["remoteValues"] == {"title": {"value": "Computed", "source": "crossref"}}


def test_applyMetadataFields_normalizes_authors(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    doc = repo["applyMetadataFields"](
        "a",
        {"authors": "0003, Sanghyun Son; Gadelha, Matheus"},
        {"authors": {"value": "Zhou, Yang", "source": "dblp"}},
        "done",
        "dblp",
    )
    assert doc["authors"] == "Sanghyun Son; Matheus Gadelha"
    assert doc["remoteValues"]["authors"]["value"] == "Yang Zhou"


def test_applyMetadataFields_does_not_touch_editedFields(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", edited_fields=["note"]))
    doc = repo["applyMetadataFields"](
        "a",
        {"title": "Computed"},
        None,
        "done",
        "crossref",
    )
    assert doc["title"] == "Computed"
    assert doc["editedFields"] == ["note"]


def test_applyMetadataFields_noop_when_unchanged(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", metadata_status="pending"))
    doc = repo["applyMetadataFields"]("a", {}, None, "pending", None)
    assert doc["metadataStatus"] == "pending"


def test_search_empty_query_returns_empty(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="hello world"))
    assert repo["search"]("") == []
    assert repo["search"]("   ") == []


def test_search_trigram_matches_substring(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="trigram")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="Quantum Field Theory"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", title="Classical Mechanics"))
    results = repo["search"]("Quantum")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_trigram_matches_filename(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="trigram")
    repo["insert"](make_doc(id="a", file_path="/lib/important-paper.pdf", file_name="important-paper.pdf", title=None))
    results = repo["search"]("important")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_trigram_short_query_falls_back_to_like(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="trigram")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="AI"))
    results = repo["search"]("AI")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_like_mode_matches(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="paper-2024.pdf", title="Deep Learning"))
    repo["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf", title="Unrelated"))
    results = repo["search"]("learning")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_like_matches_filename(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    repo["insert"](make_doc(id="a", file_path="/lib/report.pdf", file_name="report.pdf", title=None))
    results = repo["search"]("report")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_like_escapes_wildcards(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="50% off"))
    results = repo["search"]("50%")
    assert len(results) == 1
    assert results[0]["id"] == "a"


def test_search_respects_limit(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    for i in range(10):
        repo["insert"](make_doc(id=f"d{i}", file_path=f"/lib/d{i}.pdf", file_name=f"d{i}.pdf", title="common"))
    results = repo["search"]("common", limit=3)
    assert len(results) == 3


def test_search_pushes_offset_into_sql(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    for index in range(6):
        repo["insert"](
            make_doc(
                id=f"d{index}",
                file_path=f"/lib/d{index}.pdf",
                file_name=f"d{index}.pdf",
                title="common",
                added_at=100 - index,
            )
        )

    results = repo["search"]("common", limit=2, offset=2)

    assert [document["id"] for document in results] == ["d2", "d3"]


def test_search_like_mode_with_short_query(db):
    repo = make_docs_repo(db, library_folder="/lib", search_mode="like")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf", title="ok"))
    results = repo["search"]("ok")
    assert len(results) == 1


def test_document_mapping_includes_all_fields(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](
        make_doc(
            id="full",
            file_path="/lib/full.pdf",
            file_name="full.pdf",
            title="Title",
            authors="Author",
            year="2024",
            venue="Venue",
            volume="1",
            issue="2",
            pages="3-4",
            abstract="Abstract",
            keywords="kw",
            url="http://x",
            doi="10.x",
            arxiv_id="1234.5678",
            note="note",
            affiliations="aff",
            starred=1,
            metadata_source="manual",
            metadata_status="done",
            metadata_attempts=5,
            edited_fields=["title"],
            remote_values={"title": {"value": "T", "source": "manual"}},
            file_missing=1,
        )
    )
    doc = repo["get"]("full")
    assert doc["title"] == "Title"
    assert doc["authors"] == "Author"
    assert doc["year"] == "2024"
    assert doc["venue"] == "Venue"
    assert doc["volume"] == "1"
    assert doc["issue"] == "2"
    assert doc["pages"] == "3-4"
    assert doc["abstract"] == "Abstract"
    assert doc["keywords"] == "kw"
    assert doc["url"] == "http://x"
    assert doc["doi"] == "10.x"
    assert doc["arxivId"] == "1234.5678"
    assert doc["note"] == "note"
    assert doc["affiliations"] == "aff"
    assert doc["starred"] == 1
    assert doc["metadataSource"] == "manual"
    assert doc["metadataStatus"] == "done"
    assert doc["metadataAttempts"] == 5
    assert doc["editedFields"] == ["title"]
    assert doc["remoteValues"] == {"title": {"value": "T", "source": "manual"}}
    assert doc["fileMissing"] == 1


def test_edited_fields_parse_invalid_returns_empty(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    db.execute("UPDATE documents SET editedFields = ? WHERE id = ?", ["not-json", "a"])
    doc = repo["get"]("a")
    assert doc["editedFields"] == []


def test_remote_values_parse_invalid_returns_null(db):
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    db.execute("UPDATE documents SET remoteValues = ? WHERE id = ?", ["{bad", "a"])
    doc = repo["get"]("a")
    assert doc["remoteValues"] is None
