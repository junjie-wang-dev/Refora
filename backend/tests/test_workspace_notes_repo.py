import sqlite3

import pytest

from conftest import make_workspace_notes_repo, make_workspaces_repo, open_migrated_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def _make_workspace(db) -> str:
    ws = make_workspaces_repo(db)
    return ws["create"]("Research")["id"]


def test_list_empty_returns_empty(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    assert notes["list"](wid) == []


def test_create_returns_note_with_markdown_default(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "My Note", "# body")
    assert note["id"]
    assert note["workspaceId"] == wid
    assert note["title"] == "My Note"
    assert note["contentMd"] == "# body"
    assert note["noteType"] == "markdown"
    assert note["color"] == "sand"
    assert note["createdAt"] > 0
    assert note["updatedAt"] == note["createdAt"]


def test_create_strips_title(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "  Spaced  ", "body")
    assert note["title"] == "Spaced"


def test_create_empty_title_raises(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    with pytest.raises(RepoError) as exc:
        notes["create"](wid, "   ", "body")
    assert exc.value.code == "invalid_title"


def test_create_unknown_workspace_raises(db):
    notes = make_workspace_notes_repo(db)
    with pytest.raises(RepoError) as exc:
        notes["create"]("missing-ws", "title", "body")
    assert exc.value.code == "not_found"


def test_create_plain_note_type(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "Plain", "body", "plain")
    assert note["noteType"] == "plain"


def test_create_invalid_note_type_rejected_by_check(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    with pytest.raises(sqlite3.IntegrityError):
        notes["create"](wid, "Bad", "body", "html")


def test_list_returns_notes_for_workspace_only(db):
    ws = make_workspaces_repo(db)
    wid_a = ws["create"]("A")["id"]
    wid_b = ws["create"]("B")["id"]
    notes = make_workspace_notes_repo(db)
    notes["create"](wid_a, "A1", "a1")
    notes["create"](wid_b, "B1", "b1")
    notes["create"](wid_a, "A2", "a2")
    titles_a = [n["title"] for n in notes["list"](wid_a)]
    titles_b = [n["title"] for n in notes["list"](wid_b)]
    assert sorted(titles_a) == ["A1", "A2"]
    assert titles_b == ["B1"]


def test_list_orders_by_updatedAt_desc(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    first = notes["create"](wid, "First", "1")
    second = notes["create"](wid, "Second", "2")
    db.execute(
        f"UPDATE workspace_notes SET updatedAt = {first['createdAt'] + 1000} "
        f"WHERE id = '{first['id']}'"
    )
    titles = [n["title"] for n in notes["list"](wid)]
    assert titles == ["First", "Second"]


def test_get_returns_existing(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Note", "body", "plain")
    got = notes["get"](created["id"])
    assert got is not None
    assert got["id"] == created["id"]
    assert got["noteType"] == "plain"


def test_get_missing_returns_none(db):
    notes = make_workspace_notes_repo(db)
    assert notes["get"]("nonexistent") is None


def test_update_changes_title_and_content(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Old", "old body")
    updated = notes["update"](created["id"], {"title": "New", "contentMd": "new body"})
    assert updated["title"] == "New"
    assert updated["contentMd"] == "new body"
    assert updated["id"] == created["id"]
    assert updated["updatedAt"] >= created["updatedAt"]


def test_update_strips_title(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Old", "body")
    updated = notes["update"](created["id"], {"title": "  Trimmed  "})
    assert updated["title"] == "Trimmed"


def test_update_empty_title_raises(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Old", "body")
    with pytest.raises(RepoError) as exc:
        notes["update"](created["id"], {"title": "   "})
    assert exc.value.code == "invalid_title"


def test_update_partial_unchanged_fields_preserved(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Title", "content", "plain")
    updated = notes["update"](created["id"], {"title": "New Title"})
    assert updated["contentMd"] == "content"
    assert updated["noteType"] == "plain"


def test_update_preserves_note_type(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Title", "content", "plain")
    updated = notes["update"](created["id"], {"contentMd": "new content"})
    assert updated["noteType"] == "plain"


def test_update_changes_and_validates_color(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Title", "content", "plain")
    updated = notes["update"](created["id"], {"color": "sky"})
    assert updated["color"] == "sky"
    with pytest.raises(sqlite3.IntegrityError):
        notes["update"](created["id"], {"color": "neon"})


def test_update_missing_raises(db):
    notes = make_workspace_notes_repo(db)
    with pytest.raises(RepoError) as exc:
        notes["update"]("missing", {"title": "x"})
    assert exc.value.code == "not_found"


def test_delete_removes_note(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    created = notes["create"](wid, "Note", "body")
    notes["delete"](created["id"])
    assert notes["get"](created["id"]) is None
    assert notes["list"](wid) == []


def test_delete_missing_raises(db):
    notes = make_workspace_notes_repo(db)
    with pytest.raises(RepoError) as exc:
        notes["delete"]("missing")
    assert exc.value.code == "not_found"


def test_create_bumps_workspace_updatedAt(db):
    ws = make_workspaces_repo(db)
    wid = ws["create"]("Research")["id"]
    before = ws["get"](wid)["updatedAt"]
    notes = make_workspace_notes_repo(db)
    notes["create"](wid, "Note", "body")
    after = ws["get"](wid)["updatedAt"]
    assert after >= before


def test_delete_cascades_when_workspace_removed(db):
    ws = make_workspaces_repo(db)
    wid = ws["create"]("Research")["id"]
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "Note", "body")

    ws["delete"](wid)

    assert db.execute(
        "SELECT COUNT(*) FROM workspace_notes WHERE workspaceId = ?", [wid]
    ).fetchone()[0] == 0
    assert notes["get"](note["id"]) is None


def test_foreign_key_cascade_direct(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "Note", "body")

    db.execute("DELETE FROM workspaces WHERE id = ?", [wid])

    assert db.execute(
        "SELECT COUNT(*) FROM workspace_notes WHERE id = ?", [note["id"]]
    ).fetchone()[0] == 0


def test_field_contract_matches_workspace_note_type(db):
    wid = _make_workspace(db)
    notes = make_workspace_notes_repo(db)
    note = notes["create"](wid, "Note", "body", "plain")
    assert set(note.keys()) == {
        "id",
        "workspaceId",
        "noteType",
        "color",
        "title",
        "contentMd",
        "createdAt",
        "updatedAt",
    }


def test_create_repositories_includes_workspace_notes(db):
    from refora_server.repositories import create_repositories

    repos = create_repositories(db)
    assert "workspaceNotes" in repos
    assert callable(repos["workspaceNotes"]["list"])
    assert callable(repos["workspaceNotes"]["create"])
    assert callable(repos["workspaceNotes"]["update"])
    assert callable(repos["workspaceNotes"]["delete"])
    assert callable(repos["workspaceNotes"]["get"])
