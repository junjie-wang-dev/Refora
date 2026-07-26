import base64
import json

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import refora_server.server.routes.library as library_routes
from refora_server.server.routes.library import create_library_router


class Fakes:
    def __init__(self):
        self.token_calls = 0
        self.trashed = []
        self.created_provider = None
        self.document_filter = None
        self.listed_documents = []
        self.clipboard_files = []
        self.documents = {
            "list": self.list_documents,
            "counts": lambda: {
                "all": 0,
                "recentlyRead": 0,
                "recentlyAdded": 0,
                "starred": 0,
            },
            "search": lambda _query, _limit: [],
            "get": self.get_document,
            "delete": self.delete_document,
            "setStarred": lambda _id, _starred: None,
            "update": lambda _id, patch: {"id": _id, **patch},
            "updateFilePath": lambda _id, _path, _name: None,
        }
        self.categories = {
            "list": lambda: [],
            "create": lambda name: {"id": "category-1", "name": name},
            "rename": lambda _id, _name: None,
            "delete": lambda _id: None,
            "assign": lambda _document_id, _category_id: None,
            "unassign": lambda _document_id, _category_id: None,
            "listForDocument": lambda _document_id: [],
        }
        self.importer = {
            "importFiles": lambda _paths: {"imported": [], "skipped": [], "errors": []},
            "importFolder": lambda _path, _recursive: {"imported": [], "skipped": [], "errors": []},
        }
        self.watcher = {
            "list": lambda: [],
            "add": lambda path: {"id": "watch-1", "path": path},
            "remove": lambda _id: None,
            "toggle": lambda watch_id, enabled: {"id": watch_id, "enabled": enabled},
        }
        self.library = {"switchLibrary": lambda _path: {"ack": True}}
        settings_values = {
            "language": json.dumps("en"),
            "sidebarCollapsed": json.dumps("0"),
            "libraryFolderPath": json.dumps(""),
            "windowBounds": json.dumps(None),
            "listColumnState": json.dumps(None),
            "theme": json.dumps("dark"),
        }
        self.settings = {
            "list": lambda: sorted(settings_values.items()),
            "get": lambda key, default=None: settings_values.get(key, default),
            "set": lambda key, value: settings_values.__setitem__(key, value),
        }
        self.web_search = {
            "getConfig": lambda: {"provider": "disabled"},
            "test": lambda _query: {
                "ok": False,
                "provider": "disabled",
                "resultCount": 0,
                "error": "Web search is disabled",
            },
        }
        self.web_search_config_data = {
            "provider": "disabled",
            "tavilyApiKeyEnc": None,
            "braveApiKeyEnc": None,
        }
        self.web_search_config = {
            "get": lambda: dict(self.web_search_config_data),
            "update": self.update_web_search_config,
        }
        self.web_search["getConfig"] = self.get_web_search_config
        self.ai_providers = {"list": lambda: [], "testProvider": lambda _id, _key: {"ok": True}, "listModels": lambda _id, _key: {"ok": True, "models": []}}
        self.ai_providers_repo = {"create": self.create_provider, "update": lambda _id, patch: patch, "delete": lambda _id: None}
        self.exporter = {"exportJson": lambda _ids, _workspace: {}, "exportBibtex": lambda _ids: {}, "getBibtexString": lambda _ids: {"bibtex": ""}}
        self.connector = {
            "trashItem": self.trash,
            "openPath": lambda _path: None,
            "showInFolder": lambda _path: None,
            "clipboardWrite": lambda _text: None,
            "clipboardWriteFile": self.copy_file_to_clipboard,
            "dialogOpenDirectory": lambda _title: {
                "ok": True,
                "data": {"canceled": True, "path": None},
            },
            "getApiKey": lambda _provider_id: {
                "ok": True,
                "data": {"apiKey": "stored-key"},
            },
            "encryptApiKey": lambda key: {
                "ok": True,
                "data": {
                    "apiKeyEnc": base64.b64encode(f"encrypted:{key}".encode()).decode()
                },
            },
        }
        self.repos = {
            "workspaceAssets": {"search": lambda _query, _limit: []},
            "workspaces": {"searchContent": lambda _query, _limit: []},
            "chat": {"search": lambda _query, _limit: []},
        }

    async def require_token(self, request: Request):
        self.token_calls += 1
        if request.headers.get("X-Refora-Token") != "test-token":
            raise ValueError("Invalid or missing token")

    def get_document(self, document_id: str):
        if document_id == "missing":
            return None
        return {"id": document_id, "filePath": "/tmp/source.pdf"}

    def list_documents(self, filter_: dict):
        self.document_filter = filter_
        return self.listed_documents

    def delete_document(self, _document_id: str):
        return None

    def trash(self, path: str):
        self.trashed.append(path)

    def create_provider(self, provider: dict):
        self.created_provider = provider
        return {
            "id": "provider-1",
            **{key: value for key, value in provider.items() if key != "apiKeyEnc"},
            "hasKey": provider.get("apiKeyEnc") is not None,
        }

    def copy_file_to_clipboard(self, path: str):
        file_path = library_routes.Path(path)
        self.clipboard_files.append((file_path.name, file_path.read_text(encoding="utf-8")))

    def update_web_search_config(self, patch: dict):
        self.web_search_config_data.update(patch)
        return dict(self.web_search_config_data)

    def get_web_search_config(self):
        return {
            "provider": self.web_search_config_data["provider"],
            "hasTavilyApiKey": self.web_search_config_data["tavilyApiKeyEnc"]
            is not None,
            "hasBraveApiKey": self.web_search_config_data["braveApiKeyEnc"]
            is not None,
            "ddgsInstalled": True,
            "ddgsVersion": "builtin",
        }


