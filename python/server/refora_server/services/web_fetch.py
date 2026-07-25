from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag

from refora_server.db.errors import RepoError

FETCH_TIMEOUT_SECONDS = 20.0
MAX_URL_LENGTH = 2048
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_CHARS = 20_000
MAX_CONTENT_CHARS = 40_000
_REMOVABLE_TAGS = {
    "script", "style", "nav", "aside", "footer", "form", "button", "input", "textarea",
    "select", "option", "noscript", "iframe", "object", "embed", "canvas", "video", "audio",
    "picture", "source", "img", "svg",
}


def _normalize_url(value: Any) -> str:
    url = value.strip() if isinstance(value, str) else ""
    if not url or len(url) > MAX_URL_LENGTH:
        raise RepoError("invalid_input", f"URL must be between 1 and {MAX_URL_LENGTH} characters")
    try:
        parsed = urlsplit(url)
    except ValueError as error:
        raise RepoError("invalid_input", "URL is invalid") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RepoError("invalid_input", "Only HTTP(S) URLs can be fetched")
    if parsed.username is not None or parsed.password is not None:
        raise RepoError("invalid_input", "URLs containing credentials cannot be fetched")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _content_type(value: str | None) -> tuple[str, str]:
    parts = [part.strip() for part in (value or "").split(";")]
    mime = parts[0].lower() if parts else ""
    charset = "utf-8"
    for part in parts[1:]:
        if part.lower().startswith("charset="):
            charset = part.partition("=")[2].strip().strip("\"'") or "utf-8"
            break
    return mime, charset


def _supported_content_type(mime: str) -> bool:
    return (
        not mime
        or mime.startswith("text/")
        or mime in {"application/json", "application/ld+json", "application/xhtml+xml", "application/xml"}
    )


def _absolute_url(value: str, source_url: str) -> str | None:
    try:
        parsed = urlsplit(urljoin(source_url, value))
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return urlunsplit(parsed)


def _inline_markdown(node: Any, source_url: str) -> str:
    if isinstance(node, NavigableString):
        return re.sub(r"\s+", " ", str(node))
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    if name in _REMOVABLE_TAGS:
        return ""
    if name == "br":
        return "\n"
    if name == "pre":
        code = node.get_text("\n", strip=True)
        return f"\n```\n{code}\n```\n"
    content = "".join(_inline_markdown(child, source_url) for child in node.children)
    if name in {"strong", "b"}:
        return f"**{content.strip()}**" if content.strip() else ""
    if name in {"em", "i"}:
        return f"*{content.strip()}*" if content.strip() else ""
    if name == "code":
        return f"`{content.strip()}`" if content.strip() else ""
    if name == "a":
        href = node.get("href")
        absolute = _absolute_url(href, source_url) if isinstance(href, str) else None
        text = content.strip()
        return f"[{text}]({absolute})" if text and absolute else content
    if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        return f"\n{'#' * int(name[1])} {content.strip()}\n\n"
    if name == "li":
        return f"{content.strip()}\n"
    if name in {"ul", "ol"}:
        items = [child for child in node.children if isinstance(child, Tag) and child.name == "li"]
        if not items:
            return content
        prefix = "- " if name == "ul" else None
        rendered = []
        for index, item in enumerate(items, 1):
            marker = prefix or f"{index}. "
            rendered.append(f"{marker}{_inline_markdown(item, source_url).strip()}")
        return f"\n{'\n'.join(rendered)}\n\n"
    if name == "blockquote":
        quote = content.strip()
        return f"\n{'\n'.join(f'> {line}' for line in quote.splitlines() if line.strip())}\n\n" if quote else ""
    if name in {"p", "div", "section", "article", "main", "header", "figure", "figcaption", "tr"}:
        return f"\n{content.strip()}\n\n" if content.strip() else ""
    return content


def htmlToMarkdown(html: str, source_url: str) -> dict[str, str]:
    soup = BeautifulSoup(html, "lxml")
    title_element = soup.title
    title = title_element.get_text(" ", strip=True)[:300] if title_element else ""
    for element in soup.find_all(_REMOVABLE_TAGS):
        element.decompose()
    root = soup.find("article") or soup.find("main") or soup.body or soup
    text = _inline_markdown(root, source_url)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    result = {"text": text}
    if title:
        result["title"] = title
    return result


def fetchUrl(
    url: str | Mapping[str, Any],
    *,
    maxChars: int | None = None,
    httpClient: httpx.Client | None = None,
) -> dict[str, Any]:
    request = url if isinstance(url, Mapping) else {"url": url}
    requested_url = _normalize_url(request.get("url"))
    raw_max_chars = maxChars if maxChars is not None else request.get("maxChars", DEFAULT_MAX_CHARS)
    try:
        limit = max(1000, min(MAX_CONTENT_CHARS, int(raw_max_chars)))
    except (TypeError, ValueError, OverflowError) as error:
        raise RepoError("invalid_input", "maxChars must be a number") from error
    owns_client = httpClient is None
    client = httpClient or httpx.Client(timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True)
    try:
        with client.stream(
            "GET",
            requested_url,
            headers={
                "Accept": "text/html, text/plain, text/markdown, application/xhtml+xml, application/json;q=0.9, */*;q=0.1",
                "Accept-Encoding": "identity",
                "User-Agent": "Refora/0.1 web_fetch",
            },
        ) as response:
            if response.is_error:
                raise RepoError("web_fetch_failed", f"Web fetch failed with HTTP {response.status_code}")
            mime, charset = _content_type(response.headers.get("content-type"))
            if not _supported_content_type(mime):
                raise RepoError(
                    "unsupported_content_type",
                    f"Web fetch supports text and HTML responses, not {mime or 'this content type'}",
                )
            declared_length = response.headers.get("content-length")
            if declared_length:
                try:
                    if int(declared_length) > MAX_RESPONSE_BYTES:
                        raise RepoError("response_too_large", "Web page exceeds the 2 MB download limit")
                except ValueError:
                    pass
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RepoError("response_too_large", "Web page exceeds the 2 MB download limit")
                chunks.append(chunk)
            raw_bytes = b"".join(chunks)
            final_url = str(response.url)
            status = response.status_code
    except RepoError:
        raise
    except httpx.HTTPError as error:
        raise RepoError("web_fetch_failed", str(error) or "Web fetch request failed") from error
    finally:
        if owns_client:
            client.close()
    try:
        raw = raw_bytes.decode(charset)
    except (LookupError, UnicodeDecodeError):
        raw = raw_bytes.decode("utf-8", errors="replace")
    looks_like_html = "html" in mime or (not mime and bool(re.search(r"<(?:(?:!doctype)|html|head|body)\b", raw, re.IGNORECASE)))
    converted = htmlToMarkdown(raw, final_url) if looks_like_html else {"text": raw.replace("\r\n", "\n").replace("\r", "\n").strip()}
    text = converted["text"]
    result: dict[str, Any] = {
        "requestedUrl": requested_url,
        "url": final_url,
        "status": status,
        "contentType": mime or ("text/html" if looks_like_html else "text/plain"),
        "text": text[:limit],
        "truncated": len(text) > limit,
    }
    if "title" in converted:
        result["title"] = converted["title"]
    return result
