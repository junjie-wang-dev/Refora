from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
WEBSOCKET_PATH = "/ws"
SERVER_EVENTS = (
    "ai.chat.token",
    "ai.chat.reasoning",
    "ai.chat.done",
    "ai.chat.error",
    "ai.chat.trace",
    "ai.chat.interrupted",
    "ai.chat.run-status",
    "ai.chat.title-updated",
    "ai.chat.interrupt-request",
    "ai.chat.interrupt-resolve",
    "ai.summary.updated",
    "ai.summary.error",
    "ai.report.created",
    "document.updated",
    "library.scanning",
    "library.switched",
    "window.focus-changed",
    "import.progress",
    "import.toast",
    "workspace.items.changed",
    "mineru.install-progress",
    "ocr.progress",
    "ocr.completed",
    "ocr.error",
)
CONNECTOR_EVENTS = (
    "connector.trash-item",
    "connector.open-path",
    "connector.show-in-folder",
    "connector.dialog-open-directory",
    "connector.dialog-open-file",
    "connector.dialog-choose",
    "connector.clipboard-write",
    "connector.clipboard-write-file",
    "connector.encrypt-api-key",
    "connector.decrypt-api-key",
    "connector.apply-proxy",
)
CLIENT_WEBSOCKET_EVENTS = (
    "subscribe",
    "unsubscribe",
    "ping",
    "connector.result",
    "connector.error",
)
SERVER_WEBSOCKET_EVENTS = (
    "subscribed",
    "unsubscribed",
    "pong",
)


def _route(method: str, path: str) -> dict[str, str]:
    return {"method": method, "path": path}


def source_http_routes() -> list[dict[str, str]]:
    server_root = Path(__file__).resolve().parent
    paths = [server_root / "app.py", *(server_root / "routes").glob("*.py")]
    routes: set[tuple[str, str]] = set()
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if (
                    not isinstance(decorator, ast.Call)
                    or not isinstance(decorator.func, ast.Attribute)
                    or decorator.func.attr not in {"get", "post", "put", "patch", "delete"}
                    or not decorator.args
                    or not isinstance(decorator.args[0], ast.Constant)
                    or not isinstance(decorator.args[0].value, str)
                ):
                    continue
                routes.add((decorator.func.attr.upper(), decorator.args[0].value))
    return [_route(method, path) for method, path in sorted(routes)]


def runtime_http_routes(app: Any) -> list[dict[str, str]]:
    from fastapi.routing import APIRoute, iter_route_contexts

    routes = {
        (method, route.path)
        for route in iter_route_contexts(app.routes)
        if isinstance(route.original_route, APIRoute) and route.path is not None
        for method in route.methods or set()
        if method in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    }
    return [_route(method, path) for method, path in sorted(routes)]


def _payload(http_routes: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "httpRoutes": http_routes,
        "websocketPath": WEBSOCKET_PATH,
        "serverEvents": list(SERVER_EVENTS),
        "connectorEvents": list(CONNECTOR_EVENTS),
        "clientWebsocketEvents": list(CLIENT_WEBSOCKET_EVENTS),
        "serverWebsocketEvents": list(SERVER_WEBSOCKET_EVENTS),
    }


def _digest(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def source_contract() -> dict[str, Any]:
    payload = _payload(source_http_routes())
    return {**payload, "protocolDigest": _digest(payload)}


def runtime_contract(app: Any) -> dict[str, Any]:
    payload = _payload(runtime_http_routes(app))
    return {**payload, "protocolDigest": _digest(payload)}
