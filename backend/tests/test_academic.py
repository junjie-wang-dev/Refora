from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any, Optional
from unittest.mock import MagicMock
from urllib.parse import unquote_plus

import pytest

from refora_server.academic.arxiv import (
    ArxivClient,
    ArxivClientError,
    FetchResponse,
    convert_arxiv_html_to_markdown,
    create_arxiv_client,
    create_arxiv_paper_service,
    create_arxiv_rate_limiter,
    normalize_arxiv_id,
    parse_arxiv_feed,
)
from refora_server.academic.cache import create_academic_cache
from refora_server.academic.frontier import (
    ContinueFrontierInput,
    ExpandFrontierInput,
    StartFrontierInput,
    create_research_frontier_service,
    create_research_frontier_session_store,
)
from refora_server.academic.identity import (
    LocalDocument,
    create_academic_identity_service,
)
from refora_server.academic.semantic_scholar import (
    SemanticScholarError,
    create_semantic_scholar_client,
)
from refora_server.academic.types import (
    AcademicAuthor,
    AcademicGraphCandidate,
    AcademicGraphCoverage,
    AcademicGraphPage,
    ArxivSearchInput,
    ArxivSearchPaper,
    IdentityEvidence,
    PaperIdentity,
    PaperLocator,
    SemanticRecommendationResult,
)


FEED = """
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-02-01T00:00:00Z</updated>
    <published>2024-01-31T00:00:00Z</published>
    <title> A useful paper </title>
    <summary> A bounded abstract. </summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <category term="cs.AI"/>
    <arxiv:doi>10.1000/example</arxiv:doi>
  </entry>
</feed>
"""

SEED_PAPER = {
    "paperId": "seed-paper",
    "corpusId": 10,
    "externalIds": {"ArXiv": "2401.00001"},
    "title": "Seed paper",
    "authors": [{"authorId": "author-1", "name": "Seed Author"}],
    "year": 2024,
    "citationCount": 12,
    "referenceCount": 8,
}


def _make_fetch(response_body: str, status: int = 200, headers: Optional[dict[str, str]] = None, final_url: Optional[str] = None) -> Any:
    async def fetch(url: str, init: Optional[dict[str, Any]] = None) -> FetchResponse:
        return FetchResponse(
            status=status,
            text=response_body,
            headers=headers or {"content-type": "application/atom+xml"},
            final_url=final_url,
        )

    return fetch


def _make_json_fetch(payload: Any, status: int = 200, headers: Optional[dict[str, str]] = None, final_url: Optional[str] = None) -> Any:
    import json

    async def fetch(url: str, init: Optional[dict[str, Any]] = None) -> FetchResponse:
        return FetchResponse(
            status=status,
            text=json.dumps(payload),
            headers=headers or {"content-type": "application/json"},
            final_url=final_url,
        )

    return fetch


def _make_recording_fetch(calls: list[str], response_body: str, status: int = 200, headers: Optional[dict[str, str]] = None, final_url: Optional[str] = None) -> Any:
    async def fetch(url: str, init: Optional[dict[str, Any]] = None) -> FetchResponse:
        calls.append(url)
        return FetchResponse(
            status=status,
            text=response_body,
            headers=headers or {"content-type": "application/atom+xml"},
            final_url=final_url,
        )

    return fetch


def _paper(s2_id: str, title: str, year: int) -> PaperIdentity:
    return PaperIdentity(
        canonicalId=f"s2:{s2_id}",
        semanticScholarPaperId=s2_id,
        title=title,
        authors=[AcademicAuthor(name=f"{title} Author")],
        year=year,
        publicationDate=f"{year}-01-01",
        abstract=f"{title} abstract",
        matchStatus="exact",
        evidence=[IdentityEvidence(provider="semantic_scholar", identifier=s2_id, matchedBy="test")],
    )


def _arxiv_paper(arxiv_id: str, title: str) -> ArxivSearchPaper:
    return ArxivSearchPaper(
        arxivId=arxiv_id,
        title=title,
        authors=[f"{title} Author"],
        abstract=f"{title} abstract",
        publishedAt="2025-01-01T00:00:00Z",
        updatedAt="2025-01-01T00:00:00Z",
        categories=["cs.AI"],
        absUrl=f"https://arxiv.org/abs/{arxiv_id}",
        htmlUrl=f"https://arxiv.org/html/{arxiv_id}",
        pdfUrl=f"https://arxiv.org/pdf/{arxiv_id}",
    )


