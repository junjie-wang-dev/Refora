from __future__ import annotations

import os
from typing import Any, Callable, TypedDict

from refora_server.repositories.errors import RepoError


class LibraryRepos(TypedDict):
    settings: Any


class LibraryServiceDeps(TypedDict, total=False):
    emit: Callable[[str, dict[str, Any]], None]


def createLibraryService(repos: LibraryRepos, deps: LibraryServiceDeps | None = None):
    deps = deps or {}
    emit: Callable[[str, dict[str, Any]], None] = deps.get("emit", lambda _event, _payload: None)

    def switchLibrary(folder: str) -> dict[str, Any]:
        resolved = os.path.normpath(os.path.abspath(folder)) if folder else ""
        if not resolved or not os.path.exists(resolved) or not os.path.isdir(resolved):
            raise RepoError("invalid_argument", f"Invalid library folder: {resolved}")
        repos["settings"].set("libraryFolderPath", resolved)
        try:
            emit("library.switched", {"path": resolved})
        except Exception:
            pass
        return {"ack": True}

    def getLibraryFolder() -> str:
        return repos["settings"].get("libraryFolderPath", "") or ""

    return {
        "switchLibrary": switchLibrary,
        "getLibraryFolder": getLibraryFolder,
    }
