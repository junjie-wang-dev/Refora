from __future__ import annotations

import asyncio
import inspect
import json
import re
from typing import Any, Awaitable, Callable, Protocol, TypedDict

from refora_server.services.provider_config import (
    ProviderConfigInput,
    ProviderRuntimeConfig,
    build_provider_config as _build_provider_config,
)

MAX_CONCURRENT = 2
MAX_RETRIES = 3
BASE_DELAY_MS = 1000
SUMMARY_MAX_TOKENS = 450
MAX_CORE_CHARS = 480
MAX_KEY_POINTS = 5
MAX_KEY_POINT_CHARS = 180
CHUNK_SIZE = 3000
CHUNK_OVERLAP = 200

_RETRYABLE_NETWORK_CODES = {
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EPIPE",
    "ECONNABORTED",
}

_RETRYABLE_MESSAGE_PATTERNS = [
    re.compile(r"429"),
    re.compile(r"rate.?limit", re.IGNORECASE),
    re.compile(r"too many requests", re.IGNORECASE),
    re.compile(r"service unavailable", re.IGNORECASE),
    re.compile(r"bad gateway", re.IGNORECASE),
    re.compile(r"gateway timeout", re.IGNORECASE),
    re.compile(r"overloaded", re.IGNORECASE),
    re.compile(r"temporarily unavailable", re.IGNORECASE),
    re.compile(r"network error", re.IGNORECASE),
    re.compile(r"fetch failed", re.IGNORECASE),
    re.compile(r"socket hang up", re.IGNORECASE),
    re.compile(r"connection reset", re.IGNORECASE),
    re.compile(r"ETIMEDOUT", re.IGNORECASE),
    re.compile(r"ECONNRESET", re.IGNORECASE),
]


class SummaryLogger(Protocol):
    def info(self, message: str) -> Any: ...
    def warning(self, message: str) -> Any: ...
    def error(self, message: str) -> Any: ...


class SummaryDocumentsRepository(TypedDict):
    get: Callable[[str], dict[str, Any] | None]


class SummaryContentRepository(TypedDict):
    getFullText: Callable[[str], dict[str, Any] | None]
    setSummary: Callable[[str, str, dict[str, Any] | None], Any]


class AiSummaryRepositories(TypedDict):
    documents: SummaryDocumentsRepository
    aiSummaries: SummaryContentRepository


class AiSummaryDependencies(TypedDict, total=False):
    logger: SummaryLogger
    generate_summary: Callable[[dict[str, Any]], Any]
    emit_delta: Callable[[str, str | None], Any]
    emit_error: Callable[[str, str], Any]
    sleep: Callable[[float], Awaitable[None]]
    load_text: Callable[[str], Any]


class AiSummaryService(TypedDict):
    summarize: Callable[[str, ProviderConfigInput], Awaitable[str | None]]
    queueSummary: Callable[[str, ProviderConfigInput], str | None]
    processSummary: Callable[[str, ProviderConfigInput], Awaitable[str | None]]
    destroy: Callable[[], Awaitable[None]]


def _extract_status(err: Any) -> int | None:
    if isinstance(err, dict):
        status = err.get("status")
        if isinstance(status, int):
            return status
        response = err.get("response")
        if isinstance(response, dict):
            r_status = response.get("status")
            if isinstance(r_status, int):
                return r_status
        cause = err.get("cause")
        if isinstance(cause, dict):
            c_status = cause.get("status")
            if isinstance(c_status, int):
                return c_status
    status = getattr(err, "status", None)
    if isinstance(status, int):
        return status
    response = getattr(err, "response", None)
    if response is not None:
        r_status = getattr(response, "status", None)
        if isinstance(r_status, int):
            return r_status
    cause = getattr(err, "cause", None)
    if cause is not None:
        c_status = getattr(cause, "status", None)
        if isinstance(c_status, int):
            return c_status
    return None


def isRetryableError(e: Any) -> bool:
    if isinstance(e, BaseException):
        message = str(e)
    else:
        message = str(e)
    lc_error_code = getattr(e, "lc_error_code", None)
    if lc_error_code == "MODEL_RATE_LIMIT":
        return True
    if lc_error_code in ("MODEL_AUTHENTICATION", "MODEL_NOT_FOUND"):
        return False
    if getattr(e, "name", None) == "AbortError":
        return True
    status = _extract_status(e)
    if status is not None:
        if status == 429:
            return True
        if 500 <= status < 600:
            return True
        if 400 <= status < 500:
            return False
    code = getattr(e, "code", None)
    if isinstance(code, str) and code in _RETRYABLE_NETWORK_CODES:
        return True
    if any(pattern.search(message) for pattern in _RETRYABLE_MESSAGE_PATTERNS):
        return True
    return False


