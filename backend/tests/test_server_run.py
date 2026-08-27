from __future__ import annotations

import json
import socket
import sqlite3
import threading

import pytest

from refora_server.server import run as server_run
from refora_server.server.run import _bind_socket, resolve_startup_paths


def test_resolve_startup_paths_keeps_database_local_when_library_setting_exists(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    bootstrap = tmp_path / "refora.db"
    database = sqlite3.connect(bootstrap)
    database.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    database.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        ("libraryFolderPath", json.dumps(str(library))),
    )
    database.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
    database.execute("INSERT INTO sentinel(value) VALUES ('preserved')")
    database.commit()
    database.close()

    db_path, library_folder = resolve_startup_paths(str(bootstrap), "")

    assert db_path == str(bootstrap)
    assert library_folder == str(library)
    assert bootstrap.is_file()
    migrated = sqlite3.connect(bootstrap)
    try:
        assert migrated.execute("SELECT value FROM sentinel").fetchone() == ("preserved",)
    finally:
        migrated.close()


def test_resolve_startup_paths_ignores_a_cloud_database_with_the_same_name(tmp_path) -> None:
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
    destination = library / "refora.db"
    existing = sqlite3.connect(destination)
    existing.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
    existing.execute("INSERT INTO sentinel(value) VALUES ('existing')")
    existing.commit()
    existing.close()

    assert resolve_startup_paths(str(bootstrap), "") == (str(bootstrap), str(library))
    preserved = sqlite3.connect(destination)
    try:
        assert preserved.execute("SELECT value FROM sentinel").fetchone() == ("existing",)
    finally:
        preserved.close()


def test_resolve_startup_paths_never_replaces_a_cloud_database(
    tmp_path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    bootstrap = tmp_path / "refora.db"
    source = sqlite3.connect(bootstrap)
    source.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    source.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        ("libraryFolderPath", json.dumps(str(library))),
    )
    source.execute("CREATE TABLE documents(id TEXT PRIMARY KEY, title TEXT NOT NULL)")
    source.execute("INSERT INTO documents(id, title) VALUES ('doc-1', 'Preserved')")
    source.commit()
    source.close()
    destination = library / "refora.db"
    empty = sqlite3.connect(destination)
    empty.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    empty.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)",
        ("libraryFolderPath", json.dumps(str(library))),
    )
    empty.execute(
        "CREATE TABLE web_search_config(id INTEGER PRIMARY KEY, provider TEXT NOT NULL)"
    )
    empty.execute("INSERT INTO web_search_config VALUES (1, 'disabled')")
    empty.commit()
    empty.close()

    assert resolve_startup_paths(str(bootstrap), "") == (str(bootstrap), str(library))

    migrated = sqlite3.connect(bootstrap)
    try:
        assert migrated.execute("SELECT title FROM documents").fetchone() == (
            "Preserved",
        )
    finally:
        migrated.close()


def test_resolve_startup_paths_keeps_explicit_library(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()

    db_path, library_folder = resolve_startup_paths(
        str(tmp_path / "refora.db"),
        str(library),
    )

    assert db_path == str(tmp_path / "refora.db")
    assert library_folder == str(library)


def test_resolve_startup_paths_canonicalizes_explicit_library(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(library, target_is_directory=True)

    _, library_folder = resolve_startup_paths(
        str(alias / "refora.db"),
        str(alias),
    )

    assert library_folder == str(library.resolve())


def test_bind_socket_keeps_the_selected_port_reserved() -> None:
    listener = _bind_socket("127.0.0.1", 0)
    competing = None
    try:
        port = listener.getsockname()[1]
        competing = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        with pytest.raises(OSError):
            competing.bind(("127.0.0.1", port))
    finally:
        if competing is not None:
            competing.close()
        listener.close()


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


def test_parent_watchdog_requests_shutdown_when_parent_exits(monkeypatch) -> None:
    checks = iter([True, False])
    requested = threading.Event()
    stopped = threading.Event()
    monkeypatch.setattr(
        server_run,
        "_parent_process_alive",
        lambda _pid: next(checks),
    )

    server_run._watch_parent_process(123, requested.set, stopped, 0.001)

    assert requested.is_set()
