from __future__ import annotations

import os
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from refora_server.server.app import create_app, create_app_with_token


@pytest.fixture
def client_no_token():
    return TestClient(create_app_with_token(None))


@pytest.fixture
def client_with_token(tmp_path: Path):
    token = secrets.token_urlsafe(16)
    app = create_app_with_token(token, str(tmp_path / "refora.db"), str(tmp_path))
    with TestClient(app) as client:
        yield client, token


def test_health_ok_without_token(client_no_token):
    resp = client_no_token.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"ok": True, "data": {"status": "ok"}}


def test_health_envelope_shape(client_no_token):
    resp = client_no_token.get("/health")
    body = resp.json()
    assert body["ok"] is True
    assert isinstance(body["data"], dict)
    assert body["data"]["status"] == "ok"


def test_ready_rejected_without_token(client_with_token):
    client, _token = client_with_token
    resp = client.get("/ready")
    assert resp.status_code == 401


def test_ready_accepted_with_valid_token(client_with_token):
    client, token = client_with_token
    resp = client.get("/ready", headers={"X-Refora-Token": token})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "ready"
    assert data["protocolVersion"] == 1
    assert len(data["protocolDigest"]) == 64


def test_ready_rejected_with_wrong_token(client_with_token):
    client, _token = client_with_token
    resp = client.get("/ready", headers={"X-Refora-Token": "wrong"})
    assert resp.status_code == 401


def test_token_disabled_rejects_ready(client_no_token):
    resp = client_no_token.get("/ready")
    assert resp.status_code == 401


def test_create_app_requires_env_token(monkeypatch):
    monkeypatch.delenv("REFORA_SERVER_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="REFORA_SERVER_TOKEN"):
        create_app()
