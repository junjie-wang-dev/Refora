from pathlib import Path

from fastapi.testclient import TestClient

from refora_server.server.app import _loopback_origins, create_app_with_token
from refora_server.server.contract import source_contract


def test_loopback_origins_reject_non_loopback_override(monkeypatch) -> None:
    monkeypatch.setenv(
        "REFORA_CORS_ORIGINS",
        "http://localhost:5173,https://evil.example.com,file:///etc/passwd",
    )
    assert _loopback_origins() == ["http://localhost:5173"]


def test_loopback_origins_fall_back_to_defaults_when_nothing_valid(monkeypatch) -> None:
    monkeypatch.setenv("REFORA_CORS_ORIGINS", "https://evil.example.com")
    origins = _loopback_origins()
    assert "http://127.0.0.1" in origins
    assert "http://localhost" in origins


def test_assembled_app_serves_authenticated_routes_websocket_and_ocr_services(tmp_path: Path) -> None:
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))
    with TestClient(app) as client:
        assert client.get("/health").json() == {"ok": True, "data": {"status": "ok"}}
        assert client.get("/ready").status_code == 401
        headers = {"X-Refora-Token": "test-token"}
        assert client.get("/ready", headers=headers).json() == {
            "ok": True,
            "data": {
                "status": "ready",
                "protocolVersion": source_contract()["protocolVersion"],
                "protocolDigest": source_contract()["protocolDigest"],
            },
        }
        assert client.get("/documents", headers=headers).json() == {"ok": True, "data": []}
        mineru = client.get("/mineru/status", headers=headers)
        assert mineru.json()["data"]["state"] == "notInstalled"
        ocr = client.get("/ocr/state", headers=headers)
        assert ocr.json()["data"] == {"engine": mineru.json()["data"], "activeJob": None}
        with client.websocket_connect("/ws", subprotocols=["refora-token.test-token"]) as websocket:
            websocket.send_json({"event": "ping"})
            assert websocket.receive_json() == {"event": "pong"}


def test_assembled_app_reports_missing_mineru_worker_as_unavailable(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REFORA_MINERU_WORKER_PATH", str(tmp_path / "missing-worker.py"))
    app = create_app_with_token("test-token", str(tmp_path / "refora.db"), str(tmp_path))

    with TestClient(app) as client:
        response = client.get("/ocr/state", headers={"X-Refora-Token": "test-token"})

    assert response.status_code == 503
    assert response.json() == {
        "ok": False,
        "error": {"code": "unavailable", "message": "OCR service is unavailable: MinerU worker script is missing"},
    }