@pytest.fixture
def cache_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "cache"
    directory.mkdir()
    return directory


@pytest.fixture
def rate_limiter() -> Any:
    limiter = create_arxiv_rate_limiter(spacing_ms=0)
    return limiter


class TestArxivParsing:
    def test_normalize_arxiv_id_strips_prefixes_and_pdf(self) -> None:
        assert normalize_arxiv_id("arxiv:2401.12345v2") == "2401.12345v2"
        assert normalize_arxiv_id("https://arxiv.org/abs/2401.12345") == "2401.12345"
        assert normalize_arxiv_id("https://arxiv.org/pdf/2401.12345.pdf") == "2401.12345"
        assert normalize_arxiv_id("not-an-id") is None

    def test_parse_arxiv_feed_extracts_entry_metadata(self) -> None:
        feed = parse_arxiv_feed(FEED)
        assert feed.total == 2
        assert len(feed.entries) == 1
        entry = feed.entries[0]
        assert entry.arxivId == "2401.12345v2"
        assert entry.title == "A useful paper"
        assert entry.authors == "Alice; Bob"
        assert entry.categories == ["cs.AI"]
        assert entry.doi == "10.1000/example"
        assert entry.published == "2024-01-31T00:00:00Z"

    def test_parse_arxiv_feed_returns_empty_on_garbage(self) -> None:
        feed = parse_arxiv_feed("not xml at all")
        assert feed.total == 0
        assert feed.entries == []

    def test_parse_arxiv_feed_rejects_entity_declarations(self) -> None:
        malicious = (
            '<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
            '<feed xmlns="http://www.w3.org/2005/Atom">&xxe;</feed>'
        )
        feed = parse_arxiv_feed(malicious)
        assert feed.total == 0
        assert feed.entries == []


class TestArxivClient:
    @pytest.mark.asyncio
    async def test_search_returns_bounded_paginated_metadata_and_caches(self, cache_dir: Path, rate_limiter: Any) -> None:
        calls: list[str] = []
        fetch = _make_recording_fetch(calls, FEED, headers={"content-type": "application/atom+xml"})
        cache = create_academic_cache(str(cache_dir))
        client = create_arxiv_client(fetch, cache, rate_limiter=rate_limiter)

        first = await client.search(
            ArxivSearchInput(
                query="agentic research",
                pageSize=1,
                sort="submitted_date",
                categories=["cs.AI"],
            )
        )
        second = await client.search(
            ArxivSearchInput(
                query="agentic research",
                pageSize=1,
                sort="submitted_date",
                categories=["cs.AI"],
            )
        )

        assert first.cached is False
        assert first.total == 2
        assert first.nextCursor is not None
        paper = first.papers[0]
        assert paper.arxivId == "2401.12345v2"
        assert paper.title == "A useful paper"
        assert paper.authors == ["Alice", "Bob"]
        assert paper.categories == ["cs.AI"]
        assert paper.doi == "10.1000/example"
        assert paper.htmlUrl == "https://arxiv.org/html/2401.12345v2"
        assert second.cached is True
        assert len(calls) == 1
        assert "sortBy=submittedDate" in calls[0]
        assert "max_results=1" in calls[0]

    @pytest.mark.asyncio
    async def test_exact_id_and_title_search_use_provider_specific_queries(
        self,
        cache_dir: Path,
        rate_limiter: Any,
    ) -> None:
        calls: list[str] = []
        fetch = _make_recording_fetch(
            calls,
            FEED,
            headers={"content-type": "application/atom+xml"},
        )
        client = create_arxiv_client(
            fetch,
            create_academic_cache(str(cache_dir)),
            rate_limiter=rate_limiter,
        )

        paper = await client.get_by_id("2401.12345")
        result = await client.search_title("A useful paper", 5)

        assert paper is not None
        assert paper.arxivId == "2401.12345v2"
        assert "id_list=2401.12345" in unquote_plus(calls[0])
        assert 'search_query=ti:"A useful paper"' in unquote_plus(calls[1])
        assert result.papers[0].title == "A useful paper"

    @pytest.mark.asyncio
    async def test_fetch_html_accepts_official_arxiv_html(self, cache_dir: Path, rate_limiter: Any) -> None:
        fetch = _make_fetch(
            "<article><h1>Paper</h1></article>",
            status=200,
            headers={"content-type": "text/html; charset=utf-8"},
            final_url="https://arxiv.org/html/2401.12345",
        )
        client = create_arxiv_client(fetch, create_academic_cache(str(cache_dir)), rate_limiter=rate_limiter)
        result = await client.fetch_html("https://arxiv.org/abs/2401.12345")
        assert result == {
            "arxivId": "2401.12345",
            "sourceUrl": "https://arxiv.org/html/2401.12345",
            "html": "<article><h1>Paper</h1></article>",
        }

    @pytest.mark.asyncio
    async def test_search_rejects_malformed_categories(self, cache_dir: Path, rate_limiter: Any) -> None:
        calls: list[str] = []
        fetch = _make_recording_fetch(calls, FEED)
        client = create_arxiv_client(fetch, create_academic_cache(str(cache_dir)), rate_limiter=rate_limiter)
        with pytest.raises(ArxivClientError) as exc_info:
            await client.search(ArxivSearchInput(query="physics", categories=["physics.bio-ph$"]))
        assert exc_info.value.code == "invalid_arxiv_response"
        assert calls == []

    @pytest.mark.asyncio
    async def test_search_raises_rate_limited_on_429(self, cache_dir: Path, rate_limiter: Any) -> None:
        fetch = _make_fetch("", status=429)
        client = create_arxiv_client(fetch, create_academic_cache(str(cache_dir)), rate_limiter=rate_limiter)
        with pytest.raises(ArxivClientError) as exc_info:
            await client.search(ArxivSearchInput(query="physics"))
        assert exc_info.value.code == "arxiv_rate_limited"


