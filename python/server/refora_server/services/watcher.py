from __future__ import annotations

import asyncio
import inspect
import os
from typing import Any, Awaitable, Callable, TypedDict

from refora_server.library.paths import isInsideLibrary
from refora_server.repositories.errors import RepoError


def _isPdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


def _listPdfsRecursive(folder: str) -> list[str]:
    found: list[str] = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        found.extend(_listPdfsRecursive(entry.path))
                    elif entry.is_file(follow_symlinks=False) and _isPdf(entry.name):
                        found.append(entry.path)
                except OSError:
                    continue
    except OSError:
        return found
    return found


class WatcherRepos(TypedDict):
    watchFolders: Any


OnNewPdf = Callable[[list[str]], Awaitable[None] | None]


class WatcherServiceDeps(TypedDict, total=False):
    onNewPdf: OnNewPdf
    getLibraryFolder: Callable[[], str]
    pollInterval: float


def createWatcherService(repos: WatcherRepos, deps: WatcherServiceDeps | None = None):
    deps = deps or {}
    on_new_pdf: OnNewPdf = deps.get("onNewPdf", lambda _paths: None)
    get_library_folder: Callable[[], str] = deps.get("getLibraryFolder", lambda: "")
    poll_interval: float = float(deps.get("pollInterval", 5.0))

    state: dict[str, Any] = {
        "task": None,
        "running": False,
        "seen": set[str](),
    }

    def list_() -> list[dict[str, Any]]:
        return repos["watchFolders"]["list"]()

    def add(path: str) -> dict[str, Any]:
        resolved = os.path.normpath(os.path.abspath(path)) if path else ""
        if not resolved or not os.path.exists(resolved):
            raise RepoError("invalid_path", f"Path does not exist: {resolved}")
        if not os.path.isdir(resolved):
            raise RepoError("invalid_path", f"Not a directory: {resolved}")
        library_folder = get_library_folder()
        if library_folder:
            if isInsideLibrary(resolved, library_folder):
                raise RepoError("inside_library", "Path cannot be inside the library folder.")
            if isInsideLibrary(library_folder, resolved):
                raise RepoError("contains_library", "Path cannot be inside a watch folder.")
        return repos["watchFolders"]["add"](resolved)

    def remove(watchId: str) -> None:
        repos["watchFolders"]["remove"](watchId)

    def toggle(watchId: str, enabled: bool) -> dict[str, Any]:
        return repos["watchFolders"]["toggle"](watchId, enabled)

    def _scanFolderOnce(path: str) -> list[str]:
        if not os.path.isdir(path):
            return []
        new_paths: list[str] = []
        for pdf in _listPdfsRecursive(path):
            if pdf not in state["seen"]:
                state["seen"].add(pdf)
                new_paths.append(pdf)
        return new_paths

    async def _scanLoop() -> None:
        while state["running"]:
            try:
                enabled = repos["watchFolders"]["getEnabled"]()
                batch: list[str] = []
                for wf in enabled:
                    batch.extend(_scanFolderOnce(wf["path"]))
                if batch:
                    result = on_new_pdf(batch)
                    if inspect.isawaitable(result):
                        await result
            except Exception:
                pass
            await asyncio.sleep(poll_interval)

    def startScanning() -> None:
        if state["running"]:
            return
        state["running"] = True
        state["seen"] = set[str]()
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        state["task"] = loop.create_task(_scanLoop())

    def stopScanning() -> None:
        state["running"] = False
        task = state["task"]
        state["task"] = None
        if task is not None:
            if not task.done():
                task.cancel()

    def scanOnce() -> list[str]:
        batch: list[str] = []
        for wf in repos["watchFolders"]["getEnabled"]():
            batch.extend(_scanFolderOnce(wf["path"]))
        return batch

    return {
        "list": list_,
        "add": add,
        "remove": remove,
        "toggle": toggle,
        "startScanning": startScanning,
        "stopScanning": stopScanning,
        "scanOnce": scanOnce,
        "_state": state,
    }
