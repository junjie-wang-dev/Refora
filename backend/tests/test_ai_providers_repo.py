import sqlite3
import tempfile
from pathlib import Path

import pytest

from refora_server.db.connection import open_database
from refora_server.repositories.ai_providers import createAiProvidersRepository
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d) / "test.db")
        conn, _ = open_database(path)
        conn.row_factory = sqlite3.Row
        yield conn
        conn.close()


@pytest.fixture
def repo(db):
    return createAiProvidersRepository(db)


def _make_input(**overrides):
    base = {
        "presetId": "openai",
        "name": "My OpenAI",
        "baseUrl": "https://api.openai.com/v1",
        "apiProtocol": "openai-responses",
        "reasoningControl": "openai",
        "reasoningEffort": "medium",
        "model": "gpt-5.6-terra",
        "models": ["gpt-5.6-terra", "gpt-5.4-mini"],
        "baseModel": "gpt-5.6-terra",
        "variant": "",
        "variantFormat": "dash",
        "apiKeyEnc": b"\x01\x02\x03\x04encrypted",
        "temperature": 0.7,
        "maxTokens": 4096,
    }
    base.update(overrides)
    return base


def test_list_empty_returns_empty_list(repo):
    assert repo["list"]() == []


def test_create_returns_provider_with_mapped_fields(repo):
    provider = repo["create"](_make_input())
    assert provider["id"]
    assert provider["presetId"] == "openai"
    assert provider["name"] == "My OpenAI"
    assert provider["baseUrl"] == "https://api.openai.com/v1"
    assert provider["apiProtocol"] == "openai-responses"
    assert provider["reasoningControl"] == "openai"
    assert provider["reasoningEffort"] == "medium"
    assert provider["model"] == "gpt-5.6-terra"
    assert provider["models"] == ["gpt-5.6-terra", "gpt-5.4-mini"]
    assert provider["baseModel"] == "gpt-5.6-terra"
    assert provider["variant"] == ""
    assert provider["variantFormat"] == "dash"
    assert provider["temperature"] == 0.7
    assert provider["maxTokens"] == 4096
    assert provider["hasKey"] is True
    assert provider["createdAt"] > 0
    assert "apiKeyEnc" not in provider


def test_create_without_api_key_has_key_false(repo):
    provider = repo["create"](_make_input(apiKeyEnc=None))
    assert provider["hasKey"] is False


def test_create_uses_preset_defaults_when_fields_omitted(repo):
    provider = repo["create"](
        {
            "presetId": "glm",
            "name": "GLM",
            "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
            "model": "glm-5.2",
        }
    )
    assert provider["apiProtocol"] == "openai-compatible"
    assert provider["reasoningControl"] == "thinking"
    assert provider["reasoningEffort"] == "high"


def test_create_custom_preset_defaults(repo):
    provider = repo["create"](
        {
            "presetId": "custom",
            "name": "Custom",
            "baseUrl": "https://my.endpoint/v1",
            "model": "some-model",
        }
    )
    assert provider["apiProtocol"] == "openai-compatible"
    assert provider["reasoningControl"] == "openai"
    assert provider["reasoningEffort"] == "medium"


def test_get_returns_provider(repo):
    created = repo["create"](_make_input())
    fetched = repo["get"](created["id"])
    assert fetched is not None
    assert fetched["id"] == created["id"]
    assert fetched["name"] == "My OpenAI"
    assert "apiKeyEnc" not in fetched
    assert fetched["hasKey"] is True


def test_get_returns_none_for_missing_id(repo):
    assert repo["get"]("nonexistent-id") is None


def test_get_raw_returns_api_key_enc_bytes(repo):
    created = repo["create"](_make_input(apiKeyEnc=b"secret-bytes"))
    raw = repo["getRaw"](created["id"])
    assert raw is not None
    assert raw["apiKeyEnc"] == b"secret-bytes"
    assert "hasKey" not in raw
    assert raw["model"] == "gpt-5.6-terra"


def test_get_raw_returns_none_for_missing_id(repo):
    assert repo["getRaw"]("nonexistent-id") is None


def test_get_raw_preserves_null_api_key(repo):
    created = repo["create"](_make_input(apiKeyEnc=None))
    raw = repo["getRaw"](created["id"])
    assert raw is not None
    assert raw["apiKeyEnc"] is None


def test_api_key_enc_roundtrip_binary_blob(repo, db):
    key_blob = bytes(range(256))
    created = repo["create"](_make_input(apiKeyEnc=key_blob))
    raw = repo["getRaw"](created["id"])
    assert raw["apiKeyEnc"] == key_blob
    stored = db.execute(
        "SELECT apiKeyEnc FROM ai_providers WHERE id = ?", [created["id"]]
    ).fetchone()
    assert stored["apiKeyEnc"] == key_blob


def test_list_returns_all_ordered_by_createdAt(repo):
    first = repo["create"](_make_input(name="first"))
    second = repo["create"](_make_input(name="second", baseUrl="https://b.example/v1"))
    third = repo["create"](_make_input(name="third", baseUrl="https://c.example/v1"))
    providers = repo["list"]()
    assert [p["id"] for p in providers] == [first["id"], second["id"], third["id"]]