class TestArxivHtmlToMarkdown:
    def test_converts_article_to_sanitized_markdown_with_formulas_and_links(self) -> None:
        html = """
        <html>
          <head>
            <meta name="citation_title" content="A Test Paper">
            <style>.hidden { display: none }</style>
          </head>
          <body>
            <nav>Page navigation</nav>
            <article class="ltx_document">
              <h1>A Test Paper</h1>
              <section>
                <h2>Method</h2>
                <p>See <a href="/abs/2401.12345">the record</a> and
                  <math alttext="x+y"><annotation encoding="application/x-tex">x + y</annotation></math>.
                </p>
                <div class="ltx_equation">
                  <math display="block"><annotation encoding="application/x-tex">E = mc^2</annotation></math>
                </div>
                <script>window.bad = true</script>
              </section>
            </article>
          </body>
        </html>
        """
        result = convert_arxiv_html_to_markdown(html, "https://arxiv.org/html/2401.12345")
        assert result["title"] == "A Test Paper"
        assert "# A Test Paper" in result["markdown"]
        assert "## Method" in result["markdown"]
        assert "[the record](https://arxiv.org/abs/2401.12345)" in result["markdown"]
        assert "$x + y$" in result["markdown"]
        assert "$$\nE = mc^2\n$$" in result["markdown"]
        assert "window.bad" not in result["markdown"]
        assert "Page navigation" not in result["markdown"]
        assert [s.title for s in result["sections"]] == ["A Test Paper", "Method"]
        assert result["warnings"] == []

    def test_reports_warning_when_mathml_has_no_tex(self) -> None:
        result = convert_arxiv_html_to_markdown(
            '<article><h1>Paper</h1><p><math><mi>x</mi></math></p></article>',
            "https://arxiv.org/html/2401.12345",
        )
        assert result["warnings"] == ["A formula could not be converted to TeX."]

    def test_renders_images_with_absolute_src(self) -> None:
        result = convert_arxiv_html_to_markdown(
            '<article><h1>Paper</h1><p>See <img src="fig1.png" alt="Figure 1"> here.</p></article>',
            "https://arxiv.org/html/2401.12345",
        )
        assert "![Figure 1](https://arxiv.org/html/fig1.png)" in result["markdown"]

    def test_renders_horizontal_rule(self) -> None:
        result = convert_arxiv_html_to_markdown(
            '<article><h1>Paper</h1><p>Intro</p><hr><p>After</p></article>',
            "https://arxiv.org/html/2401.12345",
        )
        assert "\n\n---\n\n" in result["markdown"]

    def test_renders_table_as_gfm_pipes(self) -> None:
        result = convert_arxiv_html_to_markdown(
            """<article><h1>Paper</h1><table>
              <thead><tr><th>Metric</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Acc</td><td>95%</td></tr>
                <tr><td>Acc|Err</td><td>x</td></tr>
              </tbody>
            </table></article>""",
            "https://arxiv.org/html/2401.12345",
        )
        md = result["markdown"]
        assert "| Metric | Value |" in md
        assert "| --- | --- |" in md
        assert "| Acc | 95% |" in md
        assert "| Acc\\|Err | x |" in md

    def test_renders_nested_unordered_and_ordered_lists(self) -> None:
        result = convert_arxiv_html_to_markdown(
            """<article><h1>Paper</h1>
              <ul>
                <li>First <strong>bold</strong> and <a href="/x">link</a></li>
                <li>Nested
                  <ul><li>sub a</li><li>sub b</li></ul>
                </li>
              </ul>
              <ol>
                <li>One</li>
                <li>Two
                  <ol><li>two.a</li><li>two.b</li></ol>
                </li>
              </ol>
            </article>""",
            "https://arxiv.org/html/2401.12345",
        )
        md = result["markdown"]
        assert "- First **bold** and [link](https://arxiv.org/x)" in md
        assert "- Nested" in md
        assert "  - sub a" in md
        assert "  - sub b" in md
        assert "1. One" in md
        assert "2. Two" in md
        assert "   1. two.a" in md
        assert "   2. two.b" in md

    def test_renders_description_list_and_figcaption(self) -> None:
        result = convert_arxiv_html_to_markdown(
            """<article><h1>Paper</h1>
              <dl><dt>Term</dt><dd>Definition here</dd></dl>
              <figure><figcaption>The architecture</figcaption></figure>
            </article>""",
            "https://arxiv.org/html/2401.12345",
        )
        md = result["markdown"]
        assert "**Term**" in md
        assert ": Definition here" in md
        assert "*The architecture*" in md


