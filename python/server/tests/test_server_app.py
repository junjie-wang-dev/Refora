from pathlib import Path

from fastapi.testclient import TestClient

from refora_server.server.app import create_app_with_token


def test_assembled_app_serves_authenticated_routes_and_websocket(tmp_path: Path) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))
    with TestClient(app) as client:
        assert client.get("/health").json() == {"ok": True, "data": {"status": "ok"}}
        assert client.get("/ready").status_code == 401
        headers = {"X-Refora-Token": "test-token"}
        assert client.get("/ready", headers=headers).json() == {"ok": True, "data": {"status": "ready"}}
        assert client.get("/documents", headers=headers).json() == {"ok": True, "data": []}
        with client.websocket_connect("/ws?token=test-token") as websocket:
            websocket.send_json({"event": "ping"})
            assert websocket.receive_json() == {"event": "pong"}
