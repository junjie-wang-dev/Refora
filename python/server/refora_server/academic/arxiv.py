from __future__ import annotations

import asyncio
import base64
import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Optional
from urllib.parse import quote, urlencode

from refora_server.academic.cache import AcademicCache
from refora_server.academic.types import (
    ArxivPaperResult,
    ArxivPaperSection,
    ArxivSearchInput,
    ArxivSearchPaper,
    ArxivSearchResult,
)

ARXIV_MODERN_ID = re.compile(r"^\d{4}\.\d{4,5}(?:v\d+)?$", re.IGNORECASE)
ARXIV_LEGACY_ID = re.compile(r"^[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?$", re.IGNORECASE)

SEARCH_CACHE_TTL_MS = 60 * 60 * 1000
MAX_ATOM_BYTES = 5 * 1024 * 1024
MAX_HTML_BYTES = 20 * 1024 * 1024
ARXIV_MIN_SPACING_MS = 3000
ARXIV_TIMEOUT_SEARCH_MS = 15_000
ARXIV_TIMEOUT_HTML_MS = 30_000
ARXIV_USER_AGENT = "Refora/0.1 (mailto:support@refora.app)"

ARXIV_CLIENT_ERROR_CODES = (
    "invalid_arxiv_id",
    "arxiv_unreachable",
    "arxiv_rate_limited",
    "arxiv_html_unavailable",
    "invalid_arxiv_response",
)

ArxivErrorCode = Literal[
    "invalid_arxiv_id",
    "arxiv_unreachable",
    "arxiv_rate_limited",
    "arxiv_html_unavailable",
    "invalid_arxiv_response",
]


