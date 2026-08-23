from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Mapping
from html import unescape
from typing import Any
from urllib.parse import quote

import httpx

from refora_server.academic.arxiv import (
    ArxivSearchInput,
    base_arxiv_id,
    normalize_arxiv_id,
)
from refora_server.library.metadata import (
    deriveDoiFromArxivId,
    extractAbstractFromText,
    extractAffiliationsFromText,
    extractArxivFromText,
    extractArxivFromFileName,
    extractAuthorsFromText,
    extractDoiFromInfo,
    extractDoiFromText,
    extractMetadataFromPdf,
    extractTitleFromText,
    extractVenueFromText,
    isReliableTitle,
    isTemplateNoiseTitle,
    normalizeAuthors,
    titleFromFileName,
)
from refora_server.repositories.errors import RepoError
from refora_server.services.export import normalizeVenue

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
_TITLE_SIMILARITY_THRESHOLD = 0.6
_TITLE_USE_THRESHOLD = 0.75
_PDF_PARSE_TIMEOUT_SECONDS = 60


def _value(target: Any, name: str, default: Any = None) -> Any:
    if isinstance(target, Mapping):
        return target.get(name, default)
    return getattr(target, name, default)


def _clean(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"\s+", " ", unescape(value)).strip()
    return normalized or None


def _clean_affiliation(value: Any) -> str | None:
    cleaned = _clean(value)
    if cleaned is None:
        return None
    return re.sub(r",(?=\S)", ", ", cleaned)


def _title_candidate_is_in_head(candidate: str, text: str) -> bool:
    candidate_key = re.sub(r"[\W_]+", "", candidate, flags=re.UNICODE).casefold()
    head = " ".join(
        line.strip()
        for line in text.splitlines()[:12]
        if line.strip()
    )
    head_key = re.sub(r"[\W_]+", "", head, flags=re.UNICODE).casefold()
    return bool(candidate_key and candidate_key in head_key)


def _titles_match(left: str | None, right: str | None) -> bool:
    return _title_similarity(left, right) >= _TITLE_SIMILARITY_THRESHOLD


def _title_similarity(left: str | None, right: str | None) -> float:
    normalized_left = re.sub(r"[^a-z0-9]+", " ", (left or "").lower()).strip()
    normalized_right = re.sub(r"[^a-z0-9]+", " ", (right or "").lower()).strip()
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left == normalized_right:
        return 1.0
    left_words = normalized_left.split()
    right_words = normalized_right.split()
    if not left_words or not right_words:
        return 0.0
    left_set = set(left_words)
    common = sum(1 for word in right_words if word in left_set)
    overlap = common / min(len(left_words), len(right_words))
    shorter, longer = sorted(
        (normalized_left, normalized_right), key=len
    )
    prefix_score = len(shorter) / len(longer) if longer.startswith(shorter) else 0.0
    length_penalty = (
        len(shorter) / (len(longer) * 0.5)
        if len(shorter) < len(longer) * 0.5
        else 1.0
    )
    return max(overlap, prefix_score) * length_penalty


