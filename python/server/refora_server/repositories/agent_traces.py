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


_UNSET = object()


def _map_step(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "threadId": row["threadId"],
        "runId": row["runId"],
        "kind": row["kind"],
        "name": row["name"],
        "input": row["input"],
        "output": row["output"],
        "status": row["status"],
        "startedAt": row["startedAt"],
        "endedAt": row["endedAt"],
        "seq": row["seq"],
        "inputTokens": row["inputTokens"],
        "outputTokens": row["outputTokens"],
        "totalTokens": row["totalTokens"],
        "parentStepId": row["parentStepId"],
        "agentName": row["agentName"],
        "namespace": row["namespace"],
        "depth": row["depth"] if row["depth"] is not None else 0,
        "checkpointId": row["checkpointId"],
    }


def createAgentTracesRepository(db):
    def _fetch_step(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM agent_trace_steps WHERE id = ?", [id])
        return cur.fetchone()

    def addStep(input: dict[str, Any]) -> dict[str, Any]:
        id = input.get("id") or _new_id()
        db.execute(
            "INSERT INTO agent_trace_steps "
            "(id, threadId, runId, kind, name, input, output, status, startedAt, endedAt, seq, "
            "inputTokens, outputTokens, totalTokens, parentStepId, agentName, namespace, depth, checkpointId) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                id,
                input["threadId"],
                input["runId"],
                input["kind"],
                input.get("name"),
                input.get("input"),
                input.get("output"),
                input["status"],
                input["startedAt"],
                input.get("endedAt"),
                input["seq"],
                input.get("inputTokens"),
                input.get("outputTokens"),
                input.get("totalTokens"),
                input.get("parentStepId"),
                input.get("agentName"),
                input.get("namespace"),
                input.get("depth") or 0,
                input.get("checkpointId"),
            ],
        )
        row = _fetch_step(id)
        assert row is not None
        return _map_step(row)

    def updateStep(id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        existing = _fetch_step(id)
        if existing is None:
            return None

        trace_input = patch.get("input", _UNSET)
        trace_input = existing["input"] if trace_input is _UNSET else trace_input

        output = patch.get("output", _UNSET)
        output = existing["output"] if output is _UNSET else output

        status = patch.get("status", _UNSET)
        status = existing["status"] if status is _UNSET or status is None else status

        endedAt = patch.get("endedAt", _UNSET)
        endedAt = existing["endedAt"] if endedAt is _UNSET else endedAt

        sets = ["input = ?", "output = ?", "status = ?", "endedAt = ?"]
        params: list[Any] = [trace_input, output, status, endedAt]

        for col in ("inputTokens", "outputTokens", "totalTokens"):
            value = patch.get(col, _UNSET)
            if value is not _UNSET:
                sets.append(f"{col} = ?")
                params.append(value)

        params.append(id)
        db.execute(
            f"UPDATE agent_trace_steps SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        row = _fetch_step(id)
        assert row is not None
        return _map_step(row)

    def listByThread(threadId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM agent_trace_steps WHERE threadId = ? ORDER BY startedAt ASC, seq ASC",
            [threadId],
        )
        rows = cur.fetchall()
        return [_map_step(r) for r in rows]

    def listByRun(runId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM agent_trace_steps WHERE runId = ? ORDER BY seq ASC",
            [runId],
        )
        rows = cur.fetchall()
        return [_map_step(r) for r in rows]

    def deleteByThread(threadId: str) -> int:
        cur = db.execute(
            "DELETE FROM agent_trace_steps WHERE threadId = ?", [threadId]
        )
        return cur.rowcount

    def deleteByRun(threadId: str, runId: str) -> int:
        cur = db.execute(
            "DELETE FROM agent_trace_steps WHERE threadId = ? AND runId = ?",
            [threadId, runId],
        )
        return cur.rowcount

    def deleteOlderThan(timestamp: int) -> int:
        cur = db.execute(
            "DELETE FROM agent_trace_steps WHERE startedAt < ?", [timestamp]
        )
        return cur.rowcount

    def reconcileRunning(output: str, endedAt: int | None = None) -> int:
        ts = endedAt if endedAt is not None else _now_ms()
        cur = db.execute(
            "UPDATE agent_trace_steps "
            "SET status = 'cancelled', output = COALESCE(output, ?), endedAt = ? "
            "WHERE status = 'running'",
            [output, ts],
        )
        return cur.rowcount

    return {
        "addStep": addStep,
        "updateStep": updateStep,
        "listByThread": listByThread,
        "listByRun": listByRun,
        "deleteByThread": deleteByThread,
        "deleteByRun": deleteByRun,
        "deleteOlderThan": deleteOlderThan,
        "reconcileRunning": reconcileRunning,
    }
