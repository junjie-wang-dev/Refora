from __future__ import annotations

import pytest
from fastapi import WebSocketDisconnect

from refora_server.server.events import EventBus
from refora_server.server.websocket import websocket_handler


class Socket:
    def __init__(self, messages: list[dict], token: str = "token") -> None:
        self.query_params = {"token": token}
        self._messages = iter(messages)
        self.accepted = False
        self.closed_code: int | None = None
        self.sent: list[dict] = []

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int) -> None:
        self.closed_code = code

    async def receive_json(self) -> dict:
        try:
            return next(self._messages)
        except StopIteration as error:
            raise WebSocketDisconnect(code=1000) from error

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class Connector:
    def __init__(self) -> None:
        self.replies: list[tuple[str, object]] = []

    def handle_reply(self, event: str, data: object) -> bool:
        self.replies.append((event, data))
        return True


@pytest.mark.asyncio
async def test_websocket_commands_and_connector_reply():
    events = EventBus()
    connector = Connector()
    socket = Socket(
        [
            {"event": "subscribe", "data": {"topics": ["ai.chat.token"]}},
            {"event": "ping"},
            {"event": "connector.result", "data": {"requestId": "request-1", "ok": True, "data": {}}},
            {"event": "unsubscribe", "data": {"topics": ["ai.chat.token"]}},
        ]
    )

    await websocket_handler(socket, events, connector, "token")
    await events.broadcast("ai.chat.token", {"delta": "after disconnect"})

    assert socket.accepted
    assert socket.sent == [
        {"event": "subscribed", "topics": ["ai.chat.token"]},
        {"event": "pong"},
        {"event": "unsubscribed", "topics": ["ai.chat.token"]},
    ]
    assert connector.replies == [
        ("connector.result", {"requestId": "request-1", "ok": True, "data": {}})
    ]


@pytest.mark.asyncio
async def test_websocket_rejects_invalid_token_before_accepting():
    socket = Socket([], token="wrong")

    await websocket_handler(socket, EventBus(), Connector(), "token")

    assert not socket.accepted
    assert socket.closed_code == 1008
