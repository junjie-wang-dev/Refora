import pytest

from conftest import make_workspaces_repo, open_migrated_db
from refora_server.repositories.ai_reports import createAiReportsRepository
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def make_reports_repo(db):
    return createAiReportsRepository(db)


def make_workspace(db, name="Research"):
    ws = make_workspaces_repo(db)
    return ws["create"](name)


def test_create_returns_report_with_json_roundtrip(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](
        wid,
        "Quarterly Review",
        "# Body",
        ["doc-1", "doc-2"],
        model="gpt-4o",
    )
    assert created["workspaceId"] == wid
    assert created["title"] == "Quarterly Review"
    assert created["contentMd"] == "# Body"
    assert created["sourceDocIds"] == ["doc-1", "doc-2"]
    assert created["model"] == "gpt-4o"
    assert created["createdAt"] > 0
    assert created["id"]

    raw = db.execute(
        "SELECT sourceDocIds FROM ai_reports WHERE id = ?", [created["id"]]
    ).fetchone()
    assert raw["sourceDocIds"] == '["doc-1", "doc-2"]'


def test_create_accepts_json_string_source_doc_ids(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", '["doc-a", "doc-b"]')
    assert created["sourceDocIds"] == ["doc-a", "doc-b"]


def test_create_default_model_is_none(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", [])
    assert created["model"] is None
    assert created["sourceDocIds"] == []


def test_create_empty_title_raises(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    with pytest.raises(RepoError) as exc:
        reports["create"](wid, "   ", "# b", [])
    assert exc.value.code == "invalid_title"


def test_create_unknown_workspace_raises(db):
    reports = make_reports_repo(db)
    with pytest.raises(RepoError) as exc:
        reports["create"]("no-such-ws", "R", "# b", [])
    assert exc.value.code == "not_found"


def test_list_filters_by_workspace_and_orders_by_created_at_desc(db):
    wA = make_workspace(db, "A")["id"]
    wB = make_workspace(db, "B")["id"]
    reports = make_reports_repo(db)
    r1 = reports["create"](wA, "A1", "# 1", ["doc-1"])
    db.execute(
        f"UPDATE ai_reports SET createdAt = {int(r1['createdAt']) - 2000} WHERE id = '{r1['id']}'"
    )
    r2 = reports["create"](wA, "A2", "# 2", ["doc-2"])
    db.execute(
        f"UPDATE ai_reports SET createdAt = {int(r2['createdAt']) - 1000} WHERE id = '{r2['id']}'"
    )
    r3 = reports["create"](wB, "B1", "# 3", [])

    a = reports["list"](wA)
    assert [r["id"] for r in a] == [r2["id"], r1["id"]]
    b = reports["list"](wB)
    assert [r["id"] for r in b] == [r3["id"]]
    assert reports["list"](wA)


def test_get_returns_existing(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", ["doc-1"], model="m")
    got = reports["get"](created["id"])
    assert got is not None
    assert got["id"] == created["id"]
    assert got["sourceDocIds"] == ["doc-1"]
    assert got["model"] == "m"


def test_get_missing_returns_none(db):
    reports = make_reports_repo(db)
    assert reports["get"]("nonexistent") is None


def test_update_title_and_content(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "Old", "# old", ["doc-1"])
    updated = reports["update"](created["id"], {"title": "New", "contentMd": "# new"})
    assert updated["title"] == "New"
    assert updated["contentMd"] == "# new"
    assert updated["sourceDocIds"] == ["doc-1"]
    assert updated["id"] == created["id"]


def test_update_partial_keeps_other_fields(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "Keep", "# body", ["doc-1"])
    updated = reports["update"](created["id"], {"title": "Renamed"})
    assert updated["title"] == "Renamed"
    assert updated["contentMd"] == "# body"
    assert updated["sourceDocIds"] == ["doc-1"]


def test_update_missing_raises(db):
    reports = make_reports_repo(db)
    with pytest.raises(RepoError) as exc:
        reports["update"]("missing", {"title": "x"})
    assert exc.value.code == "not_found"


def test_update_empty_title_raises(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", [])
    with pytest.raises(RepoError) as exc:
        reports["update"](created["id"], {"title": "   "})
    assert exc.value.code == "invalid_title"


def test_delete_removes_report(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", [])
    reports["delete"](created["id"])
    assert reports["get"](created["id"]) is None


def test_delete_missing_raises(db):
    reports = make_reports_repo(db)
    with pytest.raises(RepoError) as exc:
        reports["delete"]("missing")
    assert exc.value.code == "not_found"


def test_delete_cascade_when_workspace_removed(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    wid = created["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R1", "# 1", ["doc-1"])
    reports["create"](wid, "R2", "# 2", ["doc-2"])

    assert (
        db.execute(
            "SELECT COUNT(*) FROM ai_reports WHERE workspaceId = ?", [wid]
        ).fetchone()[0]
        == 2
    )

    ws["delete"](wid)

    assert (
        db.execute(
            "SELECT COUNT(*) FROM ai_reports WHERE workspaceId = ?", [wid]
        ).fetchone()[0]
        == 0
    )
    assert reports["list"](wid) == []


def test_create_updates_workspace_updatedAt(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    wid = created["id"]
    before = ws["get"](wid)["updatedAt"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R", "# b", [])
    after = ws["get"](wid)["updatedAt"]
    assert after >= before


def test_field_contract_matches_ai_report_type(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# b", ["doc-1"], model="m")
    assert set(created.keys()) == {
        "id",
        "workspaceId",
        "title",
        "contentMd",
        "sourceDocIds",
        "model",
        "createdAt",
    }


def test_remove_doc_from_sources_filters_matching_doc_id(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R1", "# 1", ["doc-1", "doc-2", "doc-3"])
    reports["create"](wid, "R2", "# 2", ["doc-2"])
    reports["create"](wid, "R3", "# 3", ["doc-9"])
    reports["create"](wid, "R4", "# 4", [])

    reports["removeDocFromSources"]("doc-2")

    listed = {r["title"]: r for r in reports["list"](wid)}
    assert listed["R1"]["sourceDocIds"] == ["doc-1", "doc-3"]
    assert listed["R2"]["sourceDocIds"] == []
    assert listed["R3"]["sourceDocIds"] == ["doc-9"]
    assert listed["R4"]["sourceDocIds"] == []


def test_remove_doc_from_sources_handles_doc_at_first_middle_last(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "first", "# 1", ["doc-1", "doc-2", "doc-3"])
    reports["create"](wid, "middle", "# 2", ["doc-a", "doc-1", "doc-c"])
    reports["create"](wid, "last", "# 3", ["doc-x", "doc-y", "doc-1"])

    reports["removeDocFromSources"]("doc-1")

    listed = {r["title"]: r for r in reports["list"](wid)}
    assert listed["first"]["sourceDocIds"] == ["doc-2", "doc-3"]
    assert listed["middle"]["sourceDocIds"] == ["doc-a", "doc-c"]
    assert listed["last"]["sourceDocIds"] == ["doc-x", "doc-y"]


def test_remove_doc_from_sources_noop_when_doc_id_absent(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# 1", ["doc-1", "doc-2"])
    original = reports["get"](created["id"])["sourceDocIds"]

    reports["removeDocFromSources"]("doc-absent")

    assert reports["get"](created["id"])["sourceDocIds"] == original


def test_remove_doc_from_sources_writes_empty_array_when_only_doc(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    created = reports["create"](wid, "R", "# 1", ["doc-1"])

    reports["removeDocFromSources"]("doc-1")

    assert reports["get"](created["id"])["sourceDocIds"] == []
    raw = db.execute(
        "SELECT sourceDocIds FROM ai_reports WHERE id = ?", [created["id"]]
    ).fetchone()
    assert raw["sourceDocIds"] == "[]"


def test_remove_doc_from_sources_does_not_touch_unrelated_reports(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R", "# 1", ["doc-1", "doc-2"])
    unrelated = reports["create"](wid, "U", "# 2", ["doc-3", "doc-4"])

    reports["removeDocFromSources"]("doc-1")

    assert reports["get"](unrelated["id"])["sourceDocIds"] == ["doc-3", "doc-4"]


def test_remove_doc_from_sources_handles_doc_id_substring_safely(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R", "# 1", ["doc-1", "doc-10", "doc-11"])

    reports["removeDocFromSources"]("doc-1")

    assert reports["list"](wid)[0]["sourceDocIds"] == ["doc-10", "doc-11"]


def test_delete_document_triggers_report_cleanup_via_remove_doc_from_sources(db):
    wid = make_workspace(db)["id"]
    reports = make_reports_repo(db)
    reports["create"](wid, "R1", "# 1", ["doc-1", "doc-2"])

    reports["removeDocFromSources"]("doc-1")

    assert reports["list"](wid)[0]["sourceDocIds"] == ["doc-2"]