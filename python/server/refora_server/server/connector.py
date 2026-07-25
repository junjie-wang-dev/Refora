from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from refora_server.server.events import EventBus

CONNECTOR_EVENTS = frozenset(
    {
        "connector.trash-item",
        "connector.open-path",
        "connector.show-in-folder",
        "connector.dialog-open-directory",
        "connector.clipboard-write",
        "connector.get-api-key",
    }
)

Result = dict[str, Any]


class ConnectorBroker:
    def __init__(self, events: EventBus, timeout: float = 30.0) -> None:
        self._events = events
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[Result]] = {}

    async def send(self, event: str, data: Mapping[str, Any] | None = None) -> Result:
        if event not in CONNECTOR_EVENTS:
            return self._error("unknown_connector", f"Unknown connector event: {event}")
        request_id = str(uuid4())
        future: asyncio.Future[Result] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        payload = {"requestId": request_id, **(dict(data) if data else {})}
        try:
            await self._events.broadcast(event, payload)
            return await asyncio.wait_for(asyncio.shield(future), self._timeout)
        except TimeoutError:
            return self._error("connector_timeout", "Connector request timed out")
        finally:
            self._pending.pop(request_id, None)

    async def trash_item(self, path: str) -> Result:
        return await self.send("connector.trash-item", {"path": path})

    async def open_path(self, path: str) -> Result:
        return await self.send("connector.open-path", {"path": path})

    async def show_in_folder(self, path: str) -> Result:
        return await self.send("connector.show-in-folder", {"path": path})

    async def dialog_open_directory(self, title: str | None = None) -> Result:
        data = {"title": title} if title is not None else {}
        return await self.send("connector.dialog-open-directory", data)

    async def clipboard_write(self, text: str) -> Result:
        return await self.send("connector.clipboard-write", {"text": text})

    async def get_api_key(self, provider_id: str) -> Result:
        return await self.send("connector.get-api-key", {"providerId": provider_id})

    def handle_result(self, data: Any) -> bool:
        if not isinstance(data, Mapping):
            return False
        request_id = data.get("requestId")
        if not isinstance(request_id, str):
            return False
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result({"ok": True, "data": data.get("data")})
        return True

    def handle_error(self, data: Any) -> bool:
        if not isinstance(data, Mapping):
            return False
        request_id = data.get("requestId")
        error = data.get("error")
        if not isinstance(request_id, str) or not isinstance(error, Mapping):
            return False
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, str) or not isinstance(message, str):
            return False
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result({"ok": False, "error": {"code": code, "message": message}})
        return True

    def handle_reply(self, event: str, data: Any) -> bool:
        if event == "connector.result":
            return self.handle_result(data)
        if event == "connector.error":
            return self.handle_error(data)
        return False

    async def cancel_pending(self) -> None:
        pending = tuple(self._pending.values())
        for future in pending:
            if not future.done():
                future.set_result(self._error("connector_shutdown", "Server is shutting down"))
        await asyncio.sleep(0)

    @staticmethod
    def _error(code: str, message: str) -> Result:
        return {"ok": False, "error": {"code": code, "message": message}}


def create_connector_broker(events: EventBus, timeout: float = 30.0) -> ConnectorBroker:
    return ConnectorBroker(events, timeout)
