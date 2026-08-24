from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path

import pytest
import refora_server.services.workspaces as workspaces_module

from conftest import (
    make_workspace_assets_repo,
    make_workspace_canvas_repo,
    make_workspace_connections_repo,
    make_workspace_items_repo,
    make_workspace_notes_repo,
    make_workspaces_repo,
    open_migrated_db,
    make_docs_repo,
)
from refora_server.repositories.errors import RepoError
from refora_server.repositories.settings import SettingsRepository
from refora_server.services.workspaces import (
    WORKSPACE_ASSET_DIRECTORY,
    WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT,
    createWorkspacesService,
)


def _make_settings_repo(db):
    return SettingsRepository(db)


def _build_repos(db, library_folder: str = ""):
    repos = {
        "workspaces": make_workspaces_repo(db),
        "workspaceItems": make_workspace_items_repo(db),
        "workspaceAssets": make_workspace_assets_repo(db),
        "workspaceCanvas": make_workspace_canvas_repo(db),
        "workspaceConnections": make_workspace_connections_repo(db),
        "workspaceNotes": make_workspace_notes_repo(db),
        "documents": make_docs_repo(db, library_folder),
        "settings": _make_settings_repo(db),
    }

    def transaction(fn):
        try:
            db.execute("BEGIN")
            result = fn()
            db.execute("COMMIT")
            return result
        except Exception:
            db.execute("ROLLBACK")
            raise

    repos["transaction"] = transaction
    if library_folder:
        repos["settings"].set("libraryFolderPath", library_folder)
    return repos


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def library_dir(tmp_path):
    folder = tmp_path / "library"
    folder.mkdir()
    return str(folder)


@pytest.fixture
def repos(db, library_dir):
    return _build_repos(db, library_dir)


@pytest.fixture
def service(repos):
    return createWorkspacesService(repos)


def _make_workspace(service, name="Research"):
    return service["createWorkspace"](name)


class _FakeConnector:
    def __init__(self):
        self.opened = []
        self.shown = []
        self.trashed = []
        self.open_path_result = ""

    def openPath(self, path):
        self.opened.append(path)
        return self.open_path_result

    def showInFolder(self, path):
        self.shown.append(path)

    def trashItem(self, path):
        self.trashed.append(path)


class TestWorkspacesCrud:
    def test_list_empty(self, service):
        assert service["listWorkspaces"]() == []

    def test_create_and_list(self, service):
        w = service["createWorkspace"]("Research")
        assert w["name"] == "Research"
        assert w["id"]
        listed = service["listWorkspaces"]()
        assert len(listed) == 1
        assert listed[0]["id"] == w["id"]

    def test_update(self, service):
        w = service["createWorkspace"]("Old")
        updated = service["updateWorkspace"](w["id"], "  New  ")
        assert updated["name"] == "New"

    @pytest.mark.parametrize("operation", ["createWorkspace", "updateWorkspace"])
    def test_create_and_update_reject_blank_names(self, service, operation):
        args = ("   ",)
        if operation == "updateWorkspace":
            workspace = service["createWorkspace"]("Existing")
            args = (workspace["id"], "   ")
        with pytest.raises(RepoError) as exc:
            service[operation](*args)
        assert exc.value.code == "invalid_name"

    def test_update_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["updateWorkspace"]("nope", "New")
        assert exc.value.code == "not_found"

    @pytest.mark.asyncio
    async def test_delete_removes_workspace(self, service):
        w = service["createWorkspace"]("Gone")
        await service["deleteWorkspace"](w["id"])
        assert service["listWorkspaces"]() == []

    @pytest.mark.asyncio
    async def test_delete_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            await service["deleteWorkspace"]("nope")
        assert exc.value.code == "not_found"


