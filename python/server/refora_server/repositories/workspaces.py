from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


def _map_workspace(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


def createWorkspacesRepository(db):
    def list() -> list[dict[str, Any]]:
        cur = db.execute("SELECT * FROM workspaces ORDER BY updatedAt DESC")
        rows = cur.fetchall()
        return [_map_workspace(r) for r in rows]

    def create(name: str) -> dict[str, Any]:
        id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            [id, name, now, now],
        )
        cur = db.execute("SELECT * FROM workspaces WHERE id = ?", [id])
        row = cur.fetchone()
        return _map_workspace(row)

    def get(id: str) -> dict[str, Any] | None:
        cur = db.execute("SELECT * FROM workspaces WHERE id = ?", [id])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_workspace(row)

    def searchContent(q: str, limit: int = 10) -> list[dict[str, Any]]:
        trimmed = q.strip()
        if not trimmed:
            return []
        escaped = trimmed.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        safe_limit = max(1, min(50, int(limit)))
        rows = db.execute(
            """
            SELECT n.id, n.workspaceId, w.name AS workspaceName, 'note' AS kind,
                   n.title, n.contentMd, n.updatedAt AS matchedAt
            FROM workspace_notes n
            JOIN workspaces w ON w.id = n.workspaceId
            WHERE n.title LIKE ? ESCAPE '\\'
               OR n.contentMd LIKE ? ESCAPE '\\'
            UNION ALL
            SELECT r.id, r.workspaceId, w.name AS workspaceName, 'report' AS kind,
                   r.title, r.contentMd, r.createdAt AS matchedAt
            FROM ai_reports r
            JOIN workspaces w ON w.id = r.workspaceId
            WHERE r.title LIKE ? ESCAPE '\\'
               OR r.contentMd LIKE ? ESCAPE '\\'
            ORDER BY matchedAt DESC, 1
            LIMIT ?
            """,
            [like, like, like, like, safe_limit],
        ).fetchall()
        normalized = trimmed.lower()
        results: list[dict[str, Any]] = []
        for row in rows:
            content = (row["contentMd"] or "").strip()
            match_index = content.lower().find(normalized)
            start = 0 if match_index < 0 else max(0, match_index - 80)
            snippet = " ".join(content[start : start + 240].split())
            results.append(
                {
                    "id": row["id"],
                    "workspaceId": row["workspaceId"],
                    "workspaceName": row["workspaceName"],
                    "kind": row["kind"],
                    "title": row["title"],
                    "snippet": snippet or row["title"],
                    "matchedAt": row["matchedAt"],
                }
            )
        return results

    def rename(id: str, name: str) -> dict[str, Any]:
        now = int(time.time() * 1000)
        cur = db.execute(
            "UPDATE workspaces SET name = ?, updatedAt = ? WHERE id = ?",
            [name, now, id],
        )
        if cur.rowcount == 0:
            raise RepoError("not_found", f"workspace not found: {id}")
        return get(id)

    def remove(id: str) -> None:
        cur = db.execute("DELETE FROM workspaces WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"workspace not found: {id}")

    return {
        "list": list,
        "searchContent": searchContent,
        "create": create,
        "get": get,
        "rename": rename,
        "delete": remove,
    }
