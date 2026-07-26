from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Mapping
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag

from refora_server.db.errors import RepoError

FETCH_TIMEOUT_SECONDS = 20.0
MAX_URL_LENGTH = 2048
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_CHARS = 20_000
MAX_CONTENT_CHARS = 40_000
MAX_REDIRECTS = 5
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_REMOVABLE_TAGS = {
    "script", "style", "nav", "aside", "footer", "form", "button", "input", "textarea",
    "select", "option", "noscript", "iframe", "object", "embed", "canvas", "video", "audio",
    "picture", "source", "img", "svg",
}


def _public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _resolve_addresses(hostname: str, port: int) -> list[str]:
    try:
        return list(
            dict.fromkeys(
                item[4][0]
                for item in socket.getaddrinfo(
                    hostname,
                    port,
                    type=socket.SOCK_STREAM,
                )
            )
        )
    except socket.gaierror as error:
        raise RepoError("unsafe_url", "URL hostname could not be resolved") from error


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
    try:
        port = parsed.port
    except ValueError as error:
        raise RepoError("invalid_input", "URL port is invalid") from error
    expected_port = 443 if parsed.scheme == "https" else 80
    if port not in {None, expected_port}:
        raise RepoError("unsafe_url", "Only standard HTTP(S) ports can be fetched")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _validate_public_url(
    value: str,
    resolver: Callable[[str, int], list[str]],
) -> str:
    normalized = _normalize_url(value)
    parsed = urlsplit(normalized)
    hostname = parsed.hostname or ""
    lowered = hostname.rstrip(".").lower()
    if (
        lowered == "localhost"
        or lowered.endswith(".localhost")
        or lowered.endswith(".local")
        or lowered.endswith(".internal")
    ):
        raise RepoError("unsafe_url", "Local network URLs cannot be fetched")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        literal = ipaddress.ip_address(lowered)
    except ValueError:
        addresses = resolver(lowered, port)
        if not addresses or any(not _public_address(address) for address in addresses):
            raise RepoError("unsafe_url", "URL resolves to a non-public network address")
    else:
        if not _public_address(str(literal)):
            raise RepoError("unsafe_url", "Non-public network URLs cannot be fetched")
    return normalized


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


_TABLE_CELL_NEWLINE = re.compile(r"\s*\n\s*")


def _render_list_web(node: Tag, source_url: str, ordered: bool, indent: int) -> str:
    lines: list[str] = []
    index = 0
    for li in node.children:
        if not isinstance(li, Tag) or li.name.lower() != "li":
            continue
        index += 1
        marker = f"{index}. " if ordered else "- "
        prefix = " " * indent + marker
        child_indent = indent + len(marker)
        nested_lists: list[Tag] = []
        inline_parts: list[str] = []

        for sub in li.children:
            if isinstance(sub, NavigableString):
                rendered = _inline_markdown(sub, source_url)
                if rendered.strip():
                    inline_parts.append(rendered)
                continue
            if not isinstance(sub, Tag):
                continue
            sub_name = sub.name.lower()
            if sub_name in {"ul", "ol"}:
                nested_lists.append(sub)
                continue
            rendered = _inline_markdown(sub, source_url)
            if rendered.strip():
                inline_parts.append(rendered)

        lead = re.sub(r"\s+", " ", " ".join(inline_parts)).strip()
        if lead:
            lines.append(f"{prefix}{lead}")
        for sub in nested_lists:
            nested = _render_list_web(sub, source_url, sub.name.lower() == "ol", child_indent)
            if nested:
                lines.append(nested)
    return "\n".join(lines)


def _render_table_cell_web(cell: Tag, source_url: str) -> str:
    text = "".join(_inline_markdown(child, source_url) for child in cell.children)
    text = re.sub(r"\s+", " ", text).strip()
    text = _TABLE_CELL_NEWLINE.sub(" ", text)
    return text.replace("|", "\\|")


