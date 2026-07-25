from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path

from refora_server.repositories.errors import RepoError

SAFE_SEGMENT = re.compile(r"^[a-zA-Z0-9_-]+$")

_SEG = os.sep


def _resolve(p: str) -> str:
    return os.path.normpath(os.path.abspath(p))


def _is_within(parent: str, candidate: str) -> bool:
    rel = os.path.relpath(candidate, parent)
    if rel == "":
        return True
    if rel == "..":
        return False
    return not rel.startswith(".." + _SEG) and not os.path.isabs(rel)


def _require_segment(value: str, label: str) -> str:
    if not SAFE_SEGMENT.match(value):
        raise RepoError("invalid_path", f"Invalid OCR {label}")
    return value


def _lstat(path: str) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError:
        return None


def _is_executable(path: str) -> bool:
    try:
        st = os.stat(path)
    except OSError:
        return False
    return bool(st.st_mode & stat.S_IXUSR)


def _is_regular_file(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode)


def _is_symlink(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISLNK(st.st_mode)


def require_safe_managed_path(root: str, candidate: str) -> str:
    resolved_root = _resolve(root)
    resolved_candidate = _resolve(candidate)
    if not _is_within(resolved_root, resolved_candidate):
        raise RepoError("invalid_path", "OCR path is outside the managed directory")
    current = resolved_root
    for segment in [s for s in os.path.relpath(resolved_candidate, resolved_root).split(_SEG) if s]:
        current = os.path.join(current, segment)
        if not os.path.exists(current):
            break
        if _is_symlink(current):
            raise RepoError("invalid_path", "OCR managed directories cannot be symbolic links")
    return resolved_candidate


def get_ocr_root(library_folder: str) -> str:
    if not library_folder or not os.path.isabs(library_folder):
        raise RepoError("invalid_path", "Library folder must be an absolute path")
    library = _resolve(library_folder)
    current = library
    for segment in (".refora", "derived", "OCR"):
        current = os.path.join(current, segment)
        if os.path.exists(current) and _is_symlink(current):
            raise RepoError("invalid_path", "OCR managed directories cannot be symbolic links")
    return current


def get_ocr_document_root(library_folder: str, document_id: str) -> str:
    root = get_ocr_root(library_folder)
    return require_safe_managed_path(root, os.path.join(root, _require_segment(document_id, "document ID")))


def get_ocr_result_root(library_folder: str, document_id: str, result_key: str) -> str:
    document_root = get_ocr_document_root(library_folder, document_id)
    return require_safe_managed_path(
        document_root, os.path.join(document_root, _require_segment(result_key, "result key"))
    )


def get_ocr_staging_root(library_folder: str, document_id: str, job_id: str) -> str:
    document_root = get_ocr_document_root(library_folder, document_id)
    return require_safe_managed_path(
        document_root, os.path.join(document_root, ".staging", _require_segment(job_id, "job ID"))
    )


def get_ocr_publish_backup_root(library_folder: str, document_id: str, job_id: str) -> str:
    document_root = get_ocr_document_root(library_folder, document_id)
    return require_safe_managed_path(
        document_root, os.path.join(document_root, ".backup", _require_segment(job_id, "job ID"))
    )


def to_library_relative_path(library_folder: str, absolute_path: str) -> str:
    root = _resolve(library_folder)
    candidate = _resolve(absolute_path)
    if not _is_within(root, candidate):
        raise RepoError("invalid_path", "OCR result is outside the Library folder")
    return os.path.relpath(candidate, root)


def resolve_ocr_result_file(library_folder: str, relative_path: str) -> str:
    if not relative_path or os.path.isabs(relative_path):
        raise RepoError("invalid_path", "OCR result path must be Library-relative")
    root = get_ocr_root(library_folder)
    candidate = _resolve(os.path.join(library_folder, relative_path))
    if not _is_within(root, candidate):
        raise RepoError("invalid_path", "OCR result path is outside the managed directory")
    if not os.path.exists(candidate):
        raise RepoError("file_missing", f"OCR result file not found: {candidate}")
    if _is_symlink(candidate) or not _is_regular_file(candidate):
        raise RepoError("invalid_path", "OCR result path must be a regular file")
    real_root = os.path.realpath(root)
    real_candidate = os.path.realpath(candidate)
    if not _is_within(real_root, real_candidate):
        raise RepoError("invalid_path", "OCR result path resolves outside the managed directory")
    return candidate


def resolve_pdf_file_path(raw_path: str) -> str:
    if not raw_path or not os.path.isabs(raw_path):
        raise RepoError("invalid_path", "PDF path must be absolute")
    resolved = _resolve(raw_path)
    if not resolved.lower().endswith(".pdf"):
        raise RepoError("invalid_path", "Selected file must be a PDF")
    if not os.path.exists(resolved):
        raise RepoError("file_missing", f"File not found: {resolved}")
    if _is_symlink(resolved) or not _is_regular_file(resolved):
        raise RepoError("invalid_path", "Selected path must be a regular PDF file")
    return resolved


def stream_file_hash(file_path: str, chunk_size: int = 64 * 1024) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def sha256_file(file_path: str) -> str:
    return stream_file_hash(file_path)


def safe_makedirs(path: str, mode: int = 0o700) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


__all__ = [
    "get_ocr_document_root",
    "get_ocr_publish_backup_root",
    "get_ocr_result_root",
    "get_ocr_root",
    "get_ocr_staging_root",
    "require_safe_managed_path",
    "resolve_ocr_result_file",
    "resolve_pdf_file_path",
    "safe_makedirs",
    "sha256_file",
    "stream_file_hash",
    "to_library_relative_path",
]
