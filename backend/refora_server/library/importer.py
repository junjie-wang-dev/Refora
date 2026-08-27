from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import shutil
import stat
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from refora_server.library.pdf_discovery import find_pdf_files
from refora_server.library.paths import isInLibraryRoot
from refora_server.services.document_identity import (
    file_signature,
    refresh_document_identity,
    stored_file_signature,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def hashPdf(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validatePdfPath(raw: str) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute() or path.suffix.lower() != ".pdf":
        return None
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return str(path.resolve(strict=True))
    except OSError:
        return None


def validatePdfContents(path: str) -> dict[str, str] | None:
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted and reader.decrypt("") == 0:
            return {"type": "encrypted", "message": "Password required"}
        len(reader.pages)
        return None
    except PdfReadError as error:
        message = str(error)
        kind = "encrypted" if "password" in message.lower() else "corrupted"
        return {"type": kind, "message": message}
    except Exception as error:
        return {"type": "corrupted", "message": str(error)}


def _copy_to_library(
    source: str,
    library_folder: str,
    preferred_name: str | None = None,
) -> str:
    folder = Path(library_folder)
    folder.mkdir(parents=True, exist_ok=True)
    source_path = Path(source)
    requested_name = Path(preferred_name or source_path.name).name
    if Path(requested_name).suffix.lower() != ".pdf":
        requested_name = source_path.name
    requested_path = Path(requested_name)
    source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source_fd = -1
    temporary_fd = -1
    temporary: Path | None = None
    destination: Path | None = None
    published: Path | None = None
    completed = False
    try:
        source_fd = os.open(source_path, source_flags)
        temporary_fd, temporary_name = tempfile.mkstemp(
            prefix=".refora-import-",
            suffix=".part",
            dir=folder,
        )
        temporary = Path(temporary_name)
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("PDF source must be a regular file")
        with os.fdopen(source_fd, "rb") as input_file:
            source_fd = -1
            with os.fdopen(temporary_fd, "wb") as output_file:
                temporary_fd = -1
                shutil.copyfileobj(input_file, output_file, 1024 * 1024)
                os.fchmod(output_file.fileno(), stat.S_IMODE(source_stat.st_mode))
                output_file.flush()
                os.fsync(output_file.fileno())
        number = 0
        while True:
            suffix = "" if number == 0 else f" ({number})"
            destination = folder / f"{requested_path.stem}{suffix}{requested_path.suffix}"
            try:
                os.link(temporary, destination, follow_symlinks=False)
                published = destination
                break
            except FileExistsError:
                number += 1
        temporary.unlink()
        directory_fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        completed = True
        return str(destination.resolve())
    finally:
        if source_fd >= 0:
            os.close(source_fd)
        if temporary_fd >= 0:
            os.close(temporary_fd)
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        if not completed and published is not None:
            published.unlink(missing_ok=True)


def _file_identity(path: str) -> tuple[int, int, int, int, int]:
    value = os.stat(path, follow_symlinks=False)
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _is_content_object_path(path: str, library_folder: str) -> bool:
    try:
        relative = Path(path).resolve().relative_to(Path(library_folder).resolve())
    except ValueError:
        return False
    parts = relative.parts
    return len(parts) == 4 and parts[:2] == ("objects", "sha256")


def _remove_empty_content_object_directories(path: str, library_folder: str) -> None:
    current = Path(path).parent
    root = Path(library_folder).resolve()
    while current != root:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _library_folder(repos: dict[str, Any], deps: dict[str, Any]) -> str:
    getter = deps.get("getLibraryFolder")
    if callable(getter):
        value = getter()
        return value if isinstance(value, str) else ""
    settings = repos.get("settings")
    if settings is not None:
        value = settings.get("libraryFolderPath", "")
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
                return decoded if isinstance(decoded, str) else value
            except json.JSONDecodeError:
                return value
    return ""


def createImporter(repos: dict[str, Any], deps: dict[str, Any] | None = None) -> dict[str, Callable[..., Any]]:
    options = deps or {}
    documents = repos["documents"]
    emit_progress = options.get("emitProgress")
    copy_to_library = options.get("copyToLibrary", _copy_to_library)
    make_id = options.get("newId", _new_id)
    now_ms = options.get("nowMs", _now_ms)
    hash_pdf = options.get("hashPdf", hashPdf)
    validate_pdf = options.get("validatePdf", validatePdfContents)
    extract_metadata = options.get("extractPdfMetadata")
    complete_callbacks: list[Callable[[dict[str, Any]], None]] = []
    import_lock = asyncio.Lock()
    destroyed = False

    def complete(result: dict[str, Any]) -> dict[str, Any]:
        for callback in complete_callbacks:
            callback(result)
        return result

    async def call_work(function: Any, *args: Any) -> Any:
        if inspect.iscoroutinefunction(function):
            return await function(*args)
        return await asyncio.to_thread(function, *args)

    async def importFiles(paths: list[str], isWatch: bool = False) -> dict[str, Any]:
        nonlocal destroyed
        async with import_lock:
            if destroyed:
                return {"imported": [], "skipped": [], "errors": []}
            return await run_import_files(paths, isWatch)

    async def run_import_files(paths: list[str], isWatch: bool) -> dict[str, Any]:
        imported: list[str] = []
        skipped: list[str] = []
        errors: list[dict[str, str]] = []
        library_folder = _library_folder(repos, options)
        total = len(paths)
        if total == 0:
            return complete({"imported": imported, "skipped": skipped, "errors": errors})
        if not library_folder:
            errors.extend(
                {"path": raw, "message": "Library folder is not configured. Please set it in Settings first."}
                for raw in paths
            )
            return complete({"imported": imported, "skipped": skipped, "errors": errors})
        for index, raw in enumerate(paths, start=1):
            copied_path: str | None = None
            try:
                if destroyed:
                    return {"imported": imported, "skipped": skipped, "errors": errors}
                path = validatePdfPath(raw)
                if path is None:
                    skipped.append(raw)
                    continue
                existing_path = documents["findByPath"](path)
                if existing_path is not None:
                    signature = file_signature(path)
                    if (
                        existing_path.get("fileMissing") == 1
                        or stored_file_signature(existing_path) != signature
                    ):
                        current_hash = await call_work(hash_pdf, path)
                        refresh_document_identity(
                            repos,
                            existing_path,
                            lambda _path: current_hash,
                            signature,
                        )
                    skipped.append(path)
                    continue
                source_identity = _file_identity(path)
                file_hash = await call_work(hash_pdf, path)
                duplicate = (
                    documents["findByHash"](file_hash)
                    if file_hash
                    else None
                )
                if duplicate is not None:
                    skipped.append(path)
                    continue
                validation = await call_work(validate_pdf, path)
                if isinstance(validation, dict):
                    file_name = Path(path).name
                    if validation.get("type") == "encrypted":
                        message = f"Skipping encrypted PDF: {file_name} (password-protected)."
                    elif validation.get("type") == "corrupted":
                        message = f"Could not read: {file_name} (file may be corrupted)."
                    else:
                        message = str(validation.get("message") or "Unable to read PDF")
                    errors.append({"path": path, "message": message})
                    continue
                if _file_identity(path) != source_identity:
                    raise RuntimeError("PDF changed during import")
                stored_path = path
                if not isInLibraryRoot(path, library_folder):
                    copied = await call_work(copy_to_library, path, library_folder)
                    stored_path = validatePdfPath(copied) or ""
                    if not stored_path or not isInLibraryRoot(stored_path, library_folder):
                        raise ValueError("Copied PDF path is outside the library root")
                    if await call_work(hash_pdf, stored_path) != file_hash:
                        raise ValueError("Copied PDF content failed verification")
                    copied_path = stored_path
                initial_identity = _file_identity(stored_path)
                now = now_ms()
                extracted = (
                    await call_work(extract_metadata, stored_path)
                    if callable(extract_metadata)
                    else None
                )
                if _file_identity(stored_path) != initial_identity:
                    raise RuntimeError("PDF changed during import")
                stored_stat = os.stat(stored_path, follow_symlinks=False)
                metadata = extracted if isinstance(extracted, dict) else {}
                document = documents["insert"](
                    {
                        "id": make_id(),
                        "filePath": stored_path,
                        "originalFolderPath": str(Path(path).parent),
                        "fileName": Path(stored_path).name,
                        "fileSize": stored_stat.st_size,
                        "fileHash": file_hash,
                        "title": metadata.get("title") if isinstance(metadata.get("title"), str) else None,
                        "authors": metadata.get("authors") if isinstance(metadata.get("authors"), str) else None,
                        "year": metadata.get("year") if isinstance(metadata.get("year"), str) else None,
                        "venue": metadata.get("venue") if isinstance(metadata.get("venue"), str) else None,
                        "volume": metadata.get("volume") if isinstance(metadata.get("volume"), str) else None,
                        "issue": metadata.get("issue") if isinstance(metadata.get("issue"), str) else None,
                        "pages": metadata.get("pages") if isinstance(metadata.get("pages"), str) else None,
                        "abstract": metadata.get("abstract") if isinstance(metadata.get("abstract"), str) else None,
                        "keywords": metadata.get("keywords") if isinstance(metadata.get("keywords"), str) else None,
                        "url": metadata.get("url") if isinstance(metadata.get("url"), str) else None,
                        "doi": metadata.get("doi") if isinstance(metadata.get("doi"), str) else None,
                        "arxivId": metadata.get("arxivId") if isinstance(metadata.get("arxivId"), str) else None,
                        "note": metadata.get("note") if isinstance(metadata.get("note"), str) else None,
                        "affiliations": metadata.get("affiliations") if isinstance(metadata.get("affiliations"), str) else None,
                        "starred": 0,
                        "addedAt": now,
                        "lastReadAt": None,
                        "updatedAt": now,
                        "metadataSource": metadata.get("metadataSource") if isinstance(metadata.get("metadataSource"), str) else None,
                        "metadataStatus": "done" if metadata else "pending",
                        "metadataAttempts": 0,
                        "editedFields": [],
                        "remoteValues": None,
                        "fileMissing": 0,
                    }
                )
                copied_path = None
                imported.append(document["id"])
            except Exception as error:
                if copied_path:
                    Path(copied_path).unlink(missing_ok=True)
                errors.append({"path": raw, "message": str(error)})
            finally:
                if callable(emit_progress):
                    emit_progress({"current": index, "total": total, "path": raw})
        return complete({"imported": imported, "skipped": skipped, "errors": errors})

    async def importFolder(path: str, recursive: bool = False) -> dict[str, Any]:
        folder = Path(path)
        if not folder.is_absolute() or not folder.exists() or folder.is_symlink() or not folder.is_dir():
            return complete({"imported": [], "skipped": [path], "errors": []})
        paths = await asyncio.to_thread(
            find_pdf_files,
            str(folder),
            recursive=recursive,
        )
        return await importFiles(paths)

    async def normalizeManagedFiles() -> dict[str, Any]:
        async with import_lock:
            library_folder = _library_folder(repos, options)
            normalized = 0
            errors: list[dict[str, str]] = []
            if not library_folder or destroyed:
                return {"normalized": normalized, "errors": errors}
            offset = 0
            migrated_content_objects: set[str] = set()
            while not destroyed:
                documents_page = documents["list"](
                    {"mode": "all", "limit": 500, "offset": offset}
                )
                if not documents_page:
                    break
                for document in documents_page:
                    path = validatePdfPath(document.get("filePath"))
                    if path is None:
                        continue
                    if isInLibraryRoot(path, library_folder):
                        continue
                    copied_path: str | None = None
                    try:
                        file_hash = await call_work(hash_pdf, path)
                        copied = await call_work(
                            _copy_to_library,
                            path,
                            library_folder,
                            document.get("fileName"),
                        )
                        destination = validatePdfPath(copied) or ""
                        copied_path = destination
                        if not destination or await call_work(hash_pdf, destination) != file_hash:
                            raise ValueError("Managed PDF content failed verification")
                        file_stat = os.stat(destination, follow_symlinks=False)
                        documents["updateFileIdentity"](
                            document["id"],
                            destination,
                            Path(destination).name,
                            file_stat.st_size,
                            file_hash,
                            file_stat.st_dev,
                            file_stat.st_ino,
                            file_stat.st_mtime_ns,
                        )
                        updated = documents["get"](document["id"])
                        if (
                            updated is None
                            or Path(updated["filePath"]).resolve()
                            != Path(destination).resolve()
                        ):
                            raise RuntimeError("Managed PDF record changed during normalization")
                        copied_path = None
                        normalized += 1
                        if _is_content_object_path(path, library_folder):
                            migrated_content_objects.add(path)
                    except Exception as error:
                        if copied_path:
                            Path(copied_path).unlink(missing_ok=True)
                        errors.append({"path": path, "message": str(error)})
                offset += len(documents_page)
                if len(documents_page) < 500:
                    break
            for path in migrated_content_objects:
                if documents["findByPath"](path) is not None:
                    continue
                Path(path).unlink(missing_ok=True)
                _remove_empty_content_object_directories(path, library_folder)
            return {"normalized": normalized, "errors": errors}

    def onComplete(callback: Callable[[dict[str, Any]], None]) -> None:
        complete_callbacks.append(callback)

    def destroy() -> None:
        nonlocal destroyed
        destroyed = True
        complete_callbacks.clear()

    return {
        "importFiles": importFiles,
        "importFolder": importFolder,
        "normalizeManagedFiles": normalizeManagedFiles,
        "onComplete": onComplete,
        "destroy": destroy,
    }
