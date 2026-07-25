from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from refora_server.server.routes.library import create_library_router


class Fakes:
    def __init__(self):
        self.token_calls = 0
        self.trashed = []
        self.created_provider = None
        self.documents = {
            "list": lambda _filter: [],
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
        self.settings = {"list": lambda: [("theme", "dark")], "set": lambda _key, _value: None}
        self.web_search = {"getConfig": lambda: {"provider": "disabled"}, "test": lambda _query: []}
        self.ai_providers = {"list": lambda: [], "testProvider": lambda _id, _key: {"ok": True}, "listModels": lambda _id, _key: {"ok": True, "models": []}}
        self.ai_providers_repo = {"create": self.create_provider, "update": lambda _id, patch: patch, "delete": lambda _id: None}
        self.exporter = {"exportJson": lambda _ids, _workspace: {}, "exportBibtex": lambda _ids: {}, "getBibtexString": lambda _ids: {"bibtex": ""}}
        self.connector = {"trashItem": self.trash, "openPath": lambda _path: None, "showInFolder": lambda _path: None, "clipboardWrite": lambda _text: None}

    async def require_token(self, request: Request):
        self.token_calls += 1
        if request.headers.get("X-Refora-Token") != "test-token":
            raise ValueError("Invalid or missing token")

    def get_document(self, document_id: str):
        if document_id == "missing":
            return None
        return {"id": document_id, "filePath": "/tmp/source.pdf"}

    def delete_document(self, _document_id: str):
        return None

    def trash(self, path: str):
        self.trashed.append(path)

    def create_provider(self, provider: dict):
        self.created_provider = provider
        return {"id": "provider-1", **provider}


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
        ("POST", "/ai/providers/{provider_id}/test"), ("GET", "/ai/providers/{provider_id}/models"),
        ("POST", "/export/json"), ("POST", "/export/bibtex"), ("GET", "/export/bibtex-string"),
        ("POST", "/clipboard/write-text"), ("POST", "/clipboard/copy-markdown"),
        ("POST", "/clipboard/copy-workspace-asset"),
    }
    assert expected <= routes


def test_document_delete_uses_token_connector_and_result_envelope():
    client, fakes = make_client()
    response = client.delete("/documents/doc-1", headers={"X-Refora-Token": "test-token"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.trashed == ["/tmp/source.pdf"]
    assert fakes.token_calls == 1


def test_missing_document_and_invalid_pdf_path_are_enveloped():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}
    missing = client.get("/documents/missing", headers=headers)
    invalid_path = client.post("/documents/doc-1/relocate", headers=headers, json={"path": "paper.pdf"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    assert invalid_path.status_code == 400
    assert invalid_path.json()["error"]["code"] == "validation"


def test_provider_api_key_is_not_sent_to_repository():
    client, fakes = make_client()
    response = client.post(
        "/ai/providers",
        headers={"X-Refora-Token": "test-token"},
        json={"name": "Test", "apiKey": "secret", "apiKeyEnc": "encrypted"},
    )
    assert response.status_code == 200
    assert fakes.created_provider == {"name": "Test"}
