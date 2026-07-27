import pytest

from conftest import make_workspace_canvas_repo, make_workspaces_repo, open_migrated_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def repo(db):
    return make_workspace_canvas_repo(db)


def _seed_workspace(db, name="Research"):
    ws = make_workspaces_repo(db)
    return ws["create"](name)


def test_get_missing_returns_default_viewport_when_no_row(db, repo):
    workspace = _seed_workspace(db)
    canvas = repo["get"](workspace["id"])
    assert canvas == {
        "workspaceId": workspace["id"],
        "panX": 0.0,
        "panY": 0.0,
        "zoom": 1.0,
        "updatedAt": 0,
    }


def test_get_missing_workspace_raises_not_found(db, repo):
    with pytest.raises(RepoError) as exc:
        repo["get"]("nonexistent-workspace")
    assert exc.value.code == "not_found"


def test_update_creates_new_canvas(db, repo):
    workspace = _seed_workspace(db)
    canvas = repo["update"](workspace["id"], 10.5, -20.0, 1.5)
    assert canvas["workspaceId"] == workspace["id"]
    assert canvas["panX"] == 10.5
    assert canvas["panY"] == -20.0
    assert canvas["zoom"] == 1.5
    assert canvas["updatedAt"] > 0


def test_update_returns_stored_row(db, repo):
    workspace = _seed_workspace(db)
    repo["update"](workspace["id"], 1.0, 2.0, 1.0)
    fetched = repo["get"](workspace["id"])
    assert fetched is not None
    assert fetched["panX"] == 1.0
    assert fetched["panY"] == 2.0
    assert fetched["zoom"] == 1.0
    assert fetched["workspaceId"] == workspace["id"]


def test_update_overwrites_existing_same_workspace(db, repo):
    workspace = _seed_workspace(db)
    first = repo["update"](workspace["id"], 5.0, 5.0, 1.0)
    second = repo["update"](workspace["id"], 99.0, -99.0, 2.0)
    assert second["panX"] == 99.0
    assert second["panY"] == -99.0
    assert second["zoom"] == 2.0
    assert second["updatedAt"] >= first["updatedAt"]
    cur = db.execute(
        "SELECT count(*) AS c FROM workspace_canvas_state WHERE workspaceId = ?",
        [workspace["id"]],
    ).fetchone()
    assert cur["c"] == 1
    assert repo["get"](workspace["id"]) == second


def test_update_bumps_workspace_updatedAt(db, repo):
    workspace = _seed_workspace(db)
    original_updated = workspace["updatedAt"]
    repo["update"](workspace["id"], 0.0, 0.0, 1.0)
    cur = db.execute(
        "SELECT updatedAt FROM workspaces WHERE id = ?", [workspace["id"]]
    ).fetchone()
    assert cur["updatedAt"] >= original_updated


def test_update_zoom_at_min_boundary_allowed(db, repo):
    workspace = _seed_workspace(db)
    canvas = repo["update"](workspace["id"], 0.0, 0.0, 0.25)
    assert canvas["zoom"] == 0.25


def test_update_zoom_at_max_boundary_allowed(db, repo):
    workspace = _seed_workspace(db)
    canvas = repo["update"](workspace["id"], 0.0, 0.0, 2.5)
    assert canvas["zoom"] == 2.5


def test_update_zoom_below_min_rejected(db, repo):
    workspace = _seed_workspace(db)
    with pytest.raises(RepoError) as exc:
        repo["update"](workspace["id"], 0.0, 0.0, 0.24)
    assert exc.value.code == "invalid_viewport"
    assert repo["get"](workspace["id"]) == {
        "workspaceId": workspace["id"],
        "panX": 0.0,
        "panY": 0.0,
        "zoom": 1.0,
        "updatedAt": 0,
    }


def test_update_zoom_above_max_rejected(db, repo):
    workspace = _seed_workspace(db)
    with pytest.raises(RepoError) as exc:
        repo["update"](workspace["id"], 0.0, 0.0, 2.51)
    assert exc.value.code == "invalid_viewport"
    assert repo["get"](workspace["id"]) == {
        "workspaceId": workspace["id"],
        "panX": 0.0,
        "panY": 0.0,
        "zoom": 1.0,
        "updatedAt": 0,
    }


def test_update_missing_workspace_raises_not_found(db, repo):
    with pytest.raises(RepoError) as exc:
        repo["update"]("nonexistent-workspace", 0.0, 0.0, 1.0)
    assert exc.value.code == "not_found"


def test_canvas_is_isolated_per_workspace(db, repo):
    a = _seed_workspace(db, "A")
    b = _seed_workspace(db, "B")
    repo["update"](a["id"], 1.0, 2.0, 0.5)
    repo["update"](b["id"], 3.0, 4.0, 1.5)
    canvas_a = repo["get"](a["id"])
    canvas_b = repo["get"](b["id"])
    assert canvas_a["panX"] == 1.0
    assert canvas_a["zoom"] == 0.5
    assert canvas_b["panX"] == 3.0
    assert canvas_b["zoom"] == 1.5


def test_cascade_delete_workspace_removes_canvas(db, repo):
    workspace = _seed_workspace(db)
    repo["update"](workspace["id"], 7.0, 8.0, 1.0)
    assert repo["get"](workspace["id"]) is not None
    make_workspaces_repo(db)["delete"](workspace["id"])
    cur = db.execute(
        "SELECT count(*) AS c FROM workspace_canvas_state WHERE workspaceId = ?",
        [workspace["id"]],
    ).fetchone()
    assert cur["c"] == 0
    with pytest.raises(RepoError) as exc:
        repo["get"](workspace["id"])
    assert exc.value.code == "not_found"


def test_cascade_delete_workspace_does_not_touch_other_canvas(db, repo):
    a = _seed_workspace(db, "A")
    b = _seed_workspace(db, "B")
    repo["update"](a["id"], 1.0, 2.0, 0.5)
    repo["update"](b["id"], 3.0, 4.0, 1.5)
    make_workspaces_repo(db)["delete"](a["id"])
    cur = db.execute(
        "SELECT count(*) AS c FROM workspace_canvas_state WHERE workspaceId = ?",
        [a["id"]],
    ).fetchone()
    assert cur["c"] == 0
    assert repo["get"](b["id"]) is not None
    assert repo["get"](b["id"])["zoom"] == 1.5
