from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI


def mineru_worker_path() -> str:
    configured = os.environ.get("REFORA_MINERU_WORKER_PATH")
    if configured:
        return configured
    package_root = Path(__file__).resolve().parents[3]
    candidates = (
        package_root / "workers" / "mineru_worker.py",
        package_root.parent / "mineru" / "mineru_worker.py",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return str(candidates[0])


async def download_mineru_file(
    url: str,
    destination: str,
    cancel_event: asyncio.Event,
    on_progress: Any,
    *,
    proxy: str | None = None,
) -> None:
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("MinerU download support is unavailable") from exc
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    received = 0
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=60.0,
            **({"proxy": proxy} if proxy else {}),
        ) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                raw_total = response.headers.get("content-length")
                total = int(raw_total) if raw_total and raw_total.isdigit() else None
                with open(destination, "wb") as output:
                    os.chmod(destination, 0o600)
                    async for chunk in response.aiter_bytes(64 * 1024):
                        if cancel_event.is_set():
                            raise RuntimeError("MinerU installation was cancelled")
                        output.write(chunk)
                        received += len(chunk)
                        on_progress(received, total)
        if cancel_event.is_set():
            raise RuntimeError("MinerU installation was cancelled")
    except BaseException:
        try:
            os.unlink(destination)
        except FileNotFoundError:
            pass
        raise


async def trash_mineru_path(connector: Any, path: str) -> None:
    result = await connector.trash_item(path)
    if isinstance(result, dict) and result.get("ok"):
        return
    error = result.get("error") if isinstance(result, dict) else None
    message = error.get("message") if isinstance(error, dict) else "No response from the native connector"
    raise RuntimeError(f"Native Trash connector is unavailable: {message}")


def schedule_event(
    events: Any,
    name: str,
    data: Any,
    loop: asyncio.AbstractEventLoop | None = None,
) -> None:
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if loop is not None and running_loop is not loop:
        future = asyncio.run_coroutine_threadsafe(events.broadcast(name, data), loop)
        future.add_done_callback(consume_future)
        return
    task = asyncio.create_task(events.broadcast(name, data))

    def consume_result(completed: asyncio.Task[Any]) -> None:
        try:
            completed.result()
        except Exception:
            pass

    task.add_done_callback(consume_result)


def consume_future(completed: Any) -> None:
    try:
        completed.result()
    except BaseException:
        pass


def unavailable_ocr_service(reason: str) -> dict[str, Any]:
    async def unavailable(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"OCR service is unavailable: {reason}")

    async def stop_worker() -> None:
        return None

    async def destroy() -> None:
        return None

    return {
        "initialize": unavailable,
        "getState": unavailable,
        "startOcr": unavailable,
        "cancelOcr": unavailable,
        "getOcrState": unavailable,
        "getMarkdown": unavailable,
        "readMarkdown": unavailable,
        "prepareDocumentDelete": unavailable,
        "stopWorker": stop_worker,
        "destroy": destroy,
    }


def unavailable_agent_capability(*_args: Any, **_kwargs: Any) -> dict[str, str]:
    return {
        "status": "unavailable",
        "code": "agent_capability_unavailable",
        "message": "Agent capability is unavailable",
    }


class LazyAgentRuntime(dict):
    def __init__(self, app: FastAPI) -> None:
        self._app = app

    def _resolve(self) -> dict[str, Any]:
        runtime = getattr(self._app.state, "agent_runtime", None)
        return runtime if isinstance(runtime, dict) else {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._resolve().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self._resolve()[key]

    def __contains__(self, key: object) -> bool:
        return key in self._resolve()


def summary_prompt(text: str | None, combined: str | None) -> str:
    if isinstance(text, str):
        return (
            "You are a research assistant reading text extracted from a PDF. "
            "Capture at most two essential facts from this excerpt in no more than "
            "60 words total. Be concise and factual; do not write a long "
            "interpretation.\n\n"
            f"Extracted PDF text:\n{text}"
        )
    if isinstance(combined, str):
        return (
            "You are a research assistant. Create a brief factual overview from the "
            "extracted PDF section notes below. Respond in the paper's primary "
            "language with ONLY a JSON object containing exactly two fields: "
            '"core" (one or two short sentences, at most 80 words) and "keyPoints" '
            "(an array of 3 to 5 concise strings, each at most 20 words). Do not add "
            "methods, contribution, analysis, markdown, or commentary.\n\n"
            f"Extracted PDF section notes:\n{combined}"
        )
    raise RuntimeError("AI summary input is unavailable")
