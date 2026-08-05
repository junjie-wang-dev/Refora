from __future__ import annotations

import asyncio
import inspect
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Body, Depends
from fastapi.responses import FileResponse, JSONResponse

from refora_server.repositories.errors import RepoError


class RequestError(Exception):
    pass


def _dependency(deps: Any, name: str) -> Any:
    if isinstance(deps, dict):
        return deps[name]
    return getattr(deps, name)


def _optional_dependency(deps: Any, name: str) -> Any:
    if isinstance(deps, dict):
        return deps.get(name)
    return getattr(deps, name, None)


def _result(data: Any) -> JSONResponse:
    return JSONResponse({"ok": True, "data": data})


def _failure(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error": {"code": code, "message": message}},
    )


def _repo_status(code: str) -> int:
    if code in {"not_found", "file_missing"}:
        return 404
    if code in {"busy", "conflict", "duplicate", "invalid_order", "stale"}:
        return 409
    if code in {"not_ready", "unavailable", "engine_unavailable"}:
        return 503
    return 400


def _runtime_status(error: RuntimeError) -> int:
    message = str(error).lower()
    if any(word in message for word in ("already", "while", "before uninstall", "active")):
        return 409
    if any(word in message for word in ("unavailable", "not installed", "runtime")):
        return 503
    return 400


async def _invoke(operation: Callable[[], Any]) -> JSONResponse:
    try:
        value = operation()
        if inspect.isawaitable(value):
            value = await value
        return _result(value)
    except RequestError as error:
        return _failure(400, "validation", str(error))
    except RepoError as error:
        return _failure(_repo_status(error.code), error.code, str(error))
    except RuntimeError as error:
        status_code = _runtime_status(error)
        code = "unavailable" if status_code == 503 else "conflict" if status_code == 409 else "bad_request"
        return _failure(status_code, code, str(error))
    except (KeyError, TypeError, ValueError) as error:
        return _failure(400, "validation", str(error) or "Invalid request")
    except Exception:
        return _failure(500, "internal", "Internal server error")


def _body(value: dict[str, Any] | None) -> dict[str, Any]:
    if value is None:
        raise RequestError("Request body is required")
    return value


def _string(value: dict[str, Any], name: str) -> str:
    result = value.get(name)
    if not isinstance(result, str) or not result:
        raise RequestError(f"{name} must be a non-empty string")
    return result


def _text(value: dict[str, Any], name: str) -> str:
    result = value.get(name)
    if not isinstance(result, str):
        raise RequestError(f"{name} must be a string")
    return result


def _number(value: dict[str, Any], name: str) -> float:
    result = value.get(name)
    if isinstance(result, bool) or not isinstance(result, (int, float)):
        raise RequestError(f"{name} must be a number")
    return float(result)


def _integer(value: dict[str, Any], name: str) -> int:
    result = value.get(name)
    if isinstance(result, bool) or not isinstance(result, int):
        raise RequestError(f"{name} must be an integer")
    return result


def _string_list(value: dict[str, Any], name: str) -> list[str]:
    result = value.get(name)
    if not isinstance(result, list) or not all(isinstance(item, str) and item for item in result):
        raise RequestError(f"{name} must be an array of non-empty strings")
    return result


def _placement(value: dict[str, Any]) -> dict[str, Any] | None:
    placement = value.get("placement")
    if placement is None:
        return None
    if not isinstance(placement, dict):
        raise RequestError("placement must be an object")
    return {"x": _number(placement, "x"), "y": _number(placement, "y")}


def _item_ids(value: dict[str, Any], kind: str) -> tuple[list[str], bool]:
    if "ids" in value:
        return _string_list(value, "ids"), False
    field = {
        "document": "docId",
        "report": "reportId",
        "note": "noteId",
        "asset": "assetId",
    }.get(kind)
    if field is None:
        raise RequestError("kind must be document, report, note, or asset")
    return [_string(value, field)], True


def _status(value: Any) -> Any:
    return value.to_dict() if hasattr(value, "to_dict") else value


def _detach(coroutine: Awaitable[Any]) -> None:
    task = asyncio.create_task(coroutine)

    def consume_result(completed: asyncio.Task[Any]) -> None:
        try:
            completed.result()
        except Exception:
            pass

    task.add_done_callback(consume_result)


