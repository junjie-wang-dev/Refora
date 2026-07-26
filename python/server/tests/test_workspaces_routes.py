from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from refora_server.repositories.errors import RepoError
from refora_server.server.routes.workspaces import create_workspaces_router


class FakeServices:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.install_started = False
        self.install_release = asyncio.Event()
        self.workspaces = {
            "listWorkspaces": self._workspace("listWorkspaces", []),
            "createWorkspace": self._workspace("createWorkspace", {"id": "workspace-1"}),
            "createWorkspaceWithSandbox": self._workspace(
                "createWorkspaceWithSandbox", {"id": "workspace-1"}
            ),
            "ensureWorkspaceSandbox": self._workspace(
                "ensureWorkspaceSandbox", None
            ),
            "updateWorkspace": self._workspace("updateWorkspace", {"id": "workspace-1"}),
            "deleteWorkspace": self._workspace("deleteWorkspace", None),
            "openSandbox": self._workspace("openSandbox", None),
            "listItems": self._workspace("listItems", []),
            "getItem": self._workspace("getItem", {"id": "item-1"}),
            "addItems": self._workspace("addItems", [{"id": "item-1"}]),
            "deleteItem": self._workspace("deleteItem", None),
            "reorderItems": self._workspace("reorderItems", []),
            "resizeItem": self._workspace("resizeItem", {"id": "item-1"}),
            "moveItem": self._workspace("moveItem", {"id": "item-1"}),
            "listAssets": self._workspace("listAssets", []),
            "getAsset": self._workspace("getAsset", {"id": "asset-1"}),
            "resolveAssetFile": self._workspace(
                "resolveAssetFile",
                (
                    {
                        "id": "asset-1",
                        "previewKind": "image",
                        "mimeType": "image/png",
                    },
                    __file__,
                ),
            ),
            "importAssets": self._workspace("importAssets", {"imported": [], "errors": []}),
            "previewAsset": self._workspace("previewAsset", {"content": "preview", "truncated": False}),
            "openAsset": self._workspace("openAsset", None),
            "revealAsset": self._workspace("revealAsset", None),
            "deleteAsset": self._workspace("deleteAsset", None),
            "getCanvas": self._workspace("getCanvas", {"panX": 0, "panY": 0, "zoom": 1}),
            "putCanvas": self._workspace("putCanvas", {"panX": 0, "panY": 0, "zoom": 1}),
            "listConnections": self._workspace("listConnections", []),
            "getConnection": self._workspace("getConnection", {"id": "connection-1"}),
            "createConnection": self._workspace("createConnection", {"id": "connection-1"}),
            "deleteConnection": self._workspace("deleteConnection", None),
            "listNotes": self._workspace("listNotes", []),
            "getNote": self._workspace("getNote", {"id": "note-1"}),
            "createNote": self._workspace("createNote", {"id": "note-1"}),
            "updateNote": self._workspace("updateNote", {"id": "note-1"}),
            "deleteNote": self._workspace("deleteNote", None),
        }
        self.mineru = {
            "getStatus": self._workspace("getStatus", {"state": "notInstalled"}),
            "setInstallRoot": self._workspace("setInstallRoot", {"state": "notInstalled"}),
            "install": self._install,
            "cancelInstall": self._workspace("cancelInstall", None),
            "uninstall": self._workspace("uninstall", None),
        }
        self.ocr = {
            "startOcr": self._start_ocr,
            "cancelOcr": self._workspace("cancelOcr", {"id": "job-1", "status": "cancelled"}),
            "getState": self._workspace("getState", {"activeJob": None, "result": None}),
            "readMarkdown": self._workspace("readMarkdown", "# OCR"),
            "resolveAsset": self._workspace("resolveAsset", __file__),
            "stopWorker": self._workspace("stopWorker", None),
        }

    def _workspace(self, name: str, result: Any):
        def invoke(*args: Any) -> Any:
            self.calls.append((name, args))
            return result

        return invoke

    async def _install(self, install_root: str | None) -> None:
        self.calls.append(("install", (install_root,)))
        self.install_started = True
        await self.install_release.wait()

    async def _start_ocr(self, document_id: str, profile: str) -> str:
        self.calls.append(("startOcr", (document_id, profile)))
        await asyncio.sleep(0)
        return "job-1"


@dataclass
class FakeDeps:
    workspaces: dict[str, Any]
    mineru: dict[str, Any]
    ocr: dict[str, Any]
    connector: Any

    async def require_token(self, request: Request) -> None:
        if request.headers.get("X-Refora-Token") != "token":
            raise HTTPException(status_code=401, detail="invalid token")


@pytest.fixture
def services() -> FakeServices:
    return FakeServices()


