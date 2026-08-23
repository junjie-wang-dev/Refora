from __future__ import annotations

import sqlite3
import threading

try:
    import fcntl
except ImportError:
    fcntl = None

from .migrations import MigrationResult, SqliteLike, run_migrations

_active_search_mode: str = "trigram"

_MIGRATION_THREAD_LOCK = threading.Lock()


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

    def execute(self, sql: str, params: list[object]) -> None:
        self._db.execute(sql, params)

    def fetchall(self, sql: str, params: list[object]) -> list[sqlite3.Row]:
        return list(self._db.execute(sql, params).fetchall())


def _migration_lock(db_path: str):
    if fcntl is None or db_path == ":memory:" or "file::memory:" in db_path:
        from contextlib import nullcontext

        return nullcontext()
    return open(f"{db_path}.migration.lock", "a+")


def open_database(db_path: str) -> tuple[sqlite3.Connection, MigrationResult]:
    global _active_search_mode
    db = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        with _MIGRATION_THREAD_LOCK, _migration_lock(db_path) as lock_file:
            if lock_file is not None and fcntl is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    result = run_migrations(_SqliteAdapter(db))
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            else:
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
