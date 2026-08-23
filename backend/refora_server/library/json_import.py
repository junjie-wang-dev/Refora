from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

from refora_server.library.document_ids import is_safe_document_id
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
    if (
        not is_safe_document_id(document_id)
        or not isinstance(raw_file_path, str)
    ):
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


def _preflight_import(data: dict[str, Any], library_folder: str) -> tuple[
    list[dict[str, Any]],
    list[dict[str, str]],
    list[dict[str, str]],
]:
    sanitized_documents: list[dict[str, Any]] = []
    document_ids: set[str] = set()
    for index, raw_document in enumerate(data["documents"]):
        document = sanitizeImportedDoc(raw_document, library_folder)
        if document is None:
            raise ValueError(f"Invalid export document at index {index}")
        document_id = document["id"]
        if document_id in document_ids:
            raise ValueError(f"Duplicate export document id: {document_id}")
        document_ids.add(document_id)
        sanitized_documents.append(document)

    sanitized_categories: list[dict[str, str]] = []
    category_ids: set[str] = set()
    category_names: set[str] = set()
    for index, raw_category in enumerate(data["categories"]):
        if not isinstance(raw_category, dict):
            raise ValueError(f"Invalid export category at index {index}")
        category_id = raw_category.get("id")
        name = raw_category.get("name")
        if (
            not isinstance(category_id, str)
            or not category_id
            or not isinstance(name, str)
            or not name.strip()
        ):
            raise ValueError(f"Invalid export category at index {index}")
        if category_id in category_ids:
            raise ValueError(f"Duplicate export category id: {category_id}")
        if name in category_names:
            raise ValueError(f"Duplicate export category name: {name}")
        category_ids.add(category_id)
        category_names.add(name)
        sanitized_categories.append({"id": category_id, "name": name})

    sanitized_links: list[dict[str, str]] = []
    links: set[tuple[str, str]] = set()
    for index, raw_link in enumerate(data["documentCategories"]):
        if not isinstance(raw_link, dict):
            raise ValueError(f"Invalid export document category at index {index}")
        document_id = raw_link.get("documentId")
        category_id = raw_link.get("categoryId")
        if not isinstance(document_id, str) or not isinstance(category_id, str):
            raise ValueError(f"Invalid export document category at index {index}")
        if document_id not in document_ids or category_id not in category_ids:
            raise ValueError(f"Inconsistent export document category at index {index}")
        key = (document_id, category_id)
        if key in links:
            raise ValueError(
                f"Duplicate export document category: {document_id}/{category_id}"
            )
        links.add(key)
        sanitized_links.append(
            {"documentId": document_id, "categoryId": category_id}
        )
    return sanitized_documents, sanitized_categories, sanitized_links


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
    sanitized_documents, sanitized_categories, sanitized_links = _preflight_import(
        data, library_folder
    )

    def operation() -> dict[str, int]:
        if mode == "replace":
            documents["deleteAll"]()
            for category in categories["list"]():
                categories["delete"](category["id"])
        category_ids: dict[str, str] = {}
        known_names = {category["name"]: category["id"] for category in categories["list"]()}
        for category in sanitized_categories:
            old_id = category["id"]
            name = category["name"]
            category_ids[old_id] = known_names.get(name) or categories["create"](name)["id"]
            known_names[name] = category_ids[old_id]
        inserted: set[str] = set()
        count = 0
        for document in sanitized_documents:
            if mode == "merge" and documents["get"](document["id"]) is not None:
                continue
            documents["insert"](document)
            inserted.add(document["id"])
            count += 1
        for link in sanitized_links:
            document_id = link["documentId"]
            category_id = link["categoryId"]
            new_category_id = category_ids.get(category_id)
            if document_id in inserted and new_category_id:
                categories["assign"](document_id, new_category_id)
        return {"imported": count}

    transaction = repos.get("transaction")
    return transaction(operation) if callable(transaction) else operation()
