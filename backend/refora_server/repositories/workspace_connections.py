from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_support import require_workspace, touch_workspace

_ANCHORS = ("top", "right", "bottom", "left")


def _map_connection(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "sourceItemId": row["sourceItemId"],
        "targetItemId": row["targetItemId"],
        "sourceAnchor": row["sourceAnchor"],
        "targetAnchor": row["targetAnchor"],
        "createdAt": row["createdAt"],
    }


def createWorkspaceConnectionsRepository(db):
    def list(workspaceId: str) -> list[dict[str, Any]]:
        require_workspace(db, workspaceId)
        cur = db.execute(
            "SELECT * FROM workspace_connections WHERE workspaceId = ? ORDER BY createdAt, id",
            [workspaceId],
        )
        return [_map_connection(r) for r in cur.fetchall()]

    def get(id: str) -> dict[str, Any] | None:
        cur = db.execute("SELECT * FROM workspace_connections WHERE id = ?", [id])
        row = cur.fetchone()
        return _map_connection(row) if row is not None else None

    def create(
        workspaceId: str,
        sourceItemId: str,
        targetItemId: str,
        sourceAnchor: str,
        targetAnchor: str,
    ) -> dict[str, Any]:
        require_workspace(db, workspaceId)
        if sourceAnchor not in _ANCHORS or targetAnchor not in _ANCHORS:
            raise RepoError("invalid_anchor", "workspace connection anchor is invalid")
        if sourceItemId == targetItemId:
            raise RepoError("invalid_connection", "workspace cards cannot connect to themselves")
        cur = db.execute(
            "SELECT id, workspaceId FROM workspace_items WHERE id IN (?, ?)",
            [sourceItemId, targetItemId],
        )
        rows = cur.fetchall()
        if len(rows) != 2 or any(r["workspaceId"] != workspaceId for r in rows):
            raise RepoError("not_found", "workspace connection endpoint not found")
        cur = db.execute(
            "SELECT id, createdAt FROM workspace_connections "
            "WHERE workspaceId = ? AND sourceItemId = ? AND targetItemId = ?",
            [workspaceId, sourceItemId, targetItemId],
        )
        existing = cur.fetchone()
        conn_id = existing["id"] if existing is not None else str(uuid.uuid4())
        created_at = existing["createdAt"] if existing is not None else int(time.time() * 1000)
        db.execute(
            "INSERT INTO workspace_connections "
            "(id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(workspaceId, sourceItemId, targetItemId) DO UPDATE SET "
            "sourceAnchor = excluded.sourceAnchor, "
            "targetAnchor = excluded.targetAnchor",
            [conn_id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, created_at],
        )
        touch_workspace(db, workspaceId)
        cur = db.execute("SELECT * FROM workspace_connections WHERE id = ?", [conn_id])
        return _map_connection(cur.fetchone())

    def remove(id: str) -> None:
        cur = db.execute("SELECT workspaceId FROM workspace_connections WHERE id = ?", [id])
        existing = cur.fetchone()
        if existing is None:
            raise RepoError("not_found", f"workspace connection not found: {id}")
        db.execute("DELETE FROM workspace_connections WHERE id = ?", [id])
        touch_workspace(db, existing["workspaceId"])

    return {"list": list, "get": get, "create": create, "delete": remove}
