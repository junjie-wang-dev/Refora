from __future__ import annotations

import json
import sqlite3

from refora_server.server.run import resolve_startup_paths


def test_resolve_startup_paths_migrates_legacy_library_setting(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    bootstrap = tmp_path / "refora.db"
    database = sqlite3.connect(bootstrap)
    database.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    database.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        ("libraryFolderPath", json.dumps(str(library))),
    )
    database.commit()
    database.close()

    db_path, library_folder = resolve_startup_paths(str(bootstrap), "")

    assert db_path == str(library / "refora.db")
    assert library_folder == str(library)


def test_resolve_startup_paths_keeps_explicit_library(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()

    db_path, library_folder = resolve_startup_paths(
        str(tmp_path / "refora.db"),
        str(library),
    )

    assert db_path == str(tmp_path / "refora.db")
    assert library_folder == str(library)


def test_resolve_startup_paths_ignores_missing_legacy_library(tmp_path) -> None:
    bootstrap = tmp_path / "refora.db"
    database = sqlite3.connect(bootstrap)
    database.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    database.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        ("libraryFolderPath", json.dumps(str(tmp_path / "missing"))),
    )
    database.commit()
    database.close()

    assert resolve_startup_paths(str(bootstrap), "") == (str(bootstrap), "")
