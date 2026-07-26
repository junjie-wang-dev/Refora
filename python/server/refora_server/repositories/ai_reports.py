from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_source_doc_ids(raw: Any) -> list[str]:
    if not isinstance(raw, str) or len(raw) == 0:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if isinstance(parsed, list):
        return [v for v in parsed if isinstance(v, str)]
    return []


def _normalize_source_doc_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        return _parse_source_doc_ids(value)
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _map_report(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "title": row["title"],
        "contentMd": row["contentMd"],
        "sourceDocIds": _parse_source_doc_ids(row["sourceDocIds"]),
        "model": row["model"] if row["model"] is not None else None,
        "createdAt": row["createdAt"],
    }


def createAiReportsRepository(db):
    def list(workspaceId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM ai_reports WHERE workspaceId = ? ORDER BY createdAt DESC",
            [workspaceId],
        )
        return [_map_report(r) for r in cur.fetchall()]

    def create(
        workspaceId: str,
        title: str,
        contentMd: str,
        sourceDocIds: Any,
        model: str | None = None,
    ) -> dict[str, Any]:
        trimmed = (title or "").strip()
        if not trimmed:
            raise RepoError("invalid_title", "report title cannot be empty")
        cur = db.execute("SELECT id FROM workspaces WHERE id = ?", [workspaceId])
        if cur.fetchone() is None:
            raise RepoError("not_found", f"workspace not found: {workspaceId}")
        id = str(uuid.uuid4())
        now = _now_ms()
        ids_json = json.dumps(_normalize_source_doc_ids(sourceDocIds))
        db.execute(
            "INSERT INTO ai_reports (id, workspaceId, title, contentMd, sourceDocIds, model, createdAt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [id, workspaceId, trimmed, contentMd, ids_json, model, now],
        )
        db.execute(
            "UPDATE workspaces SET updatedAt = ? WHERE id = ?",
            [now, workspaceId],
        )
        row = db.execute("SELECT * FROM ai_reports WHERE id = ?", [id]).fetchone()
        return _map_report(row)

    def get(id: str) -> dict[str, Any] | None:
        row = db.execute("SELECT * FROM ai_reports WHERE id = ?", [id]).fetchone()
        if row is None:
            return None
        return _map_report(row)

    def update(id: str, patch: dict[str, Any]) -> dict[str, Any]:
        existing = db.execute("SELECT * FROM ai_reports WHERE id = ?", [id]).fetchone()
        if existing is None:
            raise RepoError("not_found", f"report not found: {id}")
        title = (
            patch["title"].strip()
            if "title" in patch and patch.get("title") is not None
            else existing["title"]
        )
        if not title:
            raise RepoError("invalid_title", "report title cannot be empty")
        contentMd = patch["contentMd"] if "contentMd" in patch else existing["contentMd"]
        db.execute(
            "UPDATE ai_reports SET title = ?, contentMd = ? WHERE id = ?",
            [title, contentMd, id],
        )
        now = _now_ms()
        db.execute(
            "UPDATE workspaces SET updatedAt = ? WHERE id = ?",
            [now, existing["workspaceId"]],
        )
        row = db.execute("SELECT * FROM ai_reports WHERE id = ?", [id]).fetchone()
        return _map_report(row)

    def remove(id: str) -> None:
        existing = db.execute(
            "SELECT workspaceId FROM ai_reports WHERE id = ?", [id]
        ).fetchone()
        if existing is None:
            raise RepoError("not_found", f"report not found: {id}")
        cur = db.execute("DELETE FROM ai_reports WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"report not found: {id}")
        now = _now_ms()
        db.execute(
            "UPDATE workspaces SET updatedAt = ? WHERE id = ?",
            [now, existing["workspaceId"]],
        )

    def remove_doc_from_sources(doc_id: str) -> None:
        pattern = f'%"{doc_id}"%'
        rows = db.execute(
            "SELECT id, sourceDocIds FROM ai_reports WHERE sourceDocIds LIKE ?",
            [pattern],
        ).fetchall()
        for row in rows:
            ids = _parse_source_doc_ids(row["sourceDocIds"])
            if doc_id not in ids:
                continue
            updated = [i for i in ids if i != doc_id]
            if len(updated) == len(ids):
                continue
            db.execute(
                "UPDATE ai_reports SET sourceDocIds = ? WHERE id = ?",
                [json.dumps(updated), row["id"]],
            )

    return {
        "list": list,
        "create": create,
        "get": get,
        "update": update,
        "delete": remove,
        "removeDocFromSources": remove_doc_from_sources,
    }
