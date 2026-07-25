from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional

from refora_server.academic.arxiv import AcademicFetch, FetchResponse, base_arxiv_id, normalize_arxiv_id
from refora_server.academic.cache import AcademicCache
from refora_server.academic.types import (
    AcademicAuthor,
    AcademicGraphCandidate,
    AcademicGraphCoverage,
    AcademicGraphPage,
    CitationEvidence,
    IdentityEvidence,
    PaperIdentity,
    PaperLocator,
    SemanticRecommendationResult,
)

API_BASE = "https://api.semanticscholar.org/graph/v1"
RECOMMENDATIONS_BASE = "https://api.semanticscholar.org/recommendations/v1"
PAPER_FIELDS = ",".join(
    [
        "paperId",
        "corpusId",
        "externalIds",
        "url",
        "title",
        "abstract",
        "venue",
        "year",
        "publicationDate",
        "authors",
        "citationCount",
        "referenceCount",
    ]
)
GRAPH_FIELDS = ",".join(
    [
        "contexts",
        "intents",
        "isInfluential",
        "paperId",
        "corpusId",
        "externalIds",
        "url",
        "title",
        "abstract",
        "venue",
        "year",
        "publicationDate",
        "authors",
        "citationCount",
        "referenceCount",
    ]
)
IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000
GRAPH_TTL_MS = 24 * 60 * 60 * 1000
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
S2_MIN_SPACING_MS = 1000
S2_TIMEOUT_MS = 20_000

SemanticScholarErrorCode = Literal[
    "invalid_paper_locator",
    "paper_not_found",
    "semantic_scholar_unreachable",
    "semantic_scholar_rate_limited",
    "invalid_semantic_scholar_response",
]


