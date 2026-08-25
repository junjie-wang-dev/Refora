from __future__ import annotations

import asyncio
import inspect
import logging
import os
import sys
import threading
import time
from typing import Any, Awaitable, Callable, TypedDict

from refora_server.library.pdf_discovery import (
    MANAGED_PDF_DIRECTORIES,
    find_pdf_files,
)
from refora_server.library.paths import isInsideLibrary
from refora_server.repositories.errors import RepoError

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer as NativeObserver
    from watchdog.observers.polling import PollingObserver

    Observer = PollingObserver if sys.platform == "darwin" else NativeObserver

    _WATCHDOG_AVAILABLE = True
except Exception:
    _WATCHDOG_AVAILABLE = False
    FileSystemEventHandler = object  # type: ignore[assignment, misc]
    Observer = None  # type: ignore[assignment, misc]
    PollingObserver = None  # type: ignore[assignment, misc]


def _isPdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


_MANAGED_DIRECTORIES = MANAGED_PDF_DIRECTORIES
_HIDDEN_PREFIXES = (".",)

_AWAIT_WRITE_FINISH_MS = 2000
_AWAIT_WRITE_POLL_MS = 100
_DEBOUNCE_MS = 500
_LIBRARY_RECONCILE_INTERVAL_S = 30.0
_OBSERVER_LIFECYCLE_LOCK = threading.RLock()


def _listPdfsRecursive(folder: str) -> list[str]:
    return find_pdf_files(folder, skip_hidden=True)


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
    return False


class WatcherRepos(TypedDict, total=False):
    watchFolders: Any
    documents: Any


OnNewPdf = Callable[
    [list[str]],
    Awaitable[dict[str, Any] | None] | dict[str, Any] | None,
]
OnLibraryHealthCheck = Callable[[], Awaitable[Any] | Any]


class WatcherServiceDeps(TypedDict, total=False):
    onNewPdf: OnNewPdf
    getLibraryFolder: Callable[[], str]
    pollInterval: float
    observerPollInterval: float
    stabilityThresholdMs: int
    debounceMs: int
    onLibraryHealthCheck: OnLibraryHealthCheck
    libraryHealthInterval: float
    logger: Any


