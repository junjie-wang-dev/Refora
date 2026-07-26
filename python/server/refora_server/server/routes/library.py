from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import re
import tempfile
from pathlib import Path
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from refora_server.academic.arxiv import base_arxiv_id
from refora_server.academic.types import ArxivSearchInput
from refora_server.library.bib_import import importBibtex
from refora_server.library.identifier_import import importByIdentifier
from refora_server.library.json_import import importFromJson
from refora_server.library.paths import resolveFromLibrary
from refora_server.library.pdf_path import resolvePdfFilePath
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.web.types import WEB_SEARCH_PROVIDERS


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


def _markdown_file_name(title: str) -> str:
    normalized = re.sub(r"\.md$", "", title.strip(), flags=re.IGNORECASE)
    normalized = re.sub(r'[<>:"/\\|?*]', "-", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip().rstrip(". ")[:120]
    return f"{normalized or 'card'}.md"


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
        "clipboard_file": ("clipboardWriteFile", "clipboard_write_file"),
        "dialog_directory": ("dialogOpenDirectory", "dialog_open_directory"),
        "dialog_file": ("dialogOpenFile", "dialog_open_file"),
        "dialog_choose": ("dialogChoose", "dialog_choose"),
        "get_api_key": ("getApiKey", "get_api_key"),
        "encrypt_api_key": ("encryptApiKey", "encrypt_api_key"),
        "decrypt_api_key": ("decryptApiKey", "decrypt_api_key"),
    }[operation]
    for name in names:
        if callable(_value(connector, name)):
            result = await _call(connector, name, *args)
            if isinstance(result, Mapping) and "ok" in result:
                if result.get("ok") is True:
                    return result.get("data")
                error = result.get("error")
                code = error.get("code") if isinstance(error, Mapping) else "connector_error"
                message = error.get("message") if isinstance(error, Mapping) else "Native connector failed"
                failure = RuntimeError(str(message))
                failure.code = str(code)
                raise failure
            return result
    raise _UnavailableError(f"Connector does not provide {names[0]}")


def _json_setting(settings: Any, key: str, default: Any) -> Any:
    raw = _method(settings, "get")(key, None)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def _absolute_regular_file(value: str, extensions: set[str], max_bytes: int) -> str:
    if not value or not os.path.isabs(value):
        raise ValueError("path must be absolute")
    path = Path(value)
    if path.suffix.lower() not in extensions:
        raise ValueError(f"path must have one of these extensions: {', '.join(sorted(extensions))}")
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError("path must be an existing regular file")
        if path.stat().st_size > max_bytes:
            raise ValueError(f"file exceeds the {max_bytes // (1024 * 1024)} MB limit")
        return str(path.resolve(strict=True))
    except OSError as error:
        raise ValueError("path must be an existing regular file") from error


