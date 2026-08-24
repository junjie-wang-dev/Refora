from __future__ import annotations

import ast
import hashlib
import json
from importlib import resources
from pathlib import Path
from typing import Any, cast

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
    "ai.summary.updated",
    "ai.summary.error",
    "ai.report.created",
    "document.updated",
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
CONTRACT_SNAPSHOT_NAME = "contract_snapshot.json"


def _endpoint_schema_digest(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    route_keywords = [
        keyword
        for decorator in node.decorator_list
        if isinstance(decorator, ast.Call)
        and isinstance(decorator.func, ast.Attribute)
        and decorator.func.attr in {"get", "post", "put", "patch", "delete"}
        for keyword in decorator.keywords
    ]
    returns = [
        candidate.value
        for candidate in ast.walk(node)
        if isinstance(candidate, ast.Return) and candidate.value is not None
    ]
    lambdas = [
        candidate.body
        for candidate in ast.walk(node)
        if isinstance(candidate, ast.Lambda)
    ]
    returned_names = {
        candidate.id
        for returned in returns
        for candidate in ast.walk(returned)
        if isinstance(candidate, ast.Name)
    }
    response_assignments: list[ast.expr] = []
    for candidate in ast.walk(node):
        if isinstance(candidate, ast.Assign):
            names = {
                target.id
                for target in candidate.targets
                if isinstance(target, ast.Name)
            }
            if names & returned_names:
                response_assignments.append(candidate.value)
        elif (
            isinstance(candidate, ast.AnnAssign)
            and isinstance(candidate.target, ast.Name)
            and candidate.target.id in returned_names
            and candidate.value is not None
        ):
            response_assignments.append(candidate.value)
    projection = {
        "arguments": ast.unparse(node.args),
        "returns": (
            ast.unparse(node.returns)
            if node.returns is not None
            else None
        ),
        "routeKeywords": [
            {
                "name": keyword.arg,
                "value": ast.unparse(keyword.value),
            }
            for keyword in route_keywords
        ],
        "returnValues": [
            ast.unparse(value)
            for value in returns
        ],
        "lambdaValues": [
            ast.unparse(value)
            for value in lambdas
        ],
        "responseAssignments": [
            ast.unparse(value)
            for value in response_assignments
        ],
    }
    encoded = json.dumps(
        projection,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _route(method: str, path: str, schema_digest: str) -> dict[str, str]:
    return {"method": method, "path": path, "schemaDigest": schema_digest}


def source_http_routes() -> list[dict[str, str]]:
    server_root = Path(__file__).resolve().parent
    paths = [
        server_root / "app.py",
        *(server_root / "routes").glob("*.py"),
        *(server_root / "services").glob("*_routes.py"),
    ]
    routes: dict[tuple[str, str], str] = {}
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
                routes[(decorator.func.attr.upper(), decorator.args[0].value)] = (
                    _endpoint_schema_digest(node)
                )
    return [
        _route(method, path, routes[(method, path)])
        for method, path in sorted(routes)
    ]


def _validate_runtime_http_routes(
    app: Any,
    snapshot_routes: list[dict[str, str]],
) -> None:
    from fastapi.routing import APIRoute, iter_route_contexts

    actual_routes = {
        (method, route.path)
        for route in iter_route_contexts(app.routes)
        if isinstance(route.original_route, APIRoute) and route.path is not None
        for method in route.methods or set()
        if method in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    }
    expected_routes = {
        (route["method"], route["path"])
        for route in snapshot_routes
    }
    if actual_routes != expected_routes:
        missing = sorted(expected_routes - actual_routes)
        unexpected = sorted(actual_routes - expected_routes)
        raise RuntimeError(
            "FastAPI routes do not match the packaged contract snapshot: "
            f"missing={missing}, unexpected={unexpected}"
        )


def runtime_http_routes(app: Any) -> list[dict[str, str]]:
    snapshot_routes = _snapshot_http_routes(load_contract_snapshot())
    _validate_runtime_http_routes(app, snapshot_routes)
    return snapshot_routes


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


def _snapshot_http_routes(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    routes = snapshot.get("httpRoutes")
    if not isinstance(routes, list):
        raise RuntimeError("Packaged contract snapshot has invalid HTTP routes")
    validated: list[dict[str, str]] = []
    for route in routes:
        if not isinstance(route, dict):
            raise RuntimeError("Packaged contract snapshot has invalid HTTP routes")
        method = route.get("method")
        path = route.get("path")
        schema_digest = route.get("schemaDigest")
        if not all(isinstance(value, str) for value in (method, path, schema_digest)):
            raise RuntimeError("Packaged contract snapshot has invalid HTTP routes")
        validated.append(
            _route(
                cast(str, method),
                cast(str, path),
                cast(str, schema_digest),
            )
        )
    return validated


def load_contract_snapshot() -> dict[str, Any]:
    try:
        encoded = (
            resources.files("refora_server.server")
            .joinpath(CONTRACT_SNAPSHOT_NAME)
            .read_text(encoding="utf-8")
        )
        snapshot = json.loads(encoded)
    except (FileNotFoundError, OSError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Packaged server contract snapshot is unavailable") from error
    if not isinstance(snapshot, dict):
        raise RuntimeError("Packaged server contract snapshot is invalid")
    protocol_digest = snapshot.get("protocolDigest")
    payload = {key: value for key, value in snapshot.items() if key != "protocolDigest"}
    if not isinstance(protocol_digest, str) or _digest(payload) != protocol_digest:
        raise RuntimeError("Packaged server contract snapshot digest is invalid")
    expected_static = _payload(_snapshot_http_routes(snapshot))
    if payload != expected_static:
        raise RuntimeError("Packaged server contract snapshot does not match server protocol constants")
    return snapshot


def source_contract() -> dict[str, Any]:
    payload = _payload(source_http_routes())
    return {**payload, "protocolDigest": _digest(payload)}


def runtime_contract(app: Any) -> dict[str, Any]:
    snapshot = load_contract_snapshot()
    _validate_runtime_http_routes(app, _snapshot_http_routes(snapshot))
    return snapshot
