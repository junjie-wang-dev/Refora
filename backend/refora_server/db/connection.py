from __future__ import annotations

import sqlite3

from .migrations import MigrationResult, SqliteLike, run_migrations

_active_search_mode: str = "trigram"


class _SqliteAdapter:
    __slots__ = ("_db",)

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def exec(self, sql: str) -> None:
        self._db.execute(sql)

    def exec_script(self, sql: str) -> None:
        self._db.executescript(sql)

    def get_user_version(self) -> int:
        row = self._db.execute("PRAGMA user_version").fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    def set_user_version(self, version: int) -> None:
        self._db.execute(f"PRAGMA user_version = {int(version)}")

    def has_column(self, table: str, column: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM pragma_table_info(?) WHERE name = ?", (table, column)
        ).fetchone()
        return row is not None

    def has_object(self, type: str, name: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?", (type, name)
        ).fetchone()
        return row is not None


def open_database(db_path: str) -> tuple[sqlite3.Connection, MigrationResult]:
    global _active_search_mode
    db = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        result = run_migrations(_SqliteAdapter(db))
        _active_search_mode = result.search_mode
        return db, result
    except Exception:
        db.close()
        raise


def close_database(db: sqlite3.Connection) -> None:
    db.close()


def get_search_mode() -> str:
    return _active_search_mode
