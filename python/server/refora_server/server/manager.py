from __future__ import annotations

from typing import Any


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, Any] = {}

    def create(self, kind: str, **kwargs: Any) -> str:
        raise NotImplementedError

    def get(self, session_id: str) -> Any:
        raise NotImplementedError

    def cancel(self, session_id: str) -> bool:
        raise NotImplementedError


_manager: SessionManager | None = None


def get_manager() -> SessionManager:
    global _manager
    if _manager is None:
        _manager = SessionManager()
    return _manager