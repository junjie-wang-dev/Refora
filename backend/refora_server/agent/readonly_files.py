from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any


def _method(repository: Any, name: str) -> Any:
    if isinstance(repository, dict):
        return repository.get(name)
    return getattr(repository, name, None)


def _regular_file(path: Any) -> bool:
    if not isinstance(path, str) or not os.path.isabs(path):
        return False
    try:
        return not os.path.islink(path) and os.path.isfile(path)
    except OSError:
        return False


def _file_entry(item: dict[str, Any], kind: str) -> dict[str, Any] | None:
    path = item.get("filePath")
    if not _regular_file(path):
        return None
    size = item.get("fileSize")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        size = os.path.getsize(path)
    return {
        "id": item.get("id"),
        "workspaceId": item.get("workspaceId"),
        "fileName": item.get("fileName"),
        "fileHash": item.get("fileHash"),
        "path": path,
        "mimeType": item.get("mimeType") or "application/pdf",
        "size": size,
        "kind": kind,
        "updatedAt": item.get("updatedAt"),
    }


def _revision(files: list[dict[str, Any]]) -> str:
    encoded = json.dumps(
        sorted(files, key=lambda item: (str(item["kind"]), str(item["id"]))),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_readonly_files_manifest(
    workspace_id: str | None,
    documents_repo: Any,
    assets_repo: Any,
    dest_path: str | Path,
) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    list_documents = _method(documents_repo, "list")
    if callable(list_documents):
        for document in list_documents({"mode": "all"}):
            entry = _file_entry(document, "document")
            if entry is not None:
                files.append(entry)
    list_assets = _method(assets_repo, "list")
    if workspace_id and callable(list_assets):
        for asset in list_assets(workspace_id):
            entry = _file_entry(asset, "asset")
            if entry is not None:
                files.append(entry)
    files.sort(key=lambda item: (item["kind"], str(item["id"])))
    manifest = {
        "version": 1,
        "workspaceId": workspace_id,
        "revision": _revision(files),
        "files": files,
    }
    destination_path = Path(dest_path).expanduser().resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination_path.with_name(
        f"{destination_path.name}.tmp-{uuid.uuid4().hex}"
    )
    try:
        with temporary_path.open("x", encoding="utf-8") as output:
            json.dump(manifest, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.chmod(temporary_path, 0o400)
        os.replace(temporary_path, destination_path)
        os.chmod(destination_path, 0o400)
        return manifest
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
