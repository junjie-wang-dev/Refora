from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from refora_server.agent.engine_schema import (
    INTERRUPT_STATUS_PENDING,
    INTERRUPT_STATUS_RESOLVED,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _parse_json(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str):
        return fallback
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return fallback


def _map_interrupt(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "runId": row["runId"],
        "threadId": row["threadId"],
        "checkpointId": row["checkpointId"] if row["checkpointId"] is not None else None,
        "actions": _parse_json(row["payload"], []),
        "status": row["status"],
        "decision": _parse_json(row["decision"], None),
        "createdAt": row["createdAt"],
        "resolvedAt": row["resolvedAt"] if row["resolvedAt"] is not None else None,
    }


def createAgentInterruptsRepository(db):
    def _fetch(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM agent_interrupts WHERE id = ?", [id])
        return cur.fetchone()

    def create(input: dict[str, Any]) -> dict[str, Any]:
        id = _new_id()
        now = _now_ms()
        db.execute(
            "INSERT INTO agent_interrupts "
            "(id, runId, threadId, checkpointId, payload, status, decision, createdAt, resolvedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)",
            [
                id,
                input["runId"],
                input["threadId"],
                input.get("checkpointId"),
                json.dumps(input["actions"]),
                INTERRUPT_STATUS_PENDING,
                now,
            ],
        )
        row = _fetch(id)
        assert row is not None
        return _map_interrupt(row)

    def get(id: str) -> dict[str, Any] | None:
        row = _fetch(id)
        if row is None:
            return None
        return _map_interrupt(row)

    def getPendingByRun(runId: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM agent_interrupts "
            "WHERE runId = ? AND status = ? "
            "ORDER BY createdAt DESC LIMIT 1",
            [runId, INTERRUPT_STATUS_PENDING],
        )
        row = cur.fetchone()
        if row is None:
            return None
        return _map_interrupt(row)

    def resolve(id: str, decisions: list[Any]) -> dict[str, Any] | None:
        db.execute(
            "UPDATE agent_interrupts "
            "SET status = ?, decision = ?, resolvedAt = ? "
            "WHERE id = ? AND status = ?",
            [INTERRUPT_STATUS_RESOLVED, json.dumps(decisions), _now_ms(), id, INTERRUPT_STATUS_PENDING],
        )
        row = _fetch(id)
        if row is None:
            return None
        return _map_interrupt(row)

    return {
        "create": create,
        "get": get,
        "getPendingByRun": getPendingByRun,
        "resolve": resolve,
    }