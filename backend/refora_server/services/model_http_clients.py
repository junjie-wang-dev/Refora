from __future__ import annotations

import threading
from typing import Any

import httpx

from refora_server.services.proxy import normalize_proxy_rules


def create_model_http_client_pool() -> dict[str, Any]:
    clients: dict[str, tuple[httpx.Client, httpx.AsyncClient]] = {}
    lock = threading.Lock()

    def model_options(proxy: str) -> dict[str, Any]:
        normalized = normalize_proxy_rules(proxy)
        if not normalized:
            return {}
        with lock:
            pair = clients.get(normalized)
            if pair is None:
                pair = (
                    httpx.Client(proxy=normalized),
                    httpx.AsyncClient(proxy=normalized),
                )
                clients[normalized] = pair
        return {
            "http_client": pair[0],
            "http_async_client": pair[1],
        }

    async def destroy() -> None:
        with lock:
            pending = list(clients.values())
            clients.clear()
        for sync_client, async_client in pending:
            sync_client.close()
            await async_client.aclose()

    return {
        "modelOptions": model_options,
        "destroy": destroy,
    }


__all__ = ["create_model_http_client_pool"]
