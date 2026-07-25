from __future__ import annotations

from typing import Any


class SettingsRepository:
    def __init__(self, db: Any) -> None:
        self._db = db

    def get(self, key: str, default: str | None = None) -> str | None:
        row = self._db.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return default
        return row[0]

    def set(self, key: str, value: str) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )

    def delete(self, key: str) -> None:
        self._db.execute("DELETE FROM settings WHERE key = ?", (key,))

    def list(self) -> list[tuple[str, str]]:
        rows = self._db.execute(
            "SELECT key, value FROM settings ORDER BY key"
        ).fetchall()
        return [(row[0], row[1]) for row in rows]


def create_settings_repository(db: Any) -> SettingsRepository:
    return SettingsRepository(db)
