from __future__ import annotations

import math
import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_support import require_workspace, touch_workspace

_KINDS = ("document", "report", "note", "asset")
_KIND_TABLE = {
    "document": "documents",
    "report": "ai_reports",
    "note": "workspace_notes",
    "asset": "workspace_assets",
}


def _map_workspace_item(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "kind": row["kind"],
        "docId": row["docId"] if row["docId"] is not None else None,
        "reportId": row["reportId"] if row["reportId"] is not None else None,
        "noteId": row["noteId"] if row["noteId"] is not None else None,
        "assetId": row["assetId"] if row["assetId"] is not None else None,
        "sortOrder": row["sortOrder"],
        "width": row["width"],
        "height": row["height"],
        "x": row["x"],
        "y": row["y"],
        "zIndex": row["zIndex"],
        "addedAt": row["addedAt"],
    }


def createWorkspaceItemsRepository(db):
    def list(workspaceId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM workspace_items WHERE workspaceId = ? ORDER BY sortOrder, addedAt, id",
            [workspaceId],
        )
        return [_map_workspace_item(r) for r in cur.fetchall()]

    def _kind_id_field(kind: str) -> str:
        return f"{kind}Id"

    def add(
        workspaceId: str,
        kind: str,
        ids: list[str],
        placement: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        seen: set[str] = set()
        unique_ids: list[str] = []
        for raw in ids:
            if isinstance(raw, str) and len(raw) > 0 and raw not in seen:
                seen.add(raw)
                unique_ids.append(raw)
        if len(unique_ids) == 0:
            return []
        if kind not in _KINDS:
            raise RepoError("invalid_kind", f"unsupported workspace item kind: {kind}")
        require_workspace(db, workspaceId)
        table = _KIND_TABLE[kind]
        id_field = _kind_id_field(kind)
        for id_ in unique_ids:
            if kind == "document":
                cur = db.execute(f"SELECT id FROM {table} WHERE id = ?", [id_])
            else:
                cur = db.execute(
                    f"SELECT id FROM {table} WHERE id = ? AND workspaceId = ?",
                    [id_, workspaceId],
                )
            if cur.fetchone() is None:
                raise RepoError("not_found", f"{kind} not found in workspace: {id_}")
        if placement is not None:
            if not _is_finite(placement.get("x")) or not _is_finite(placement.get("y")):
                raise RepoError("invalid_position", "workspace card position must be finite")
        cur = db.execute(
            "SELECT MAX(sortOrder) AS sortOrder, MAX(zIndex) AS zIndex "
            "FROM workspace_items WHERE workspaceId = ?",
            [workspaceId],
        )
        max_row = cur.fetchone()
        next_sort = (max_row["sortOrder"] if max_row is not None and max_row["sortOrder"] is not None else -1) + 1
        next_z = (max_row["zIndex"] if max_row is not None and max_row["zIndex"] is not None else -1) + 1
        now = int(time.time() * 1000)
        created_ids: list[str] = []
        created_count = 0
        for id_ in unique_ids:
            doc_id = id_ if kind == "document" else None
            report_id = id_ if kind == "report" else None
            note_id = id_ if kind == "note" else None
            asset_id = id_ if kind == "asset" else None
            cur = db.execute(
                "SELECT id FROM workspace_items WHERE workspaceId = ? AND kind = ? AND "
                "((? = 'document' AND docId = ?) OR (? = 'report' AND reportId = ?) OR "
                "(? = 'note' AND noteId = ?) OR (? = 'asset' AND assetId = ?))",
                [workspaceId, kind, kind, id_, kind, id_, kind, id_, kind, id_],
            )
            existing = cur.fetchone()
            if existing is not None:
                created_ids.append(existing["id"])
                continue
            item_id = str(uuid.uuid4())
            if placement is not None:
                x = float(placement["x"]) + (created_count % 3) * 28
                y = float(placement["y"]) + (created_count // 3) * 28
            else:
                x = float((next_sort % 4) * 332)
                y = float((next_sort // 4) * 232)
            try:
                db.execute(
                    "INSERT INTO workspace_items "
                    "(id, workspaceId, kind, docId, reportId, noteId, assetId, sortOrder, x, y, zIndex, addedAt) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [item_id, workspaceId, kind, doc_id, report_id, note_id, asset_id, next_sort, x, y, next_z, now],
                )
            except sqlite3.IntegrityError as exc:
                raise RepoError("duplicate", f"workspace item already exists for {kind}: {id_}") from exc
            created_ids.append(item_id)
            next_sort += 1
            next_z += 1
            created_count += 1
        touch_workspace(db, workspaceId)
        if len(created_ids) == 0:
            return []
        placeholders = ", ".join(["?"] * len(created_ids))
        cur = db.execute(
            f"SELECT * FROM workspace_items WHERE id IN ({placeholders}) ORDER BY sortOrder",
            created_ids,
        )
        return [_map_workspace_item(r) for r in cur.fetchall()]

    def remove(id: str) -> None:
        cur = db.execute("SELECT workspaceId FROM workspace_items WHERE id = ?", [id])
        row = cur.fetchone()
        if row is None:
            raise RepoError("not_found", f"workspace item not found: {id}")
        cur = db.execute("DELETE FROM workspace_items WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"workspace item not found: {id}")
        touch_workspace(db, row["workspaceId"])

    def reorder(workspaceId: str, orderedIds: list[str]) -> list[dict[str, Any]]:
        require_workspace(db, workspaceId)
        cur = db.execute(
            "SELECT id FROM workspace_items WHERE workspaceId = ? ORDER BY sortOrder",
            [workspaceId],
        )
        current = [r["id"] for r in cur.fetchall()]
        current_ids = set(current)
        if (
            len(orderedIds) != len(current)
            or len(set(orderedIds)) != len(orderedIds)
            or any(id_ not in current_ids for id_ in orderedIds)
        ):
            raise RepoError("invalid_order", "orderedIds must contain every workspace item exactly once")
        for i, id_ in enumerate(orderedIds):
            db.execute(
                "UPDATE workspace_items SET sortOrder = ? WHERE id = ? AND workspaceId = ?",
                [i, id_, workspaceId],
            )
        touch_workspace(db, workspaceId)
        return list(workspaceId)

    def resize(id: str, width: int, height: int) -> dict[str, Any]:
        if (
            not isinstance(width, int)
            or isinstance(width, bool)
            or not isinstance(height, int)
            or isinstance(height, bool)
            or width <= 0
            or height <= 0
        ):
            raise RepoError("invalid_size", "workspace card size must use positive integers")
        cur = db.execute("SELECT workspaceId FROM workspace_items WHERE id = ?", [id])
        existing = cur.fetchone()
        if existing is None:
            raise RepoError("not_found", f"workspace item not found: {id}")
        db.execute(
            "UPDATE workspace_items SET width = ?, height = ? WHERE id = ?",
            [width, height, id],
        )
        touch_workspace(db, existing["workspaceId"])
        cur = db.execute("SELECT * FROM workspace_items WHERE id = ?", [id])
        return _map_workspace_item(cur.fetchone())

    def move(id: str, x: float, y: float, zIndex: int) -> dict[str, Any]:
        if not _is_finite(x) or not _is_finite(y) or not isinstance(zIndex, int) or isinstance(zIndex, bool) or zIndex < 0:
            raise RepoError("invalid_position", "workspace card position is invalid")
        cur = db.execute("SELECT workspaceId FROM workspace_items WHERE id = ?", [id])
        existing = cur.fetchone()
        if existing is None:
            raise RepoError("not_found", f"workspace item not found: {id}")
        db.execute(
            "UPDATE workspace_items SET x = ?, y = ?, zIndex = ? WHERE id = ?",
            [float(x), float(y), zIndex, id],
        )
        touch_workspace(db, existing["workspaceId"])
        cur = db.execute("SELECT * FROM workspace_items WHERE id = ?", [id])
        return _map_workspace_item(cur.fetchone())

    def removeByDocId(docId: str) -> None:
        db.execute("DELETE FROM workspace_items WHERE docId = ?", [docId])

    def removeByReportId(reportId: str) -> None:
        db.execute("DELETE FROM workspace_items WHERE reportId = ?", [reportId])

    def removeByNoteId(noteId: str) -> None:
        db.execute("DELETE FROM workspace_items WHERE noteId = ?", [noteId])

    def removeByAssetId(assetId: str) -> None:
        db.execute("DELETE FROM workspace_items WHERE assetId = ?", [assetId])

    def get(id: str) -> dict[str, Any] | None:
        cur = db.execute("SELECT * FROM workspace_items WHERE id = ?", [id])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_workspace_item(row)

    return {
        "list": list,
        "add": add,
        "remove": remove,
        "reorder": reorder,
        "resize": resize,
        "move": move,
        "get": get,
        "removeByDocId": removeByDocId,
        "removeByReportId": removeByReportId,
        "removeByNoteId": removeByNoteId,
        "removeByAssetId": removeByAssetId,
    }


def _is_finite(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return True
    return False
