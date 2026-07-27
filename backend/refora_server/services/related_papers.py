from __future__ import annotations

import re
import unicodedata
from typing import Any

_STOP_TERMS = {
    "about",
    "after",
    "also",
    "among",
    "analysis",
    "based",
    "before",
    "between",
    "from",
    "into",
    "method",
    "methods",
    "paper",
    "results",
    "study",
    "that",
    "their",
    "these",
    "this",
    "through",
    "using",
    "with",
}


def _comparable(value: Any) -> str:
    return unicodedata.normalize("NFKC", value or "").casefold().strip()


def _terms(value: Any) -> set[str]:
    return {
        term
        for term in re.findall(r"[^\W_]+", _comparable(value), re.UNICODE)
        if len(term) >= 2 and term not in _STOP_TERMS
    }


def _authors(value: Any) -> set[str]:
    return {
        author.strip()
        for author in re.split(r";|\band\b", _comparable(value))
        if author.strip()
    }


def _shared(left: set[str], right: set[str]) -> list[str]:
    return sorted(left & right)


def _year(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def find_related_papers(
    repos: dict[str, Any],
    document_id: str,
    limit: int = 8,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    seed_id = document_id.strip()
    seed = repos["documents"]["get"](seed_id)
    if seed is None:
        return {"error": "Document not found", "docId": seed_id}
    seed_title = _terms(seed.get("title") or seed.get("fileName"))
    seed_keywords = _terms(seed.get("keywords"))
    seed_abstract = _terms(seed.get("abstract"))
    seed_authors = _authors(seed.get("authors"))
    seed_venue = _comparable(seed.get("venue"))
    seed_year = _year(seed.get("year"))
    workspace_doc_ids = {
        item["docId"]
        for item in repos["workspaceItems"]["list"](workspace_id)
        if item.get("kind") == "document" and isinstance(item.get("docId"), str)
    } if workspace_id else set()
    related: list[dict[str, Any]] = []
    for candidate in repos["documents"]["list"]({"mode": "all"}):
        if candidate["id"] == seed_id:
            continue
        shared_keywords = _shared(seed_keywords, _terms(candidate.get("keywords")))
        shared_title = _shared(
            seed_title, _terms(candidate.get("title") or candidate.get("fileName"))
        )
        shared_abstract = _shared(seed_abstract, _terms(candidate.get("abstract")))
        shared_authors = _shared(seed_authors, _authors(candidate.get("authors")))
        same_venue = bool(seed_venue) and seed_venue == _comparable(candidate.get("venue"))
        candidate_year = _year(candidate.get("year"))
        nearby_year = (
            seed_year is not None
            and candidate_year is not None
            and abs(seed_year - candidate_year) <= 1
        )
        evidence = (
            len(shared_keywords) * 4
            + len(shared_title) * 2
            + min(len(shared_abstract), 12) * 0.25
            + len(shared_authors) * 3
            + (1 if same_venue else 0)
        )
        score = evidence + (0.25 if evidence > 0 and nearby_year else 0)
        if score <= 0:
            continue
        related.append(
            {
                "docId": candidate["id"],
                "title": candidate.get("title") or candidate.get("fileName"),
                "authors": candidate.get("authors") or "",
                "year": candidate.get("year") or "",
                "venue": candidate.get("venue") or "",
                "inWorkspace": candidate["id"] in workspace_doc_ids,
                "score": round(score, 2),
                "reasons": {
                    "sharedKeywords": shared_keywords,
                    "sharedAuthors": shared_authors,
                    "sharedTitleTerms": shared_title[:8],
                    "sharedAbstractTerms": shared_abstract[:8],
                    "sameVenue": same_venue,
                    "nearbyYear": nearby_year,
                },
            }
        )
    related.sort(key=lambda item: (-item["score"], _comparable(item["title"])))
    return {"seedDocId": seed_id, "results": related[: max(1, min(20, int(limit)))]}
