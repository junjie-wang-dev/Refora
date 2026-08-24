from __future__ import annotations

import asyncio
import hashlib
import inspect
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from refora_server.library.importer import hashPdf, validatePdfPath
from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_assets import workspace_asset_media_type
from refora_server.services.workspace_note_input import parse_workspace_note_patch

WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT = 256 * 1024
WORKSPACE_ASSET_DIRECTORY = "refora-assets"
WORKSPACE_ASSET_IMPORT_LIMIT = 512 * 1024 * 1024
WORKSPACE_ASSET_DISK_RESERVE = 64 * 1024 * 1024
WORKSPACE_MARKDOWN_IMPORT_LIMIT = 16 * 1024 * 1024


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    import uuid

    return str(uuid.uuid4())


def _validate_source_file(raw_path: str) -> str:
    if not raw_path or not os.path.isabs(raw_path):
        raise RepoError("invalid_path", "Workspace asset path must be absolute")
    resolved = os.path.abspath(raw_path)
    if not os.path.exists(resolved):
        raise RepoError("file_missing", f"File not found: {resolved}")
    if os.path.islink(resolved) or not os.path.isfile(resolved):
        raise RepoError("invalid_path", "Workspace assets must be regular files")
    return resolved


def _read_markdown_file(raw_path: str) -> tuple[str, str]:
    resolved = _validate_source_file(raw_path)
    path = Path(resolved)
    if path.suffix.lower() not in {".md", ".markdown"}:
        raise RepoError("invalid_path", "Workspace Markdown files must use .md or .markdown")
    if path.stat().st_size > WORKSPACE_MARKDOWN_IMPORT_LIMIT:
        raise RepoError("file_too_large", "Workspace Markdown file exceeds the 16 MiB limit")
    try:
        content = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RepoError("invalid_encoding", "Workspace Markdown files must be UTF-8") from exc
    return path.stem, content


def _validate_asset_source(raw_path: str) -> tuple[str, int]:
    resolved = _validate_source_file(raw_path)
    try:
        file_size = os.path.getsize(resolved)
    except OSError as exc:
        raise RepoError("invalid_path", f"Unable to inspect workspace asset: {resolved}") from exc
    if file_size > WORKSPACE_ASSET_IMPORT_LIMIT:
        raise RepoError(
            "file_too_large",
            "Workspace asset exceeds the 512 MiB limit",
        )
    return resolved, file_size


def _require_asset_capacity(directory: str, file_size: int) -> None:
    try:
        free_bytes = shutil.disk_usage(directory).free
    except OSError as exc:
        raise RepoError("storage_unavailable", "Unable to inspect library disk space") from exc
    if free_bytes < file_size + WORKSPACE_ASSET_DISK_RESERVE:
        raise RepoError(
            "insufficient_storage",
            "Not enough disk space to import workspace asset",
        )