class TestArxivPaperService:
    @pytest.mark.asyncio
    async def test_converts_html_to_paginated_markdown_and_caches(self, cache_dir: Path, rate_limiter: Any) -> None:
        long_paragraph = "Research evidence. " * 80
        html = f"""
        <article class="ltx_document">
          <h1>Paper title</h1>
          <h2>Introduction</h2>
          <p>{long_paragraph}</p>
          <h2>Results</h2>
          <p>{'Measured result. ' * 80}</p>
        </article>
        """
        fetch_calls: list[str] = []

        async def fetch_html(arxiv_id: str, signal: Optional[asyncio.Event] = None) -> dict[str, str]:
            fetch_calls.append(arxiv_id)
            return {
                "arxivId": "2401.12345v1",
                "sourceUrl": "https://arxiv.org/html/2401.12345v1",
                "html": html,
            }

        client_mock = MagicMock(spec=ArxivClient)
        client_mock.fetch_html = fetch_html
        cache = create_academic_cache(str(cache_dir))
        service = create_arxiv_paper_service(client_mock, cache)

        first = await service.get_paper(arxiv_id="2401.12345v1", max_chars=500)
        second = await service.get_paper(
            arxiv_id="2401.12345v1",
            cursor=first.nextCursor,
            max_chars=500,
        )

        assert first.arxivId == "2401.12345v1"
        assert first.sourceFormat == "arxiv-html"
        assert first.outputFormat == "markdown"
        assert first.title == "Paper title"
        assert first.cached is False
        assert "# Paper title" in first.contentMd
        assert first.nextCursor is not None
        assert second.cursor > 0
        assert second.cached is True
        assert len(fetch_calls) == 1
        assert [s.title for s in first.sections] == ["Paper title", "Introduction", "Results"]


