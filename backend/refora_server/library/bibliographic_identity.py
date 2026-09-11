from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote

from refora_server.academic.arxiv import base_arxiv_id, normalize_arxiv_id


def normalized_doi(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    value = unquote(value.strip())
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value, flags=re.I)
    return value.lower()


def normalized_arxiv(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = normalize_arxiv_id(value)
    return base_arxiv_id(normalized).lower() if normalized else ""


def find_identity_match(documents: list[dict[str, Any]], metadata: dict[str, Any]) -> dict[str, Any] | None:
    doi = normalized_doi(metadata.get("doi"))
    arxiv = normalized_arxiv(metadata.get("arxivId"))
    key = metadata.get("citekey")
    title = re.sub(r"\s+", " ", str(metadata.get("title") or "")).strip().casefold()
    for document in documents:
        if doi and normalized_doi(document.get("doi")) == doi:
            return document
        if arxiv and normalized_arxiv(document.get("arxivId")) == arxiv:
            return document
        if not doi and not arxiv and key and title and document.get("citekey") == key:
            if re.sub(r"\s+", " ", str(document.get("title") or "")).strip().casefold() == title:
                return document
    return None


def find_existing(documents: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any] | None:
    finder = documents.get("findByIdentity")
    if callable(finder):
        return finder(metadata)
    listing = documents.get("list")
    return find_identity_match(listing({"mode": "all"}), metadata) if callable(listing) else None