class SemanticScholarError(Exception):
    def __init__(self, code: SemanticScholarErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "SemanticScholarError"


def normalize_doi(value: str) -> str:
    text = value.strip()
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^doi\s*:\s*", "", text, flags=re.IGNORECASE)
    return text.lower()


def _locator_to_provider_id(locator: PaperLocator) -> str:
    value = locator.value.strip()
    if not value:
        raise SemanticScholarError("invalid_paper_locator", "Paper identifier is empty")
    if locator.type == "arxiv_id":
        arxiv_id = normalize_arxiv_id(value)
        if not arxiv_id:
            raise SemanticScholarError("invalid_paper_locator", "Invalid arXiv ID")
        return f"ARXIV:{arxiv_id}"
    if locator.type == "doi":
        doi = normalize_doi(value)
        if not doi:
            raise SemanticScholarError("invalid_paper_locator", "Invalid DOI")
        return f"DOI:{doi}"
    if locator.type == "s2_paper_id":
        return value
    if locator.type == "s2_corpus_id":
        if not re.match(r"^\d+$", value):
            raise SemanticScholarError("invalid_paper_locator", "Invalid Semantic Scholar CorpusId")
        return f"CorpusId:{value}"
    raise SemanticScholarError(
        "invalid_paper_locator",
        "Local document identifiers must be resolved before calling Semantic Scholar",
    )


def _paper_identity(paper: dict[str, Any], locator: Optional[PaperLocator] = None) -> PaperIdentity:
    title = (paper.get("title") or "").strip() if isinstance(paper.get("title"), str) else None
    paper_id = (paper.get("paperId") or "").strip() if isinstance(paper.get("paperId"), str) else None
    if not title or not paper_id:
        raise SemanticScholarError(
            "invalid_semantic_scholar_response",
            "Semantic Scholar paper is missing an ID or title",
        )
    external_ids = paper.get("externalIds") or {}
    if not isinstance(external_ids, dict):
        external_ids = {}
    raw_arxiv = external_ids.get("ArXiv") if isinstance(external_ids.get("ArXiv"), str) else external_ids.get("ARXIV")
    normalized_arxiv = normalize_arxiv_id(raw_arxiv) if isinstance(raw_arxiv, str) else None
    doi = normalize_doi(external_ids["DOI"]) if isinstance(external_ids.get("DOI"), str) else None
    corpus_id = None
    if isinstance(paper.get("corpusId"), (int, float)) and not isinstance(paper.get("corpusId"), bool):
        corpus_id = int(paper["corpusId"])
    elif isinstance(external_ids.get("CorpusId"), (int, float)) and not isinstance(external_ids.get("CorpusId"), bool):
        corpus_id = int(external_ids["CorpusId"])
    if normalized_arxiv:
        canonical_id = f"arxiv:{base_arxiv_id(normalized_arxiv).lower()}"
    elif doi:
        canonical_id = f"doi:{doi}"
    else:
        canonical_id = f"s2:{paper_id}"

    authors = []
    for author in paper.get("authors") or []:
        if not isinstance(author, dict):
            continue
        name = author.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        author_id = author.get("authorId")
        authors.append(AcademicAuthor(authorId=author_id if isinstance(author_id, str) else None, name=name.strip()))

    year = paper.get("year")
    if isinstance(year, bool) or not isinstance(year, (int, float)):
        year = None
    else:
        year = int(year)
    return PaperIdentity(
        canonicalId=canonical_id,
        arxivId=normalized_arxiv,
        doi=doi,
        semanticScholarPaperId=paper_id,
        semanticScholarCorpusId=corpus_id,
        title=title,
        authors=authors,
        year=year,
        publicationDate=paper.get("publicationDate") if isinstance(paper.get("publicationDate"), str) else None,
        abstract=paper.get("abstract") if isinstance(paper.get("abstract"), str) else None,
        venue=paper.get("venue") if isinstance(paper.get("venue"), str) else None,
        citationCount=paper.get("citationCount") if isinstance(paper.get("citationCount"), (int, float)) and not isinstance(paper.get("citationCount"), bool) else None,
        referenceCount=paper.get("referenceCount") if isinstance(paper.get("referenceCount"), (int, float)) and not isinstance(paper.get("referenceCount"), bool) else None,
        matchStatus="exact",
        evidence=[
            IdentityEvidence(
                provider="semantic_scholar",
                identifier=paper_id,
                matchedBy=(locator.type if locator else "semantic_scholar_result"),
            )
        ],
    )


def _encode_cursor(offset: int) -> str:
    raw = json.dumps({"offset": offset}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: Optional[str]) -> int:
    if not cursor:
        return 0
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.urlsafe_b64decode(cursor + padding).decode("utf-8")
        parsed = json.loads(decoded)
        value = parsed.get("offset")
        if isinstance(value, bool):
            return 0
        if isinstance(value, int) and value >= 0:
            return value
        return 0
    except Exception:
        return 0


class _S2RateGate:
    def __init__(self) -> None:
        self._last_request_at = 0.0
        self._gate_tail: Optional[asyncio.Future] = None
        self._lock: Optional[asyncio.Lock] = None

    def _ensure_loop(self) -> None:
        if self._lock is None:
            self._lock = asyncio.Lock()
        if self._gate_tail is None:
            fut: asyncio.Future = asyncio.Future()
            fut.set_result(None)
            self._gate_tail = fut

    async def gate(self) -> None:
        self._ensure_loop()
        assert self._lock is not None and self._gate_tail is not None
        async with self._lock:
            previous = self._gate_tail
            turn: asyncio.Future = asyncio.Future()
            self._gate_tail = turn

        async def _run() -> None:
            try:
                await previous
            except Exception:
                pass
            remaining = S2_MIN_SPACING_MS - (time.monotonic() * 1000.0 - self._last_request_at)
            if remaining > 0:
                await asyncio.sleep(remaining / 1000.0)
            self._last_request_at = time.monotonic() * 1000.0
            turn.set_result(None)

        await _run()


class SemanticScholarClient:
    def __init__(
        self,
        fetch_fn: AcademicFetch,
        cache: AcademicCache,
        api_key: Optional[str] = None,
    ) -> None:
        self._fetch = fetch_fn
        self._cache = cache
        self._api_key = api_key
        self._gate = _S2RateGate()

    async def _request_json(self, url: str, signal: Optional[asyncio.Event] = None) -> Any:
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        for attempt in range(3):
            await self._gate.gate()
            try:
                response = await self._fetch(
                    url,
                    {"headers": headers, "timeout_ms": S2_TIMEOUT_MS, "signal": signal},
                )
            except Exception as error:
                if signal is not None and signal.is_set():
                    raise
                if attempt < 2:
                    continue
                raise SemanticScholarError("semantic_scholar_unreachable", str(error) or "Semantic Scholar request failed")

            if response.status == 404:
                raise SemanticScholarError("paper_not_found", "Paper was not found in Semantic Scholar")
            if response.status == 429:
                if attempt < 2:
                    retry_after_raw = response.header("retry-after") or "1"
                    try:
                        retry_after = float(retry_after_raw)
                    except ValueError:
                        retry_after = 1.0
                    await asyncio.sleep(min(10.0, max(1.0, retry_after)) / 1.0)
                    continue
                raise SemanticScholarError("semantic_scholar_rate_limited", "Semantic Scholar rate limit reached")
            if response.status < 200 or response.status >= 300:
                raise SemanticScholarError(
                    "semantic_scholar_unreachable",
                    f"Semantic Scholar returned HTTP {response.status}",
                )
            length_header = response.header("content-length")
            if length_header:
                try:
                    length = int(length_header)
                    if length > MAX_RESPONSE_BYTES:
                        raise SemanticScholarError(
                            "invalid_semantic_scholar_response",
                            "Semantic Scholar response is too large",
                        )
                except ValueError:
                    pass
            if len(response.text.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise SemanticScholarError(
                    "invalid_semantic_scholar_response",
                    "Semantic Scholar response is too large",
                )
            try:
                return json.loads(response.text)
            except json.JSONDecodeError:
                raise SemanticScholarError(
                    "invalid_semantic_scholar_response",
                    "Semantic Scholar returned invalid JSON",
                )
        raise SemanticScholarError("semantic_scholar_unreachable", "Semantic Scholar request failed")

    async def get_paper(self, locator: PaperLocator, signal: Optional[asyncio.Event] = None) -> PaperIdentity:
        provider_id = _locator_to_provider_id(locator)
        cache_key = provider_id
        cached = await self._cache.get_json("s2-paper", cache_key)
        if cached:
            return _paper_identity(cached.value, locator)
        from urllib.parse import quote

        url = f"{API_BASE}/paper/{quote(provider_id, safe='')}?fields={quote(PAPER_FIELDS, safe='')}"
        paper = await self._request_json(url, signal)
        await self._cache.set_json("s2-paper", cache_key, paper, IDENTITY_TTL_MS)
        return _paper_identity(paper, locator)

    async def graph_page(
        self,
        locator: PaperLocator,
        direction: Literal["incoming", "outgoing"],
        cursor: Optional[str] = None,
        limit: int = 20,
        signal: Optional[asyncio.Event] = None,
        filters: Optional[dict[str, Any]] = None,
    ) -> AcademicGraphPage:
        from urllib.parse import quote, urlencode

        provider_id = _locator_to_provider_id(locator)
        offset = _decode_cursor(cursor)
        page_size = min(50, max(1, limit))
        relation = "citations" if direction == "incoming" else "references"
        params = {
            "offset": str(offset),
            "limit": str(page_size),
            "fields": GRAPH_FIELDS,
        }
        if filters and filters.get("publishedAfter"):
            params["publicationDateOrYear"] = f"{filters['publishedAfter']}:"
        url = f"{API_BASE}/paper/{quote(provider_id, safe='')}/{relation}?{urlencode(params)}"
        cache_key = url
        cached = False
        cache_hit = await self._cache.get_json("s2-graph", cache_key)
        if cache_hit:
            response = cache_hit.value
            cached = True
        else:
            response = await self._request_json(url, signal)
            await self._cache.set_json("s2-graph", cache_key, response, GRAPH_TTL_MS)
        seed = await self.get_paper(locator, signal)
        items: list[AcademicGraphCandidate] = []
        for edge in response.get("data") or []:
            if not isinstance(edge, dict):
                continue
            raw_paper = edge.get("citingPaper" if direction == "incoming" else "citedPaper")
            if not isinstance(raw_paper, dict):
                continue
            try:
                identity = _paper_identity(raw_paper)
            except SemanticScholarError:
                continue
            items.append(
                AcademicGraphCandidate(
                    paper=identity,
                    citationEvidence=CitationEvidence(
                        contexts=list((edge.get("contexts") or [])[:5]),
                        intents=list((edge.get("intents") or [])[:10]),
                        isInfluential=edge.get("isInfluential") is True,
                    ),
                )
            )
        next_value = response.get("next") if isinstance(response.get("next"), int) else None
        total = response.get("total") if isinstance(response.get("total"), int) else None
        scanned = offset + len(items)
        return AcademicGraphPage(
            seed=seed,
            direction=direction,
            items=items,
            total=total,
            nextCursor=_encode_cursor(next_value) if next_value is not None else None,
            coverage=AcademicGraphCoverage(
                scanned=scanned,
                total=total,
                complete=next_value is None or (total is not None and scanned >= total),
            ),
            fetchedAt=_iso_now(),
            cached=cached,
        )

    async def recommendations(
        self,
        locator: PaperLocator,
        limit: int = 20,
        signal: Optional[asyncio.Event] = None,
    ) -> SemanticRecommendationResult:
        from urllib.parse import quote, urlencode

        provider_id = _locator_to_provider_id(locator)
        page_size = min(50, max(1, limit))
        params = {"from": "recent", "limit": str(page_size), "fields": PAPER_FIELDS}
        url = f"{RECOMMENDATIONS_BASE}/papers/forpaper/{quote(provider_id, safe='')}?{urlencode(params)}"
        cache_key = url
        cached = False
        cache_hit = await self._cache.get_json("s2-recommendations", cache_key)
        if cache_hit:
            response = cache_hit.value
            cached = True
        else:
            response = await self._request_json(url, signal)
            await self._cache.set_json("s2-recommendations", cache_key, response, GRAPH_TTL_MS)
        seed = await self.get_paper(locator, signal)
        items: list[PaperIdentity] = []
        for paper in response.get("recommendedPapers") or []:
            if not isinstance(paper, dict):
                continue
            try:
                items.append(_paper_identity(paper))
            except SemanticScholarError:
                continue
        return SemanticRecommendationResult(
            seed=seed,
            items=items,
            fetchedAt=_iso_now(),
            cached=cached,
        )

    async def get_citing_papers(
        self,
        locator: PaperLocator,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
        filters: Optional[dict[str, Any]] = None,
    ) -> AcademicGraphPage:
        return await self.graph_page(locator, "incoming", cursor, limit if limit is not None else 20, signal, filters)

    async def get_referenced_papers(
        self,
        locator: PaperLocator,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
        filters: Optional[dict[str, Any]] = None,
    ) -> AcademicGraphPage:
        return await self.graph_page(locator, "outgoing", cursor, limit if limit is not None else 20, signal, filters)

    async def get_recommendations(
        self,
        locator: PaperLocator,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
    ) -> SemanticRecommendationResult:
        return await self.recommendations(locator, limit if limit is not None else 20, signal)


def _iso_now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def create_semantic_scholar_client(
    fetch_fn: AcademicFetch,
    cache: AcademicCache,
    api_key: Optional[str] = None,
) -> SemanticScholarClient:
    return SemanticScholarClient(fetch_fn, cache, api_key)