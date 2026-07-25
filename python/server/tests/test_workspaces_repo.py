import pytest

from conftest import make_workspaces_repo, open_migrated_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def test_list_empty_returns_empty(db):
    ws = make_workspaces_repo(db)
    assert ws["list"]() == []


def test_create_returns_workspace(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    assert w["name"] == "Research"
    assert w["id"]
    assert w["createdAt"] > 0
    assert w["updatedAt"] == w["createdAt"]


def test_list_orders_by_updatedAt_desc(db):
    ws = make_workspaces_repo(db)
    a = ws["create"]("A")
    b = ws["create"]("B")
    db.execute(
        f"UPDATE workspaces SET updatedAt = {a['createdAt'] + 1000} WHERE id = '{a['id']}'"
    )
    names = [w["name"] for w in ws["list"]()]
    assert names == ["A", "B"]


def test_get_returns_existing(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    got = ws["get"](created["id"])
    assert got is not None
    assert got["id"] == created["id"]
    assert got["name"] == "Research"


def test_get_missing_returns_none(db):
    ws = make_workspaces_repo(db)
    assert ws["get"]("nonexistent") is None


def test_rename_updates_name_and_returns_workspace(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Old")
    renamed = ws["rename"](created["id"], "New")
    assert renamed is not None
    assert renamed["name"] == "New"
    assert renamed["id"] == created["id"]
    assert renamed["updatedAt"] >= created["updatedAt"]


def test_rename_missing_raises(db):
    ws = make_workspaces_repo(db)
    with pytest.raises(RepoError) as exc:
        ws["rename"]("missing", "New")
    assert exc.value.code == "not_found"


def test_delete_removes_workspace(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    ws["delete"](created["id"])
    assert ws["list"]() == []
    assert ws["get"](created["id"]) is None


def test_delete_missing_raises(db):
    ws = make_workspaces_repo(db)
    with pytest.raises(RepoError) as exc:
        ws["delete"]("missing")
    assert exc.value.code == "not_found"


def test_delete_cascades_child_tables(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    wid = created["id"]

    db.execute(
        "INSERT INTO ai_reports (id, workspaceId, title, contentMd, createdAt) "
        "VALUES (?, ?, ?, ?, ?)",
        ["report-1", wid, "Report", "# body", 1],
    )
    db.execute(
        "INSERT INTO workspace_items (id, workspaceId, kind, reportId, sortOrder, addedAt) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ["item-1", wid, "report", "report-1", 0, 1],
    )
    db.execute(
        "INSERT INTO chat_threads (id, workspaceId, providerId, createdAt) "
        "VALUES (?, ?, ?, ?)",
        ["thread-1", wid, "provider-1", 1],
    )

    assert db.execute(
        "SELECT COUNT(*) FROM workspace_items WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 1
    assert db.execute(
        "SELECT COUNT(*) FROM ai_reports WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 1
    assert db.execute(
        "SELECT COUNT(*) FROM chat_threads WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 1

    ws["delete"](wid)

    assert db.execute(
        "SELECT COUNT(*) FROM workspace_items WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM ai_reports WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM chat_threads WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 0


def test_field_contract_matches_workspace_type(db):
    ws = make_workspaces_repo(db)
    created = ws["create"]("Research")
    assert set(created.keys()) == {"id", "name", "createdAt", "updatedAt"}