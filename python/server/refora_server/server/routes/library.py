from __future__ import annotations

import inspect
import os
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from refora_server.library.pdf_path import resolvePdfFilePath


class _UnavailableError(RuntimeError):
    code = "unavailable"


def _value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def _dependency(deps: Any, *names: str) -> Any:
    for name in names:
        value = _value(deps, name)
        if value is not None:
            return value
    for group in ("repos", "repositories", "services"):
        nested = _value(deps, group)
        if nested is not None:
            for name in names:
                value = _value(nested, name)
                if value is not None:
                    return value
    return None


def _method(source: Any, name: str) -> Any:
    value = _value(source, name)
    if not callable(value):
        raise _UnavailableError(f"Dependency does not provide {name}")
    return value


async def _call(source: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    result = _method(source, name)(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def _success(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": True, "data": data})


def _error(exc: Exception) -> JSONResponse:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", "") or str(exc) or "Internal server error"
    if code in {"not_found", "file_missing"}:
        return JSONResponse(status_code=404, content={"ok": False, "error": {"code": "not_found", "message": message}})
    if code in {"duplicate", "conflict", "state_error"}:
        return JSONResponse(status_code=409, content={"ok": False, "error": {"code": "conflict", "message": message}})
    if code in {"unavailable", "dependency_unavailable", "connector_timeout"}:
        return JSONResponse(status_code=503, content={"ok": False, "error": {"code": "unavailable", "message": message}})
    if isinstance(exc, (ValueError, TypeError)) or code:
        return JSONResponse(status_code=400, content={"ok": False, "error": {"code": "validation", "message": message}})
    return JSONResponse(status_code=500, content={"ok": False, "error": {"code": "internal", "message": message}})


def _body_dict(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("Request body must be an object")
    return body


def _string(body: dict[str, Any], name: str, *, required: bool = True) -> str:
    value = body.get(name)
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def _ids(body: dict[str, Any], name: str = "ids") -> list[str]:
    value = body.get(name)
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{name} must be a non-empty list of strings")
    return value


def _absolute_directory(value: str) -> str:
    if not value or not os.path.isabs(value):
        raise ValueError("path must be an absolute directory path")
    resolved = os.path.abspath(value)
    if not os.path.isdir(resolved):
        raise ValueError("path must be an existing directory")
    return resolved


def _provider_input(body: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in body.items() if key not in {"apiKey", "apiKeyEnc"}}


async def _connector(connector: Any, operation: str, *args: Any) -> Any:
    names = {
        "trash": ("trashItem", "trash_item"),
        "open": ("openPath", "open_path"),
        "reveal": ("showInFolder", "show_in_folder"),
        "clipboard": ("clipboardWrite", "clipboard_write", "writeText", "write_text"),
    }[operation]
    for name in names:
        if callable(_value(connector, name)):
            return await _call(connector, name, *args)
    raise _UnavailableError(f"Connector does not provide {names[0]}")


def create_library_router(deps: Any) -> APIRouter:
    require_token = _value(deps, "require_token")
    if not callable(require_token):
        raise ValueError("deps.require_token is required")
    router = APIRouter(dependencies=[Depends(require_token)])
    documents = _dependency(deps, "documents")
    categories = _dependency(deps, "categories")
    importer = _dependency(deps, "importer")
    watcher = _dependency(deps, "watcher")
    library = _dependency(deps, "library")
    settings = _dependency(deps, "settings")
    services = _value(deps, "services", {})
    repos = _value(deps, "repos", _value(deps, "repositories", {}))
    web_search = _value(deps, "web_search") or _value(services, "webSearch") or _dependency(deps, "webSearch")
    web_search_config = _value(deps, "web_search_config") or _value(repos, "webSearchConfig")
    providers = _value(deps, "ai_providers") or _value(services, "aiProviders")
    provider_repo = _value(deps, "ai_providers_repo") or _value(repos, "aiProviders")
    exporter = _dependency(deps, "exporter", "export")
    connector = _dependency(deps, "connector")
    metadata = _dependency(deps, "metadata")

    async def run(action):
        try:
            return _success(await action())
        except Exception as exc:
            return _error(exc)

    async def document(document_id: str) -> dict[str, Any]:
        result = await _call(documents, "get", document_id)
        if result is None:
            error = RuntimeError(f"document not found: {document_id}")
            error.code = "not_found"
            raise error
        return result

    @router.get("/documents/count")
    async def count_documents(q: str = "", categoryId: str = "", starred: str = ""):
        async def action():
            items = await listed(q, categoryId, starred, 500, 0)
            return {"count": len(items)}
        return await run(action)

    async def listed(q: str, category_id: str, starred: str, limit: int, offset: int) -> list[dict[str, Any]]:
        if limit < 1 or limit > 500 or offset < 0:
            raise ValueError("limit must be between 1 and 500 and offset must not be negative")
        if q.strip():
            items = await _call(documents, "search", q.strip(), 500)
        else:
            filter_: dict[str, Any] = {}
            if category_id:
                filter_ = {"mode": "category", "categoryId": category_id}
            elif starred.lower() in {"true", "1"}:
                filter_ = {"mode": "starred"}
            elif starred and starred.lower() not in {"false", "0"}:
                raise ValueError("starred must be true or false")
            items = await _call(documents, "list", filter_)
            if starred.lower() in {"false", "0"}:
                items = [item for item in items if not item.get("starred")]
        return items[offset : offset + limit]

    @router.get("/documents")
    async def list_documents(q: str = "", categoryId: str = "", starred: str = "", limit: int = 100, offset: int = 0):
        return await run(lambda: listed(q, categoryId, starred, limit, offset))

    @router.get("/documents/search")
    async def search_documents(q: str = ""):
        return await run(lambda: _call(documents, "search", _string({"q": q}, "q"), 500))

    @router.get("/documents/{document_id}")
    async def get_document(document_id: str):
        return await run(lambda: document(document_id))

    @router.patch("/documents/{document_id}")
    async def patch_document(document_id: str, body: dict[str, Any]):
        return await run(lambda: _call(documents, "update", document_id, _body_dict(body)))

    @router.post("/documents/{document_id}/starred")
    async def set_document_starred(document_id: str, body: dict[str, Any]):
        async def action():
            value = _body_dict(body).get("starred")
            if not isinstance(value, bool):
                raise ValueError("starred must be a boolean")
            await _call(documents, "setStarred", document_id, value)
            return await document(document_id)
        return await run(action)

    async def trash_documents(ids: list[str]):
        for document_id in ids:
            item = await document(document_id)
            path = item.get("filePath")
            if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".pdf"):
                raise ValueError("Document has an invalid PDF path")
            await _connector(connector, "trash", path)
            await _call(documents, "delete", document_id)
        return {"ack": True}

    @router.delete("/documents/{document_id}")
    async def delete_document(document_id: str):
        return await run(lambda: trash_documents([document_id]))

    @router.post("/documents/bulk-delete")
    async def bulk_delete_documents(body: dict[str, Any]):
        return await run(lambda: trash_documents(_ids(_body_dict(body))))

    @router.post("/documents/bulk-categorize")
    async def bulk_categorize_documents(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            category_id = parsed.get("categoryId")
            if category_id is not None and not isinstance(category_id, str):
                raise ValueError("categoryId must be a string or null")
            for document_id in _ids(parsed):
                if category_id is None:
                    for category in await _call(categories, "listForDocument", document_id):
                        await _call(categories, "unassign", document_id, category["id"])
                else:
                    await _call(categories, "assign", document_id, category_id)
            return {"ack": True}
        return await run(action)

    async def refresh(document_id: str):
        if metadata is None:
            raise _UnavailableError("Metadata service is unavailable")
        for name in ("refresh", "refreshMetadata"):
            if callable(_value(metadata, name)):
                return await _call(metadata, name, document_id)
        raise _UnavailableError("Metadata service is unavailable")

    @router.post("/documents/{document_id}/refresh-metadata")
    async def refresh_document_metadata(document_id: str):
        return await run(lambda: refresh(document_id))

    @router.post("/documents/bulk-refresh-metadata")
    async def bulk_refresh_document_metadata(body: dict[str, Any]):
        async def action():
            for document_id in _ids(_body_dict(body)):
                await refresh(document_id)
            return {"ack": True}
        return await run(action)

    @router.post("/documents/{document_id}/relocate")
    async def relocate_document(document_id: str, body: dict[str, Any]):
        async def action():
            path = resolvePdfFilePath(_string(_body_dict(body), "path"))
            await _call(documents, "updateFilePath", document_id, path, os.path.basename(path))
            return await document(document_id)
        return await run(action)

    @router.post("/documents/{document_id}/restore-file")
    async def restore_document_file(document_id: str):
        async def action():
            if callable(_value(documents, "restoreFile")):
                return await _call(documents, "restoreFile", document_id)
            raise _UnavailableError("File restoration is unavailable")
        return await run(action)

    @router.post("/documents/{document_id}/open-pdf")
    async def open_document_pdf(document_id: str):
        async def action():
            item = await document(document_id)
            await _connector(connector, "open", item["filePath"])
            return {"ack": True}
        return await run(action)

    @router.post("/documents/{document_id}/open-in-finder")
    async def reveal_document(document_id: str):
        async def action():
            item = await document(document_id)
            await _connector(connector, "reveal", item["filePath"])
            return {"ack": True}
        return await run(action)

    async def import_result(result: dict[str, Any]) -> dict[str, Any]:
        imported = []
        for value in result.get("imported", []):
            imported.append(await document(value) if isinstance(value, str) else value)
        skipped = [{"path": path, "reason": "skipped"} if isinstance(path, str) else path for path in result.get("skipped", [])]
        skipped.extend({"path": error.get("path", ""), "reason": error.get("message", "failed")} for error in result.get("errors", []))
        return {"imported": imported, "skipped": skipped}

    @router.post("/import/files")
    async def import_files(body: dict[str, Any]):
        async def action():
            paths = _body_dict(body).get("paths", _body_dict(body).get("filePaths"))
            if not isinstance(paths, list) or not paths:
                raise ValueError("paths must be a non-empty list")
            resolved = [resolvePdfFilePath(path) if isinstance(path, str) else (_ for _ in ()).throw(ValueError("Invalid PDF path")) for path in paths]
            return await import_result(await _call(importer, "importFiles", resolved))
        return await run(action)

    @router.post("/import/folder")
    async def import_folder(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            result = await _call(importer, "importFolder", _absolute_directory(_string(parsed, "path")), bool(parsed.get("recursive", False)))
            return await import_result(result)
        return await run(action)

    @router.post("/import/json")
    async def import_json(body: dict[str, Any]):
        return await run(lambda: _call(importer, "importJson", _body_dict(body)))

    async def import_bibliography(body: dict[str, Any], name: str):
        parsed = _body_dict(body)
        if callable(_value(importer, name)):
            return await _call(importer, name, parsed.get("dbPath"), parsed.get("paths", []))
        raise _UnavailableError(f"{name} import is unavailable")

    @router.post("/import/zotero")
    async def import_zotero(body: dict[str, Any]):
        return await run(lambda: import_bibliography(body, "importZotero"))

    @router.post("/import/mendeley")
    async def import_mendeley(body: dict[str, Any]):
        return await run(lambda: import_bibliography(body, "importMendeley"))

    @router.post("/import/identifier")
    async def import_identifier(body: dict[str, Any]):
        async def action():
            document_id = await _call(importer, "importByIdentifier", _string(_body_dict(body), "identifier"))
            return {"documentId": document_id}
        return await run(action)

    @router.get("/categories")
    async def list_categories():
        return await run(lambda: _call(categories, "list"))

    @router.post("/categories")
    async def create_category(body: dict[str, Any]):
        return await run(lambda: _call(categories, "create", _string(_body_dict(body), "name")))

    @router.patch("/categories/{category_id}")
    async def patch_category(category_id: str, body: dict[str, Any]):
        async def action():
            await _call(categories, "rename", category_id, _string(_body_dict(body), "name"))
            return next(item for item in await _call(categories, "list") if item["id"] == category_id)
        return await run(action)

    @router.delete("/categories/{category_id}")
    async def delete_category(category_id: str):
        async def action():
            await _call(categories, "delete", category_id)
            return {"ack": True}
        return await run(action)

    async def assign_category(category_id: str, body: dict[str, Any], operation: str):
        for document_id in _ids(_body_dict(body), "documentIds"):
            await _call(categories, operation, document_id, category_id)
        return {"ack": True}

    @router.post("/categories/{category_id}/assign")
    async def assign_category_documents(category_id: str, body: dict[str, Any]):
        return await run(lambda: assign_category(category_id, body, "assign"))

    @router.post("/categories/{category_id}/unassign")
    async def unassign_category_documents(category_id: str, body: dict[str, Any]):
        return await run(lambda: assign_category(category_id, body, "unassign"))

    @router.get("/watch")
    async def list_watch():
        return await run(lambda: _call(watcher, "list"))

    @router.post("/watch")
    async def add_watch(body: dict[str, Any]):
        return await run(lambda: _call(watcher, "add", _absolute_directory(_string(_body_dict(body), "path"))))

    @router.delete("/watch/{watch_id}")
    async def delete_watch(watch_id: str):
        async def action():
            await _call(watcher, "remove", watch_id)
            return {"ack": True}
        return await run(action)

    @router.post("/watch/{watch_id}/toggle")
    async def toggle_watch(watch_id: str, body: dict[str, Any]):
        async def action():
            enabled = _body_dict(body).get("enabled")
            if not isinstance(enabled, bool):
                raise ValueError("enabled must be a boolean")
            return await _call(watcher, "toggle", watch_id, enabled)
        return await run(action)

    @router.post("/library/switch")
    async def switch_library(body: dict[str, Any]):
        return await run(lambda: _call(library, "switchLibrary", _absolute_directory(_string(_body_dict(body), "path"))))

    @router.get("/settings")
    async def get_settings():
        async def action():
            values = await _call(settings, "list")
            return dict(values)
        return await run(action)

    @router.patch("/settings")
    async def patch_settings(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            for key, value in parsed.items():
                if not isinstance(key, str) or not isinstance(value, (str, int, float, bool)):
                    raise ValueError("Settings values must be scalar")
                await _call(settings, "set", key, str(value))
            return dict(await _call(settings, "list"))
        return await run(action)

    @router.get("/settings/web-search")
    async def get_web_search_settings():
        return await run(lambda: _call(web_search, "getConfig"))

    @router.patch("/settings/web-search")
    async def patch_web_search_settings(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            if callable(_value(web_search, "updateConfig")):
                return await _call(web_search, "updateConfig", parsed)
            return await _call(web_search_config, "update", parsed)
        return await run(action)

    @router.post("/settings/web-search/test")
    async def test_web_search_settings(body: dict[str, Any]):
        async def action():
            return {"results": await _call(web_search, "test", _string(_body_dict(body), "query"))}
        return await run(action)

    @router.get("/ai/providers")
    async def list_providers():
        return await run(lambda: _call(providers, "list"))

    @router.post("/ai/providers")
    async def create_provider(body: dict[str, Any]):
        return await run(lambda: _call(provider_repo, "create", _provider_input(_body_dict(body))))

    @router.patch("/ai/providers/{provider_id}")
    async def patch_provider(provider_id: str, body: dict[str, Any]):
        return await run(lambda: _call(provider_repo, "update", provider_id, _provider_input(_body_dict(body))))

    @router.delete("/ai/providers/{provider_id}")
    async def delete_provider(provider_id: str):
        async def action():
            await _call(provider_repo, "delete", provider_id)
            return {"ack": True}
        return await run(action)

    @router.post("/ai/providers/{provider_id}/test")
    async def test_provider(provider_id: str, body: dict[str, Any]):
        return await run(lambda: _call(providers, "testProvider", provider_id, _string(_body_dict(body), "apiKey")))

    @router.get("/ai/providers/{provider_id}/models")
    async def list_provider_models(provider_id: str, request: Request):
        async def action():
            key = request.headers.get("X-Refora-Api-Key", "")
            return await _call(providers, "listModels", provider_id, key)
        return await run(action)

    @router.post("/export/json")
    async def export_json(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            return await _call(exporter, "exportJson", parsed.get("documentIds"), parsed.get("workspaceId"))
        return await run(action)

    @router.post("/export/bibtex")
    async def export_bibtex(body: dict[str, Any]):
        return await run(lambda: _call(exporter, "exportBibtex", _ids(_body_dict(body), "documentIds")))

    @router.get("/export/bibtex-string")
    async def export_bibtex_string(documentIds: str = ""):
        async def action():
            values = [value for value in documentIds.split(",") if value]
            if not values:
                raise ValueError("documentIds is required")
            return await _call(exporter, "getBibtexString", values)
        return await run(action)

    async def copy_text(body: dict[str, Any], field: str):
        await _connector(connector, "clipboard", _string(_body_dict(body), field))
        return {"ack": True}

    @router.post("/clipboard/write-text")
    async def write_clipboard_text(body: dict[str, Any]):
        return await run(lambda: copy_text(body, "text"))

    @router.post("/clipboard/copy-markdown")
    async def copy_clipboard_markdown(body: dict[str, Any]):
        return await run(lambda: copy_text(body, "markdown"))

    @router.post("/clipboard/copy-workspace-asset")
    async def copy_workspace_asset(body: dict[str, Any]):
        async def action():
            asset_id = _string(_body_dict(body), "assetId")
            await _connector(connector, "clipboard", asset_id)
            return {"ack": True}
        return await run(action)

    return router