def splitText(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start += chunk_size - overlap
    return chunks


def compactText(raw: str, maximum: int) -> str:
    normalized = re.sub(r"\s+", " ", raw).strip()
    if len(normalized) <= maximum:
        return normalized
    sliced = normalized[: maximum - 1].rstrip()
    last_space = sliced.rfind(" ")
    if last_space >= int(maximum * 0.75):
        sliced = sliced[:last_space]
    return f"{sliced.rstrip()}\u2026"


def stripCodeFences(raw: str) -> str:
    stripped = re.sub(r"^\s*```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    stripped = re.sub(r"\s*```\s*$", "", stripped, flags=re.IGNORECASE)
    return stripped.strip()


def toSummaryContent(parsed: Any) -> dict[str, Any] | None:
    if not isinstance(parsed, dict):
        return None
    core = (
        compactText(parsed["core"], MAX_CORE_CHARS)
        if isinstance(parsed.get("core"), str)
        else ""
    )
    raw_points = parsed.get("keyPoints")
    if not isinstance(raw_points, list):
        raw_points = []
    key_points: list[str] = []
    for point in raw_points:
        if isinstance(point, str):
            compacted = compactText(point, MAX_KEY_POINT_CHARS)
            if compacted:
                key_points.append(compacted)
        if len(key_points) >= MAX_KEY_POINTS:
            break
    return {"core": core, "keyPoints": key_points}


def createAiSummaryService(
    repos: AiSummaryRepositories,
    deps: AiSummaryDependencies | None = None,
) -> AiSummaryService:
    deps = deps or {}
    logger = deps.get("logger")
    generate_summary: Callable[..., Any] | None = deps.get("generate_summary")
    emit_delta: Callable[[str, str | None], Any] | None = deps.get("emit_delta")
    emit_error: Callable[[str, str], Any] | None = deps.get("emit_error")
    sleep_fn: Callable[[float], Awaitable[None]] | None = deps.get("sleep")
    load_text: Callable[[str], Any] | None = deps.get("load_text")

    destroyed = {"value": False}
    semaphore: asyncio.Semaphore | None = None
    inflight: set[asyncio.Task[Any]] = set()
    queued: dict[str, asyncio.Task[Any]] = {}

    def _info(message: str) -> None:
        if logger is not None:
            try:
                logger.info(message)
            except Exception:
                pass

    def _warn(message: str) -> None:
        if logger is not None:
            try:
                logger.warning(message)
            except Exception:
                pass

    def _error(message: str) -> None:
        if logger is not None:
            try:
                logger.error(message)
            except Exception:
                pass

    def _emit(doc_id: str, summary_id: str | None = None) -> None:
        if emit_delta is not None:
            try:
                emit_delta(doc_id, summary_id)
            except Exception:
                pass

    def _emit_error(doc_id: str, message: str) -> None:
        if emit_error is not None:
            try:
                emit_error(doc_id, message)
            except Exception:
                pass
        _emit(doc_id)

    async def _invoke_summary(
        provider_config: ProviderRuntimeConfig, text: str, doc_id: str
    ) -> dict[str, Any]:
        async def invoke(payload: dict[str, Any]) -> Any:
            if generate_summary is None:
                raise RuntimeError("generate_summary dependency is not configured")
            if inspect.iscoroutinefunction(generate_summary):
                return await generate_summary(payload)
            result = await asyncio.to_thread(generate_summary, payload)
            return await result if inspect.isawaitable(result) else result

        chunks = splitText(text)
        chunk_summaries: list[str] = []
        for chunk in chunks:
            if destroyed["value"]:
                raise RuntimeError("Summary service destroyed")
            result = await invoke({"provider": provider_config, "text": chunk})
            chunk_summaries.append(_content_to_text(result))
        combined = "\n\n".join(chunk_summaries)
        if not combined.strip():
            return {"core": "", "keyPoints": []}
        if destroyed["value"]:
            raise RuntimeError("Summary service destroyed")
        final_result = await invoke(
            {"provider": provider_config, "text": None, "combined": combined}
        )
        final_text = _content_to_text(final_result)
        try:
            parsed = toSummaryContent(json.loads(stripCodeFences(final_text)))
        except (ValueError, TypeError, json.JSONDecodeError):
            _warn(f"aiSummary:json-parse-failed id={doc_id}")
            parsed = None
        if parsed is not None:
            return parsed
        return {
            "core": compactText(final_text.strip() or combined, MAX_CORE_CHARS),
            "keyPoints": [],
        }

    async def process_summary(
        doc_id: str, provider: ProviderConfigInput
    ) -> str | None:
        doc = repos["documents"]["get"](doc_id)
        if doc is None:
            _warn(f"aiSummary:processJob doc-not-found id={doc_id}")
            _emit(doc_id)
            return None
        if destroyed["value"]:
            return None
        provider_config = _build_provider_config(
            provider, deep_thinking=False, max_tokens=SUMMARY_MAX_TOKENS
        )
        provider_config["streaming"] = False
        text = provider.get("__text")
        if not text and load_text is not None:
            loaded_text = load_text(doc_id)
            text = await loaded_text if inspect.isawaitable(loaded_text) else loaded_text
        if not text:
            full_text = repos["aiSummaries"]["getFullText"](doc_id)
            text = full_text["text"] if full_text else ""
        if not text:
            _emit_error(doc_id, "No document text available to summarize")
            return None
        content: dict[str, Any] | None = None
        last_error: BaseException | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            if destroyed["value"]:
                return None
            try:
                content = await _invoke_summary(provider_config, text, doc_id)
                last_error = None
                break
            except Exception as e:
                last_error = e
                if attempt == MAX_RETRIES or not isRetryableError(e):
                    break
                delay = BASE_DELAY_MS * (2 ** (attempt - 1)) / 1000
                _warn(
                    f"aiSummary:retry attempt={attempt}/{MAX_RETRIES} id={doc_id} delay={delay}s: {e}"
                )
                if sleep_fn is not None:
                    await sleep_fn(delay)
        if destroyed["value"]:
            return None
        if last_error is not None:
            message = str(last_error)
            _warn(f"aiSummary:failed id={doc_id}: {message}")
            _emit_error(doc_id, f"Summary generation failed: {message}")
            return None
        model = provider.get("model") or provider_config.get("model") or ""
        repos["aiSummaries"]["setSummary"](doc_id, model, content)
        _info(f"aiSummary:done id={doc_id} model={model}")
        _emit(doc_id, doc_id)
        return doc_id

    async def summarize(
        documentId: str, provider: ProviderConfigInput
    ) -> str | None:
        async def _job() -> str | None:
            return await process_summary(documentId, provider)

        return await _run_job(_job)

    def queue_summary(
        documentId: str, provider: ProviderConfigInput
    ) -> str | None:
        if destroyed["value"]:
            return None
        existing = queued.get(documentId)
        if existing is not None and not existing.done():
            return documentId

        async def _queued_job() -> str | None:
            try:
                return await summarize(documentId, provider)
            except asyncio.CancelledError:
                return None
            except Exception as error:
                message = str(error)
                _warn(f"aiSummary:failed id={documentId}: {message}")
                _emit_error(documentId, f"Summary generation failed: {message}")
                return None

        task = asyncio.create_task(_queued_job())
        queued[documentId] = task

        def _remove(completed: asyncio.Task[Any]) -> None:
            if queued.get(documentId) is completed:
                queued.pop(documentId, None)

        task.add_done_callback(_remove)
        return documentId

    async def _run_job(job: Callable[..., Awaitable[str | None]]) -> str | None:
        nonlocal semaphore
        if destroyed["value"]:
            return None
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        if destroyed["value"]:
            return None

        acquired = False
        try:
            await semaphore.acquire()
            acquired = True
        except asyncio.CancelledError:
            return None

        if destroyed["value"]:
            if acquired:
                semaphore.release()
            return None

        task = asyncio.ensure_future(job())
        inflight.add(task)
        try:
            return await task
        finally:
            inflight.discard(task)
            if acquired:
                semaphore.release()

    async def destroy() -> None:
        destroyed["value"] = True
        current = asyncio.current_task()
        tasks = {
            task
            for task in (*queued.values(), *inflight)
            if task is not current and not task.done()
        }
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        queued.clear()
        inflight.clear()

    return {
        "summarize": summarize,
        "queueSummary": queue_summary,
        "processSummary": process_summary,
        "destroy": destroy,
    }


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
        return "".join(parts)
    if isinstance(content, dict):
        if isinstance(content.get("content"), str):
            return content["content"]
        if isinstance(content.get("text"), str):
            return content["text"]
    return ""
