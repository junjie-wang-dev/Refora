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
        "create": create,
        "get": get,
        "rename": rename,
        "delete": remove,
    }