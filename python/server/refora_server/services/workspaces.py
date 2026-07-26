from __future__ import annotations

import hashlib
import inspect
import os
import shutil
import time
from typing import Any, Callable

from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_assets import workspace_asset_media_type

WORKSPACE_ASSET_TEXT_PREVIEW_LIMIT = 256 * 1024
WORKSPACE_ASSET_DIRECTORY = "refora-assets"


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


def _stream_file_hash(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


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

    def create_workspace(name: str) -> dict[str, Any]:
        normalized = name.strip()
        if not normalized:
            raise RepoError("invalid_name", "workspace name cannot be empty")
        return repos["workspaces"]["create"](normalized)

    def update_workspace(workspace_id: str, name: str) -> dict[str, Any]:
        normalized = name.strip()
        if not normalized:
            raise RepoError("invalid_name", "workspace name cannot be empty")
        return repos["workspaces"]["rename"](workspace_id, normalized)

    async def delete_workspace(workspace_id: str) -> None:
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

    def import_assets(
        workspace_id: str,
        paths: list[str],
        placement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _require_workspace(workspace_id)
        library_folder = _require_library_folder(repos)
        imported: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        seen: set[str] = set()
        unique_paths: list[str] = []
        for raw in paths:
            if isinstance(raw, str) and len(raw) > 0 and raw not in seen:
                seen.add(raw)
                unique_paths.append(raw)

        for raw_path in unique_paths:
            asset_id = _new_id()
            asset_directory = os.path.join(library_folder, WORKSPACE_ASSET_DIRECTORY, asset_id)
            try:
                source_path = _validate_source_file(raw_path)
                file_name = os.path.basename(source_path)
                destination = os.path.join(asset_directory, file_name)
                os.makedirs(asset_directory, exist_ok=True)
                if os.path.exists(destination):
                    raise RepoError("duplicate", f"File already exists: {destination}")
                shutil.copy2(source_path, destination)
                file_size = os.path.getsize(destination)
                file_hash = _stream_file_hash(destination)
                media = workspace_asset_media_type(file_name)
                now = _now_ms()
                asset_record = {
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
                saved = _transaction(
                    lambda: _insert_asset_with_item(
                        repos, asset_record, workspace_id, placement, len(imported)
                    )
                )
                imported.append(saved)
            except Exception as exc:
                shutil.rmtree(asset_directory, ignore_errors=True)
                errors.append(
                    {"path": raw_path, "message": str(exc) if isinstance(exc, RepoError) else str(exc)}
                )
        return {"imported": imported, "errors": errors}

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
        return repos["workspaceNotes"]["update"](note_id, patch)

    def delete_note(workspace_id: str, note_id: str) -> None:
        _require_scoped("workspaceNotes", "workspace note", note_id, workspace_id)
        _transaction(lambda: _remove_note_and_items(repos, note_id))

    def _remove_note_and_items(repos_: dict[str, Any], note_id: str) -> None:
        repos_["workspaceItems"]["removeByNoteId"](note_id)
        repos_["workspaceNotes"]["delete"](note_id)

    return {
        "listWorkspaces": list_workspaces,
        "createWorkspace": create_workspace,
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
