from __future__ import annotations

import sqlite3
import time
from typing import Any

from refora_server.ocr.types import ACTIVE_JOB_STATUSES, OcrJob, OcrResult
from refora_server.repositories.errors import RepoError

JOB_COLUMNS: tuple[str, ...] = (
    "id",
    "documentId",
    "resultKey",
    "sourceHash",
    "profile",
    "status",
    "stage",
    "progress",
    "errorCode",
    "errorMessage",
    "createdAt",
    "startedAt",
    "finishedAt",
    "updatedAt",
)

RESULT_COLUMNS: tuple[str, ...] = (
    "id",
    "documentId",
    "resultKey",
    "sourceHash",
    "mineruVersion",
    "modelRevision",
    "profile",
    "optionsHash",
    "schemaVersion",
    "relativeRoot",
    "markdownRelativePath",
    "blocksRelativePath",
    "manifestRelativePath",
    "createdAt",
)

UPDATE_JOB_FIELDS: tuple[str, ...] = (
    "status",
    "stage",
    "progress",
    "errorCode",
    "errorMessage",
    "startedAt",
    "finishedAt",
)


def now_ms() -> int:
    return int(time.time() * 1000)


def _map_job(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "documentId": row["documentId"],
        "resultKey": row["resultKey"],
        "sourceHash": row["sourceHash"],
        "profile": row["profile"],
        "status": row["status"],
        "stage": row["stage"],
        "progress": row["progress"],
        "errorCode": row["errorCode"],
        "errorMessage": row["errorMessage"],
        "createdAt": row["createdAt"],
        "startedAt": row["startedAt"],
        "finishedAt": row["finishedAt"],
        "updatedAt": row["updatedAt"],
    }


def _map_result(row: sqlite3.Row, source_hash: str | None = None) -> dict[str, Any]:
    row_source_hash = row["sourceHash"]
    return {
        "id": row["id"],
        "documentId": row["documentId"],
        "resultKey": row["resultKey"],
        "sourceHash": row_source_hash,
        "mineruVersion": row["mineruVersion"],
        "modelRevision": row["modelRevision"],
        "profile": row["profile"],
        "optionsHash": row["optionsHash"],
        "schemaVersion": row["schemaVersion"],
        "relativeRoot": row["relativeRoot"],
        "markdownRelativePath": row["markdownRelativePath"],
        "blocksRelativePath": row["blocksRelativePath"],
        "manifestRelativePath": row["manifestRelativePath"],
        "createdAt": row["createdAt"],
        "stale": source_hash is not None and row_source_hash != source_hash,
    }


def _active_status_placeholders() -> str:
    return ", ".join("?" for _ in ACTIVE_JOB_STATUSES)


