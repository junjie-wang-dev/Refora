from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from typing import Any
from urllib.parse import unquote, urlsplit


_MEDIA_KINDS = {"image", "audio", "video", "file"}
_INLINE_MEDIA_RE = re.compile(r"^data:(image/(?:png|jpeg|jpg|gif|webp|avif)|audio/[a-zA-Z0-9.+-]+|video/[a-zA-Z0-9.+-]+|application/(?:pdf|octet-stream|json|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|text/(?:plain|csv|tab-separated-values|markdown|json));base64,[A-Za-z0-9+/=\r\n]+$", re.IGNORECASE)


def normalize_media(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value[:512]:
        if len(result) >= 64:
            break
        if not isinstance(item, dict) or not isinstance(item.get("kind"), str) or item["kind"] not in _MEDIA_KINDS:
            continue
        source = item.get("source")
        if not isinstance(source, dict):
            continue
        kind = source.get("type")
        if not isinstance(kind, str):
            continue
        fields = {
            "asset": ("assetId",), "ocr": ("documentId", "resultKey", "path"),
            "remote": ("url",), "inline": ("dataUrl",),
            "sandbox": ("runId", "path"), "cached": ("mediaId",), "unavailable": ("reason",),
        }.get(kind)
        if fields is None or any(not isinstance(source.get(key), str) or not source[key].strip() for key in fields):
            continue
        cleaned = {"type": kind, **{key: source[key] for key in fields}}
        if kind == "remote":
            try:
                parsed = urlsplit(cleaned["url"])
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or len(cleaned["url"]) > 2048:
                    continue
            except ValueError:
                continue
        elif kind == "inline":
            if len(cleaned["dataUrl"]) > 32 * 1024 * 1024:
                cleaned = {"type": "unavailable", "reason": "Media exceeds the 24 MB display limit."}
            elif not _INLINE_MEDIA_RE.fullmatch(cleaned["dataUrl"]):
                cleaned = {"type": "unavailable", "reason": "This media encoding or format cannot be displayed."}
        elif any(len(cleaned[key]) > 4096 for key in fields):
            continue
        if kind in {"ocr", "sandbox"}:
            path = unquote(cleaned["path"])
            if "\x00" in path or "\\" in path or ".." in path.split("/"):
                continue
            if kind == "ocr" and not path.startswith(("images/", "assets/")):
                continue
            if kind == "sandbox" and not path.lstrip("/").startswith("outputs/"):
                continue
        identity = json.dumps([item["kind"], cleaned], sort_keys=True, ensure_ascii=False)
        identifier = item.get("id")
        if not isinstance(identifier, str) or not identifier or len(identifier) > 200:
            identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
        if identifier in seen:
            continue
        seen.add(identifier)
        media = {"id": identifier, "kind": item["kind"], "source": cleaned}
        for key, limit in (("title", 500), ("mimeType", 200)):
            text = item.get(key)
            if isinstance(text, str) and text.strip():
                media[key] = text.strip()[:limit]
        result.append(media)
    return result


def normalize_attachments(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in value[:8]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        field = "docId" if kind == "document" else "assetId" if kind == "asset" else None
        identifier = item.get(field) if field else None
        if not isinstance(identifier, str) or not identifier.strip() or field is None:
            continue
        key = (kind, identifier)
        if key in seen:
            continue
        seen.add(key)
        reference = {"type": kind, field: identifier}
        title = item.get("title")
        if isinstance(title, str) and title.strip():
            reference["title"] = title.strip()[:500]
        result.append(reference)
    return result


def attachment_snapshots(repos: Any, value: Any) -> list[dict[str, str]]:
    attachments = normalize_attachments(value)
    for attachment in attachments:
        document = attachment["type"] == "document"
        repository_name = "documents" if document else "workspaceAssets"
        repository = repos.get(repository_name) if isinstance(repos, Mapping) else getattr(repos, repository_name, None)
        getter = repository.get("get") if isinstance(repository, Mapping) else getattr(repository, "get", None)
        item = getter(attachment["docId" if document else "assetId"]) if callable(getter) else None
        title = (item.get("title") or item.get("fileName")) if item else None
        attachment.pop("title", None)
        if isinstance(title, str) and title.strip():
            attachment["title"] = title.strip()[:500]
    return attachments


def display_message(message: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in message.items() if key != "displayContent"}
    if message.get("displayContent") is not None:
        result["content"] = message["displayContent"]
        return result
    if message.get("role") != "user":
        return result
    content = message.get("content") or ""
    marker = "\n\n[Attached workspace files]\n"
    if marker not in content:
        return result
    text, block = content.rsplit(marker, 1)
    block = re.sub(
        r"\n\(Note: \d+ attachment\(s\) were unavailable in this workspace and omitted\.\)$",
        "",
        block,
    )
    records = re.split(r"(?m)^- type: ", block)
    if records[0] or len(records) < 2:
        return result
    attachments: list[dict[str, str]] = []
    for record in records[1:]:
        lines = record.splitlines()
        if not lines or lines[0] not in {"document", "asset"}:
            return result
        allowed = (
            {"itemId", "docId", "title", "authors", "year", "hasSummary"}
            if lines[0] == "document"
            else {"itemId", "assetId", "fileName", "mimeType", "previewKind", "fileMissing"}
        )
        for line in lines[1:]:
            field_match = re.fullmatch(r"  ([A-Za-z]+): (.*)", line)
            if field_match is None or field_match[1] not in allowed:
                return result
        fields = dict(re.findall(r"^  ([A-Za-z]+): (.*)$", record, re.MULTILINE))
        kind = lines[0]
        field = "docId" if kind == "document" else "assetId"
        if not fields.get(field) or not fields.get("itemId"):
            return result
        attachments.append({
            "type": kind,
            field: fields[field],
            "title": fields.get("title") or fields.get("fileName") or fields[field],
        })
    result["content"] = text
    result["attachments"] = normalize_attachments(attachments)
    return result
