from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import stat
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from refora_server.ocr.paths import (
    get_ocr_document_root,
    get_ocr_publish_backup_root,
    get_ocr_result_root,
    get_ocr_root,
    get_ocr_staging_root,
    resolve_ocr_result_file,
    resolve_pdf_file_path,
    safe_makedirs,
    stream_file_hash,
    to_library_relative_path,
)
from refora_server.ocr.types import (
    MINERU_VERSION,
    OCR_RESULT_SCHEMA_VERSION,
    OcrProfile,
)
from refora_server.repositories.errors import RepoError
from refora_server.services.mineru import MineruEngineManager, MineruWorkerProcess

VALID_PROFILES: tuple[str, ...] = ("compatible", "balanced", "quality")
ACTIVE_STATUSES: tuple[str, ...] = ("queued", "running")


def now_ms() -> int:
    return int(time.time() * 1000)


async def _default_rename(src: str, dst: str) -> None:
    os.replace(src, dst)


def result_options(profile: str) -> str:
    return json.dumps(
        {
            "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
            "mineruVersion": MINERU_VERSION,
            "profile": profile,
            "language": "ch",
            "formula": True,
            "table": True,
        },
        sort_keys=True,
    )


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _error_code(error: BaseException) -> str:
    if isinstance(error, RepoError):
        return error.code
    name = getattr(error, "name", None)
    if isinstance(name, str) and name:
        return name
    return "ocr_failed"


def _error_message(error: BaseException) -> str:
    return str(error) or error.__class__.__name__


def _is_symlink(path: str) -> bool:
    try:
        return stat.S_ISLNK(os.lstat(path).st_mode)
    except OSError:
        return False


def _is_regular_file(path: str) -> bool:
    try:
        return stat.S_ISREG(os.stat(path).st_mode)
    except OSError:
        return False


@dataclass
class OcrServiceDeps:
    engineManager: MineruEngineManager
    worker: MineruWorkerProcess
    getLibraryFolder: Callable[[], str]
    emitProgress: Callable[[dict[str, Any]], None]
    emitCompleted: Callable[[dict[str, Any]], None]
    emitError: Callable[[dict[str, Any]], None]
    renamePath: Callable[[str, str], Awaitable[None]] | None = None


