from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

import refora_server.services.metadata as metadata_module
from refora_server.services.metadata import create_metadata_service


def test_crossref_mapping_preserves_complete_metadata() -> None:
    fields = metadata_module._crossref_fields(
        {
            "title": ["Paper"],
            "author": [
                {
                    "name": "The Consortium",
                    "affiliation": [{"name": "Example University"}],
                },
                {
                    "family": "Lovelace",
                    "given": "Ada",
                    "affiliation": [{"name": "Example University"}],
                },
            ],
            "published-online": {"date-parts": [[2025, 1, 1]]},
            "container-title": [
                "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition"
            ],
            "subject": ["Computer Vision", "Machine Learning"],
            "DOI": "10.1000/example",
        }
    )

    assert fields["authors"] == "The Consortium; Ada Lovelace"
    assert fields["affiliations"] == "Example University"
    assert fields["keywords"] == "Computer Vision, Machine Learning"
    assert fields["venue"] == "CVPR"
    assert fields["year"] == "2025"


def test_crossref_mapping_decodes_and_spaces_affiliations() -> None:
    fields = metadata_module._crossref_fields(
        {
            "title": ["Paper"],
            "author": [
                {
                    "family": "Wang",
                    "given": "Junjie",
                    "affiliation": [
                        {
                            "name": (
                                "Ume&#x00E5; University,"
                                "Department of Applied Physics and Electronics"
                            )
                        }
                    ],
                }
            ],
        }
    )

    assert fields["affiliations"] == (
        "Umeå University, Department of Applied Physics and Electronics"
    )


def test_title_candidate_must_appear_in_pdf_head() -> None:
    text = (
        "Limitations of Neural Collapse\n"
        "for Understanding Generalization in Deep Learning\n"
        "Like Hui\n"
        "Abstract\n"
    )
    assert metadata_module._title_candidate_is_in_head(
        "Limitations of Neural Collapse for Understanding Generalization in Deep Learning",
        text,
    )
    assert not metadata_module._title_candidate_is_in_head(
        "Neural Collapse on CIFAR-10",
        text,
    )


def test_arxiv_verification_requires_a_second_signal() -> None:
    candidate = {
        "arxivId": "2401.12345",
        "title": "A Reliable Paper Title",
        "authors": ["Ada Lovelace"],
        "year": 2025,
    }

    assert metadata_module._is_arxiv_candidate_verified(
        {
            "title": "A Reliable Paper Title",
            "authors": "Lovelace, Ada",
        },
        candidate,
    )
    assert not metadata_module._is_arxiv_candidate_verified(
        {"title": "A Reliable Paper Title"},
        candidate,
    )
    assert metadata_module._is_arxiv_candidate_verified(
        {
            "title": "A Reliable Paper Title",
            "doi": "10.48550/arXiv.2401.12345",
        },
        candidate,
    )


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


def test_bulk_metadata_refresh_rolls_back_all_statuses_on_failure() -> None:
    statuses = {"doc-1": "done", "doc-2": "done"}

    def get(document_id: str) -> dict[str, Any] | None:
        status = statuses.get(document_id)
        return (
            {"id": document_id, "metadataStatus": status}
            if status is not None
            else None
        )

    def set_status(document_id: str, status: str) -> None:
        statuses[document_id] = status
        if document_id == "doc-2":
            raise RuntimeError("status update failed")

    def transaction(operation):
        snapshot = dict(statuses)
        try:
            return operation()
        except BaseException:
            statuses.clear()
            statuses.update(snapshot)
            raise

    service = create_metadata_service(
        {
            "documents": {
                "get": get,
                "setMetadataStatus": set_status,
                "getResumableMetadataRows": lambda: [],
            },
            "settings": {"get": lambda _key, default=None: default},
            "transaction": transaction,
        },
        academic={},
        emit=lambda _name, _data: None,
    )

    with pytest.raises(RuntimeError, match="status update failed"):
        service["bulkRefreshMetadata"](["doc-1", "doc-2"])

    assert statuses == {"doc-1": "done", "doc-2": "done"}


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
    assert documents.document["authors"] == "Ada Lovelace"
    assert documents.document["metadataStatus"] == "done"
    assert documents.document["metadataAttempts"] == 0
    assert documents.remote_values is not None
    assert documents.remote_values["title"]["value"] == "Paper"
    assert events[-1][0] == "document.updated"
    await service["destroy"]()


@pytest.mark.asyncio
async def test_metadata_uses_reliable_pdf_title_and_text_authors_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    documents.document["fileName"] = "paper3.pdf"
    documents.document["title"] = None
    documents.document["editedFields"] = []
    text = (
        "Towards Model-Agnostic Cooperative Perception\n"
        "Junjie Wang1, Tomas Nordstr ¨om1,2\n"
        "1Department of Applied Physics and Electronics, Ume ˚a University\n"
        "2RISE Research Institutes of Sweden\n"
        "Abstract—We study cooperative perception.\n"
    )
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {"/Author": "", "/Title": ""},
            "text": text,
            "titleCandidate": "Towards Model-Agnostic Cooperative Perception",
        },
    )

    class Response:
        status_code = 200

        def __init__(self, url: str) -> None:
            self.url = url

        def json(self) -> dict[str, Any]:
            if "dblp.org" in self.url:
                return {"result": {"hits": {"hit": []}}}
            return {"message": {"items": []}}

    class Client:
        def __init__(self, **_options: Any) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, url: str, **_options: Any) -> Response:
            return Response(url)

    monkeypatch.setattr(metadata_module.httpx, "AsyncClient", Client)
    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=lambda _name, _data: None,
    )

    service["refresh"]("doc-1")
    for _ in range(100):
        if documents.document["metadataStatus"] == "done":
            break
        await asyncio.sleep(0.01)

    assert documents.document["title"] == "Towards Model-Agnostic Cooperative Perception"
    assert documents.document["authors"] == "Junjie Wang; Tomas Nordström"
    assert documents.document["affiliations"] == (
        "Department of Applied Physics and Electronics, Umeå University; "
        "RISE Research Institutes of Sweden"
    )
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


