from __future__ import annotations

import re
from collections.abc import Callable, Mapping
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


def _api_key(config: Mapping[str, Any], provider: str, decrypt_key: Callable[..., Any] | None) -> str:
    field = f"{provider}ApiKey"
    value = config.get(field, config.get(f"{field}Enc"))
    if value is None:
        label = "Tavily" if provider == "tavily" else "Brave"
        raise RepoError("no_api_key", f"{label} API key is not configured")
    if decrypt_key is not None:
        try:
            value = decrypt_key(value, provider)
        except TypeError:
            value = decrypt_key(value)
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RepoError("invalid_api_key", "Search API key cannot be decoded") from error
    value = _text(value, 2048)
    if not value:
        label = "Tavily" if provider == "tavily" else "Brave"
        raise RepoError("no_api_key", f"{label} API key is not configured")
    return value


def _request(
    method: str,
    url: str,
    *,
    client: httpx.Client | None,
    proxy: str | None = None,
    **kwargs: Any,
) -> httpx.Response:
    try:
        if client is not None:
            return client.request(method, url, **kwargs)
        options: dict[str, Any] = {
            "timeout": SEARCH_TIMEOUT_SECONDS,
            "follow_redirects": True,
        }
        if proxy:
            options["proxy"] = proxy
        with httpx.Client(**options) as request_client:
            return request_client.request(method, url, **kwargs)
    except httpx.HTTPError as error:
        raise RepoError("search_failed", str(error) or "Web search request failed") from error


def createWebSearchService(repos: Any, deps: Any):
    get_config = _dependency(deps, "getConfig")
    if get_config is None:
        try:
            get_config = repos["webSearchConfig"]["get"]
        except (KeyError, TypeError):
            get_config = getattr(getattr(repos, "webSearchConfig"), "get")
    if not callable(get_config):
        raise TypeError("deps.getConfig must be callable")
    client = _dependency(deps, "httpClient", _dependency(deps, "http_client"))
    if client is not None and not isinstance(client, httpx.Client):
        raise TypeError("deps.httpClient must be an httpx.Client")
    decrypt_key = _dependency(deps, "decryptKey", _dependency(deps, "decrypt_key"))
    if decrypt_key is not None and not callable(decrypt_key):
        raise TypeError("deps.decryptKey must be callable")
    get_proxy = _dependency(deps, "getProxy", _dependency(deps, "get_proxy"))

    def current_config() -> Mapping[str, Any]:
        config = get_config()
        if not isinstance(config, Mapping):
            raise RepoError("invalid_data", "Web search configuration is invalid")
        return config

    def search(request: str | Mapping[str, Any]) -> list[dict[str, str]]:
        data: Mapping[str, Any] = {"query": request} if isinstance(request, str) else request
        if not isinstance(data, Mapping):
            raise RepoError("invalid_input", "Search request is invalid")
        query = _text(data.get("query"), MAX_QUERY_LENGTH + 1)
        if not query or len(query) > MAX_QUERY_LENGTH:
            raise RepoError("invalid_input", f"Search query must be between 1 and {MAX_QUERY_LENGTH} characters")
        raw_max_results = data.get("maxResults", 8)
        try:
            max_results = max(1, min(MAX_RESULTS, int(raw_max_results)))
        except (TypeError, ValueError, OverflowError) as error:
            raise RepoError("invalid_input", "maxResults must be a number") from error
        allowed_domains = _normalize_domains(data.get("allowedDomains"))
        config = current_config()
        provider = config.get("provider")
        if provider == "disabled":
            raise RepoError("web_search_disabled", "Web search is disabled in Settings")
        if provider not in WEB_SEARCH_PROVIDERS:
            raise RepoError("invalid_input", "Unknown web search provider")
        time_range = data.get("timeRange")
        if time_range not in {None, "day", "week", "month", "year"}:
            raise RepoError("invalid_input", "Invalid search time range")
        region = _text(data.get("region"), 20)
        proxy = _text(get_proxy(), 2048) if callable(get_proxy) else ""
        if provider == "ddgs":
            params = {
                "q": _effective_query(query, allowed_domains),
                "kl": region or "wt-wt",
                "kp": "-1",
            }
            if time_range:
                params["df"] = {"day": "d", "week": "w", "month": "m", "year": "y"}[time_range]
            response = _request(
                "GET",
                DDG_HTML_ENDPOINT,
                client=client,
                proxy=proxy or None,
                params=params,
                headers={"Accept": "text/html", "User-Agent": "Refora/0.1 web_search"},
            )
            if response.is_error:
                _response_error(response, "DuckDuckGo")
            items = _parse_ddg_html(response.text)
        elif provider == "tavily":
            response = _request(
                "POST",
                TAVILY_ENDPOINT,
                client=client,
                proxy=proxy or None,
                headers={"Authorization": f"Bearer {_api_key(config, provider, decrypt_key)}"},
                json={
                    "query": query,
                    "search_depth": "basic",
                    "max_results": max_results,
                    "include_answer": False,
                    "include_raw_content": False,
                    "include_images": False,
                    **({"time_range": time_range} if time_range else {}),
                    **({"include_domains": allowed_domains} if allowed_domains else {}),
                },
            )
            if response.is_error:
                _response_error(response, "Tavily")
            try:
                body = response.json()
            except ValueError as error:
                raise RepoError("search_failed", "Tavily returned invalid JSON") from error
            raw_items = body.get("results", []) if isinstance(body, Mapping) else []
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
                params["freshness"] = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}[time_range]
            if re.fullmatch(r"[a-z]{2}-[a-z]{2}", region, re.IGNORECASE):
                language, country = region.split("-")
                params.update(
                    {
                        "country": country.upper(),
                        "search_lang": language.lower(),
                        "ui_lang": f"{language.lower()}-{country.upper()}",
                    }
                )
            response = _request(
                "GET",
                BRAVE_ENDPOINT,
                client=client,
                proxy=proxy or None,
                params=params,
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": _api_key(config, provider, decrypt_key),
                    "Api-Version": "2023-01-01",
                },
            )
            if response.is_error:
                _response_error(response, "Brave")
            try:
                body = response.json()
            except ValueError as error:
                raise RepoError("search_failed", "Brave returned invalid JSON") from error
            web = body.get("web", {}) if isinstance(body, Mapping) else {}
            raw_items = web.get("results", []) if isinstance(web, Mapping) else []
            items = [
                {
                    "title": item.get("title"),
                    "url": item.get("url"),
                    "snippet": item.get("description"),
                    "publishedAt": item.get("page_age", item.get("age")),
                }
                for item in raw_items
                if isinstance(item, Mapping)
            ]
        return _normalize_items(items, allowed_domains)[:max_results]

    def test(query: str = "Refora literature manager") -> list[dict[str, str]]:
        return search({"query": query, "maxResults": 1})

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

    return {"getConfig": getConfig, "isEnabled": isEnabled, "search": search, "test": test}
