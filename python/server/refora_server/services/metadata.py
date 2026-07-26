from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

import httpx

from refora_server.academic.arxiv import ArxivSearchInput, base_arxiv_id, normalize_arxiv_id
from refora_server.library.metadata import (
    deriveDoiFromArxivId,
    extractAbstractFromText,
    extractAffiliationsFromText,
    extractArxivFromText,
    extractDoiFromInfo,
    extractDoiFromText,
    extractMetadataFromPdf,
    extractTitleFromText,
    extractVenueFromText,
    isReliableTitle,
    normalizeAuthors,
    titleFromFileName,
)
from refora_server.repositories.errors import RepoError

_EDITABLE_FIELDS = (
    "title",
    "authors",
    "year",
    "venue",
    "volume",
    "issue",
    "pages",
    "abstract",
    "keywords",
    "url",
    "doi",
    "arxivId",
    "note",
    "affiliations",
)


def _value(target: Any, name: str, default: Any = None) -> Any:
    if isinstance(target, Mapping):
        return target.get(name, default)
    return getattr(target, name, default)


def _clean(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"\s+", " ", value).strip()
    return normalized or None


def _title_words(value: str | None) -> set[str]:
    if not value:
        return set()
    return {
        word
        for word in re.sub(r"[^a-z0-9]+", " ", value.lower()).split()
        if len(word) > 1
    }


def _titles_match(left: str | None, right: str | None) -> bool:
    return _title_similarity(left, right) >= 0.75


def _title_similarity(left: str | None, right: str | None) -> float:
    a = _title_words(left)
    b = _title_words(right)
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def _crossref_year(message: Mapping[str, Any]) -> str | None:
    for key in ("published-print", "published-online", "issued"):
        value = message.get(key)
        parts = value.get("date-parts") if isinstance(value, Mapping) else None
        if (
            isinstance(parts, list)
            and parts
            and isinstance(parts[0], list)
            and parts[0]
            and isinstance(parts[0][0], int)
        ):
            return str(parts[0][0])
    return None


def _crossref_fields(message: Mapping[str, Any]) -> dict[str, str]:
    titles = message.get("title")
    containers = message.get("container-title")
    authors = message.get("author")
    mapped_authors: list[str] = []
    if isinstance(authors, list):
        for author in authors:
            if not isinstance(author, Mapping):
                continue
            family = _clean(author.get("family"))
            given = _clean(author.get("given"))
            if family and given:
                mapped_authors.append(f"{family}, {given}")
            elif family:
                mapped_authors.append(family)
    result = {
        "title": _clean(titles[0]) if isinstance(titles, list) and titles else None,
        "authors": "; ".join(mapped_authors) or None,
        "year": _crossref_year(message),
        "venue": _clean(containers[0]) if isinstance(containers, list) and containers else None,
        "volume": _clean(message.get("volume")),
        "issue": _clean(message.get("issue")),
        "pages": _clean(message.get("page")),
        "abstract": _clean(message.get("abstract")),
        "url": _clean(message.get("URL")),
        "doi": _clean(message.get("DOI")),
    }
    return {key: value for key, value in result.items() if value is not None}


