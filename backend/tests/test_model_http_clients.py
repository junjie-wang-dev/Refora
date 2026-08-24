from __future__ import annotations

import asyncio

from refora_server.services.model_http_clients import (
    MODEL_HTTP_TIMEOUT,
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


def test_model_http_client_pool_applies_explicit_timeout() -> None:
    pool = create_model_http_client_pool()

    options = pool["modelOptions"]("socks5://127.0.0.1:1080")

    assert options["http_client"].timeout == MODEL_HTTP_TIMEOUT
    assert options["http_async_client"].timeout == MODEL_HTTP_TIMEOUT
    assert MODEL_HTTP_TIMEOUT.connect == 5.0
    assert MODEL_HTTP_TIMEOUT.read == 120.0
    assert MODEL_HTTP_TIMEOUT.write == 30.0
    assert MODEL_HTTP_TIMEOUT.pool == 5.0
    asyncio.run(pool["destroy"]())
