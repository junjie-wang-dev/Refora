from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Any

from fastapi import WebSocket


class EventBus:
    def __init__(self) -> None:
        self._connections: dict[WebSocket, set[str]] = {}
        self._topics: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, connection: WebSocket, topics: Iterable[str]) -> list[str]:
        normalized = self._normalize_topics(topics)
        async with self._lock:
            connection_topics = self._connections.setdefault(connection, set())
            for topic in normalized:
                connection_topics.add(topic)
                self._topics.setdefault(topic, set()).add(connection)
        return normalized

    async def unsubscribe(self, connection: WebSocket, topics: Iterable[str]) -> list[str]:
        normalized = self._normalize_topics(topics)
        async with self._lock:
            connection_topics = self._connections.get(connection)
            if connection_topics is None:
                return normalized
            for topic in normalized:
                connection_topics.discard(topic)
                subscribers = self._topics.get(topic)
                if subscribers is None:
                    continue
                subscribers.discard(connection)
                if not subscribers:
                    self._topics.pop(topic, None)
            if not connection_topics:
                self._connections.pop(connection, None)
        return normalized

    async def cleanup(self, connection: WebSocket) -> None:
        async with self._lock:
            topics = self._connections.pop(connection, set())
            for topic in topics:
                subscribers = self._topics.get(topic)
                if subscribers is None:
                    continue
                subscribers.discard(connection)
                if not subscribers:
                    self._topics.pop(topic, None)

    async def remove_connection(self, connection: WebSocket) -> None:
        await self.cleanup(connection)

    async def broadcast(self, event: str, data: Any) -> None:
        async with self._lock:
            connections = tuple(self._topics.get(event, ()))
        failures = await asyncio.gather(
            *(connection.send_json({"event": event, "data": data}) for connection in connections),
            return_exceptions=True,
        )
        for connection, result in zip(connections, failures, strict=True):
            if isinstance(result, BaseException):
                await self.cleanup(connection)

    async def publish(self, event: str, data: Any) -> None:
        await self.broadcast(event, data)

    @staticmethod
    def _normalize_topics(topics: Iterable[str]) -> list[str]:
        seen: set[str] = set()
        normalized: list[str] = []
        for topic in topics:
            if not isinstance(topic, str) or not topic or topic in seen:
                continue
            seen.add(topic)
            normalized.append(topic)
        return normalized


def create_event_bus() -> EventBus:
    return EventBus()
