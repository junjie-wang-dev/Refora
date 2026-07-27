import pytest

from conftest import open_schema_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_schema_db()
    yield db
    db.close()


def _make_repo(db):
    from refora_server.repositories.watch_folders import createWatchFoldersRepository

    return createWatchFoldersRepository(db)


def test_list_empty_returns_empty(db):
    repo = _make_repo(db)
    assert repo["list"]() == []


def test_add_returns_watch_folder_with_all_fields(db):
    repo = _make_repo(db)
    wf = repo["add"]("/lib/papers")
    assert wf["id"]
    assert wf["path"] == "/lib/papers"
    assert wf["enabled"] == 1
    assert isinstance(wf["addedAt"], int)
    assert wf["addedAt"] > 0


def test_add_duplicate_path_raises(db):
    repo = _make_repo(db)
    repo["add"]("/lib/papers")
    with pytest.raises(RepoError) as exc:
        repo["add"]("/lib/papers")
    assert exc.value.code == "duplicate"
    assert exc.value.field == "path"


def test_list_orders_by_addedAt(db):
    import time

    repo = _make_repo(db)
    a = repo["add"]("/lib/a")
    time.sleep(0.01)
    b = repo["add"]("/lib/b")
    time.sleep(0.01)
    c = repo["add"]("/lib/c")
    rows = repo["list"]()
    assert [r["id"] for r in rows] == [a["id"], b["id"], c["id"]]


def test_remove_deletes_row(db):
    repo = _make_repo(db)
    wf = repo["add"]("/lib/papers")
    repo["remove"](wf["id"])
    assert repo["list"]() == []


def test_remove_missing_raises_not_found(db):
    repo = _make_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["remove"]("missing-id")
    assert exc.value.code == "not_found"


def test_toggle_disable_returns_updated_row(db):
    repo = _make_repo(db)
    wf = repo["add"]("/lib/papers")
    assert wf["enabled"] == 1
    updated = repo["toggle"](wf["id"], False)
    assert updated["id"] == wf["id"]
    assert updated["enabled"] == 0
    rows = repo["list"]()
    assert rows[0]["enabled"] == 0


def test_toggle_enable_returns_updated_row(db):
    repo = _make_repo(db)
    wf = repo["add"]("/lib/papers")
    repo["toggle"](wf["id"], False)
    updated = repo["toggle"](wf["id"], True)
    assert updated["enabled"] == 1
    rows = repo["list"]()
    assert rows[0]["enabled"] == 1


def test_toggle_missing_raises_not_found(db):
    repo = _make_repo(db)
    with pytest.raises(RepoError) as exc:
        repo["toggle"]("missing-id", True)
    assert exc.value.code == "not_found"


def test_getEnabled_returns_only_enabled(db):
    repo = _make_repo(db)
    a = repo["add"]("/lib/a")
    b = repo["add"]("/lib/b")
    repo["toggle"](a["id"], False)
    repo["toggle"](b["id"], False)
    assert repo["getEnabled"]() == []
    repo["toggle"](a["id"], True)
    enabled = repo["getEnabled"]()
    assert [r["id"] for r in enabled] == [a["id"]]


def test_remove_only_targets_id(db):
    repo = _make_repo(db)
    a = repo["add"]("/lib/a")
    b = repo["add"]("/lib/b")
    repo["remove"](a["id"])
    rows = repo["list"]()
    assert [r["id"] for r in rows] == [b["id"]]


def test_watch_folder_mapping_matches_contract(db):
    repo = _make_repo(db)
    wf = repo["add"]("/lib/papers")
    assert set(wf.keys()) == {"id", "path", "enabled", "addedAt"}