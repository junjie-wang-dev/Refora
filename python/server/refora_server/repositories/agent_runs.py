from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _map_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "threadId": row["threadId"],
        "providerId": row["providerId"],
        "modelId": row["modelId"],
        "status": row["status"],
        "checkpointBefore": row["checkpointBefore"],
        "checkpointAfter": row["checkpointAfter"],
        "replacesRunId": row["replacesRunId"],
        "userMessageId": row["userMessageId"],
        "assistantMessageId": row["assistantMessageId"],
        "startedAt": row["startedAt"],
        "endedAt": row["endedAt"],
        "error": row["error"],
    }


def createAgentRunsRepository(db):
    def _fetch_run(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM agent_runs WHERE id = ?", [id])
        return cur.fetchone()

    def create(input: dict[str, Any]) -> dict[str, Any]:
        id = input.get("id") or _new_id()
        db.execute(
            "INSERT INTO agent_runs "
            "(id, threadId, providerId, modelId, status, checkpointBefore, checkpointAfter, "
            "replacesRunId, userMessageId, assistantMessageId, startedAt, endedAt, error) "
            "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL)",
            [
                id,
                input["threadId"],
                input["providerId"],
                input["modelId"],
                input.get("status") or "queued",
                input.get("checkpointBefore"),
                input.get("replacesRunId"),
                input.get("userMessageId"),
                input.get("startedAt") or _now_ms(),
            ],
        )
        row = _fetch_run(id)
        assert row is not None
        return _map_run(row)

    def get(id: str) -> dict[str, Any] | None:
        row = _fetch_run(id)
        if row is None:
            return None
        return _map_run(row)

    def listByThread(threadId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM agent_runs WHERE threadId = ? ORDER BY startedAt, id",
            [threadId],
        )
        rows = cur.fetchall()
        return [_map_run(r) for r in rows]

    def update(id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        existing = get(id)
        if existing is None:
            return None
        next_state = {**existing, **patch}
        db.execute(
            "UPDATE agent_runs "
            "SET status = ?, checkpointBefore = ?, checkpointAfter = ?, userMessageId = ?, "
            "assistantMessageId = ?, endedAt = ?, error = ? WHERE id = ?",
            [
                next_state["status"],
                next_state["checkpointBefore"],
                next_state["checkpointAfter"],
                next_state["userMessageId"],
                next_state["assistantMessageId"],
                next_state["endedAt"],
                next_state["error"],
                id,
            ],
        )
        return get(id)

    def reconcileRunning(error: str, endedAt: int | None = None) -> int:
        ts = endedAt if endedAt is not None else _now_ms()
        cur = db.execute(
            "UPDATE agent_runs SET status = 'cancelled', endedAt = ?, error = ? "
            "WHERE status IN ('queued', 'running')",
            [ts, error],
        )
        return cur.rowcount

    return {
        "create": create,
        "get": get,
        "listByThread": listByThread,
        "update": update,
        "reconcileRunning": reconcileRunning,
    }