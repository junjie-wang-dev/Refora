from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, Tag

from refora_server.db.errors import RepoError
from refora_server.web.types import WEB_SEARCH_PROVIDERS

SEARCH_TIMEOUT_SECONDS = 15.0
MAX_QUERY_LENGTH = 400
MAX_RESULTS = 10
MAX_DOMAINS = 10
DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/"
BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
TAVILY_ENDPOINT = "https://api.tavily.com/search"
DDGS_VERSION = "builtin"
_DOMAIN_PATTERN = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    re.IGNORECASE,
)


def _dependency(deps: Any, name: str, default: Any = None) -> Any:
    if isinstance(deps, Mapping):
        return deps.get(name, default)
    return getattr(deps, name, default)


def _text(value: Any, maximum: int) -> str:
    return value.strip()[:maximum] if isinstance(value, str) else ""


def _normalize_domains(values: Any) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise RepoError("invalid_input", "allowedDomains must be a list")
    domains: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise RepoError("invalid_input", "Invalid allowed domain")
        domain = value.strip().lower().strip(".")
        if not _DOMAIN_PATTERN.fullmatch(domain):
            raise RepoError("invalid_input", f"Invalid allowed domain: {value}")
        if domain not in domains:
            domains.append(domain)
        if len(domains) > MAX_DOMAINS:
            raise RepoError("invalid_input", f"A maximum of {MAX_DOMAINS} domains is allowed")
    return domains


def _hostname_allowed(hostname: str, allowed_domains: list[str]) -> bool:
    if not allowed_domains:
        return True
    hostname = hostname.lower()
    return any(hostname == domain or hostname.endswith(f".{domain}") for domain in allowed_domains)


def _normalize_items(items: list[dict[str, Any]], allowed_domains: list[str]) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        url_value = _text(item.get("url"), 2048)
        try:
            parsed = urlsplit(url_value)
            hostname = parsed.hostname
            if (
                parsed.scheme not in {"http", "https"}
                or not hostname
                or parsed.username is not None
                or parsed.password is not None
                or not _hostname_allowed(hostname, allowed_domains)
            ):
                continue
            url = urlunsplit(parsed)
        except ValueError:
            continue
        if url in seen:
            continue
        seen.add(url)
        result = {
            "title": _text(item.get("title"), 300),
            "url": url,
            "snippet": _text(item.get("snippet"), 2000),
        }
        published_at = _text(item.get("publishedAt"), 100)
        if published_at:
            result["publishedAt"] = published_at
        results.append(result)
        if len(results) >= MAX_RESULTS:
            break
    return results


def _effective_query(query: str, allowed_domains: list[str]) -> str:
    if not allowed_domains:
        return query
    sites = " OR ".join(f"site:{domain}" for domain in allowed_domains)
    return f"{query} ({sites})"[:MAX_QUERY_LENGTH]


def _response_error(response: httpx.Response, provider: str) -> None:
    detail = _text(response.text, 500)
    if response.status_code in {401, 403}:
        raise RepoError("invalid_api_key", f"{provider} rejected the API key")
    if response.status_code == 429:
        raise RepoError("rate_limited", f"{provider} rate limit exceeded")
    suffix = f": {detail}" if detail else ""
    raise RepoError("search_failed", f"{provider} search failed with HTTP {response.status_code}{suffix}")


