from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Any, Protocol

from refora_server.repositories.errors import RepoError


class WorkspaceCursor(Protocol):
    def fetchone(self) -> Any | None: ...


class WorkspaceDatabase(Protocol):
    def execute(
        self, sql: str, params: Sequence[object]
    ) -> WorkspaceCursor: ...


def require_workspace(db: WorkspaceDatabase, workspace_id: str) -> None:
    row = db.execute("SELECT 1 FROM workspaces WHERE id = ?", [workspace_id]).fetchone()
    if row is None:
        raise RepoError("not_found", f"workspace not found: {workspace_id}")


def touch_workspace(
    db: WorkspaceDatabase,
    workspace_id: str,
    updated_at: int | None = None,
) -> None:
    timestamp = int(time.time() * 1000) if updated_at is None else updated_at
    db.execute(
        "UPDATE workspaces SET updatedAt = ? WHERE id = ?",
        [timestamp, workspace_id],
    )
