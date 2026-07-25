from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

import pytest

settings_mod = importlib.import_module("refora_server.repositories.settings")
SettingsRepository = settings_mod.SettingsRepository

seed_mod = importlib.import_module("refora_server.db.settings_seed")
DEFAULT_LIBRARY_FOLDER = seed_mod.DEFAULT_LIBRARY_FOLDER
SETTING_KEYS = seed_mod.SETTING_KEYS
default_settings = seed_mod.default_settings
seed_default_settings = seed_mod.seed_default_settings

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "main"
    / "db"
    / "schema.sql"
)


@pytest.fixture()
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


@pytest.fixture()
def repo(db: sqlite3.Connection) -> SettingsRepository:
    return SettingsRepository(db)


def test_get_returns_default_when_missing(repo: SettingsRepository) -> None:
    assert repo.get("nonexistent") is None
    assert repo.get("nonexistent", "fallback") == "fallback"


def test_set_and_get_roundtrip(repo: SettingsRepository, db: sqlite3.Connection) -> None:
    repo.set("libraryFolderPath", "/Users/test/Library")
    db.commit()
    assert repo.get("libraryFolderPath") == "/Users/test/Library"

    repo.set("libraryFolderPath", "/Users/other/Library")
    db.commit()
    assert repo.get("libraryFolderPath") == "/Users/other/Library"


def test_set_stores_raw_string_without_extra_serialization(
    repo: SettingsRepository, db: sqlite3.Connection
) -> None:
    json_value = json.dumps({"a": 1, "b": [2, 3]})
    repo.set("libraryDuplicateFileCache", json_value)
    db.commit()
    raw = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("libraryDuplicateFileCache",)
    ).fetchone()[0]
    assert raw == json_value
    assert repo.get("libraryDuplicateFileCache") == json_value


def test_delete_removes_key(repo: SettingsRepository, db: sqlite3.Connection) -> None:
    repo.set("theme", "light")
    db.commit()
    assert repo.get("theme") == "light"

    repo.delete("theme")
    db.commit()
    assert repo.get("theme") is None


def test_delete_missing_key_is_noop(repo: SettingsRepository, db: sqlite3.Connection) -> None:
    repo.delete("never_existed")
    db.commit()
    assert repo.get("never_existed") is None


def test_list_returns_all_keys_sorted(repo: SettingsRepository, db: sqlite3.Connection) -> None:
    repo.set("zebra", "1")
    repo.set("alpha", "2")
    repo.set("mango", "3")
    db.commit()
    result = repo.list()
    assert [k for k, _ in result] == ["alpha", "mango", "zebra"]
    assert dict(result) == {"alpha": "2", "mango": "3", "zebra": "1"}


def test_list_empty_when_no_rows(repo: SettingsRepository) -> None:
    assert repo.list() == []


def test_seed_inserts_all_default_keys(
    db: sqlite3.Connection, repo: SettingsRepository
) -> None:
    seed_default_settings(db, "en")
    db.commit()
    keys = {k for k, _ in repo.list()}
    for key in SETTING_KEYS:
        assert key in keys


def test_seed_stores_json_encoded_values(db: sqlite3.Connection) -> None:
    seed_default_settings(db, "en")
    db.commit()
    row = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("language",)
    ).fetchone()
    assert row[0] == json.dumps("en")

    theme = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("theme",)
    ).fetchone()[0]
    assert theme == json.dumps("dark")

    width = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("sidebarWidth",)
    ).fetchone()[0]
    assert width == json.dumps(224)

    bounds = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("windowBounds",)
    ).fetchone()[0]
    assert bounds == json.dumps(None)


def test_seed_language_zh_and_en(db: sqlite3.Connection) -> None:
    seed_default_settings(db, "zh")
    db.commit()
    row = db.execute(
        "SELECT value FROM settings WHERE key = ?", ("language",)
    ).fetchone()
    assert row[0] == json.dumps("zh")


def test_seed_is_idempotent(db: sqlite3.Connection, repo: SettingsRepository) -> None:
    seed_default_settings(db, "en")
    db.commit()
    after_first = sorted(repo.list())

    seed_default_settings(db, "en")
    db.commit()
    after_second = sorted(repo.list())

    assert after_first == after_second


def test_seed_preserves_user_overrides(
    db: sqlite3.Connection, repo: SettingsRepository
) -> None:
    seed_default_settings(db, "en")
    db.commit()
    assert repo.get("language") == json.dumps("en")

    repo.set("language", json.dumps("zh"))
    db.commit()

    seed_default_settings(db, "en")
    db.commit()

    assert repo.get("language") == json.dumps("zh")


def test_seed_does_not_overwrite_existing_values(
    db: sqlite3.Connection, repo: SettingsRepository
) -> None:
    repo.set("libraryFolderPath", json.dumps("/custom/path"))
    db.commit()

    seed_default_settings(db, "en")
    db.commit()

    assert repo.get("libraryFolderPath") == json.dumps("/custom/path")


def test_default_settings_matches_ts_defaults() -> None:
    entries = dict(default_settings("en"))
    assert entries["libraryFolderPath"] == ""
    assert entries["theme"] == "dark"
    assert entries["sidebarCollapsed"] == "0"
    assert entries["lastWatchScanAt"] == 0
    assert entries["language"] == "en"
    assert entries["proxyUrl"] == ""
    assert entries["windowBounds"] is None
    assert entries["listColumnState"] is None
    assert entries["activeProviderId"] == ""
    assert entries["chatRecentModels"] == "[]"
    assert entries["chatDeepThinking"] is False
    assert entries["workspaceChatHeight"] == 280
    assert entries["workspaceChatWidth"] == 380
    assert entries["sidebarWidth"] == 224
    assert entries["detailWidth"] == 384
    assert entries["workspaceWidth"] == 480
    assert entries["documentListCompactWidth"] == 320
    assert DEFAULT_LIBRARY_FOLDER == ""
    assert len(entries) == len(SETTING_KEYS)