def make_client():
    fakes = Fakes()
    app = FastAPI()
    app.include_router(create_library_router(fakes))
    return TestClient(app), fakes


def test_registers_every_library_domain_protocol_route():
    client, _ = make_client()
    routes = {(method, route.path) for route in client.app.routes for method in route.methods or []}
    expected = {
        ("GET", "/documents"), ("GET", "/documents/count"), ("GET", "/documents/search"),
        ("GET", "/documents/{document_id}"), ("PATCH", "/documents/{document_id}"),
        ("POST", "/documents/{document_id}/starred"), ("DELETE", "/documents/{document_id}"),
        ("POST", "/documents/bulk-delete"), ("POST", "/documents/bulk-categorize"),
        ("POST", "/documents/bulk-refresh-metadata"), ("POST", "/documents/{document_id}/refresh-metadata"),
        ("POST", "/documents/{document_id}/relocate"), ("POST", "/documents/{document_id}/restore-file"),
        ("POST", "/documents/{document_id}/open-pdf"), ("POST", "/documents/{document_id}/open-in-finder"),
        ("POST", "/import/files"), ("POST", "/import/folder"), ("POST", "/import/json"),
        ("POST", "/import/zotero"), ("POST", "/import/mendeley"), ("POST", "/import/identifier"),
        ("GET", "/categories"), ("POST", "/categories"), ("PATCH", "/categories/{category_id}"),
        ("DELETE", "/categories/{category_id}"), ("POST", "/categories/{category_id}/assign"),
        ("POST", "/categories/{category_id}/unassign"), ("GET", "/watch"), ("POST", "/watch"),
        ("DELETE", "/watch/{watch_id}"), ("POST", "/watch/{watch_id}/toggle"),
        ("POST", "/library/switch"), ("GET", "/settings"), ("PATCH", "/settings"),
        ("GET", "/settings/web-search"), ("PATCH", "/settings/web-search"),
        ("POST", "/settings/web-search/test"), ("GET", "/ai/providers"), ("POST", "/ai/providers"),
        ("PATCH", "/ai/providers/{provider_id}"), ("DELETE", "/ai/providers/{provider_id}"),
        ("POST", "/ai/providers/{provider_id}/test"), ("POST", "/ai/providers/models"),
        ("POST", "/export/json"), ("POST", "/export/bibtex"), ("GET", "/export/bibtex-string"),
        ("POST", "/clipboard/write-text"), ("POST", "/clipboard/copy-markdown"),
        ("POST", "/clipboard/copy-workspace-asset"),
        ("GET", "/app/bootstrap"), ("GET", "/search/global"),
        ("POST", "/dialog/open-directory"),
    }
    assert expected <= routes


