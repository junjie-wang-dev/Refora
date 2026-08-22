from __future__ import annotations

import json
import socket
import sqlite3

import pytest

from refora_server.server.run import _bind_socket, resolve_startup_paths


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
