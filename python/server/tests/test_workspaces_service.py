from __future__ import annotations

import os

import pytest

from conftest import (
    make_workspace_assets_repo,
    make_workspace_canvas_repo,
    make_workspace_connections_repo,
    make_workspace_items_repo,
    make_workspace_notes_repo,
    make_workspaces_repo,
    open_migrated_db,
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
        updated = service["updateWorkspace"](w["id"], "New")
        assert updated["name"] == "New"

    def test_update_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["updateWorkspace"]("nope", "New")
        assert exc.value.code == "not_found"

    def test_delete_removes_workspace(self, service):
        w = service["createWorkspace"]("Gone")
        service["deleteWorkspace"](w["id"])
        assert service["listWorkspaces"]() == []

    def test_delete_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["deleteWorkspace"]("nope")
        assert exc.value.code == "not_found"


class TestOpenSandbox:
    def test_open_sandbox_via_connector(self, repos):
        w = repos["workspaces"]["create"]("Research")
        connector = _FakeConnector()
        sandbox_roots = {}

        def ensure(wid):
            sandbox_roots[wid] = f"/sandbox/{wid}"
            return {"sandboxRoot": f"/sandbox/{wid}"}

        svc = createWorkspacesService(
            repos, {"connector": connector, "sandbox": {"ensure": ensure}}
        )
        svc["openSandbox"](w["id"])
        assert connector.opened == [f"/sandbox/{w['id']}"]

    def test_open_sandbox_missing_workspace(self, repos):
        connector = _FakeConnector()
        svc = createWorkspacesService(
            repos,
            {
                "connector": connector,
                "sandbox": {"ensure": lambda wid: {"sandboxRoot": "/x"}},
            },
        )
        with pytest.raises(RepoError) as exc:
            svc["openSandbox"]("nope")
        assert exc.value.code == "not_found"
        assert connector.opened == []

    def test_open_sandbox_no_sandbox_dep(self, repos):
        w = repos["workspaces"]["create"]("Research")
        svc = createWorkspacesService(repos, {"connector": _FakeConnector()})
        with pytest.raises(RepoError) as exc:
            svc["openSandbox"](w["id"])
        assert exc.value.code == "not_ready"

    def test_open_sandbox_open_failure(self, repos):
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
            svc["openSandbox"](w["id"])
        assert exc.value.code == "open_failed"

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
        service["deleteItem"](items[0]["id"])
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
        resized = service["resizeItem"](items[0]["id"], 400, 300)
        assert resized["width"] == 400
        assert resized["height"] == 300

    def test_resize_invalid_size_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["resizeItem"](items[0]["id"], 0, 100)
        assert exc.value.code == "invalid_size"

    def test_move_item(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        moved = service["moveItem"](items[0]["id"], 12.5, 34.0, 5)
        assert moved["x"] == 12.5
        assert moved["y"] == 34.0
        assert moved["zIndex"] == 5

    def test_move_invalid_position_raises(self, db, service):
        from conftest import insert_doc

        insert_doc(db, id="doc-1")
        w = _make_workspace(service)
        items = service["addItems"](w["id"], "document", ["doc-1"])
        with pytest.raises(RepoError) as exc:
            service["moveItem"](items[0]["id"], float("nan"), 0, 1)
        assert exc.value.code == "invalid_position"

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
        preview = service["previewAsset"](asset_id)
        assert preview["truncated"] is True
        assert len(preview["content"]) == WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT

    def test_import_small_text_preview_not_truncated(self, service, library_dir):
        src = self._write_source(library_dir, "small.txt", b"short")
        w = _make_workspace(service)
        result = service["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        preview = service["previewAsset"](asset_id)
        assert preview["truncated"] is False
        assert preview["content"] == "short"


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
            service["previewAsset"](asset_id)
        assert exc.value.code == "preview_not_supported"

    def test_preview_missing_asset_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["previewAsset"]("nope")
        assert exc.value.code == "not_found"


class TestConnectorCallbacks:
    def test_open_asset_uses_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "src", "note.txt")
        os.makedirs(os.path.dirname(src), exist_ok=True)
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        svc["openAsset"](asset_id)
        assert len(connector.opened) == 1
        assert connector.opened[0].endswith("note.txt")

    def test_reveal_asset_uses_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        svc["revealAsset"](asset_id)
        assert len(connector.shown) == 1
        assert connector.shown[0].endswith("note.txt")

    def test_open_asset_failure_raises(self, repos, library_dir):
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
            svc["openAsset"](asset_id)
        assert exc.value.code == "open_failed"

    def test_open_asset_without_connector_raises(self, repos, library_dir):
        svc = createWorkspacesService(repos)
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        with pytest.raises(RepoError) as exc:
            svc["openAsset"](asset_id)
        assert exc.value.code == "not_ready"

    def test_delete_asset_trashes_via_connector(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        result = svc["importAssets"](w["id"], [src])
        asset_id = result["imported"][0]["id"]
        svc["deleteAsset"](asset_id)
        assert len(connector.trashed) == 1
        assert connector.trashed[0].endswith(asset_id)
        assert svc["listAssets"](w["id"]) == []
        assert svc["listItems"](w["id"]) == []

    def test_delete_asset_missing_raises(self, service):
        with pytest.raises(RepoError) as exc:
            service["deleteAsset"]("nope")
        assert exc.value.code == "not_found"

    def test_delete_workspace_trashes_assets(self, repos, library_dir):
        connector = _FakeConnector()
        svc = createWorkspacesService(repos, {"connector": connector})
        src = os.path.join(library_dir, "note.txt")
        with open(src, "wb") as fh:
            fh.write(b"hi")
        w = svc["createWorkspace"]("X")
        svc["importAssets"](w["id"], [src])
        svc["deleteWorkspace"](w["id"])
        assert len(connector.trashed) == 1
        assert svc["listWorkspaces"]() == []


class TestCanvas:
    def test_get_canvas_none_when_absent(self, service):
        w = _make_workspace(service)
        assert service["getCanvas"](w["id"]) is None

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
        service["deleteConnection"](conn["id"])
        assert service["listConnections"](w["id"]) == []


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
        updated = service["updateNote"](note["id"], {"title": "New", "contentMd": "x"})
        assert updated["title"] == "New"
        assert updated["contentMd"] == "x"

    def test_delete_note_removes_item(self, service):
        w = _make_workspace(service)
        note = service["createNote"](w["id"], "Title", "body", "markdown")
        service["deleteNote"](note["id"])
        assert service["listNotes"](w["id"]) == []
        assert service["listItems"](w["id"]) == []