class TestWorkspaceSandboxAndCascade:
    @pytest.mark.asyncio
    async def test_create_with_sandbox_ensures_and_rolls_back_on_failure(
        self, repos, tmp_path
    ):
        connector = _FakeConnector()
        sandbox_roots: dict[str, str] = {}

        def ensure(wid):
            sandbox_roots[wid] = str(tmp_path / "sandboxes" / wid)
            raise RepoError("invalid_path", "sandbox ensure failed")

        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "sandbox": {"ensure": ensure},
            },
        )
        with pytest.raises(RepoError) as exc:
            await svc["createWorkspaceWithSandbox"]("Research")
        assert exc.value.code == "invalid_path"
        assert svc["listWorkspaces"]() == []
        assert sandbox_roots

    @pytest.mark.asyncio
    async def test_delete_cleans_threads_sandbox_and_assets(
        self, repos, db, tmp_path
    ):
        w = repos["workspaces"]["create"]("Research")
        sandbox_root = tmp_path / "sandboxes" / w["id"]
        sandbox_root.mkdir(parents=True)
        connector = _FakeConnector()

        deleted_threads: list[str] = []
        deleted_frontiers: list[str] = []

        class FakeRuntime:
            async def deleteThread(self, thread_id):
                deleted_threads.append(thread_id)

        class FakeFrontier:
            async def delete_thread(self, thread_id):
                deleted_frontiers.append(thread_id)

        chat = repos.get("chat")
        if chat is None:
            chat = {}
            repos["chat"] = chat
        chat["listThreads"] = lambda workspace_id: [
            {"id": "thread-1", "workspaceId": workspace_id},
            {"id": "thread-2", "workspaceId": workspace_id},
        ]

        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "getSandboxPath": lambda wid: str(sandbox_root),
                "agentRuntime": {"deleteThread": FakeRuntime().deleteThread},
                "academic": {"frontier": {"delete_thread": FakeFrontier().delete_thread}},
            },
        )
        await svc["deleteWorkspace"](w["id"])

        assert svc["listWorkspaces"]() == []
        assert deleted_threads == ["thread-1", "thread-2"]
        assert deleted_frontiers == ["thread-1", "thread-2"]
        assert sandbox_root in [Path(p) for p in connector.trashed] or str(
            sandbox_root
        ) in connector.trashed


class TestOpenSandbox:
    @pytest.mark.asyncio
    async def test_open_sandbox_via_connector(self, repos):
        w = repos["workspaces"]["create"]("Research")
        connector = _FakeConnector()
        sandbox_roots = {}

        def ensure(wid):
            sandbox_roots[wid] = f"/sandbox/{wid}"
            return {"sandboxRoot": f"/sandbox/{wid}"}

        svc = createWorkspacesService(
            repos, {"connector": connector, "sandbox": {"ensure": ensure}}
        )
        await svc["openSandbox"](w["id"])
        assert connector.opened == [f"/sandbox/{w['id']}"]

    @pytest.mark.asyncio
    async def test_open_sandbox_missing_workspace(self, repos):
        connector = _FakeConnector()
        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "sandbox": {"ensure": lambda wid: {"sandboxRoot": "/x"}},
            },
        )
        with pytest.raises(RepoError) as exc:
            await svc["openSandbox"]("nope")
        assert exc.value.code == "not_found"
        assert connector.opened == []

    @pytest.mark.asyncio
    async def test_open_sandbox_no_sandbox_dep(self, repos):
        w = repos["workspaces"]["create"]("Research")
        svc = createWorkspacesService(repos, {"connector": _FakeConnector()})
        with pytest.raises(RepoError) as exc:
            await svc["openSandbox"](w["id"])
        assert exc.value.code == "not_ready"

    @pytest.mark.asyncio
    async def test_open_sandbox_open_failure(self, repos):
        w = repos["workspaces"]["create"]("Research")
        connector = _FakeConnector()
        connector.open_path_result = "boom"
        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "sandbox": {"ensure": lambda wid: {"sandboxRoot": "/sandbox/" + wid}},
            },
        )
        with pytest.raises(RepoError) as exc:
            await svc["openSandbox"](w["id"])
        assert exc.value.code == "open_failed"

    @pytest.mark.asyncio
    async def test_open_sandbox_uses_configured_workspace_path(self, repos, tmp_path):
        w = repos["workspaces"]["create"]("Research")
        connector = _FakeConnector()
        sandbox_root = tmp_path / "sandboxes" / w["id"]
        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "getSandboxPath": lambda _wid: str(sandbox_root),
            },
        )

        await svc["openSandbox"](w["id"])

        assert sandbox_root.is_dir()
        assert connector.opened == [str(sandbox_root)]

