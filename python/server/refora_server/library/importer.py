from __future__ import annotations

import hashlib
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from refora_server.library.paths import isInsideLibrary


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


def _copy_to_library(source: str, library_folder: str) -> str:
    folder = Path(library_folder)
    folder.mkdir(parents=True, exist_ok=True)
    source_path = Path(source)
    destination = folder / source_path.name
    number = 1
    while destination.exists():
        destination = folder / f"{source_path.stem} ({number}){source_path.suffix}"
        number += 1
    shutil.copy2(source_path, destination)
    return str(destination.resolve())


def _library_folder(repos: dict[str, Any], deps: dict[str, Any]) -> str:
    getter = deps.get("getLibraryFolder")
    if callable(getter):
        value = getter()
        return value if isinstance(value, str) else ""
    settings = repos.get("settings")
    if settings is not None:
        value = settings.get("libraryFolderPath", "")
        return value if isinstance(value, str) else ""
    return ""


def createImporter(repos: dict[str, Any], deps: dict[str, Any] | None = None) -> dict[str, Callable[..., Any]]:
    options = deps or {}
    documents = repos["documents"]
    emit_progress = options.get("emitProgress")
    copy_to_library = options.get("copyToLibrary", _copy_to_library)
    make_id = options.get("newId", _new_id)
    now_ms = options.get("nowMs", _now_ms)
    hash_pdf = options.get("hashPdf", hashPdf)
    extract_metadata = options.get("extractPdfMetadata")
    complete_callbacks: list[Callable[[dict[str, Any]], None]] = []

    def complete(result: dict[str, Any]) -> dict[str, Any]:
        for callback in complete_callbacks:
            callback(result)
        return result

    def importFiles(paths: list[str], isWatch: bool = False) -> dict[str, Any]:
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
                path = validatePdfPath(raw)
                if path is None:
                    skipped.append(raw)
                    continue
                if documents["findByPath"](path) is not None:
                    skipped.append(path)
                    continue
                file_hash = hash_pdf(path)
                if documents["findByHash"](file_hash) is not None:
                    skipped.append(path)
                    continue
                stored_path = path
                if not isInsideLibrary(path, library_folder):
                    copied_path = copy_to_library(path, library_folder)
                    stored_path = copied_path
                stat = os.stat(path)
                now = now_ms()
                extracted = extract_metadata(path) if callable(extract_metadata) else None
                metadata = extracted if isinstance(extracted, dict) else {}
                document = documents["insert"](
                    {
                        "id": make_id(),
                        "filePath": stored_path,
                        "originalFolderPath": str(Path(path).parent),
                        "fileName": Path(stored_path).name,
                        "fileSize": stat.st_size,
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
                imported.append(document["id"])
            except Exception as error:
                if copied_path:
                    Path(copied_path).unlink(missing_ok=True)
                errors.append({"path": raw, "message": str(error)})
            finally:
                if callable(emit_progress):
                    emit_progress({"current": index, "total": total, "path": raw})
        return complete({"imported": imported, "skipped": skipped, "errors": errors})

    def importFolder(path: str, recursive: bool = False) -> dict[str, Any]:
        folder = Path(path)
        if not folder.is_absolute() or not folder.exists() or folder.is_symlink() or not folder.is_dir():
            return complete({"imported": [], "skipped": [path], "errors": []})
        iterator = folder.rglob("*") if recursive else folder.glob("*")
        paths = [str(item.resolve()) for item in iterator if item.suffix.lower() == ".pdf"]
        return importFiles(sorted(paths))

    def onComplete(callback: Callable[[dict[str, Any]], None]) -> None:
        complete_callbacks.append(callback)

    def destroy() -> None:
        complete_callbacks.clear()

    return {
        "importFiles": importFiles,
        "importFolder": importFolder,
        "onComplete": onComplete,
        "destroy": destroy,
    }
