import sqlite3

import pytest

from conftest import (
    insert_doc,
    make_workspace_connections_repo,
    make_workspace_items_repo,
    open_migrated_db,
)
from refora_server.repositories.errors import RepoError


def _setup(db, *, ws_id="ws-1"):
    db.execute(
        "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        [ws_id, "ws", 1000000, 1000000],
    )
    return ws_id


def _two_items(db, ws):
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    created = make_workspace_items_repo(db)["add"](ws, "document", ["doc-1", "doc-2"])
    return [i["id"] for i in created]


def test_create_and_list():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    conn = repo["create"](ws, a, b, "right", "left")
    assert conn["sourceItemId"] == a
    assert conn["targetItemId"] == b
    assert conn["sourceAnchor"] == "right"
    assert conn["targetAnchor"] == "left"
    listed = repo["list"](ws)
    assert len(listed) == 1
    assert listed[0]["id"] == conn["id"]


def test_list_workspace_not_found():
    db = open_migrated_db()
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["list"]("missing")
    assert exc.value.code == "not_found"


def test_create_source_equals_target():
    db = open_migrated_db()
    ws = _setup(db)
    a, _ = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](ws, a, a, "right", "left")
    assert exc.value.code == "invalid_connection"


def test_create_invalid_anchor():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](ws, a, b, "middle", "left")
    assert exc.value.code == "invalid_anchor"


def test_create_workspace_not_found():
    db = open_migrated_db()
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"]("missing", "x", "y", "right", "left")
    assert exc.value.code == "not_found"


def test_create_endpoint_not_found():
    db = open_migrated_db()
    ws = _setup(db)
    a, _ = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](ws, a, "missing", "right", "left")
    assert exc.value.code == "not_found"


def test_create_endpoint_in_other_workspace():
    db = open_migrated_db()
    ws = _setup(db)
    _setup(db, ws_id="ws-2")
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-3")
    items = make_workspace_items_repo(db)
    a = items["add"](ws, "document", ["doc-1"])[0]["id"]
    b = items["add"]("ws-2", "document", ["doc-3"])[0]["id"]
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](ws, a, b, "right", "left")
    assert exc.value.code == "not_found"


def test_create_unique_upsert_updates_anchors():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    first = repo["create"](ws, a, b, "right", "left")
    second = repo["create"](ws, a, b, "top", "bottom")
    assert first["id"] == second["id"]
    assert first["createdAt"] == second["createdAt"]
    assert second["sourceAnchor"] == "top"
    assert second["targetAnchor"] == "bottom"
    assert len(repo["list"](ws)) == 1


def test_delete():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    conn = repo["create"](ws, a, b, "right", "left")
    repo["delete"](conn["id"])
    assert repo["list"](ws) == []


def test_delete_not_found():
    db = open_migrated_db()
    repo = make_workspace_connections_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["delete"]("missing")
    assert exc.value.code == "not_found"


def test_delete_item_cascades_connection():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    repo["create"](ws, a, b, "right", "left")
    db.execute("DELETE FROM workspace_items WHERE id = ?", [a])
    assert repo["list"](ws) == []


def test_delete_workspace_cascades_connections():
    db = open_migrated_db()
    ws = _setup(db)
    a, b = _two_items(db, ws)
    repo = make_workspace_connections_repo(db)
    repo["create"](ws, a, b, "right", "left")
    db.execute("DELETE FROM workspaces WHERE id = ?", [ws])
    cur = db.execute(
        "SELECT COUNT(*) AS c FROM workspace_connections WHERE workspaceId = ?",
        [ws],
    )
    assert cur.fetchone()["c"] == 0


def test_source_target_check_constraint():
    db = open_migrated_db()
    ws = _setup(db)
    a, _ = _two_items(db, ws)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO workspace_connections "
            "(id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt) "
            "VALUES (?, ?, ?, ?, 'right', 'left', 1000000)",
            ["c", ws, a, a],
        )