class TestItems:
    def test_list_empty(self, service):
        w = _make_workspace(service)
        assert service["listItems"](w["id"]) == []

    def test_add_document_item(self, db, service, repos):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        assert len(items) == 1
        assert items[0]["kind"] == "document"
        assert items[0]["docId"] == "doc-1"

    def test_delete_item(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        service["deleteItem"](w["id"], items[0]["id"])
        assert service["listItems"](w["id"]) == []

    def test_reorder_items(self, db, service):
        from conftest import insert_doc

        for i in range(3):
            insert_doc(db, id=f"doc-{i}")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-0", "doc-1", "doc-2"])
        order = [items[2]["id"], items[0]["id"], items[1]["id"]]
        service["reorderItems"](w["id"], order)
        listed = service["listItems"](w["id"])
        assert [it["id"] for it in listed] == order

    def test_reorder_invalid_set_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["reorderItems"](w["id"], ["wrong"])
        assert exc.value.code == "invalid_order"

    def test_resize_item(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        resized = service["resizeItem"](w["id"], items[0]["id"], 400, 300)
        assert resized["width"] == 400
        assert resized["height"] == 300

    def test_resize_invalid_size_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["resizeItem"](w["id"], items[0]["id"], 0, 100)
        assert exc.value.code == "invalid_size"

    def test_move_item(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        moved = service["moveItem"](w["id"], items[0]["id"], 12.5, 34.0, 5)
        assert moved["x"] == 12.5
        assert moved["y"] == 34.0
        assert moved["zIndex"] == 5

    def test_move_invalid_position_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["moveItem"](w["id"], items[0]["id"], float("nan"), 0, 1)
        assert exc.value.code == "invalid_position"

    def test_item_mutations_reject_another_workspace_scope(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        source = _make_workspace(service, "Source")
        other = _make_workspace(service, "Other")
        item = service["addItems"](source["id"], "document", ["doc-1"])[0]
        with pytest.raises(RepoError) as exc:
            service["moveItem"](other["id"], item["id"], 99, 99, 9)
        assert exc.value.code == "not_found"
        assert service["getItem"](item["id"])["workspaceId"] == source["id"]
        assert service["getItem"](item["id"])["x"] != 99

    def test_add_with_placement_offsets(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        insert_doc(db, id="doc-2")
        w = _make_workspace(service)
        items = service["addItems"](
            w["id"], "document", ["doc-1", "doc-2"], {"x": 100.0, "y": 100.0}
        )
        assert items[0]["x"] == 100.0
        assert items[1]["x"] == 100.0 + 28


class TestAssetsImport:
    def _write_source(self, library_dir, name, content=b"hello"):
        path = os.path.join(library_dir, "sources", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(content)
        return path

    def test_import_single_file(self, service, repos, library_dir):
        src = self._write_source(library_dir, "note.txt", b"hello world")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        assert result["errors"] == []
        assert len(result["imported"]) == 1
        asset = result["imported"][0]
        assert asset["fileName"] == "note.txt"
        assert asset["previewKind"] == "text"
        assert asset["mimeType"] == "text/plain"
        assert asset["fileSize"] == len(b"hello world")
        assert len(asset["fileHash"]) == 64
        dest = os.path.join(library_dir, WORKSPACE_ASSET_DIRECTORY, asset["id"], "note.txt")
        assert os.path.isfile(dest)

    def test_import_creates_asset_item(self, service, library_dir):
        src = self._write_source(library_dir, "pic.png", b"\x89PNG")
        w = _make_workspace(service)
        service["importAssets"](w["id"], [src])
        items = service["listItems"](w["id"])
        assert len(items) == 1
        assert items[0]["kind"] == "asset"

    def test_import_with_placement(self, service, library_dir):
        src = self._write_source(library_dir, "note.txt", b"hi")
        w = _make_workspace(service)
        service["importAssets"](w["id"], [src], {"x": 50.0, "y": 50.0})
        items = service["listItems"](w["id"])
        assert items[0]["x"] == 50.0
        assert items[0]["y"] == 50.0

    def test_import_dedupes_paths(self, service, library_dir):
        src = self._write_source(library_dir, "note.txt", b"hi")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src, src])
        assert len(result["imported"]) == 1

    def test_import_missing_file_records_error(self, service, library_dir):
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], ["/abs/missing.txt"])
        assert len(result["imported"]) == 0
        assert len(result["errors"]) == 1
        assert result["errors"][0]["path"] == "/abs/missing.txt"

    def test_import_relative_path_rejected(self, service, library_dir):
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], ["relative.txt"])
        assert len(result["imported"]) == 0
        assert result["errors"][0]["path"] == "relative.txt"

    def test_import_symlink_rejected(self, service, library_dir):
        source = self._write_source(library_dir, "source.txt", b"hi")
        link = os.path.join(library_dir, "link.txt")
        os.symlink(source, link)
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [link])
        assert result["imported"] == []
        assert result["errors"][0]["path"] == link

    def test_import_rejects_file_over_size_limit(
        self, service, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "large.bin", b"12345")
        monkeypatch.setattr(workspaces_module, "WORKSPACE_ASSET_IMPORT_LIMIT", 4)
        workspace = _make_workspace(service)

        result = service["importAssets"](workspace["id"], [src])

        assert result["imported"] == []
        assert "512 MiB limit" in result["errors"][0]["message"]
        assert service["listAssets"](workspace["id"]) == []
        assert not (Path(library_dir) / WORKSPACE_ASSET_DIRECTORY).exists()

    def test_import_rejects_insufficient_disk_space(
        self, service, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "asset.bin", b"12345")
        monkeypatch.setattr(
            workspaces_module.shutil,
            "disk_usage",
            lambda _path: type("Usage", (), {"free": 0})(),
        )
        workspace = _make_workspace(service)

        result = service["importAssets"](workspace["id"], [src])

        assert result["imported"] == []
        assert "Not enough disk space" in result["errors"][0]["message"]
        assert service["listAssets"](workspace["id"]) == []
        asset_root = Path(library_dir) / WORKSPACE_ASSET_DIRECTORY
        assert not asset_root.exists() or list(asset_root.iterdir()) == []

    def test_atomic_publish_failure_removes_staged_file_and_record(
        self, service, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "asset.bin", b"payload")

        def fail_replace(_source, _destination):
            raise OSError("publish failed")

        monkeypatch.setattr(workspaces_module.os, "replace", fail_replace)
        workspace = _make_workspace(service)

        result = service["importAssets"](workspace["id"], [src])

        assert result["imported"] == []
        assert "publish failed" in result["errors"][0]["message"]
        assert service["listAssets"](workspace["id"]) == []
        assert service["listItems"](workspace["id"]) == []
        asset_root = Path(library_dir) / WORKSPACE_ASSET_DIRECTORY
        assert not asset_root.exists() or list(asset_root.iterdir()) == []

    def test_database_failure_rolls_back_record_and_removes_published_file(
        self, service, repos, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "asset.bin", b"payload")
        workspace = _make_workspace(service)

        def fail_item_insert(*_args, **_kwargs):
            raise RepoError("insert_failed", "item insert failed")

        monkeypatch.setitem(repos["workspaceItems"], "add", fail_item_insert)

        result = service["importAssets"](workspace["id"], [src])

        assert result["imported"] == []
        assert "item insert failed" in result["errors"][0]["message"]
        assert service["listAssets"](workspace["id"]) == []
        assert service["listItems"](workspace["id"]) == []
        asset_root = Path(library_dir) / WORKSPACE_ASSET_DIRECTORY
        assert not asset_root.exists() or list(asset_root.iterdir()) == []

    @pytest.mark.asyncio
    async def test_async_import_does_not_block_event_loop(
        self, service, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "asset.bin", b"payload")
        workspace = _make_workspace(service)
        original_stage = workspaces_module._stage_asset_file
        started = threading.Event()
        release = threading.Event()

        def delayed_stage(*args, **kwargs):
            started.set()
            if not release.wait(0.5):
                raise TimeoutError("test release timed out")
            return original_stage(*args, **kwargs)

        monkeypatch.setattr(workspaces_module, "_stage_asset_file", delayed_stage)
        task = asyncio.create_task(
            service["importAssetsAsync"](workspace["id"], [src])
        )
        try:
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.001)
            assert started.is_set()
            assert not task.done()
        finally:
            release.set()

        result = await task
        assert len(result["imported"]) == 1

    @pytest.mark.asyncio
    async def test_cancelled_async_import_removes_staged_directory(
        self, service, library_dir, monkeypatch
    ):
        src = self._write_source(library_dir, "asset.bin", b"payload")
        workspace = _make_workspace(service)
        started = threading.Event()

        def cancellable_stage(_source, destination, _size, cancelled):
            temporary = Path(destination).parent / ".refora-import-test.tmp"
            temporary.write_bytes(b"partial")
            started.set()
            if not cancelled.wait(1):
                raise TimeoutError("cancellation was not delivered")
            raise asyncio.CancelledError

        monkeypatch.setattr(workspaces_module, "_stage_asset_file", cancellable_stage)
        task = asyncio.create_task(
            service["importAssetsAsync"](workspace["id"], [src])
        )
        assert await asyncio.to_thread(started.wait, 1)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert service["listAssets"](workspace["id"]) == []
        asset_root = Path(library_dir) / WORKSPACE_ASSET_DIRECTORY
        assert not asset_root.exists() or list(asset_root.iterdir()) == []

    def test_import_missing_workspace_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["importAssets"]("nope", [])
        assert exc.value.code == "not_found"

    def test_import_library_not_configured(self, db):
        repos = _build_repos(db, "")
        svc = createWorkspacesService(repos)
        w = svc["createWorkspace"]("X")
        with pytest.raises(RepoError) as exc:
            svc["importAssets"](w["id"], ["/x.txt"])
        assert exc.value.code == "library_not_configured"

    def test_import_large_text_preview_truncation(self, service, library_dir):
        big = b"a" * (WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT + 100)
        src = self._write_source(library_dir, "big.txt", big)
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        preview = service["previewAsset"](w["id"], asset_id)
        assert preview["truncated"] is True
        assert len(preview["content"]) == WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT

    def test_import_small_text_preview_not_truncated(self, service, library_dir):
        src = self._write_source(library_dir, "small.txt", b"short")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        preview = service["previewAsset"](w["id"], asset_id)
        assert preview["truncated"] is False
        assert preview["content"] == "short"


