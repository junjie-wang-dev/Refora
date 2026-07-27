from __future__ import annotations

import sqlite3

import pytest

from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories.web_search_config import createWebSearchConfigRepository


@pytest.fixture()
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    run_migrations(_SqliteAdapter(conn))
    return conn


@pytest.fixture()
def repo(db: sqlite3.Connection):
    return createWebSearchConfigRepository(db)


def test_get_returns_default_ddgs_after_migration(repo) -> None:
    row = repo["get"]()
    assert row["provider"] == "ddgs"
    assert row["tavilyApiKeyEnc"] is None
    assert row["braveApiKeyEnc"] is None
    assert row["updatedAt"] == 0


def test_default_seed_row_exists_in_db(db: sqlite3.Connection) -> None:
    raw = db.execute(
        "SELECT id, provider, tavilyApiKeyEnc, braveApiKeyEnc, updatedAt "
        "FROM web_search_config WHERE id = 1"
    ).fetchone()
    assert raw["id"] == 1
    assert raw["provider"] == "ddgs"
    assert raw["tavilyApiKeyEnc"] is None
    assert raw["braveApiKeyEnc"] is None
    assert raw["updatedAt"] == 0


def test_update_provider_roundtrip(repo) -> None:
    updated = repo["update"]({"provider": "tavily"})
    assert updated["provider"] == "tavily"
    assert updated["tavilyApiKeyEnc"] is None
    assert updated["braveApiKeyEnc"] is None
    assert updated["updatedAt"] > 0
    again = repo["get"]()
    assert again["provider"] == "tavily"


def test_update_tavily_api_key_bytes_roundtrip(repo, db: sqlite3.Connection) -> None:
    key = b"\x01\x02\x03\x04secret-tavily"
    updated = repo["update"]({"tavilyApiKeyEnc": key})
    assert updated["tavilyApiKeyEnc"] == key
    assert updated["braveApiKeyEnc"] is None
    assert updated["provider"] == "ddgs"

    raw = db.execute(
        "SELECT tavilyApiKeyEnc FROM web_search_config WHERE id = 1"
    ).fetchone()
    assert bytes(raw["tavilyApiKeyEnc"]) == key


def test_update_brave_api_key_bytes_roundtrip(repo, db: sqlite3.Connection) -> None:
    key = b"\x05\x06\x07\x08secret-brave"
    updated = repo["update"]({"braveApiKeyEnc": key})
    assert updated["braveApiKeyEnc"] == key
    assert updated["tavilyApiKeyEnc"] is None

    raw = db.execute(
        "SELECT braveApiKeyEnc FROM web_search_config WHERE id = 1"
    ).fetchone()
    assert bytes(raw["braveApiKeyEnc"]) == key


def test_clear_api_key_with_none(repo) -> None:
    repo["update"]({"tavilyApiKeyEnc": b"key-data"})
    assert repo["get"]()["tavilyApiKeyEnc"] == b"key-data"
    cleared = repo["update"]({"tavilyApiKeyEnc": None})
    assert cleared["tavilyApiKeyEnc"] is None


def test_update_with_empty_patch_is_noop(repo) -> None:
    before = repo["get"]()
    after = repo["update"]({})
    assert after == before
    assert after["updatedAt"] == before["updatedAt"]


def test_update_unknown_provider_raises(repo) -> None:
    from refora_server.repositories.errors import RepoError

    with pytest.raises(RepoError) as exc:
        repo["update"]({"provider": "google"})
    assert exc.value.code == "invalid_input"


def test_update_invalid_tavily_key_type_raises(repo) -> None:
    from refora_server.repositories.errors import RepoError

    with pytest.raises(RepoError) as exc:
        repo["update"]({"tavilyApiKeyEnc": "not-bytes"})
    assert exc.value.code == "invalid_input"


def test_get_missing_row_raises() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    run_migrations(_SqliteAdapter(conn))
    conn.execute("DELETE FROM web_search_config WHERE id = 1")
    repo = createWebSearchConfigRepository(conn)
    from refora_server.repositories.errors import RepoError

    with pytest.raises(RepoError) as exc:
        repo["get"]()
    assert exc.value.code == "not_found"


def test_registered_in_repository_factory() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    run_migrations(_SqliteAdapter(conn))
    from refora_server.repositories import create_repositories

    repos = create_repositories(conn)
    assert "webSearchConfig" in repos
    assert repos["webSearchConfig"]["get"]()["provider"] == "ddgs"