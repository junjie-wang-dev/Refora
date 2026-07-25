from __future__ import annotations

from typing import Any, Literal

WebSearchProvider = Literal["disabled", "ddgs", "tavily", "brave"]

WEB_SEARCH_PROVIDERS: tuple[WebSearchProvider, ...] = (
    "disabled",
    "ddgs",
    "tavily",
    "brave",
)

WebSearchTimeRange = Literal["day", "week", "month", "year"]


class WebSearchConfig(dict):
    pass


class WebSearchConfigPatch(dict):
    pass


class WebSearchTestResult(dict):
    pass


class WebSearchRequest(dict):
    pass


class WebSearchResultItem(dict):
    pass


class WebSearchResponse(dict):
    pass


class WebFetchRequest(dict):
    pass


class WebFetchResponse(dict):
    pass


def is_valid_provider(provider: Any) -> bool:
    return provider in WEB_SEARCH_PROVIDERS