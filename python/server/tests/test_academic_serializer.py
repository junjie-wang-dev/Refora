from __future__ import annotations

from refora_server.services.academic_serializer import (
    serialize_arxiv_search_response,
    serialize_paper_fulltext_response,
    serialize_semantic_recommendations_response,
)


def test_serializes_arxiv_search_response_to_stable_paper_fields() -> None:
    result = serialize_arxiv_search_response(
        {
            "papers": [
                {
                    "arxivId": "2401.12345v2",
                    "title": "  Reliable Agents  ",
                    "authors": [" Alice ", "Bob"],
                    "abstract": " An evaluation study. ",
                    "publishedAt": "2024-01-31T00:00:00Z",
                    "updatedAt": "2024-02-01T00:00:00Z",
                    "categories": ["cs.AI"],
                    "doi": "10.1000/reliable",
                    "absUrl": "https://arxiv.org/abs/2401.12345v2",
                }
            ],
            "total": 4,
            "nextCursor": "page-2",
            "fetchedAt": "2026-01-01T00:00:00Z",
            "cached": True,
        }
    )

    assert result == {
        "source": "arxiv",
        "papers": [
            {
                "source": "arxiv",
                "title": "Reliable Agents",
                "authors": ["Alice", "Bob"],
                "abstract": "An evaluation study.",
                "year": 2024,
                "publicationDate": "2024-01-31T00:00:00Z",
                "updatedAt": "2024-02-01T00:00:00Z",
                "categories": ["cs.AI"],
                "venue": None,
                "citationCount": None,
                "referenceCount": None,
                "arxivId": "2401.12345v2",
                "doi": "10.1000/reliable",
                "semanticScholarPaperId": None,
                "semanticScholarCorpusId": None,
                "url": "https://arxiv.org/abs/2401.12345v2",
                "htmlUrl": None,
                "pdfUrl": None,
            }
        ],
        "total": 4,
        "nextCursor": "page-2",
        "fetchedAt": "2026-01-01T00:00:00Z",
        "cached": True,
    }


def test_serializes_semantic_scholar_recommendations_to_stable_paper_fields() -> None:
    result = serialize_semantic_recommendations_response(
        {
            "seed": {"paperId": "seed", "title": "Seed paper", "authors": [{"name": "Seed Author"}]},
            "recommendedPapers": [
                {
                    "paperId": "s2-paper",
                    "corpusId": 42,
                    "externalIds": {"ArXiv": "2402.00001", "DOI": "10.1000/semantic"},
                    "title": "Semantic recommendation",
                    "authors": [{"authorId": "author-1", "name": "Ada Lovelace"}],
                    "abstract": "Recommended by the graph.",
                    "year": 2025,
                    "publicationDate": "2025-02-03",
                    "venue": "Journal of Agents",
                    "citationCount": 17,
                    "referenceCount": 9,
                    "url": "https://www.semanticscholar.org/paper/s2-paper",
                }
            ],
        }
    )

    paper = result["papers"][0]
    assert result["source"] == "semantic_scholar"
    assert result["seed"]["title"] == "Seed paper"
    assert paper == {
        "source": "semantic_scholar",
        "title": "Semantic recommendation",
        "authors": ["Ada Lovelace"],
        "abstract": "Recommended by the graph.",
        "year": 2025,
        "publicationDate": "2025-02-03",
        "updatedAt": None,
        "categories": [],
        "venue": "Journal of Agents",
        "citationCount": 17,
        "referenceCount": 9,
        "arxivId": "2402.00001",
        "doi": "10.1000/semantic",
        "semanticScholarPaperId": "s2-paper",
        "semanticScholarCorpusId": 42,
        "url": "https://www.semanticscholar.org/paper/s2-paper",
        "htmlUrl": None,
        "pdfUrl": None,
    }


def test_serializers_supply_defaults_for_missing_or_invalid_fields() -> None:
    arxiv = serialize_arxiv_search_response({"papers": [{}], "total": "invalid"})
    semantic = serialize_semantic_recommendations_response({"recommendedPapers": [{}]})
    fulltext = serialize_paper_fulltext_response({"title": None, "text": None, "offset": -1, "totalChars": "invalid"})

    expected_paper = {
        "source": "arxiv",
        "title": "",
        "authors": [],
        "abstract": "",
        "year": None,
        "publicationDate": None,
        "updatedAt": None,
        "categories": [],
        "venue": None,
        "citationCount": None,
        "referenceCount": None,
        "arxivId": None,
        "doi": None,
        "semanticScholarPaperId": None,
        "semanticScholarCorpusId": None,
        "url": None,
        "htmlUrl": None,
        "pdfUrl": None,
    }
    assert arxiv["papers"] == [expected_paper]
    assert arxiv["total"] == 1
    assert arxiv["nextCursor"] is None
    assert semantic["seed"]["title"] == ""
    assert semantic["papers"][0]["authors"] == []
    assert fulltext == {
        "source": "local",
        "title": "",
        "content": "",
        "offset": 0,
        "limit": 0,
        "totalChars": 0,
        "nextOffset": None,
        "nextCursor": None,
    }