class TestSemanticScholar:
    @pytest.mark.asyncio
    async def test_resolves_exact_identity_from_arxiv_id(self, cache_dir: Path) -> None:
        fetch = _make_json_fetch(SEED_PAPER)
        client = create_semantic_scholar_client(fetch, create_academic_cache(str(cache_dir)))
        paper = await client.get_paper(PaperLocator(type="arxiv_id", value="2401.00001"))
        assert paper.canonicalId == "arxiv:2401.00001"
        assert paper.arxivId == "2401.00001"
        assert paper.semanticScholarPaperId == "seed-paper"
        assert paper.semanticScholarCorpusId == 10
        assert paper.matchStatus == "exact"

    @pytest.mark.asyncio
    async def test_citations_expose_pagination_coverage(self, cache_dir: Path) -> None:
        cache = create_academic_cache(str(cache_dir))
        await cache.set_json("s2-paper", "ARXIV:2401.00001", SEED_PAPER, 60_000)
        graph_response = {
            "offset": 0,
            "next": 1,
            "total": 3,
            "data": [
                {
                    "contexts": ["Builds on the seed method."],
                    "intents": ["methodology"],
                    "isInfluential": True,
                    "citingPaper": {
                        "paperId": "newer-paper",
                        "externalIds": {"DOI": "10.1000/newer"},
                        "title": "Newer citing paper",
                        "authors": [{"name": "New Author"}],
                        "year": 2025,
                        "publicationDate": "2025-05-01",
                    },
                    "citedPaper": {
                        "paperId": "wrong-direction",
                        "title": "Referenced paper",
                        "authors": [],
                    },
                }
            ],
        }
        fetch = _make_json_fetch(graph_response)
        client = create_semantic_scholar_client(fetch, cache)

        page = await client.get_citing_papers(
            PaperLocator(type="arxiv_id", value="2401.00001"),
            None,
            1,
            None,
            {"publishedAfter": "2025-01-01"},
        )
        assert page.direction == "incoming"
        assert len(page.items) == 1
        candidate = page.items[0]
        assert candidate.paper.canonicalId == "doi:10.1000/newer"
        assert candidate.paper.title == "Newer citing paper"
        assert candidate.citationEvidence is not None
        assert candidate.citationEvidence.contexts == ["Builds on the seed method."]
        assert candidate.citationEvidence.intents == ["methodology"]
        assert candidate.citationEvidence.isInfluential is True
        assert page.nextCursor is not None
        assert page.coverage == AcademicGraphCoverage(scanned=1, total=3, complete=False)


class InMemoryDocumentRepo:
    def __init__(self, documents: list[LocalDocument]) -> None:
        self._documents = {d.id: d for d in documents}

    def get(self, document_id: str) -> Optional[LocalDocument]:
        return self._documents.get(document_id)

    def list(self, mode: str = "all") -> list[LocalDocument]:
        return list(self._documents.values())