def test_update_changes_fields(repo):
    created = repo["create"](_make_input())
    updated = repo["update"](
        created["id"],
        {
            "name": "Renamed",
            "model": "gpt-5.4-mini",
            "temperature": 0.1,
            "maxTokens": 8192,
        },
    )
    assert updated["name"] == "Renamed"
    assert updated["model"] == "gpt-5.4-mini"
    assert updated["temperature"] == 0.1
    assert updated["maxTokens"] == 8192


def test_update_preset_and_protocol(repo):
    created = repo["create"](_make_input())
    updated = repo["update"](
        created["id"],
        {
            "presetId": "deepseek",
            "apiProtocol": "openai-compatible",
            "reasoningControl": "thinking",
            "reasoningEffort": "high",
        },
    )
    assert updated["presetId"] == "deepseek"
    assert updated["apiProtocol"] == "openai-compatible"
    assert updated["reasoningControl"] == "thinking"
    assert updated["reasoningEffort"] == "high"


def test_update_models_serializes_json(repo, db):
    created = repo["create"](_make_input())
    repo["update"](created["id"], {"models": ["a", "b", "c"]})
    raw = db.execute(
        "SELECT modelsJson FROM ai_providers WHERE id = ?", [created["id"]]
    ).fetchone()
    import json
    assert json.loads(raw["modelsJson"]) == ["a", "b", "c"]
    fetched = repo["get"](created["id"])
    assert fetched["models"] == ["a", "b", "c"]


def test_update_models_null_clears_field(repo):
    created = repo["create"](_make_input())
    repo["update"](created["id"], {"models": None})
    fetched = repo["get"](created["id"])
    assert fetched["models"] is None


def test_update_api_key_enc(repo):
    created = repo["create"](_make_input(apiKeyEnc=None))
    assert created["hasKey"] is False
    updated = repo["update"](created["id"], {"apiKeyEnc": b"new-key"})
    assert updated["hasKey"] is True
    raw = repo["getRaw"](created["id"])
    assert raw["apiKeyEnc"] == b"new-key"


def test_update_clears_api_key_enc(repo):
    created = repo["create"](_make_input(apiKeyEnc=b"original"))
    updated = repo["update"](created["id"], {"apiKeyEnc": None})
    assert updated["hasKey"] is False
    raw = repo["getRaw"](created["id"])
    assert raw["apiKeyEnc"] is None


def test_update_variant_and_format(repo):
    created = repo["create"](_make_input())
    updated = repo["update"](
        created["id"],
        {"baseModel": "gpt-5", "variant": "high", "variantFormat": "dash"},
    )
    assert updated["baseModel"] == "gpt-5"
    assert updated["variant"] == "high"
    assert updated["variantFormat"] == "dash"


def test_update_empty_patch_returns_current(repo):
    created = repo["create"](_make_input())
    updated = repo["update"](created["id"], {})
    assert updated["id"] == created["id"]
    assert updated["name"] == created["name"]


def test_update_missing_id_raises_not_found(repo):
    with pytest.raises(RepoError) as exc_info:
        repo["update"]("nonexistent", {"name": "x"})
    assert exc_info.value.code == "not_found"


def test_delete_removes_provider(repo):
    created = repo["create"](_make_input())
    repo["delete"](created["id"])
    assert repo["get"](created["id"]) is None
    assert repo["list"]() == []


def test_delete_missing_id_raises_not_found(repo):
    with pytest.raises(RepoError) as exc_info:
        repo["delete"]("nonexistent")
    assert exc_info.value.code == "not_found"


def test_unknown_protocol_defaults_to_compatible(repo):
    provider = repo["create"](
        _make_input(apiProtocol="unknown-protocol")
    )
    assert provider["apiProtocol"] == "openai-compatible"


def test_unknown_reasoning_effort_defaults_to_medium(repo):
    provider = repo["create"](
        _make_input(reasoningEffort="bogus")
    )
    assert provider["reasoningEffort"] == "medium"


def test_model_composed_from_base_and_variant(repo):
    provider = repo["create"](
        {
            "presetId": "openai",
            "name": "Variant",
            "baseUrl": "https://api.openai.com/v1",
            "model": "",
            "baseModel": "gpt-5",
            "variant": "high",
            "variantFormat": "colon",
        }
    )
    assert provider["model"] == "gpt-5:high"


def test_model_parsed_from_id_when_base_omitted(repo):
    provider = repo["create"](
        {
            "presetId": "openai",
            "name": "Parsed",
            "baseUrl": "https://api.openai.com/v1",
            "model": "deepseek-r1-high",
        }
    )
    assert provider["baseModel"] == "deepseek-r1"
    assert provider["variant"] == "high"


def test_models_deduped_and_trimmed(repo):
    provider = repo["create"](
        _make_input(models=["  a  ", "a", "b", ""])
    )
    assert provider["models"] == ["a", "b"]


def test_empty_models_list_becomes_null(repo):
    provider = repo["create"](_make_input(models=[]))
    assert provider["models"] is None
