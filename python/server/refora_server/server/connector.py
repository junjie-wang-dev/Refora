from __future__ import annotations

import asyncio
import base64
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from refora_server.server.events import EventBus
from refora_server.server.contract import CONNECTOR_EVENTS

Result = dict[str, Any]


class ConnectorBroker:
    def __init__(self, events: EventBus, timeout: float = 30.0) -> None:
        self._events = events
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[Result]] = {}
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    async def send(self, event: str, data: Mapping[str, Any] | None = None) -> Result:
        if event not in CONNECTOR_EVENTS:
            return self._error("unknown_connector", f"Unknown connector event: {event}")
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
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

    async def dialog_open_file(
        self,
        title: str | None = None,
        extensions: list[str] | None = None,
        multiple: bool = False,
    ) -> Result:
        data: dict[str, Any] = {}
        if title is not None:
            data["title"] = title
        if extensions:
            data["extensions"] = extensions
        if multiple:
            data["multiple"] = True
        return await self.send("connector.dialog-open-file", data)

    async def dialog_choose(
        self,
        title: str,
        message: str,
        buttons: list[str],
        default_id: int = 0,
        cancel_id: int | None = None,
    ) -> Result:
        return await self.send(
            "connector.dialog-choose",
            {
                "title": title,
                "message": message,
                "buttons": buttons,
                "defaultId": default_id,
                "cancelId": len(buttons) - 1 if cancel_id is None else cancel_id,
            },
        )

    async def clipboard_write(self, text: str) -> Result:
        return await self.send("connector.clipboard-write", {"text": text})

    async def clipboard_write_file(self, path: str) -> Result:
        return await self.send("connector.clipboard-write-file", {"path": path})

    async def encrypt_api_key(self, api_key: str) -> Result:
        return await self.send("connector.encrypt-api-key", {"apiKey": api_key})

    async def decrypt_api_key(self, api_key_enc: bytes) -> Result:
        return await self.send(
            "connector.decrypt-api-key",
            {"apiKeyEnc": base64.b64encode(api_key_enc).decode("ascii")},
        )

    def decrypt_api_key_sync(self, api_key_enc: bytes, _provider: str | None = None) -> str:
        if not isinstance(api_key_enc, bytes) or not api_key_enc:
            raise ValueError("Encrypted API key must be non-empty bytes")
        loop = self._loop
        if loop is None or not loop.is_running():
            raise RuntimeError("Native connector event loop is unavailable")
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is loop:
            raise RuntimeError("Native key decryption must run outside the server event loop")
        future = asyncio.run_coroutine_threadsafe(
            self.decrypt_api_key(api_key_enc), loop
        )
        result = future.result(timeout=self._timeout + 1)
        if result.get("ok") is not True:
            error = result.get("error")
            message = (
                error.get("message")
                if isinstance(error, Mapping)
                else "Native key decryption failed"
            )
            raise RuntimeError(str(message))
        data = result.get("data")
        api_key = data.get("apiKey") if isinstance(data, Mapping) else None
        if not isinstance(api_key, str) or not api_key:
            raise RuntimeError("Native key storage returned an invalid payload")
        return api_key

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
