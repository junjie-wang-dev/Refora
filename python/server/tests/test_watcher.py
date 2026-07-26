import asyncio
import os

import pytest

from conftest import make_watch_folders_repo, open_migrated_db


def _make_watcher(
    repos,
    captured=None,
    poll_interval=0.05,
    library_folder="",
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
        },
    )


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
            await asyncio.sleep(0.1)
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


def test_startScanning_idempotent():
    db = open_migrated_db()
    try:
        wf_repo = make_watch_folders_repo(db)
        repos = {"watchFolders": wf_repo}
        svc = _make_watcher(repos, poll_interval=0.5)

        async def run():
            svc["startScanning"]()
            first_task = svc["_state"]["task"]
            svc["startScanning"]()
            assert svc["_state"]["task"] is first_task
            svc["stopScanning"]()

        asyncio.run(run())
    finally:
        db.close()
