from __future__ import annotations

import asyncio
import inspect
import json
import os
import shutil
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from refora_server.academic.arxiv import base_arxiv_id
from refora_server.academic.types import ArxivSearchInput
from refora_server.library.bib_import import importFromBibtex
from refora_server.library.file_hash import streamHash
from refora_server.library.identifier_import import importByIdentifier
from refora_server.library.json_import import importFromJson
from refora_server.library.paths import containsLibrary, isInsideLibrary
from refora_server.library.pdf_path import resolvePdfFilePath
from refora_server.repositories.documents import validatePatch
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.clipboard_temp import create_clipboard_temp_service
from refora_server.server.services.library_route_support import (
    UnavailableError as _UnavailableError,
    absolute_directory as _absolute_directory,
    absolute_regular_file as _absolute_regular_file,
    body_dict as _body_dict,
    call as _call,
    connector_call as _connector,
    dependency as _dependency,
    error_response as _error,
    ids as _ids,
    json_setting as _json_setting,
    list_column_state as _list_column_state,
    method as _method,
    string as _string,
    success as _success,
    value as _value,
    window_bounds as _window_bounds,
)
from refora_server.server.services.library_settings_routes import (
    register_library_settings_routes,
)
from refora_server.server.services.run_blocking import run_blocking as _run_blocking


