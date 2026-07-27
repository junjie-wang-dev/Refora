from __future__ import annotations

import asyncio

from refora_server.db.connection import open_database


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
