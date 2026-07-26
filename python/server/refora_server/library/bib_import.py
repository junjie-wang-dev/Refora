from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from refora_server.library.paths import isInsideLibrary


FIELD_MAP = {
    "title": "title",
    "author": "authors",
    "year": "year",
    "journal": "venue",
    "booktitle": "venue",
    "volume": "volume",
    "number": "issue",
    "issue": "issue",
    "pages": "pages",
    "abstract": "abstract",
    "keywords": "keywords",
    "url": "url",
    "doi": "doi",
    "note": "note",
}
MAX_BIBTEX_BYTES = 50 * 1024 * 1024


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _read_brace_delimited(text: str, start: int) -> tuple[str, int] | None:
    depth = 0
    value: list[str] = []
    pos = start
    while pos < len(text):
        char = text[pos]
        if char == "{":
            if depth > 0:
                value.append(char)
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return "".join(value), pos + 1
            value.append(char)
        else:
            value.append(char)
        pos += 1
    return None


def _read_quote_delimited(text: str, start: int) -> tuple[str, int] | None:
    value: list[str] = []
    pos = start + 1
    while pos < len(text):
        char = text[pos]
        if char == "\\" and pos + 1 < len(text):
            value.extend((char, text[pos + 1]))
            pos += 2
            continue
        if char == '"':
            return "".join(value), pos + 1
        if char == "{":
            brace = _read_brace_delimited(text, pos)
            if brace is not None:
                part, pos = brace
                value.append(part)
                continue
        value.append(char)
        pos += 1
    return None


def _read_value(text: str, start: int) -> tuple[str, int] | None:
    pos = start
    result: list[str] = []
    while pos < len(text):
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            break
        if text[pos] == "{":
            part = _read_brace_delimited(text, pos)
        elif text[pos] == '"':
            part = _read_quote_delimited(text, pos)
        else:
            end = pos
            while end < len(text) and text[end] not in ',{}"':
                end += 1
            bare = text[pos:end].strip()
            part = (bare, end) if bare else None
        if part is None:
            return None
        value, pos = part
        result.append(value)
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text) or text[pos] != "#":
            break
        pos += 1
    return "".join(result), pos


def _parse_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    pos = 0
    while pos < len(text):
        while pos < len(text) and (text[pos].isspace() or text[pos] == ","):
            pos += 1
        start = pos
        while pos < len(text) and (text[pos].isalnum() or text[pos] in "_-:"):
            pos += 1
        name = text[start:pos].lower()
        if not name:
            break
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text) or text[pos] != "=":
            break
        pos += 1
        value = _read_value(text, pos)
        if value is None:
            break
        parsed, pos = value
        clean_name = re.sub(r"^bibfield-", "", name)
        fields.setdefault(clean_name, parsed)
    return fields


