from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from refora_server.db.connection import _SqliteAdapter
from refora_server.db.errors import RepoError
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories
from refora_server.services.web_fetch import fetchUrl, fetchUrlAsync
from refora_server.services.web_search import createWebSearchService

DDG_HTML = """
<html><body>
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpaper">Example paper</a>
    <a class="result__snippet">A concise result summary.</a>
  </div>
  <div class="result results_links">
    <a class="result__a" href="https://other.example.org/article">Other article</a>
    <div class="result__snippet">Another summary.</div>
  </div>
</body></html>
"""


@pytest.fixture()
def repos():
    import sqlite3

    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    run_migrations(_SqliteAdapter(db))
    return create_repositories(db)


def test_search_parses_duckduckgo_html_and_filters_domains(repos) -> None:
    repos["webSearchConfig"]["update"]({"provider": "ddgs"})

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL(
            "https://html.duckduckgo.com/html/?q=neural+retrieval+%28site%3Aexample.com%29&kl=wt-wt&kp=-1"
        )
        return httpx.Response(200, text=DDG_HTML, request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    service = createWebSearchService(
        repos,
        {"getConfig": repos["webSearchConfig"]["get"], "httpClient": client},
    )

    results = service["search"](
        {"query": "neural retrieval", "allowedDomains": ["example.com"]}
    )

    assert results == [
        {
            "title": "Example paper",
            "url": "https://example.com/paper",
            "snippet": "A concise result summary.",
        }
    ]
    client.close()


def test_search_uses_tavily_configured_in_repository(repos) -> None:
    repos["webSearchConfig"]["update"](
        {"provider": "tavily", "tavilyApiKeyEnc": b"encrypted-tavily"}
    )
    decrypted: list[tuple[bytes, str]] = []

    def decrypt_key(value: bytes, provider: str) -> str:
        decrypted.append((value, provider))
        return "tavily-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url == httpx.URL("https://api.tavily.com/search")
        assert request.headers["authorization"] == "Bearer tavily-secret"
        assert json.loads(request.content) == {
            "query": "literature",
            "search_depth": "basic",
            "max_results": 3,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
        }
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Tavily result",
                        "url": "https://example.com/tavily",
                        "content": "Provider result",
                        "published_date": "2026-07-01",
                    }
                ]
            },
            request=request,
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    service = createWebSearchService(
        repos,
        {
            "getConfig": repos["webSearchConfig"]["get"],
            "httpClient": client,
            "decryptKey": decrypt_key,
        },
    )

    assert service["search"]({"query": "literature", "maxResults": 3}) == [
        {
            "title": "Tavily result",
            "url": "https://example.com/tavily",
            "snippet": "Provider result",
            "publishedAt": "2026-07-01",
        }
    ]
    assert decrypted == [(b"encrypted-tavily", "tavily")]
    client.close()


def test_search_does_not_treat_ciphertext_as_a_plaintext_api_key(repos) -> None:
    repos["webSearchConfig"]["update"](
        {"provider": "tavily", "tavilyApiKeyEnc": b"ciphertext"}
    )
    service = createWebSearchService(
        repos, {"getConfig": repos["webSearchConfig"]["get"]}
    )

    with pytest.raises(RepoError) as error:
        service["search"]("literature")

    assert error.value.code == "key_decryption_unavailable"


@pytest.mark.asyncio
async def test_async_search_decrypts_on_the_server_loop_and_cancels_http(
    repos,
) -> None:
    repos["webSearchConfig"]["update"](
        {"provider": "tavily", "tavilyApiKeyEnc": b"ciphertext"}
    )
    started = asyncio.Event()
    blocked = asyncio.Event()
    decrypted: list[tuple[bytes, str]] = []
    proxies: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer tavily-secret"
        started.set()
        await blocked.wait()
        return httpx.Response(200, json={"results": []}, request=request)

    async def decrypt(value: bytes, provider: str) -> str:
        decrypted.append((value, provider))
        return "tavily-secret"

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = createWebSearchService(
        repos,
        {
            "asyncHttpClient": client,
            "decryptKeyAsync": decrypt,
            "getProxy": lambda: (
                proxies.append("http://proxy.example:8080")
                or "http://proxy.example:8080"
            ),
        },
    )
    cancel_event = asyncio.Event()
    task = asyncio.create_task(
        service["searchAsync"]({"query": "literature"}, cancel_event)
    )
    await asyncio.wait_for(started.wait(), 1)
    cancel_event.set()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert decrypted == [(b"ciphertext", "tavily")]
    assert proxies == ["http://proxy.example:8080"]
    await client.aclose()


