from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

from refora_server.library.paths import isInsideLibrary


EDITABLE_FIELDS = {
    "title", "authors", "year", "venue", "volume", "issue", "pages", "abstract",
    "keywords", "url", "doi", "arxivId", "note", "affiliations",
}
METADATA_STATUSES = {"pending", "done", "failed"}
METADATA_SOURCES = {"pdf", "crossref", "arxiv", "dblp", "manual"}


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _number_or_none(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _number_default(value: Any, default: int | float) -> int | float:
    parsed = _number_or_none(value)
    return default if parsed is None else parsed


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


def parseExportJson(payload: str | dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ValueError("Invalid export format: invalid JSON") from error
    else:
        parsed = payload
    if not isinstance(parsed, dict):
        raise ValueError("Invalid export format: not an object")
    for key in ("documents", "categories", "documentCategories"):
        if not isinstance(parsed.get(key), list):
            raise ValueError(f"Invalid export format: missing {key} array")
    return parsed


def sanitizeImportedDoc(doc: Any, libraryFolder: str) -> dict[str, Any] | None:
    if not isinstance(doc, dict):
        return None
    document_id = doc.get("id")
    raw_file_path = doc.get("filePath")
    if not isinstance(document_id, str) or not document_id or not isinstance(raw_file_path, str):
        return None
    path = Path(raw_file_path)
    if path.is_absolute():
        file_path = str(path.resolve(strict=False))
    else:
        if not libraryFolder:
            return None
        file_path = str((Path(libraryFolder) / path).resolve(strict=False))
        if not isInsideLibrary(file_path, libraryFolder):
            return None
    if Path(file_path).suffix.lower() != ".pdf":
        return None
    file_missing = 1
    file_size = _number_or_none(doc.get("fileSize"))
    try:
        if os.path.lexists(file_path):
            if Path(file_path).is_symlink() or not Path(file_path).is_file():
                return None
            stat = os.stat(file_path)
            file_missing = 0
            file_size = stat.st_size
    except OSError:
        return None
    raw_original = doc.get("originalFolderPath")
    original_folder = (
        str(Path(raw_original).resolve(strict=False))
        if isinstance(raw_original, str) and Path(raw_original).is_absolute()
        else str(Path(file_path).parent)
    )
    edited_fields = [
        value for value in doc.get("editedFields", [])
        if isinstance(value, str) and value in EDITABLE_FIELDS
    ] if isinstance(doc.get("editedFields"), list) else []
    remote_values = doc.get("remoteValues") if isinstance(doc.get("remoteValues"), dict) else None
    status = doc.get("metadataStatus")
    source = doc.get("metadataSource")
    return {
        "id": document_id,
        "filePath": file_path,
        "originalFolderPath": original_folder,
        "fileName": Path(file_path).name,
        "fileSize": file_size,
        "fileHash": _string_or_none(doc.get("fileHash")),
        "title": _string_or_none(doc.get("title")),
        "authors": _string_or_none(doc.get("authors")),
        "year": _string_or_none(doc.get("year")),
        "venue": _string_or_none(doc.get("venue")),
        "volume": _string_or_none(doc.get("volume")),
        "issue": _string_or_none(doc.get("issue")),
        "pages": _string_or_none(doc.get("pages")),
        "abstract": _string_or_none(doc.get("abstract")),
        "keywords": _string_or_none(doc.get("keywords")),
        "url": _string_or_none(doc.get("url")),
        "doi": _string_or_none(doc.get("doi")),
        "arxivId": _string_or_none(doc.get("arxivId")),
        "note": _string_or_none(doc.get("note")),
        "affiliations": _string_or_none(doc.get("affiliations")),
        "starred": _number_default(doc.get("starred"), 0),
        "addedAt": _number_default(doc.get("addedAt"), 0),
        "lastReadAt": _number_or_none(doc.get("lastReadAt")),
        "updatedAt": _number_default(doc.get("updatedAt"), 0),
        "metadataSource": source if isinstance(source, str) and source in METADATA_SOURCES else None,
        "metadataStatus": status if isinstance(status, str) and status in METADATA_STATUSES else "pending",
        "metadataAttempts": _number_default(doc.get("metadataAttempts"), 0),
        "editedFields": edited_fields,
        "remoteValues": remote_values,
        "fileMissing": file_missing,
    }


def importFromJson(
    repos: dict[str, Any],
    payload: str | dict[str, Any],
    mode: str = "merge",
    deps: dict[str, Any] | None = None,
) -> dict[str, int]:
    if mode not in {"merge", "replace"}:
        raise ValueError("Import mode must be merge or replace")
    options = deps or {}
    data = parseExportJson(payload)
    documents = repos["documents"]
    categories = repos["categories"]
    library_folder = _library_folder(repos, options)
    sanitized_documents = [
        document
        for raw_document in data["documents"]
        if (document := sanitizeImportedDoc(raw_document, library_folder)) is not None
    ]

    def operation() -> dict[str, int]:
        if mode == "replace":
            documents["deleteAll"]()
            for category in categories["list"]():
                categories["delete"](category["id"])
        category_ids: dict[str, str] = {}
        known_names = {category["name"]: category["id"] for category in categories["list"]()}
        for category in data["categories"]:
            if not isinstance(category, dict):
                continue
            old_id = category.get("id")
            name = category.get("name")
            if not isinstance(old_id, str) or not isinstance(name, str) or not name or old_id in category_ids:
                continue
            category_ids[old_id] = known_names.get(name) or categories["create"](name)["id"]
            known_names[name] = category_ids[old_id]
        inserted: set[str] = set()
        count = 0
        for document in sanitized_documents:
            if mode == "merge" and documents["get"](document["id"]) is not None:
                continue
            if mode == "merge":
                try:
                    documents["insert"](document)
                except Exception:
                    continue
            else:
                documents["insert"](document)
            inserted.add(document["id"])
            count += 1
        for link in data["documentCategories"]:
            if not isinstance(link, dict):
                continue
            document_id = link.get("documentId")
            category_id = link.get("categoryId")
            if not isinstance(document_id, str) or not isinstance(category_id, str):
                continue
            new_category_id = category_ids.get(category_id)
            if document_id in inserted and new_category_id:
                if mode == "merge":
                    try:
                        categories["assign"](document_id, new_category_id)
                    except Exception:
                        continue
                else:
                    categories["assign"](document_id, new_category_id)
        return {"imported": count}

    transaction = repos.get("transaction")
    return transaction(operation) if callable(transaction) else operation()
