from __future__ import annotations

import asyncio
import os
from typing import Any

from refora_server.academic import (
    create_academic_cache,
    create_academic_graph_service,
    create_academic_identity_service,
    create_arxiv_client,
    create_arxiv_paper_service,
    create_research_frontier_service,
    create_semantic_scholar_client,
)
from refora_server.academic.arxiv import FetchResponse
from refora_server.services.academic_serializer import (
    serialize_arxiv_search_response,
    serialize_paper,
    serialize_paper_fulltext_response,
    serialize_semantic_recommendations_response,
)


def create_academic_runtime(
    repos: dict[str, Any],
    library_folder: str,
    get_proxy: Any,
    factories: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if "documents" not in repos:
        return {"services": {}}

    async def academic_fetch(url: str, options: dict[str, Any]) -> FetchResponse:
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError("Academic network support is unavailable") from exc
        signal = options.get("signal")
        if isinstance(signal, asyncio.Event) and signal.is_set():
            raise asyncio.CancelledError()
        timeout_ms = options.get("timeout_ms")
        timeout = (
            max(1, int(timeout_ms)) / 1000
            if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool)
            else 20.0
        )
        headers = options.get("headers")
        request_headers = headers if isinstance(headers, dict) else None
        proxy = get_proxy()
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=options.get("follow_redirects") is True,
            **({"proxy": proxy} if proxy else {}),
        ) as client:
            request_task = asyncio.create_task(client.get(url, headers=request_headers))
            if isinstance(signal, asyncio.Event):
                cancel_task = asyncio.create_task(signal.wait())
                done, _ = await asyncio.wait(
                    {request_task, cancel_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if cancel_task in done and signal.is_set():
                    request_task.cancel()
                    await asyncio.gather(request_task, return_exceptions=True)
                    raise asyncio.CancelledError()
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)
            response = await request_task
        if isinstance(signal, asyncio.Event) and signal.is_set():
            raise asyncio.CancelledError()
        return FetchResponse(
            status=response.status_code,
            text=response.text,
            headers=dict(response.headers),
            final_url=str(response.url),
        )

    factories = factories or {}
    cache_factory = factories.get("cache", create_academic_cache)
    arxiv_factory = factories.get("arxiv", create_arxiv_client)
    semantic_scholar_factory = factories.get(
        "semantic_scholar", create_semantic_scholar_client
    )
    identity_factory = factories.get("identity", create_academic_identity_service)
    graph_factory = factories.get("graph", create_academic_graph_service)
    frontier_factory = factories.get("frontier", create_research_frontier_service)
    arxiv_papers_factory = factories.get("arxiv_papers", create_arxiv_paper_service)
    academic_cache = cache_factory(
        os.path.join(library_folder, ".refora", "academic-cache")
    )
    arxiv_client = arxiv_factory(academic_fetch, academic_cache)
    semantic_scholar_client = semantic_scholar_factory(
        academic_fetch, academic_cache
    )
    identity = identity_factory(
        repos["documents"], semantic_scholar_client
    )
    graph = graph_factory(identity, semantic_scholar_client)
    frontier = frontier_factory(
        identity,
        graph,
        arxiv_client,
        os.path.join(library_folder, ".refora", "academic-frontiers"),
    )
    arxiv_papers = arxiv_papers_factory(arxiv_client, academic_cache)

    async def search_arxiv(request: Any) -> dict[str, Any]:
        return serialize_arxiv_search_response(await arxiv_client.search(request))

    async def get_arxiv_by_id(arxiv_id: str) -> dict[str, Any] | None:
        paper = await arxiv_client.get_by_id(arxiv_id)
        return serialize_paper(paper, "arxiv") if paper is not None else None

    async def search_arxiv_title(title: str, page_size: int = 5) -> dict[str, Any]:
        return serialize_arxiv_search_response(
            await arxiv_client.search_title(title, page_size)
        )

    async def get_arxiv_paper(
        arxiv_id: str,
        section_id: str | None = None,
        cursor: str | None = None,
        max_chars: int | None = None,
    ) -> dict[str, Any]:
        return serialize_paper_fulltext_response(
            await arxiv_papers.get_paper(arxiv_id, section_id, cursor, max_chars)
        )

    async def get_semantic_recommendations(
        locator: Any, limit: int | None = None
    ) -> dict[str, Any]:
        return serialize_semantic_recommendations_response(
            await graph.get_recommendations(locator, limit)
        )

    services = {
        "arxiv": {
            "search": search_arxiv,
            "getById": get_arxiv_by_id,
            "searchTitle": search_arxiv_title,
        },
        "arxiv_papers": {"get_paper": get_arxiv_paper},
        "identity": identity,
        "graph": {
            "get_citing_papers": graph.get_citing_papers,
            "get_referenced_papers": graph.get_referenced_papers,
            "get_recommendations": get_semantic_recommendations,
        },
        "frontier": frontier,
    }
    return {
        "services": services,
        "arxiv": arxiv_client,
        "arxiv_papers": arxiv_papers,
        "identity": identity,
        "graph": graph,
        "frontier": frontier,
    }
