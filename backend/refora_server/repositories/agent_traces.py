from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.agent.engine_schema import (
    TRACE_STATUS_CANCELLED,
    TRACE_STATUS_RUNNING,
)
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
            "SET status = ?, output = COALESCE(output, ?), endedAt = ? "
            "WHERE status = ?",
            [TRACE_STATUS_CANCELLED, output, ts, TRACE_STATUS_RUNNING],
        )
        return cur.rowcount

    def usageStats() -> dict[str, Any]:
        totals = db.execute(
            """
            SELECT
              COALESCE(SUM(inputTokens), 0) AS inputTokens,
              COALESCE(SUM(outputTokens), 0) AS outputTokens,
              COALESCE(SUM(COALESCE(totalTokens, COALESCE(inputTokens, 0) + COALESCE(outputTokens, 0))), 0) AS totalTokens,
              COUNT(*) AS modelCalls
            FROM agent_trace_steps
            WHERE kind = 'llm'
            """
        ).fetchone()
        conversation_count = db.execute(
            "SELECT COUNT(*) AS count FROM chat_threads"
        ).fetchone()["count"]
        turn_count = db.execute(
            "SELECT COUNT(*) AS count FROM agent_runs"
        ).fetchone()["count"]
        active_days = db.execute(
            """
            SELECT COUNT(DISTINCT date(startedAt / 1000, 'unixepoch', 'localtime')) AS count
            FROM agent_runs
            """
        ).fetchone()["count"]
        models = db.execute(
            """
            SELECT
              COALESCE(NULLIF(r.modelId, ''), 'Unknown') AS model,
              COALESCE(SUM(COALESCE(s.totalTokens, COALESCE(s.inputTokens, 0) + COALESCE(s.outputTokens, 0))), 0) AS tokens,
              COUNT(*) AS calls
            FROM agent_trace_steps s
            LEFT JOIN agent_runs r ON r.id = s.runId
            WHERE s.kind = 'llm'
            GROUP BY COALESCE(NULLIF(r.modelId, ''), 'Unknown')
            HAVING COALESCE(SUM(COALESCE(s.totalTokens, COALESCE(s.inputTokens, 0) + COALESCE(s.outputTokens, 0))), 0) > 0
            ORDER BY tokens DESC, model ASC
            """
        ).fetchall()
        activity = db.execute(
            """
            WITH run_usage AS (
              SELECT
                r.id,
                r.threadId,
                r.startedAt,
                COALESCE(SUM(COALESCE(s.totalTokens, COALESCE(s.inputTokens, 0) + COALESCE(s.outputTokens, 0))), 0) AS tokens
              FROM agent_runs r
              LEFT JOIN agent_trace_steps s ON s.runId = r.id AND s.kind = 'llm'
              GROUP BY r.id, r.threadId, r.startedAt
            )
            SELECT
              date(startedAt / 1000, 'unixepoch', 'localtime') AS date,
              SUM(tokens) AS tokens,
              COUNT(*) AS turns
            FROM run_usage
            GROUP BY date(startedAt / 1000, 'unixepoch', 'localtime')
            ORDER BY date ASC
            """
        ).fetchall()
        return {
            "totalTokens": int(totals["totalTokens"]),
            "inputTokens": int(totals["inputTokens"]),
            "outputTokens": int(totals["outputTokens"]),
            "conversationCount": int(conversation_count),
            "turnCount": int(turn_count),
            "modelCallCount": int(totals["modelCalls"]),
            "activeDays": int(active_days),
            "models": [
                {
                    "model": row["model"],
                    "tokens": int(row["tokens"]),
                    "calls": int(row["calls"]),
                }
                for row in models
            ],
            "activity": [
                {
                    "date": row["date"],
                    "tokens": int(row["tokens"]),
                    "turns": int(row["turns"]),
                }
                for row in activity
            ],
        }

    return {
        "addStep": addStep,
        "updateStep": updateStep,
        "listByThread": listByThread,
        "listByRun": listByRun,
        "deleteByThread": deleteByThread,
        "deleteByRun": deleteByRun,
        "deleteOlderThan": deleteOlderThan,
        "reconcileRunning": reconcileRunning,
        "usageStats": usageStats,
    }