def parseBibtex(content: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    index = 0
    while index < len(content):
        at_index = content.find("@", index)
        if at_index < 0:
            break
        pos = at_index + 1
        type_start = pos
        while pos < len(content) and content[pos].isalpha():
            pos += 1
        entry_type = content[type_start:pos].lower()
        if entry_type in {"comment", "string", "preamble"}:
            index = pos
            continue
        while pos < len(content) and content[pos].isspace():
            pos += 1
        if pos >= len(content) or content[pos] != "{":
            index = pos
            continue
        body = _read_brace_delimited(content, pos)
        if body is None:
            break
        raw_body, index = body
        comma = raw_body.find(",")
        citekey = raw_body.strip() if comma < 0 else raw_body[:comma].strip()
        fields_text = "" if comma < 0 else raw_body[comma + 1 :]
        entries.append({"entryType": entry_type, "citekey": citekey, "fields": _parse_fields(fields_text)})
    return entries


def unescapeLatex(value: str) -> str:
    result = value
    for source, target in (
        (r"\{}", "{"), (r"\}", "}"), (r"\{", "{"), (r'\"', '"'),
        (r"\&", "&"), (r"\%", "%"), (r"\#", "#"), (r"\_", "_"),
        (r"\$", "$"), (r"\\", "\\"),
    ):
        result = result.replace(source, target)
    result = re.sub(r"\{\\([\"'`\^~=.])\}", r"\1", result)
    result = re.sub(r'\\"\{(\w)\}', r"\1", result)
    result = re.sub(r"\\['`]\{(\w)\}", r"\1", result)
    result = re.sub(r"\\[\^~]([A-Za-z])", r"\1", result)
    return re.sub(r"\{([^{}]*)\}", r"\1", result)


def normalizeAuthors(value: str) -> str:
    authors = [author.strip() for author in re.split(r"\band\b", value, flags=re.IGNORECASE) if author.strip()]
    normalized: list[str] = []
    for author in authors:
        if "," in author:
            last, *rest = author.split(",")
            first = ",".join(rest).strip()
            normalized.append(f"{last.strip()}, {first}" if first else last.strip())
        else:
            normalized.append(author)
    return "; ".join(normalized)


def normalizePages(value: str) -> str:
    return re.sub(r"\s*-\s*", "-", re.sub(r"\s*--\s*", "-", value))


def extractMetadataFromEntry(entry: dict[str, Any]) -> dict[str, str]:
    fields = entry["fields"]
    result: dict[str, str] = {}
    for bib_key, document_field in FIELD_MAP.items():
        if document_field == "venue":
            if "venue" in result:
                continue
            raw = fields.get("journal") or fields.get("booktitle")
            if raw:
                result["venue"] = unescapeLatex(raw).strip().replace("{", "").replace("}", "")
            continue
        raw = fields.get(bib_key)
        if not raw:
            continue
        value = unescapeLatex(raw).strip()
        if not value:
            continue
        if document_field == "authors":
            value = normalizeAuthors(value)
        elif document_field == "pages":
            value = normalizePages(value)
        elif document_field == "year":
            match = re.search(r"\d{4}", value)
            value = match.group(0) if match else value
        result[document_field] = value
    prefix = unescapeLatex(fields.get("archiveprefix", "")).strip().lower()
    eprint = unescapeLatex(fields.get("eprint", "")).strip().replace("{", "").replace("}", "")
    if prefix == "arxiv" and eprint:
        result["arxivId"] = eprint
    return result


def extractAttachmentPaths(raw: str) -> list[str]:
    paths: list[str] = []
    for part in raw.split(";"):
        candidate = part.strip()
        pdf_end = candidate.lower().find(".pdf")
        if pdf_end >= 0:
            candidate = candidate[: pdf_end + 4]
        file_url_index = candidate.lower().find("file://")
        if file_url_index >= 0:
            parsed = urlparse(candidate[file_url_index:])
            if parsed.scheme == "file":
                candidate = unquote(parsed.path)
                if parsed.netloc and parsed.netloc != "localhost":
                    candidate = f"//{parsed.netloc}{candidate}"
            else:
                candidate = ""
        else:
            descriptor_end = candidate.find(":")
            if descriptor_end >= 0:
                described_path = candidate[descriptor_end + 1 :].strip()
                if ".pdf" in described_path.lower():
                    candidate = described_path
        if candidate:
            paths.append(candidate)
    return paths


def _validate_pdf_path(raw: str, base_dir: str) -> str | None:
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = Path(base_dir) / path
    if path.suffix.lower() != ".pdf":
        return None
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return str(path.resolve(strict=True))
    except OSError:
        return None


def _find_pdf_from_entry(entry: dict[str, Any], source: str, base_dir: str) -> str | None:
    fields = entry["fields"]
    candidates: list[str] = []
    if source == "zotero":
        for number in range(1, 10):
            raw = fields.get(f"file{number}")
            if raw:
                candidates.extend(extractAttachmentPaths(raw))
        raw = fields.get("file")
        if raw:
            candidates.extend(extractAttachmentPaths(raw))
    elif source == "mendeley":
        for name in ("file", "files"):
            raw = fields.get(name)
            if raw:
                candidates.extend(extractAttachmentPaths(raw))
    else:
        raise ValueError("source must be zotero or mendeley")
    for candidate in candidates:
        valid = _validate_pdf_path(candidate, base_dir)
        if valid:
            return valid
    return None


def _hash_pdf(file_path: str) -> str | None:
    try:
        digest = hashlib.sha256()
        with open(file_path, "rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()
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
    else:
        settings = repos.get("settings")
        value = settings.get("libraryFolderPath", "") if settings is not None else ""
    if not isinstance(value, str):
        return ""
    try:
        decoded = json.loads(value)
        if isinstance(decoded, str):
            return decoded
    except json.JSONDecodeError:
        pass
    return value


def _base_document(
    metadata: dict[str, str],
    citekey: str,
    now_ms: Any,
    make_id: Any,
) -> dict[str, Any]:
    now = now_ms()
    return {
        "id": make_id(),
        "title": metadata.get("title"),
        "authors": metadata.get("authors"),
        "affiliations": None,
        "year": metadata.get("year"),
        "venue": metadata.get("venue"),
        "volume": metadata.get("volume"),
        "issue": metadata.get("issue"),
        "pages": metadata.get("pages"),
        "abstract": metadata.get("abstract"),
        "keywords": metadata.get("keywords"),
        "url": metadata.get("url"),
        "doi": metadata.get("doi"),
        "arxivId": None,
        "note": citekey or None,
        "starred": 0,
        "addedAt": now,
        "lastReadAt": None,
        "updatedAt": now,
        "metadataSource": "manual",
        "metadataStatus": "done",
        "metadataAttempts": 0,
        "editedFields": [],
        "remoteValues": None,
        "fileMissing": 0,
    }


def _apply_metadata_to_existing(
    documents: dict[str, Any],
    document_id: str,
    metadata: dict[str, str],
    citekey: str,
) -> None:
    document = documents["get"](document_id)
    if document is None:
        return
    edited_fields = document.get("editedFields", [])
    patch: dict[str, str] = {}
    remote_values = dict(document.get("remoteValues") or {})
    for field, value in metadata.items():
        if not value:
            continue
        if field in edited_fields:
            remote_values[field] = {"value": value, "source": "manual"}
        else:
            patch[field] = value
    if citekey and not document.get("note") and "note" not in edited_fields:
        patch["note"] = citekey
    if patch:
        documents["update"](document_id, patch)
    if remote_values or document.get("remoteValues") is not None:
        documents["setRemoteValues"](document_id, remote_values)


async def importFromBibtex(
    repos: dict[str, Any],
    file_path: str,
    source: str,
    verifyArxivId: Any = None,
    deps: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options = deps or {}
    path = Path(file_path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("BibTeX path is not a file")
    if path.stat().st_size > MAX_BIBTEX_BYTES:
        raise ValueError("BibTeX file exceeds the 50 MB limit")
    entries = parseBibtex(path.read_text(encoding="utf-8"))
    documents = repos["documents"]
    now_ms = options.get("nowMs", _now_ms)
    make_id = options.get("newId", _new_id)
    hash_pdf = options.get("hashPdf", _hash_pdf)
    copy_to_library = options.get("copyToLibrary", _copy_to_library)
    library_folder = _library_folder(repos, options)
    added: list[str] = []
    skipped: list[str] = []
    errors: list[dict[str, str]] = []

    async def apply_arxiv(document_id: str, arxiv_id: str | None, key: str) -> None:
        if not arxiv_id:
            return
        if not callable(verifyArxivId):
            errors.append({"key": key, "message": "arXiv verification service is unavailable"})
            return
        try:
            result = verifyArxivId(document_id, arxiv_id)
            if inspect.isawaitable(result):
                await result
        except Exception as error:
            errors.append({"key": key, "message": str(error)})

    for number, entry in enumerate(entries, start=1):
        key = entry["citekey"] or f"entry-{number}"
        try:
            metadata = extractMetadataFromEntry(entry)
            arxiv_id = metadata.pop("arxivId", None)
            pdf_path = _find_pdf_from_entry(entry, source, str(path.parent))
            if pdf_path:
                existing = documents["findByPath"](pdf_path)
                file_hash: str | None = None
                if existing is None:
                    file_hash = hash_pdf(pdf_path)
                    if file_hash:
                        existing = documents["findByHash"](file_hash)
                if existing is not None:
                    _apply_metadata_to_existing(documents, existing["id"], metadata, entry["citekey"])
                    await apply_arxiv(existing["id"], arxiv_id, key)
                    skipped.append(existing["id"])
                    continue
                stat = os.stat(pdf_path)
                base = _base_document(metadata, entry["citekey"], now_ms, make_id)
                document = documents["insert"](
                    {
                        **base,
                        "filePath": pdf_path,
                        "originalFolderPath": str(Path(pdf_path).parent),
                        "fileName": Path(pdf_path).name,
                        "fileSize": stat.st_size,
                        "fileHash": file_hash,
                    }
                )
                if library_folder and not isInsideLibrary(pdf_path, library_folder):
                    try:
                        copied_path = copy_to_library(pdf_path, library_folder)
                        documents["updateFilePath"](
                            document["id"], copied_path, Path(copied_path).name
                        )
                    except Exception:
                        pass
                added.append(document["id"])
                await apply_arxiv(document["id"], arxiv_id, key)
                continue
            base = _base_document(metadata, entry["citekey"], now_ms, make_id)
            document = documents["insert"](
                {
                    **base,
                    "filePath": "",
                    "originalFolderPath": "",
                    "fileName": entry["citekey"] or "",
                    "fileSize": None,
                    "fileHash": None,
                    "fileMissing": 1,
                }
            )
            added.append(document["id"])
            await apply_arxiv(document["id"], arxiv_id, key)
        except Exception as error:
            errors.append({"key": key, "message": str(error)})
    return {"added": added, "skipped": skipped, "errors": errors}


def importBibtex(repos: dict[str, Any], content: str, deps: dict[str, Any] | None = None) -> dict[str, Any]:
    options = deps or {}
    documents = repos["documents"]
    now_ms = options.get("nowMs", _now_ms)
    make_id = options.get("newId", _new_id)
    imported: list[str] = []
    skipped: list[str] = []
    errors: list[dict[str, str]] = []
    existing_documents = documents["list"]({"mode": "all"})
    for number, entry in enumerate(parseBibtex(content), start=1):
        key = entry["citekey"] or f"entry-{number}"
        try:
            metadata = extractMetadataFromEntry(entry)
            duplicate = next(
                (
                    document for document in existing_documents
                    if (metadata.get("doi") and document.get("doi", "").lower() == metadata["doi"].lower())
                    or (metadata.get("arxivId") and document.get("arxivId") == metadata["arxivId"])
                ),
                None,
            )
            if duplicate is not None:
                patch = {
                    field: value
                    for field, value in metadata.items()
                    if field in {"title", "authors", "year", "venue", "volume", "issue", "pages", "abstract", "keywords", "url", "doi", "note"}
                    and not duplicate.get(field)
                }
                if patch:
                    documents["update"](duplicate["id"], patch)
                skipped.append(duplicate["id"])
                continue
            now = now_ms()
            document = documents["insert"](
                {
                    "id": make_id(),
                    "filePath": "",
                    "originalFolderPath": "",
                    "fileName": key,
                    "fileSize": None,
                    "fileHash": None,
                    "title": metadata.get("title"),
                    "authors": metadata.get("authors"),
                    "year": metadata.get("year"),
                    "venue": metadata.get("venue"),
                    "volume": metadata.get("volume"),
                    "issue": metadata.get("issue"),
                    "pages": metadata.get("pages"),
                    "abstract": metadata.get("abstract"),
                    "keywords": metadata.get("keywords"),
                    "url": metadata.get("url"),
                    "doi": metadata.get("doi"),
                    "arxivId": metadata.get("arxivId"),
                    "note": metadata.get("note") or key or None,
                    "affiliations": None,
                    "starred": 0,
                    "addedAt": now,
                    "lastReadAt": None,
                    "updatedAt": now,
                    "metadataSource": "manual",
                    "metadataStatus": "done",
                    "metadataAttempts": 0,
                    "editedFields": [],
                    "remoteValues": None,
                    "fileMissing": 1,
                }
            )
            imported.append(document["id"])
            existing_documents.append(document)
        except Exception as error:
            errors.append({"key": key, "message": str(error)})
    return {"imported": imported, "skipped": skipped, "errors": errors}
