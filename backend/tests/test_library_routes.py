import base64

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import refora_server.server.routes.library as library_routes
from refora_server.server.routes.library import create_library_router


class Fakes:
    def __init__(self):
        self.token_calls = 0
        self.trashed = []
        self.deleted_documents = []
        self.created_provider = None
        self.document_filter = None
        self.listed_documents = []
        self.clipboard_files = []
        self.imported_file_paths = []
        self.document_overrides = {}
        self.last_read_at = {}
        self.metadata_refreshes = []
        self.pdf_annotations = {}
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
            "updateFilePath": self.update_file_path,
            "updateFileIdentity": self.update_file_identity,
            "setLastReadAt": self.set_last_read_at,
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
            "importFiles": self.import_files,
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
            "language": "en",
            "sidebarCollapsed": "0",
            "libraryFolderPath": "",
            "windowBounds": None,
            "listColumnState": None,
            "theme": "dark",
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
        self.ai_providers_repo = {
            "create": self.create_provider,
            "update": lambda _id, patch: patch,
            "delete": lambda _id: None,
            "getRaw": lambda provider_id: {
                "id": provider_id,
                "apiKeyEnc": b"encrypted:stored-key",
            },
        }
        self.exporter = {"exportJson": lambda _ids, _workspace: {}, "exportBibtex": lambda _ids: {}, "getBibtexString": lambda _ids: {"bibtex": ""}}
        self.metadata = {
            "refresh": self.refresh_metadata,
            "updateVerifiedArxivId": lambda document_id, arxiv_id: {
                "id": document_id,
                "arxivId": arxiv_id,
            },
        }
        self.requested_arxiv_ids = []
        self.services = {
            "academic": {
                "arxiv": {"getById": self.get_arxiv_by_id},
                "identity": object(),
            }
        }
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
            "dialogOpenFile": lambda _title, _extensions, _multiple=False: {
                "ok": True,
                "data": {"canceled": True, "path": None, "paths": []},
            },
            "decryptApiKey": lambda _encrypted: {
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
            "pdfAnnotations": {
                "get": lambda document_id: self.pdf_annotations.get(document_id, []),
                "set": self.set_pdf_annotations,
            },
        }

    async def require_token(self, request: Request):
        self.token_calls += 1
        if request.headers.get("X-Refora-Token") != "test-token":
            raise ValueError("Invalid or missing token")

    def get_document(self, document_id: str):
        if document_id == "missing":
            return None
        return self.document_overrides.get(
            document_id,
            {"id": document_id, "filePath": "/tmp/source.pdf"},
        )

    def list_documents(self, filter_: dict):
        self.document_filter = filter_
        return self.listed_documents

    def delete_document(self, document_id: str):
        self.deleted_documents.append(document_id)

    def import_files(self, paths: list[str]):
        self.imported_file_paths.extend(paths)
        return {"imported": [], "skipped": [], "errors": []}

    def update_file_identity(
        self,
        document_id: str,
        path: str,
        name: str,
        size: int,
        file_hash: str,
    ):
        self.document_overrides[document_id].update(
            {
                "filePath": path,
                "fileName": name,
                "fileSize": size,
                "fileHash": file_hash,
                "fileMissing": 0,
            }
        )

    def update_file_path(self, document_id: str, path: str, name: str):
        self.document_overrides[document_id].update(
            {"filePath": path, "fileName": name}
        )

    def set_last_read_at(self, document_id: str, timestamp: int):
        self.last_read_at[document_id] = timestamp
        self.document_overrides[document_id]["lastReadAt"] = timestamp

    def refresh_metadata(self, document_id: str):
        self.metadata_refreshes.append(document_id)
        return {"id": document_id, "metadataStatus": "pending"}

    def get_arxiv_by_id(self, arxiv_id: str):
        self.requested_arxiv_ids.append(arxiv_id)
        return {
            "arxivId": arxiv_id,
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
            "url": f"https://arxiv.org/abs/{arxiv_id}",
            "pdfUrl": f"https://arxiv.org/pdf/{arxiv_id}",
        }

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

    def set_pdf_annotations(self, document_id: str, annotations: list[dict]):
        self.pdf_annotations[document_id] = annotations
        return annotations

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
        ("GET", "/documents/{document_id}/pdf-annotations"), ("PUT", "/documents/{document_id}/pdf-annotations"),
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