def _render_table_web(node: Tag, source_url: str) -> str:
    def collect_rows(parent: Tag) -> list[Tag]:
        return [child for child in parent.children if isinstance(child, Tag) and child.name.lower() == "tr"]

    header_cells: list[str] = []
    rows: list[list[str]] = []

    thead = node.find("thead", recursive=False)
    tbody_nodes = node.find_all("tbody", recursive=False)

    header_row: Tag | None = None
    if thead is not None:
        trs = collect_rows(thead)
        if trs:
            header_row = trs[0]

    body_rows: list[Tag] = []
    if tbody_nodes:
        for tbody in tbody_nodes:
            body_rows.extend(collect_rows(tbody))

    if header_row is None and not body_rows:
        all_rows = collect_rows(node)
        if not all_rows:
            return ""
        header_row = all_rows[0]
        body_rows = all_rows[1:]

    if header_row is not None:
        for cell in header_row.children:
            if isinstance(cell, Tag) and cell.name.lower() in ("th", "td"):
                header_cells.append(_render_table_cell_web(cell, source_url))

    body_rows = [tr for tr in body_rows if any(
        isinstance(c, Tag) and c.name.lower() in ("th", "td") for c in tr.children
    )]

    if header_cells:
        for tr in body_rows:
            row_cells = []
            for cell in tr.children:
                if isinstance(cell, Tag) and cell.name.lower() in ("th", "td"):
                    row_cells.append(_render_table_cell_web(cell, source_url))
            if row_cells:
                while len(row_cells) < len(header_cells):
                    row_cells.append("")
                rows.append(row_cells[: len(header_cells)])
    else:
        for tr in body_rows:
            row_cells = []
            for cell in tr.children:
                if isinstance(cell, Tag) and cell.name.lower() in ("th", "td"):
                    row_cells.append(_render_table_cell_web(cell, source_url))
            if row_cells:
                rows.append(row_cells)

    if not header_cells and not rows:
        return ""

    if not header_cells:
        header_cells = rows[0] if rows else []
        rows = rows[1:] if rows else []

    width = max(len(header_cells), *(len(r) for r in rows)) if rows else len(header_cells)
    while len(header_cells) < width:
        header_cells.append("")
    rows = [(r + [""] * (width - len(r)))[:width] for r in rows]

    out = ["| " + " | ".join(header_cells) + " |"]
    out.append("| " + " | ".join("---" for _ in range(width)) + " |")
    for row in rows:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


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
    if name == "hr":
        return "\n---\n\n"
    if name in {"ul", "ol"}:
        rendered = _render_list_web(node, source_url, name == "ol", 0)
        return f"\n{rendered}\n\n" if rendered.strip() else ""
    if name == "table":
        rendered = _render_table_web(node, source_url)
        return f"\n{rendered}\n\n" if rendered else ""
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
        text = re.sub(r"\s+", " ", content).strip()
        return f"\n{'#' * int(name[1])} {text}\n\n" if text else ""
    if name == "blockquote":
        quote = content.strip()
        return (
            "\n" + "\n".join(f"> {line}" for line in quote.splitlines() if line.strip()) + "\n\n"
            if quote
            else ""
        )
    if name in {"p", "div", "section", "article", "main", "header", "figure", "figcaption"}:
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
    resolver: Callable[[str, int], list[str]] | None = None,
) -> dict[str, Any]:
    request = url if isinstance(url, Mapping) else {"url": url}
    resolve = resolver or _resolve_addresses
    requested_url = _validate_public_url(_normalize_url(request.get("url")), resolve)
    raw_max_chars = maxChars if maxChars is not None else request.get("maxChars", DEFAULT_MAX_CHARS)
    try:
        limit = max(1000, min(MAX_CONTENT_CHARS, int(raw_max_chars)))
    except (TypeError, ValueError, OverflowError) as error:
        raise RepoError("invalid_input", "maxChars must be a number") from error
    owns_client = httpClient is None
    client = httpClient or httpx.Client(timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=False)
    try:
        current_url = requested_url
        for redirect_count in range(MAX_REDIRECTS + 1):
            current_url = _validate_public_url(current_url, resolve)
            with client.stream(
                "GET",
                current_url,
                follow_redirects=False,
                headers={
                    "Accept": "text/html, text/plain, text/markdown, application/xhtml+xml, application/json;q=0.9, */*;q=0.1",
                    "Accept-Encoding": "identity",
                    "User-Agent": "Refora/0.1 web_fetch",
                },
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise RepoError("web_fetch_failed", "Web fetch redirect is missing a destination")
                    if redirect_count >= MAX_REDIRECTS:
                        raise RepoError("web_fetch_failed", "Web fetch exceeded the redirect limit")
                    current_url = _validate_public_url(urljoin(current_url, location), resolve)
                    continue
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
                final_url = current_url
                status = response.status_code
                break
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


async def _await_or_cancel(awaitable: Any, cancel_event: asyncio.Event | None) -> Any:
    task = asyncio.ensure_future(awaitable)
    if cancel_event is None:
        return await task
    cancel_task = asyncio.create_task(cancel_event.wait())
    done, _ = await asyncio.wait(
        {task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
    )
    if cancel_task in done and cancel_event.is_set():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise asyncio.CancelledError()
    cancel_task.cancel()
    await asyncio.gather(cancel_task, return_exceptions=True)
    return await task


async def fetchUrlAsync(
    url: str | Mapping[str, Any],
    *,
    maxChars: int | None = None,
    httpClient: httpx.AsyncClient | None = None,
    resolver: Callable[[str, int], list[str]] | None = None,
    cancelEvent: asyncio.Event | None = None,
    proxy: str | None = None,
) -> dict[str, Any]:
    request = url if isinstance(url, Mapping) else {"url": url}
    resolve = resolver or _resolve_addresses
    requested_url = await asyncio.to_thread(
        _validate_public_url, _normalize_url(request.get("url")), resolve
    )
    raw_max_chars = (
        maxChars if maxChars is not None else request.get("maxChars", DEFAULT_MAX_CHARS)
    )
    try:
        limit = max(1000, min(MAX_CONTENT_CHARS, int(raw_max_chars)))
    except (TypeError, ValueError, OverflowError) as error:
        raise RepoError("invalid_input", "maxChars must be a number") from error
    owns_client = httpClient is None
    client = httpClient or httpx.AsyncClient(
        timeout=FETCH_TIMEOUT_SECONDS,
        follow_redirects=False,
        **({"proxy": proxy} if proxy else {}),
    )
    response: httpx.Response | None = None
    try:
        current_url = requested_url
        for redirect_count in range(MAX_REDIRECTS + 1):
            current_url = await asyncio.to_thread(
                _validate_public_url, current_url, resolve
            )
            request_obj = client.build_request(
                "GET",
                current_url,
                headers={
                    "Accept": "text/html, text/plain, text/markdown, application/xhtml+xml, application/json;q=0.9, */*;q=0.1",
                    "Accept-Encoding": "identity",
                    "User-Agent": "Refora/0.1 web_fetch",
                },
            )
            response = await _await_or_cancel(
                client.send(request_obj, stream=True), cancelEvent
            )
            if response.status_code in _REDIRECT_STATUSES:
                location = response.headers.get("location")
                await response.aclose()
                response = None
                if not location:
                    raise RepoError(
                        "web_fetch_failed",
                        "Web fetch redirect is missing a destination",
                    )
                if redirect_count >= MAX_REDIRECTS:
                    raise RepoError(
                        "web_fetch_failed", "Web fetch exceeded the redirect limit"
                    )
                current_url = await asyncio.to_thread(
                    _validate_public_url, urljoin(current_url, location), resolve
                )
                continue
            if response.is_error:
                raise RepoError(
                    "web_fetch_failed",
                    f"Web fetch failed with HTTP {response.status_code}",
                )
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
                        raise RepoError(
                            "response_too_large",
                            "Web page exceeds the 2 MB download limit",
                        )
                except ValueError:
                    pass
            chunks: list[bytes] = []
            total = 0
            iterator = response.aiter_bytes()
            while True:
                try:
                    chunk = await _await_or_cancel(anext(iterator), cancelEvent)
                except StopAsyncIteration:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RepoError(
                        "response_too_large", "Web page exceeds the 2 MB download limit"
                    )
                chunks.append(chunk)
            raw_bytes = b"".join(chunks)
            final_url = current_url
            status = response.status_code
            break
    except RepoError:
        raise
    except asyncio.CancelledError:
        raise
    except httpx.HTTPError as error:
        raise RepoError(
            "web_fetch_failed", str(error) or "Web fetch request failed"
        ) from error
    finally:
        if response is not None:
            await response.aclose()
        if owns_client:
            await client.aclose()
    try:
        raw = raw_bytes.decode(charset)
    except (LookupError, UnicodeDecodeError):
        raw = raw_bytes.decode("utf-8", errors="replace")
    looks_like_html = "html" in mime or (
        not mime
        and bool(
            re.search(
                r"<(?:(?:!doctype)|html|head|body)\b", raw, re.IGNORECASE
            )
        )
    )
    converted = (
        htmlToMarkdown(raw, final_url)
        if looks_like_html
        else {"text": raw.replace("\r\n", "\n").replace("\r", "\n").strip()}
    )
    text = converted["text"]
    result: dict[str, Any] = {
        "requestedUrl": requested_url,
        "url": final_url,
        "status": status,
        "contentType": mime
        or ("text/html" if looks_like_html else "text/plain"),
        "text": text[:limit],
        "truncated": len(text) > limit,
    }
    if "title" in converted:
        result["title"] = converted["title"]
    return result
