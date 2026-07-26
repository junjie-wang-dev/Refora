from __future__ import annotations

import asyncio
from typing import Any

import pytest

import refora_server.services.metadata as metadata_module
from refora_server.services.metadata import create_metadata_service


class FakeDocuments:
    def __init__(self) -> None:
        self.document = {
            "id": "doc-1",
            "filePath": "/library/paper.pdf",
            "fileName": "paper.pdf",
            "title": "Manual title",
            "authors": None,
            "editedFields": ["title"],
            "metadataStatus": "pending",
            "metadataAttempts": 0,
        }
        self.remote_values: dict[str, Any] | None = None

    def get(self, document_id: str) -> dict[str, Any] | None:
        return dict(self.document) if document_id == self.document["id"] else None

    def set_status(self, document_id: str, status: str) -> None:
        assert document_id == self.document["id"]
        self.document["metadataStatus"] = status

    def increment_attempts(self, document_id: str) -> int:
        assert document_id == self.document["id"]
        self.document["metadataAttempts"] += 1
        return self.document["metadataAttempts"]

    def apply(
        self,
        document_id: str,
        fields: dict[str, str],
        remote_values: dict[str, Any] | None,
        status: str,
        source: str | None,
    ) -> dict[str, Any]:
        assert document_id == self.document["id"]
        self.document.update(fields)
        self.document["metadataStatus"] = status
        self.document["metadataSource"] = source
        self.remote_values = remote_values
        return dict(self.document)

    def update(self, document_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        assert document_id == self.document["id"]
        self.document.update(patch)
        return dict(self.document)

    def resumable(self) -> list[dict[str, Any]]:
        return []

    def service(self) -> dict[str, Any]:
        return {
            "get": self.get,
            "setMetadataStatus": self.set_status,
            "incrementMetadataAttempts": self.increment_attempts,
            "applyMetadataFields": self.apply,
            "update": self.update,
            "getResumableMetadataRows": self.resumable,
        }


@pytest.mark.asyncio
async def test_metadata_runs_in_python_and_preserves_edited_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    events: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {"Title": "Extracted title", "Author": "Ada Lovelace"},
            "text": "Abstract: A sufficiently detailed abstract for metadata extraction.",
        },
    )
    monkeypatch.setattr(metadata_module, "isReliableTitle", lambda _title, _text: False)
    monkeypatch.setattr(
        metadata_module,
        "extractAbstractFromText",
        lambda _text: "A sufficiently detailed abstract for metadata extraction.",
    )
    monkeypatch.setattr(metadata_module, "extractAffiliationsFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractVenueFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractDoiFromInfo", lambda _info: None)
    monkeypatch.setattr(metadata_module, "extractDoiFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractArxivFromText", lambda _text: None)

    async def emit(name: str, data: dict[str, Any]) -> None:
        events.append((name, data))

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=emit,
    )

    result = service["refresh"]("doc-1")
    assert result["metadataStatus"] == "pending"
    for _ in range(100):
        if documents.document["metadataStatus"] != "pending":
            break
        await asyncio.sleep(0.01)

    assert documents.document["title"] == "Manual title"
    assert documents.document["authors"] == "Lovelace, Ada"
    assert documents.document["metadataStatus"] == "done"
    assert documents.document["metadataAttempts"] == 0
    assert documents.remote_values is not None
    assert documents.remote_values["title"]["value"] == "Paper"
    assert events[-1][0] == "document.updated"
    await service["destroy"]()


@pytest.mark.asyncio
async def test_metadata_failure_is_retriable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: (_ for _ in ()).throw(ValueError("invalid PDF")),
    )

    async def emit(_name: str, _data: dict[str, Any]) -> None:
        return None

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=emit,
    )

    service["refresh"]("doc-1")
    for _ in range(100):
        if documents.document["metadataStatus"] == "failed":
            break
        await asyncio.sleep(0.01)

    assert documents.document["metadataStatus"] == "failed"
    assert documents.document["metadataAttempts"] == 1
    await service["destroy"]()


@pytest.mark.asyncio
async def test_metadata_parser_error_payload_is_retriable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "error": {"type": "encrypted", "message": "password required"},
            "info": {},
            "text": "",
        },
    )

    async def emit(_name: str, _data: dict[str, Any]) -> None:
        return None

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=emit,
    )

    service["refresh"]("doc-1")
    for _ in range(100):
        if documents.document["metadataStatus"] == "failed":
            break
        await asyncio.sleep(0.01)

    assert documents.document["metadataStatus"] == "failed"
    assert documents.document["metadataAttempts"] == 1
    await service["destroy"]()


@pytest.mark.asyncio
async def test_title_fallback_preserves_edit_made_during_network_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    documents.document["title"] = None
    documents.document["editedFields"] = []
    lookup_started = asyncio.Event()
    release_lookup = asyncio.Event()
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {"Title": "Reliable Paper Title"},
            "text": "Reliable Paper Title\nA sufficiently long body of paper text.",
        },
    )
    monkeypatch.setattr(metadata_module, "isReliableTitle", lambda _title, _text: True)
    monkeypatch.setattr(metadata_module, "extractAbstractFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractAffiliationsFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractVenueFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractDoiFromInfo", lambda _info: None)
    monkeypatch.setattr(metadata_module, "extractDoiFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractArxivFromText", lambda _text: None)

    class Response:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {
                "result": {
                    "hits": {
                        "hit": [
                            {
                                "info": {
                                    "title": "Reliable Paper Title",
                                    "authors": {
                                        "author": [{"text": "Ada Lovelace"}]
                                    },
                                    "year": "2026",
                                    "venue": "ICML",
                                }
                            }
                        ]
                    }
                }
            }

    class Client:
        def __init__(self, **_options: Any) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, _url: str, **_options: Any) -> Response:
            lookup_started.set()
            await release_lookup.wait()
            return Response()

    monkeypatch.setattr(metadata_module.httpx, "AsyncClient", Client)

    async def emit(_name: str, _data: dict[str, Any]) -> None:
        return None

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=emit,
    )

    service["refresh"]("doc-1")
    await asyncio.wait_for(lookup_started.wait(), timeout=1)
    documents.document["title"] = "User edited title"
    documents.document["editedFields"] = ["title"]
    release_lookup.set()
    for _ in range(100):
        if documents.document["metadataStatus"] == "done":
            break
        await asyncio.sleep(0.01)

    assert documents.document["title"] == "User edited title"
    assert documents.document["venue"] == "ICML"
    assert documents.document["year"] == "2026"
    assert documents.remote_values is not None
    assert documents.remote_values["title"]["value"] == "Reliable Paper Title"
    await service["destroy"]()