def create_metadata_service(
    repos: Mapping[str, Any],
    *,
    academic: Mapping[str, Any],
    emit: Any,
    proxy: Any = None,
) -> dict[str, Any]:
    documents = repos["documents"]
    tasks: set[asyncio.Task[Any]] = set()
    scheduled_ids: set[str] = set()
    semaphore = asyncio.Semaphore(3)
    destroyed = False

    async def broadcast(document: Mapping[str, Any]) -> None:
        value = emit("document.updated", dict(document))
        if asyncio.iscoroutine(value):
            await value

    async def arxiv_paper(arxiv_id: str) -> dict[str, Any] | None:
        search = _value(_value(academic, "arxiv", {}), "search")
        if not callable(search):
            return None
        result = search(ArxivSearchInput(query=arxiv_id, pageSize=20))
        if asyncio.iscoroutine(result):
            result = await result
        papers = result.get("papers") if isinstance(result, Mapping) else None
        target = base_arxiv_id(arxiv_id).lower()
        if not isinstance(papers, list):
            return None
        for paper in papers:
            candidate = paper.get("arxivId") if isinstance(paper, Mapping) else None
            if isinstance(candidate, str) and base_arxiv_id(candidate).lower() == target:
                return dict(paper)
        return None

    def request_options() -> tuple[dict[str, str], dict[str, Any]]:
        settings = repos["settings"]
        raw_mailto = settings.get("crossrefMailto", '""')
        try:
            import json

            mailto = json.loads(raw_mailto) if isinstance(raw_mailto, str) else ""
        except (TypeError, ValueError):
            mailto = ""
        headers = {
            "User-Agent": (
                f"Refora/0.1 (mailto:{mailto})"
                if isinstance(mailto, str) and mailto
                else "Refora/0.1 (mailto:support@refora.app)"
            )
        }
        proxy_url = proxy() if callable(proxy) else None
        options = {
            "timeout": 8,
            "follow_redirects": True,
            **({"proxy": proxy_url} if proxy_url else {}),
        }
        return headers, options

    async def crossref(doi: str) -> dict[str, str]:
        headers, options = request_options()
        async with httpx.AsyncClient(
            **options,
        ) as client:
            response = await client.get(
                f"https://api.crossref.org/works/{quote(doi, safe='')}",
                headers=headers,
            )
        if response.status_code != 200:
            return {}
        payload = response.json()
        message = payload.get("message") if isinstance(payload, Mapping) else None
        return _crossref_fields(message) if isinstance(message, Mapping) else {}

    async def crossref_by_title(title: str) -> dict[str, str]:
        headers, options = request_options()
        async with httpx.AsyncClient(**options) as client:
            response = await client.get(
                "https://api.crossref.org/works",
                params={
                    "query.title": title,
                    "rows": "3",
                    "select": (
                        "title,author,container-title,volume,issue,page,"
                        "published-print,published-online,subject,URL,DOI,abstract"
                    ),
                },
                headers=headers,
            )
        if response.status_code != 200:
            return {}
        payload = response.json()
        message = payload.get("message") if isinstance(payload, Mapping) else None
        items = message.get("items") if isinstance(message, Mapping) else None
        if not isinstance(items, list):
            return {}
        best: tuple[float, dict[str, str]] | None = None
        for item in items:
            if not isinstance(item, Mapping):
                continue
            fields = _crossref_fields(item)
            score = _title_similarity(title, fields.get("title"))
            if best is None or score > best[0]:
                best = (score, fields)
        return best[1] if best is not None and best[0] >= 0.75 else {}

    async def dblp_by_title(title: str) -> dict[str, str]:
        headers, options = request_options()
        async with httpx.AsyncClient(**options) as client:
            response = await client.get(
                "https://dblp.org/search/publ/api",
                params={"q": title, "format": "json", "h": "3"},
                headers=headers,
            )
        if response.status_code != 200:
            return {}
        payload = response.json()
        result = payload.get("result") if isinstance(payload, Mapping) else None
        hits = result.get("hits") if isinstance(result, Mapping) else None
        raw_items = hits.get("hit") if isinstance(hits, Mapping) else None
        items = raw_items if isinstance(raw_items, list) else []
        best: tuple[float, Mapping[str, Any]] | None = None
        for item in items:
            info = item.get("info") if isinstance(item, Mapping) else None
            if not isinstance(info, Mapping):
                continue
            candidate_title = _clean(info.get("title"))
            score = _title_similarity(title, candidate_title)
            if best is None or score > best[0]:
                best = (score, info)
        if best is None or best[0] < 0.75:
            return {}
        info = best[1]
        authors_block = info.get("authors")
        raw_authors = (
            authors_block.get("author")
            if isinstance(authors_block, Mapping)
            else None
        )
        author_items = raw_authors if isinstance(raw_authors, list) else [raw_authors]
        authors = [
            value
            for item in author_items
            if item is not None
            for value in [
                _clean(item.get("text"))
                if isinstance(item, Mapping)
                else _clean(item)
            ]
            if value
        ]
        doi = _clean(info.get("doi"))
        url = _clean(info.get("ee")) or (
            f"https://doi.org/{doi}" if doi else None
        )
        fields = {
            "title": _clean(info.get("title")),
            "authors": normalizeAuthors("; ".join(authors)) if authors else None,
            "year": _clean(info.get("year")),
            "venue": _clean(info.get("venue")),
            "volume": _clean(info.get("volume")),
            "pages": _clean(info.get("pages")),
            "doi": doi,
            "url": url,
        }
        return {key: value for key, value in fields.items() if value is not None}

    def arxiv_fields(paper: Mapping[str, Any]) -> dict[str, str]:
        authors = paper.get("authors")
        publication_date = paper.get("publicationDate")
        result = {
            "title": _clean(paper.get("title")),
            "authors": (
                normalizeAuthors("; ".join(value for value in authors if isinstance(value, str)))
                if isinstance(authors, list)
                else None
            ),
            "year": (
                publication_date[:4]
                if isinstance(publication_date, str) and len(publication_date) >= 4
                else None
            ),
            "abstract": _clean(paper.get("abstract")),
            "url": _clean(paper.get("url")),
            "doi": _clean(paper.get("doi")),
            "arxivId": _clean(paper.get("arxivId")),
        }
        return {key: value for key, value in result.items() if value is not None}

    async def arxiv_by_title(title: str) -> dict[str, str]:
        search = _value(_value(academic, "arxiv", {}), "search")
        if not callable(search):
            return {}
        result = search(ArxivSearchInput(query=title, pageSize=5))
        if asyncio.iscoroutine(result):
            result = await result
        papers = result.get("papers") if isinstance(result, Mapping) else None
        if not isinstance(papers, list):
            return {}
        best: tuple[float, Mapping[str, Any]] | None = None
        for paper in papers:
            if not isinstance(paper, Mapping):
                continue
            score = _title_similarity(title, _clean(paper.get("title")))
            if best is None or score > best[0]:
                best = (score, paper)
        return arxiv_fields(best[1]) if best is not None and best[0] >= 0.75 else {}

    async def process(document_id: str) -> dict[str, Any]:
        async with semaphore:
            document = documents["get"](document_id)
            if document is None:
                raise RepoError("not_found", f"document not found: {document_id}")
            try:
                parsed = await asyncio.to_thread(
                    extractMetadataFromPdf, document["filePath"], 5
                )
                if not isinstance(parsed, Mapping):
                    raise RepoError(
                        "metadata_parse_failed",
                        "PDF metadata parser returned an invalid result",
                    )
                parse_error = parsed.get("error")
                if isinstance(parse_error, Mapping):
                    message = _clean(parse_error.get("message"))
                    raise RepoError(
                        "metadata_parse_failed",
                        message or "PDF metadata extraction failed",
                    )
                info = parsed.get("info")
                text = parsed.get("text")
                if not isinstance(info, Mapping):
                    info = {}
                if not isinstance(text, str):
                    text = ""
                extracted_title = (
                    _clean(info.get("/Title") or info.get("Title"))
                    or _clean(parsed.get("titleCandidate"))
                    or extractTitleFromText(text)
                )
                search_title = (
                    extracted_title
                    if isReliableTitle(extracted_title, text)
                    else None
                )
                local_title = search_title or titleFromFileName(document["fileName"])
                local: dict[str, str] = {}
                if local_title:
                    local["title"] = local_title
                author = _clean(info.get("/Author") or info.get("Author"))
                if author:
                    local["authors"] = normalizeAuthors(author) or author
                abstract = extractAbstractFromText(text)
                affiliations = extractAffiliationsFromText(text)
                venue = extractVenueFromText(text)
                doi = extractDoiFromInfo(dict(info)) or extractDoiFromText(text)
                arxiv_id = extractArxivFromText(text)
                if abstract:
                    local["abstract"] = abstract
                if affiliations:
                    local["affiliations"] = affiliations
                if isinstance(venue, Mapping):
                    for key in ("venue", "year"):
                        value = _clean(venue.get(key))
                        if value:
                            local[key] = value
                if doi:
                    local["doi"] = doi
                if arxiv_id:
                    local["arxivId"] = arxiv_id
                    local.setdefault("doi", deriveDoiFromArxivId(arxiv_id))

                remote: dict[str, str] = {}
                source: str | None = None
                if arxiv_id:
                    paper = await arxiv_paper(arxiv_id)
                    if paper is not None and (
                        not document.get("title")
                        or _titles_match(
                            document.get("title") or local.get("title"),
                            _clean(paper.get("title")),
                        )
                    ):
                        remote = arxiv_fields(paper)
                        source = "arxiv"
                if not remote and doi:
                    try:
                        remote = await crossref(doi)
                    except (httpx.HTTPError, ValueError):
                        remote = {}
                    if remote:
                        source = "crossref"
                if not remote and search_title:
                    for candidate_source, operation in (
                        ("dblp", dblp_by_title),
                        ("arxiv", arxiv_by_title),
                        ("crossref", crossref_by_title),
                    ):
                        try:
                            remote = await operation(search_title)
                        except (httpx.HTTPError, ValueError):
                            remote = {}
                        if remote:
                            source = candidate_source
                            break

                merged = {**local, **remote}
                latest = documents["get"](document_id)
                if latest is None:
                    raise RepoError(
                        "not_found", f"document not found: {document_id}"
                    )
                edited = set(latest.get("editedFields") or [])
                fields: dict[str, str] = {}
                remote_values: dict[str, Any] = {}
                for key, value in merged.items():
                    if key not in _EDITABLE_FIELDS or not isinstance(value, str):
                        continue
                    if not value:
                        continue
                    field_source = source if key in remote else "pdf"
                    remote_values[key] = {
                        "value": value,
                        "source": field_source or "pdf",
                    }
                    current_value = latest.get(key)
                    if key in edited and current_value not in (None, ""):
                        continue
                    fields[key] = value
                updated = documents["applyMetadataFields"](
                    document_id,
                    fields,
                    remote_values or None,
                    "done",
                    source or ("pdf" if fields else None),
                )
                await broadcast(updated)
                return updated
            except Exception:
                documents["incrementMetadataAttempts"](document_id)
                documents["setMetadataStatus"](document_id, "failed")
                failed = documents["get"](document_id)
                if failed is not None:
                    await broadcast(failed)
                raise

    def enqueue(document_id: str) -> None:
        nonlocal destroyed
        if destroyed:
            return
        document = documents["get"](document_id)
        if (
            document is None
            or document.get("metadataStatus") == "done"
            or document_id in scheduled_ids
        ):
            return
        scheduled_ids.add(document_id)
        task = asyncio.create_task(process(document_id))
        tasks.add(task)

        def finish(completed: asyncio.Task[Any]) -> None:
            tasks.discard(completed)
            scheduled_ids.discard(document_id)
            try:
                completed.result()
            except BaseException:
                pass

        task.add_done_callback(finish)

    def refresh(document_id: str) -> dict[str, Any]:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"document not found: {document_id}")
        documents["setMetadataStatus"](document_id, "pending")
        enqueue(document_id)
        updated = documents["get"](document_id)
        assert updated is not None
        return updated

    async def update_verified_arxiv_id(
        document_id: str, value: str
    ) -> dict[str, Any]:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"document not found: {document_id}")
        if not value.strip():
            return documents["update"](document_id, {"arxivId": ""})
        normalized = normalize_arxiv_id(value)
        if normalized is None:
            raise RepoError("invalid_arxiv_id", "Invalid arXiv ID format", "arxivId")
        paper = await arxiv_paper(normalized)
        if paper is None:
            raise RepoError(
                "invalid_arxiv_id",
                "arXiv did not return a matching record",
                "arxivId",
            )
        if document.get("title") and not _titles_match(
            document.get("title"), _clean(paper.get("title"))
        ):
            raise RepoError(
                "arxiv_metadata_mismatch",
                "The arXiv record does not match this paper metadata",
                "arxivId",
            )
        updated = documents["update"](document_id, {"arxivId": normalized})
        await broadcast(updated)
        return updated

    def resume_on_startup() -> None:
        for row in documents["getResumableMetadataRows"]():
            enqueue(row["id"])

    async def destroy() -> None:
        nonlocal destroyed
        destroyed = True
        pending = tuple(tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    return {
        "enqueue": enqueue,
        "refresh": refresh,
        "updateVerifiedArxivId": update_verified_arxiv_id,
        "resumeOnStartup": resume_on_startup,
        "destroy": destroy,
    }