class ArxivClientError(Exception):
    def __init__(self, code: ArxivErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "ArxivClientError"


def normalize_arxiv_id(value: str) -> Optional[str]:
    text = value.strip()
    text = re.sub(r"^arxiv\s*:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^https?://(?:export\.)?arxiv\.org/(?:abs|pdf|html)/", "", text, flags=re.IGNORECASE)
    text = re.split(r"[?#]", text, maxsplit=1)[0]
    text = re.sub(r"\.pdf$", "", text, flags=re.IGNORECASE)
    if not ARXIV_MODERN_ID.match(text) and not ARXIV_LEGACY_ID.match(text):
        return None
    return text


def base_arxiv_id(arxiv_id: str) -> str:
    return re.sub(r"v\d+$", "", arxiv_id, flags=re.IGNORECASE)


def _non_empty(value: Any) -> Optional[str]:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed if trimmed else None
    return None


def _as_array(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


@dataclass
class ParsedArxivEntry:
    title: str
    arxivId: str
    categories: list[str]
    authors: Optional[str] = None
    year: Optional[str] = None
    abstract: Optional[str] = None
    id: Optional[str] = None
    doi: Optional[str] = None
    published: Optional[str] = None
    updated: Optional[str] = None


@dataclass
class ParsedArxivFeed:
    total: int
    entries: list[ParsedArxivEntry] = field(default_factory=list)


def _parse_total(raw_total: Any) -> int:
    if isinstance(raw_total, (int, float)):
        try:
            value = int(raw_total)
            return value
        except (TypeError, ValueError):
            return 0
    if isinstance(raw_total, str):
        try:
            return int(raw_total)
        except ValueError:
            return 0
    return 0


def parse_arxiv_feed(xml: str) -> ParsedArxivFeed:
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(xml)
    except Exception:
        return ParsedArxivFeed(total=0)

    atom_ns = "http://www.w3.org/2005/Atom"
    opensearch_ns = "http://a9.com/-/spec/opensearch/1.1/"
    arxiv_ns = "http://arxiv.org/schemas/atom"

    def local(tag: str) -> str:
        return tag.split("}", 1)[1] if "}" in tag else tag

    def attr_term(element: ET.Element) -> Optional[str]:
        term = element.attrib.get("term")
        return term.strip() if term and term.strip() else None

    total = 0
    for child in root:
        if local(child.tag) == "totalResults":
            total = _parse_total(child.text)
            break

    entries: list[ParsedArxivEntry] = []
    for entry in root:
        if local(entry.tag) != "entry":
            continue
        title = entry.findtext(f"{{{atom_ns}}}title")
        if title is None:
            title_text = None
            for child in entry:
                if local(child.tag) == "title":
                    title_text = child.text
                    break
        else:
            title_text = title
        if not isinstance(title_text, str):
            continue
        title_clean = re.sub(r"\s+", " ", title_text).strip()
        if not title_clean:
            continue

        id_value = None
        for child in entry:
            if local(child.tag) == "id":
                id_value = (child.text or "").strip() if child.text else None
                break
        arxiv_id = normalize_arxiv_id(id_value) if id_value else None
        if not arxiv_id:
            continue

        authors: list[str] = []
        for child in entry:
            if local(child.tag) != "author":
                continue
            name = None
            for sub in child:
                if local(sub.tag) == "name":
                    name = sub.text
                    break
            if isinstance(name, str) and name.strip():
                authors.append(name.strip())
        authors_str = "; ".join(authors) if authors else None

        published = None
        updated = None
        summary = None
        doi = None
        for child in entry:
            tag_local = local(child.tag)
            if tag_local == "published":
                published = _non_empty(child.text)
            elif tag_local == "updated":
                updated = _non_empty(child.text)
            elif tag_local == "summary":
                summary = child.text
            elif tag_local == "doi" and child.tag.startswith(f"{{{arxiv_ns}}}"):
                doi = _non_empty(child.text)
        abstract_clean = (
            re.sub(r"\s+", " ", summary).strip() if isinstance(summary, str) else None
        )

        categories: list[str] = []
        for child in entry:
            if local(child.tag) == "category":
                term = attr_term(child)
                if term:
                    categories.append(term)

        entries.append(
            ParsedArxivEntry(
                title=title_clean,
                arxivId=arxiv_id,
                authors=authors_str,
                year=published[:4] if published else None,
                abstract=abstract_clean,
                id=id_value,
                doi=doi,
                published=published,
                updated=updated,
                categories=categories,
            )
        )

    return ParsedArxivFeed(total=total if isinstance(total, int) else len(entries), entries=entries)


def _encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: Optional[str], key: str) -> int:
    if not cursor:
        return 0
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.urlsafe_b64decode(cursor + padding).decode("utf-8")
        parsed = json.loads(decoded)
        value = parsed.get(key)
        if isinstance(value, bool):
            return 0
        if isinstance(value, int) and value >= 0:
            return value
        return 0
    except Exception:
        return 0


def _escape_search_term(value: str) -> str:
    cleaned = re.sub(r'["\\]', " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _entry_to_search_paper(entry: ParsedArxivEntry) -> ArxivSearchPaper:
    authors = [author.strip() for author in (entry.authors or "").split(";") if author.strip()]
    return ArxivSearchPaper(
        arxivId=entry.arxivId,
        title=entry.title,
        authors=authors,
        abstract=entry.abstract or None,
        publishedAt=entry.published or None,
        updatedAt=entry.updated or None,
        categories=entry.categories,
        doi=entry.doi or None,
        absUrl=f"https://arxiv.org/abs/{entry.arxivId}",
        htmlUrl=f"https://arxiv.org/html/{entry.arxivId}",
        pdfUrl=f"https://arxiv.org/pdf/{entry.arxivId}",
    )


class ArxivRateLimiter:
    def __init__(self, spacing_ms: int = ARXIV_MIN_SPACING_MS) -> None:
        self._spacing_ms = spacing_ms
        self._last_request_at: Optional[float] = None
        self._gate_tail: Optional[asyncio.Future] = None
        self._generation = 0
        self._lock: Optional[asyncio.Lock] = None

    def _ensure_loop(self) -> None:
        if self._lock is None:
            self._lock = asyncio.Lock()
        if self._gate_tail is None:
            fut: asyncio.Future = asyncio.Future()
            fut.set_result(None)
            self._gate_tail = fut

    async def wait(self) -> None:
        self._ensure_loop()
        current_generation = self._generation
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
            if current_generation != self._generation:
                turn.set_result(None)
                return
            now = time.monotonic() * 1000.0
            if self._last_request_at is not None and now >= self._last_request_at:
                remaining = self._spacing_ms - (now - self._last_request_at)
                if remaining > 0:
                    await asyncio.sleep(remaining / 1000.0)
            if current_generation != self._generation:
                turn.set_result(None)
                return
            self._last_request_at = time.monotonic() * 1000.0
            turn.set_result(None)

        await _run()

    def reset(self) -> None:
        self._generation += 1
        self._last_request_at = None
        if self._gate_tail is not None:
            self._gate_tail = asyncio.Future()
            self._gate_tail.set_result(None)


def create_arxiv_rate_limiter(spacing_ms: int = ARXIV_MIN_SPACING_MS) -> ArxivRateLimiter:
    return ArxivRateLimiter(spacing_ms=spacing_ms)


AcademicFetch = Callable[
    [str, dict[str, Any]],
    Awaitable["FetchResponse"],
]


@dataclass
class FetchResponse:
    status: int
    text: str
    headers: dict[str, str]
    final_url: Optional[str] = None

    def header(self, name: str) -> Optional[str]:
        lower = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lower:
                return value
        return None


def _read_bounded_text(response: FetchResponse, max_bytes: int) -> str:
    length_header = response.header("content-length")
    if length_header:
        try:
            length = int(length_header)
            if length > max_bytes:
                raise ArxivClientError("invalid_arxiv_response", "arXiv response is too large")
        except ValueError:
            pass
    if len(response.text.encode("utf-8")) > max_bytes:
        raise ArxivClientError("invalid_arxiv_response", "arXiv response is too large")
    return response.text


class ArxivClient:
    def __init__(
        self,
        fetch_fn: AcademicFetch,
        cache: AcademicCache,
        rate_limiter: Optional[ArxivRateLimiter] = None,
    ) -> None:
        self._fetch = fetch_fn
        self._cache = cache
        self._rate_limiter = rate_limiter or create_arxiv_rate_limiter()

    async def search(self, input: ArxivSearchInput, signal: Optional[asyncio.Event] = None) -> ArxivSearchResult:
        query = _escape_search_term(input.query)
        if not query:
            raise ArxivClientError("invalid_arxiv_response", "Search query is empty")
        page_size = min(50, max(1, input.pageSize if input.pageSize is not None else 20))
        start = _decode_cursor(input.cursor, "start")
        requested_categories = [c.strip() for c in (input.categories or []) if c.strip()]
        invalid = next(
            (c for c in requested_categories if not re.match(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$", c, re.IGNORECASE)),
            None,
        )
        if invalid:
            raise ArxivClientError("invalid_arxiv_response", f"Invalid arXiv category: {invalid}")
        categories = list(dict.fromkeys(requested_categories))[:5]
        query_parts = [f'all:"{query}"']
        if categories:
            query_parts.append(f"({' OR '.join(f'cat:{c}' for c in categories)})")
        params = {
            "search_query": " AND ".join(query_parts),
            "start": str(start),
            "max_results": str(page_size),
            "sortBy": "submittedDate" if input.sort == "submitted_date" else "relevance",
            "sortOrder": "descending",
        }
        url = f"https://export.arxiv.org/api/query?{urlencode(params)}"
        return await self._search_url(url, start, signal)

    async def get_by_id(
        self,
        value: str,
        signal: Optional[asyncio.Event] = None,
    ) -> Optional[ArxivSearchPaper]:
        arxiv_id = normalize_arxiv_id(value)
        if not arxiv_id:
            raise ArxivClientError("invalid_arxiv_id", "Invalid arXiv ID")
        params = {"id_list": arxiv_id, "max_results": "1"}
        result = await self._search_url(
            f"https://export.arxiv.org/api/query?{urlencode(params)}",
            0,
            signal,
        )
        target = base_arxiv_id(arxiv_id).lower()
        return next(
            (
                paper
                for paper in result.papers
                if base_arxiv_id(paper.arxivId).lower() == target
            ),
            None,
        )

    async def search_title(
        self,
        title: str,
        page_size: int = 5,
        signal: Optional[asyncio.Event] = None,
    ) -> ArxivSearchResult:
        query = _escape_search_term(title)
        if not query:
            raise ArxivClientError("invalid_arxiv_response", "Search query is empty")
        params = {
            "search_query": f'ti:"{query}"',
            "start": "0",
            "max_results": str(min(50, max(1, page_size))),
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        return await self._search_url(
            f"https://export.arxiv.org/api/query?{urlencode(params)}",
            0,
            signal,
        )

    async def _search_url(
        self,
        url: str,
        start: int,
        signal: Optional[asyncio.Event],
    ) -> ArxivSearchResult:
        cache_key = url
        cached = await self._cache.get_json("arxiv-search", cache_key)
        if cached:
            return ArxivSearchResult(
                papers=[ArxivSearchPaper(**p) for p in cached.value.get("papers", [])],
                total=cached.value.get("total", 0),
                nextCursor=cached.value.get("nextCursor"),
                fetchedAt=cached.value.get("fetchedAt"),
                cached=True,
            )

        await self._rate_limiter.wait()
        try:
            response = await self._fetch(
                url,
                {"headers": {"User-Agent": ARXIV_USER_AGENT}, "timeout_ms": ARXIV_TIMEOUT_SEARCH_MS, "signal": signal},
            )
        except Exception as error:
            if signal is not None and _signal_aborted(signal):
                raise
            raise ArxivClientError("arxiv_unreachable", str(error) or "arXiv request failed")
        if response.status == 429:
            raise ArxivClientError("arxiv_rate_limited", "arXiv rate limit reached")
        if response.status < 200 or response.status >= 300:
            raise ArxivClientError("arxiv_unreachable", f"arXiv returned HTTP {response.status}")

        feed = parse_arxiv_feed(_read_bounded_text(response, MAX_ATOM_BYTES))
        next_start = start + len(feed.entries)
        next_cursor = _encode_cursor({"start": next_start}) if next_start < feed.total else None
        papers = [_entry_to_search_paper(entry) for entry in feed.entries]
        value = {
            "papers": [_paper_to_dict(p) for p in papers],
            "total": feed.total,
            "nextCursor": next_cursor,
            "fetchedAt": _iso_now(),
        }
        await self._cache.set_json("arxiv-search", cache_key, value, SEARCH_CACHE_TTL_MS)
        return ArxivSearchResult(
            papers=papers,
            total=feed.total,
            nextCursor=next_cursor,
            fetchedAt=value["fetchedAt"],
            cached=False,
        )

    async def fetch_html(self, input: str, signal: Optional[asyncio.Event] = None) -> dict[str, str]:
        arxiv_id = normalize_arxiv_id(input)
        if not arxiv_id:
            raise ArxivClientError("invalid_arxiv_id", "Invalid arXiv ID")
        url = f"https://arxiv.org/html/{arxiv_id}"
        await self._rate_limiter.wait()
        try:
            response = await self._fetch(
                url,
                {
                    "headers": {"User-Agent": ARXIV_USER_AGENT},
                    "timeout_ms": ARXIV_TIMEOUT_HTML_MS,
                    "follow_redirects": True,
                    "signal": signal,
                },
            )
        except Exception as error:
            if signal is not None and _signal_aborted(signal):
                raise
            raise ArxivClientError("arxiv_unreachable", str(error) or "arXiv request failed")
        if response.status == 404:
            raise ArxivClientError("arxiv_html_unavailable", "Official arXiv HTML is unavailable")
        if response.status < 200 or response.status >= 300:
            raise ArxivClientError("arxiv_unreachable", f"arXiv returned HTTP {response.status}")
        final_url = response.final_url or url
        try:
            from urllib.parse import urlparse

            parsed = urlparse(final_url)
        except Exception:
            raise ArxivClientError("invalid_arxiv_response", "Unexpected arXiv redirect")
        if parsed.scheme != "https" or parsed.hostname != "arxiv.org":
            raise ArxivClientError("invalid_arxiv_response", "Unexpected arXiv redirect")
        content_type = (response.header("content-type") or "").lower()
        if "text/html" not in content_type:
            raise ArxivClientError("invalid_arxiv_response", "arXiv did not return HTML")
        return {
            "arxivId": arxiv_id,
            "sourceUrl": final_url,
            "html": _read_bounded_text(response, MAX_HTML_BYTES),
        }


def _paper_to_dict(paper: ArxivSearchPaper) -> dict[str, Any]:
    data: dict[str, Any] = {
        "arxivId": paper.arxivId,
        "title": paper.title,
        "authors": paper.authors,
        "categories": paper.categories,
        "absUrl": paper.absUrl,
        "htmlUrl": paper.htmlUrl,
        "pdfUrl": paper.pdfUrl,
    }
    for key in ("abstract", "publishedAt", "updatedAt", "doi"):
        value = getattr(paper, key)
        if value is not None:
            data[key] = value
    return data


def _signal_aborted(signal: asyncio.Event) -> bool:
    return signal.is_set()


def _iso_now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _build_sections(markdown: str) -> list[ArxivPaperSection]:
    matches = list(re.finditer(r"^(#{1,6})\s+(.+)$", markdown, re.MULTILINE))
    sections: list[ArxivPaperSection] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        sections.append(
            ArxivPaperSection(
                id=f"section-{index + 1}",
                title=match.group(2).strip(),
                level=len(match.group(1)),
                start=start,
                end=end,
            )
        )
    return sections


def _absolute_url(value: str, source_url: str) -> str:
    try:
        from urllib.parse import urljoin, urlparse

        parsed = urlparse(value)
        if parsed.scheme:
            return value
        return urljoin(source_url, value)
    except Exception:
        return value


def convert_arxiv_html_to_markdown(html: str, source_url: str) -> dict[str, Any]:
    from bs4 import BeautifulSoup, NavigableString, Tag

    document = BeautifulSoup(html, "lxml")

    root = (
        document.select_one("article.ltx_document")
        or document.select_one("article")
        or document.select_one("main")
        or document.body
    )
    if root is None:
        root = document

    for selector in (
        "script",
        "style",
        "nav",
        "form",
        "button",
        "input",
        "textarea",
        "select",
        "noscript",
        "iframe",
        "object",
        "embed",
        ".ltx_page_navbar",
    ):
        for element in root.select(selector):
            element.decompose()

    for element in root.select("[href]"):
        href = element.get("href")
        if href:
            element["href"] = _absolute_url(href, source_url)
    for element in root.select("[src]"):
        src = element.get("src")
        if src:
            element["src"] = _absolute_url(src, source_url)

    warnings: list[str] = []
    math_tokens: dict[str, str] = {}
    math_index = 0
    for math in root.find_all("math"):
        annotation = None
        for sub in math.find_all("annotation"):
            encoding = sub.get("encoding")
            if encoding in ("application/x-tex", "application/x-latex"):
                annotation = sub.get_text(strip=True)
                break
        tex = annotation or (math.get("alttext") or "").strip()
        if not tex:
            warnings.append("A formula could not be converted to TeX.")
            continue
        display = math.get("display") == "block" or bool(math.find_parent(class_="ltx_equation")) or bool(math.find_parent(class_="ltx_equationgroup"))
        token = f"REFORAMATHTOKEN{math_index}END"
        math_index += 1
        math_tokens[token] = f"\n\n$$\n{tex}\n$$\n\n" if display else f"${tex}$"
        math.replace_with(NavigableString(token))

    markdown = _turndown(root)
    for token, replacement in math_tokens.items():
        markdown = markdown.replace(token, replacement)
    markdown = re.sub(r"\n{4,}", "\n\n\n", markdown)
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    markdown = markdown.strip()

    title = None
    citation_title = document.select_one('meta[name="citation_title"]')
    if citation_title and citation_title.get("content"):
        title = citation_title["content"].strip()
    if not title:
        h1 = document.select_one("h1")
        if h1:
            title = re.sub(r"\s+", " ", h1.get_text()).strip() or None

    return {
        "title": title,
        "markdown": markdown,
        "sections": _build_sections(markdown),
        "warnings": list(dict.fromkeys(warnings)),
    }


def _turndown(root: Tag) -> str:
    lines = _render_node(root, indent=0)
    return "\n".join(lines)


def _render_node(node: Any, indent: int) -> list[str]:
    from bs4 import NavigableString, Tag

    out: list[str] = []
    for child in node.children:
        if isinstance(child, NavigableString):
            text = str(child)
            if text.strip():
                out.append(text.strip())
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name.lower() if child.name else ""
        if name == "svg":
            continue
        if name in ("script", "style", "nav", "form", "button", "input", "textarea", "select", "noscript", "iframe", "object", "embed"):
            continue
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(name[1])
            text = re.sub(r"\s+", " ", child.get_text()).strip()
            if text:
                out.append(f"\n\n{'#' * level} {text}\n\n")
            continue
        if name in ("p", "section", "div", "article", "main", "figure"):
            inner = _render_node(child, indent)
            if inner:
                out.append("\n\n" + "\n".join(inner) + "\n\n")
            continue
        if name in ("ul", "ol"):
            items = []
            for li in child.find_all("li", recursive=False):
                text = re.sub(r"\s+", " ", li.get_text()).strip()
                if text:
                    items.append(f"- {text}")
            if items:
                out.append("\n\n" + "\n".join(items) + "\n\n")
            continue
        if name == "pre":
            code = child.get_text()
            out.append(f"\n\n```\n{code}\n```\n\n")
            continue
        if name in ("code",):
            code = child.get_text()
            out.append(f"`{code}`")
            continue
        if name in ("a",):
            href = child.get("href") or ""
            text = re.sub(r"\s+", " ", child.get_text()).strip()
            if text and href:
                out.append(f"[{text}]({href})")
            elif text:
                out.append(text)
            continue
        if name in ("strong", "b"):
            text = re.sub(r"\s+", " ", child.get_text()).strip()
            if text:
                out.append(f"**{text}**")
            continue
        if name in ("em", "i"):
            text = re.sub(r"\s+", " ", child.get_text()).strip()
            if text:
                out.append(f"*{text}*")
            continue
        if name == "br":
            out.append("\n")
            continue
        if name in ("blockquote",):
            inner = _render_node(child, indent)
            inner_text = "\n".join(inner).strip()
            if inner_text:
                out.append("\n\n" + "\n".join(f"> {line}" for line in inner_text.split("\n")) + "\n\n")
            continue
        if name in ("table",):
            out.append("\n\n" + child.get_text() + "\n\n")
            continue
        inner = _render_node(child, indent)
        if inner:
            out.extend(inner)
    return out


@dataclass
class ArxivManifest:
    schemaVersion: int
    arxivId: str
    sourceUrl: str
    sections: list[ArxivPaperSection]
    conversionWarnings: list[str]
    fetchedAt: float
    title: Optional[str] = None


def _page_end(text: str, start: int, max_chars: int) -> int:
    hard_end = min(len(text), start + max_chars)
    if hard_end == len(text):
        return hard_end
    minimum = start + int(max_chars * 0.6)
    paragraph = text.rfind("\n\n", start, hard_end)
    if paragraph >= minimum:
        return paragraph
    line = text.rfind("\n", start, hard_end)
    return line if line >= minimum else hard_end


class ArxivPaperService:
    def __init__(self, arxiv_client: ArxivClient, cache: AcademicCache) -> None:
        self._client = arxiv_client
        self._cache = cache

    async def _load_cached(self, arxiv_id: str) -> Optional[tuple[ArxivManifest, str]]:
        from pathlib import Path

        manifest_path = Path(self._cache.path("arxiv", arxiv_id, "manifest.json"))
        try:
            import json

            manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if manifest_data.get("schemaVersion") != 1 or manifest_data.get("arxivId") != arxiv_id:
            return None
        versioned = bool(re.search(r"v\d+$", arxiv_id, re.IGNORECASE))
        if not versioned and time.time() * 1000.0 - float(manifest_data.get("fetchedAt", 0)) > 24 * 60 * 60 * 1000:
            return None
        markdown_path = Path(self._cache.path("arxiv", arxiv_id, "document.md"))
        try:
            markdown = markdown_path.read_text(encoding="utf-8")
        except Exception:
            return None
        if not markdown:
            return None
        manifest = ArxivManifest(
            schemaVersion=manifest_data["schemaVersion"],
            arxivId=manifest_data["arxivId"],
            sourceUrl=manifest_data["sourceUrl"],
            sections=[ArxivPaperSection(**s) for s in manifest_data.get("sections", [])],
            conversionWarnings=manifest_data.get("conversionWarnings", []),
            fetchedAt=float(manifest_data.get("fetchedAt", 0)),
            title=manifest_data.get("title"),
        )
        return manifest, markdown

    async def _publish(
        self,
        arxiv_id: str,
        source_url: str,
        converted: dict[str, Any],
    ) -> ArxivManifest:
        import json
        from pathlib import Path

        markdown = converted["markdown"]
        sections = converted["sections"]
        warnings = converted["warnings"]
        title = converted.get("title")
        directory = Path(self._cache.path("arxiv", arxiv_id))
        directory.mkdir(parents=True, exist_ok=True)

        blocks: list[str] = []
        offset = 0
        for paragraph in re.split(r"\n{2,}", markdown):
            start = markdown.index(paragraph, offset) if paragraph else -1
            if start < 0:
                continue
            end = start + len(paragraph)
            blocks.append(json.dumps({"start": start, "end": end, "text": paragraph}))
            offset = end

        manifest = ArxivManifest(
            schemaVersion=1,
            arxivId=arxiv_id,
            sourceUrl=source_url,
            title=title,
            fetchedAt=time.time() * 1000.0,
            sections=sections,
            conversionWarnings=warnings,
        )
        await self._cache.write_text(self._cache.path("arxiv", arxiv_id, "document.md"), markdown)
        await self._cache.write_text(self._cache.path("arxiv", arxiv_id, "blocks.jsonl"), "\n".join(blocks))
        await self._cache.write_text(
            self._cache.path("arxiv", arxiv_id, "manifest.json"),
            json.dumps(
                {
                    "schemaVersion": manifest.schemaVersion,
                    "arxivId": manifest.arxivId,
                    "sourceUrl": manifest.sourceUrl,
                    "title": manifest.title,
                    "fetchedAt": manifest.fetchedAt,
                    "sections": [s.__dict__ for s in manifest.sections],
                    "conversionWarnings": manifest.conversionWarnings,
                }
            ),
        )
        return manifest

    async def get_paper(
        self,
        arxiv_id: str,
        section_id: Optional[str] = None,
        cursor: Optional[str] = None,
        max_chars: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
    ) -> ArxivPaperResult:
        normalized = normalize_arxiv_id(arxiv_id)
        if not normalized:
            raise ArxivClientError("invalid_arxiv_id", "Invalid arXiv ID")

        cached = await self._load_cached(normalized)
        was_cached = cached is not None
        if not cached:
            fetched = await self._client.fetch_html(normalized, signal)
            converted = convert_arxiv_html_to_markdown(fetched["html"], fetched["sourceUrl"])
            manifest = await self._publish(normalized, fetched["sourceUrl"], converted)
            cached = (manifest, converted["markdown"])

        manifest, markdown = cached
        section = None
        if section_id:
            section = next((s for s in manifest.sections if s.id == section_id), None)
            if section is None:
                raise ArxivClientError("invalid_arxiv_response", "Requested section was not found")
        source_text = markdown[section.start:section.end] if section else markdown
        max_chars_value = min(12_000, max(500, max_chars if max_chars is not None else 8000))
        cursor_value = min(len(source_text), _decode_cursor(cursor, "offset"))
        end = _page_end(source_text, cursor_value, max_chars_value)
        content_md = source_text[cursor_value:end].strip()

        return ArxivPaperResult(
            arxivId=normalized,
            sourceUrl=manifest.sourceUrl,
            sourceFormat="arxiv-html",
            outputFormat="markdown",
            title=manifest.title,
            sections=manifest.sections,
            sectionId=section.id if section else None,
            cursor=cursor_value,
            maxChars=max_chars_value,
            totalChars=len(source_text),
            nextCursor=_encode_cursor({"offset": end}) if end < len(source_text) else None,
            contentMd=content_md,
            conversionWarnings=manifest.conversionWarnings,
            cached=was_cached,
        )


def create_arxiv_client(
    fetch_fn: AcademicFetch,
    cache: AcademicCache,
    rate_limiter: Optional[ArxivRateLimiter] = None,
) -> ArxivClient:
    return ArxivClient(fetch_fn, cache, rate_limiter)


def create_arxiv_paper_service(arxiv_client: ArxivClient, cache: AcademicCache) -> ArxivPaperService:
    return ArxivPaperService(arxiv_client, cache)
