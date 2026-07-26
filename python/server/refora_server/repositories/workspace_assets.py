from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError

IMAGE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
}

AUDIO_TYPES: dict[str, str] = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}

VIDEO_TYPES: dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}

TEXT_EXTENSIONS: set[str] = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".yaml", ".yml",
    ".toml", ".ini", ".log", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss",
    ".less", ".html", ".htm", ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".php", ".sh", ".zsh", ".fish", ".sql", ".bib", ".tex", ".rtf",
}

_PREVIEW_KINDS: tuple[str, ...] = ("image", "text", "audio", "video", "none")


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return str(uuid.uuid4())


def workspace_asset_media_type(file_name: str) -> dict[str, str]:
    import os

    extension = os.path.splitext(file_name)[1].lower()
    if extension in IMAGE_TYPES:
        return {"mimeType": IMAGE_TYPES[extension], "previewKind": "image"}
    if extension in AUDIO_TYPES:
        return {"mimeType": AUDIO_TYPES[extension], "previewKind": "audio"}
    if extension in VIDEO_TYPES:
        return {"mimeType": VIDEO_TYPES[extension], "previewKind": "video"}
    if extension in TEXT_EXTENSIONS:
        if extension in (".json", ".jsonl"):
            mime_type = "application/json"
        elif extension in (".md", ".markdown"):
            mime_type = "text/markdown"
        elif extension == ".csv":
            mime_type = "text/csv"
        elif extension == ".tsv":
            mime_type = "text/tab-separated-values"
        else:
            mime_type = "text/plain"
        return {"mimeType": mime_type, "previewKind": "text"}
    if extension == ".pdf":
        return {"mimeType": "application/pdf", "previewKind": "none"}
    return {"mimeType": "application/octet-stream", "previewKind": "none"}


