from __future__ import annotations

import asyncio
import inspect
import os
from typing import Any


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
            exists = isinstance(path, str) and os.path.exists(path)
            missing = document.get("fileMissing") == 1
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