@pytest.fixture
def client(services: FakeServices) -> TestClient:
    class Connector:
        async def dialog_open_directory(self, title: str) -> dict[str, Any]:
            return {"ok": True, "data": {"canceled": False, "path": "/tmp/mineru"}}

        async def dialog_open_file(
            self,
            title: str,
            extensions: list[str] | None,
            multiple: bool,
        ) -> dict[str, Any]:
            return {
                "ok": True,
                "data": {
                    "canceled": False,
                    "paths": ["/tmp/notes.md", "/tmp/data.csv"],
                },
            }

    app = FastAPI()
    app.include_router(
        create_workspaces_router(
            FakeDeps(services.workspaces, services.mineru, services.ocr, Connector())
        )
    )
    return TestClient(app)


HEADERS = {"X-Refora-Token": "token"}


@pytest.mark.parametrize(
    ("method", "path", "payload", "call"),
    [
        ("get", "/workspaces", None, "listWorkspaces"),
        ("post", "/workspaces", {"name": "Research"}, "createWorkspaceWithSandbox"),
        ("patch", "/workspaces/workspace-1", {"name": "Updated"}, "updateWorkspace"),
        ("delete", "/workspaces/workspace-1", None, "deleteWorkspace"),
        ("post", "/workspaces/workspace-1/open-sandbox", None, "openSandbox"),
        ("get", "/workspaces/workspace-1/items", None, "listItems"),
        ("get", "/workspace-items/item-1", None, "getItem"),
        ("post", "/workspaces/workspace-1/items", {"kind": "document", "ids": ["doc-1"]}, "addItems"),
        ("post", "/workspaces/workspace-1/items/reorder", {"ids": ["item-1"]}, "reorderItems"),
        ("patch", "/workspaces/workspace-1/items/item-1/size", {"width": 320, "height": 240}, "resizeItem"),
        ("post", "/workspaces/workspace-1/items/move", {"itemId": "item-1", "x": 1, "y": 2, "zIndex": 3}, "moveItem"),
        ("delete", "/workspaces/workspace-1/items/item-1", None, "deleteItem"),
        ("get", "/workspaces/workspace-1/assets", None, "listAssets"),
        ("get", "/workspace-assets/asset-1", None, "getAsset"),
        ("post", "/workspaces/workspace-1/assets/files", {"paths": ["/tmp/asset.txt"]}, "importAssets"),
        ("get", "/workspaces/workspace-1/assets/asset-1/preview", None, "previewAsset"),
        ("post", "/workspaces/workspace-1/assets/asset-1/open", None, "openAsset"),
        ("post", "/workspaces/workspace-1/assets/asset-1/reveal", None, "revealAsset"),
        ("delete", "/workspaces/workspace-1/assets/asset-1", None, "deleteAsset"),
        ("get", "/workspaces/workspace-1/canvas", None, "getCanvas"),
        ("put", "/workspaces/workspace-1/canvas", {"panX": 1, "panY": 2, "zoom": 1.25}, "putCanvas"),
        ("get", "/workspaces/workspace-1/connections", None, "listConnections"),
        ("get", "/workspace-connections/connection-1", None, "getConnection"),
        ("post", "/workspaces/workspace-1/connections", {"sourceItemId": "item-1", "targetItemId": "item-2", "sourceAnchor": "right", "targetAnchor": "left"}, "createConnection"),
        ("delete", "/workspaces/workspace-1/connections/connection-1", None, "deleteConnection"),
        ("get", "/workspaces/workspace-1/notes", None, "listNotes"),
        ("get", "/workspace-notes/note-1", None, "getNote"),
        ("post", "/workspaces/workspace-1/notes", {"title": "Note", "contentMd": "Text"}, "createNote"),
        ("patch", "/workspaces/workspace-1/notes/note-1", {"title": "Changed"}, "updateNote"),
        ("delete", "/workspaces/workspace-1/notes/note-1", None, "deleteNote"),
        ("get", "/mineru/status", None, "getStatus"),
        ("post", "/mineru/choose-install-root", None, "setInstallRoot"),
        ("post", "/mineru/cancel-install", None, "cancelInstall"),
        ("post", "/mineru/uninstall", None, "uninstall"),
        ("post", "/ocr/cancel", {"jobId": "job-1"}, "cancelOcr"),
        ("get", "/ocr/state?documentId=document-1", None, "getState"),
        (
            "get",
            "/ocr/documents/document-1/results/result-1/markdown",
            None,
            "readMarkdown",
        ),
    ],
)
def test_workspace_and_ocr_endpoint_matrix(
    client: TestClient,
    services: FakeServices,
    method: str,
    path: str,
    payload: dict[str, Any] | None,
    call: str,
) -> None:
    request_args: dict[str, Any] = {"headers": HEADERS}
    if payload is not None:
        request_args["json"] = payload
    response = client.request(method.upper(), path, **request_args)

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert services.calls[-1][0] == call


def test_routes_require_token(client: TestClient) -> None:
    response = client.get("/workspaces")

    assert response.status_code == 401


