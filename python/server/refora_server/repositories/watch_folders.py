import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


def _map_watch_folder(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "path": row["path"],
        "enabled": int(row["enabled"]) if row["enabled"] is not None else 0,
        "addedAt": row["addedAt"],
    }


def createWatchFoldersRepository(db):
    def list_() -> list[dict[str, Any]]:
        cur = db.execute("SELECT * FROM watch_folders ORDER BY addedAt")
        rows = cur.fetchall()
        return [_map_watch_folder(r) for r in rows]

    def add(path: str) -> dict[str, Any]:
        id = str(uuid.uuid4())
        added_at = int(time.time() * 1000)
        try:
            db.execute(
                "INSERT INTO watch_folders (id, path, enabled, addedAt) VALUES (?, ?, 1, ?)",
                [id, path, added_at],
            )
        except sqlite3.IntegrityError as exc:
            raise RepoError("duplicate", f"watch folder already exists: {path}", "path") from exc
        cur = db.execute("SELECT * FROM watch_folders WHERE id = ?", [id])
        row = cur.fetchone()
        return _map_watch_folder(row)

    def remove(id: str) -> None:
        cur = db.execute("DELETE FROM watch_folders WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"watch folder not found: {id}")

    def toggle(id: str, enabled: bool) -> dict[str, Any]:
        cur = db.execute(
            "UPDATE watch_folders SET enabled = ? WHERE id = ?",
            [1 if enabled else 0, id],
        )
        if cur.rowcount == 0:
            raise RepoError("not_found", f"watch folder not found: {id}")
        cur = db.execute("SELECT * FROM watch_folders WHERE id = ?", [id])
        row = cur.fetchone()
        return _map_watch_folder(row)

    def getEnabled() -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT * FROM watch_folders WHERE enabled = 1 ORDER BY addedAt"
        )
        rows = cur.fetchall()
        return [_map_watch_folder(r) for r in rows]

    return {
        "list": list_,
        "add": add,
        "remove": remove,
        "toggle": toggle,
        "getEnabled": getEnabled,
    }