from __future__ import annotations

import base64
import json
import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.services.chat_attachments import display_message, normalize_attachments, normalize_media


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _map_thread(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "providerId": row["providerId"],
        "agentProfileId": row["agentProfileId"],
        "createdAt": row["createdAt"],
        "title": row["title"],
        "headCheckpointId": row["headCheckpointId"],
        "agentStateVersion": row["agentStateVersion"] if row["agentStateVersion"] is not None else 0,
    }


def _map_message(row: sqlite3.Row) -> dict[str, Any]:
    message = {
        "id": row["id"],
        "threadId": row["threadId"],
        "role": row["role"],
        "content": row["content"],
        "createdAt": row["createdAt"],
    }
    keys = row.keys()
    if "displayContent" in keys and row["displayContent"] is not None:
        message["displayContent"] = row["displayContent"]
    if "attachments" in keys:
        try:
            attachments = normalize_attachments(json.loads(row["attachments"]))
        except (ValueError, TypeError):
            attachments = []
        if attachments:
            message["attachments"] = attachments
    if "activeDocumentId" in keys and (row["activeDocumentId"] is not None or row["displayContent"] is not None):
        message["activeDocumentId"] = row["activeDocumentId"]
    if "media" in keys:
        try:
            media = normalize_media(json.loads(row["media"]))
        except (ValueError, TypeError):
            media = []
        if media:
            message["media"] = media
    if "runId" in keys and row["runId"] is not None:
        message["runId"] = row["runId"]
    if "runStatus" in keys and row["runStatus"] is not None:
        message["runStatus"] = row["runStatus"]
    return message


