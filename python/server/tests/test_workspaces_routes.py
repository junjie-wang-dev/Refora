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
            "updateWorkspace": self._workspace("updateWorkspace", {"id": "workspace-1"}),
            "deleteWorkspace": self._workspace("deleteWorkspace", None),
            "openSandbox": self._workspace("openSandbox", None),
            "listItems": self._workspace("listItems", []),
            "addItems": self._workspace("addItems", [{"id": "item-1"}]),
            "deleteItem": self._workspace("deleteItem", None),
            "reorderItems": self._workspace("reorderItems", []),
            "resizeItem": self._workspace("resizeItem", {"id": "item-1"}),
            "moveItem": self._workspace("moveItem", {"id": "item-1"}),
            "listAssets": self._workspace("listAssets", []),
            "importAssets": self._workspace("importAssets", {"imported": [], "errors": []}),
            "previewAsset": self._workspace("previewAsset", {"content": "preview", "truncated": False}),
            "openAsset": self._workspace("openAsset", None),
            "revealAsset": self._workspace("revealAsset", None),
            "deleteAsset": self._workspace("deleteAsset", None),
            "getCanvas": self._workspace("getCanvas", {"panX": 0, "panY": 0, "zoom": 1}),
            "putCanvas": self._workspace("putCanvas", {"panX": 0, "panY": 0, "zoom": 1}),
            "listConnections": self._workspace("listConnections", []),
            "createConnection": self._workspace("createConnection", {"id": "connection-1"}),
            "deleteConnection": self._workspace("deleteConnection", None),
            "listNotes": self._workspace("listNotes", []),
            "createNote": self._workspace("createNote", {"id": "note-1"}),
            "updateNote": self._workspace("updateNote", {"id": "note-1"}),
            "deleteNote": self._workspace("deleteNote", None),
        }
        self.mineru = {
            "getStatus": self._workspace("getStatus", {"state": "notInstalled"}),
            "install": self._install,
            "cancelInstall": self._workspace("cancelInstall", None),
            "uninstall": self._workspace("uninstall", None),
        }
        self.ocr = {
            "startOcr": self._start_ocr,
            "cancelOcr": self._workspace("cancelOcr", None),
            "getOcrState": self._workspace("getOcrState", {"activeJob": None}),
            "getMarkdown": self._workspace("getMarkdown", "# OCR"),
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

    async def require_token(self, request: Request) -> None:
        if request.headers.get("X-Refora-Token") != "token":
            raise HTTPException(status_code=401, detail="invalid token")


@pytest.fixture
def services() -> FakeServices:
    return FakeServices()


@pytest.fixture
def client(services: FakeServices) -> TestClient:
    app = FastAPI()
    app.include_router(create_workspaces_router(FakeDeps(services.workspaces, services.mineru, services.ocr)))
    return TestClient(app)


HEADERS = {"X-Refora-Token": "token"}


@pytest.mark.parametrize(
    ("method", "path", "payload", "call"),
    [
        ("get", "/workspaces", None, "listWorkspaces"),
        ("post", "/workspaces", {"name": "Research"}, "createWorkspace"),
        ("patch", "/workspaces/workspace-1", {"name": "Updated"}, "updateWorkspace"),
        ("delete", "/workspaces/workspace-1", None, "deleteWorkspace"),
        ("post", "/workspaces/workspace-1/open-sandbox", None, "openSandbox"),
        ("get", "/workspaces/workspace-1/items", None, "listItems"),
        ("post", "/workspaces/workspace-1/items", {"kind": "document", "ids": ["doc-1"]}, "addItems"),
        ("post", "/workspaces/workspace-1/items/reorder", {"ids": ["item-1"]}, "reorderItems"),
        ("patch", "/workspaces/workspace-1/items/item-1/size", {"width": 320, "height": 240}, "resizeItem"),
        ("post", "/workspaces/workspace-1/items/move", {"itemId": "item-1", "x": 1, "y": 2, "zIndex": 3}, "moveItem"),
        ("delete", "/workspaces/workspace-1/items/item-1", None, "deleteItem"),
        ("get", "/workspaces/workspace-1/assets", None, "listAssets"),
        ("post", "/workspaces/workspace-1/assets/files", {"paths": ["/tmp/asset.txt"]}, "importAssets"),
        ("get", "/workspaces/workspace-1/assets/asset-1/preview", None, "previewAsset"),
        ("post", "/workspaces/workspace-1/assets/asset-1/open", None, "openAsset"),
        ("post", "/workspaces/workspace-1/assets/asset-1/reveal", None, "revealAsset"),
        ("delete", "/workspaces/workspace-1/assets/asset-1", None, "deleteAsset"),
        ("get", "/workspaces/workspace-1/canvas", None, "getCanvas"),
        ("put", "/workspaces/workspace-1/canvas", {"panX": 1, "panY": 2, "zoom": 1.25}, "putCanvas"),
        ("get", "/workspaces/workspace-1/connections", None, "listConnections"),
        ("post", "/workspaces/workspace-1/connections", {"sourceItemId": "item-1", "targetItemId": "item-2", "sourceAnchor": "right", "targetAnchor": "left"}, "createConnection"),
        ("delete", "/workspaces/workspace-1/connections/connection-1", None, "deleteConnection"),
        ("get", "/workspaces/workspace-1/notes", None, "listNotes"),
        ("post", "/workspaces/workspace-1/notes", {"title": "Note", "contentMd": "Text"}, "createNote"),
        ("patch", "/workspaces/workspace-1/notes/note-1", {"title": "Changed"}, "updateNote"),
        ("delete", "/workspaces/workspace-1/notes/note-1", None, "deleteNote"),
        ("get", "/mineru/status", None, "getStatus"),
        ("post", "/mineru/cancel-install", None, "cancelInstall"),
        ("post", "/mineru/uninstall", None, "uninstall"),
        ("post", "/ocr/cancel", {"jobId": "job-1"}, "cancelOcr"),
        ("get", "/ocr/state", None, "getOcrState"),
        ("get", "/ocr/job-1/markdown", None, "getMarkdown"),
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


def test_route_errors_use_result_envelopes(client: TestClient, services: FakeServices) -> None:
    services.workspaces["listWorkspaces"] = lambda: (_ for _ in ()).throw(RepoError("not_found", "missing"))
    missing = client.get("/workspaces", headers=HEADERS)
    services.workspaces["createWorkspace"] = lambda name: (_ for _ in ()).throw(RepoError("duplicate", "exists"))
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


def test_mineru_install_returns_immediate_acknowledgement(client: TestClient, services: FakeServices) -> None:
    response = client.post("/mineru/install", headers=HEADERS, json={"installRoot": "/tmp/mineru"})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ack": True}}