def create_library_router(deps: Any) -> APIRouter:
    require_token = _value(deps, "require_token")
    if not callable(require_token):
        raise ValueError("deps.require_token is required")
    router = APIRouter(dependencies=[Depends(require_token)])
    documents = _dependency(deps, "documents")
    categories = _dependency(deps, "categories")
    importer = _dependency(deps, "importer")
    watcher = _dependency(deps, "watcher")
    settings = _dependency(deps, "settings")
    services = _value(deps, "services", {})
    repos = _value(deps, "repos", _value(deps, "repositories", {}))
    workspace_assets = _value(repos, "workspaceAssets")
    workspaces = _value(repos, "workspaces")
    chat = _value(repos, "chat")
    web_search = _value(deps, "web_search") or _value(services, "webSearch") or _dependency(deps, "webSearch")
    web_search_config = _value(deps, "web_search_config") or _value(repos, "webSearchConfig")
    providers = _value(deps, "ai_providers") or _value(services, "aiProviders")
    get_proxy = _value(services, "getProxy") or _dependency(deps, "get_proxy")
    provider_repo = _value(deps, "ai_providers_repo") or _value(repos, "aiProviders")
    agent_profiles = _value(services, "agentProfiles") or _dependency(
        deps, "agentProfiles", "agent_profiles"
    )
    exporter = _dependency(deps, "exporter", "export")
    clipboard_temp = (
        _value(services, "clipboardTemp")
        or _dependency(deps, "clipboard_temp")
        or create_clipboard_temp_service()
    )
    connector = _dependency(deps, "connector")
    metadata = _dependency(deps, "metadata")
    emit = _dependency(deps, "emit")
    pdf_annotations = _value(repos, "pdfAnnotations")
    transaction = _value(repos, "transaction")

    async def run(action):
        try:
            return _success(await action())
        except Exception as exc:
            return _error(exc)

    async def call_off_loop(source: Any, name: str, *args: Any) -> Any:
        result = await _run_blocking(_method(source, name), *args)
        if inspect.isawaitable(result):
            return await result
        return result

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

    @router.get("/app/bootstrap")
    async def app_bootstrap():
        async def action():
            language = _json_setting(settings, "language", "en")
            if language not in {"zh", "en"}:
                language = "en"
            theme = _json_setting(settings, "theme", "system")
            if theme not in {"system", "dark", "light"}:
                theme = "system"
            window_bounds = _json_setting(settings, "windowBounds", None)
            list_column_state = _json_setting(settings, "listColumnState", None)
            sidebar_collapsed = _json_setting(settings, "sidebarCollapsed", "0")
            library_folder_path = _json_setting(settings, "libraryFolderPath", "")
            if not isinstance(library_folder_path, str):
                library_folder_path = ""
            return {
                "language": language,
                "theme": theme,
                "windowBounds": _window_bounds(window_bounds),
                "listColumnState": _list_column_state(list_column_state),
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
                "documents": await call_off_loop(documents, "search", query, 10),
                "workspaceFiles": await call_off_loop(workspace_assets, "search", query, 10),
                "workspaceContents": await call_off_loop(workspaces, "searchContent", query, 10),
                "chats": await call_off_loop(chat, "search", query, 10),
            }
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
            if offset > 0:
                return await call_off_loop(
                    documents, "search", q.strip(), limit or 500, offset
                )
            return await call_off_loop(documents, "search", q.strip(), limit or 500)
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
            if starred.lower() in {"false", "0"}:
                filter_["starred"] = False
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
            if limit is not None:
                filter_["limit"] = limit
            if offset > 0:
                filter_["offset"] = offset
            return await call_off_loop(documents, "list", filter_)

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
    async def search_documents(q: str = "", limit: int = 500, offset: int = 0):
        async def action():
            if limit < 1 or limit > 500:
                raise ValueError("limit must be between 1 and 500")
            if offset < 0:
                raise ValueError("offset must not be negative")
            return await _call(
                documents,
                "search",
                _string({"q": q}, "q"),
                limit,
                *([offset] if offset > 0 else []),
            )
        return await run(action)

    @router.get("/documents/{document_id}")
    async def get_document(document_id: str):
        return await run(lambda: document(document_id))

    @router.patch("/documents/{document_id}")
    async def patch_document(document_id: str, body: dict[str, Any]):
        async def action():
            patch = dict(_body_dict(body))
            validatePatch(patch)
            arxiv_id = patch.get("arxivId")
            if arxiv_id is not None:
                if metadata is None:
                    raise _UnavailableError("Metadata service is unavailable")
                before = await document(document_id)
                normalized = await _call(
                    metadata, "verifyArxivId", document_id, arxiv_id
                )
                patch["arxivId"] = normalized
                if (
                    normalized
                    and len(patch) == 1
                    and before.get("arxivId") == normalized
                ):
                    return before
            item = await _call(documents, "update", document_id, patch)
            if callable(emit):
                emitted = emit("document.updated", dict(item))
                if inspect.isawaitable(emitted):
                    await emitted
            return item

        return await run(action)

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
        items = []
        library_folder = _json_setting(settings, "libraryFolderPath", "")
        for document_id in ids:
            item = await _call(documents, "get", document_id)
            items.append(item)
        for item in items:
            if isinstance(item, Mapping) and item.get("fileMissing") != 1:
                path = item.get("filePath")
                if (
                    isinstance(path, str)
                    and os.path.isabs(path)
                    and path.lower().endswith(".pdf")
                    and not os.path.islink(path)
                    and os.path.isfile(path)
                    and isinstance(library_folder, str)
                    and bool(library_folder)
                    and isInsideLibrary(path, library_folder)
                ):
                    try:
                        await _connector(connector, "trash", path)
                    except Exception:
                        pass

        def _cleanup():
            if callable(_value(documents, "bulkDelete")):
                _method(documents, "bulkDelete")(ids)
            else:
                for document_id in ids:
                    _method(documents, "delete")(document_id)

        if callable(transaction):
            transaction(_cleanup)
        else:
            _cleanup()
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
            document_ids = _ids(parsed)
            if callable(_value(categories, "setForDocuments")):
                await _call(categories, "setForDocuments", document_ids, category_id)
                return {"ack": True}
            for document_id in document_ids:
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
            document_ids = _ids(_body_dict(body))
            if callable(_value(metadata, "bulkRefreshMetadata")):
                await _call(metadata, "bulkRefreshMetadata", document_ids)
                return {"ack": True}
            for document_id in document_ids:
                await refresh(document_id)
            return {"ack": True}
        return await run(action)

    @router.post("/documents/{document_id}/relocate")
    async def relocate_document(document_id: str, body: dict[str, Any]):
        async def action():
            current = await document(document_id)
            raw_path = _body_dict(body).get("path")
            if raw_path is not None and not isinstance(raw_path, str):
                raise ValueError("path must be a string")
            if not raw_path:
                selection = await _connector(
                    connector,
                    "dialog_file",
                    "Select PDF File",
                    ["pdf"],
                    False,
                )
                if not isinstance(selection, Mapping):
                    raise _UnavailableError("Native file dialog returned an invalid payload")
                if selection.get("canceled") is True:
                    return current
                raw_path = selection.get("path")
            if not isinstance(raw_path, str):
                raise _UnavailableError("Native file dialog did not return a path")
            path = resolvePdfFilePath(raw_path)
            file_hash = await asyncio.to_thread(streamHash, path)
            if not isinstance(file_hash, str):
                raise ValueError("Unable to hash selected PDF")
            await _call(
                documents,
                "updateFileIdentity",
                document_id,
                path,
                os.path.basename(path),
                os.path.getsize(path),
                file_hash,
            )
            if current.get("fileHash") != file_hash and callable(
                _value(ai_summaries, "delete")
            ):
                await _call(ai_summaries, "delete", document_id)
            return await document(document_id)
        return await run(action)

    @router.post("/documents/{document_id}/restore-file")
    async def restore_document_file(document_id: str):
        async def action():
            if callable(_value(documents, "restoreFile")):
                return await _call(documents, "restoreFile", document_id)
            current = await document(document_id)
            original_folder = current.get("originalFolderPath")
            if (
                not isinstance(original_folder, str)
                or not os.path.isabs(original_folder)
                or os.path.islink(original_folder)
                or not os.path.isdir(original_folder)
            ):
                raise ValueError("Original folder no longer exists")
            source_path = resolvePdfFilePath(current["filePath"])
            source = Path(source_path)
            destination = Path(original_folder) / source.name
            index = 1
            while destination.exists():
                destination = Path(original_folder) / (
                    f"{source.stem} ({index}){source.suffix}"
                )
                index += 1
            restored_path = shutil.move(source_path, str(destination))
            try:
                await _call(
                    documents,
                    "updateFilePath",
                    document_id,
                    restored_path,
                    destination.name,
                )
            except BaseException as update_error:
                try:
                    if os.path.exists(source_path):
                        raise RuntimeError("Original PDF path was occupied during rollback")
                    shutil.move(restored_path, source_path)
                except BaseException as rollback_error:
                    raise RuntimeError(
                        f"Failed to update restored PDF and rollback the file move: {rollback_error}"
                    ) from update_error
                raise
            return await document(document_id)
        return await run(action)

    @router.post("/documents/{document_id}/open-pdf")
    async def open_document_pdf(document_id: str, external: bool = True):
        async def action():
            item = await document(document_id)
            if item.get("fileMissing") == 1:
                error = RuntimeError(f"PDF file is missing for document: {document_id}")
                error.code = "file_missing"
                raise error
            path = resolvePdfFilePath(item["filePath"])
            if external:
                await _connector(connector, "open", path)
            await _call(documents, "setLastReadAt", document_id, int(time.time() * 1000))
            return await document(document_id)
        return await run(action)

    @router.post("/documents/{document_id}/open-in-finder")
    async def reveal_document(document_id: str):
        async def action():
            item = await document(document_id)
            await _connector(connector, "reveal", item["filePath"])
            return {"ack": True}
        return await run(action)

    @router.get("/documents/{document_id}/pdf-annotations")
    async def get_pdf_annotations(document_id: str):
        async def action():
            await document(document_id)
            if not callable(_value(pdf_annotations, "get")):
                return []
            return await _call(pdf_annotations, "get", document_id)
        return await run(action)

    @router.put("/documents/{document_id}/pdf-annotations")
    async def update_pdf_annotations(document_id: str, body: dict[str, Any]):
        async def action():
            await document(document_id)
            annotations = _body_dict(body).get("annotations")
            if not isinstance(annotations, list):
                raise ValueError("annotations must be an array")
            if len(annotations) > 10000 or any(not isinstance(item, dict) for item in annotations):
                raise ValueError("annotations contains invalid entries")
            encoded = json.dumps(annotations, allow_nan=False)
            if len(encoded.encode("utf-8")) > 16 * 1024 * 1024:
                raise ValueError("annotations exceeds the 16 MiB limit")
            if not callable(_value(pdf_annotations, "set")):
                raise _UnavailableError("PDF annotation storage is unavailable")
            return await _call(pdf_annotations, "set", document_id, annotations)
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
            if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
                raise ValueError("paths must be a list of strings")
            if not paths:
                selection = await _connector(
                    connector,
                    "dialog_file",
                    "Add PDF Files",
                    ["pdf"],
                    True,
                )
                if not isinstance(selection, Mapping):
                    raise _UnavailableError("Native file dialog returned an invalid payload")
                if selection.get("canceled") is True:
                    return {"added": [], "skipped": [], "errors": []}
                selected_paths = selection.get("paths")
                if not isinstance(selected_paths, list) or any(
                    not isinstance(path, str) for path in selected_paths
                ):
                    raise _UnavailableError("Native file dialog returned invalid paths")
                paths = selected_paths
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

            def load_and_import() -> dict[str, int]:
                with open(file_path, encoding="utf-8") as source:
                    return importFromJson(repos, source.read(), mode)

            return await asyncio.to_thread(load_and_import)
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
        verify_arxiv = _value(metadata, "updateVerifiedArxivId")
        source_name = "zotero" if name == "importZotero" else "mendeley"
        for raw_path in selected_paths:
            file_path = _absolute_regular_file(
                raw_path, {".bib", ".bibtex"}, 50 * 1024 * 1024
            )
            result = await importFromBibtex(
                repos,
                file_path,
                source_name,
                verify_arxiv if callable(verify_arxiv) else None,
            )
            total_added += len(result.get("added", []))
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
                target = base_arxiv_id(arxiv_id).lower()
                paper = None
                if callable(_value(arxiv, "getById")):
                    candidate = await _call(arxiv, "getById", arxiv_id)
                    if (
                        isinstance(candidate, Mapping)
                        and isinstance(candidate.get("arxivId"), str)
                        and base_arxiv_id(candidate["arxivId"]).lower() == target
                    ):
                        paper = candidate
                elif callable(_value(arxiv, "search")):
                    result = await _call(
                        arxiv,
                        "search",
                        ArxivSearchInput(query=arxiv_id, pageSize=20),
                    )
                    papers = result.get("papers", []) if isinstance(result, Mapping) else []
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
                year = paper.get("year")
                return {
                    "title": paper.get("title"),
                    "authors": (
                        "; ".join(author for author in authors if isinstance(author, str))
                        if isinstance(authors, list)
                        else None
                    ),
                    "year": (
                        str(year)
                        if isinstance(year, int) and not isinstance(year, bool)
                        else publication_date[:4]
                        if isinstance(publication_date, str)
                        and len(publication_date) >= 4
                        else year
                        if isinstance(year, str)
                        else None
                    ),
                    "abstract": paper.get("abstract"),
                    "url": paper.get("url"),
                    "doi": paper.get("doi"),
                    "arxivId": paper.get("arxivId"),
                    "pdfUrl": paper.get("pdfUrl"),
                    "metadataSource": "arxiv",
                }

            async def fetch_doi_metadata(doi: str) -> dict[str, Any] | None:
                operation = _value(metadata, "fetchDoiMetadata")
                if not callable(operation):
                    return None
                return await _call(metadata, "fetchDoiMetadata", doi)

            document_id = await importByIdentifier(
                repos,
                _string(_body_dict(body), "identifier"),
                {
                    "getLibraryFolder": lambda: _json_setting(
                        settings, "libraryFolderPath", ""
                    ),
                    "academicIdentityService": identity,
                    "fetchArxivMetadata": fetch_arxiv_metadata,
                    "fetchDoiMetadata": fetch_doi_metadata,
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
        document_ids = _ids(_body_dict(body), "documentIds")
        bulk_operation = "assignMany" if operation == "assign" else "unassignMany"
        if callable(_value(categories, bulk_operation)):
            await _call(categories, bulk_operation, document_ids, category_id)
            return {"ack": True}
        for document_id in document_ids:
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
        async def action():
            path = _absolute_directory(_string(_body_dict(body), "path"))
            library_folder = _json_setting(settings, "libraryFolderPath", "")
            if isinstance(library_folder, str) and library_folder:
                if isInsideLibrary(path, library_folder):
                    error = RuntimeError("Path cannot be inside the library folder.")
                    error.code = "inside_library"
                    raise error
                if containsLibrary(path, library_folder):
                    error = RuntimeError("Path cannot contain the library folder.")
                    error.code = "contains_library"
                    raise error
            return await _call(watcher, "add", path)
        return await run(action)

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

    export_target = exporter
    if isinstance(exporter, Mapping) and callable(exporter.get("exportJson")):
        raw_export_json = exporter["exportJson"]

        def export_json_off_loop(*args: Any) -> Any:
            return _run_blocking(raw_export_json, *args)

        export_target = {**exporter, "exportJson": export_json_off_loop}

    register_library_settings_routes(
        router,
        {
            "run": run,
            "settings": settings,
            "connector": connector,
            "transaction": transaction,
            "web_search": web_search,
            "web_search_config": web_search_config,
            "providers": providers,
            "provider_repo": provider_repo,
            "agent_profiles": agent_profiles,
            "get_proxy": get_proxy,
            "exporter": export_target,
            "clipboard_temp": clipboard_temp,
            "workspace_assets": workspace_assets,
            "create_ai_providers": createAiProvidersService,
        },
    )

    return router