async def _select_workspace_files(connector: Any) -> list[str]:
    if connector is None:
        raise RuntimeError("Native file picker is unavailable")
    chooser = getattr(connector, "dialog_open_file", None)
    if not callable(chooser):
        raise RuntimeError("Native file picker is unavailable")
    selection = chooser("Add Files to Workspace", None, True)
    if inspect.isawaitable(selection):
        selection = await selection
    if not isinstance(selection, dict) or selection.get("ok") is not True:
        error = selection.get("error") if isinstance(selection, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        raise RuntimeError(message or "Native file picker failed")
    data = selection.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("Native file picker returned an invalid result")
    if data.get("canceled") is True:
        return []
    paths = data.get("paths")
    if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
        raise RuntimeError("Native file picker returned invalid paths")
    return paths


def create_workspaces_router(deps: Any) -> APIRouter:
    workspaces = _dependency(deps, "workspaces")
    mineru = _dependency(deps, "mineru")
    ocr = _dependency(deps, "ocr")
    connector = _optional_dependency(deps, "connector")
    require_token = _dependency(deps, "require_token")
    router = APIRouter(dependencies=[Depends(require_token)])

    @router.get("/workspaces")
    async def list_workspaces() -> JSONResponse:
        return await _invoke(lambda: workspaces["listWorkspaces"]())

    @router.post("/workspaces")
    async def create_workspace(body: dict[str, Any] | None = Body(default=None)) -> JSONResponse:
        create = workspaces.get("createWorkspaceWithSandbox", workspaces["createWorkspace"])

        async def operation() -> Any:
            value = create(_string(_body(body), "name"))
            if inspect.isawaitable(value):
                value = await value
            return value

        return await _invoke(operation)

    @router.patch("/workspaces/{workspace_id}")
    async def update_workspace(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["updateWorkspace"](workspace_id, _string(_body(body), "name"))
        )

    @router.delete("/workspaces/{workspace_id}")
    async def delete_workspace(workspace_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["deleteWorkspace"](workspace_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.post("/workspaces/{workspace_id}/open-sandbox")
    async def open_sandbox(workspace_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["openSandbox"](workspace_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.get("/workspaces/{workspace_id}/items")
    async def list_items(workspace_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["listItems"](workspace_id))

    @router.get("/workspace-items/{item_id}")
    async def get_item(item_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["getItem"](item_id))

    @router.post("/workspaces/{workspace_id}/items")
    async def add_items(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        def operation() -> Any:
            payload = _body(body)
            kind = _string(payload, "kind")
            ids, singular = _item_ids(payload, kind)
            result = workspaces["addItems"](
                workspace_id, kind, ids, _placement(payload)
            )
            if not singular:
                return result
            if not isinstance(result, list) or len(result) != 1:
                raise RuntimeError("Workspace item creation returned an invalid result")
            return result[0]

        return await _invoke(operation)

    @router.post("/workspaces/{workspace_id}/items/batch")
    async def add_items_batch(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        def operation() -> list[dict[str, Any]]:
            payload = _body(body)
            kind = _string(payload, "kind")
            ids = _string_list(payload, "ids")
            result = workspaces["addItems"](
                workspace_id, kind, ids, _placement(payload)
            )
            if not isinstance(result, list):
                raise RuntimeError("Workspace item creation returned an invalid result")
            return result

        return await _invoke(operation)

    @router.post("/workspaces/{workspace_id}/items/reorder")
    async def reorder_items(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["reorderItems"](workspace_id, _string_list(_body(body), "ids"))
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.patch("/workspaces/{workspace_id}/items/{item_id}/size")
    async def resize_item(
        workspace_id: str, item_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["resizeItem"](
                workspace_id,
                item_id,
                _integer(_body(body), "width"),
                _integer(_body(body), "height"),
            )
        )

    @router.post("/workspaces/{workspace_id}/items/move")
    async def move_item(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["moveItem"](
                workspace_id,
                _string(_body(body), "itemId"),
                _number(_body(body), "x"),
                _number(_body(body), "y"),
                _integer(_body(body), "zIndex"),
            )
        )

    @router.delete("/workspaces/{workspace_id}/items/{item_id}")
    async def delete_item(workspace_id: str, item_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["deleteItem"](workspace_id, item_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.get("/workspaces/{workspace_id}/assets")
    async def list_assets(workspace_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["listAssets"](workspace_id))

    @router.get("/workspace-assets/{asset_id}")
    async def get_asset(asset_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["getAsset"](asset_id))

    @router.post("/workspaces/{workspace_id}/assets/files")
    async def import_assets(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        async def operation() -> Any:
            payload = _body(body)
            paths = _string_list(payload, "paths")
            if not paths:
                paths = await _select_workspace_files(connector)
            if not paths:
                return {"imported": [], "errors": []}
            return workspaces["importAssets"](
                workspace_id, paths, _placement(payload)
            )

        return await _invoke(operation)

    @router.post("/workspaces/{workspace_id}/files")
    async def import_workspace_files(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        def operation() -> Any:
            payload = _body(body)
            return workspaces["importWorkspaceFiles"](
                workspace_id, _string_list(payload, "paths"), _placement(payload)
            )

        return await _invoke(operation)

    @router.get("/workspaces/{workspace_id}/assets/{asset_id}/preview")
    async def preview_asset(workspace_id: str, asset_id: str) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["previewAsset"](workspace_id, asset_id)
        )

    @router.get("/workspace-assets/{asset_id}/content")
    async def workspace_asset_content(asset_id: str):
        try:
            asset, path = workspaces["resolveAssetFile"](asset_id)
            if asset.get("previewKind") not in {"image", "audio", "video"}:
                return _failure(415, "preview_not_supported", "Preview is not supported")
            return FileResponse(
                path,
                media_type=asset.get("mimeType") or "application/octet-stream",
                headers={"X-Content-Type-Options": "nosniff"},
            )
        except RepoError as error:
            return _failure(_repo_status(error.code), error.code, str(error))

    @router.post("/workspaces/{workspace_id}/assets/{asset_id}/open")
    async def open_asset(workspace_id: str, asset_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["openAsset"](workspace_id, asset_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.post("/workspaces/{workspace_id}/assets/{asset_id}/reveal")
    async def reveal_asset(workspace_id: str, asset_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["revealAsset"](workspace_id, asset_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.delete("/workspaces/{workspace_id}/assets/{asset_id}")
    async def delete_asset(workspace_id: str, asset_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["deleteAsset"](workspace_id, asset_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.get("/workspaces/{workspace_id}/canvas")
    async def get_canvas(workspace_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["getCanvas"](workspace_id))

    @router.put("/workspaces/{workspace_id}/canvas")
    async def put_canvas(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["putCanvas"](
                workspace_id,
                _number(_body(body), "panX"),
                _number(_body(body), "panY"),
                _number(_body(body), "zoom"),
            )
        )

    @router.get("/workspaces/{workspace_id}/connections")
    async def list_connections(workspace_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["listConnections"](workspace_id))

    @router.get("/workspace-connections/{connection_id}")
    async def get_connection(connection_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["getConnection"](connection_id))

    @router.post("/workspaces/{workspace_id}/connections")
    async def create_connection(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["createConnection"](
                workspace_id,
                _string(_body(body), "sourceItemId"),
                _string(_body(body), "targetItemId"),
                _string(_body(body), "sourceAnchor"),
                _string(_body(body), "targetAnchor"),
            )
        )

    @router.delete("/workspaces/{workspace_id}/connections/{connection_id}")
    async def delete_connection(workspace_id: str, connection_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["deleteConnection"](workspace_id, connection_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.get("/workspaces/{workspace_id}/notes")
    async def list_notes(workspace_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["listNotes"](workspace_id))

    @router.get("/workspace-notes/{note_id}")
    async def get_note(note_id: str) -> JSONResponse:
        return await _invoke(lambda: workspaces["getNote"](note_id))

    @router.post("/workspaces/{workspace_id}/notes")
    async def create_note(
        workspace_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["createNote"](
                workspace_id,
                _string(_body(body), "title"),
                _text(_body(body), "contentMd"),
                _string(_body(body), "noteType") if _body(body).get("noteType") is not None else "markdown",
                _placement(_body(body)),
            )
        )

    @router.patch("/workspaces/{workspace_id}/notes/{note_id}")
    async def update_note(
        workspace_id: str, note_id: str, body: dict[str, Any] | None = Body(default=None)
    ) -> JSONResponse:
        return await _invoke(
            lambda: workspaces["updateNote"](workspace_id, note_id, _body(body))
        )

    @router.delete("/workspaces/{workspace_id}/notes/{note_id}")
    async def delete_note(workspace_id: str, note_id: str) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = workspaces["deleteNote"](workspace_id, note_id)
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.get("/mineru/status")
    async def mineru_status() -> JSONResponse:
        async def operation() -> Any:
            value = mineru["getStatus"]()
            if inspect.isawaitable(value):
                value = await value
            return _status(value)

        return await _invoke(operation)

    @router.post("/mineru/choose-install-root")
    async def choose_mineru_install_root() -> JSONResponse:
        async def operation() -> Any:
            if connector is None:
                raise RuntimeError("Native directory picker is unavailable")
            chooser = getattr(connector, "dialog_open_directory", None)
            if not callable(chooser):
                raise RuntimeError("Native directory picker is unavailable")
            selection = chooser("Select MinerU Install Location")
            if inspect.isawaitable(selection):
                selection = await selection
            if not isinstance(selection, dict) or selection.get("ok") is not True:
                error = selection.get("error") if isinstance(selection, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                raise RuntimeError(message or "Native directory picker failed")
            data = selection.get("data")
            if not isinstance(data, dict):
                raise RuntimeError("Native directory picker returned an invalid result")
            if data.get("canceled") is True or data.get("path") is None:
                value = mineru["getStatus"]()
            else:
                path = data.get("path")
                if not isinstance(path, str) or not path:
                    raise RuntimeError("Native directory picker returned an invalid path")
                value = mineru["setInstallRoot"](path)
            if inspect.isawaitable(value):
                value = await value
            return _status(value)

        return await _invoke(operation)

    @router.post("/mineru/install")
    async def install_mineru(body: dict[str, Any] | None = Body(default=None)) -> JSONResponse:
        async def operation() -> dict[str, bool]:
            payload = body or {}
            install_root = payload.get("installRoot")
            if install_root is not None and not isinstance(install_root, str):
                raise RequestError("installRoot must be a string")
            value = mineru["install"](install_root)
            if not inspect.isawaitable(value):
                raise RequestError("MinerU install operation must be awaitable")
            _detach(value)
            await asyncio.sleep(0)
            return {"ack": True}

        return await _invoke(operation)

    @router.post("/mineru/cancel-install")
    async def cancel_mineru_install() -> JSONResponse:
        async def operation() -> dict[str, bool]:
            value = mineru["cancelInstall"]()
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.post("/mineru/uninstall")
    async def uninstall_mineru() -> JSONResponse:
        async def operation() -> dict[str, bool]:
            stop_worker = (
                ocr.get("stopWorker")
                if isinstance(ocr, dict)
                else getattr(ocr, "stopWorker", None)
            )
            if callable(stop_worker):
                stopped = stop_worker()
                if inspect.isawaitable(stopped):
                    await stopped
            value = mineru["uninstall"]()
            if inspect.isawaitable(value):
                await value
            return {"ack": True}

        return await _invoke(operation)

    @router.post("/ocr/start")
    async def start_ocr(body: dict[str, Any] | None = Body(default=None)) -> JSONResponse:
        async def operation() -> dict[str, str]:
            payload = _body(body)
            profile = payload.get("profile", "balanced")
            if not isinstance(profile, str):
                raise RequestError("profile must be a string")
            job_id = ocr["startOcr"](_string(payload, "documentId"), profile)
            if inspect.isawaitable(job_id):
                job_id = await job_id
            return {"jobId": job_id}

        return await _invoke(operation)

    @router.post("/ocr/cancel")
    async def cancel_ocr(body: dict[str, Any] | None = Body(default=None)) -> JSONResponse:
        async def operation() -> Any:
            value = ocr["cancelOcr"](_string(_body(body), "jobId"))
            if inspect.isawaitable(value):
                value = await value
            return value

        return await _invoke(operation)

    @router.get("/ocr/state")
    async def ocr_state(documentId: str | None = None) -> JSONResponse:
        if documentId is None:
            return await _invoke(lambda: ocr["getOcrState"]())
        if not isinstance(documentId, str) or not documentId:
            return _failure(
                400, "validation", "documentId must be a non-empty string"
            )
        return await _invoke(lambda: ocr["getState"](documentId))

    @router.get("/ocr/documents/{document_id}/results/{result_key}/markdown")
    async def ocr_markdown(document_id: str, result_key: str) -> JSONResponse:
        async def operation() -> dict[str, str]:
            value = ocr["readMarkdown"](document_id, result_key)
            if inspect.isawaitable(value):
                value = await value
            return {"markdown": value}

        return await _invoke(operation)

    @router.get(
        "/ocr/documents/{document_id}/results/{result_key}/assets/{asset_path:path}"
    )
    async def ocr_asset(document_id: str, result_key: str, asset_path: str):
        try:
            return FileResponse(
                ocr["resolveAsset"](document_id, result_key, asset_path),
                headers={"X-Content-Type-Options": "nosniff"},
            )
        except RepoError as error:
            return _failure(_repo_status(error.code), error.code, str(error))

    return router


__all__ = ["create_workspaces_router"]
