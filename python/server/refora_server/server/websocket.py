from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect, status

from refora_server.server.connector import ConnectorBroker
from refora_server.server.events import EventBus

WebSocketHandler = Callable[[WebSocket], Awaitable[None]]


def _has_valid_token(websocket: WebSocket, token: str | None) -> bool:
    if token is None:
        return True
    return hmac.compare_digest(websocket.query_params.get("token", ""), token)


async def websocket_handler(
    websocket: WebSocket,
    events: EventBus,
    connector: ConnectorBroker,
    token: str | None = None,
) -> None:
    if not _has_valid_token(websocket, token):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            event = message.get("event")
            data = message.get("data")
            if event == "subscribe":
                topics = _topics_from(data)
                await events.subscribe(websocket, topics)
                await websocket.send_json({"event": "subscribed", "topics": topics})
            elif event == "unsubscribe":
                topics = _topics_from(data)
                await events.unsubscribe(websocket, topics)
                await websocket.send_json({"event": "unsubscribed", "topics": topics})
            elif event == "ping":
                await websocket.send_json({"event": "pong"})
            elif event in {"connector.result", "connector.error"}:
                connector.handle_reply(event, data)
    except WebSocketDisconnect:
        pass
    finally:
        await events.cleanup(websocket)


def create_websocket_handler(
    events: EventBus,
    connector: ConnectorBroker,
    token: str | None = None,
) -> WebSocketHandler:
    async def handler(websocket: WebSocket) -> None:
        await websocket_handler(websocket, events, connector, token)

    return handler


def _topics_from(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return []
    topics = data.get("topics")
    if not isinstance(topics, list):
        return []
    return [topic for topic in topics if isinstance(topic, str)]
