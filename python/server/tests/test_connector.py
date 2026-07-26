from __future__ import annotations

import asyncio

import pytest

from refora_server.server.connector import ConnectorBroker
from refora_server.server.events import EventBus


class Socket:
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.sent = asyncio.Event()

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)
        self.sent.set()


@pytest.mark.asyncio
async def test_connector_request_is_correlated_with_result():
    events = EventBus()
    socket = Socket()
    broker = ConnectorBroker(events)
    await events.subscribe(socket, ["connector.trash-item"])
    
    pending = asyncio.create_task(broker.trash_item("/library/paper.pdf"))
    await asyncio.wait_for(socket.sent.wait(), 0.1)
    request = socket.messages[0]["data"]
    assert broker.handle_result({"requestId": request["requestId"], "ok": True, "data": {"ack": True}})

    assert await pending == {"ok": True, "data": {"ack": True}}
    assert request["path"] == "/library/paper.pdf"


@pytest.mark.asyncio
async def test_connector_can_encrypt_api_key_without_persisting_plaintext():
    events = EventBus()
    socket = Socket()
    broker = ConnectorBroker(events)
    await events.subscribe(socket, ["connector.encrypt-api-key"])

    pending = asyncio.create_task(broker.encrypt_api_key("sk-secret"))
    await asyncio.wait_for(socket.sent.wait(), 0.1)
    request = socket.messages[0]["data"]
    assert request["apiKey"] == "sk-secret"
    assert broker.handle_result(
        {
            "requestId": request["requestId"],
            "data": {"apiKeyEnc": "ZW5jcnlwdGVk"},
        }
    )

    assert await pending == {
        "ok": True,
        "data": {"apiKeyEnc": "ZW5jcnlwdGVk"},
    }


@pytest.mark.asyncio
async def test_connector_can_decrypt_api_key_from_a_worker_thread():
    events = EventBus()
    socket = Socket()
    broker = ConnectorBroker(events)
    await events.subscribe(socket, ["connector.decrypt-api-key"])

    pending = asyncio.create_task(
        asyncio.to_thread(broker.decrypt_api_key_sync, b"encrypted", "tavily")
    )
    await asyncio.wait_for(socket.sent.wait(), 0.1)
    request = socket.messages[0]["data"]
    assert request["apiKeyEnc"] == "ZW5jcnlwdGVk"
    assert broker.handle_result(
        {
            "requestId": request["requestId"],
            "data": {"apiKey": "tavily-secret"},
        }
    )

    assert await pending == "tavily-secret"


@pytest.mark.asyncio
async def test_connector_error_and_unknown_response_are_handled():
    events = EventBus()
    socket = Socket()
    broker = ConnectorBroker(events)
    await events.subscribe(socket, ["connector.open-path"])
    
    pending = asyncio.create_task(broker.open_path("/library/paper.pdf"))
    await asyncio.wait_for(socket.sent.wait(), 0.1)
    request_id = socket.messages[0]["data"]["requestId"]
    assert not broker.handle_error({"requestId": "unknown", "error": {"code": "x", "message": "x"}})
    assert broker.handle_error(
        {"requestId": request_id, "error": {"code": "native_error", "message": "Unavailable"}}
    )

    assert await pending == {
        "ok": False,
        "error": {"code": "native_error", "message": "Unavailable"},
    }


@pytest.mark.asyncio
async def test_connector_timeout_and_unknown_event_return_error_envelopes():
    broker = ConnectorBroker(EventBus(), timeout=0.001)

    assert await broker.send("connector.not-real") == {
        "ok": False,
        "error": {"code": "unknown_connector", "message": "Unknown connector event: connector.not-real"},
    }
    assert await broker.clipboard_write("copy") == {
        "ok": False,
        "error": {"code": "connector_timeout", "message": "Connector request timed out"},
    }