def test_identifier_import_uses_exact_arxiv_lookup(monkeypatch):
    client, fakes = make_client()
    captured = {}

    async def import_identifier(repos, identifier, deps):
        captured["repos"] = repos
        captured["identifier"] = identifier
        captured["metadata"] = await deps["fetchArxivMetadata"](identifier)
        return "doc-new"

    monkeypatch.setattr(library_routes, "importByIdentifier", import_identifier)

    response = client.post(
        "/import/identifier",
        headers={"X-Refora-Token": "test-token"},
        json={"identifier": "1706.03762"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"documentId": "doc-new"}}
    assert fakes.requested_arxiv_ids == ["1706.03762"]
    assert captured["identifier"] == "1706.03762"
    assert captured["metadata"]["title"] == "Attention Is All You Need"
    assert captured["metadata"]["year"] == "2017"


def test_document_delete_uses_token_connector_and_result_envelope(tmp_path):
    client, fakes = make_client()
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n")
    fakes.document_overrides["doc-1"] = {
        "id": "doc-1",
        "filePath": str(source),
        "fileMissing": 0,
    }
    response = client.delete("/documents/doc-1", headers={"X-Refora-Token": "test-token"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.trashed == [str(source)]
    assert fakes.deleted_documents == ["doc-1"]


def test_bulk_delete_removes_records_when_files_are_missing_or_trash_fails(tmp_path):
    client, fakes = make_client()
    present = tmp_path / "present.pdf"
    present.write_bytes(b"%PDF-1.4\n")
    fakes.document_overrides.update(
        {
            "missing-file": {
                "id": "missing-file",
                "filePath": str(tmp_path / "gone.pdf"),
                "fileMissing": 1,
            },
            "trash-fails": {
                "id": "trash-fails",
                "filePath": str(present),
                "fileMissing": 0,
            },
        }
    )

    def fail_trash(_path: str):
        raise RuntimeError("trash unavailable")

    fakes.connector["trashItem"] = fail_trash
    response = client.post(
        "/documents/bulk-delete",
        headers={"X-Refora-Token": "test-token"},
        json={"ids": ["missing-file", "trash-fails"]},
    )

    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.deleted_documents == ["missing-file", "trash-fails"]


def test_open_missing_pdf_returns_not_found():
    client, fakes = make_client()
    fakes.document_overrides["doc-1"] = {
        "id": "doc-1",
        "filePath": "/tmp/gone.pdf",
        "fileMissing": 1,
    }

    response = client.post(
        "/documents/doc-1/open-pdf",
        headers={"X-Refora-Token": "test-token"},
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_builtin_reader_marks_pdf_read_without_opening_external_app(tmp_path):
    client, fakes = make_client()
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    fakes.document_overrides["doc-1"] = {
        "id": "doc-1",
        "filePath": str(pdf),
        "fileMissing": 0,
    }

    def fail_open(_path: str):
        raise AssertionError("external PDF app should not be opened")

    fakes.connector["openPath"] = fail_open
    response = client.post(
        "/documents/doc-1/open-pdf?external=false",
        headers={"X-Refora-Token": "test-token"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["id"] == "doc-1"
    assert fakes.last_read_at["doc-1"] > 0


def test_pdf_annotations_roundtrip_is_document_scoped():
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}
    annotations = [{
        "id": "annotation-1",
        "kind": "note",
        "page": 2,
        "color": "#f2c94c",
        "text": "",
        "comment": "Important result",
        "createdAt": 123,
        "point": {"x": 0.2, "y": 0.3},
    }]

    updated = client.put(
        "/documents/doc-1/pdf-annotations",
        headers=headers,
        json={"annotations": annotations},
    )
    fetched = client.get(
        "/documents/doc-1/pdf-annotations",
        headers=headers,
    )

    assert updated.json()["data"] == annotations
    assert fetched.json()["data"] == annotations


def test_bulk_metadata_refresh_only_enqueues_work():
    client, fakes = make_client()

    response = client.post(
        "/documents/bulk-refresh-metadata",
        headers={"X-Refora-Token": "test-token"},
        json={"ids": ["doc-1", "doc-2", "doc-3"]},
    )

    assert response.json() == {"ok": True, "data": {"ack": True}}
    assert fakes.metadata_refreshes == ["doc-1", "doc-2", "doc-3"]
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
    assert invalid_path.json()["error"]["code"] == "invalid_path"


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


def test_empty_import_paths_open_the_native_pdf_picker(tmp_path):
    client, fakes = make_client()
    first = tmp_path / "one.pdf"
    second = tmp_path / "two.pdf"
    first.write_bytes(b"%PDF-1.4\n")
    second.write_bytes(b"%PDF-1.4\n")
    fakes.connector["dialogOpenFile"] = (
        lambda _title, _extensions, _multiple=False: {
            "ok": True,
            "data": {
                "canceled": False,
                "path": str(first),
                "paths": [str(first), str(second)],
            },
        }
    )

    response = client.post(
        "/import/files",
        headers={"X-Refora-Token": "test-token"},
        json={"paths": []},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"added": [], "skipped": [], "errors": []},
    }
    assert fakes.imported_file_paths == [str(first), str(second)]


def test_open_relocate_and_restore_preserve_document_contracts(tmp_path):
    client, fakes = make_client()
    original_folder = tmp_path / "original"
    library_folder = tmp_path / "library"
    original_folder.mkdir()
    library_folder.mkdir()
    current = library_folder / "paper.pdf"
    replacement = tmp_path / "replacement.pdf"
    current.write_bytes(b"%PDF-current\n")
    replacement.write_bytes(b"%PDF-replacement\n")
    fakes.document_overrides["doc-1"] = {
        "id": "doc-1",
        "filePath": str(current),
        "fileName": current.name,
        "fileSize": current.stat().st_size,
        "fileHash": "old-hash",
        "fileMissing": 0,
        "originalFolderPath": str(original_folder),
    }
    fakes.connector["dialogOpenFile"] = (
        lambda _title, _extensions, _multiple=False: {
            "ok": True,
            "data": {
                "canceled": False,
                "path": str(replacement),
            },
        }
    )

    opened = client.post(
        "/documents/doc-1/open-pdf",
        headers={"X-Refora-Token": "test-token"},
    )
    relocated = client.post(
        "/documents/doc-1/relocate",
        headers={"X-Refora-Token": "test-token"},
        json={"path": ""},
    )
    fakes.document_overrides["doc-1"]["filePath"] = str(current)
    restored = client.post(
        "/documents/doc-1/restore-file",
        headers={"X-Refora-Token": "test-token"},
    )

    assert opened.json()["data"]["id"] == "doc-1"
    assert fakes.last_read_at["doc-1"] > 0
    assert relocated.json()["data"]["filePath"] == str(replacement)
    assert relocated.json()["data"]["fileHash"] != "old-hash"
    assert restored.status_code == 200
    restored_path = restored.json()["data"]["filePath"]
    assert restored_path.startswith(str(original_folder))
    assert not current.exists()


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


def test_watch_rejects_paths_inside_or_containing_the_library(tmp_path):
    client, fakes = make_client()
    headers = {"X-Refora-Token": "test-token"}
    library_folder = tmp_path / "parent" / "library"
    library_folder.mkdir(parents=True)
    inside_folder = library_folder / "watched"
    inside_folder.mkdir()
    parent_folder = tmp_path / "parent"
    fakes.settings["set"]("libraryFolderPath", str(library_folder))

    inside = client.post("/watch", headers=headers, json={"path": str(inside_folder)})
    contains = client.post(
        "/watch", headers=headers, json={"path": str(parent_folder)}
    )

    assert inside.status_code == 400
    assert inside.json()["error"]["code"] == "inside_library"
    assert contains.status_code == 400
    assert contains.json()["error"]["code"] == "contains_library"


def test_settings_rejects_unknown_keys_and_library_folder_path(tmp_path):
    client, _ = make_client()
    headers = {"X-Refora-Token": "test-token"}

    unknown = client.patch(
        "/settings", headers=headers, json={"unknownKey": "value"}
    )
    library_switch = client.patch(
        "/settings", headers=headers, json={"libraryFolderPath": str(tmp_path)}
    )

    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "forbidden_field"
    assert library_switch.status_code == 400
    assert library_switch.json()["error"]["code"] == "use_library_switch"


def test_settings_proxy_url_applies_proxy_rules_via_connector(tmp_path):
    client, fakes = make_client()
    headers = {"X-Refora-Token": "test-token"}
    applied: list[str] = []

    async def apply_proxy(rules: str):
        applied.append(rules)
        return {"ok": True, "data": {"applied": True}}

    fakes.connector["applyProxy"] = apply_proxy

    response = client.patch(
        "/settings",
        headers=headers,
        json={"proxyUrl": "http://proxy.example:8080"},
    )

    assert response.status_code == 200
    assert applied == ["http://proxy.example:8080"]

    invalid = client.patch(
        "/settings", headers=headers, json={"proxyUrl": "not-a-url"}
    )
    assert invalid.status_code == 200
    assert applied == ["http://proxy.example:8080"]


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