def _stage_asset_file(
    source_path: str,
    destination: str,
    expected_size: int,
    cancelled: threading.Event | None = None,
) -> tuple[int, str]:
    asset_directory = os.path.dirname(destination)
    temporary_fd, temporary_path = tempfile.mkstemp(
        prefix=".refora-import-", suffix=".tmp", dir=asset_directory
    )
    source_fd = -1
    digest = hashlib.sha256()
    copied = 0
    try:
        source_fd = os.open(
            source_path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
        with os.fdopen(source_fd, "rb") as source:
            source_fd = -1
            with os.fdopen(temporary_fd, "wb") as target:
                temporary_fd = -1
                while True:
                    if cancelled is not None and cancelled.is_set():
                        raise asyncio.CancelledError
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > WORKSPACE_ASSET_IMPORT_LIMIT:
                        raise RepoError(
                            "file_too_large",
                            "Workspace asset exceeds the 512 MiB limit",
                        )
                    target.write(chunk)
                    digest.update(chunk)
                target.flush()
                os.fsync(target.fileno())
        if copied != expected_size:
            raise RepoError("source_changed", "Workspace asset changed during import")
        shutil.copystat(source_path, temporary_path, follow_symlinks=False)
        os.replace(temporary_path, destination)
        directory_fd = os.open(asset_directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return copied, digest.hexdigest()
    finally:
        if source_fd >= 0:
            os.close(source_fd)
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass


def _require_library_folder(repos: dict[str, Any]) -> str:
    library_folder = repos["settings"].get("libraryFolderPath", "")
    if not library_folder:
        raise RepoError("library_not_configured", "Library folder is not configured")
    resolved = os.path.abspath(library_folder)
    if not os.path.isdir(resolved):
        raise RepoError("invalid_library", f"Library folder is unavailable: {resolved}")
    return resolved


def _to_library_relative(abs_path: str, library_folder: str) -> str:
    from refora_server.library.paths import toLibraryRelative

    return toLibraryRelative(abs_path, library_folder)


def _resolve_from_library(rel_or_abs: str, library_folder: str) -> str:
    from refora_server.library.paths import resolveFromLibrary

    return resolveFromLibrary(rel_or_abs, library_folder)


def _resolve_workspace_asset_path(repos: dict[str, Any], asset: dict[str, Any]) -> str:
    library_folder = _require_library_folder(repos)
    asset_directory = os.path.abspath(
        os.path.join(library_folder, WORKSPACE_ASSET_DIRECTORY, asset["id"])
    )
    resolved = os.path.abspath(_resolve_from_library(asset["filePath"], library_folder))
    relative_to_directory = os.path.relpath(resolved, asset_directory)
    if (
        os.path.dirname(resolved) != asset_directory
        or os.path.basename(resolved) != asset["fileName"]
        or relative_to_directory.startswith("..")
        or os.path.isabs(relative_to_directory)
    ):
        raise RepoError("invalid_path", "Workspace asset path is outside its managed directory")
    return resolved


def _require_workspace_asset_file(
    repos: dict[str, Any], asset_id: str
) -> tuple[dict[str, Any], str]:
    asset = repos["workspaceAssets"]["get"](asset_id)
    if asset is None:
        raise RepoError("not_found", f"workspace asset not found: {asset_id}")
    file_path = _resolve_workspace_asset_path(repos, asset)
    try:
        if not os.path.exists(file_path) or os.path.islink(file_path) or not os.path.isfile(file_path):
            if asset["fileMissing"] != 1:
                repos["workspaceAssets"]["update"](asset_id, {"fileMissing": True})
            raise RepoError("file_missing", f"Workspace asset is missing: {asset['fileName']}")
    except RepoError:
        raise
    except OSError:
        if asset["fileMissing"] != 1:
            repos["workspaceAssets"]["update"](asset_id, {"fileMissing": True})
        raise RepoError("invalid_path", f"Unable to inspect workspace asset: {asset['fileName']}")
    if asset["fileMissing"] != 0:
        repos["workspaceAssets"]["update"](asset_id, {"fileMissing": False})
    refreshed = repos["workspaceAssets"]["get"](asset_id)
    return refreshed, file_path


def _connector_method(connector, name):
    if connector is None:
        return None
    aliases = {
        "openPath": "open_path",
        "showInFolder": "show_in_folder",
        "trashItem": "trash_item",
    }
    if isinstance(connector, dict):
        return connector.get(name) or connector.get(aliases.get(name, ""))
    return getattr(connector, name, None) or getattr(
        connector, aliases.get(name, ""), None
    )


def _sandbox_method(sandbox, name):
    if sandbox is None:
        return None
    if isinstance(sandbox, dict):
        return sandbox.get(name)
    return getattr(sandbox, name, None)


def createWorkspacesService(repos: dict[str, Any], deps: dict[str, Any] | None = None):
    deps = deps or {}
    connector = deps.get("connector")
    logger = deps.get("logger")
    sandbox = deps.get("sandbox")
    get_sandbox_path = deps.get("getSandboxPath") or deps.get("get_sandbox_path")
    agent_runtime = deps.get("agentRuntime")
    academic = deps.get("academic") or {}
    importer = deps.get("importer")

    async def _connector_call(name: str, *args: Any) -> Any:
        operation = _connector_method(connector, name)
        if operation is None:
            raise RepoError("not_ready", "Connector is not available")
        result = operation(*args)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, dict) and isinstance(result.get("ok"), bool):
            if result["ok"]:
                return result.get("data")
            error = result.get("error")
            code = (
                error.get("code")
                if isinstance(error, dict) and isinstance(error.get("code"), str)
                else "connector_failed"
            )
            message = (
                error.get("message")
                if isinstance(error, dict) and isinstance(error.get("message"), str)
                else "Native operation failed"
            )
            raise RepoError(code, message)
        return result

    def _transaction(fn: Callable[[], Any]) -> Any:
        tx = repos.get("transaction")
        if tx is not None:
            return tx(fn)
        return fn()

    def _require_workspace(workspace_id: str) -> dict[str, Any]:
        workspace = repos["workspaces"]["get"](workspace_id)
        if workspace is None:
            raise RepoError("not_found", f"workspace not found: {workspace_id}")
        return workspace

    def _require_scoped(
        repository_name: str,
        record_name: str,
        record_id: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        repository = repos[repository_name]
        getter = repository.get("get") if isinstance(repository, dict) else getattr(repository, "get", None)
        if not callable(getter):
            raise RepoError("not_ready", f"{record_name} lookup is unavailable")
        record = getter(record_id)
        if record is None or (
            workspace_id is not None and record.get("workspaceId") != workspace_id
        ):
            raise RepoError("not_found", f"{record_name} not found: {record_id}")
        return record

    def list_workspaces() -> list[dict[str, Any]]:
        return repos["workspaces"]["list"]()

    def _sandbox_root(workspace_id: str) -> str | None:
        ensure = _sandbox_method(sandbox, "ensure")
        if ensure is not None:
            sandbox_paths = ensure(workspace_id)
            return sandbox_paths["sandboxRoot"] if isinstance(sandbox_paths, dict) else None
        if callable(get_sandbox_path):
            sandbox_root = get_sandbox_path(workspace_id)
            if isinstance(sandbox_root, str) and os.path.isabs(sandbox_root):
                os.makedirs(sandbox_root, mode=0o700, exist_ok=True)
                if os.path.islink(sandbox_root) or not os.path.isdir(sandbox_root):
                    raise RepoError("invalid_path", "Agent sandbox path is invalid")
                return sandbox_root
        return None

    async def _delete_sandbox(workspace_id: str) -> None:
        ensure = _sandbox_method(sandbox, "ensure")
        if ensure is not None:
            paths = ensure(workspace_id)
            sandbox_root = paths["sandboxRoot"] if isinstance(paths, dict) else None
        elif callable(get_sandbox_path):
            sandbox_root = get_sandbox_path(workspace_id)
        else:
            sandbox_root = None
        if isinstance(sandbox_root, str) and os.path.isdir(sandbox_root):
            await _connector_trash(sandbox_root)

    async def _delete_workspace_threads(workspace_id: str) -> None:
        chat_repo = repos.get("chat")
        list_threads = chat_repo.get("listThreads") if isinstance(chat_repo, dict) else None
        if not callable(list_threads):
            return
        threads = list_threads(workspace_id)
        if not isinstance(threads, list):
            return
        delete_runtime_thread = (
            agent_runtime.get("deleteThread")
            if isinstance(agent_runtime, dict)
            else None
        )
        frontier = academic.get("frontier") if isinstance(academic, dict) else None
        delete_frontier_thread = (
            frontier.get("delete_thread") if isinstance(frontier, dict) else None
        )
        for thread in threads:
            thread_id = thread.get("id") if isinstance(thread, dict) else None
            if not isinstance(thread_id, str):
                continue
            if callable(delete_runtime_thread):
                try:
                    result = delete_runtime_thread(thread_id)
                    if inspect.isawaitable(result):
                        await result
                except Exception as exc:
                    if logger is not None:
                        logger.warn(f"agentRuntime:deleteThread-failed {thread_id}: {exc}")
            if callable(delete_frontier_thread):
                try:
                    result = delete_frontier_thread(thread_id)
                    if inspect.isawaitable(result):
                        await result
                except Exception as exc:
                    if logger is not None:
                        logger.warn(f"frontier:deleteThread-failed {thread_id}: {exc}")

    def create_workspace(name: str) -> dict[str, Any]:
        normalized = name.strip()
        if not normalized:
            raise RepoError("invalid_name", "workspace name cannot be empty")
        return repos["workspaces"]["create"](normalized)

    async def ensure_workspace_sandbox(workspace_id: str) -> None:
        _sandbox_root(workspace_id)

    async def create_workspace_with_sandbox(name: str) -> dict[str, Any]:
        workspace = create_workspace(name)
        try:
            await ensure_workspace_sandbox(workspace["id"])
        except Exception:
            try:
                repos["workspaces"]["delete"](workspace["id"])
            except Exception as exc:
                if logger is not None:
                    logger.warn(f"workspaces:rollback-failed {workspace['id']}: {exc}")
            raise
        return workspace

    def update_workspace(workspace_id: str, name: str) -> dict[str, Any]:
        normalized = name.strip()
        if not normalized:
            raise RepoError("invalid_name", "workspace name cannot be empty")
        return repos["workspaces"]["rename"](workspace_id, normalized)

    async def delete_workspace(workspace_id: str) -> None:
        await _delete_workspace_threads(workspace_id)
        assets = repos["workspaceAssets"]["list"](workspace_id)
        for asset in assets:
            try:
                asset_directory = os.path.dirname(
                    _resolve_workspace_asset_path(repos, asset)
                )
            except RepoError:
                continue
            if os.path.isdir(asset_directory):
                await _connector_trash(asset_directory)
        repos["workspaces"]["delete"](workspace_id)
        try:
            await _delete_sandbox(workspace_id)
        except Exception as exc:
            if logger is not None:
                logger.warn(f"agentSandbox:trash-failed {workspace_id}: {exc}")

    async def open_sandbox(workspace_id: str) -> None:
        _require_workspace(workspace_id)
        ensure = _sandbox_method(sandbox, "ensure")
        if ensure is not None:
            sandbox_paths = ensure(workspace_id)
            sandbox_root = sandbox_paths["sandboxRoot"]
        elif callable(get_sandbox_path):
            sandbox_root = get_sandbox_path(workspace_id)
            if not isinstance(sandbox_root, str) or not os.path.isabs(sandbox_root):
                raise RepoError("invalid_path", "Agent sandbox path is invalid")
            os.makedirs(sandbox_root, mode=0o700, exist_ok=True)
            if os.path.islink(sandbox_root) or not os.path.isdir(sandbox_root):
                raise RepoError("invalid_path", "Agent sandbox path is invalid")
        else:
            raise RepoError("not_ready", "Agent sandbox is not available")
        message = await _connector_call("openPath", sandbox_root)
        if message:
            raise RepoError("open_failed", message)

    def list_items(workspace_id: str) -> list[dict[str, Any]]:
        _require_workspace(workspace_id)
        return repos["workspaceItems"]["list"](workspace_id)

    def get_item(item_id: str) -> dict[str, Any]:
        return _require_scoped("workspaceItems", "workspace item", item_id)

    def add_items(
        workspace_id: str,
        kind: str,
        ids: list[str],
        placement: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        return _transaction(
            lambda: repos["workspaceItems"]["add"](workspace_id, kind, ids, placement)
        )

    def delete_item(workspace_id: str, item_id: str) -> None:
        _require_scoped("workspaceItems", "workspace item", item_id, workspace_id)
        repos["workspaceItems"]["remove"](item_id)

    def reorder_items(workspace_id: str, ordered_ids: list[str]) -> list[dict[str, Any]]:
        return _transaction(
            lambda: repos["workspaceItems"]["reorder"](workspace_id, ordered_ids)
        )

    def resize_item(
        workspace_id: str, item_id: str, width: int, height: int
    ) -> dict[str, Any]:
        _require_scoped("workspaceItems", "workspace item", item_id, workspace_id)
        return repos["workspaceItems"]["resize"](item_id, width, height)

    def move_item(
        workspace_id: str, item_id: str, x: float, y: float, z_index: int
    ) -> dict[str, Any]:
        _require_scoped("workspaceItems", "workspace item", item_id, workspace_id)
        return repos["workspaceItems"]["move"](item_id, x, y, z_index)

    def list_assets(workspace_id: str) -> list[dict[str, Any]]:
        _require_workspace(workspace_id)
        assets = repos["workspaceAssets"]["list"](workspace_id)
        result: list[dict[str, Any]] = []
        for asset in assets:
            try:
                refreshed, _ = _require_workspace_asset_file(repos, asset["id"])
                result.append(refreshed)
            except RepoError:
                current = repos["workspaceAssets"]["get"](asset["id"])
                if current is not None:
                    result.append(current)
        return result

    def get_asset(asset_id: str) -> dict[str, Any]:
        return _require_scoped("workspaceAssets", "workspace asset", asset_id)

    def _unique_asset_paths(paths: list[str]) -> list[str]:
        seen: set[str] = set()
        unique_paths: list[str] = []
        for raw in paths:
            if isinstance(raw, str) and len(raw) > 0 and raw not in seen:
                seen.add(raw)
                unique_paths.append(raw)
        return unique_paths

    def _asset_record(
        asset_id: str,
        workspace_id: str,
        source_path: str,
        destination: str,
        file_size: int,
        file_hash: str,
        library_folder: str,
    ) -> dict[str, Any]:
        file_name = os.path.basename(source_path)
        media = workspace_asset_media_type(file_name)
        now = _now_ms()
        return {
            "id": asset_id,
            "workspaceId": workspace_id,
            "fileName": file_name,
            "filePath": _to_library_relative(destination, library_folder),
            "sourcePath": source_path,
            "mimeType": media["mimeType"],
            "previewKind": media["previewKind"],
            "fileSize": file_size,
            "fileHash": file_hash,
            "fileMissing": 0,
            "createdAt": now,
            "updatedAt": now,
        }

    def _asset_error(raw_path: str, exc: Exception) -> dict[str, str]:
        return {"path": raw_path, "message": str(exc)}

    def import_assets(
        workspace_id: str,
        paths: list[str],
        placement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _require_workspace(workspace_id)
        library_folder = _require_library_folder(repos)
        imported: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []

        for raw_path in _unique_asset_paths(paths):
            asset_id = _new_id()
            asset_directory = os.path.join(library_folder, WORKSPACE_ASSET_DIRECTORY, asset_id)
            directory_created = False
            try:
                source_path, source_size = _validate_asset_source(raw_path)
                file_name = os.path.basename(source_path)
                destination = os.path.join(asset_directory, file_name)
                os.makedirs(asset_directory, mode=0o700, exist_ok=False)
                directory_created = True
                _require_asset_capacity(asset_directory, source_size)
                file_size, file_hash = _stage_asset_file(
                    source_path, destination, source_size
                )
                asset_record = _asset_record(
                    asset_id,
                    workspace_id,
                    source_path,
                    destination,
                    file_size,
                    file_hash,
                    library_folder,
                )
                saved = _transaction(
                    lambda: _insert_asset_with_item(
                        repos, asset_record, workspace_id, placement, len(imported)
                    )
                )
                imported.append(saved)
            except Exception as exc:
                if directory_created:
                    shutil.rmtree(asset_directory, ignore_errors=True)
                errors.append(_asset_error(raw_path, exc))
        return {"imported": imported, "errors": errors}

    async def import_assets_async(
        workspace_id: str,
        paths: list[str],
        placement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _require_workspace(workspace_id)
        library_folder = _require_library_folder(repos)
        imported: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []

        for raw_path in _unique_asset_paths(paths):
            asset_id = _new_id()
            asset_directory = os.path.join(library_folder, WORKSPACE_ASSET_DIRECTORY, asset_id)
            directory_created = False
            cancelled = threading.Event()
            try:
                source_path, source_size = _validate_asset_source(raw_path)
                file_name = os.path.basename(source_path)
                destination = os.path.join(asset_directory, file_name)
                os.makedirs(asset_directory, mode=0o700, exist_ok=False)
                directory_created = True
                _require_asset_capacity(asset_directory, source_size)
                worker = asyncio.create_task(
                    asyncio.to_thread(
                        _stage_asset_file,
                        source_path,
                        destination,
                        source_size,
                        cancelled,
                    )
                )
                try:
                    file_size, file_hash = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    cancelled.set()
                    try:
                        await asyncio.shield(worker)
                    except BaseException:
                        pass
                    raise
                asset_record = _asset_record(
                    asset_id,
                    workspace_id,
                    source_path,
                    destination,
                    file_size,
                    file_hash,
                    library_folder,
                )
                saved = _transaction(
                    lambda: _insert_asset_with_item(
                        repos, asset_record, workspace_id, placement, len(imported)
                    )
                )
                imported.append(saved)
            except asyncio.CancelledError:
                if directory_created:
                    await asyncio.to_thread(shutil.rmtree, asset_directory, True)
                raise
            except Exception as exc:
                if directory_created:
                    await asyncio.to_thread(shutil.rmtree, asset_directory, True)
                errors.append(_asset_error(raw_path, exc))
        return {"imported": imported, "errors": errors}

    async def import_workspace_files(
        workspace_id: str,
        paths: list[str],
        placement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _require_workspace(workspace_id)
        unique_paths = list(dict.fromkeys(path for path in paths if isinstance(path, str) and path))
        pdf_paths = [path for path in unique_paths if Path(path).suffix.lower() == ".pdf"]
        markdown_paths = [
            path for path in unique_paths if Path(path).suffix.lower() in {".md", ".markdown"}
        ]
        asset_paths = [
            path for path in unique_paths
            if Path(path).suffix.lower() not in {".pdf", ".md", ".markdown"}
        ]
        document_ids: list[str] = []
        notes: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        offset = 0

        def placed(current_offset: int) -> dict[str, Any] | None:
            if placement is None:
                return None
            return {
                "x": float(placement["x"]) + (current_offset % 3) * 28,
                "y": float(placement["y"]) + (current_offset // 3) * 28,
            }

        if pdf_paths:
            import_files = importer.get("importFiles") if isinstance(importer, dict) else None
            if not callable(import_files):
                raise RepoError("not_ready", "PDF importer is unavailable")
            result = import_files(pdf_paths)
            if inspect.isawaitable(result):
                result = await result
            if not isinstance(result, dict):
                raise RepoError("import_failed", "PDF importer returned an invalid result")
            for value in result.get("imported", []):
                document_id = value.get("id") if isinstance(value, dict) else value
                if isinstance(document_id, str) and document_id not in document_ids:
                    document_ids.append(document_id)
            for skipped_path in result.get("skipped", []):
                raw_path = skipped_path.get("path") if isinstance(skipped_path, dict) else skipped_path
                resolved = validatePdfPath(raw_path) if isinstance(raw_path, str) else None
                if resolved is None:
                    continue
                document = repos["documents"]["findByPath"](resolved)
                if document is None:
                    try:
                        file_hash = await asyncio.to_thread(hashPdf, resolved)
                        document = repos["documents"]["findByHash"](file_hash)
                    except OSError:
                        document = None
                if document is not None and document["id"] not in document_ids:
                    document_ids.append(document["id"])
            for error in result.get("errors", []):
                if isinstance(error, dict):
                    errors.append({
                        "path": str(error.get("path", "")),
                        "message": str(error.get("message", "PDF import failed")),
                    })
            if document_ids:
                _transaction(
                    lambda: repos["workspaceItems"]["add"](
                        workspace_id, "document", document_ids, placed(offset)
                    )
                )
                offset += len(document_ids)

        for raw_path in markdown_paths:
            try:
                title, content = _read_markdown_file(raw_path)
                note = create_note(workspace_id, title, content, "markdown", placed(offset))
                notes.append(note)
                offset += 1
            except Exception as exc:
                errors.append({"path": raw_path, "message": str(exc)})

        if asset_paths:
            result = await import_assets_async(workspace_id, asset_paths, placed(offset))
            assets.extend(result["imported"])
            errors.extend(result["errors"])

        return {
            "documentIds": document_ids,
            "notes": notes,
            "assets": assets,
            "errors": errors,
        }

    def _insert_asset_with_item(
        repos_: dict[str, Any],
        asset_record: dict[str, Any],
        workspace_id: str,
        placement: dict[str, Any] | None,
        offset: int,
    ) -> dict[str, Any]:
        created = repos_["workspaceAssets"]["create"](asset_record)
        item_placement: dict[str, Any] | None = None
        if placement is not None:
            item_placement = {
                "x": float(placement["x"]) + (offset % 3) * 28,
                "y": float(placement["y"]) + (offset // 3) * 28,
            }
        repos_["workspaceItems"]["add"](workspace_id, "asset", [created["id"]], item_placement)
        return created

    def preview_asset(workspace_id: str, asset_id: str) -> dict[str, Any]:
        _require_scoped("workspaceAssets", "workspace asset", asset_id, workspace_id)
        asset, file_path = _require_workspace_asset_file(repos, asset_id)
        if asset["previewKind"] != "text":
            raise RepoError("preview_not_supported", "This file does not support text preview")
        with open(file_path, "rb") as fh:
            data = fh.read(WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT + 1)
        truncated = len(data) > WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT
        length = min(len(data), WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT)
        content = data[:length].decode("utf-8", errors="replace")
        return {"content": content, "truncated": truncated}

    def resolve_asset_file(asset_id: str) -> tuple[dict[str, Any], str]:
        return _require_workspace_asset_file(repos, asset_id)

    async def open_asset(workspace_id: str, asset_id: str) -> None:
        _require_scoped("workspaceAssets", "workspace asset", asset_id, workspace_id)
        _, file_path = _require_workspace_asset_file(repos, asset_id)
        message = await _connector_call("openPath", file_path)
        if message:
            raise RepoError("open_failed", message)

    async def reveal_asset(workspace_id: str, asset_id: str) -> None:
        _require_scoped("workspaceAssets", "workspace asset", asset_id, workspace_id)
        _, file_path = _require_workspace_asset_file(repos, asset_id)
        await _connector_call("showInFolder", file_path)

    async def delete_asset(workspace_id: str, asset_id: str) -> None:
        asset = _require_scoped(
            "workspaceAssets", "workspace asset", asset_id, workspace_id
        )
        file_path = _resolve_workspace_asset_path(repos, asset)
        asset_directory = os.path.dirname(file_path)
        if os.path.isdir(asset_directory):
            await _connector_trash(asset_directory)
        _transaction(
            lambda: _remove_asset_and_items(repos, asset_id)
        )

    def _remove_asset_and_items(repos_: dict[str, Any], asset_id: str) -> None:
        repos_["workspaceItems"]["removeByAssetId"](asset_id)
        repos_["workspaceAssets"]["delete"](asset_id)

    async def _connector_trash(path: str) -> None:
        try:
            await _connector_call("trashItem", path)
        except Exception as exc:
            if logger is not None:
                logger.warn(f"workspaceAsset:trash-failed {path}: {exc}")

    def get_canvas(workspace_id: str) -> dict[str, Any]:
        _require_workspace(workspace_id)
        return repos["workspaceCanvas"]["get"](workspace_id)

    def put_canvas(
        workspace_id: str, pan_x: float, pan_y: float, zoom: float
    ) -> dict[str, Any]:
        _require_workspace(workspace_id)
        return repos["workspaceCanvas"]["update"](workspace_id, pan_x, pan_y, zoom)

    def list_connections(workspace_id: str) -> list[dict[str, Any]]:
        _require_workspace(workspace_id)
        return repos["workspaceConnections"]["list"](workspace_id)

    def get_connection(connection_id: str) -> dict[str, Any]:
        return _require_scoped(
            "workspaceConnections", "workspace connection", connection_id
        )

    def create_connection(
        workspace_id: str,
        source_item_id: str,
        target_item_id: str,
        source_anchor: str,
        target_anchor: str,
    ) -> dict[str, Any]:
        return repos["workspaceConnections"]["create"](
            workspace_id, source_item_id, target_item_id, source_anchor, target_anchor
        )

    def delete_connection(workspace_id: str, connection_id: str) -> None:
        _require_scoped(
            "workspaceConnections",
            "workspace connection",
            connection_id,
            workspace_id,
        )
        repos["workspaceConnections"]["delete"](connection_id)

    def list_notes(workspace_id: str) -> list[dict[str, Any]]:
        _require_workspace(workspace_id)
        return repos["workspaceNotes"]["list"](workspace_id)

    def get_note(note_id: str) -> dict[str, Any]:
        return _require_scoped("workspaceNotes", "workspace note", note_id)

    def create_note(
        workspace_id: str,
        title: str,
        content_md: str,
        note_type: str = "markdown",
        placement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        def _do() -> dict[str, Any]:
            note = repos["workspaceNotes"]["create"](workspace_id, title, content_md, note_type)
            repos["workspaceItems"]["add"](workspace_id, "note", [note["id"]], placement)
            return note

        return _transaction(_do)

    def update_note(
        workspace_id: str, note_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        _require_scoped("workspaceNotes", "workspace note", note_id, workspace_id)
        return repos["workspaceNotes"]["update"](
            note_id, parse_workspace_note_patch(patch)
        )

    def delete_note(workspace_id: str, note_id: str) -> None:
        _require_scoped("workspaceNotes", "workspace note", note_id, workspace_id)
        _transaction(lambda: _remove_note_and_items(repos, note_id))

    def _remove_note_and_items(repos_: dict[str, Any], note_id: str) -> None:
        repos_["workspaceItems"]["removeByNoteId"](note_id)
        repos_["workspaceNotes"]["delete"](note_id)

    return {
        "listWorkspaces": list_workspaces,
        "createWorkspace": create_workspace,
        "createWorkspaceWithSandbox": create_workspace_with_sandbox,
        "ensureWorkspaceSandbox": ensure_workspace_sandbox,
        "updateWorkspace": update_workspace,
        "deleteWorkspace": delete_workspace,
        "openSandbox": open_sandbox,
        "listItems": list_items,
        "getItem": get_item,
        "addItems": add_items,
        "deleteItem": delete_item,
        "reorderItems": reorder_items,
        "resizeItem": resize_item,
        "moveItem": move_item,
        "listAssets": list_assets,
        "getAsset": get_asset,
        "importAssets": import_assets,
        "importAssetsAsync": import_assets_async,
        "importWorkspaceFiles": import_workspace_files,
        "previewAsset": preview_asset,
        "resolveAssetFile": resolve_asset_file,
        "openAsset": open_asset,
        "revealAsset": reveal_asset,
        "deleteAsset": delete_asset,
        "getCanvas": get_canvas,
        "putCanvas": put_canvas,
        "listConnections": list_connections,
        "getConnection": get_connection,
        "createConnection": create_connection,
        "deleteConnection": delete_connection,
        "listNotes": list_notes,
        "getNote": get_note,
        "createNote": create_note,
        "updateNote": update_note,
        "deleteNote": delete_note,
    }
