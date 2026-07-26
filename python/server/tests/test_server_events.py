from __future__ import annotations

import asyncio

import pytest

from refora_server.server.events import EventBus


class Socket:
    def __init__(self, fails: bool = False) -> None:
        self.fails = fails
        self.messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        if self.fails:
            raise RuntimeError("closed")
        self.messages.append(message)


@pytest.mark.asyncio
async def test_broadcast_reaches_only_topic_subscribers():
    events = EventBus()
    subscribed = Socket()
    other = Socket()

    assert await events.subscribe(subscribed, ["ai.chat.token", "ai.chat.token"]) == ["ai.chat.token"]
    await events.subscribe(other, ["document.updated"])
    await events.broadcast("ai.chat.token", {"delta": "hello"})

    assert subscribed.messages == [{"event": "ai.chat.token", "data": {"delta": "hello"}}]
    assert other.messages == []


@pytest.mark.asyncio
async def test_unsubscribe_and_cleanup_remove_connections():
    events = EventBus()
    socket = Socket()

    await events.subscribe(socket, ["topic.one", "topic.two"])
    assert await events.unsubscribe(socket, ["topic.one"]) == ["topic.one"]
    await events.broadcast("topic.one", {})
    await events.broadcast("topic.two", {})
    await events.cleanup(socket)
    await events.broadcast("topic.two", {})

    assert socket.messages == [{"event": "topic.two", "data": {}}]


@pytest.mark.asyncio
async def test_send_failure_removes_connection():
    events = EventBus()
    failed = Socket(fails=True)

    await events.subscribe(failed, ["topic"])
    await events.broadcast("topic", {"value": 1})
    failed.fails = False
    await events.broadcast("topic", {"value": 2})

    assert failed.messages == []


@pytest.mark.asyncio
async def test_wait_for_subscriber_unblocks_after_topic_subscription():
    events = EventBus()
    socket = Socket()
    waiter = asyncio.create_task(events.wait_for_subscriber("connector.decrypt-api-key"))

    await asyncio.sleep(0)
    assert not waiter.done()
    await events.subscribe(socket, ["connector.decrypt-api-key"])
    await asyncio.wait_for(waiter, timeout=0.2)