def create_ocr_service(repos: dict[str, Any], deps: OcrServiceDeps):
    document_ocr = repos["documentOcr"]
    documents = repos["documents"]
    transaction = repos.get("transaction")
    if not callable(transaction):
        raise RuntimeError("OCR repository transaction is unavailable")
    cancelled: set[str] = set()
    state: dict[str, Any] = {
        "destroyed": False,
        "running_job_id": None,
        "running_task": None,
        "start_pending": False,
    }
    rename_path = deps.renamePath or _default_rename

    def _emit(callback: Callable[[dict[str, Any]], None], payload: dict[str, Any]) -> None:
        try:
            callback(payload)
        except Exception:
            pass

    def _emit_job(job: dict[str, Any]) -> None:
        _emit(deps.emitProgress, {"job": job})

    def _update_job(job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        job = document_ocr["updateJob"](job_id, patch)
        _emit_job(job)
        return job

    async def _cleanup_staging() -> None:
        library = deps.getLibraryFolder()
        if not library:
            return
        root = get_ocr_root(library)
        try:
            entries = os.listdir(root)
        except OSError:
            return
        for name in entries:
            if not name.isalnum() and not all(c.isalnum() or c in "_-" for c in name):
                continue
            staging = os.path.join(root, name, ".staging")
            shutil.rmtree(staging, ignore_errors=True)

    async def initialize() -> None:
        document_ocr["markRunningInterrupted"]()
        await _cleanup_staging()

    async def _get_source_hash(document_id: str) -> tuple[str, str]:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"Document not found: {document_id}")
        path = resolve_pdf_file_path(document["filePath"])
        file_hash = document.get("fileHash")
        if file_hash:
            return path, file_hash
        return path, await asyncio.to_thread(stream_file_hash, path)

    async def get_state(document_id: str) -> dict[str, Any]:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"Document not found: {document_id}")
        engine_status = await deps.engineManager["getStatus"]()
        active_job = document_ocr["getActiveJob"](document_id)
        result = document_ocr["getResult"](document_id, document.get("fileHash"))
        return {
            "engine": engine_status.to_dict() if hasattr(engine_status, "to_dict") else _status_to_dict(engine_status),
            "activeJob": active_job,
            "result": result,
        }

    def _status_to_dict(status: Any) -> dict[str, Any]:
        if hasattr(status, "to_dict"):
            return status.to_dict()
        return status

    async def _validate_normalized_files(staging: str) -> None:
        for name in ("document.md", "blocks.jsonl", "middle.json"):
            path = os.path.join(staging, name)
            try:
                entry = os.lstat(path)
            except OSError as error:
                raise RuntimeError(f"MinerU produced an invalid {name}") from error
            if stat.S_ISLNK(entry.st_mode) or not stat.S_ISREG(entry.st_mode) or entry.st_size == 0:
                raise RuntimeError(f"MinerU produced an invalid {name}")

    def _require_active_job(job_id: str) -> None:
        if state["destroyed"] or job_id in cancelled:
            raise RuntimeError("MinerU conversion was cancelled")

    async def _publish_result(
        library: str,
        job: dict[str, Any],
        staging: str,
        destination: str,
    ) -> tuple[Callable[[], None], Callable[[], Awaitable[None]]]:
        backup = get_ocr_publish_backup_root(library, job["documentId"], job["id"])
        safe_makedirs(os.path.dirname(backup))
        shutil.rmtree(backup, ignore_errors=True)
        _require_active_job(job["id"])
        destination_exists = os.path.exists(destination)
        backed_up = False
        if destination_exists:
            await rename_path(destination, backup)
            backed_up = True
        published = False
        try:
            _require_active_job(job["id"])
            await rename_path(staging, destination)
            published = True
            _require_active_job(job["id"])
        except Exception:
            if published:
                shutil.rmtree(destination, ignore_errors=True)
            if backed_up:
                try:
                    await rename_path(backup, destination)
                except Exception:
                    pass
            raise

        def _commit() -> None:
            if not backed_up:
                return
            shutil.rmtree(backup, ignore_errors=True)

        async def _rollback() -> None:
            shutil.rmtree(destination, ignore_errors=True)
            if not backed_up:
                return
            await rename_path(backup, destination)

        return _commit, _rollback

    async def _run_job(job: dict[str, Any], input_path: str, model_revision: str) -> None:
        library = deps.getLibraryFolder()
        staging = get_ocr_staging_root(library, job["documentId"], job["id"])
        destination = get_ocr_result_root(library, job["documentId"], job["resultKey"])
        state["running_job_id"] = job["id"]
        try:
            safe_makedirs(staging)
            _update_job(
                job["id"],
                {
                    "status": "running",
                    "stage": "startingWorker",
                    "progress": 0.02,
                    "startedAt": now_ms(),
                },
            )

            def _on_progress(progress: Any) -> None:
                if not state["destroyed"] and job["id"] not in cancelled:
                    stage = progress.stage if hasattr(progress, "stage") else progress.get("stage")
                    prog = progress.progress if hasattr(progress, "progress") else progress.get("progress")
                    _update_job(job["id"], {"stage": stage, "progress": prog})

            worker_result = await deps.worker["parse"](
                input_path,
                staging,
                job["profile"],
                _on_progress,
            )
            _require_active_job(job["id"])
            _update_job(job["id"], {"stage": "validating", "progress": 0.98})
            await _validate_normalized_files(staging)
            _require_active_job(job["id"])
            options_hash = digest(result_options(job["profile"]))
            created_at = now_ms()
            manifest = {
                "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
                "documentId": job["documentId"],
                "resultKey": job["resultKey"],
                "sourceHash": job["sourceHash"],
                "mineruVersion": MINERU_VERSION,
                "modelRevision": model_revision,
                "profile": job["profile"],
                "optionsHash": options_hash,
                "createdAt": created_at,
                "files": {
                    "markdown": worker_result.markdown,
                    "blocks": worker_result.blocks,
                    "middle": worker_result.middle,
                    "assets": worker_result.assets,
                },
                "pageCount": worker_result.pageCount,
                "blockCount": worker_result.blockCount,
            }
            manifest_path = os.path.join(staging, "manifest.json")
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2)
            try:
                os.chmod(manifest_path, 0o600)
            except OSError:
                pass
            _require_active_job(job["id"])
            publish_staging = get_ocr_staging_root(library, job["documentId"], job["id"])
            publish_destination = get_ocr_result_root(library, job["documentId"], job["resultKey"])
            safe_makedirs(get_ocr_document_root(library, job["documentId"]))
            commit, rollback = await _publish_result(library, job, publish_staging, publish_destination)
            try:
                _require_active_job(job["id"])
                relative_root = to_library_relative_path(library, destination)
                result: dict[str, Any] = {
                    "id": str(uuid.uuid4()),
                    "documentId": job["documentId"],
                    "resultKey": job["resultKey"],
                    "sourceHash": job["sourceHash"],
                    "mineruVersion": MINERU_VERSION,
                    "modelRevision": model_revision,
                    "profile": job["profile"],
                    "optionsHash": options_hash,
                    "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
                    "relativeRoot": relative_root,
                    "markdownRelativePath": os.path.join(relative_root, "document.md"),
                    "blocksRelativePath": os.path.join(relative_root, "blocks.jsonl"),
                    "manifestRelativePath": os.path.join(relative_root, "manifest.json"),
                    "createdAt": created_at,
                    "stale": False,
                }
                def persist_success() -> tuple[dict[str, Any], dict[str, Any]]:
                    stored_result = document_ocr["insertResult"](result)
                    completed_job = document_ocr["updateJob"](
                        job["id"],
                        {
                            "status": "succeeded",
                            "stage": "completed",
                            "progress": 1.0,
                            "finishedAt": now_ms(),
                        },
                    )
                    return stored_result, completed_job

                stored, completed_job = transaction(persist_success)
                _emit_job(completed_job)
            except Exception:
                await rollback()
                raise
            commit()
            _emit(
                deps.emitCompleted,
                {"jobId": job["id"], "documentId": job["documentId"], "result": stored},
            )
        except Exception as error:
            try:
                safe_staging = get_ocr_staging_root(library, job["documentId"], job["id"])
                shutil.rmtree(safe_staging, ignore_errors=True)
            except Exception:
                pass
            if state["destroyed"]:
                return
            if document_ocr["getJob"](job["id"]) is None:
                return
            was_cancelled = state["destroyed"] or job["id"] in cancelled
            code = "cancelled" if was_cancelled else _error_code(error)
            message = "MinerU conversion was cancelled" if was_cancelled else _error_message(error)
            _update_job(
                job["id"],
                {
                    "status": "cancelled" if was_cancelled else "failed",
                    "errorCode": code,
                    "errorMessage": message,
                    "finishedAt": now_ms(),
                },
            )
            if not was_cancelled:
                _emit(
                    deps.emitError,
                    {"jobId": job["id"], "documentId": job["documentId"], "code": code, "message": message}
                )
        finally:
            cancelled.discard(job["id"])
            if state["running_job_id"] == job["id"]:
                state["running_job_id"] = None

    async def start_ocr(document_id: str, profile: OcrProfile = "balanced") -> str:
        if state["destroyed"]:
            raise RuntimeError("OCR service is unavailable")
        if profile not in VALID_PROFILES:
            raise RepoError("invalid_value", "Unsupported OCR profile", "profile")
        if state["start_pending"]:
            raise RepoError("busy", "MinerU is already processing a document")
        state["start_pending"] = True
        try:
            engine = await deps.engineManager["getRuntime"]()
            existing = document_ocr["getAnyActiveJob"]()
            if existing is not None:
                raise RepoError("busy", "MinerU is already processing a document")
            source_path, source_hash = await _get_source_hash(document_id)
            if state["destroyed"]:
                raise RuntimeError("OCR service is unavailable")
            options_hash = digest(result_options(profile))
            result_key = digest(f"{source_hash}:{options_hash}:{engine.modelRevision}")[:32]
            now = now_ms()
            job = document_ocr["createJob"](
                {
                    "id": str(uuid.uuid4()),
                    "documentId": document_id,
                    "resultKey": result_key,
                    "sourceHash": source_hash,
                    "profile": profile,
                    "status": "queued",
                    "stage": "queued",
                    "progress": 0,
                    "errorCode": None,
                    "errorMessage": None,
                    "createdAt": now,
                    "startedAt": None,
                    "finishedAt": None,
                    "updatedAt": now,
                }
            )
            _emit_job(job)
            task = asyncio.ensure_future(_run_job(job, source_path, engine.modelRevision))
            state["running_task"] = {"jobId": job["id"], "task": task}

            def _on_done(completed: asyncio.Task) -> None:
                if state["running_task"] and state["running_task"]["jobId"] == job["id"]:
                    state["running_task"] = None

            task.add_done_callback(_on_done)
            return job["id"]
        finally:
            state["start_pending"] = False

    async def cancel_ocr(job_id: str) -> dict[str, Any]:
        job = document_ocr["getJob"](job_id)
        if job is None:
            raise RepoError("not_found", f"OCR job not found: {job_id}")
        if job["status"] not in ACTIVE_STATUSES:
            return job
        cancelled.add(job_id)
        if state["running_job_id"] == job_id:
            await deps.worker["cancel"]()
        running_task = state["running_task"]
        if running_task and running_task["jobId"] == job_id:
            await running_task["task"]
        refreshed = document_ocr["getJob"](job_id)
        return refreshed if refreshed is not None else job

    async def get_ocr_state() -> dict[str, Any]:
        any_active = document_ocr["getAnyActiveJob"]()
        engine_status = await deps.engineManager["getStatus"]()
        return {
            "engine": engine_status.to_dict() if hasattr(engine_status, "to_dict") else _status_to_dict(engine_status),
            "activeJob": any_active,
        }

    async def get_markdown(job_id: str) -> str:
        job = document_ocr["getJob"](job_id)
        if job is None:
            raise RepoError("not_found", f"OCR job not found: {job_id}")
        result = document_ocr["getResultByKey"](job["documentId"], job["resultKey"])
        if result is None:
            raise RepoError("not_found", "OCR result not found")
        path = resolve_ocr_result_file(deps.getLibraryFolder(), result["markdownRelativePath"])
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()

    async def read_markdown(document_id: str, result_key: str) -> str:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"Document not found: {document_id}")
        result = document_ocr["getResultByKey"](document_id, result_key)
        if result is None:
            raise RepoError("not_found", "OCR result not found")
        source_hash = document.get("fileHash")
        if (
            isinstance(source_hash, str)
            and source_hash
            and result.get("sourceHash") != source_hash
        ):
            raise RepoError("stale", "OCR result is stale for the current document")
        path = resolve_ocr_result_file(deps.getLibraryFolder(), result["markdownRelativePath"])
        try:
            if _is_symlink(path) or not _is_regular_file(path):
                raise RepoError("file_missing", "OCR markdown file is missing")
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        except RepoError:
            raise
        except (OSError, UnicodeError) as error:
            raise RepoError("file_missing", "OCR markdown file is unavailable") from error

    def resolve_asset(document_id: str, result_key: str, asset_path: str) -> str:
        result = document_ocr["getResultByKey"](document_id, result_key)
        if result is None:
            raise RepoError("not_found", "OCR result not found")
        relative_root = result.get("relativeRoot")
        if (
            not isinstance(relative_root, str)
            or not isinstance(asset_path, str)
            or not asset_path
            or os.path.isabs(asset_path)
        ):
            raise RepoError("invalid_path", "OCR asset path is invalid")
        result_root = os.path.realpath(
            os.path.join(deps.getLibraryFolder(), relative_root)
        )
        candidate_relative = os.path.join(relative_root, "assets", asset_path)
        candidate = resolve_ocr_result_file(
            deps.getLibraryFolder(), candidate_relative
        )
        try:
            inside = os.path.commonpath(
                [result_root, os.path.realpath(candidate)]
            ) == result_root
        except ValueError:
            inside = False
        if not inside:
            raise RepoError("invalid_path", "OCR asset path is invalid")
        return candidate

    async def wait_for_job(job_id: str) -> dict[str, Any]:
        current = document_ocr["getJob"](job_id)
        if current is None:
            raise RepoError("not_found", f"OCR job not found: {job_id}")
        if current["status"] not in ACTIVE_STATUSES:
            if current["status"] != "succeeded":
                raise RuntimeError(
                    current.get("errorMessage")
                    or f"OCR job ended with status {current['status']}"
                )
            return current
        running_task = state["running_task"]
        if not running_task or running_task["jobId"] != job_id:
            raise RuntimeError("OCR job is not running in this process")
        await asyncio.shield(running_task["task"])
        completed = document_ocr["getJob"](job_id)
        if completed is None:
            raise RepoError("not_found", f"OCR job not found: {job_id}")
        if completed["status"] != "succeeded":
            raise RuntimeError(
                completed.get("errorMessage")
                or f"OCR job ended with status {completed['status']}"
            )
        return completed

    async def read_cached_for_agent(
        document_id: str,
    ) -> dict[str, Any] | None:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"Document not found: {document_id}")
        result = document_ocr["getResult"](document_id, document.get("fileHash"))
        if result is None or result.get("stale"):
            return None
        return {
            "result": result,
            "markdown": await read_markdown(document_id, result["resultKey"]),
        }

    async def _wait_for_job_with_signal(
        job_id: str,
        signal: asyncio.Event | None,
        cancel_on_signal: bool,
    ) -> dict[str, Any]:
        if signal is None:
            return await wait_for_job(job_id)

        if signal.is_set():
            if cancel_on_signal:
                await asyncio.shield(cancel_ocr(job_id))
            raise RuntimeError("OCR reading was cancelled")

        running_task = state["running_task"]
        if not running_task or running_task["jobId"] != job_id:
            return await wait_for_job(job_id)

        async def _wait_for_signal():
            await signal.wait()

        signal_future = asyncio.ensure_future(_wait_for_signal())
        try:
            done, pending = await asyncio.wait(
                {running_task["task"], signal_future},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            if not signal_future.done():
                signal_future.cancel()

        if signal_future in done:
            if cancel_on_signal:
                await asyncio.shield(cancel_ocr(job_id))
            raise RuntimeError("OCR reading was cancelled")

        return await wait_for_job(job_id)

    async def prepare_for_agent(
        document_id: str,
        signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        if signal is not None and signal.is_set():
            raise RuntimeError("OCR reading was cancelled")
        cached = await read_cached_for_agent(document_id)
        if cached is not None and cached["result"].get("profile") in {
            "balanced",
            "quality",
        }:
            return cached
        active_job = document_ocr["getActiveJob"](document_id)
        started_by_agent = False
        if active_job is not None and active_job.get("profile") not in {
            "balanced",
            "quality",
        }:
            raise RepoError(
                "busy",
                f"MinerU is already processing this document with the {active_job['profile']} profile",
            )
        job_id = active_job["id"] if active_job is not None else None
        if job_id is None:
            job_id = await start_ocr(document_id, "balanced")
            started_by_agent = True
        try:
            await _wait_for_job_with_signal(job_id, signal, started_by_agent)
        except asyncio.CancelledError:
            if started_by_agent:
                await asyncio.shield(cancel_ocr(job_id))
            raise
        except RuntimeError:
            raise
        cached = await read_cached_for_agent(document_id)
        if cached is None or cached["result"].get("profile") not in {
            "balanced",
            "quality",
        }:
            raise RuntimeError("Balanced OCR result is unavailable")
        return cached

    async def prepare_document_delete(document_id: str) -> None:
        active = document_ocr["getActiveJob"](document_id)
        if active is not None:
            await cancel_ocr(active["id"])
        root = get_ocr_document_root(deps.getLibraryFolder(), document_id)
        shutil.rmtree(root, ignore_errors=True)

    def destroy() -> None:
        state["destroyed"] = True
        if state["running_job_id"]:
            cancelled.add(state["running_job_id"])
        deps.worker["destroy"]()

    async def stop_worker() -> None:
        await deps.worker["stop"]()

    return {
        "initialize": initialize,
        "getState": get_state,
        "startOcr": start_ocr,
        "cancelOcr": cancel_ocr,
        "getOcrState": get_ocr_state,
        "getMarkdown": get_markdown,
        "readMarkdown": read_markdown,
        "resolveAsset": resolve_asset,
        "readCachedForAgent": read_cached_for_agent,
        "prepareForAgent": prepare_for_agent,
        "prepareDocumentDelete": prepare_document_delete,
        "stopWorker": stop_worker,
        "destroy": destroy,
    }


OcrService = dict[str, Any]
createOcrService = create_ocr_service


__all__ = [
    "OcrService",
    "OcrServiceDeps",
    "createOcrService",
    "create_ocr_service",
]
