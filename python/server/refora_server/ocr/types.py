from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

MINERU_VERSION = "3.4.4"
MINERU_WORKER_PROTOCOL_VERSION = 1
OCR_RESULT_SCHEMA_VERSION = 1

MineruEngineState = Literal[
    "notInstalled",
    "installing",
    "installed",
    "unavailable",
    "invalid",
]

MineruInstallStage = Literal[
    "preparing",
    "installingTools",
    "installingPython",
    "installingMineru",
    "downloadingModels",
    "healthCheck",
    "finalizing",
    "completed",
]

OcrProfile = Literal["compatible", "balanced", "quality"]

OcrJobStatus = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
]

OcrJobStage = Literal[
    "queued",
    "startingWorker",
    "loadingModels",
    "parsing",
    "writingResults",
    "validating",
    "completed",
]

OCR_PROFILES: tuple[OcrProfile, ...] = ("compatible", "balanced", "quality")
OCR_JOB_STATUSES: tuple[OcrJobStatus, ...] = (
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
)
OCR_JOB_STAGES: tuple[OcrJobStage, ...] = (
    "queued",
    "startingWorker",
    "loadingModels",
    "parsing",
    "writingResults",
    "validating",
    "completed",
)
ACTIVE_JOB_STATUSES: tuple[OcrJobStatus, ...] = ("queued", "running")


@dataclass
class OcrJob:
    id: str
    documentId: str
    resultKey: str
    sourceHash: str
    profile: OcrProfile
    status: OcrJobStatus
    stage: OcrJobStage
    progress: float | None
    errorCode: str | None
    errorMessage: str | None
    createdAt: int
    startedAt: int | None
    finishedAt: int | None
    updatedAt: int


@dataclass
class OcrResult:
    id: str
    documentId: str
    resultKey: str
    sourceHash: str
    mineruVersion: str
    modelRevision: str
    profile: OcrProfile
    optionsHash: str
    schemaVersion: int
    relativeRoot: str
    markdownRelativePath: str
    blocksRelativePath: str
    manifestRelativePath: str
    createdAt: int
    stale: bool


__all__ = [
    "MINERU_VERSION",
    "MINERU_WORKER_PROTOCOL_VERSION",
    "OCR_RESULT_SCHEMA_VERSION",
    "MineruEngineState",
    "MineruInstallStage",
    "OcrProfile",
    "OcrJobStatus",
    "OcrJobStage",
    "OCR_PROFILES",
    "OCR_JOB_STATUSES",
    "OCR_JOB_STAGES",
    "ACTIVE_JOB_STATUSES",
    "OcrJob",
    "OcrResult",
]