def test_raw_asset_routes_are_authenticated_and_served_by_python(
    client: TestClient, services: FakeServices
) -> None:
    workspace_asset = client.get(
        "/workspace-assets/asset-1/content",
        headers=HEADERS,
    )
    ocr_asset = client.get(
        "/ocr/documents/document-1/results/result-1/assets/page.png",
        headers=HEADERS,
    )

    assert workspace_asset.status_code == 200
    assert workspace_asset.headers["content-type"] == "image/png"
    assert ocr_asset.status_code == 200
    assert ("resolveAssetFile", ("asset-1",)) in services.calls
    assert (
        "resolveAsset",
        ("document-1", "result-1", "page.png"),
    ) in services.calls


def test_route_errors_use_result_envelopes(client: TestClient, services: FakeServices) -> None:
    services.workspaces["listWorkspaces"] = lambda: (_ for _ in ()).throw(RepoError("not_found", "missing"))
    missing = client.get("/workspaces", headers=HEADERS)
    services.workspaces["createWorkspaceWithSandbox"] = lambda name: (_ for _ in ()).throw(RepoError("duplicate", "exists"))
    conflict = client.post("/workspaces", headers=HEADERS, json={"name": "Research"})
    services.mineru["getStatus"] = lambda: (_ for _ in ()).throw(RuntimeError("MinerU runtime unavailable"))
    unavailable = client.get("/mineru/status", headers=HEADERS)

    assert (missing.status_code, missing.json()["error"]["code"]) == (404, "not_found")
    assert (conflict.status_code, conflict.json()["error"]["code"]) == (409, "duplicate")
    assert (unavailable.status_code, unavailable.json()["error"]["code"]) == (503, "unavailable")


def test_ocr_start_returns_job_acknowledgement(client: TestClient, services: FakeServices) -> None:
    response = client.post(
        "/ocr/start",
        headers=HEADERS,
        json={"documentId": "document-1", "profile": "quality"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"jobId": "job-1"}}
    assert services.calls[-1] == ("startOcr", ("document-1", "quality"))

def test_routes_preserve_scope_placement_and_ocr_identity(
    client: TestClient, services: FakeServices
) -> None:
    created = client.post(
        "/workspaces/workspace-1/items",
        headers=HEADERS,
        json={
            "kind": "document",
            "docId": "document-1",
            "placement": {"x": 12, "y": 34},
        },
    )
    moved = client.post(
        "/workspaces/workspace-1/items/move",
        headers=HEADERS,
        json={"itemId": "item-1", "x": 7, "y": 8, "zIndex": 9},
    )
    markdown = client.get(
        "/ocr/documents/document-1/results/result-1/markdown", headers=HEADERS
    )

    assert created.json() == {"ok": True, "data": {"id": "item-1"}}
    assert moved.status_code == 200
    assert markdown.json() == {"ok": True, "data": {"markdown": "# OCR"}}
    assert (
        "addItems",
        ("workspace-1", "document", ["document-1"], {"x": 12.0, "y": 34.0}),
    ) in services.calls
    assert ("moveItem", ("workspace-1", "item-1", 7.0, 8.0, 9)) in services.calls
    assert services.calls[-1] == ("readMarkdown", ("document-1", "result-1"))


def test_mineru_choose_root_uses_native_selection(
    client: TestClient, services: FakeServices
) -> None:
    response = client.post("/mineru/choose-install-root", headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"state": "notInstalled"}}
    assert services.calls[-1] == ("setInstallRoot", ("/tmp/mineru",))


def test_workspace_file_picker_and_empty_note_content_are_supported(
    client: TestClient, services: FakeServices
) -> None:
    files = client.post(
        "/workspaces/workspace-1/assets/files",
        headers=HEADERS,
        json={"paths": [], "placement": {"x": 10, "y": 20}},
    )
    note = client.post(
        "/workspaces/workspace-1/notes",
        headers=HEADERS,
        json={"title": "Untitled", "contentMd": "", "noteType": "markdown"},
    )

    assert files.status_code == 200
    assert (
        "importAssets",
        (
            "workspace-1",
            ["/tmp/notes.md", "/tmp/data.csv"],
            {"x": 10.0, "y": 20.0},
        ),
    ) in services.calls
    assert note.status_code == 200
    assert services.calls[-1] == (
        "createNote",
        ("workspace-1", "Untitled", "", "markdown", None),
    )


def test_mineru_install_returns_immediate_acknowledgement(client: TestClient, services: FakeServices) -> None:
    response = client.post("/mineru/install", headers=HEADERS, json={"installRoot": "/tmp/mineru"})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ack": True}}


def test_items_batch_endpoint_creates_all_items_in_single_call(
    client: TestClient, services: FakeServices
) -> None:
    response = client.post(
        "/workspaces/workspace-1/items/batch",
        headers=HEADERS,
        json={"kind": "document", "ids": ["doc-1", "doc-2"], "placement": {"x": 1, "y": 2}},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": [{"id": "item-1"}]}
    assert services.calls[-1] == (
        "addItems",
        ("workspace-1", "document", ["doc-1", "doc-2"], {"x": 1.0, "y": 2.0}),
    )


def test_items_batch_rejects_missing_ids(client: TestClient) -> None:
    response = client.post(
        "/workspaces/workspace-1/items/batch",
        headers=HEADERS,
        json={"kind": "document"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation"
