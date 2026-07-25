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


def _map_thread(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "providerId": row["providerId"],
        "createdAt": row["createdAt"],
        "title": row["title"],
        "headCheckpointId": row["headCheckpointId"],
        "agentStateVersion": row["agentStateVersion"] if row["agentStateVersion"] is not None else 0,
    }


def _map_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "threadId": row["threadId"],
        "role": row["role"],
        "content": row["content"],
        "createdAt": row["createdAt"],
    }


def createChatRepository(db):
    def _fetch_thread(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM chat_threads WHERE id = ?", [id])
        return cur.fetchone()

    def createThread(workspaceId: str | None, providerId: str) -> dict[str, Any]:
        id = _new_id()
        now = _now_ms()
        db.execute(
            "INSERT INTO chat_threads (id, workspaceId, providerId, createdAt) VALUES (?, ?, ?, ?)",
            [id, workspaceId, providerId, now],
        )
        row = _fetch_thread(id)
        assert row is not None
        return _map_thread(row)

    def listThreads(workspaceId: str | None) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM chat_threads WHERE workspaceId IS ? ORDER BY createdAt DESC",
            [workspaceId],
        )
        rows = cur.fetchall()
        return [_map_thread(r) for r in rows]

    def getThread(id: str) -> dict[str, Any] | None:
        row = _fetch_thread(id)
        if row is None:
            return None
        return _map_thread(row)

    def addMessage(threadId: str, role: str, content: str) -> dict[str, Any]:
        id = _new_id()
        now = _now_ms()
        db.execute(
            "INSERT INTO chat_messages (id, threadId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
            [id, threadId, role, content, now],
        )
        cur = db.execute("SELECT * FROM chat_messages WHERE id = ?", [id])
        row = cur.fetchone()
        assert row is not None
        return _map_message(row)

    def listMessages(threadId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM chat_messages WHERE threadId = ? ORDER BY createdAt",
            [threadId],
        )
        rows = cur.fetchall()
        return [_map_message(r) for r in rows]

    def deleteLastExchange(threadId: str) -> int:
        cur = db.execute(
            "SELECT rowid FROM chat_messages WHERE threadId = ? AND role = 'user' "
            "ORDER BY rowid DESC LIMIT 1",
            [threadId],
        )
        row = cur.fetchone()
        if row is None:
            return 0
        rowid = row["rowid"]
        cur = db.execute(
            "DELETE FROM chat_messages WHERE threadId = ? AND rowid >= ?",
            [threadId, rowid],
        )
        return cur.rowcount

    def deleteThread(id: str) -> None:
        cur = db.execute("DELETE FROM chat_threads WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"thread not found: {id}")

    def updateTitle(threadId: str, title: str) -> dict[str, Any]:
        db.execute(
            "UPDATE chat_threads SET title = ? WHERE id = ?",
            [title, threadId],
        )
        row = _fetch_thread(threadId)
        if row is None:
            raise RepoError("not_found", f"thread not found: {threadId}")
        return _map_thread(row)

    def updateAgentState(
        threadId: str, headCheckpointId: str | None, agentStateVersion: int
    ) -> dict[str, Any]:
        db.execute(
            "UPDATE chat_threads SET headCheckpointId = ?, agentStateVersion = ? WHERE id = ?",
            [headCheckpointId, agentStateVersion, threadId],
        )
        row = _fetch_thread(threadId)
        if row is None:
            raise RepoError("not_found", f"thread not found: {threadId}")
        return _map_thread(row)

    return {
        "createThread": createThread,
        "listThreads": listThreads,
        "getThread": getThread,
        "addMessage": addMessage,
        "listMessages": listMessages,
        "deleteLastExchange": deleteLastExchange,
        "deleteThread": deleteThread,
        "updateTitle": updateTitle,
        "updateAgentState": updateAgentState,
    }
