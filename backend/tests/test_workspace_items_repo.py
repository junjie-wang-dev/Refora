import sqlite3

import pytest

from conftest import (
    insert_asset,
    insert_doc,
    insert_note,
    insert_report,
    make_workspace_items_repo,
    open_migrated_db,
)
from refora_server.repositories.errors import RepoError


def _setup_workspace(db, *, ws_id="ws-1", ws_name="ws"):
    db.execute(
        "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        [ws_id, ws_name, 1000000, 1000000],
    )
    return ws_id


def test_add_document_item():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1"])
    assert len(created) == 1
    item = created[0]
    assert item["kind"] == "document"
    assert item["docId"] == "doc-1"
    assert item["reportId"] is None
    assert item["noteId"] is None
    assert item["assetId"] is None
    assert item["sortOrder"] == 0
    assert item["zIndex"] == 0
    assert item["width"] > 0
    assert item["height"] > 0
    assert item["addedAt"] > 0


def test_add_report_item():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_report(db, id="report-1", workspaceId=ws)
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "report", ["report-1"])
    assert len(created) == 1
    assert created[0]["kind"] == "report"
    assert created[0]["reportId"] == "report-1"
    assert created[0]["docId"] is None


def test_add_note_item():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_note(db, id="note-1", workspaceId=ws)
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "note", ["note-1"])
    assert len(created) == 1
    assert created[0]["kind"] == "note"
    assert created[0]["noteId"] == "note-1"


def test_add_asset_item():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_asset(db, id="asset-1", workspaceId=ws)
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "asset", ["asset-1"])
    assert len(created) == 1
    assert created[0]["kind"] == "asset"
    assert created[0]["assetId"] == "asset-1"


def test_add_duplicate_returns_existing():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    first = items["add"](ws, "document", ["doc-1"])[0]
    second = items["add"](ws, "document", ["doc-1"])[0]
    assert first["id"] == second["id"]
    assert len(items["list"](ws)) == 1


def test_add_invalid_kind():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["add"](ws, "folder", ["x"])
    assert exc.value.code == "invalid_kind"


def test_add_workspace_not_found():
    db = open_migrated_db()
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["add"]("missing", "document", ["doc-1"])
    assert exc.value.code == "not_found"


def test_add_referenced_doc_not_found():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["add"](ws, "document", ["nope"])
    assert exc.value.code == "not_found"


def test_add_report_not_in_workspace():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    _setup_workspace(db, ws_id="ws-2")
    insert_report(db, id="report-2", workspaceId="ws-2")
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["add"](ws, "report", ["report-2"])
    assert exc.value.code == "not_found"


def test_add_multiple_items_sort_order():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    insert_doc(db, id="doc-3")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1", "doc-2", "doc-3"])
    assert [i["sortOrder"] for i in created] == [0, 1, 2]
    assert [i["zIndex"] for i in created] == [0, 1, 2]


def test_add_with_placement():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1", "doc-2"], {"x": 100, "y": 50})
    assert created[0]["x"] == 100.0
    assert created[0]["y"] == 50.0
    assert created[1]["x"] == 128.0
    assert created[1]["y"] == 50.0


def test_add_invalid_placement():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["add"](ws, "document", ["doc-1"], {"x": float("nan"), "y": 0})
    assert exc.value.code == "invalid_position"


def test_add_empty_ids_returns_empty():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    items = make_workspace_items_repo(db)
    assert items["add"](ws, "document", []) == []


def test_list_orders_by_sort_order():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    items = make_workspace_items_repo(db)
    items["add"](ws, "document", ["doc-1", "doc-2"])
    listed = items["list"](ws)
    assert [i["docId"] for i in listed] == ["doc-1", "doc-2"]


def test_remove():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    items["remove"](item["id"])
    assert items["list"](ws) == []
    assert items["get"](item["id"]) is None


def test_remove_not_found():
    db = open_migrated_db()
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["remove"]("missing")
    assert exc.value.code == "not_found"


def test_reorder():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    insert_doc(db, id="doc-3")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1", "doc-2", "doc-3"])
    ids = [i["id"] for i in created]
    reordered = items["reorder"](ws, list(reversed(ids)))
    assert [i["sortOrder"] for i in reordered] == [0, 1, 2]
    assert [i["id"] for i in reordered] == list(reversed(ids))


def test_reorder_invalid_missing():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1", "doc-2"])
    with pytest.raises(RepoError) as exc:
        items["reorder"](ws, [created[0]["id"]])
    assert exc.value.code == "invalid_order"


def test_reorder_invalid_duplicate():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    insert_doc(db, id="doc-2")
    items = make_workspace_items_repo(db)
    created = items["add"](ws, "document", ["doc-1", "doc-2"])
    with pytest.raises(RepoError) as exc:
        items["reorder"](ws, [created[0]["id"], created[0]["id"]])
    assert exc.value.code == "invalid_order"


def test_reorder_workspace_not_found():
    db = open_migrated_db()
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["reorder"]("missing", [])
    assert exc.value.code == "not_found"


def test_resize():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    updated = items["resize"](item["id"], 400, 300)
    assert updated["width"] == 400
    assert updated["height"] == 300


def test_resize_invalid_size():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    with pytest.raises(RepoError) as exc:
        items["resize"](item["id"], 0, 100)
    assert exc.value.code == "invalid_size"
    with pytest.raises(RepoError):
        items["resize"](item["id"], -5, 100)


def test_resize_not_found():
    db = open_migrated_db()
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["resize"]("missing", 300, 200)
    assert exc.value.code == "not_found"


def test_move():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    updated = items["move"](item["id"], 12.5, 34.0, 7)
    assert updated["x"] == 12.5
    assert updated["y"] == 34.0
    assert updated["zIndex"] == 7


def test_move_invalid_position():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    with pytest.raises(RepoError) as exc:
        items["move"](item["id"], float("inf"), 0, 0)
    assert exc.value.code == "invalid_position"
    with pytest.raises(RepoError):
        items["move"](item["id"], 0, 0, -1)


def test_move_not_found():
    db = open_migrated_db()
    items = make_workspace_items_repo(db)
    with pytest.raises(RepoError) as exc:
        items["move"]("missing", 0, 0, 0)
    assert exc.value.code == "not_found"


def test_get_returns_item():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    item = items["add"](ws, "document", ["doc-1"])[0]
    fetched = items["get"](item["id"])
    assert fetched is not None
    assert fetched["id"] == item["id"]


def test_get_missing_returns_none():
    db = open_migrated_db()
    items = make_workspace_items_repo(db)
    assert items["get"]("missing") is None


def test_kind_check_constraint_violation():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO workspace_items "
            "(id, workspaceId, kind, docId, reportId, noteId, assetId, sortOrder, x, y, zIndex, addedAt) "
            "VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 1000000)",
            ["bad", ws, "document"],
        )


def test_unique_index_duplicate_at_db_level():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    items["add"](ws, "document", ["doc-1"])
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO workspace_items "
            "(id, workspaceId, kind, docId, reportId, noteId, assetId, sortOrder, x, y, zIndex, addedAt) "
            "VALUES (?, ?, 'document', ?, NULL, NULL, NULL, 5, 0, 0, 5, 1000000)",
            ["dup", ws, "doc-1"],
        )


def test_workspace_delete_cascades_items():
    db = open_migrated_db()
    ws = _setup_workspace(db)
    insert_doc(db, id="doc-1")
    items = make_workspace_items_repo(db)
    items["add"](ws, "document", ["doc-1"])
    db.execute("DELETE FROM workspaces WHERE id = ?", [ws])
    assert items["list"](ws) == []