def _base64_blob(value: Any) -> bytes | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _UnavailableError("Native encryption returned an invalid payload")
    try:
        return base64.b64decode(value, validate=True)
    except ValueError as error:
        raise _UnavailableError("Native encryption returned invalid base64") from error


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
    workspace_assets = _value(repos, "workspaceAssets")
    workspaces = _value(repos, "workspaces")
    chat = _value(repos, "chat")
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

    async def selected_file(
        path: Any,
        *,
        title: str,
        extensions: list[str],
        max_bytes: int,
    ) -> str | None:
        selected = path
        if not isinstance(selected, str) or not selected.strip():
            result = await _connector(connector, "dialog_file", title, extensions)
            if not isinstance(result, Mapping):
                raise _UnavailableError("Native file dialog returned an invalid payload")
            if result.get("canceled") is True:
                return None
            selected = result.get("path")
        if not isinstance(selected, str):
            raise ValueError("path must be a string")
        return _absolute_regular_file(
            selected,
            {f".{extension.lower().lstrip('.')}" for extension in extensions},
            max_bytes,
        )

    async def provider_api_key(provider_id: str) -> str:
        data = await _connector(connector, "get_api_key", provider_id)
        if not isinstance(data, Mapping) or not isinstance(data.get("apiKey"), str):
            raise _UnavailableError("Native key storage returned an invalid payload")
        return data["apiKey"]

    async def encrypted_provider_input(body: dict[str, Any]) -> dict[str, Any]:
        parsed = _body_dict(body)
        output = _provider_input(parsed)
        if "apiKey" not in parsed:
            return output
        api_key = parsed.get("apiKey")
        if not isinstance(api_key, str):
            raise ValueError("apiKey must be a string")
        data = await _connector(connector, "encrypt_api_key", api_key)
        if not isinstance(data, Mapping) or "apiKeyEnc" not in data:
            raise _UnavailableError("Native key storage returned an invalid payload")
        output["apiKeyEnc"] = _base64_blob(data.get("apiKeyEnc"))
        return output

    async def encrypted_search_key(api_key: str) -> bytes | None:
        data = await _connector(connector, "encrypt_api_key", api_key)
        if not isinstance(data, Mapping):
            raise _UnavailableError("Native key storage returned an invalid payload")
        return _base64_blob(data.get("apiKeyEnc"))

    def workspace_asset_file(asset_id: str) -> str:
        asset = _method(workspace_assets, "get")(asset_id)
        if asset is None:
            error = RuntimeError(f"workspace asset not found: {asset_id}")
            error.code = "not_found"
            raise error
        library_folder = _json_setting(settings, "libraryFolderPath", "")
        if not isinstance(library_folder, str) or not os.path.isabs(library_folder):
            raise ValueError("Library folder is not configured")
        file_path = asset.get("filePath")
        file_name = asset.get("fileName")
        if not isinstance(file_path, str) or not isinstance(file_name, str):
            raise ValueError("Workspace asset has an invalid path")
        resolved = os.path.abspath(resolveFromLibrary(file_path, library_folder))
        asset_directory = os.path.abspath(
            os.path.join(library_folder, "refora-assets", asset_id)
        )
        try:
            inside = os.path.commonpath([asset_directory, resolved]) == asset_directory
        except ValueError:
            inside = False
        if (
            not inside
            or os.path.dirname(resolved) != asset_directory
            or os.path.basename(resolved) != file_name
            or os.path.islink(resolved)
            or not os.path.isfile(resolved)
        ):
            raise ValueError("Workspace asset path is invalid or missing")
        return resolved

    @router.get("/app/bootstrap")
    async def app_bootstrap():
        async def action():
            language = _json_setting(settings, "language", "en")
            if language not in {"zh", "en"}:
                language = "en"
            window_bounds = _json_setting(settings, "windowBounds", None)
            list_column_state = _json_setting(settings, "listColumnState", None)
            sidebar_collapsed = _json_setting(settings, "sidebarCollapsed", "0")
            library_folder_path = _json_setting(settings, "libraryFolderPath", "")
            if not isinstance(library_folder_path, str):
                library_folder_path = ""
            return {
                "language": language,
                "windowBounds": window_bounds if isinstance(window_bounds, dict) else None,
                "listColumnState": list_column_state if isinstance(list_column_state, dict) else None,
                "sidebarCollapsed": sidebar_collapsed is True or sidebar_collapsed == "1",
                "firstRun": not bool(library_folder_path),
                "libraryFolderPath": library_folder_path or None,
            }
        return await run(action)

    @router.get("/search/global")
    async def global_search(q: str = ""):
        async def action():
            if not isinstance(q, str) or not q.strip():
                return {
                    "documents": [],
                    "workspaceFiles": [],
                    "workspaceContents": [],
                    "chats": [],
                }
            query = q.strip()[:500]
            return {
                "documents": await _call(documents, "search", query, 10),
                "workspaceFiles": await _call(workspace_assets, "search", query, 10),
                "workspaceContents": await _call(workspaces, "searchContent", query, 10),
                "chats": await _call(chat, "search", query, 10),
            }
        return await run(action)

    @router.post("/dialog/open-directory")
    async def open_directory_dialog(body: dict[str, Any]):
        async def action():
            title = _body_dict(body).get("title")
            if title is not None and not isinstance(title, str):
                raise ValueError("title must be a string")
            result = await _connector(connector, "dialog_directory", title)
            if not isinstance(result, Mapping):
                raise _UnavailableError("Native directory dialog returned an invalid payload")
            canceled = result.get("canceled") is True
            path = result.get("path")
            if canceled:
                return {"canceled": True, "path": None}
            if not isinstance(path, str):
                raise _UnavailableError("Native directory dialog did not return a path")
            return {"canceled": False, "path": _absolute_directory(path)}
        return await run(action)

    @router.get("/documents/count")
    async def count_documents(q: str = "", categoryId: str = "", starred: str = ""):
        return await run(lambda: _call(documents, "counts"))

    async def listed(
        q: str,
        mode: str,
        category_id: str,
        starred: str,
        sort_field: str,
        sort_dir: str,
        limit: int | None,
        offset: int,
    ) -> list[dict[str, Any]]:
        if limit is not None and (limit < 1 or limit > 10_000):
            raise ValueError("limit must be between 1 and 10000")
        if offset < 0:
            raise ValueError("offset must not be negative")
        if q.strip():
            items = await _call(documents, "search", q.strip(), limit or 500)
        else:
            valid_modes = {"all", "recentlyRead", "recentlyAdded", "starred", "category"}
            if mode and mode not in valid_modes:
                raise ValueError("mode is invalid")
            filter_: dict[str, Any] = {"mode": mode or "all"}
            if filter_["mode"] == "category":
                if not category_id:
                    raise ValueError("categoryId is required for category mode")
                filter_["categoryId"] = category_id
            elif starred.lower() in {"true", "1"}:
                filter_ = {"mode": "starred"}
            elif starred and starred.lower() not in {"false", "0"}:
                raise ValueError("starred must be true or false")
            if sort_field or sort_dir:
                if sort_field not in {
                    "title",
                    "authors",
                    "year",
                    "venue",
                    "addedAt",
                    "filePath",
                } or sort_dir not in {"asc", "desc"}:
                    raise ValueError("sortField and a valid sortDir are required")
                filter_["sort"] = {"field": sort_field, "dir": sort_dir}
            items = await _call(documents, "list", filter_)
            if starred.lower() in {"false", "0"}:
                items = [item for item in items if not item.get("starred")]
        return items[offset:] if limit is None else items[offset : offset + limit]

    @router.get("/documents")
    async def list_documents(
        q: str = "",
        mode: str = "",
        categoryId: str = "",
        starred: str = "",
        sortField: str = "",
        sortDir: str = "",
        limit: int | None = None,
        offset: int = 0,
    ):
        return await run(
            lambda: listed(
                q,
                mode,
                categoryId,
                starred,
                sortField,
                sortDir,
                limit,
                offset,
            )
        )

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
        added = [
            value["id"] if isinstance(value, Mapping) and isinstance(value.get("id"), str) else value
            for value in result.get("imported", [])
            if isinstance(value, str) or isinstance(value, Mapping)
        ]
        skipped = [
            value.get("path", "") if isinstance(value, Mapping) else value
            for value in result.get("skipped", [])
            if isinstance(value, str) or isinstance(value, Mapping)
        ]
        errors = [
            {
                "path": error.get("path", "") if isinstance(error, Mapping) else "",
                "message": error.get("message", "failed") if isinstance(error, Mapping) else str(error),
            }
            for error in result.get("errors", [])
        ]
        return {"added": added, "skipped": skipped, "errors": errors}

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
    async def import_json(body: Any):
        async def action():
            parsed = body if isinstance(body, dict) else {"path": body}
            file_path = await selected_file(
                parsed.get("path"),
                title="Import JSON",
                extensions=["json"],
                max_bytes=100 * 1024 * 1024,
            )
            if file_path is None:
                return {"imported": 0}
            mode = parsed.get("mode")
            if mode is None:
                choice = await _connector(
                    connector,
                    "dialog_choose",
                    "Import Mode",
                    "How should the import handle existing data?",
                    ["Merge (keep existing, add new)", "Replace (clear all, import)", "Cancel"],
                    0,
                    2,
                )
                if not isinstance(choice, Mapping):
                    raise _UnavailableError("Native choice dialog returned an invalid payload")
                if choice.get("canceled") is True or choice.get("response") == 2:
                    return {"imported": 0}
                mode = "replace" if choice.get("response") == 1 else "merge"
            if mode not in {"merge", "replace"}:
                raise ValueError("mode must be merge or replace")
            with open(file_path, encoding="utf-8") as source:
                return importFromJson(repos, source.read(), mode)
        return await run(action)

    async def import_bibliography(body: dict[str, Any], name: str):
        parsed = _body_dict(body)
        paths = parsed.get("paths", [])
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            raise ValueError("paths must be a list of strings")
        selected_paths = paths
        if not selected_paths:
            selected = await selected_file(
                None,
                title=f"Import from {'Zotero' if name == 'importZotero' else 'Mendeley'} (BibTeX)",
                extensions=["bib", "bibtex"],
                max_bytes=50 * 1024 * 1024,
            )
            if selected is None:
                return {"added": 0, "skipped": 0, "errors": []}
            selected_paths = [selected]
        total_added = 0
        total_skipped = 0
        errors: list[dict[str, str]] = []
        for raw_path in selected_paths:
            file_path = _absolute_regular_file(
                raw_path, {".bib", ".bibtex"}, 50 * 1024 * 1024
            )
            with open(file_path, encoding="utf-8") as source:
                result = importBibtex(repos, source.read())
            total_added += len(result.get("imported", []))
            total_skipped += len(result.get("skipped", []))
            errors.extend(result.get("errors", []))
        return {"added": total_added, "skipped": total_skipped, "errors": errors}

    @router.post("/import/zotero")
    async def import_zotero(body: dict[str, Any]):
        return await run(lambda: import_bibliography(body, "importZotero"))

    @router.post("/import/mendeley")
    async def import_mendeley(body: dict[str, Any]):
        return await run(lambda: import_bibliography(body, "importMendeley"))

    @router.post("/import/identifier")
    async def import_identifier(body: dict[str, Any]):
        async def action():
            academic = _value(services, "academic", {})
            identity = _value(academic, "identity")
            arxiv = _value(academic, "arxiv", {})

            async def fetch_arxiv_metadata(arxiv_id: str) -> dict[str, Any] | None:
                if not callable(_value(arxiv, "search")):
                    return None
                result = await _call(
                    arxiv,
                    "search",
                    ArxivSearchInput(query=arxiv_id, pageSize=20),
                )
                papers = result.get("papers", []) if isinstance(result, Mapping) else []
                target = base_arxiv_id(arxiv_id).lower()
                paper = next(
                    (
                        item
                        for item in papers
                        if isinstance(item, Mapping)
                        and isinstance(item.get("arxivId"), str)
                        and base_arxiv_id(item["arxivId"]).lower() == target
                    ),
                    None,
                )
                if paper is None:
                    return None
                authors = paper.get("authors", [])
                publication_date = paper.get("publicationDate")
                return {
                    "title": paper.get("title"),
                    "authors": (
                        "; ".join(author for author in authors if isinstance(author, str))
                        if isinstance(authors, list)
                        else None
                    ),
                    "year": (
                        publication_date[:4]
                        if isinstance(publication_date, str) and len(publication_date) >= 4
                        else None
                    ),
                    "abstract": paper.get("abstract"),
                    "url": paper.get("url"),
                    "doi": paper.get("doi"),
                    "arxivId": paper.get("arxivId"),
                    "pdfUrl": paper.get("pdfUrl"),
                    "metadataSource": "arxiv",
                }

            document_id = await importByIdentifier(
                repos,
                _string(_body_dict(body), "identifier"),
                {
                    "getLibraryFolder": lambda: _json_setting(
                        settings, "libraryFolderPath", ""
                    ),
                    "academicIdentityService": identity,
                    "fetchArxivMetadata": fetch_arxiv_metadata,
                },
            )
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
            decoded: dict[str, Any] = {}
            for key, value in values:
                try:
                    decoded[key] = json.loads(value)
                except (TypeError, ValueError):
                    decoded[key] = value
            return decoded
        return await run(action)

    @router.patch("/settings")
    async def patch_settings(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            for key, value in parsed.items():
                if not isinstance(key, str) or not key:
                    raise ValueError("Settings keys must be non-empty strings")
                try:
                    encoded = json.dumps(value, allow_nan=False)
                except (TypeError, ValueError) as error:
                    raise ValueError(f"Setting {key} is not JSON serializable") from error
                await _call(settings, "set", key, encoded)
            values = await _call(settings, "list")
            decoded: dict[str, Any] = {}
            for key, value in values:
                try:
                    decoded[key] = json.loads(value)
                except (TypeError, ValueError):
                    decoded[key] = value
            return decoded
        return await run(action)

    @router.get("/settings/web-search")
    async def get_web_search_settings():
        return await run(lambda: _call(web_search, "getConfig"))

    @router.patch("/settings/web-search")
    async def patch_web_search_settings(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            allowed = {
                "provider",
                "tavilyApiKey",
                "braveApiKey",
                "clearTavilyApiKey",
                "clearBraveApiKey",
            }
            unknown = set(parsed) - allowed
            if unknown:
                raise ValueError(
                    f"Unknown web search setting: {sorted(unknown)[0]}"
                )
            current = await _call(web_search_config, "get")
            provider = parsed.get("provider", current.get("provider"))
            if provider not in WEB_SEARCH_PROVIDERS:
                raise ValueError("Unknown web search provider")
            tavily_key = parsed.get("tavilyApiKey")
            brave_key = parsed.get("braveApiKey")
            clear_tavily = parsed.get("clearTavilyApiKey", False)
            clear_brave = parsed.get("clearBraveApiKey", False)
            if not isinstance(clear_tavily, bool) or not isinstance(clear_brave, bool):
                raise ValueError("Web search clear flags must be booleans")
            if tavily_key is not None and not isinstance(tavily_key, str):
                raise ValueError("tavilyApiKey must be a string")
            if brave_key is not None and not isinstance(brave_key, str):
                raise ValueError("braveApiKey must be a string")
            tavily_key = tavily_key.strip() if isinstance(tavily_key, str) else ""
            brave_key = brave_key.strip() if isinstance(brave_key, str) else ""
            if clear_tavily and tavily_key:
                raise ValueError("Tavily API key cannot be set and cleared together")
            if clear_brave and brave_key:
                raise ValueError("Brave API key cannot be set and cleared together")
            patch: dict[str, Any] = {"provider": provider}
            if clear_tavily:
                patch["tavilyApiKeyEnc"] = None
            elif tavily_key:
                patch["tavilyApiKeyEnc"] = await encrypted_search_key(tavily_key)
            if clear_brave:
                patch["braveApiKeyEnc"] = None
            elif brave_key:
                patch["braveApiKeyEnc"] = await encrypted_search_key(brave_key)
            has_tavily = (
                patch.get("tavilyApiKeyEnc", current.get("tavilyApiKeyEnc"))
                is not None
            )
            has_brave = (
                patch.get("braveApiKeyEnc", current.get("braveApiKeyEnc"))
                is not None
            )
            if provider == "tavily" and not has_tavily:
                raise ValueError(
                    "Configure a Tavily API key before selecting Tavily"
                )
            if provider == "brave" and not has_brave:
                raise ValueError("Configure a Brave API key before selecting Brave")
            await _call(web_search_config, "update", patch)
            return await _call(web_search, "getConfig")
        return await run(action)

    @router.post("/settings/web-search/test")
    async def test_web_search_settings(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            query = parsed.get("query", "")
            if not isinstance(query, str):
                raise ValueError("query must be a string")
            test_search = _method(web_search, "test")
            return await asyncio.to_thread(test_search, query)
        return await run(action)

    @router.get("/ai/providers")
    async def list_providers():
        return await run(lambda: _call(providers, "list"))

    @router.post("/ai/providers")
    async def create_provider(body: dict[str, Any]):
        async def action():
            return await _call(provider_repo, "create", await encrypted_provider_input(body))
        return await run(action)

    @router.patch("/ai/providers/{provider_id}")
    async def patch_provider(provider_id: str, body: dict[str, Any]):
        async def action():
            return await _call(
                provider_repo, "update", provider_id, await encrypted_provider_input(body)
            )
        return await run(action)

    @router.delete("/ai/providers/{provider_id}")
    async def delete_provider(provider_id: str):
        async def action():
            await _call(provider_repo, "delete", provider_id)
            return {"ack": True}
        return await run(action)

    @router.post("/ai/providers/{provider_id}/test")
    async def test_provider(provider_id: str):
        async def action():
            return await _call(
                providers, "testProvider", provider_id, await provider_api_key(provider_id)
            )
        return await run(action)

    @router.post("/ai/providers/models")
    async def list_provider_models(body: dict[str, Any]):
        async def action():
            parsed = _body_dict(body)
            provider_id = parsed.get("providerId")
            if provider_id is not None:
                if not isinstance(provider_id, str) or not provider_id.strip():
                    raise ValueError("providerId must be a non-empty string")
                return await _call(
                    providers,
                    "listModels",
                    provider_id,
                    await provider_api_key(provider_id),
                )
            base_url = parsed.get("baseUrl")
            api_key = parsed.get("apiKey", "")
            if not isinstance(base_url, str) or not base_url.strip():
                return {"ok": False, "models": [], "error": "Base URL is required"}
            if not isinstance(api_key, str):
                raise ValueError("apiKey must be a string")
            transient_raw = {
                "id": "__transient__",
                "presetId": parsed.get("presetId") or "custom",
                "name": "Unsaved provider",
                "baseUrl": base_url,
                "model": "",
            }
            transient = createAiProvidersService(
                {
                    "aiProviders": {
                        "getRaw": lambda provider: (
                            transient_raw if provider == "__transient__" else None
                        )
                    }
                }
            )
            return await _call(transient, "listModels", "__transient__", api_key)
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
        async def action():
            payload = _body_dict(body)
            title = _string(payload, "title")
            markdown = _string(payload, "markdown")
            directory = Path(tempfile.mkdtemp(prefix="refora-clipboard-"))
            path = directory / _markdown_file_name(title)
            path.write_text(markdown, encoding="utf-8")
            await _connector(connector, "clipboard_file", str(path))
            return {"ack": True}

        return await run(action)

    @router.post("/clipboard/copy-workspace-asset")
    async def copy_workspace_asset(body: dict[str, Any]):
        async def action():
            asset_id = _string(_body_dict(body), "assetId")
            await _connector(connector, "clipboard_file", workspace_asset_file(asset_id))
            return {"ack": True}
        return await run(action)

    return router