class TestWorkspaceFileImport:
    @pytest.mark.asyncio
    async def test_classifies_pdf_markdown_and_other_assets(
        self, repos, db, library_dir
    ):
        from conftest import make_doc

        sources = Path(library_dir) / "sources"
        sources.mkdir()
        pdf = sources / "paper.pdf"
        markdown = sources / "research.markdown"
        image = sources / "figure.png"
        pdf.write_bytes(b"pdf")
        markdown.write_text("# Findings\n", encoding="utf-8")
        image.write_bytes(b"\x89PNG")
        repos["documents"]["insert"](
            make_doc(id="doc-1", file_path=str(pdf), file_name=pdf.name)
        )

        async def import_files(paths):
            assert paths == [str(pdf)]
            return {"imported": ["doc-1"], "skipped": [], "errors": []}

        service = createWorkspacesService(
            repos, {"importer": {"importFiles": import_files}}
        )
        workspace = service["createWorkspace"]("Mixed")

        result = await service["importWorkspaceFiles"](
            workspace["id"],
            [str(pdf), str(markdown), str(image)],
            {"x": 40.0, "y": 50.0},
        )

        assert result["documentIds"] == ["doc-1"]
        assert result["notes"][0]["title"] == "research"
        assert result["notes"][0]["contentMd"] == "# Findings\n"
        assert result["assets"][0]["fileName"] == "figure.png"
        assert result["errors"] == []
        items = service["listItems"](workspace["id"])
        assert [item["kind"] for item in items] == ["document", "note", "asset"]
        assert [(item["x"], item["y"]) for item in items] == [
            (40.0, 50.0),
            (68.0, 50.0),
            (96.0, 50.0),
        ]

    @pytest.mark.asyncio
    async def test_reuses_an_existing_document_for_a_skipped_pdf(
        self, repos, db, library_dir
    ):
        from conftest import make_doc
        from refora_server.library.importer import hashPdf

        pdf = Path(library_dir) / "existing.pdf"
        pdf.write_bytes(b"existing pdf")
        repos["documents"]["insert"](
            make_doc(
                id="doc-existing",
                file_path=str(pdf),
                file_name=pdf.name,
                file_hash=hashPdf(str(pdf)),
            )
        )

        async def import_files(_paths):
            return {"imported": [], "skipped": [str(pdf)], "errors": []}

        service = createWorkspacesService(
            repos, {"importer": {"importFiles": import_files}}
        )
        workspace = service["createWorkspace"]("Existing")

        result = await service["importWorkspaceFiles"](
            workspace["id"], [str(pdf)]
        )

        assert result["documentIds"] == ["doc-existing"]
        assert service["listItems"](workspace["id"])[0]["docId"] == "doc-existing"


