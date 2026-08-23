from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import Any, Callable


FileSignature = tuple[int, int, int, int]


def stream_file_hash(path: str) -> str:
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode):
            raise ValueError("Document PDF is not a regular file")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    return digest.hexdigest()


def file_signature(path: str) -> FileSignature:
    value = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode):
        raise ValueError("Document PDF is not a regular file")
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)


def stored_file_signature(document: dict[str, Any]) -> FileSignature | None:
    values = (
        document.get("fileDevice"),
        document.get("fileInode"),
        document.get("fileSize"),
        document.get("fileMtimeNs"),
    )
    if any(isinstance(value, bool) or not isinstance(value, int) for value in values):
        return None
    return values


def refresh_document_identity(
    repos: dict[str, Any],
    document: dict[str, Any],
    hash_file: Callable[[str], str | None] = stream_file_hash,
    expected_signature: FileSignature | None = None,
) -> dict[str, Any] | None:
    path = document.get("filePath")
    if not isinstance(path, str) or not path:
        return None
    before = file_signature(path)
    if expected_signature is not None and before != expected_signature:
        raise RuntimeError("Document PDF changed while hashing")
    if stored_file_signature(document) == before and document.get("fileMissing") != 1:
        return None
    file_hash = hash_file(path)
    if not isinstance(file_hash, str) or not file_hash:
        raise RuntimeError("Unable to hash document PDF")
    after = file_signature(path)
    if after != before:
        raise RuntimeError("Document PDF changed while hashing")
    documents = repos["documents"]
    hash_changed = document.get("fileHash") != file_hash

    def operation() -> dict[str, Any]:
        documents["updateFileIdentity"](
            document["id"],
            path,
            Path(path).name,
            after[2],
            file_hash,
            after[0],
            after[1],
            after[3],
        )
        if hash_changed:
            summaries = repos.get("aiSummaries")
            delete_summary = summaries.get("delete") if isinstance(summaries, dict) else None
            if callable(delete_summary):
                delete_summary(document["id"])
            document_ocr = repos.get("documentOcr")
            delete_ocr = (
                document_ocr.get("deleteForDocument")
                if isinstance(document_ocr, dict)
                else None
            )
            if callable(delete_ocr):
                delete_ocr(document["id"])
        updated = documents["get"](document["id"])
        if updated is None:
            raise RuntimeError("Document disappeared while refreshing file identity")
        return updated

    transaction = repos.get("transaction")
    return transaction(operation) if callable(transaction) else operation()