def _ddg_result_url(value: str) -> str:
    absolute = urljoin("https://duckduckgo.com", value)
    parsed = urlsplit(absolute)
    if parsed.hostname and parsed.hostname.lower().endswith("duckduckgo.com"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target:
            return target
    return absolute


def _result_container(anchor: Tag) -> Tag:
    current: Tag | None = anchor
    while current is not None:
        classes = current.get("class", [])
        if "result" in classes or "results_links" in classes:
            return current
        parent = current.parent
        current = parent if isinstance(parent, Tag) else None
    return anchor


def _parse_ddg_html(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    results: list[dict[str, str]] = []
    for anchor in soup.select("a.result__a"):
        href = anchor.get("href")
        if not isinstance(href, str):
            continue
        container = _result_container(anchor)
        snippet_element = container.select_one(".result__snippet")
        results.append(
            {
                "title": anchor.get_text(" ", strip=True),
                "url": _ddg_result_url(href),
                "snippet": snippet_element.get_text(" ", strip=True) if snippet_element else "",
            }
        )
    return results


async def _await_or_cancel(
    awaitable: Any, cancel_event: asyncio.Event | None
) -> Any:
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


def createWebSearchService(repos: Any, deps: Any):
    get_config = _dependency(deps, "getConfig")
    if get_config is None:
        try:
            get_config = repos["webSearchConfig"]["get"]
        except (KeyError, TypeError):
            get_config = getattr(getattr(repos, "webSearchConfig"), "get")
    if not callable(get_config):
        raise TypeError("deps.getConfig must be callable")
    decrypt_key_async = _dependency(
        deps, "decryptKeyAsync", _dependency(deps, "decrypt_key_async")
    )
    if decrypt_key_async is not None and not callable(decrypt_key_async):
        raise TypeError("deps.decryptKeyAsync must be callable")
    get_proxy = _dependency(deps, "getProxy", _dependency(deps, "get_proxy"))

    def current_config() -> Mapping[str, Any]:
        config = get_config()
        if not isinstance(config, Mapping):
            raise RepoError("invalid_data", "Web search configuration is invalid")
        return config

    async def search_async(
        request: str | Mapping[str, Any],
        cancel_event: asyncio.Event | None = None,
    ) -> list[dict[str, str]]:
        data: Mapping[str, Any] = (
            {"query": request} if isinstance(request, str) else request
        )
        if not isinstance(data, Mapping):
            raise RepoError("invalid_input", "Search request is invalid")
        query = _text(data.get("query"), MAX_QUERY_LENGTH + 1)
        if not query or len(query) > MAX_QUERY_LENGTH:
            raise RepoError(
                "invalid_input",
                f"Search query must be between 1 and {MAX_QUERY_LENGTH} characters",
            )
        try:
            max_results = max(
                1, min(MAX_RESULTS, int(data.get("maxResults", 8)))
            )
        except (TypeError, ValueError, OverflowError) as error:
            raise RepoError("invalid_input", "maxResults must be a number") from error
        allowed_domains = _normalize_domains(data.get("allowedDomains"))
        config = current_config()
        provider = config.get("provider")
        if provider == "disabled":
            raise RepoError(
                "web_search_disabled", "Web search is disabled in Settings"
            )
        if provider not in WEB_SEARCH_PROVIDERS:
            raise RepoError("invalid_input", "Unknown web search provider")
        time_range = data.get("timeRange")
        if time_range not in {None, "day", "week", "month", "year"}:
            raise RepoError("invalid_input", "Invalid search time range")
        region = _text(data.get("region"), 20)
        proxy = _text(get_proxy(), 2048) if callable(get_proxy) else ""
        async_client = _dependency(
            deps, "asyncHttpClient", _dependency(deps, "async_http_client")
        )
        owns_client = async_client is None
        if async_client is not None and not isinstance(
            async_client, httpx.AsyncClient
        ):
            raise TypeError("deps.asyncHttpClient must be an httpx.AsyncClient")
        client_async = async_client or httpx.AsyncClient(
            timeout=SEARCH_TIMEOUT_SECONDS,
            follow_redirects=True,
            **({"proxy": proxy} if proxy else {}),
        )

        async def api_key() -> str:
            field = f"{provider}ApiKey"
            plain = config.get(field)
            if plain is not None:
                return _text(plain, 2048)
            encrypted = config.get(f"{field}Enc")
            if encrypted is None:
                label = "Tavily" if provider == "tavily" else "Brave"
                raise RepoError(
                    "no_api_key", f"{label} API key is not configured"
                )
            if decrypt_key_async is None:
                raise RepoError(
                    "key_decryption_unavailable",
                    "Native key decryption is unavailable",
                )
            decrypted = decrypt_key_async(encrypted, provider)
            if inspect.isawaitable(decrypted):
                decrypted = await decrypted
            key = _text(decrypted, 2048)
            if not key:
                raise RepoError("invalid_api_key", "Search API key is empty")
            return key

        try:
            if provider == "ddgs":
                params = {
                    "q": _effective_query(query, allowed_domains),
                    "kl": region or "wt-wt",
                    "kp": "-1",
                }
                if time_range:
                    params["df"] = {
                        "day": "d",
                        "week": "w",
                        "month": "m",
                        "year": "y",
                    }[time_range]
                response = await _await_or_cancel(
                    client_async.get(
                        DDG_HTML_ENDPOINT,
                        params=params,
                        headers={
                            "Accept": "text/html",
                            "User-Agent": "Refora/0.1 web_search",
                        },
                    ),
                    cancel_event,
                )
                if response.is_error:
                    _response_error(response, "DuckDuckGo")
                items = _parse_ddg_html(response.text)
            elif provider == "tavily":
                response = await _await_or_cancel(
                    client_async.post(
                        TAVILY_ENDPOINT,
                        headers={"Authorization": f"Bearer {await api_key()}"},
                        json={
                            "query": query,
                            "search_depth": "basic",
                            "max_results": max_results,
                            "include_answer": False,
                            "include_raw_content": False,
                            "include_images": False,
                            **(
                                {"time_range": time_range}
                                if time_range
                                else {}
                            ),
                            **(
                                {"include_domains": allowed_domains}
                                if allowed_domains
                                else {}
                            ),
                        },
                    ),
                    cancel_event,
                )
                if response.is_error:
                    _response_error(response, "Tavily")
                try:
                    body = response.json()
                except ValueError as error:
                    raise RepoError(
                        "search_failed", "Tavily returned invalid JSON"
                    ) from error
                raw_items = (
                    body.get("results", []) if isinstance(body, Mapping) else []
                )
                items = [
                    {
                        "title": item.get("title"),
                        "url": item.get("url"),
                        "snippet": item.get("content"),
                        "publishedAt": item.get("published_date"),
                    }
                    for item in raw_items
                    if isinstance(item, Mapping)
                ]
            else:
                params = {
                    "q": _effective_query(query, allowed_domains),
                    "count": str(max_results),
                    "safesearch": "moderate",
                }
                if time_range:
                    params["freshness"] = {
                        "day": "pd",
                        "week": "pw",
                        "month": "pm",
                        "year": "py",
                    }[time_range]
                if re.fullmatch(r"[a-z]{2}-[a-z]{2}", region, re.IGNORECASE):
                    language, country = region.split("-")
                    params.update(
                        {
                            "country": country.upper(),
                            "search_lang": language.lower(),
                            "ui_lang": f"{language.lower()}-{country.upper()}",
                        }
                    )
                response = await _await_or_cancel(
                    client_async.get(
                        BRAVE_ENDPOINT,
                        params=params,
                        headers={
                            "Accept": "application/json",
                            "X-Subscription-Token": await api_key(),
                            "Api-Version": "2023-01-01",
                        },
                    ),
                    cancel_event,
                )
                if response.is_error:
                    _response_error(response, "Brave")
                try:
                    body = response.json()
                except ValueError as error:
                    raise RepoError(
                        "search_failed", "Brave returned invalid JSON"
                    ) from error
                web = body.get("web", {}) if isinstance(body, Mapping) else {}
                raw_items = (
                    web.get("results", []) if isinstance(web, Mapping) else []
                )
                items = [
                    {
                        "title": item.get("title"),
                        "url": item.get("url"),
                        "snippet": item.get("description"),
                        "publishedAt": item.get(
                            "page_age", item.get("age")
                        ),
                    }
                    for item in raw_items
                    if isinstance(item, Mapping)
                ]
            return _normalize_items(items, allowed_domains)[:max_results]
        except asyncio.CancelledError:
            raise
        except httpx.HTTPError as error:
            raise RepoError(
                "search_failed", str(error) or "Web search request failed"
            ) from error
        finally:
            if owns_client:
                await client_async.aclose()

    async def test(query: str = "Refora literature manager") -> dict[str, Any]:
        config = current_config()
        provider = config.get("provider")
        if provider == "disabled":
            return {
                "ok": False,
                "provider": provider,
                "resultCount": 0,
                "error": "Web search is disabled",
            }
        try:
            results = await search_async(
                {
                    "query": query.strip() or "Refora literature manager",
                    "maxResults": 1,
                }
            )
            return {
                "ok": bool(results),
                "provider": provider,
                "resultCount": len(results),
                **(
                    {}
                    if results
                    else {"error": "The provider returned no results"}
                ),
            }
        except Exception as error:
            return {
                "ok": False,
                "provider": provider,
                "resultCount": 0,
                "error": str(error),
            }

    def getConfig() -> dict[str, Any]:
        config = current_config()
        return {
            "provider": config.get("provider"),
            "hasTavilyApiKey": config.get("tavilyApiKey", config.get("tavilyApiKeyEnc")) is not None,
            "hasBraveApiKey": config.get("braveApiKey", config.get("braveApiKeyEnc")) is not None,
            "ddgsInstalled": True,
            "ddgsVersion": DDGS_VERSION,
        }

    def isEnabled() -> bool:
        return current_config().get("provider") != "disabled"

    return {
        "getConfig": getConfig,
        "isEnabled": isEnabled,
        "searchAsync": search_async,
        "test": test,
    }
