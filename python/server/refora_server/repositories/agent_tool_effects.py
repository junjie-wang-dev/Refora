from __future__ import annotations

import sqlite3
import time
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


def _map_effect(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "runId": row["runId"],
        "toolCallId": row["toolCallId"],
        "toolName": row["toolName"],
        "workspaceId": row["workspaceId"] if row["workspaceId"] is not None else None,
        "status": row["status"],
        "result": row["result"] if row["result"] is not None else None,
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


def createAgentToolEffectsRepository(db):
    def get(runId: str, toolCallId: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM agent_tool_effects WHERE runId = ? AND toolCallId = ?",
            [runId, toolCallId],
        )
        row = cur.fetchone()
        if row is None:
            return None
        return _map_effect(row)

    def begin(input: dict[str, Any]) -> dict[str, Any]:
        existing = get(input["runId"], input["toolCallId"])
        if existing is not None:
            return existing
        now = _now_ms()
        db.execute(
            "INSERT INTO agent_tool_effects "
            "(runId, toolCallId, toolName, workspaceId, status, result, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
            [
                input["runId"],
                input["toolCallId"],
                input["toolName"],
                input.get("workspaceId"),
                now,
                now,
            ],
        )
        row = db.execute(
            "SELECT * FROM agent_tool_effects WHERE runId = ? AND toolCallId = ?",
            [input["runId"], input["toolCallId"]],
        ).fetchone()
        assert row is not None
        return _map_effect(row)

    def finish(
        runId: str,
        toolCallId: str,
        status: str,
        result: str,
    ) -> dict[str, Any] | None:
        db.execute(
            "UPDATE agent_tool_effects SET status = ?, result = ?, updatedAt = ? "
            "WHERE runId = ? AND toolCallId = ?",
            [status, result, _now_ms(), runId, toolCallId],
        )
        return get(runId, toolCallId)

    return {"get": get, "begin": begin, "finish": finish}