def createWatcherService(repos: WatcherRepos, deps: WatcherServiceDeps | None = None):
    deps = deps or {}
    on_new_pdf: OnNewPdf = deps.get("onNewPdf", lambda _paths: None)
    get_library_folder: Callable[[], str] = deps.get("getLibraryFolder", lambda: "")
    poll_interval: float = float(deps.get("pollInterval", 5.0))
    observer_poll_interval = float(deps.get("observerPollInterval", 1.0))
    stability_threshold_ms = int(deps.get("stabilityThresholdMs", _AWAIT_WRITE_FINISH_MS))
    debounce_ms = int(deps.get("debounceMs", _DEBOUNCE_MS))
    on_library_health_check: OnLibraryHealthCheck | None = deps.get("onLibraryHealthCheck")
    library_health_interval = float(deps.get("libraryHealthInterval", 600.0))
    logger = deps.get("logger") or logging.getLogger(__name__)

    state: dict[str, Any] = {
        "task": None,
        "running": False,
        "seen": {},
        "watchdog": _WATCHDOG_AVAILABLE,
        "observers": {},
        "observerLock": threading.RLock(),
        "loop": None,
        "lock": None,
        "stabilizers": {},
        "debounceTimer": None,
        "pending": set(),
        "reconcileTask": None,
        "startupTask": None,
        "observerFallbackTask": None,
        "failedObserverFolders": {},
        "skippedLibraryFiles": {},
        "libraryHealthCheck": on_library_health_check,
        "lastLibraryHealthCheckAt": None,
    }

    def _warning(message: str) -> None:
        try:
            logger.warning(message)
        except Exception:
            pass

    def _fileSignature(path: str) -> tuple[int, int, int, int] | None:
        try:
            stat = os.stat(path)
        except OSError:
            return None
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)

    def _shouldSuppressLibraryImport(path: str) -> bool:
        normalized = os.path.normpath(os.path.abspath(path))
        skipped: dict[str, tuple[int, int, int, int]] = state[
            "skippedLibraryFiles"
        ]
        previous = skipped.get(normalized)
        if previous is None:
            return False
        current = _fileSignature(normalized)
        if current == previous:
            return True
        skipped.pop(normalized, None)
        return False

    def _recordSkippedLibraryFiles(result: Any) -> None:
        if not isinstance(result, dict):
            return
        skipped_paths = result.get("skipped")
        if not isinstance(skipped_paths, list):
            return
        library_folder = get_library_folder()
        if not library_folder:
            return
        skipped: dict[str, tuple[int, int, int, int]] = state[
            "skippedLibraryFiles"
        ]
        for value in skipped_paths:
            if not isinstance(value, str) or not value:
                continue
            normalized = os.path.normpath(os.path.abspath(value))
            if not isInsideLibrary(normalized, library_folder):
                continue
            signature = _fileSignature(normalized)
            if signature is not None:
                skipped[normalized] = signature

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
        state["failedObserverFolders"].pop(watchId, None)
        _stopObserver(watchId)

    def toggle(watchId: str, enabled: bool) -> dict[str, Any]:
        wf = repos["watchFolders"]["toggle"](watchId, enabled)
        if state["running"]:
            if enabled:
                _startObserverForFolder(wf["id"], wf["path"])
            else:
                state["failedObserverFolders"].pop(wf["id"], None)
                _stopObserver(wf["id"])
        return wf

    # ---- import pipeline (debounce + await-write-finish) ----

    def _scheduleImport(path: str, *, allow_library: bool = False) -> None:
        if not path or not _isPdf(path):
            return
        path = os.path.normpath(os.path.abspath(path))
        if allow_library and _shouldSuppressLibraryImport(path):
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
        loop = _getLoop()
        if loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(_armDebounce)
        except RuntimeError:
            return

    def _armDebounce() -> None:
        if not state["running"]:
            return
        loop = _getLoop()
        if loop.is_closed():
            return
        lock = state["lock"]
        if lock is None:
            return
        with lock:
            timer = state["debounceTimer"]
            if timer is not None:
                timer.cancel()
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
                    loop.run_until_complete(_awaitResult(result))
                except Exception:
                    pass
        else:
            _recordSkippedLibraryFiles(result)

    async def _awaitResult(awaitable: Awaitable[Any]) -> None:
        try:
            result = await awaitable
            _recordSkippedLibraryFiles(result)
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
            def complete() -> None:
                with lock:
                    if stabilizers.get(path) is not t:
                        return
                    stabilizers.pop(path, None)
                _onStable(path, allow_library)

            t = threading.Timer(stability_threshold_ms / 1000.0, complete)
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
    ) -> bool:
        if not _WATCHDOG_AVAILABLE or not state["running"]:
            return False
        observer_lock: threading.RLock = state["observerLock"]
        with _OBSERVER_LIFECYCLE_LOCK, observer_lock:
            observers: dict[str, Any] = state["observers"]
            if folderId in observers:
                state["failedObserverFolders"].pop(folderId, None)
                return True
            if not folderPath or not os.path.isdir(folderPath):
                state["failedObserverFolders"][folderId] = (
                    folderPath,
                    isLibrary,
                )
                _warning(f"watcher observer path is unavailable: {folderPath}")
                return False
            library_folder = get_library_folder()
            handler = _PdfHandler(folderPath, library_folder, isLibrary=isLibrary)
            observer = None
            try:
                observer = (
                    Observer(timeout=observer_poll_interval)
                    if Observer is PollingObserver
                    else Observer()
                )
                observer.schedule(handler, folderPath, recursive=True)
                observer.start()
            except Exception as error:
                state["failedObserverFolders"][folderId] = (
                    folderPath,
                    isLibrary,
                )
                if observer is not None:
                    try:
                        observer.stop()
                        if getattr(observer, "is_alive", lambda: False)():
                            observer.join()
                    except Exception:
                        pass
                _warning(f"watcher observer failed for {folderPath}: {error}")
                return False
            observers[folderId] = observer
            state["failedObserverFolders"].pop(folderId, None)
            return True

    def _stopObserver(folderId: str) -> None:
        observer_lock: threading.RLock = state["observerLock"]
        with _OBSERVER_LIFECYCLE_LOCK, observer_lock:
            observers: dict[str, Any] = state["observers"]
            observer = observers.get(folderId)
            if observer is None:
                return
            observer.stop()
            observer.join()
            is_alive = getattr(observer, "is_alive", None)
            if callable(is_alive) and is_alive():
                raise RuntimeError("File system observer did not stop")
            observers.pop(folderId, None)

    def _startLibraryObserver() -> None:
        if not _WATCHDOG_AVAILABLE or not state["running"]:
            return
        library_folder = get_library_folder()
        if not library_folder or not os.path.isdir(library_folder):
            return
        _startObserverForFolder("__library__", library_folder, isLibrary=True)

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

    async def _reconcileLibraryAsync() -> None:
        library_folder = get_library_folder()
        if not library_folder or not os.path.isdir(library_folder):
            return
        known = _knownLibraryFiles()
        current = set(
            await asyncio.to_thread(
                find_pdf_files,
                library_folder,
                skip_hidden=True,
            )
        )
        untracked = current - known
        skipped: dict[str, tuple[int, int, int, int]] = state[
            "skippedLibraryFiles"
        ]
        for path in set(skipped) - untracked:
            skipped.pop(path, None)
        for path in sorted(untracked):
            _scheduleImport(path, allow_library=True)

    async def _reconcileWatchFoldersAsync() -> None:
        seen = state["seen"]
        folders = repos["watchFolders"]["getEnabled"]()
        for wf in folders:
            root = os.path.normpath(os.path.abspath(wf["path"]))
            if not os.path.isdir(root):
                continue
            current = set(
                await asyncio.to_thread(
                    find_pdf_files,
                    root,
                    skip_hidden=True,
                )
            )
            previous = seen.get(root)
            if previous is None:
                previous = set()
            seen[root] = current
            for path in sorted(current - previous):
                _scheduleImport(path)

    async def _startupReconcile() -> None:
        try:
            await _reconcileWatchFoldersAsync()
            await _reconcileLibraryAsync()
            await _maybeRunLibraryHealthCheck(force=True)
        except Exception as error:
            _warning(f"watcher startup reconciliation failed: {error}")

    async def _maybeRunLibraryHealthCheck(*, force: bool = False) -> None:
        callback = state["libraryHealthCheck"]
        if not callable(callback):
            return
        now = time.monotonic()
        last_check_at = state["lastLibraryHealthCheckAt"]
        if (
            not force
            and last_check_at is not None
            and now - last_check_at < library_health_interval
        ):
            return
        state["lastLibraryHealthCheckAt"] = now
        result = callback()
        if inspect.isawaitable(result):
            await result

    async def _reconcileLoop() -> None:
        while state["running"]:
            await asyncio.sleep(_LIBRARY_RECONCILE_INTERVAL_S)
            if not state["running"]:
                break
            try:
                await _reconcileLibraryAsync()
                await _maybeRunLibraryHealthCheck()
            except Exception as error:
                _warning(f"watcher library reconciliation failed: {error}")

    # ---- polling fallback ----

    def _scanFolderOnce(
        path: str,
        *,
        known: set[str] | None = None,
    ) -> list[str]:
        if not os.path.isdir(path):
            return []
        root = os.path.normpath(os.path.abspath(path))
        current = set(_listPdfsRecursive(root))
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
                )
            )
        return batch

    async def _scanFolderOnceAsync(
        path: str,
        *,
        known: set[str] | None = None,
    ) -> list[str]:
        if not os.path.isdir(path):
            return []
        root = os.path.normpath(os.path.abspath(path))
        current = set(
            await asyncio.to_thread(
                find_pdf_files,
                root,
                skip_hidden=True,
            )
        )
        previous = state["seen"].get(root)
        if previous is None:
            previous = known or set()
        state["seen"][root] = current
        return sorted(current - previous)

    async def _scanAllAsync() -> list[str]:
        batch: list[str] = []
        folders = repos["watchFolders"]["getEnabled"]()
        for wf in folders:
            batch.extend(await _scanFolderOnceAsync(wf["path"]))
        library_folder = get_library_folder()
        if library_folder:
            batch.extend(
                await _scanFolderOnceAsync(
                    library_folder,
                    known=_knownLibraryFiles(),
                )
            )
        return batch

    async def _scanLoop() -> None:
        while state["running"]:
            try:
                batch = await _scanAllAsync()
                if batch:
                    result = on_new_pdf(batch)
                    if inspect.isawaitable(result):
                        result = await result
                    _recordSkippedLibraryFiles(result)
                await _maybeRunLibraryHealthCheck()
            except Exception as error:
                _warning(f"watcher polling scan failed: {error}")
            await asyncio.sleep(poll_interval)

    async def _observerFallbackLoop() -> None:
        while state["running"]:
            try:
                batch: list[str] = []
                failed = list(state["failedObserverFolders"].values())
                for path, is_library in failed:
                    batch.extend(
                        await _scanFolderOnceAsync(
                            path,
                            known=_knownLibraryFiles() if is_library else None,
                        )
                    )
                if batch:
                    result = on_new_pdf(batch)
                    if inspect.isawaitable(result):
                        result = await result
                    _recordSkippedLibraryFiles(result)
            except Exception as error:
                _warning(f"watcher observer fallback scan failed: {error}")
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
            state["startupTask"] = loop.create_task(_startupReconcile())
            state["reconcileTask"] = loop.create_task(_reconcileLoop())
            state["observerFallbackTask"] = loop.create_task(
                _observerFallbackLoop()
            )
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
        startup_task = state["startupTask"]
        state["startupTask"] = None
        if startup_task is not None and not startup_task.done():
            startup_task.cancel()
        observer_fallback_task = state["observerFallbackTask"]
        state["observerFallbackTask"] = None
        if observer_fallback_task is not None and not observer_fallback_task.done():
            observer_fallback_task.cancel()
        state["failedObserverFolders"] = {}
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

    def setLibraryHealthCheck(callback: OnLibraryHealthCheck | None) -> None:
        state["libraryHealthCheck"] = callback
        state["lastLibraryHealthCheckAt"] = None

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
        "setLibraryHealthCheck": setLibraryHealthCheck,
        "_markStabilizing": _markStabilizing,
        "_state": state,
    }