class TestAcademicIdentity:
    @pytest.mark.asyncio
    async def test_resolve_exact_for_non_document_locator(self, cache_dir: Path) -> None:
        fetch = _make_json_fetch(SEED_PAPER)
        s2 = create_semantic_scholar_client(fetch, create_academic_cache(str(cache_dir)))
        identity = create_academic_identity_service(InMemoryDocumentRepo([]), s2)
        result = await identity.resolve(PaperLocator(type="arxiv_id", value="2401.00001"))
        assert result.matchStatus == "exact"
        assert result.canonicalId == "arxiv:2401.00001"

    @pytest.mark.asyncio
    async def test_resolve_verified_when_paper_not_found(self, cache_dir: Path) -> None:
        async def fetch(url: str, init: Optional[dict[str, Any]] = None) -> FetchResponse:
            return FetchResponse(status=404, text="{}", headers={"content-type": "application/json"})

        s2 = create_semantic_scholar_client(fetch, create_academic_cache(str(cache_dir)))
        doc = LocalDocument(
            id="doc-1",
            title="Local paper",
            fileName="local.pdf",
            authors="Alice; Bob",
            year="2024",
            arxivId="2401.99999",
        )
        identity = create_academic_identity_service(InMemoryDocumentRepo([doc]), s2)
        result = await identity.resolve(PaperLocator(type="document_id", value="doc-1"))
        assert result.matchStatus == "verified"
        assert result.canonicalId == "arxiv:2401.99999"
        assert result.arxivId == "2401.99999"
        assert any(e.provider == "local" for e in result.evidence)

    @pytest.mark.asyncio
    async def test_resolve_ambiguous_local_only_when_no_provider_locator(self, cache_dir: Path) -> None:
        async def fetch(url: str, init: Optional[dict[str, Any]] = None) -> FetchResponse:
            raise AssertionError("should not call semantic scholar")

        s2 = create_semantic_scholar_client(fetch, create_academic_cache(str(cache_dir)))
        doc = LocalDocument(id="doc-2", title="Title-only paper", fileName="title.pdf")
        identity = create_academic_identity_service(InMemoryDocumentRepo([doc]), s2)
        result = await identity.resolve(PaperLocator(type="document_id", value="doc-2"))
        assert result.matchStatus == "exact"
        assert result.canonicalId == "document:doc-2"
        assert result.evidence[0].provider == "local"

    @pytest.mark.asyncio
    async def test_resolve_conflict_raises_identity_conflict(self, cache_dir: Path) -> None:
        conflicting = {
            "paperId": "other",
            "externalIds": {"ArXiv": "2401.11111"},
            "title": "Other paper",
            "authors": [{"name": "Author"}],
        }
        fetch = _make_json_fetch(conflicting)
        s2 = create_semantic_scholar_client(fetch, create_academic_cache(str(cache_dir)))
        doc = LocalDocument(id="doc-3", title="Local", arxivId="2401.99999")
        from refora_server.academic.identity import AcademicIdentityError

        identity = create_academic_identity_service(InMemoryDocumentRepo([doc]), s2)
        with pytest.raises(AcademicIdentityError) as exc_info:
            await identity.resolve(PaperLocator(type="document_id", value="doc-3"))
        assert exc_info.value.code == "identity_conflict"

    def test_to_semantic_scholar_locator_prefers_s2_paper_id(self) -> None:
        s2 = MagicMock()
        identity = create_academic_identity_service(InMemoryDocumentRepo([]), s2)
        locator = identity.to_semantic_scholar_locator(
            PaperIdentity(
                canonicalId="s2:abc",
                title="T",
                authors=[],
                matchStatus="exact",
                evidence=[],
                semanticScholarPaperId="abc",
                arxivId="2401.00001",
            )
        )
        assert locator.type == "s2_paper_id"
        assert locator.value == "abc"


def _graph_page(
    seed: PaperIdentity,
    items: list[PaperIdentity],
    *,
    next_cursor: Optional[str] = None,
    total: Optional[int] = None,
    complete: bool = True,
) -> AcademicGraphPage:
    return AcademicGraphPage(
        seed=seed,
        direction="incoming",
        items=[AcademicGraphCandidate(paper=p) for p in items],
        total=total,
        nextCursor=next_cursor,
        coverage=AcademicGraphCoverage(scanned=len(items), total=total, complete=complete),
        fetchedAt="2026-01-01T00:00:00.000Z",
        cached=False,
    )


class _MockGraphService:
    def __init__(self, citing_papers_pages: list[Any], recommendations_pages: Optional[list[Any]] = None) -> None:
        self._citing = list(citing_papers_pages)
        self._recommendations = list(recommendations_pages or [])
        self.citing_calls: list[tuple[Any, ...]] = []
        self.recommendation_calls: list[tuple[Any, ...]] = []

    async def get_citing_papers(self, locator: PaperLocator, cursor: Optional[str] = None, limit: Optional[int] = None, signal: Optional[asyncio.Event] = None, filters: Optional[dict[str, Any]] = None) -> AcademicGraphPage:
        self.citing_calls.append((locator, cursor, limit, signal, filters))
        if not self._citing:
            raise RuntimeError("no more citing pages")
        return self._citing.pop(0)

    async def get_recommendations(self, locator: PaperLocator, limit: Optional[int] = None, signal: Optional[asyncio.Event] = None) -> SemanticRecommendationResult:
        self.recommendation_calls.append((locator, limit, signal))
        if not self._recommendations:
            return SemanticRecommendationResult(seed=locator_to_seed(locator), items=[], fetchedAt="2026-01-01T00:00:00.000Z", cached=False)
        return self._recommendations.pop(0)

    async def get_referenced_papers(self, *args: Any, **kwargs: Any) -> AcademicGraphPage:
        raise NotImplementedError


