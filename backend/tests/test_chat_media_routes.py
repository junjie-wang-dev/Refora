import base64

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from refora_server.server.routes.ai import create_ai_router
from refora_server.services.chat_media import create_chat_media_service


@pytest.fixture
def client(tmp_path):
    service = create_chat_media_service(str(tmp_path), {}, {})

    async def authorize(request):
        if request.headers.get("X-Refora-Token") != "local-test":
            raise HTTPException(status_code=401, detail="Token required")

    app = FastAPI()
    app.include_router(create_ai_router({"repos": {}, "services": {"chatMedia": service}, "require_token": authorize}))
    with TestClient(app, headers={"X-Refora-Token": "local-test"}) as result:
        yield result


def test_media_resource_roundtrip_and_range_response(client):
    content = b"\x89PNG\r\n\x1a\n" + b"image payload"
    response = client.post("/ai/media/resolve", json={
        "source": {"type": "inline", "dataUrl": "data:image/png;base64," + base64.b64encode(content).decode()},
        "fileName": "chart.png",
    })
    assert response.status_code == 200
    resource = response.json()["data"]
    assert "path" not in resource
    assert resource["url"] == f"refora-asset://media/{resource['id']}"
    assert resource["kind"] == "image"
    resolved = client.get(f"/ai/media/{resource['id']}").json()["data"]
    assert resolved["path"].endswith("chart.png")
    data = client.get(f"/ai/media/{resource['id']}/content")
    assert data.content == content
    assert data.headers["content-type"] == "image/png"
    assert data.headers["x-content-type-options"] == "nosniff"
    partial = client.get(f"/ai/media/{resource['id']}/content", headers={"Range": "bytes=0-7"})
    assert partial.status_code == 206
    assert partial.content == content[:8]
    cached = client.post("/ai/media/resolve", json={"source": {"type": "cached", "mediaId": resource["id"]}}).json()["data"]
    assert cached == resource


def test_media_text_preview_and_missing_media_errors(client):
    content = "method,score\nRefora,95\n"
    resource = client.post("/ai/media/resolve", json={
        "source": {"type": "inline", "dataUrl": "data:text/csv;base64," + base64.b64encode(content.encode()).decode()},
        "fileName": "results.csv",
    }).json()["data"]
    preview = client.get(f"/ai/media/{resource['id']}/text")
    assert preview.json()["data"] == {"content": content, "truncated": False}
    content_response = client.get(f"/ai/media/{resource['id']}/content")
    assert content_response.headers["content-type"] == "application/octet-stream"
    missing = client.get(f"/ai/media/{'a' * 64}/content")
    assert missing.status_code == 404
    assert missing.json()["ok"] is False


def test_media_endpoints_require_token_and_reject_unsafe_requests(client):
    for path in [f"/ai/media/{'a' * 64}", f"/ai/media/{'a' * 64}/content", f"/ai/media/{'a' * 64}/text"]:
        assert client.get(path, headers={"X-Refora-Token": "wrong"}).status_code == 401
    assert client.post("/ai/media/resolve", headers={"X-Refora-Token": "wrong"}, json={}).status_code == 401
    for body in [
        {"source": {"type": "remote", "url": "http://127.0.0.1/private"}},
        {"source": {"type": "cached", "mediaId": "../secret"}},
        {"source": {"type": "inline", "dataUrl": "data:text/html;base64,PHNjcmlwdD4="}},
        {"source": {}, "path": "/tmp/secret"},
    ]:
        response = client.post("/ai/media/resolve", json=body)
        assert response.status_code == 400
        assert response.json()["ok"] is False
