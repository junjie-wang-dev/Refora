from __future__ import annotations

import asyncio
import inspect
import os
import threading
from typing import Any, Awaitable, Callable, TypedDict

from refora_server.library.paths import isInsideLibrary
from refora_server.repositories.errors import RepoError

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _WATCHDOG_AVAILABLE = True
except Exception:
    _WATCHDOG_AVAILABLE = False
    FileSystemEventHandler = object  # type: ignore[assignment, misc]
    Observer = None  # type: ignore[assignment, misc]


def _isPdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


_MANAGED_DIRECTORIES = {"refora-assets", ".refora-agent", ".refora"}
_HIDDEN_PREFIXES = (".",)

_AWAIT_WRITE_FINISH_MS = 2000
_AWAIT_WRITE_POLL_MS = 100
_DEBOUNCE_MS = 500
_LIBRARY_RECONCILE_INTERVAL_S = 30.0


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


def _shouldIgnorePath(testPath: str, root: str, libraryFolder: str) -> bool:
    if libraryFolder and testPath != root and isInsideLibrary(testPath, libraryFolder):
        return True
    parts = testPath.replace("\\", "/").split("/")
    for part in parts:
        if not part:
            continue
        if part in _MANAGED_DIRECTORIES:
            return True
        if part == ".git":
            return True
        if part.startswith(_HIDDEN_PREFIXES):
            return True
        if "." in part and not part.lower().endswith(".pdf"):
            return True
    return False


class WatcherRepos(TypedDict, total=False):
    watchFolders: Any
    documents: Any


OnNewPdf = Callable[[list[str]], Awaitable[None] | None]


class WatcherServiceDeps(TypedDict, total=False):
    onNewPdf: OnNewPdf
    getLibraryFolder: Callable[[], str]
    pollInterval: float
    stabilityThresholdMs: int
    debounceMs: int


