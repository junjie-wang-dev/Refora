from __future__ import annotations

import asyncio
import inspect
from typing import Any

from refora_server.services.document_identity import (
    file_signature,
    refresh_document_identity,
    stored_file_signature,
    stream_file_hash,
)


def create_document_presence_service(
    repos: dict[str, Any],
    *,
    emit: Any,
    interval: float = 600.0,
) -> dict[str, Any]:
    documents = repos["documents"]
    task: asyncio.Task[Any] | None = None
    destroyed = False

    async def broadcast(document: dict[str, Any]) -> None:
        result = emit("document.updated", document)
        if inspect.isawaitable(result):
            await result

    async def check_now() -> list[dict[str, Any]]:
        changed: list[dict[str, Any]] = []
        rows = documents["list"]({"mode": "all"})
        for index, document in enumerate(rows):
            path = document.get("filePath")
            signature = None
            if isinstance(path, str) and path:
                try:
                    signature = file_signature(path)
                except (OSError, ValueError):
                    pass
            exists = signature is not None
            missing = document.get("fileMissing") == 1
            if exists and (
                missing or stored_file_signature(document) != signature
            ):
                if not callable(documents.get("updateFileIdentity")):
                    if missing:
                        documents["setFileMissing"](document["id"], False)
                        updated = documents["get"](document["id"])
                        if updated is not None:
                            changed.append(updated)
                            await broadcast(updated)
                    continue
                try:
                    file_hash = await asyncio.to_thread(stream_file_hash, path)
                    updated = refresh_document_identity(
                        repos, document, lambda _path: file_hash, signature
                    )
                    if updated is not None:
                        changed.append(updated)
                        await broadcast(updated)
                        continue
                except (OSError, RuntimeError, ValueError):
                    if missing:
                        documents["setFileMissing"](document["id"], False)
                        updated = documents["get"](document["id"])
                        if updated is not None:
                            changed.append(updated)
                            await broadcast(updated)
                    continue
            if exists == missing:
                documents["setFileMissing"](document["id"], not exists)
                updated = documents["get"](document["id"])
                if updated is not None:
                    changed.append(updated)
                    await broadcast(updated)
            if index > 0 and index % 50 == 0:
                await asyncio.sleep(0)
        return changed

    async def monitor() -> None:
        while not destroyed:
            await check_now()
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                return

    def start() -> None:
        nonlocal task
        if task is None or task.done():
            task = asyncio.create_task(monitor())

    async def destroy() -> None:
        nonlocal destroyed
        destroyed = True
        current = task
        if current is not None and not current.done():
            current.cancel()
            await asyncio.gather(current, return_exceptions=True)

    return {
        "checkNow": check_now,
        "start": start,
        "destroy": destroy,
    }
