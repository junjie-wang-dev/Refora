from __future__ import annotations

import re
import time
import uuid
from typing import Any


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
    return "; ".join(authors)


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
