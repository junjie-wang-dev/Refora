from __future__ import annotations

import sqlite3
import time
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_support import require_workspace, touch_workspace

WORKSPACE_CANVAS_MIN_ZOOM = 0.25
WORKSPACE_CANVAS_MAX_ZOOM = 2.5
WORKSPACE_CANVAS_DEFAULT_ZOOM = 1.0


def _default_canvas(workspaceId: str) -> dict[str, Any]:
    return {
        "workspaceId": workspaceId,
        "panX": 0.0,
        "panY": 0.0,
        "zoom": WORKSPACE_CANVAS_DEFAULT_ZOOM,
        "updatedAt": 0,
    }


def now_ms() -> int:
    return int(time.time() * 1000)


def _map_canvas(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "workspaceId": row["workspaceId"],
        "panX": row["panX"],
        "panY": row["panY"],
        "zoom": row["zoom"],
        "updatedAt": row["updatedAt"],
    }


def _validate_viewport(panX: float, panY: float, zoom: float) -> None:
    if not isinstance(panX, (int, float)) or isinstance(panX, bool):
        raise RepoError("invalid_viewport", "workspace canvas viewport is out of bounds")
    if not isinstance(panY, (int, float)) or isinstance(panY, bool):
        raise RepoError("invalid_viewport", "workspace canvas viewport is out of bounds")
    if not isinstance(zoom, (int, float)) or isinstance(zoom, bool):
        raise RepoError("invalid_viewport", "workspace canvas viewport is out of bounds")
    if zoom < WORKSPACE_CANVAS_MIN_ZOOM or zoom > WORKSPACE_CANVAS_MAX_ZOOM:
        raise RepoError("invalid_viewport", "workspace canvas viewport is out of bounds")


def createWorkspaceCanvasRepository(db):
    def get(workspaceId: str) -> dict[str, Any]:
        require_workspace(db, workspaceId)
        cur = db.execute(
            "SELECT workspaceId, panX, panY, zoom, updatedAt "
            "FROM workspace_canvas_state WHERE workspaceId = ?",
            [workspaceId],
        )
        row = cur.fetchone()
        if row is None:
            return _default_canvas(workspaceId)
        return _map_canvas(row)

    def update(workspaceId: str, panX: float, panY: float, zoom: float) -> dict[str, Any]:
        require_workspace(db, workspaceId)
        _validate_viewport(panX, panY, zoom)
        now = now_ms()
        db.execute(
            "INSERT INTO workspace_canvas_state (workspaceId, panX, panY, zoom, updatedAt) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(workspaceId) DO UPDATE SET "
            "panX = excluded.panX, "
            "panY = excluded.panY, "
            "zoom = excluded.zoom, "
            "updatedAt = excluded.updatedAt",
            [workspaceId, panX, panY, zoom, now],
        )
        touch_workspace(db, workspaceId, now)
        return get(workspaceId)

    return {
        "get": get,
        "update": update,
    }
