from __future__ import annotations

from refora_server.services.related_papers import find_related_papers


def test_find_related_papers_ranks_shared_evidence_and_workspace_membership():
    documents = [
        {
            "id": "seed",
            "title": "Graph Neural Networks for Molecules",
            "fileName": "seed.pdf",
            "authors": "Ada; Bob",
            "year": "2024",
            "venue": "ICML",
            "keywords": "graph; molecules",
            "abstract": "message passing molecular prediction",
        },
        {
            "id": "related",
            "title": "Graph Networks for Molecular Prediction",
            "fileName": "related.pdf",
            "authors": "Ada; Chen",
            "year": "2023",
            "venue": "ICML",
            "keywords": "graph; molecular",
            "abstract": "message passing prediction",
        },
        {
            "id": "unrelated",
            "title": "Medieval History",
            "fileName": "history.pdf",
            "authors": "Dana",
            "year": "1998",
            "venue": "History",
            "keywords": "archives",
            "abstract": "manuscripts",
        },
    ]
    repos = {
        "documents": {
            "get": lambda document_id: next(
                (item for item in documents if item["id"] == document_id), None
            ),
            "list": lambda _filter: documents,
        },
        "workspaceItems": {
            "list": lambda _workspace_id: [
                {"kind": "document", "docId": "related"}
            ]
        },
    }

    result = find_related_papers(repos, "seed", 8, "workspace")

    assert result["seedDocId"] == "seed"
    assert [item["docId"] for item in result["results"]] == ["related"]
    assert result["results"][0]["inWorkspace"] is True
    assert result["results"][0]["reasons"]["sharedAuthors"] == ["ada"]


def test_find_related_papers_reports_missing_seed():
    result = find_related_papers(
        {
            "documents": {"get": lambda _document_id: None},
            "workspaceItems": {"list": lambda _workspace_id: []},
        },
        "missing",
    )

    assert result == {"error": "Document not found", "docId": "missing"}
