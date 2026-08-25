import asyncio
import os
import threading
import time

import pytest

from conftest import make_watch_folders_repo, open_migrated_db

from refora_server.services import watcher as watcher_module


def _make_watcher(
    repos,
    captured=None,
    poll_interval=0.05,
    library_folder="",
    stability_threshold_ms=80,
    debounce_ms=40,
):
    from refora_server.services.watcher import createWatcherService

    def on_new_pdf(paths):
        if captured is not None:
            captured.extend(paths)
        return None

    return createWatcherService(
        repos,
        {
            "onNewPdf": on_new_pdf,
            "getLibraryFolder": lambda: library_folder,
            "pollInterval": poll_interval,
            "observerPollInterval": poll_interval,
            "stabilityThresholdMs": stability_threshold_ms,
            "debounceMs": debounce_ms,
        },
    )


def _wait_for(predicate, timeout=3.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def test_list_returns_repo_list():
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        assert svc["list"]() == []
        wf_repo["add"]("/lib/papers")
        rows = svc["list"]()
        assert len(rows) == 1
        assert rows[0]["path"] == "/lib/papers"
    finally:
        db.close()


def test_add_delegates_to_repo(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        wf = svc["add"](str(tmp_path))
        assert wf["path"] == os.path.normpath(str(tmp_path))
        assert wf["enabled"] == 1
    finally:
        db.close()


def test_remove_delegates_to_repo(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        wf = svc["add"](str(tmp_path))
        svc["remove"](wf["id"])
        assert svc["list"]() == []
    finally:
        db.close()


def test_toggle_delegates_to_repo(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        wf = svc["add"](str(tmp_path))
        updated = svc["toggle"](wf["id"], False)
        assert updated["enabled"] == 0
        updated = svc["toggle"](wf["id"], True)
        assert updated["enabled"] == 1
    finally:
        db.close()


def test_scanOnce_detects_new_pdfs(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        (tmp_path / "a.pdf").write_bytes(b"%PDF-1.4")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "b.pdf").write_bytes(b"%PDF-1.4")
        (tmp_path / "ignore.txt").write_text("nope")
        svc["add"](str(tmp_path))
        new = svc["scanOnce"]()
        assert len(new) == 2
        assert all(p.lower().endswith(".pdf") for p in new)
        second = svc["scanOnce"]()
        assert second == []
    finally:
        db.close()


def test_event_path_allows_visible_directories_containing_dots():
    root = "/Volumes/Research.v2"
    path = "/Volumes/Research.v2/Papers.final/article.pdf"

    assert watcher_module._shouldIgnorePath(path, root, "") is False


def test_scanOnce_skips_disabled_folders(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        (tmp_path / "a.pdf").write_bytes(b"%PDF")
        wf = svc["add"](str(tmp_path))
        svc["toggle"](wf["id"], False)
        assert svc["scanOnce"]() == []
    finally:
        db.close()


def test_scanOnce_skips_nonexistent_path():
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        wf_repo["add"]("/does/not/exist")
        assert svc["scanOnce"]() == []
    finally:
        db.close()


def test_scan_once_reconciles_untracked_library_pdfs(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        tracked = tmp_path / "tracked.pdf"
        untracked = tmp_path / "untracked.pdf"
        managed = tmp_path / ".refora" / "derived.pdf"
        tracked.write_bytes(b"%PDF")
        untracked.write_bytes(b"%PDF")
        managed.parent.mkdir()
        managed.write_bytes(b"%PDF")
        repos = {
            "watchFolders": wf_repo,
            "documents": {
                "list": lambda _filter: [{"filePath": str(tracked)}],
            },
        }
        svc = _make_watcher(repos, library_folder=str(tmp_path))

        assert svc["scanOnce"]() == [str(untracked)]
        assert svc["scanOnce"]() == []
    finally:
        db.close()


def test_scan_once_skips_hidden_managed_and_symlinked_pdfs(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        visible = tmp_path / "visible.pdf"
        visible.write_bytes(b"%PDF")
        hidden = tmp_path / ".hidden" / "hidden.pdf"
        hidden.parent.mkdir()
        hidden.write_bytes(b"%PDF")
        managed = tmp_path / "refora-assets" / "derived.pdf"
        managed.parent.mkdir()
        managed.write_bytes(b"%PDF")
        outside = tmp_path.parent / "outside.pdf"
        outside.write_bytes(b"%PDF")
        (tmp_path / "linked.pdf").symlink_to(outside)
        svc = _make_watcher({"watchFolders": wf_repo})
        svc["add"](str(tmp_path))

        assert svc["scanOnce"]() == [str(visible)]
    finally:
        db.close()


def test_library_scan_detects_recreated_pdf(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        pdf = tmp_path / "paper.pdf"
        repos = {
            "watchFolders": wf_repo,
            "documents": {"list": lambda _filter: []},
        }
        svc = _make_watcher(repos, library_folder=str(tmp_path))
        pdf.write_bytes(b"%PDF")
        assert svc["scanOnce"]() == [str(pdf)]
        pdf.unlink()
        assert svc["scanOnce"]() == []
        pdf.write_bytes(b"%PDF")
        assert svc["scanOnce"]() == [str(pdf)]
    finally:
        db.close()


def test_startScanning_invokes_onNewPdf(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured, poll_interval=0.02)
        (tmp_path / "a.pdf").write_bytes(b"%PDF")
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            await asyncio.sleep(0.2)
            svc["stopScanning"]()

        asyncio.run(run())
        assert any(p.lower().endswith(".pdf") for p in captured)
    finally:
        db.close()


def test_stopScanning_marks_not_running():
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos, poll_interval=0.5)

        async def run():
            svc["startScanning"]()
            assert svc["_state"]["running"] is True
            svc["stopScanning"]()
            assert svc["_state"]["running"] is False

        asyncio.run(run())
    finally:
        db.close()


def test_completed_stabilizer_is_removed_from_state(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        svc = _make_watcher(
            {"watchFolders": wf_repo},
            stability_threshold_ms=10,
            debounce_ms=100,
        )
        path = str(tmp_path / "stable.pdf")
        (tmp_path / "stable.pdf").write_bytes(b"%PDF")

        svc["_markStabilizing"](path)

        assert _wait_for(lambda: path not in svc["_state"]["stabilizers"])
        svc["stopScanning"]()
    finally:
        db.close()


def test_watchdog_timer_schedules_debounce_on_event_loop_thread(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", False)
    db = open_migrated_db()
    try:
        captured: list[str] = []
        svc = _make_watcher(
            {"watchFolders": make_watch_folders_repo(db)},
            captured=captured,
            poll_interval=1,
            stability_threshold_ms=10,
            debounce_ms=10,
        )
        path = str(tmp_path / "thread-safe.pdf")
        (tmp_path / "thread-safe.pdf").write_bytes(b"%PDF")

        async def run():
            asyncio.get_running_loop().set_debug(True)
            svc["startScanning"]()
            try:
                svc["_markStabilizing"](path)
                for _ in range(50):
                    if captured:
                        break
                    await asyncio.sleep(0.01)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert captured == [path]
    finally:
        db.close()


def test_watchdog_timer_tolerates_loop_closing_race(tmp_path, monkeypatch):
    class ClosingLoop:
        def is_closed(self):
            return False

        def call_soon_threadsafe(self, _callback):
            raise RuntimeError("Event loop is closed")

    db = open_migrated_db()
    errors = []
    monkeypatch.setattr(threading, "excepthook", lambda args: errors.append(args.exc_value))
    try:
        svc = _make_watcher(
            {"watchFolders": make_watch_folders_repo(db)},
            stability_threshold_ms=10,
        )
        path = str(tmp_path / "closing.pdf")
        (tmp_path / "closing.pdf").write_bytes(b"%PDF")
        svc["_state"]["running"] = True
        svc["_state"]["loop"] = ClosingLoop()

        svc["_markStabilizing"](path)

        assert _wait_for(lambda: path not in svc["_state"]["stabilizers"])
        assert errors == []
        svc["_state"]["running"] = False
    finally:
        db.close()


def test_startScanning_idempotent():
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos, poll_interval=0.5)

        async def run():
            svc["startScanning"]()
            first_running = svc["_state"]["running"]
            svc["startScanning"]()
            assert svc["_state"]["running"] is first_running
            svc["stopScanning"]()

        asyncio.run(run())
    finally:
        db.close()


def test_fallback_scan_loop_runs_library_health_check(monkeypatch):
    monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", False)
    db = open_migrated_db()
    checks: list[None] = []
    try:
        async def run():
            def on_library_health_check():
                checks.append(None)
                svc["_state"]["running"] = False

            svc = watcher_module.createWatcherService(
                {"watchFolders": make_watch_folders_repo(db)},
                {
                    "onNewPdf": lambda _paths: None,
                    "getLibraryFolder": lambda: "",
                    "pollInterval": 0.01,
                    "onLibraryHealthCheck": on_library_health_check,
                    "libraryHealthInterval": 600,
                },
            )
            svc["startScanning"]()
            try:
                task = svc["_state"]["task"]
                assert task is not None
                await asyncio.wait_for(task, timeout=1)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert checks == [None]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Event-driven (watchdog) tests. These exercise the live filesystem.
# ---------------------------------------------------------------------------


def _watchdog_available() -> bool:
    return watcher_module._WATCHDOG_AVAILABLE


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_detects_new_pdf(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.15)
                (tmp_path / "new.pdf").write_bytes(b"%PDF-1.4")
                await asyncio.sleep(0.6)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert any(
            os.path.normpath(p) == os.path.normpath(str(tmp_path / "new.pdf"))
            for p in captured
        )
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_ignores_non_pdf(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.15)
                (tmp_path / "notes.txt").write_text("hello")
                (tmp_path / "image.png").write_bytes(b"\x89PNG")
                await asyncio.sleep(0.5)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert captured == []
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_ignores_hidden_and_managed_dirs(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.15)
                hidden = tmp_path / ".hidden"
                hidden.mkdir()
                (hidden / "secret.pdf").write_bytes(b"%PDF")
                asset = tmp_path / "refora-assets"
                asset.mkdir()
                (asset / "asset.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.5)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert captured == []
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_await_write_finish(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(
            repos,
            captured=captured,
            stability_threshold_ms=300,
            debounce_ms=40,
        )
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.15)
                pdf = tmp_path / "big.pdf"
                pdf.write_bytes(b"%PDF-1.4 partial")
                await asyncio.sleep(0.15)
                assert not captured, "import fired before write finished"
                pdf.write_bytes(b"%PDF-1.4 complete")
                await asyncio.sleep(0.7)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert any(
            os.path.normpath(p) == os.path.normpath(str(tmp_path / "big.pdf"))
            for p in captured
        )
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_debounces_burst(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[list[str]] = []
        from refora_server.services.watcher import createWatcherService

        def on_new_pdf(paths):
            captured.append(list(paths))
            return None

        svc = createWatcherService(
            repos,
            {
                "onNewPdf": on_new_pdf,
                "getLibraryFolder": lambda: "",
                "observerPollInterval": 0.05,
                "stabilityThresholdMs": 60,
                "debounceMs": 120,
            },
        )
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.15)
                for i in range(5):
                    (tmp_path / f"doc-{i}.pdf").write_bytes(b"%PDF")
                    await asyncio.sleep(0.02)
                await asyncio.sleep(0.8)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        total = sum(len(b) for b in captured)
        assert total == 5, f"expected 5 imports, got {total}: {captured}"
        assert len(captured) <= 2, f"expected debounce aggregation, got {len(captured)} batches"
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_add_starts_observer_dynamically(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.1)
                wf = svc["add"](str(tmp_path))
                assert wf["id"] in svc["_state"]["observers"]
                await asyncio.sleep(0.15)
                (tmp_path / "added.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.6)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert any(
            os.path.normpath(p) == os.path.normpath(str(tmp_path / "added.pdf"))
            for p in captured
        )
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_remove_stops_observer(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)
        wf = svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                assert wf["id"] in svc["_state"]["observers"]
                svc["remove"](wf["id"])
                assert wf["id"] not in svc["_state"]["observers"]
                await asyncio.sleep(0.2)
                (tmp_path / "after-remove.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.5)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert captured == []
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_can_restart_immediately_after_a_full_stop(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos)
        svc["add"](str(tmp_path))

        async def run():
            for _ in range(5):
                svc["startScanning"]()
                await asyncio.sleep(0)
                observers = tuple(svc["_state"]["observers"].values())
                assert observers
                svc["stopScanning"]()
                assert svc["_state"]["observers"] == {}
                assert all(not observer.is_alive() for observer in observers)

        asyncio.run(run())
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_toggle_stops_and_starts_observer(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured)
        wf = svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                svc["toggle"](wf["id"], False)
                assert wf["id"] not in svc["_state"]["observers"]
                await asyncio.sleep(0.15)
                (tmp_path / "disabled.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.4)
                assert captured == []
                svc["toggle"](wf["id"], True)
                assert wf["id"] in svc["_state"]["observers"]
                await asyncio.sleep(0.15)
                (tmp_path / "enabled.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.6)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert any(
            os.path.normpath(p) == os.path.normpath(str(tmp_path / "enabled.pdf"))
            for p in captured
        )
        assert not any("disabled.pdf" in p for p in captured)
    finally:
        db.close()


def test_observer_start_failure_uses_polling_fallback_and_logs(tmp_path, monkeypatch):
    class FailingObserver:
        def schedule(self, *_args, **_kwargs):
            return None

        def start(self):
            raise RuntimeError("observer unavailable")

    class Logger:
        def __init__(self):
            self.messages: list[str] = []

        def warning(self, message):
            self.messages.append(str(message))

    monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", True)
    monkeypatch.setattr(watcher_module, "Observer", FailingObserver)
    db = open_migrated_db()
    try:
        watch_folders = make_watch_folders_repo(db)
        watched = watch_folders["add"](str(tmp_path))
        captured: list[str] = []
        logger = Logger()
        service = watcher_module.createWatcherService(
            {"watchFolders": watch_folders},
            {
                "onNewPdf": lambda paths: captured.extend(paths),
                "pollInterval": 0.03,
                "logger": logger,
            },
        )

        async def run():
            service["startScanning"]()
            try:
                await asyncio.sleep(0.08)
                (tmp_path / "fallback.pdf").write_bytes(b"%PDF")
                deadline = time.monotonic() + 1
                while not captured and time.monotonic() < deadline:
                    await asyncio.sleep(0.03)
            finally:
                service["stopScanning"]()

        asyncio.run(run())
        assert watched["id"] not in service["_state"]["observers"]
        assert str(tmp_path / "fallback.pdf") in captured
        assert any("observer unavailable" in message for message in logger.messages)
    finally:
        db.close()


@pytest.mark.skipif(not _watchdog_available(), reason="watchdog not installed")
def test_event_driven_library_reconcile_on_start(tmp_path):
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        tracked = tmp_path / "tracked.pdf"
        untracked = tmp_path / "untracked.pdf"
        tracked.write_bytes(b"%PDF")
        untracked.write_bytes(b"%PDF")
        repos = {
            "watchFolders": wf_repo,
            "documents": {"list": lambda _filter: [{"filePath": str(tracked)}]},
        }
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured, library_folder=str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.5)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert any(
            os.path.normpath(p) == os.path.normpath(str(untracked))
            for p in captured
        )
    finally:
        db.close()


def test_library_reconcile_suppresses_unchanged_skipped_pdf(tmp_path, monkeypatch):
    db = open_migrated_db()
    try:
        class ObserverStub:
            def schedule(self, *_args, **_kwargs):
                return None

            def start(self):
                return None

            def stop(self):
                return None

            def join(self, **_kwargs):
                return None

        monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", True)
        monkeypatch.setattr(watcher_module, "Observer", ObserverStub)
        monkeypatch.setattr(
            watcher_module,
            "_LIBRARY_RECONCILE_INTERVAL_S",
            0.05,
        )
        wf_repo = make_watch_folders_repo(db)
        duplicate = tmp_path / "duplicate.pdf"
        duplicate.write_bytes(b"%PDF-1.7 duplicate")
        repos = {
            "watchFolders": wf_repo,
            "documents": {"list": lambda _filter: []},
        }
        captured: list[list[str]] = []

        def on_new_pdf(paths):
            captured.append(list(paths))
            return {"imported": [], "skipped": list(paths), "errors": []}

        from refora_server.services.watcher import createWatcherService

        svc = createWatcherService(
            repos,
            {
                "onNewPdf": on_new_pdf,
                "getLibraryFolder": lambda: str(tmp_path),
                "stabilityThresholdMs": 80,
                "debounceMs": 20,
            },
        )

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.25)
                assert captured == [[str(duplicate)]]
                duplicate.write_bytes(b"%PDF-1.7 replacement content")
                await asyncio.sleep(0.35)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert captured == [[str(duplicate)], [str(duplicate)]]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Fallback path: simulate watchdog unavailable.
# ---------------------------------------------------------------------------


def test_fallback_uses_polling_when_watchdog_unavailable(tmp_path, monkeypatch):
    db = open_migrated_db()
    try:
        monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", False)
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        captured: list[str] = []
        svc = _make_watcher(repos, captured=captured, poll_interval=0.02)
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            try:
                await asyncio.sleep(0.1)
                (tmp_path / "poll.pdf").write_bytes(b"%PDF")
                await asyncio.sleep(0.2)
            finally:
                svc["stopScanning"]()

        asyncio.run(run())
        assert svc["_state"]["watchdog"] is False
        assert any(p.lower().endswith(".pdf") for p in captured)
    finally:
        db.close()


def test_fallback_no_observers_created(tmp_path, monkeypatch):
    db = open_migrated_db()
    try:
        monkeypatch.setattr(watcher_module, "_WATCHDOG_AVAILABLE", False)
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos, poll_interval=0.2)
        svc["add"](str(tmp_path))

        async def run():
            svc["startScanning"]()
            assert svc["_state"]["observers"] == {}
            svc["stopScanning"]()

        asyncio.run(run())
    finally:
        db.close()
