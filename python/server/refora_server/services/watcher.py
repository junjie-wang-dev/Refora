from __future__ import annotations

import asyncio
import inspect
import os
from typing import Any, Awaitable, Callable, TypedDict

from refora_server.library.paths import isInsideLibrary
from refora_server.repositories.errors import RepoError


def _isPdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


_MANAGED_DIRECTORIES = {"refora-assets", ".refora-agent", ".refora"}


def _listPdfsRecursive(folder: str, skip_managed: bool = False) -> list[str]:
    found: list[str] = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                try:
                    if (
                        skip_managed
                        and (
                            entry.name in _MANAGED_DIRECTORIES
                            or entry.name.startswith(".")
                        )
                    ):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        found.extend(_listPdfsRecursive(entry.path, skip_managed))
                    elif entry.is_file(follow_symlinks=False) and _isPdf(entry.name):
                        found.append(os.path.normpath(os.path.abspath(entry.path)))
                except OSError:
                    continue
    except OSError:
        return found
    return found


class WatcherRepos(TypedDict, total=False):
    watchFolders: Any
    documents: Any


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
        "seen": {},
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

    def _scanFolderOnce(
        path: str,
        *,
        known: set[str] | None = None,
        skip_managed: bool = False,
    ) -> list[str]:
        if not os.path.isdir(path):
            return []
        root = os.path.normpath(os.path.abspath(path))
        current = set(_listPdfsRecursive(root, skip_managed))
        previous = state["seen"].get(root)
        if previous is None:
            previous = known or set()
        state["seen"][root] = current
        return sorted(current - previous)

    def _knownLibraryFiles() -> set[str]:
        documents = repos.get("documents")
        list_documents = documents.get("list") if isinstance(documents, dict) else None
        if not callable(list_documents):
            return set()
        return {
            os.path.normpath(os.path.abspath(document["filePath"]))
            for document in list_documents({"mode": "all"})
            if isinstance(document, dict)
            and isinstance(document.get("filePath"), str)
            and document["filePath"]
        }

    def _scanAll() -> list[str]:
        batch: list[str] = []
        for wf in repos["watchFolders"]["getEnabled"]():
            batch.extend(_scanFolderOnce(wf["path"]))
        library_folder = get_library_folder()
        if library_folder:
            batch.extend(
                _scanFolderOnce(
                    library_folder,
                    known=_knownLibraryFiles(),
                    skip_managed=True,
                )
            )
        return batch

    async def _scanLoop() -> None:
        while state["running"]:
            try:
                batch = _scanAll()
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
        state["seen"] = {}
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
        return _scanAll()

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