def locator_to_seed(locator: PaperLocator) -> PaperIdentity:
    return PaperIdentity(
        canonicalId=f"s2:{locator.value}",
        semanticScholarPaperId=locator.value,
        title="seed",
        authors=[],
        matchStatus="exact",
        evidence=[],
    )


class _MockArxivClient:
    def __init__(self, pages: Optional[list[Any]] = None) -> None:
        self._pages = list(pages or [])
        self.calls: list[ArxivSearchInput] = []

    async def search(self, input: ArxivSearchInput, signal: Optional[asyncio.Event] = None) -> Any:
        self.calls.append(input)
        if not self._pages:
            from refora_server.academic.types import ArxivSearchResult

            return ArxivSearchResult(papers=[], total=0, fetchedAt="2026-01-01T00:00:00.000Z", cached=False)
        return self._pages.pop(0)


class _MockIdentityService:
    def __init__(self, seed: PaperIdentity) -> None:
        self._seed = seed
        self.resolve_calls: list[PaperLocator] = []
        self.local_document_ids: dict[str, Optional[str]] = {}

    async def resolve(self, locator: PaperLocator, signal: Optional[asyncio.Event] = None) -> PaperIdentity:
        self.resolve_calls.append(locator)
        return self._seed

    def local_document_id(self, identity: PaperIdentity) -> Optional[str]:
        return self.local_document_ids.get(identity.canonicalId)

    def to_semantic_scholar_locator(self, identity: PaperIdentity) -> PaperLocator:
        return PaperLocator(type="s2_paper_id", value=identity.semanticScholarPaperId or "")