def _normalize_doi(value: Any) -> str | None:
    cleaned = _clean(value)
    if cleaned is None:
        return None
    normalized = re.sub(
        r"^https?://(?:dx\.)?doi\.org/",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(r"^doi\s*:\s*", "", normalized, flags=re.IGNORECASE)
    return normalized.lower() or None


def _author_keys(value: Any) -> list[str]:
    cleaned = _clean(value)
    if cleaned is None:
        return []
    keys: list[str] = []
    for author in cleaned.split(";"):
        normalized = author.strip().lower()
        family = (
            normalized.split(",", 1)[0]
            if "," in normalized
            else normalized.split()[-1]
            if normalized.split()
            else ""
        )
        key = re.sub(r"[^a-z0-9]", "", family)
        if key:
            keys.append(key)
    return keys


def _authors_match(left: Any, right: Any) -> bool:
    left_keys = _author_keys(left)
    right_keys = _author_keys(right)
    if not left_keys or not right_keys:
        return False
    right_set = set(right_keys)
    overlap = sum(1 for author in left_keys if author in right_set)
    return overlap > 0 and (
        left_keys[0] == right_keys[0]
        or overlap / min(len(left_keys), len(right_keys)) >= 0.5
    )


def _paper_authors(paper: Mapping[str, Any]) -> str | None:
    authors = paper.get("authors")
    if isinstance(authors, list):
        values = [
            value
            for item in authors
            for value in [
                _clean(item.get("name"))
                if isinstance(item, Mapping)
                else _clean(item)
            ]
            if value
        ]
        return "; ".join(values) or None
    return _clean(authors)


def _paper_year(paper: Mapping[str, Any]) -> str | None:
    year = paper.get("year")
    if isinstance(year, int):
        return str(year)
    cleaned = _clean(year)
    if cleaned:
        return cleaned[:4]
    publication_date = _clean(
        paper.get("publicationDate") or paper.get("publishedAt")
    )
    return publication_date[:4] if publication_date else None


def _is_arxiv_candidate_verified(
    reference: Mapping[str, Any],
    candidate: Mapping[str, Any],
    direct_id_evidence: bool = False,
) -> bool:
    candidate_arxiv_id = _clean(candidate.get("arxivId"))
    if candidate_arxiv_id is None:
        return False
    reference_doi = _normalize_doi(reference.get("doi"))
    candidate_doi = _normalize_doi(candidate.get("doi"))
    canonical_arxiv_doi = _normalize_doi(deriveDoiFromArxivId(candidate_arxiv_id))
    reference_is_arxiv_doi = bool(
        reference_doi and reference_doi.startswith("10.48550/arxiv.")
    )
    if reference_is_arxiv_doi and reference_doi != canonical_arxiv_doi:
        return False
    if (
        reference_doi is not None
        and candidate_doi is not None
        and reference_doi != canonical_arxiv_doi
        and reference_doi != candidate_doi
    ):
        return False
    doi_match = reference_doi is not None and reference_doi in {
        candidate_doi,
        canonical_arxiv_doi,
    }
    title = _clean(reference.get("title"))
    title_score = _title_similarity(title, _clean(candidate.get("title")))
    if doi_match:
        return title is None or title_score >= _TITLE_SIMILARITY_THRESHOLD
    if title_score < _TITLE_USE_THRESHOLD:
        return False
    if direct_id_evidence:
        return True
    return bool(
        reference.get("year")
        and _paper_year(candidate)
        and str(reference["year"]) == _paper_year(candidate)
    ) or _authors_match(reference.get("authors"), _paper_authors(candidate))


def _is_network_error(error: BaseException) -> bool:
    if isinstance(error, httpx.HTTPError):
        return True
    return getattr(error, "code", None) in {
        "arxiv_unreachable",
        "arxiv_rate_limited",
        "semantic_scholar_unreachable",
        "semantic_scholar_rate_limited",
    }


class _RateGate:
    def __init__(self, spacing_seconds: float) -> None:
        self.spacing_seconds = spacing_seconds
        self.last_request_at: float | None = None
        self.lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self.lock:
            now = time.monotonic()
            if self.last_request_at is not None:
                remaining = self.spacing_seconds - (now - self.last_request_at)
                if remaining > 0:
                    await asyncio.sleep(remaining)
            self.last_request_at = time.monotonic()


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
            else:
                name = _clean(author.get("name"))
                if name:
                    mapped_authors.append(name)
    author_items = authors if isinstance(authors, list) else []
    affiliations = {
        value
        for author in author_items
        if isinstance(author, Mapping)
        for raw_affiliation in (
            author.get("affiliation")
            if isinstance(author.get("affiliation"), list)
            else []
        )
        for value in [
            _clean_affiliation(raw_affiliation.get("name"))
            if isinstance(raw_affiliation, Mapping)
            else None
        ]
        if value
    }
    subjects = message.get("subject")
    keywords = (
        ", ".join(
            value
            for item in subjects
            for value in [_clean(item)]
            if value
        )
        if isinstance(subjects, list)
        else None
    )
    venue = _clean(containers[0]) if isinstance(containers, list) and containers else None
    result = {
        "title": _clean(titles[0]) if isinstance(titles, list) and titles else None,
        "authors": normalizeAuthors("; ".join(mapped_authors)) if mapped_authors else None,
        "year": _crossref_year(message),
        "venue": normalizeVenue(venue) if venue else None,
        "volume": _clean(message.get("volume")),
        "issue": _clean(message.get("issue")),
        "pages": _clean(message.get("page")),
        "abstract": _clean(message.get("abstract")),
        "keywords": keywords,
        "url": _clean(message.get("URL")),
        "doi": _clean(message.get("DOI")),
        "affiliations": "; ".join(sorted(affiliations)) or None,
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
    background_tasks: set[asyncio.Task[Any]] = set()
    scheduled_ids: set[str] = set()
    semaphore = asyncio.Semaphore(3)
    crossref_gate = _RateGate(1)
    dblp_gate = _RateGate(1)
    destroyed = False

    async def broadcast(document: Mapping[str, Any]) -> None:
        value = emit("document.updated", dict(document))
        if asyncio.iscoroutine(value):
            await value

    async def arxiv_paper(arxiv_id: str) -> dict[str, Any] | None:
        arxiv = _value(academic, "arxiv", {})
        get_by_id = _value(arxiv, "getById")
        if callable(get_by_id):
            result = get_by_id(arxiv_id)
            if asyncio.iscoroutine(result):
                result = await result
            return dict(result) if isinstance(result, Mapping) else None
        search = _value(arxiv, "search")
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

    async def arxiv_title_candidates(title: str) -> list[dict[str, Any]]:
        arxiv = _value(academic, "arxiv", {})
        search_title = _value(arxiv, "searchTitle")
        if callable(search_title):
            result = search_title(title, 5)
        else:
            search = _value(arxiv, "search")
            if not callable(search):
                return []
            result = search(ArxivSearchInput(query=title, pageSize=5))
        if asyncio.iscoroutine(result):
            result = await result
        papers = result.get("papers") if isinstance(result, Mapping) else None
        if not isinstance(papers, list):
            return []
        candidates = [
            dict(paper)
            for paper in papers
            if isinstance(paper, Mapping)
            and _title_similarity(title, _clean(paper.get("title")))
            >= _TITLE_SIMILARITY_THRESHOLD
        ]
        return sorted(
            candidates,
            key=lambda paper: _title_similarity(title, _clean(paper.get("title"))),
            reverse=True,
        )

    def request_options() -> tuple[dict[str, str], dict[str, Any]]:
        settings = repos["settings"]
        mailto = settings.get("crossrefMailto", "")
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

    async def crossref_record(
        doi: str,
    ) -> tuple[dict[str, str], str | None]:
        await crossref_gate.wait()
        headers, options = request_options()
        async with httpx.AsyncClient(
            **options,
        ) as client:
            response = await client.get(
                f"https://api.crossref.org/works/{quote(doi, safe='')}",
                headers=headers,
            )
        if response.status_code != 200:
            return {}, None
        payload = response.json()
        message = payload.get("message") if isinstance(payload, Mapping) else None
        if not isinstance(message, Mapping):
            return {}, None
        links = message.get("link")
        link_items = links if isinstance(links, list) else []
        pdf_url = next(
            (
                value
                for item in link_items
                if isinstance(item, Mapping)
                and item.get("content-type") == "application/pdf"
                for value in [_clean(item.get("URL"))]
                if value
            ),
            None,
        )
        return _crossref_fields(message), pdf_url

    async def crossref(doi: str) -> dict[str, str]:
        fields, _pdf_url = await crossref_record(doi)
        return fields

    async def crossref_by_title(title: str) -> dict[str, str]:
        await crossref_gate.wait()
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
        return (
            best[1]
            if best is not None and best[0] >= _TITLE_USE_THRESHOLD
            else {}
        )

    async def dblp_by_title(title: str) -> dict[str, str]:
        await dblp_gate.wait()
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
        if best is None or best[0] < _TITLE_USE_THRESHOLD:
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
            "venue": (
                normalizeVenue(value)
                if (value := _clean(info.get("venue")))
                else None
            ),
            "volume": _clean(info.get("volume")),
            "pages": _clean(info.get("pages")),
            "doi": doi,
            "url": url,
        }
        return {key: value for key, value in fields.items() if value is not None}

    def arxiv_fields(
        paper: Mapping[str, Any],
        include_identity: bool = True,
    ) -> dict[str, str]:
        arxiv_id = _clean(paper.get("arxivId"))
        result = {
            "title": _clean(paper.get("title")),
            "authors": normalizeAuthors(_paper_authors(paper)),
            "year": _paper_year(paper),
            "abstract": _clean(paper.get("abstract")),
            "url": _clean(paper.get("url")),
            "doi": (
                _clean(paper.get("doi"))
                or deriveDoiFromArxivId(arxiv_id)
                if include_identity and arxiv_id
                else None
            ),
            "arxivId": arxiv_id if include_identity else None,
        }
        return {key: value for key, value in result.items() if value is not None}

    async def find_verified_arxiv_metadata(
        reference: Mapping[str, Any],
    ) -> dict[str, str] | None:
        title = _clean(reference.get("title"))
        if title is None:
            return None
        candidates = await arxiv_title_candidates(title)
        paper = next(
            (
                candidate
                for candidate in candidates
                if _is_arxiv_candidate_verified(reference, candidate)
            ),
            None,
        )
        if paper is None:
            return None
        result = arxiv_fields(paper)
        if not result.get("doi"):
            doi = _clean(reference.get("doi"))
            if doi:
                result["doi"] = doi
        return result

    async def fetch_doi_metadata(doi: str) -> dict[str, Any] | None:
        fields, pdf_url = await crossref_record(doi)
        if not fields:
            return None
        fields["metadataSource"] = "crossref"
        try:
            arxiv = await find_verified_arxiv_metadata(fields)
            if arxiv and arxiv.get("arxivId"):
                fields["arxivId"] = arxiv["arxivId"]
        except BaseException as error:
            if not _is_network_error(error):
                raise
        if pdf_url:
            fields["pdfUrl"] = pdf_url
        return fields

    async def supplement_venue_fields(
        fetched: dict[str, str],
        search_title: str | None,
        text: str,
        field_sources: dict[str, str],
    ) -> None:
        has_venue = _clean(fetched.get("venue")) is not None
        has_volume = _clean(fetched.get("volume")) is not None
        has_year = _clean(fetched.get("year")) is not None
        has_doi = _clean(fetched.get("doi")) is not None
        has_issue = _clean(fetched.get("issue")) is not None
        has_pages = _clean(fetched.get("pages")) is not None
        if has_venue and has_volume and has_year and has_doi:
            return
        if not has_venue:
            banner = extractVenueFromText(text)
            if isinstance(banner, Mapping):
                venue = _clean(banner.get("venue"))
                year = _clean(banner.get("year"))
                if venue:
                    fetched["venue"] = venue
                    field_sources["venue"] = "pdf"
                if year and not has_year:
                    fetched["year"] = year
                    field_sources["year"] = "pdf"
                return
        if search_title is None:
            return
        result = await crossref_by_title(search_title)
        if not result:
            return
        if not has_venue and result.get("venue"):
            fetched["venue"] = result["venue"]
            field_sources["venue"] = "crossref"
            if result.get("year"):
                fetched["year"] = result["year"]
                field_sources["year"] = "crossref"
        for key, missing in (
            ("volume", not has_volume),
            ("issue", not has_issue),
            ("pages", not has_pages),
            ("doi", not has_doi),
        ):
            if missing and result.get(key):
                fetched[key] = result[key]
                field_sources[key] = "crossref"
        for key in ("abstract", "keywords", "affiliations"):
            if not fetched.get(key) and result.get(key):
                fetched[key] = result[key]
                field_sources[key] = "crossref"

    def start_background(operation: Any) -> None:
        task = asyncio.create_task(operation)
        background_tasks.add(task)

        def finish(completed: asyncio.Task[Any]) -> None:
            background_tasks.discard(completed)
            try:
                completed.result()
            except BaseException:
                pass

        task.add_done_callback(finish)

    async def enrich_verified_arxiv_id(
        document_id: str,
        reference: Mapping[str, Any],
    ) -> None:
        result = await find_verified_arxiv_metadata(reference)
        if not result or not result.get("arxivId") or destroyed:
            return
        current = documents["get"](document_id)
        if current is None or current.get("arxivId"):
            return
        remote_values = {
            **(current.get("remoteValues") or {}),
            "arxivId": {
                "value": result["arxivId"],
                "source": "arxiv",
            },
        }
        fields = {}
        if not (
            "arxivId" in set(current.get("editedFields") or [])
            and current.get("arxivId") not in (None, "")
        ):
            fields["arxivId"] = result["arxivId"]
        updated = documents["applyMetadataFields"](
            document_id,
            fields,
            remote_values,
            current["metadataStatus"],
            None,
        )
        await broadcast(updated)

    async def process(document_id: str) -> dict[str, Any]:
        async with semaphore:
            document = documents["get"](document_id)
            if document is None:
                raise RepoError("not_found", f"document not found: {document_id}")
            try:
                parsed = await asyncio.wait_for(
                    asyncio.to_thread(
                        extractMetadataFromPdf, document["filePath"], 5
                    ),
                    timeout=_PDF_PARSE_TIMEOUT_SECONDS,
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
                info_title = _clean(
                    info.get("/Title")
                    or info.get("Title")
                    or info.get("title")
                )
                if info_title and isTemplateNoiseTitle(info_title):
                    info_title = None
                title_candidate = _clean(parsed.get("titleCandidate"))
                if (
                    not title_candidate
                    or not isReliableTitle(title_candidate, text)
                    or not _title_candidate_is_in_head(title_candidate, text)
                ):
                    title_candidate = None
                text_title = (
                    info_title
                    or title_candidate
                    or extractTitleFromText(text)
                )
                file_name_title = titleFromFileName(document["fileName"])
                reliable_title = isReliableTitle(text_title, text)
                search_title = text_title if reliable_title else None
                fallback_title = (
                    text_title or file_name_title
                    if reliable_title
                    else file_name_title or text_title
                )
                doi = extractDoiFromInfo(dict(info)) or extractDoiFromText(text)
                arxiv_id = (
                    extractArxivFromText(text)
                    or extractArxivFromFileName(document["fileName"])
                )
                derived_doi = (
                    deriveDoiFromArxivId(arxiv_id)
                    if arxiv_id and not doi
                    else None
                )
                info_authors = _clean(
                    info.get("/Author")
                    or info.get("Author")
                    or info.get("author")
                ) or extractAuthorsFromText(text, text_title)
                fetched: dict[str, str] | None = None
                field_sources: dict[str, str] = {}
                source = "pdf"
                network_failed = False

                if doi:
                    try:
                        fetched = await crossref(doi)
                    except (httpx.HTTPError, ValueError):
                        network_failed = True
                    if fetched:
                        source = "crossref"
                        field_sources.update(
                            {key: "crossref" for key in fetched}
                        )

                if arxiv_id:
                    paper = None
                    try:
                        paper = await arxiv_paper(arxiv_id)
                    except BaseException as error:
                        if _is_network_error(error):
                            network_failed = True
                        else:
                            raise
                    reference = {
                        "title": text_title
                        or (fetched or {}).get("title")
                        or document.get("title"),
                        "authors": (fetched or {}).get("authors")
                        or info_authors
                        or document.get("authors"),
                        "year": (fetched or {}).get("year")
                        or document.get("year"),
                        "doi": (fetched or {}).get("doi")
                        or doi
                        or document.get("doi"),
                    }
                    verified = bool(
                        paper
                        and isReliableTitle(_clean(paper.get("title")), text)
                        and _is_arxiv_candidate_verified(
                            reference,
                            paper,
                            True,
                        )
                    )
                    if paper and verified:
                        if fetched:
                            fetched["arxivId"] = str(paper["arxivId"])
                            field_sources["arxivId"] = "arxiv"
                        else:
                            fetched = arxiv_fields(paper)
                            source = "arxiv"
                            field_sources.update(
                                {key: "arxiv" for key in fetched}
                            )

                if not fetched and search_title:
                    try:
                        fetched = await dblp_by_title(search_title)
                    except (httpx.HTTPError, ValueError):
                        network_failed = True
                    if fetched:
                        source = "dblp"
                        field_sources.update({key: "dblp" for key in fetched})
                    if not fetched:
                        candidates: list[dict[str, Any]] = []
                        try:
                            candidates = await arxiv_title_candidates(search_title)
                        except BaseException as error:
                            if _is_network_error(error):
                                network_failed = True
                            else:
                                raise
                        reference = {
                            "title": search_title,
                            "authors": info_authors or document.get("authors"),
                            "year": document.get("year"),
                            "doi": document.get("doi"),
                        }
                        verified = next(
                            (
                                candidate
                                for candidate in candidates
                                if _is_arxiv_candidate_verified(
                                    reference, candidate
                                )
                            ),
                            None,
                        )
                        candidate = verified or (
                            candidates[0] if candidates else None
                        )
                        if (
                            candidate
                            and _title_similarity(
                                search_title,
                                _clean(candidate.get("title")),
                            )
                            >= _TITLE_USE_THRESHOLD
                        ):
                            fetched = arxiv_fields(
                                candidate,
                                include_identity=False,
                            )
                            if verified and verified.get("arxivId"):
                                fetched["arxivId"] = str(
                                    verified["arxivId"]
                                )
                            source = "arxiv"
                            field_sources.update(
                                {key: "arxiv" for key in fetched}
                            )

                if not fetched and network_failed:
                    raise RepoError(
                        "metadata_network_failed",
                        "Metadata providers are unavailable",
                    )

                if not fetched:
                    fetched = {}
                    final_title = fallback_title or file_name_title
                    if final_title:
                        fetched["title"] = final_title
                        field_sources["title"] = "pdf"
                    if info_authors:
                        fetched["authors"] = (
                            normalizeAuthors(info_authors) or info_authors
                        )
                        field_sources["authors"] = "pdf"
                    source = "pdf"

                try:
                    await supplement_venue_fields(
                        fetched,
                        search_title,
                        text,
                        field_sources,
                    )
                except (httpx.HTTPError, ValueError):
                    pass

                affiliations = extractAffiliationsFromText(text)
                if affiliations:
                    fetched_affiliations = _clean(fetched.get("affiliations"))
                    pdf_count = len(affiliations.split(";"))
                    fetched_count = (
                        len(fetched_affiliations.split(";"))
                        if fetched_affiliations
                        else 0
                    )
                    if not fetched_affiliations or pdf_count > fetched_count:
                        fetched["affiliations"] = affiliations
                        field_sources["affiliations"] = "pdf"
                if not fetched.get("abstract"):
                    abstract = extractAbstractFromText(text)
                    if abstract:
                        fetched["abstract"] = abstract
                        field_sources["abstract"] = "pdf"
                if not fetched.get("doi") and derived_doi:
                    fetched["doi"] = derived_doi
                    field_sources["doi"] = "arxiv"

                latest = documents["get"](document_id)
                if latest is None:
                    raise RepoError(
                        "not_found", f"document not found: {document_id}"
                    )
                edited = set(latest.get("editedFields") or [])
                fields: dict[str, str] = {}
                remote_values: dict[str, Any] = {}
                for key, value in fetched.items():
                    if (
                        key not in _EDITABLE_FIELDS
                        or not isinstance(value, str)
                        or not value.strip()
                    ):
                        continue
                    remote_values[key] = {
                        "value": value,
                        "source": field_sources.get(key, source),
                    }
                    if (
                        key in edited
                        and latest.get(key) not in (None, "")
                    ):
                        continue
                    fields[key] = value
                updated = documents["applyMetadataFields"](
                    document_id,
                    fields,
                    remote_values or None,
                    "done",
                    source,
                )
                await broadcast(updated)
                if (
                    not arxiv_id
                    and fetched.get("title")
                    and fetched.get("doi")
                ):
                    start_background(
                        enrich_verified_arxiv_id(document_id, fetched)
                    )
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

    def bulk_refresh(document_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(document_ids))

        def prepare() -> None:
            for document_id in unique_ids:
                if documents["get"](document_id) is None:
                    raise RepoError(
                        "not_found", f"document not found: {document_id}"
                    )
            for document_id in unique_ids:
                documents["setMetadataStatus"](document_id, "pending")

        transaction = repos.get("transaction")
        if callable(transaction):
            transaction(prepare)
        else:
            prepare()
        for document_id in unique_ids:
            enqueue(document_id)

    async def verify_arxiv_id(
        document_id: str, value: str
    ) -> str:
        document = documents["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"document not found: {document_id}")
        if not value.strip():
            return ""
        normalized = normalize_arxiv_id(value)
        if normalized is None:
            raise RepoError("invalid_arxiv_id", "Invalid arXiv ID format", "arxivId")
        if document.get("arxivId") == normalized:
            return normalized
        try:
            paper = await arxiv_paper(normalized)
        except BaseException as error:
            if _is_network_error(error):
                raise RepoError(
                    "arxiv_unreachable",
                    "Could not reach arXiv to verify this ID",
                    "arxivId",
                ) from error
            raise
        if paper is None:
            raise RepoError(
                "invalid_arxiv_id",
                "arXiv did not return a matching record",
                "arxivId",
            )
        url_arxiv_id = (
            normalize_arxiv_id(document["url"])
            if isinstance(document.get("url"), str)
            else None
        )
        if not _is_arxiv_candidate_verified(
            document,
            paper,
            url_arxiv_id == normalized,
        ):
            raise RepoError(
                "arxiv_metadata_mismatch",
                "The arXiv record does not match this paper metadata",
                "arxivId",
            )
        return normalized

    async def update_verified_arxiv_id(
        document_id: str, value: str
    ) -> dict[str, Any]:
        before = documents["get"](document_id)
        normalized = await verify_arxiv_id(document_id, value)
        if normalized and before is not None and before.get("arxivId") == normalized:
            return before
        updated = documents["update"](document_id, {"arxivId": normalized})
        await broadcast(updated)
        return updated

    def resume_on_startup() -> None:
        for row in documents["getResumableMetadataRows"]():
            enqueue(row["id"])

    async def destroy() -> None:
        nonlocal destroyed
        destroyed = True
        pending = tuple(tasks | background_tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    return {
        "enqueue": enqueue,
        "refresh": refresh,
        "refreshMetadata": refresh,
        "bulkRefreshMetadata": bulk_refresh,
        "verifyArxivId": verify_arxiv_id,
        "updateVerifiedArxivId": update_verified_arxiv_id,
        "fetchDoiMetadata": fetch_doi_metadata,
        "findVerifiedArxivMetadata": find_verified_arxiv_metadata,
        "resumeOnStartup": resume_on_startup,
        "destroy": destroy,
    }