class TestAssetsListingPreview:
    def test_list_assets_marks_missing_file(self, service, library_dir):
        src = os.path.join(library_dir, "src", "note.txt")
        os.makedirs(os.path.dirname(src), exist_ok=True)
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        asset = result["imported"][0]
        dest = os.path.join(library_dir, WORKSPACE_ASSET_DIRECTORY, asset["id"], "note.txt")
        os.remove(dest)
        listed = service["listAssets"](w["id"])
        assert listed[0]["fileMissing"] == 1

    def test_preview_non_text_raises(self, service, library_dir):
        src = os.path.join(library_dir, "img.png")
        with open(src, "wb") as fh:
            fh.write(b"\x89PNG\r\n")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        with pytest.raises(RepoError) as exc:
            service["previewAsset"](w["id"], asset_id)
        assert exc.value.code == "preview_not_supported"

    def test_preview_missing_asset_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["previewAsset"]("workspace-nope", "nope")
        assert exc.value.code == "not_found"

    def test_asset_access_rejects_another_workspace_scope(self, service, library_dir):
        src = os.path.join(library_dir, "scope.txt")
        with open(src, "wb") as fh:
            fh.write(b"scope")
        source = _make_workspace(service, "Source")
        other = _make_workspace(service, "Other")
        asset = service["importAssets"](source["id"], [src])["imported"][0]
        with pytest.raises(RepoError) as exc:
            service["previewAsset"](other["id"], asset["id"])
        assert exc.value.code == "not_found"
        assert service["getAsset"](asset["id"])["workspaceId"] == source["id"]


