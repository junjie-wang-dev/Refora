from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _map_memory(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "scope": row["scope"],
        "scopeId": row["scopeId"],
        "workspaceId": row["workspaceId"] if row["workspaceId"] is not None else None,
        "path": row["path"],
        "content": row["content"],
        "revision": row["revision"],
        "sourceThreadId": row["sourceThreadId"] if row["sourceThreadId"] is not None else None,
        "sourceRunId": row["sourceRunId"] if row["sourceRunId"] is not None else None,
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


def _map_revision(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "memoryId": row["memoryId"],
        "revision": row["revision"],
        "content": row["content"],
        "sourceThreadId": row["sourceThreadId"] if row["sourceThreadId"] is not None else None,
        "sourceRunId": row["sourceRunId"] if row["sourceRunId"] is not None else None,
        "createdAt": row["createdAt"],
    }


def createAgentMemoriesRepository(db):
    def list(scope: str, scopeId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM workspace_agent_memories WHERE scope = ? AND scopeId = ? ORDER BY path",
            [scope, scopeId],
        )
        return [_map_memory(r) for r in cur.fetchall()]

    def get(scope: str, scopeId: str, path: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM workspace_agent_memories WHERE scope = ? AND scopeId = ? AND path = ?",
            [scope, scopeId, path],
        )
        row = cur.fetchone()
        return _map_memory(row) if row is not None else None

    def _fetch_by_id(id: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM workspace_agent_memories WHERE id = ?", [id]
        )
        row = cur.fetchone()
        return _map_memory(row) if row is not None else None

    def upsert(input: dict[str, Any]) -> dict[str, Any]:
        scope = input["scope"]
        scopeId = input["scopeId"]
        workspaceId = input.get("workspaceId")
        path = input["path"]
        content = input["content"]
        sourceThreadId = input.get("sourceThreadId")
        sourceRunId = input.get("sourceRunId")

        existing = get(scope, scopeId, path)
        now = _now_ms()
        if existing is not None:
            revision = existing["revision"] + 1
            db.execute(
                "UPDATE workspace_agent_memories "
                "SET content = ?, revision = ?, sourceThreadId = ?, sourceRunId = ?, updatedAt = ? "
                "WHERE id = ?",
                [content, revision, sourceThreadId, sourceRunId, now, existing["id"]],
            )
            db.execute(
                "INSERT INTO workspace_agent_memory_revisions "
                "(id, memoryId, revision, content, sourceThreadId, sourceRunId, createdAt) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                [_new_id(), existing["id"], revision, content, sourceThreadId, sourceRunId, now],
            )
            return get(scope, scopeId, path)

        id = _new_id()
        db.execute(
            "INSERT INTO workspace_agent_memories "
            "(id, scope, scopeId, workspaceId, path, content, revision, sourceThreadId, sourceRunId, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
            [id, scope, scopeId, workspaceId, path, content, sourceThreadId, sourceRunId, now, now],
        )
        db.execute(
            "INSERT INTO workspace_agent_memory_revisions "
            "(id, memoryId, revision, content, sourceThreadId, sourceRunId, createdAt) "
            "VALUES (?, ?, 1, ?, ?, ?, ?)",
            [_new_id(), id, content, sourceThreadId, sourceRunId, now],
        )
        return get(scope, scopeId, path)

    def remove(scope: str, scopeId: str, path: str) -> int:
        cur = db.execute(
            "DELETE FROM workspace_agent_memories WHERE scope = ? AND scopeId = ? AND path = ?",
            [scope, scopeId, path],
        )
        return cur.rowcount

    def listRevisions(memoryId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM workspace_agent_memory_revisions WHERE memoryId = ? ORDER BY revision DESC",
            [memoryId],
        )
        return [_map_revision(r) for r in cur.fetchall()]

    return {
        "list": list,
        "get": get,
        "upsert": upsert,
        "remove": remove,
        "listRevisions": listRevisions,
    }