def createDocumentOcrRepository(db):
    def _get_job_row(job_id: str) -> sqlite3.Row | None:
        cur = db.execute("SELECT * FROM document_ocr_jobs WHERE id = ?", [job_id])
        return cur.fetchone()

    def createJob(job: dict[str, Any]) -> dict[str, Any]:
        values: list[Any] = [
            job["id"],
            job["documentId"],
            job["resultKey"],
            job["sourceHash"],
            job["profile"],
            job["status"],
            job["stage"],
            job.get("progress"),
            job.get("errorCode"),
            job.get("errorMessage"),
            job["createdAt"],
            job.get("startedAt"),
            job.get("finishedAt"),
            job["updatedAt"],
        ]
        col_list = ", ".join(JOB_COLUMNS)
        placeholders = ", ".join("?" for _ in JOB_COLUMNS)
        db.execute(
            f"INSERT INTO document_ocr_jobs ({col_list}) VALUES ({placeholders})",
            values,
        )
        row = _get_job_row(job["id"])
        assert row is not None
        return _map_job(row)

    def getJob(id: str) -> dict[str, Any] | None:
        row = _get_job_row(id)
        return _map_job(row) if row is not None else None

    def getActiveJob(documentId: str) -> dict[str, Any] | None:
        params: list[Any] = [documentId, *ACTIVE_JOB_STATUSES]
        cur = db.execute(
            f"SELECT * FROM document_ocr_jobs "
            f"WHERE documentId = ? AND status IN ({_active_status_placeholders()}) "
            f"ORDER BY createdAt DESC LIMIT 1",
            params,
        )
        row = cur.fetchone()
        return _map_job(row) if row is not None else None

    def getAnyActiveJob() -> dict[str, Any] | None:
        cur = db.execute(
            f"SELECT * FROM document_ocr_jobs "
            f"WHERE status IN ({_active_status_placeholders()}) "
            f"ORDER BY createdAt ASC LIMIT 1",
            list(ACTIVE_JOB_STATUSES),
        )
        row = cur.fetchone()
        return _map_job(row) if row is not None else None

    def updateJob(id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = getJob(id)
        if current is None:
            raise RepoError("not_found", f"OCR job not found: {id}")
        next_state = {**current, **patch, "updatedAt": now_ms()}
        db.execute(
            "UPDATE document_ocr_jobs SET "
            "status = ?, stage = ?, progress = ?, errorCode = ?, errorMessage = ?, "
            "startedAt = ?, finishedAt = ?, updatedAt = ? WHERE id = ?",
            [
                next_state["status"],
                next_state["stage"],
                next_state["progress"],
                next_state["errorCode"],
                next_state["errorMessage"],
                next_state["startedAt"],
                next_state["finishedAt"],
                next_state["updatedAt"],
                id,
            ],
        )
        row = _get_job_row(id)
        assert row is not None
        return _map_job(row)

    def markRunningInterrupted() -> int:
        now = now_ms()
        cur = db.execute(
            "UPDATE document_ocr_jobs "
            "SET status = 'interrupted', errorCode = 'interrupted', "
            "errorMessage = 'OCR process stopped before completion', "
            "finishedAt = ?, updatedAt = ? "
            f"WHERE status IN ({_active_status_placeholders()})",
            [now, now, *ACTIVE_JOB_STATUSES],
        )
        return cur.rowcount

    def insertResult(result: dict[str, Any]) -> dict[str, Any]:
        values: list[Any] = [
            result["id"],
            result["documentId"],
            result["resultKey"],
            result["sourceHash"],
            result["mineruVersion"],
            result["modelRevision"],
            result["profile"],
            result["optionsHash"],
            result["schemaVersion"],
            result["relativeRoot"],
            result["markdownRelativePath"],
            result["blocksRelativePath"],
            result["manifestRelativePath"],
            result["createdAt"],
        ]
        col_list = ", ".join(RESULT_COLUMNS)
        placeholders = ", ".join("?" for _ in RESULT_COLUMNS)
        db.execute(
            f"INSERT INTO document_ocr_results ({col_list}) VALUES ({placeholders}) "
            "ON CONFLICT(documentId, resultKey) DO UPDATE SET "
            "sourceHash = excluded.sourceHash, "
            "mineruVersion = excluded.mineruVersion, "
            "modelRevision = excluded.modelRevision, "
            "profile = excluded.profile, "
            "optionsHash = excluded.optionsHash, "
            "schemaVersion = excluded.schemaVersion, "
            "relativeRoot = excluded.relativeRoot, "
            "markdownRelativePath = excluded.markdownRelativePath, "
            "blocksRelativePath = excluded.blocksRelativePath, "
            "manifestRelativePath = excluded.manifestRelativePath, "
            "createdAt = excluded.createdAt",
            values,
        )
        out = getResult(result["documentId"], result["sourceHash"])
        assert out is not None
        return out

    def getResult(documentId: str, sourceHash: str | None = None) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM document_ocr_results WHERE documentId = ? "
            "ORDER BY createdAt DESC LIMIT 1",
            [documentId],
        )
        row = cur.fetchone()
        return _map_result(row, sourceHash) if row is not None else None

    def getResultByKey(documentId: str, resultKey: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT * FROM document_ocr_results WHERE documentId = ? AND resultKey = ?",
            [documentId, resultKey],
        )
        row = cur.fetchone()
        return _map_result(row) if row is not None else None

    def deleteResult(documentId: str, resultKey: str) -> None:
        db.execute(
            "DELETE FROM document_ocr_results WHERE documentId = ? AND resultKey = ?",
            [documentId, resultKey],
        )

    def deleteForDocument(documentId: str) -> None:
        db.execute(
            "DELETE FROM document_ocr_results WHERE documentId = ?",
            [documentId],
        )

    return {
        "createJob": createJob,
        "getJob": getJob,
        "getActiveJob": getActiveJob,
        "getAnyActiveJob": getAnyActiveJob,
        "updateJob": updateJob,
        "markRunningInterrupted": markRunningInterrupted,
        "insertResult": insertResult,
        "getResult": getResult,
        "getResultByKey": getResultByKey,
        "deleteResult": deleteResult,
        "deleteForDocument": deleteForDocument,
    }
