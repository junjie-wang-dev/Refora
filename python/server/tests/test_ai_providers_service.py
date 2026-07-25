import sqlite3
import tempfile
from pathlib import Path

import pytest

from refora_server.db.connection import open_database
from refora_server.repositories.ai_providers import createAiProvidersRepository
from refora_server.services.ai_providers import createAiProvidersService


@pytest.fixture
def db():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d) / "test.db")
        conn, _ = open_database(path)
        conn.row_factory = sqlite3.Row
        yield conn
        conn.close()


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self):
        return self._body


class _FakeClient:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs
        self.get_calls: list[tuple[str, dict[str, str]]] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, headers=None):
        self.get_calls.append((url, headers or {}))
        return self._respond(url, headers or {})

    _routes: dict[str, "_FakeClient"] = {}

    @classmethod
    def register(cls, base_url, responder):
        cls._routes[base_url] = responder

    @classmethod
    def reset(cls):
        cls._routes.clear()

    def _respond(self, url, headers):
        for base, responder in _FakeClient._routes.items():
            if url.startswith(base):
                return responder.get(url, headers)
        return _FakeResponse(404, {})


def _make_provider_repo(db):
    return createAiProvidersRepository(db)


def _make_provider(db, **overrides):
    repo = _make_provider_repo(db)
    base = {
        "presetId": "openai",
        "name": "My OpenAI",
        "baseUrl": "https://api.openai.com/v1",
        "apiProtocol": "openai-responses",
        "reasoningControl": "openai",
        "reasoningEffort": "medium",
        "model": "gpt-5.6-terra",
        "models": ["gpt-5.6-terra"],
        "baseModel": "gpt-5.6-terra",
        "variant": "",
        "variantFormat": "dash",
        "apiKeyEnc": b"enc",
        "temperature": 0.7,
        "maxTokens": 4096,
    }
    base.update(overrides)
    return repo["create"](base)


def _service(db, responder=None):
    if responder is not None:
        _FakeClient.reset()
        _FakeClient.register("https://api.openai.com/v1", responder)
    deps = {"client_factory": lambda _: _FakeClient}
    repos = {"aiProviders": _make_provider_repo(db)}
    return createAiProvidersService(repos, deps)


def test_test_provider_ok_returns_model(db):
    provider = _make_provider(db)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(
        200, {"data": [{"id": "gpt-5.6-terra"}, {"id": "gpt-5.4-mini"}]}
    )
    svc = _service(db, responder)
    result = svc["testProvider"](provider["id"], "sk-test")
    assert result == {"ok": True, "model": "gpt-5.6-terra"}


def test_test_provider_missing_returns_ok_false(db):
    svc = _service(db)
    assert svc["testProvider"]("missing", "sk-test") == {"ok": False}


def test_test_provider_http_error_returns_ok_false(db):
    provider = _make_provider(db)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(401, {})
    svc = _service(db, responder)
    assert svc["testProvider"](provider["id"], "sk-bad") == {"ok": False}


def test_test_provider_required_key_absent_returns_ok_false(db):
    provider = _make_provider(db, presetId="openai", apiKeyEnc=None)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(200, {"data": [{"id": "x"}]})
    svc = _service(db, responder)
    assert svc["testProvider"](provider["id"], "") == {"ok": False}


def test_test_provider_ollama_no_key_ok(db):
    provider = _make_provider(
        db,
        presetId="ollama-local",
        baseUrl="http://localhost:11434/v1",
        apiProtocol="openai-compatible",
        reasoningControl="openai",
        apiKeyEnc=None,
        model="gpt-oss:20b",
        baseModel="gpt-oss:20b",
    )
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(
        200, {"data": [{"id": "gpt-oss:20b"}]}
    )
    deps = {"client_factory": lambda _: _FakeClient}
    _FakeClient.reset()
    _FakeClient.register("http://localhost:11434/v1", responder)
    repos = {"aiProviders": _make_provider_repo(db)}
    svc = createAiProvidersService(repos, deps)
    result = svc["testProvider"](provider["id"], "")
    assert result == {"ok": True, "model": "gpt-oss:20b"}


def test_list_models_returns_sorted_ids(db):
    provider = _make_provider(db)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(
        200, {"data": [{"id": "zeta"}, {"id": "alpha"}, {"id": "alpha"}]}
    )
    svc = _service(db, responder)
    result = svc["listModels"](provider["id"], "sk-test")
    assert result["ok"] is True
    assert result["models"] == ["alpha", "zeta"]


def test_list_models_missing_provider(db):
    svc = _service(db)
    result = svc["listModels"]("missing", "sk-test")
    assert result["ok"] is False
    assert result["models"] == []
    assert "not found" in result["error"].lower()


def test_list_models_required_key_absent(db):
    provider = _make_provider(db, presetId="openai", apiKeyEnc=None)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(200, {"data": [{"id": "x"}]})
    svc = _service(db, responder)
    result = svc["listModels"](provider["id"], "")
    assert result["ok"] is False
    assert "api key" in result["error"].lower()


def test_list_models_http_error_returns_error(db):
    provider = _make_provider(db)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(500, {})
    svc = _service(db, responder)
    result = svc["listModels"](provider["id"], "sk-test")
    assert result["ok"] is False
    assert result["models"] == []
    assert "HTTP 500" in result["error"]


def test_list_models_filters_non_string_ids(db):
    provider = _make_provider(db)
    responder = _FakeClient()
    responder._respond = lambda url, headers: _FakeResponse(
        200, {"data": [{"id": "valid"}, {"name": "no-id"}, {"id": 123}]}
    )
    svc = _service(db, responder)
    result = svc["listModels"](provider["id"], "sk-test")
    assert result["models"] == ["valid"]


def test_list_models_sends_bearer_header(db):
    provider = _make_provider(db)
    captured: dict[str, str] = {}

    class _Capture(_FakeClient):
        def get(self, url, headers=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            return _FakeResponse(200, {"data": [{"id": "m"}]})

    deps = {"client_factory": lambda _: _Capture}
    repos = {"aiProviders": _make_provider_repo(db)}
    svc = createAiProvidersService(repos, deps)
    svc["listModels"](provider["id"], "sk-secret")
    assert captured["url"] == "https://api.openai.com/v1/models"
    assert captured["headers"]["Authorization"] == "Bearer sk-secret"


def test_list_models_no_key_for_ollama_omits_header(db):
    provider = _make_provider(
        db,
        presetId="ollama-local",
        baseUrl="http://localhost:11434/v1",
        apiProtocol="openai-compatible",
        reasoningControl="openai",
        apiKeyEnc=None,
        model="gpt-oss:20b",
        baseModel="gpt-oss:20b",
    )
    captured: dict[str, str] = {}

    class _Capture(_FakeClient):
        def get(self, url, headers=None):
            captured["headers"] = headers or {}
            return _FakeResponse(200, {"data": [{"id": "m"}]})

    deps = {"client_factory": lambda _: _Capture}
    repos = {"aiProviders": _make_provider_repo(db)}
    svc = createAiProvidersService(repos, deps)
    svc["listModels"](provider["id"], "")
    assert "Authorization" not in captured["headers"]


def test_get_provider_returns_mapped_provider_without_key(db):
    provider = _make_provider(db)
    svc = _service(db)
    result = svc["getProvider"](provider["id"])
    assert result["id"] == provider["id"]
    assert result["model"] == "gpt-5.6-terra"
    assert "apiKeyEnc" not in result


def test_get_provider_missing_raises(db):
    from refora_server.repositories.errors import RepoError

    svc = _service(db)
    with pytest.raises(RepoError):
        svc["getProvider"]("missing")
