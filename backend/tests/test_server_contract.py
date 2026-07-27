from pathlib import Path

from fastapi.testclient import TestClient

from refora_server.server.app import create_app_with_token
from refora_server.server.contract import (
    CONNECTOR_EVENTS,
    SERVER_EVENTS,
    runtime_http_routes,
    source_http_routes,
)


def test_source_contract_matches_the_assembled_fastapi_application(tmp_path: Path) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))
    with TestClient(app):
        assert runtime_http_routes(app) == source_http_routes()


def test_event_contract_has_no_duplicates() -> None:
    assert len(SERVER_EVENTS) == len(set(SERVER_EVENTS))
    assert len(CONNECTOR_EVENTS) == len(set(CONNECTOR_EVENTS))
    assert set(SERVER_EVENTS).isdisjoint(CONNECTOR_EVENTS)
