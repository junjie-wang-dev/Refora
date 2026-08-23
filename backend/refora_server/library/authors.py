from __future__ import annotations

import re
from collections.abc import Iterable

_DBLP_SUFFIX = re.compile(r"\s+\d{4}$")
_SUFFIX = re.compile(r"^(?:Jr\.?|Sr\.?|II|III|IV|V)$", re.IGNORECASE)
_ORGANIZATION_SUFFIX = re.compile(
    r"^(?:inc\.?|ltd\.?|llc|llp|plc|gmbh|ag|s\.?a\.?|corp\.?|corporation|co\.?|company)$",
    re.IGNORECASE,
)
_ORGANIZATION_WORD = re.compile(
    r"\b(?:university|institute|institution|laborator(?:y|ies)|department|cent(?:er|re)|"
    r"association|society|corporation|company|foundation|organi[sz]ation|committee|"
    r"consortium|council|agency|ministry|hospital|school|college|academy|government)\b",
    re.IGNORECASE,
)


def normalizeAuthorName(value: str) -> str:
    author = re.sub(r"\s+", " ", value).strip()
    author = _DBLP_SUFFIX.sub("", author).strip()
    if not author:
        return ""

    parts = [part.strip() for part in author.split(",") if part.strip()]
    if len(parts) < 2:
        return author
    if re.fullmatch(r"\d{4}", parts[0]):
        return " ".join(parts[1:])
    if _ORGANIZATION_SUFFIX.fullmatch(parts[-1]) or _ORGANIZATION_WORD.search(author):
        return ", ".join(parts)

    family = parts[0]
    if len(parts) >= 3 and _SUFFIX.fullmatch(parts[1]):
        return " ".join([*parts[2:], family, parts[1]])
    if len(parts) >= 3 and _SUFFIX.fullmatch(parts[-1]):
        return " ".join([*parts[1:-1], family, parts[-1]])
    return " ".join([*parts[1:], family])


def normalizeAuthorList(values: Iterable[str]) -> str:
    normalized = [
        author
        for value in values
        for author in [normalizeAuthorName(value)]
        if author
    ]
    return "; ".join(normalized)


def normalizeAuthors(value: str | None) -> str | None:
    if not value or not value.strip():
        return None
    normalized = normalizeAuthorList(value.split(";"))
    return normalized or None


def authorFamilyName(value: str) -> str:
    author = normalizeAuthorName(value)
    if not author:
        return ""
    parts = author.split()
    if len(parts) >= 2 and _SUFFIX.fullmatch(parts[-1]):
        return parts[-2]
    return parts[-1]
