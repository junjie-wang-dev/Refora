from __future__ import annotations

import asyncio
import threading

from refora_server.db.connection import open_database
from refora_server.repositories import create_repositories


async def test_open_database_returns_named_rows_and_allows_agent_worker_access(tmp_path):
    database, _ = open_database(str(tmp_path / "refora.db"))
    try:
        database.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            ("agent-worker-test", "ok"),
        )

        def read_from_worker() -> tuple[str, str]:
            row = database.execute(
                "SELECT key, value FROM settings WHERE key = ?",
                ("agent-worker-test",),
            ).fetchone()
            return row["key"], row["value"]

        assert await asyncio.to_thread(read_from_worker) == (
            "agent-worker-test",
            "ok",
        )
    finally:
        database.close()


def test_open_database_serializes_migrations_with_lock_file(tmp_path):
    db_path = str(tmp_path / "refora.db")

    first, first_result = open_database(db_path)
    try:
        second, second_result = open_database(db_path)
    finally:
        first.close()
    try:
        assert first_result.to_version == second_result.to_version
        assert (tmp_path / "refora.db.migration.lock").exists()
    finally:
        second.close()


def test_repository_write_from_another_thread_survives_transaction_rollback(
    tmp_path,
) -> None:
    database, _ = open_database(str(tmp_path / "refora.db"))
    repos = create_repositories(database)
    transaction_started = threading.Event()
    independent_started = threading.Event()
    independent_finished = threading.Event()
    allow_rollback = threading.Event()
    transaction_finished = threading.Event()
    transaction_errors: list[BaseException] = []
    independent_errors: list[BaseException] = []

    def rollback_transaction() -> None:
        def operation() -> None:
            repos["settings"].set("rolled-back", "inside")
            transaction_started.set()
            if not allow_rollback.wait(2):
                raise TimeoutError("rollback was not released")
            raise RuntimeError("rollback")

        try:
            repos["transaction"](operation)
        except BaseException as error:
            transaction_errors.append(error)
        finally:
            transaction_finished.set()

    def independent_write() -> None:
        try:
            if not transaction_started.wait(2):
                raise TimeoutError("transaction did not start")
            independent_started.set()
            repos["settings"].set("committed", "outside")
        except BaseException as error:
            independent_errors.append(error)
        finally:
            independent_finished.set()

    transaction_thread = threading.Thread(target=rollback_transaction)
    independent_thread = threading.Thread(target=independent_write)
    transaction_thread.start()
    independent_thread.start()
    try:
        assert transaction_started.wait(2)
        assert independent_started.wait(2)
        assert not independent_finished.wait(0.1)
    finally:
        allow_rollback.set()
        transaction_thread.join(2)
        independent_thread.join(2)

    try:
        assert transaction_finished.is_set()
        assert independent_finished.is_set()
        assert len(transaction_errors) == 1
        assert isinstance(transaction_errors[0], RuntimeError)
        assert str(transaction_errors[0]) == "rollback"
        assert independent_errors == []
        assert repos["settings"].get("rolled-back") is None
        assert repos["settings"].get("committed") == "outside"
    finally:
        database.close()