def test_document_delete_uses_token_connector_and_result_envelope():
    client, fakes = make_client()
    response = client.delete("/documents/doc-1", headers={"X-Refora-Token": "test-token"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.trashed == ["/tmp/source.pdf"]
    assert fakes.token_calls == 1


def test_document_list_forwards_filter_sort_and_is_unpaged_by_default():
    client, fakes = make_client()
    fakes.listed_documents = [{"id": f"doc-{index}"} for index in range(125)]
    response = client.get(
        "/documents?mode=recentlyAdded&sortField=title&sortDir=asc",
        headers={"X-Refora-Token": "test-token"},
    )

    assert response.status_code == 200
    assert len(response.json()["data"]) == 125
    assert fakes.document_filter == {
        "mode": "recentlyAdded",
        "sort": {"field": "title", "dir": "asc"},
    }

    invalid = client.get(
        "/documents?mode=all&sortField=invalid&sortDir=asc",
        headers={"X-Refora-Token": "test-token"},
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "validation"


def test_missing_document_and_invalid_pdf_path_are_enveloped():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}
    missing = client.get("/documents/missing", headers=headers)
    invalid_path = client.post("/documents/doc-1/relocate", headers=headers, json={"path": "paper.pdf"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    assert invalid_path.status_code == 400
    assert invalid_path.json()["error"]["code"] == "validation"


def test_document_list_preserves_mode_category_and_sort():
    client, fakes = make_client()
    response = client.get(
        "/documents?mode=category&categoryId=cat-1&sortField=year&sortDir=asc",
        headers={"X-Refora-Token": "test-token"},
    )

    assert response.json() == {"ok": True, "data": []}
    assert fakes.document_filter == {
        "mode": "category",
        "categoryId": "cat-1",
        "sort": {"field": "year", "dir": "asc"},
    }


def test_bootstrap_global_search_and_directory_dialog_are_enveloped():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}

    bootstrap = client.get("/app/bootstrap", headers=headers)
    search = client.get("/search/global?q=paper", headers=headers)
    dialog = client.post("/dialog/open-directory", headers=headers, json={})

    assert bootstrap.json() == {
        "ok": True,
        "data": {
            "language": "en",
            "windowBounds": None,
            "listColumnState": None,
            "sidebarCollapsed": False,
            "firstRun": True,
            "libraryFolderPath": None,
        },
    }
    assert search.json() == {
        "ok": True,
        "data": {
            "documents": [],
            "workspaceFiles": [],
            "workspaceContents": [],
            "chats": [],
        },
    }
    assert dialog.json() == {
        "ok": True,
        "data": {"canceled": True, "path": None},
    }


def test_settings_roundtrip_uses_json_values():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}

    updated = client.patch(
        "/settings",
        headers=headers,
        json={"sidebarCollapsed": True, "listColumnState": {"columns": []}},
    )
    fetched = client.get("/settings", headers=headers)

    assert updated.json()["data"]["sidebarCollapsed"] is True
    assert updated.json()["data"]["listColumnState"] == {"columns": []}
    assert fetched.json()["data"]["theme"] == "dark"
    assert fetched.json()["data"]["sidebarCollapsed"] is True


def test_web_search_keys_are_encrypted_and_can_be_cleared():
    client, fakes = make_client()
    headers = {"X-Refora-Token": "test-token"}

    updated = client.patch(
        "/settings/web-search",
        headers=headers,
        json={"provider": "tavily", "tavilyApiKey": " tavily-secret "},
    )

    assert updated.status_code == 200
    assert updated.json()["data"]["provider"] == "tavily"
    assert updated.json()["data"]["hasTavilyApiKey"] is True
    assert fakes.web_search_config_data["tavilyApiKeyEnc"] == b"encrypted:tavily-secret"

    rejected = client.patch(
        "/settings/web-search",
        headers=headers,
        json={"clearTavilyApiKey": True},
    )
    assert rejected.status_code == 400
    assert "Configure a Tavily API key" in rejected.json()["error"]["message"]

    cleared = client.patch(
        "/settings/web-search",
        headers=headers,
        json={"provider": "disabled", "clearTavilyApiKey": True},
    )
    assert cleared.status_code == 200
    assert cleared.json()["data"]["hasTavilyApiKey"] is False
    assert fakes.web_search_config_data["tavilyApiKeyEnc"] is None


def test_web_search_rejects_setting_and_clearing_the_same_key():
    client, _ = make_client()
    response = client.patch(
        "/settings/web-search",
        headers={"X-Refora-Token": "test-token"},
        json={
            "tavilyApiKey": "secret",
            "clearTavilyApiKey": True,
        },
    )

    assert response.status_code == 400
    assert "cannot be set and cleared together" in response.json()["error"]["message"]


def test_web_search_test_returns_the_typed_result_envelope():
    client, _ = make_client()
    response = client.post(
        "/settings/web-search/test",
        headers={"X-Refora-Token": "test-token"},
        json={},
    )

    assert response.json() == {
        "ok": True,
        "data": {
            "ok": False,
            "provider": "disabled",
            "resultCount": 0,
            "error": "Web search is disabled",
        },
    }


def test_copy_markdown_preserves_file_clipboard_behavior():
    client, fakes = make_client()
    response = client.post(
        "/clipboard/copy-markdown",
        headers={"X-Refora-Token": "test-token"},
        json={"title": 'A/B: Paper.md', "markdown": "# Paper"},
    )

    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.clipboard_files == [("A-B- Paper.md", "# Paper")]


def test_provider_api_key_is_encrypted_before_repository_storage():
    client, fakes = make_client()
    response = client.post(
        "/ai/providers",
        headers={"X-Refora-Token": "test-token"},
        json={"name": "Test", "apiKey": "secret", "apiKeyEnc": "untrusted"},
    )
    assert response.status_code == 200
    assert fakes.created_provider == {
        "name": "Test",
        "apiKeyEnc": b"encrypted:secret",
    }


def test_saved_provider_test_and_models_use_native_stored_key():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}

    tested = client.post("/ai/providers/provider-1/test", headers=headers)
    models = client.post(
        "/ai/providers/models",
        headers=headers,
        json={"providerId": "provider-1"},
    )

    assert tested.json() == {"ok": True, "data": {"ok": True}}
    assert models.json() == {
        "ok": True,
        "data": {"ok": True, "models": []},
    }


def test_unsaved_provider_models_uses_request_key_without_persisting(monkeypatch):
    captured = {}

    def create_transient_service(repos):
        def list_models(provider_id, api_key):
            captured["raw"] = repos["aiProviders"]["getRaw"](provider_id)
            captured["apiKey"] = api_key
            return {"ok": True, "models": ["model-1"]}

        return {"listModels": list_models}

    monkeypatch.setattr(
        library_routes, "createAiProvidersService", create_transient_service
    )
    client, fakes = make_client()
    response = client.post(
        "/ai/providers/models",
        headers={"X-Refora-Token": "test-token"},
        json={
            "presetId": "custom",
            "baseUrl": "https://models.example/v1",
            "apiKey": "ephemeral-key",
        },
    )

    assert response.json() == {
        "ok": True,
        "data": {"ok": True, "models": ["model-1"]},
    }
    assert captured["raw"]["baseUrl"] == "https://models.example/v1"
    assert captured["apiKey"] == "ephemeral-key"
    assert fakes.created_provider is None