def createWatcherService(repos: WatcherRepos, deps: WatcherServiceDeps | None = None):
    deps = deps or {}
    on_new_pdf: OnNewPdf = deps.get("onNewPdf", lambda _paths: None)
    get_library_folder: Callable[[], str] = deps.get("getLibraryFolder", lambda: "")
    poll_interval: float = float(deps.get("pollInterval", 5.0))
    stability_threshold_ms = int(deps.get("stabilityThresholdMs", _AWAIT_WRITE_FINISH_MS))
    debounce_ms = int(deps.get("debounceMs", _DEBOUNCE_MS))

    state: dict[str, Any] = {
        "task": None,
        "running": False,
        "seen": {},
        "watchdog": _WATCHDOG_AVAILABLE,
        "observers": {},
        "loop": None,
        "lock": None,
        "stabilizers": {},
        "debounceTimer": None,
        "pending": set(),
        "reconcileTask": None,
    }

    def _getLoop() -> asyncio.AbstractEventLoop:
        loop = state["loop"]
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                try:
                    loop = asyncio.get_event_loop()
                except RuntimeError:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
            state["loop"] = loop
        return loop

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
        wf = repos["watchFolders"]["add"](resolved)
        if state["running"] and wf.get("enabled"):
            _startObserverForFolder(wf["id"], resolved)
        return wf

    def remove(watchId: str) -> None:
        repos["watchFolders"]["remove"](watchId)
        _stopObserver(watchId)

    def toggle(watchId: str, enabled: bool) -> dict[str, Any]:
        wf = repos["watchFolders"]["toggle"](watchId, enabled)
        if state["running"]:
            if enabled:
                _startObserverForFolder(wf["id"], wf["path"])
            else:
                _stopObserver(wf["id"])
        return wf

    # ---- import pipeline (debounce + await-write-finish) ----

    def _scheduleImport(path: str, *, allow_library: bool = False) -> None:
        if not path or not _isPdf(path):
            return
        library_folder = get_library_folder()
        if not allow_library:
            if library_folder and isInsideLibrary(path, library_folder):
                return
        if _shouldIgnorePath(path, path, library_folder) and not allow_library:
            return
        lock = state["lock"]
        if lock is None:
            lock = threading.Lock()
            state["lock"] = lock
        with lock:
            pending: set[str] = state["pending"]
            pending.add(path)
            timer = state["debounceTimer"]
            if timer is not None:
                timer.cancel()
            loop = _getLoop()
            if loop.is_closed():
                return
            state["debounceTimer"] = loop.call_later(
                debounce_ms / 1000.0, _flushImports
            )

    def _flushImports() -> None:
        lock = state["lock"]
        if lock is None:
            return
        with lock:
            batch = sorted(state["pending"])
            state["pending"] = set()
            state["debounceTimer"] = None
        if not batch:
            return
        result = on_new_pdf(batch)
        if inspect.isawaitable(result):
            loop = _getLoop()
            if loop.is_running():
                task = loop.create_task(_awaitResult(result))
                task.add_done_callback(lambda _t: None)
            else:
                try:
                    loop.run_until_complete(result)
                except Exception:
                    pass

    async def _awaitResult(awaitable: Awaitable[Any]) -> None:
        try:
            await awaitable
        except Exception:
            pass

    # ---- watchdog event-driven observers ----

    def _resolveEventPath(event: Any) -> str | None:
        if event is None:
            return None
        src = getattr(event, "dest_path", None) or getattr(event, "src_path", None)
        if not src:
            return None
        return os.path.normpath(os.path.abspath(str(src)))

    def _onStable(path: str, allow_library: bool = False) -> None:
        _scheduleImport(path, allow_library=allow_library)

    def _markStabilizing(path: str, allow_library: bool = False) -> None:
        lock = state["lock"]
        if lock is None:
            lock = threading.Lock()
            state["lock"] = lock
        with lock:
            stabilizers: dict[str, threading.Timer] = state["stabilizers"]
            timer = stabilizers.get(path)
            if timer is not None:
                timer.cancel()
            t = threading.Timer(
                stability_threshold_ms / 1000.0, _onStable, args=(path, allow_library)
            )
            t.daemon = True
            stabilizers[path] = t
        t.start()

    def _cancelStabilizer(path: str) -> None:
        lock = state["lock"]
        if lock is None:
            return
        with lock:
            stabilizers: dict[str, threading.Timer] = state["stabilizers"]
            timer = stabilizers.pop(path, None)
        if timer is not None:
            timer.cancel()

    if _WATCHDOG_AVAILABLE:

        class _PdfHandler(FileSystemEventHandler):  # type: ignore[misc]
            def __init__(self, root: str, libraryFolder: str, isLibrary: bool = False) -> None:
                self.root = root
                self.libraryFolder = libraryFolder
                self.isLibrary = isLibrary

            def _accept(self, event: Any) -> str | None:
                path = _resolveEventPath(event)
                if path is None:
                    return None
                if not _isPdf(path):
                    return None
                if not self.isLibrary and _shouldIgnorePath(path, self.root, self.libraryFolder):
                    return None
                if self.isLibrary and _shouldIgnorePath(path, self.root, ""):
                    return None
                return path

            def on_created(self, event: Any) -> None:
                path = self._accept(event)
                if path:
                    _markStabilizing(path, allow_library=self.isLibrary)

            def on_modified(self, event: Any) -> None:
                path = self._accept(event)
                if path:
                    _markStabilizing(path, allow_library=self.isLibrary)

            def on_moved(self, event: Any) -> None:
                path = self._accept(event)
                if path:
                    _markStabilizing(path, allow_library=self.isLibrary)

            def on_deleted(self, event: Any) -> None:
                path = _resolveEventPath(event)
                if path:
                    _cancelStabilizer(path)

    def _startObserverForFolder(
        folderId: str, folderPath: str, *, isLibrary: bool = False
    ) -> None:
        if not _WATCHDOG_AVAILABLE or not state["running"]:
            return
        observers: dict[str, Any] = state["observers"]
        if folderId in observers:
            return
        if not folderPath or not os.path.isdir(folderPath):
            return
        library_folder = get_library_folder()
        handler = _PdfHandler(folderPath, library_folder, isLibrary=isLibrary)
        try:
            observer = Observer()
            observer.schedule(handler, folderPath, recursive=True)
            observer.start()
        except Exception:
            return
        observers[folderId] = observer

    def _stopObserver(folderId: str) -> None:
        observers: dict[str, Any] = state["observers"]
        observer = observers.pop(folderId, None)
        if observer is None:
            return
        try:
            observer.stop()
        except Exception:
            pass
        try:
            observer.join(timeout=1.0)
        except Exception:
            pass

    def _startLibraryObserver() -> None:
        if not _WATCHDOG_AVAILABLE or not state["running"]:
            return
        library_folder = get_library_folder()
        if not library_folder or not os.path.isdir(library_folder):
            return
        _startObserverForFolder("__library__", library_folder, isLibrary=True)
        _reconcileLibrary()

    def _stopLibraryObserver() -> None:
        _stopObserver("__library__")

    # ---- library reconcile (fallback + readiness) ----

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

    def _reconcileLibrary() -> None:
        library_folder = get_library_folder()
        if not library_folder or not os.path.isdir(library_folder):
            return
        known = _knownLibraryFiles()
        current = set(_listPdfsRecursive(library_folder, skip_managed=True))
        untracked = current - known
        for path in sorted(untracked):
            _scheduleImport(path, allow_library=True)

    def _reconcileWatchFolders() -> None:
        seen = state["seen"]
        for wf in repos["watchFolders"]["getEnabled"]():
            root = os.path.normpath(os.path.abspath(wf["path"]))
            if not os.path.isdir(root):
                continue
            current = set(_listPdfsRecursive(root))
            previous = seen.get(root)
            if previous is None:
                previous = set()
            seen[root] = current
            for path in sorted(current - previous):
                _scheduleImport(path)

    async def _reconcileLoop() -> None:
        while state["running"]:
            await asyncio.sleep(_LIBRARY_RECONCILE_INTERVAL_S)
            if not state["running"]:
                break
            try:
                _reconcileLibrary()
            except Exception:
                pass

    # ---- polling fallback ----

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

    # ---- lifecycle ----

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
        state["loop"] = loop
        if _WATCHDOG_AVAILABLE:
            for wf in repos["watchFolders"]["getEnabled"]():
                _startObserverForFolder(wf["id"], wf["path"])
            _startLibraryObserver()
            _reconcileWatchFolders()
            state["reconcileTask"] = loop.create_task(_reconcileLoop())
            return
        state["task"] = loop.create_task(_scanLoop())

    def stopScanning() -> None:
        state["running"] = False
        task = state["task"]
        state["task"] = None
        if task is not None and not task.done():
            task.cancel()
        reconcile_task = state["reconcileTask"]
        state["reconcileTask"] = None
        if reconcile_task is not None and not reconcile_task.done():
            reconcile_task.cancel()
        for folderId in list(state["observers"].keys()):
            _stopObserver(folderId)
        lock = state["lock"]
        if lock is not None:
            with lock:
                timer = state["debounceTimer"]
                if timer is not None:
                    timer.cancel()
                state["debounceTimer"] = None
                state["pending"] = set()
                stabilizers: dict[str, threading.Timer] = state["stabilizers"]
                for t in stabilizers.values():
                    try:
                        t.cancel()
                    except Exception:
                        pass
                stabilizers.clear()

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
