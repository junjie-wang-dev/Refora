import ast
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from refora_server.server import contract as contract_module
from refora_server.server.app import create_app_with_token
from refora_server.server.contract import (
    CONNECTOR_EVENTS,
    SERVER_EVENTS,
    _endpoint_schema_digest,
    load_contract_snapshot,
    runtime_contract,
    runtime_http_routes,
    source_contract,
    source_http_routes,
)


def _schema_digest(source: str) -> str:
    node = ast.parse(source).body[0]
    assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    return _endpoint_schema_digest(node)


def test_source_contract_matches_the_assembled_fastapi_application(tmp_path: Path) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))
    with TestClient(app):
        assert runtime_http_routes(app) == source_http_routes()
        assert runtime_contract(app) == source_contract()


def test_runtime_contract_does_not_read_python_source(tmp_path: Path, monkeypatch) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))
    expected = load_contract_snapshot()
    monkeypatch.setattr(
        contract_module,
        "source_http_routes",
        lambda: pytest.fail("runtime contract must not read Python source"),
    )

    with TestClient(app):
        assert runtime_contract(app) == expected


def test_runtime_contract_rejects_routes_missing_from_snapshot(tmp_path: Path) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))

    @app.get("/unexpected-contract-route")
    async def unexpected_contract_route() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app), pytest.raises(RuntimeError, match="unexpected-contract-route"):
        runtime_contract(app)


def test_event_contract_has_no_duplicates() -> None:
    assert len(SERVER_EVENTS) == len(set(SERVER_EVENTS))
    assert len(CONNECTOR_EVENTS) == len(set(CONNECTOR_EVENTS))
    assert set(SERVER_EVENTS).isdisjoint(CONNECTOR_EVENTS)


def test_route_schema_digest_changes_with_request_or_response_contract() -> None:
    baseline = _schema_digest(
        "def endpoint(body: dict[str, str]) -> dict[str, str]:\n"
        "    return {'result': body['value']}\n"
    )
    request_changed = _schema_digest(
        "def endpoint(body: list[str]) -> dict[str, str]:\n"
        "    return {'result': body[0]}\n"
    )
    response_changed = _schema_digest(
        "def endpoint(body: dict[str, str]) -> dict[str, str]:\n"
        "    return {'message': body['value']}\n"
    )

    assert request_changed != baseline
    assert response_changed != baseline


def test_route_schema_digest_ignores_non_response_implementation_details() -> None:
    baseline = _schema_digest(
        "def endpoint(body: dict[str, str]) -> dict[str, str]:\n"
        "    intermediate = normalize(body)\n"
        "    return {'result': body['value']}\n"
    )
    changed = _schema_digest(
        "def endpoint(body: dict[str, str]) -> dict[str, str]:\n"
        "    intermediate = normalize_more_carefully(body)\n"
        "    return {'result': body['value']}\n"
    )

    assert changed == baseline
