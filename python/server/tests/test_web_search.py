from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from refora_server.db.connection import _SqliteAdapter
from refora_server.db.errors import RepoError
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories
from refora_server.services.web_fetch import fetchUrl
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
        {"provider": "tavily", "tavilyApiKeyEnc": b"tavily-secret"}
    )

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
        {"getConfig": repos["webSearchConfig"]["get"], "httpClient": client},
    )

    assert service["search"]({"query": "literature", "maxResults": 3}) == [
        {
            "title": "Tavily result",
            "url": "https://example.com/tavily",
            "snippet": "Provider result",
            "publishedAt": "2026-07-01",
        }
    ]
    client.close()


def test_test_returns_a_single_probe_result(repos) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["q"] == "configured probe"
        return httpx.Response(200, text=DDG_HTML, request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    service = createWebSearchService(
        repos,
        {"getConfig": repos["webSearchConfig"]["get"], "httpClient": client},
    )

    results = service["test"]("configured probe")

    assert results == [
        {
            "title": "Example paper",
            "url": "https://example.com/paper",
            "snippet": "A concise result summary.",
        }
    ]
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
    result = fetchUrl("https://example.test/read#section", httpClient=client)

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