def createChatRepository(db):
    def _fetch_thread(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM chat_threads WHERE id = ?", [id])
        return cur.fetchone()

    def createThread(
        workspaceId: str | None,
        providerId: str,
        agentProfileId: str | None = None,
    ) -> dict[str, Any]:
        id = _new_id()
        now = _now_ms()
        db.execute(
            "INSERT INTO chat_threads (id, workspaceId, providerId, agentProfileId, createdAt) VALUES (?, ?, ?, ?, ?)",
            [id, workspaceId, providerId, agentProfileId or f"api-{providerId}", now],
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

    def addMessage(
        threadId: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        id = _new_id()
        now = _now_ms()
        metadata = metadata or {}
        db.execute(
            "INSERT INTO chat_messages (id, threadId, role, content, createdAt, displayContent, attachments, activeDocumentId, media) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                id, threadId, role, content, now,
                metadata.get("displayContent"),
                json.dumps(normalize_attachments(metadata.get("attachments")), ensure_ascii=False),
                metadata.get("activeDocumentId"),
                json.dumps(normalize_media(metadata.get("media")), ensure_ascii=False),
            ],
        )
        cur = db.execute("SELECT * FROM chat_messages WHERE id = ?", [id])
        row = cur.fetchone()
        assert row is not None
        return _map_message(row)

    def listMessages(threadId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT m.*, r.id AS runId, r.status AS runStatus "
            "FROM chat_messages m "
            "LEFT JOIN agent_runs r ON r.id = ("
            "SELECT candidate.id FROM agent_runs candidate "
            "WHERE candidate.assistantMessageId = m.id "
            "ORDER BY candidate.startedAt DESC, candidate.id DESC LIMIT 1"
            ") "
            "WHERE m.threadId = ? ORDER BY m.createdAt, m.rowid",
            [threadId],
        )
        rows = cur.fetchall()
        return [_map_message(r) for r in rows]

    def listMessagesPage(
        threadId: str, before: str | None = None, limit: int = 30
    ) -> dict[str, Any]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise RepoError("validation", "History page size must be between 1 and 100")
        clause = ""
        parameters: list[Any] = [threadId]
        if before is not None:
            try:
                if not isinstance(before, str) or len(before) > 500:
                    raise ValueError()
                scope, created_at, row_id = json.loads(base64.urlsafe_b64decode(before).decode())
                if scope != threadId or any(type(value) is not int for value in (created_at, row_id)):
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise RepoError("validation", "Invalid history cursor") from None
            clause = " AND (m.createdAt < ? OR (m.createdAt = ? AND m.rowid < ?))"
            parameters.extend([created_at, created_at, row_id])
        parameters.append(limit + 1)
        rows = db.execute(
            "SELECT m.*, m.rowid AS timelineRowId, r.id AS runId, r.status AS runStatus "
            "FROM chat_messages m LEFT JOIN agent_runs r ON r.id = ("
            "SELECT candidate.id FROM agent_runs candidate "
            "WHERE candidate.assistantMessageId = m.id OR candidate.userMessageId = m.id "
            "ORDER BY candidate.startedAt DESC, candidate.rowid DESC LIMIT 1) "
            "WHERE m.threadId = ? AND m.role IN ('user', 'assistant')"
            f"{clause} ORDER BY m.createdAt DESC, m.rowid DESC LIMIT ?",
            parameters,
        ).fetchall()
        selected = rows[:limit]
        next_cursor = None
        if len(rows) > limit:
            last = selected[-1]
            next_cursor = base64.urlsafe_b64encode(json.dumps(
                [threadId, last["createdAt"], last["timelineRowId"]], separators=(",", ":")
            ).encode()).decode()
        return {
            "messages": [_map_message(row) for row in reversed(selected)],
            "nextCursor": next_cursor,
        }

    def search(q: str, limit: int = 10) -> list[dict[str, Any]]:
        trimmed = q.strip()
        if not trimmed:
            return []
        escaped = trimmed.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        safe_limit = max(1, min(50, int(limit)))
        rows = db.execute(
            """
            WITH matching_messages AS (
              SELECT m.threadId, m.role, COALESCE(m.displayContent, m.content) AS content, m.createdAt,
                     ROW_NUMBER() OVER (
                       PARTITION BY m.threadId
                       ORDER BY m.createdAt DESC, m.rowid DESC
                     ) AS matchRank
              FROM chat_messages m
              WHERE m.role IN ('user', 'assistant')
                AND COALESCE(m.displayContent, m.content) LIKE ? ESCAPE '\\'
            )
            SELECT t.id AS threadId, t.workspaceId, w.name AS workspaceName, t.title,
                   m.role, m.content, COALESCE(m.createdAt, t.createdAt) AS matchedAt
            FROM chat_threads t
            LEFT JOIN workspaces w ON w.id = t.workspaceId
            LEFT JOIN matching_messages m ON m.threadId = t.id AND m.matchRank = 1
            WHERE t.title LIKE ? ESCAPE '\\'
               OR m.threadId IS NOT NULL
            ORDER BY matchedAt DESC, t.id
            LIMIT ?
            """,
            [like, like, safe_limit],
        ).fetchall()
        normalized = trimmed.lower()
        seen: set[str] = set()
        results: list[dict[str, Any]] = []
        for row in rows:
            thread_id = row["threadId"]
            if thread_id in seen:
                continue
            seen.add(thread_id)
            content = display_message({"role": row["role"], "content": row["content"] or ""})["content"].strip()
            match_index = content.lower().find(normalized)
            start = 0 if match_index < 0 else max(0, match_index - 80)
            excerpt = content[start : start + 240].strip()
            results.append(
                {
                    "threadId": thread_id,
                    "workspaceId": row["workspaceId"],
                    "workspaceName": row["workspaceName"],
                    "title": row["title"],
                    "snippet": excerpt or (row["title"] or ""),
                    "role": row["role"] if row["role"] in {"user", "assistant"} else None,
                    "matchedAt": row["matchedAt"],
                }
            )
            if len(results) >= safe_limit:
                break
        return results

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

    def updateAgentProfile(
        threadId: str, providerId: str, agentProfileId: str
    ) -> dict[str, Any]:
        db.execute(
            "UPDATE chat_threads SET providerId = ?, agentProfileId = ? WHERE id = ?",
            [providerId, agentProfileId, threadId],
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
        "listMessagesPage": listMessagesPage,
        "search": search,
        "deleteLastExchange": deleteLastExchange,
        "deleteThread": deleteThread,
        "updateTitle": updateTitle,
        "updateAgentProfile": updateAgentProfile,
        "updateAgentState": updateAgentState,
    }
