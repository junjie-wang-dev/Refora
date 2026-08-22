from __future__ import annotations

import asyncio

from refora_server.services.model_http_clients import (
    create_model_http_client_pool,
)


def test_model_http_client_pool_reuses_and_closes_proxy_clients() -> None:
    pool = create_model_http_client_pool()

    first = pool["modelOptions"]("http://127.0.0.1:8080")
    repeated = pool["modelOptions"]("http://127.0.0.1:8080")
    second = pool["modelOptions"]("socks5://127.0.0.1:1080")

    assert repeated == first
    assert second["http_client"] is not first["http_client"]
    assert pool["modelOptions"]("") == {}
    asyncio.run(pool["destroy"]())
    assert first["http_client"].is_closed
    assert first["http_async_client"].is_closed
    assert second["http_client"].is_closed
    assert second["http_async_client"].is_closed
