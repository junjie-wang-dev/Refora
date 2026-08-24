from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_support import require_workspace, touch_workspace


def _map_note(row: sqlite3.Row) -> dict[str, Any]:
    note_type = row["noteType"]
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "noteType": note_type if note_type is not None else "markdown",
        "color": row["color"],
        "title": row["title"],
        "contentMd": row["contentMd"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


def createWorkspaceNotesRepository(db):
    def list(workspaceId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM workspace_notes WHERE workspaceId = ? ORDER BY updatedAt DESC",
            [workspaceId],
        )
        rows = cur.fetchall()
        return [_map_note(r) for r in rows]

    def create(
        workspaceId: str,
        title: str,
        contentMd: str,
        noteType: str = "markdown",
    ) -> dict[str, Any]:
        normalized_title = title.strip()
        if not normalized_title:
            raise RepoError("invalid_title", "note title cannot be empty")
        require_workspace(db, workspaceId)
        id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO workspace_notes "
            "(id, workspaceId, noteType, title, contentMd, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [id, workspaceId, noteType, normalized_title, contentMd, now, now],
        )
        touch_workspace(db, workspaceId, now)
        row = db.execute(
            "SELECT * FROM workspace_notes WHERE id = ?", [id]
        ).fetchone()
        return _map_note(row)

    def update(id: str, patch: dict[str, Any]) -> dict[str, Any]:
        existing = db.execute(
            "SELECT * FROM workspace_notes WHERE id = ?", [id]
        ).fetchone()
        if existing is None:
            raise RepoError("not_found", f"workspace note not found: {id}")
        title = (
            existing["title"]
            if patch.get("title") is None
            else patch["title"].strip()
        )
        if not title:
            raise RepoError("invalid_title", "note title cannot be empty")
        contentMd = (
            existing["contentMd"]
            if patch.get("contentMd") is None
            else patch["contentMd"]
        )
        color = existing["color"] if patch.get("color") is None else patch["color"]
        now = int(time.time() * 1000)
        db.execute(
            "UPDATE workspace_notes SET title = ?, contentMd = ?, color = ?, updatedAt = ? WHERE id = ?",
            [title, contentMd, color, now, id],
        )
        touch_workspace(db, existing["workspaceId"], now)
        row = db.execute(
            "SELECT * FROM workspace_notes WHERE id = ?", [id]
        ).fetchone()
        return _map_note(row)

    def remove(id: str) -> None:
        existing = db.execute(
            "SELECT workspaceId FROM workspace_notes WHERE id = ?", [id]
        ).fetchone()
        if existing is None:
            raise RepoError("not_found", f"workspace note not found: {id}")
        db.execute("DELETE FROM workspace_notes WHERE id = ?", [id])
        now = int(time.time() * 1000)
        touch_workspace(db, existing["workspaceId"], now)

    def get(id: str) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM workspace_notes WHERE id = ?", [id]
        ).fetchone()
        if row is None:
            return None
        return _map_note(row)

    return {
        "list": list,
        "create": create,
        "update": update,
        "delete": remove,
        "get": get,
    }