def _map_asset(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "workspaceId": row["workspaceId"],
        "fileName": row["fileName"],
        "filePath": row["filePath"],
        "sourcePath": row["sourcePath"],
        "mimeType": row["mimeType"],
        "previewKind": row["previewKind"],
        "fileSize": row["fileSize"],
        "fileHash": row["fileHash"],
        "fileMissing": int(row["fileMissing"]),
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


_INSERT_COLUMNS: tuple[str, ...] = (
    "id",
    "workspaceId",
    "fileName",
    "filePath",
    "sourcePath",
    "mimeType",
    "previewKind",
    "fileSize",
    "fileHash",
    "fileMissing",
    "createdAt",
    "updatedAt",
)

_UPDATE_FIELDS: tuple[str, ...] = (
    "fileName",
    "filePath",
    "sourcePath",
    "mimeType",
    "previewKind",
    "fileSize",
    "fileHash",
    "fileMissing",
)


def createWorkspaceAssetsRepository(db: Any):
    def _fetch(id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM workspace_assets WHERE id = ?", [id])
        return cur.fetchone()

    def _workspace_exists(workspace_id: str) -> bool:
        cur = db.execute("SELECT 1 FROM workspaces WHERE id = ?", [workspace_id])
        return cur.fetchone() is not None

    def list(workspaceId: str) -> list[dict[str, Any]]:
        if not _workspace_exists(workspaceId):
            raise RepoError("not_found", f"workspace not found: {workspaceId}")
        cur = db.execute(
            "SELECT * FROM workspace_assets WHERE workspaceId = ? ORDER BY createdAt, id",
            [workspaceId],
        )
        rows = cur.fetchall()
        return [_map_asset(r) for r in rows]

    def search(q: str, limit: int = 10) -> list[dict[str, Any]]:
        trimmed = q.strip()
        if not trimmed:
            return []
        escaped = trimmed.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        safe_limit = max(1, min(50, int(limit)))
        rows = db.execute(
            """
            SELECT a.id, a.workspaceId, w.name AS workspaceName, a.fileName,
                   a.mimeType, a.previewKind, a.fileMissing, a.updatedAt
            FROM workspace_assets a
            JOIN workspaces w ON w.id = a.workspaceId
            WHERE a.fileName LIKE ? ESCAPE '\\'
               OR a.sourcePath LIKE ? ESCAPE '\\'
               OR a.mimeType LIKE ? ESCAPE '\\'
            ORDER BY a.updatedAt DESC, a.id
            LIMIT ?
            """,
            [like, like, like, safe_limit],
        ).fetchall()
        return [
            {
                "id": row["id"],
                "workspaceId": row["workspaceId"],
                "workspaceName": row["workspaceName"],
                "fileName": row["fileName"],
                "mimeType": row["mimeType"],
                "previewKind": row["previewKind"],
                "fileMissing": int(row["fileMissing"]),
                "updatedAt": row["updatedAt"],
            }
            for row in rows
        ]

    def create(asset: dict[str, Any]) -> dict[str, Any]:
        workspace_id = asset["workspaceId"]
        if not _workspace_exists(workspace_id):
            raise RepoError("not_found", f"workspace not found: {workspace_id}")
        id = asset.get("id") or new_id()
        now = asset.get("createdAt")
        if now is None:
            now = now_ms()
        updated_at = asset.get("updatedAt")
        if updated_at is None:
            updated_at = now
        preview_kind = asset.get("previewKind")
        if preview_kind not in _PREVIEW_KINDS:
            raise RepoError("invalid_input", f"invalid previewKind: {preview_kind}")
        values: list[Any] = [
            id,
            workspace_id,
            asset["fileName"],
            asset["filePath"],
            asset["sourcePath"],
            asset["mimeType"],
            preview_kind,
            asset["fileSize"],
            asset["fileHash"],
            int(asset.get("fileMissing", 0)),
            now,
            updated_at,
        ]
        placeholders = ", ".join("?" for _ in _INSERT_COLUMNS)
        col_list = ", ".join(_INSERT_COLUMNS)
        try:
            db.execute(
                f"INSERT INTO workspace_assets ({col_list}) VALUES ({placeholders})", values
            )
        except sqlite3.IntegrityError as exc:
            raise RepoError("duplicate", str(exc)) from exc
        row = _fetch(id)
        assert row is not None
        return _map_asset(row)

    def get(id: str) -> dict[str, Any] | None:
        row = _fetch(id)
        if row is None:
            return None
        return _map_asset(row)

    def update(id: str, patch: dict[str, Any]) -> dict[str, Any]:
        sets: list[str] = []
        params: list[Any] = []
        for field in _UPDATE_FIELDS:
            if field in patch:
                sets.append(f"{field} = ?")
                value = patch[field]
                if field == "fileMissing":
                    value = int(value)
                if field == "previewKind" and value not in _PREVIEW_KINDS:
                    raise RepoError("invalid_input", f"invalid previewKind: {value}")
                params.append(value)
        if len(sets) == 0:
            row = _fetch(id)
            if row is None:
                raise RepoError("not_found", f"workspace asset not found: {id}")
            return _map_asset(row)
        sets.append("updatedAt = ?")
        params.append(now_ms())
        params.append(id)
        try:
            cur = db.execute(
                f"UPDATE workspace_assets SET {', '.join(sets)} WHERE id = ?", params
            )
        except sqlite3.IntegrityError as exc:
            raise RepoError("duplicate", str(exc)) from exc
        if cur.rowcount == 0:
            raise RepoError("not_found", f"workspace asset not found: {id}")
        row = _fetch(id)
        assert row is not None
        return _map_asset(row)

    def delete(id: str) -> None:
        asset = get(id)
        if asset is None:
            raise RepoError("not_found", f"workspace asset not found: {id}")
        cur = db.execute("DELETE FROM workspace_assets WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"workspace asset not found: {id}")
        db.execute(
            "UPDATE workspaces SET updatedAt = ? WHERE id = ?",
            [now_ms(), asset["workspaceId"]],
        )

    return {
        "list": list,
        "search": search,
        "create": create,
        "get": get,
        "update": update,
        "delete": delete,
    }
