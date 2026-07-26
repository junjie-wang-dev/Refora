from __future__ import annotations

import json
from typing import Any


class SettingsRepository:
    def __init__(self, db: Any) -> None:
        self._db = db

    def get(self, key: str, default: Any = None) -> Any:
        row = self._db.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row[0])
        except (TypeError, ValueError):
            return default

    def set(self, key: str, value: Any) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value, allow_nan=False)),
        )

    def delete(self, key: str) -> None:
        self._db.execute("DELETE FROM settings WHERE key = ?", (key,))

    def list(self) -> list[tuple[str, Any]]:
        rows = self._db.execute(
            "SELECT key, value FROM settings ORDER BY key"
        ).fetchall()
        values: list[tuple[str, Any]] = []
        for row in rows:
            try:
                values.append((row[0], json.loads(row[1])))
            except (TypeError, ValueError):
                values.append((row[0], None))
        return values


def create_settings_repository(db: Any) -> SettingsRepository:
    return SettingsRepository(db)