@pytest.mark.asyncio
async def test_doi_metadata_stays_primary_and_verified_arxiv_is_supplemented(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    documents.document["title"] = None
    documents.document["editedFields"] = []
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {},
            "text": "A Reliable Paper Title",
            "titleCandidate": "A Reliable Paper Title",
        },
    )
    monkeypatch.setattr(metadata_module, "isReliableTitle", lambda _title, _text: True)
    monkeypatch.setattr(
        metadata_module,
        "extractDoiFromText",
        lambda _text: "10.1000/example",
    )
    monkeypatch.setattr(
        metadata_module,
        "extractArxivFromText",
        lambda _text: "2401.12345",
    )
    monkeypatch.setattr(metadata_module, "extractDoiFromInfo", lambda _info: None)
    monkeypatch.setattr(metadata_module, "extractAffiliationsFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractAbstractFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractVenueFromText", lambda _text: None)

    class Response:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {
                "message": {
                    "title": ["A Reliable Paper Title"],
                    "author": [{"family": "Lovelace", "given": "Ada"}],
                    "published-online": {"date-parts": [[2025]]},
                    "container-title": ["CVPR"],
                    "volume": "1",
                    "DOI": "10.1000/example",
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
            return Response()

    monkeypatch.setattr(metadata_module.httpx, "AsyncClient", Client)

    async def get_by_id(_arxiv_id: str) -> dict[str, Any]:
        return {
            "arxivId": "2401.12345",
            "title": "A Reliable Paper Title",
            "authors": ["Ada Lovelace"],
            "year": 2025,
            "doi": "10.1000/example",
        }

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={"arxiv": {"getById": get_by_id}},
        emit=lambda _name, _data: None,
    )
    service["refresh"]("doc-1")
    for _ in range(100):
        if documents.document["metadataStatus"] == "done":
            break
        await asyncio.sleep(0.01)

    assert documents.document["metadataSource"] == "crossref"
    assert documents.document["title"] == "A Reliable Paper Title"
    assert documents.document["arxivId"] == "2401.12345"
    assert documents.remote_values is not None
    assert documents.remote_values["arxivId"]["source"] == "arxiv"
    await service["destroy"]()


@pytest.mark.asyncio
async def test_metadata_network_failure_remains_retriable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    documents.document["title"] = None
    documents.document["editedFields"] = []
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {},
            "text": "A Reliable Paper Title",
            "titleCandidate": "A Reliable Paper Title",
        },
    )
    monkeypatch.setattr(metadata_module, "isReliableTitle", lambda _title, _text: True)
    monkeypatch.setattr(metadata_module, "extractDoiFromInfo", lambda _info: None)
    monkeypatch.setattr(metadata_module, "extractDoiFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractArxivFromText", lambda _text: None)

    class Client:
        def __init__(self, **_options: Any) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, _url: str, **_options: Any) -> None:
            raise httpx.ConnectError("offline")

    monkeypatch.setattr(metadata_module.httpx, "AsyncClient", Client)
    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={},
        emit=lambda _name, _data: None,
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
async def test_doi_result_gets_verified_arxiv_id_in_background(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    documents = FakeDocuments()
    documents.document["title"] = None
    documents.document["editedFields"] = []
    monkeypatch.setattr(
        metadata_module,
        "extractMetadataFromPdf",
        lambda _path, _pages: {
            "info": {},
            "text": "A Reliable Paper Title",
            "titleCandidate": "A Reliable Paper Title",
        },
    )
    monkeypatch.setattr(metadata_module, "isReliableTitle", lambda _title, _text: True)
    monkeypatch.setattr(
        metadata_module,
        "extractDoiFromText",
        lambda _text: "10.1000/example",
    )
    monkeypatch.setattr(metadata_module, "extractDoiFromInfo", lambda _info: None)
    monkeypatch.setattr(metadata_module, "extractArxivFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractAffiliationsFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractAbstractFromText", lambda _text: None)
    monkeypatch.setattr(metadata_module, "extractVenueFromText", lambda _text: None)

    class Response:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {
                "message": {
                    "title": ["A Reliable Paper Title"],
                    "author": [{"family": "Lovelace", "given": "Ada"}],
                    "published-online": {"date-parts": [[2025]]},
                    "container-title": ["CVPR"],
                    "volume": "1",
                    "DOI": "10.1000/example",
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
            return Response()

    monkeypatch.setattr(metadata_module.httpx, "AsyncClient", Client)

    async def search_title(_title: str, _page_size: int) -> dict[str, Any]:
        return {
            "papers": [
                {
                    "arxivId": "2401.12345",
                    "title": "A Reliable Paper Title",
                    "authors": ["Ada Lovelace"],
                    "year": 2025,
                    "doi": "10.1000/example",
                }
            ]
        }

    service = create_metadata_service(
        {
            "documents": documents.service(),
            "settings": {"get": lambda _key, default=None: default},
        },
        academic={"arxiv": {"searchTitle": search_title}},
        emit=lambda _name, _data: None,
    )
    service["refresh"]("doc-1")
    for _ in range(100):
        if documents.document.get("arxivId") == "2401.12345":
            break
        await asyncio.sleep(0.01)

    assert documents.document["arxivId"] == "2401.12345"
    assert documents.remote_values is not None
    assert documents.remote_values["arxivId"]["source"] == "arxiv"
    await service["destroy"]()