def test_test_returns_a_single_probe_result(repos) -> None:
    repos["webSearchConfig"]["update"]({"provider": "ddgs"})

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["q"] == "configured probe"
        return httpx.Response(200, text=DDG_HTML, request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    service = createWebSearchService(
        repos,
        {"getConfig": repos["webSearchConfig"]["get"], "httpClient": client},
    )

    result = service["test"]("configured probe")

    assert result == {
        "ok": True,
        "provider": "ddgs",
        "resultCount": 1,
    }
    client.close()


def test_get_config_reads_the_web_search_config_repository(repos) -> None:
    repos["webSearchConfig"]["update"](
        {"provider": "brave", "braveApiKeyEnc": b"brave-secret"}
    )
    service = createWebSearchService(repos, {"getConfig": repos["webSearchConfig"]["get"]})

    assert service["getConfig"]() == {
        "provider": "brave",
        "hasTavilyApiKey": False,
        "hasBraveApiKey": True,
        "ddgsInstalled": True,
        "ddgsVersion": "builtin",
    }


def test_search_rejects_disabled_provider(repos) -> None:
    repos["webSearchConfig"]["update"]({"provider": "disabled"})
    service = createWebSearchService(repos, {"getConfig": repos["webSearchConfig"]["get"]})

    with pytest.raises(RepoError, match="disabled") as error:
        service["search"]("literature")
    assert error.value.code == "web_search_disabled"


def test_fetch_url_converts_local_html_fixture_to_markdown() -> None:
    fixture = Path(__file__).parent / "fixtures" / "web_page.html"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            content=fixture.read_bytes(),
            request=request,
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = fetchUrl(
        "https://example.test/read#section",
        httpClient=client,
        resolver=lambda _hostname, _port: ["93.184.216.34"],
    )

    assert result["requestedUrl"] == "https://example.test/read"
    assert result["title"] == "Fixture page"
    assert "# Study title" in result["text"]
    assert "**useful**" in result["text"]
    assert "[the source](https://example.test/papers)" in result["text"]
    assert "- First point" in result["text"]
    assert "```\nprint(\"example\")\n```" in result["text"]
    assert "Navigation" not in result["text"]
    assert "shouldNotAppear" not in result["text"]
    assert result["truncated"] is False
    client.close()


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost/",
        "https://service.local/",
        "https://example.com:8443/",
    ],
)
def test_fetch_url_rejects_local_and_nonstandard_destinations(url: str) -> None:
    with pytest.raises(RepoError) as error:
        fetchUrl(url, resolver=lambda _hostname, _port: ["93.184.216.34"])

    assert error.value.code == "unsafe_url"


def test_fetch_url_rejects_hostnames_resolving_to_private_addresses() -> None:
    with pytest.raises(RepoError) as error:
        fetchUrl(
            "https://public-looking.example/",
            resolver=lambda _hostname, _port: ["10.0.0.8"],
        )

    assert error.value.code == "unsafe_url"


def test_fetch_url_validates_each_redirect_destination() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": "http://127.0.0.1/private"},
            request=request,
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RepoError) as error:
        fetchUrl(
            "https://example.test/start",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
        )

    assert error.value.code == "unsafe_url"
    assert calls == ["https://example.test/start"]
    client.close()


class _FakeNetworkStream:
    def __init__(self, server_addr: tuple[str, int]) -> None:
        self._server_addr = server_addr

    def get_extra(self, key: str) -> object:
        if key == "server_addr":
            return self._server_addr
        return None


class _PeerInjectingTransport(httpx.BaseTransport):
    def __init__(self, handler, server_addr: tuple[str, int]) -> None:
        self._handler = handler
        self._server_addr = server_addr

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        response = self._handler(request)
        response.extensions["network_stream"] = _FakeNetworkStream(self._server_addr)
        return response


class _AsyncPeerInjectingTransport(httpx.AsyncBaseTransport):
    def __init__(self, handler, server_addr: tuple[str, int]) -> None:
        self._handler = handler
        self._server_addr = server_addr

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._handler(request)
        response.extensions["network_stream"] = _FakeNetworkStream(self._server_addr)
        return response


def test_fetch_url_rejects_rebound_connection_to_private_peer() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            text="internal secret",
            request=request,
        )

    client = httpx.Client(
        transport=_PeerInjectingTransport(handler, ("127.0.0.1", 80))
    )
    with pytest.raises(RepoError) as error:
        fetchUrl(
            "https://public-looking.example/",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
        )

    assert error.value.code == "unsafe_url"
    client.close()


def test_fetch_url_rejects_rebound_redirect_from_private_peer() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        response = httpx.Response(
            302,
            headers={"location": "https://next.example/"},
            request=request,
        )
        response.extensions["network_stream"] = _FakeNetworkStream(
            ("127.0.0.1", 80)
        )
        return response

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RepoError) as error:
        fetchUrl(
            "https://public-looking.example/",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
        )

    assert error.value.code == "unsafe_url"
    assert calls == ["https://public-looking.example/"]
    client.close()


@pytest.mark.asyncio
async def test_async_fetch_rejects_rebound_connection_to_private_peer() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            text="internal secret",
            request=request,
        )

    client = httpx.AsyncClient(
        transport=_AsyncPeerInjectingTransport(handler, ("169.254.169.254", 80))
    )
    with pytest.raises(RepoError) as error:
        await fetchUrlAsync(
            "https://public-looking.example/",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
        )

    assert error.value.code == "unsafe_url"
    await client.aclose()


@pytest.mark.asyncio
async def test_async_fetch_rejects_rebound_redirect_from_private_peer() -> None:
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        response = httpx.Response(
            302,
            headers={"location": "https://next.example/"},
            request=request,
        )
        response.extensions["network_stream"] = _FakeNetworkStream(
            ("169.254.169.254", 80)
        )
        return response

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RepoError) as error:
        await fetchUrlAsync(
            "https://public-looking.example/",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
        )

    assert error.value.code == "unsafe_url"
    assert calls == ["https://public-looking.example/"]
    await client.aclose()


@pytest.mark.asyncio
async def test_async_fetch_cancels_an_in_flight_request() -> None:
    started = asyncio.Event()
    blocked = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await blocked.wait()
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            text="never returned",
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    cancel_event = asyncio.Event()
    task = asyncio.create_task(
        fetchUrlAsync(
            "https://example.test/",
            httpClient=client,
            resolver=lambda _hostname, _port: ["93.184.216.34"],
            cancelEvent=cancel_event,
        )
    )
    await asyncio.wait_for(started.wait(), 1)
    cancel_event.set()

    with pytest.raises(asyncio.CancelledError):
        await task

    await client.aclose()
