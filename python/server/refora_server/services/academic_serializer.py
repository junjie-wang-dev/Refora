from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def _first_value(source: Any, *names: str) -> Any:
    for name in names:
        value = _value(source, name)
        if value is not None:
            return value
    return None


def _text(value: Any, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def _optional_text(value: Any) -> str | None:
    text = _text(value)
    return text or None


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _year(value: Any, publication_date: str | None) -> int | None:
    year = _integer(value)
    if year is not None:
        return year
    if publication_date and len(publication_date) >= 4:
        return _integer(publication_date[:4])
    return None


def _list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple)) else []


def _authors(value: Any) -> list[str]:
    if isinstance(value, str):
        return [author.strip() for author in value.split(";") if author.strip()]
    authors: list[str] = []
    for author in _list(value):
        name = _text(_value(author, "name", author) if not isinstance(author, str) else author)
        if name:
            authors.append(name)
    return authors


def _external_id(source: Any, *names: str) -> str | None:
    value = _first_value(source, *names)
    return _optional_text(value)


def serialize_paper(source: Any, provider: str) -> dict[str, Any]:
    external_ids = _value(source, "externalIds", {})
    if not isinstance(external_ids, Mapping):
        external_ids = {}
    publication_date = _optional_text(_first_value(source, "publicationDate", "publishedAt", "published"))
    arxiv_id = _external_id(source, "arxivId", "arxiv_id") or _optional_text(
        _first_value(external_ids, "ArXiv", "ARXIV", "arXiv")
    )
    doi = _external_id(source, "doi", "DOI") or _optional_text(_value(external_ids, "DOI"))
    paper_id = _external_id(source, "semanticScholarPaperId", "paperId")
    corpus_id = _integer(_first_value(source, "semanticScholarCorpusId", "corpusId"))

    return {
        "source": provider,
        "title": _text(_value(source, "title")),
        "authors": _authors(_value(source, "authors")),
        "abstract": _text(_value(source, "abstract")),
        "year": _year(_value(source, "year"), publication_date),
        "publicationDate": publication_date,
        "updatedAt": _optional_text(_value(source, "updatedAt")),
        "categories": [_text(category) for category in _list(_value(source, "categories")) if _text(category)],
        "venue": _optional_text(_value(source, "venue")),
        "citationCount": _integer(_value(source, "citationCount")),
        "referenceCount": _integer(_value(source, "referenceCount")),
        "arxivId": arxiv_id,
        "doi": doi,
        "semanticScholarPaperId": paper_id,
        "semanticScholarCorpusId": corpus_id,
        "url": _optional_text(_first_value(source, "url", "absUrl", "sourceUrl")),
        "htmlUrl": _optional_text(_value(source, "htmlUrl")),
        "pdfUrl": _optional_text(_value(source, "pdfUrl")),
    }


def serialize_arxiv_search_response(response: Any) -> dict[str, Any]:
    papers = _list(_first_value(response, "papers", "entries"))
    serialized_papers = [serialize_paper(paper, "arxiv") for paper in papers if isinstance(paper, Mapping) or hasattr(paper, "title")]
    total = _integer(_value(response, "total"))
    return {
        "source": "arxiv",
        "papers": serialized_papers,
        "total": total if total is not None and total >= 0 else len(serialized_papers),
        "nextCursor": _optional_text(_value(response, "nextCursor")),
        "fetchedAt": _optional_text(_value(response, "fetchedAt")),
        "cached": _value(response, "cached") is True,
    }


def serialize_semantic_recommendations_response(response: Any) -> dict[str, Any]:
    papers = _list(_first_value(response, "items", "recommendedPapers", "papers"))
    return {
        "source": "semantic_scholar",
        "seed": serialize_paper(_value(response, "seed", {}), "semantic_scholar"),
        "papers": [serialize_paper(paper, "semantic_scholar") for paper in papers if isinstance(paper, Mapping) or hasattr(paper, "title")],
        "fetchedAt": _optional_text(_value(response, "fetchedAt")),
        "cached": _value(response, "cached") is True,
    }


def serialize_paper_fulltext_response(response: Any) -> dict[str, Any]:
    content = _text(_first_value(response, "text", "contentMd", "content"))
    offset = _integer(_first_value(response, "offset", "cursor"))
    limit = _integer(_first_value(response, "limit", "maxChars"))
    total_chars = _integer(_value(response, "totalChars"))
    next_offset = _integer(_value(response, "nextOffset"))
    return {
        "source": _optional_text(_value(response, "source")) or "local",
        "title": _text(_value(response, "title")),
        "content": content,
        "offset": offset if offset is not None and offset >= 0 else 0,
        "limit": limit if limit is not None and limit >= 0 else 0,
        "totalChars": total_chars if total_chars is not None and total_chars >= 0 else len(content),
        "nextOffset": next_offset if next_offset is not None and next_offset >= 0 else None,
        "nextCursor": _optional_text(_value(response, "nextCursor")),
    }


def serialize_search_arxiv(response: Any) -> dict[str, Any]:
    return serialize_arxiv_search_response(response)


def serialize_get_semantic_recommendations(response: Any) -> dict[str, Any]:
    return serialize_semantic_recommendations_response(response)


def serialize_read_paper_fulltext(response: Any) -> dict[str, Any]:
    return serialize_paper_fulltext_response(response)