class TestResearchFrontier:
    @pytest.mark.asyncio
    async def test_start_and_expand_one_round(self) -> None:
        seed = _paper("seed", "Seed", 2023)
        selected = _paper("selected", "Semantically selected", 2025)
        next_paper = _paper("next", "Next frontier", 2026)
        graph = _MockGraphService(
            citing_papers_pages=[
                _graph_page(seed, [selected], complete=True),
                _graph_page(selected, [selected, seed, next_paper, next_paper], total=4, complete=True),
            ],
            recommendations_pages=[
                SemanticRecommendationResult(seed=selected, items=[next_paper], fetchedAt="2026-01-01T00:00:00.000Z", cached=False),
            ],
        )
        identity = _MockIdentityService(seed)
        arxiv = _MockArxivClient()
        service = create_research_frontier_service(identity, graph, arxiv)

        first = await service.start(
            StartFrontierInput(
                workspaceId="workspace-1",
                threadId="thread-1",
                seed=PaperLocator(type="s2_paper_id", value="seed"),
                objective="Find the latest extension",
                branches=["citations"],
            )
        )
        citing = first.groups.citingPapers
        assert len(citing) == 1
        assert citing[0].canonicalId == "s2:selected"
        assert citing[0].title == "Semantically selected"
        assert citing[0].discoveredBy == ["citation:s2:seed"]
        assert citing[0].citationContexts is None
        assert first.nextActions[0].type == "expand"

        expanded = await service.expand(
            ExpandFrontierInput(
                workspaceId="workspace-1",
                threadId="thread-1",
                frontierId=first.frontierId,
                paperIds=["s2:selected"],
            )
        )
        assert expanded.round == 1
        assert expanded.expandedFrom == ["s2:selected"]
        assert len(expanded.groups.citingPapers) == 1
        assert expanded.groups.citingPapers[0].canonicalId == "s2:next"
        assert expanded.groups.citingPapers[0].graphDistance == 2
        assert expanded.groups.recommendations == []

    @pytest.mark.asyncio
    async def test_isolates_sessions_by_thread(self) -> None:
        seed = _paper("seed", "Seed", 2023)
        graph = _MockGraphService([_graph_page(seed, [], complete=True)])
        identity = _MockIdentityService(seed)
        service = create_research_frontier_service(identity, graph, _MockArxivClient())
        view = await service.start(
            StartFrontierInput(
                workspaceId="workspace-1",
                threadId="thread-1",
                seed=PaperLocator(type="s2_paper_id", value="seed"),
                objective="Explore",
                branches=["citations"],
            )
        )
        with pytest.raises(RuntimeError, match="not found or has expired"):
            await service.expand(
                ExpandFrontierInput(
                    workspaceId="workspace-1",
                    threadId="another-thread",
                    frontierId=view.frontierId,
                    paperIds=["s2:any"],
                )
            )

    @pytest.mark.asyncio
    async def test_continue_page_restores_citation_pagination(self, tmp_path: Path) -> None:
        seed = _paper("seed", "Seed", 2023)
        session_root = tmp_path / "sessions"
        graph = _MockGraphService(
            [
                _graph_page(seed, [], next_cursor="next-citation-page", total=1, complete=False),
                _graph_page(seed, [], total=1, complete=True),
            ]
        )
        identity = _MockIdentityService(seed)
        arxiv = _MockArxivClient()
        first_service = create_research_frontier_service(identity, graph, arxiv, session_root=str(session_root))
        first = await first_service.start(
            StartFrontierInput(
                workspaceId="workspace-1",
                threadId="thread-1",
                seed=PaperLocator(type="s2_corpus_id", value="12345"),
                objective="Resume citations",
                branches=["citations"],
            )
        )
        resume_token = next((a.resumeToken for a in first.nextActions if a.type == "continue"), None)
        assert resume_token is not None

        reopened = create_research_frontier_service(identity, graph, arxiv, session_root=str(session_root))
        await reopened.continue_page(
            ContinueFrontierInput(
                workspaceId="workspace-1",
                threadId="thread-1",
                frontierId=first.frontierId,
                resumeToken=resume_token,
            )
        )
        assert len(graph.citing_calls) == 2
        second_call = graph.citing_calls[1]
        assert second_call[0].type == "s2_corpus_id"
        assert second_call[0].value == "12345"
        assert second_call[1] == "next-citation-page"
        assert second_call[2] == 15

    @pytest.mark.asyncio
    async def test_session_store_prunes_interrupted_writes_and_enforces_budgets(self, tmp_path: Path) -> None:
        import uuid

        store = create_research_frontier_session_store(str(tmp_path))
        ids = [str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())]

        def make_session(session_id: str) -> Any:
            seed = _paper(f"seed-{session_id}", f"Seed {session_id}", 2025)
            from refora_server.academic.frontier import FrontierSession

            return FrontierSession(
                id=session_id,
                workspaceId="workspace-1",
                threadId=f"thread-{session_id}",
                objective="Budget test",
                seed=seed,
                round=0,
                expansionsUsed=0,
                visitedIds={seed.canonicalId},
                nodes={},
                resumes={},
                strictArxivOnly=False,
                createdAt=time.time() * 1000.0,
                expiresAt=time.time() * 1000.0 + 60_000,
            )

        for session_id in ids:
            await store.save(make_session(session_id))
        base_time = time.time() - 10
        for index, session_id in enumerate(ids):
            path = tmp_path / f"{session_id}.json"
            t = base_time + index
            os.utime(path, (t, t))
        temporary = tmp_path / f"{uuid.uuid4()}.json.{uuid.uuid4()}.tmp"
        temporary.write_text("partial session")

        count_prune = await store.prune(time.time() * 1000.0, max_sessions=2, max_bytes=2**53)
        assert count_prune["remainingFiles"] == 2
        assert await store.load(ids[0]) is None
        assert await store.load(ids[1]) is not None
        assert await store.load(ids[2]) is not None
        assert not temporary.exists()

        newest_size = (tmp_path / f"{ids[2]}.json").stat().st_size
        byte_prune = await store.prune(time.time() * 1000.0, max_sessions=2, max_bytes=newest_size)
        assert byte_prune["remainingFiles"] == 1
        assert byte_prune["remainingBytes"] == newest_size
        assert await store.load(ids[1]) is None
        assert await store.load(ids[2]) is not None