class TestConnectorCallbacks:
    @pytest.mark.asyncio
    async def test_open_asset_supports_async_python_connector(
        self, repos, library_dir
    ):
        opened: list[str] = []

        class Connector:
            async def open_path(self, path):
                opened.append(path)
                return {"ok": True, "data": None}

        svc = createWorkspacesService(repos, {"connector": Connector()})
        src = os.path.join(library_dir, "async.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        workspace = svc["createWorkspace"]("Async")
        asset = svc["importAssets"](workspace["id"], [src])["imported"][0]

        await svc["openAsset"](workspace["id"], asset["id"])

        assert opened and opened[0].endswith("async.txt")

    @pytest.mark.asyncio
    async def test_open_asset_uses_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "src", "note.txt")
        os.makedirs(os.path.dirname(src), exist_ok=True)
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        await svc["openAsset"](w["id"], asset_id)
        assert len(connector.opened) == 1
        assert connector.opened[0].endswith("note.txt")

    @pytest.mark.asyncio
    async def test_reveal_asset_uses_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        await svc["revealAsset"](w["id"], asset_id)
        assert len(connector.shown) == 1
        assert connector.shown[0].endswith("note.txt")

    @pytest.mark.asyncio
    async def test_open_asset_failure_raises(self, repos, library_dir):
        connector = _FakeConnector()
        connector.open_path_result = "failed"
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        with pytest.raises(RepoError) as exc:
            await svc["openAsset"](w["id"], asset_id)
        assert exc.value.code == "open_failed"

    @pytest.mark.asyncio
    async def test_open_asset_without_connector_raises(self, repos, library_dir):
        svc = createWorkspacesService(repos)
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        with pytest.raises(RepoError) as exc:
            await svc["openAsset"](w["id"], asset_id)
        assert exc.value.code == "not_ready"

    @pytest.mark.asyncio
    async def test_delete_asset_trashes_via_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        await svc["deleteAsset"](w["id"], asset_id)
        assert len(connector.trashed) == 1
        assert connector.trashed[0].endswith(asset_id)
        assert svc["listAssets"](w["id"]) == []
        assert svc["listItems"](w["id"]) == []

    @pytest.mark.asyncio
    async def test_delete_asset_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            await service["deleteAsset"]("workspace-nope", "nope")
        assert exc.value.code == "not_found"

    @pytest.mark.asyncio
    async def test_delete_workspace_trashes_assets(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        svc["importAssets"](w["id"], [src])
        await svc["deleteWorkspace"](w["id"])
        assert len(connector.trashed) == 1
        assert svc["listWorkspaces"]() == []


class TestCanvas:
    def test_get_canvas_returns_default_when_absent(self, service):
        w = _make_workspace(service)
        canvas = service["getCanvas"](w["id"])
        assert canvas == {
            "workspaceId": w["id"],
            "panX": 0.0,
            "panY": 0.0,
            "zoom": 1.0,
            "updatedAt": 0,
        }

    def test_put_canvas(self, service):
        w = _make_workspace(service)
        canvas = service["putCanvas"](w["id"], 10.0, 20.0, 1.5)
        assert canvas["panX"] == 10.0
        assert canvas["panY"] == 20.0
        assert canvas["zoom"] == 1.5
        got = service["getCanvas"](w["id"])
        assert got == canvas

    def test_put_canvas_invalid_zoom_raises(self, service):
        w = _make_workspace(service)
        with pytest.raises(RepoError) as exc:
            service["putCanvas"](w["id"], 0, 0, 0.1)
        assert exc.value.code == "invalid_viewport"

    def test_get_canvas_missing_workspace_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["getCanvas"]("nope")
        assert exc.value.code == "not_found"


class TestConnections:
    def test_list_empty(self, service):
        w = _make_workspace(service)
        assert service["listConnections"](w["id"]) == []

    def test_create_connection(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        insert_doc(db, id="doc-2")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1", "doc-2"])
        conn = service["createConnection"](
            w["id"], items[0]["id"], items[1]["id"], "right", "left"
        )
        assert conn["sourceItemId"] == items[0]["id"]
        assert conn["targetItemId"] == items[1]["id"]
        assert conn["sourceAnchor"] == "right"
        listed = service["listConnections"](w["id"])
        assert len(listed) == 1

    def test_create_connection_self_loop_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["createConnection"](
                w["id"], items[0]["id"], items[0]["id"], "right", "left"
            )
        assert exc.value.code == "invalid_connection"

    def test_delete_connection(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        insert_doc(db, id="doc-2")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1", "doc-2"])
        conn = service["createConnection"](
            w["id"], items[0]["id"], items[1]["id"], "top", "bottom"
        )
        service["deleteConnection"](w["id"], conn["id"])
        assert service["listConnections"](w["id"]) == []

    def test_delete_connection_rejects_another_workspace_scope(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        insert_doc(db, id="doc-2")
        source = _make_workspace(service, "Source")
        other = _make_workspace(service, "Other")
        items = service["addItems"](
            source["id"], "document", ["doc-1", "doc-2"]
        )
        connection = service["createConnection"](
            source["id"], items[0]["id"], items[1]["id"], "top", "bottom"
        )
        with pytest.raises(RepoError) as exc:
            service["deleteConnection"](other["id"], connection["id"])
        assert exc.value.code == "not_found"
        assert service["getConnection"](connection["id"])["workspaceId"] == source["id"]


class TestNotes:
    def test_list_empty(self, service):
        w = _make_workspace(service)
        assert service["listNotes"](w["id"]) == []

    def test_create_note_and_item(self, service):
        w = _make_workspace(service)
        note = service["createNote"](w["id"], "Title", "# body", "markdown")
        assert note["title"] == "Title"
        assert note["contentMd"] == "# body"
        items = service["listItems"](w["id"])
        assert len(items) == 1
        assert items[0]["kind"] == "note"
        assert items[0]["noteId"] == note["id"]

    def test_create_note_empty_title_raises(self, service):
        w = _make_workspace(service)
        with pytest.raises(RepoError) as exc:
            service["createNote"](w["id"], "  ", "", "markdown")
        assert exc.value.code == "invalid_title"

    def test_update_note(self, service):
        w = _make_workspace(service)
        note = service["createNote"](w["id"], "Title", "body", "markdown")
        updated = service["updateNote"](
            w["id"], note["id"], {"title": "New", "contentMd": "x"}
        )
        assert updated["title"] == "New"
        assert updated["contentMd"] == "x"

    @pytest.mark.parametrize(
        "patch",
        [
            {"title": 123},
            {"contentMd": ["invalid"]},
            {"color": "orange"},
            {"unknown": "value"},
        ],
    )
    def test_update_note_rejects_invalid_patch(self, service, patch):
        workspace = _make_workspace(service)
        note = service["createNote"](workspace["id"], "Title", "body", "markdown")

        with pytest.raises(RepoError):
            service["updateNote"](workspace["id"], note["id"], patch)

    def test_delete_note_removes_item(self, service):
        w = _make_workspace(service)
        note = service["createNote"](w["id"], "Title", "body", "markdown")
        service["deleteNote"](w["id"], note["id"])
        assert service["listNotes"](w["id"]) == []
        assert service["listItems"](w["id"]) == []

    def test_update_note_rejects_another_workspace_scope(self, service):
        source = _make_workspace(service, "Source")
        other = _make_workspace(service, "Other")
        note = service["createNote"](source["id"], "Title", "body", "markdown")
        with pytest.raises(RepoError) as exc:
            service["updateNote"](other["id"], note["id"], {"title": "Wrong"})
        assert exc.value.code == "not_found"
        assert service["getNote"](note["id"])["title"] == "Title"
