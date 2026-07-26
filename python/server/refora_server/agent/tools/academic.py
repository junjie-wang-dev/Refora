from __future__ import annotations

from typing import Any

from refora_server.academic.types import ArxivSearchInput, PaperLocator
from refora_server.agent.tools.common import call, object_schema, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}

_PAPER_LOCATOR = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["document_id", "arxiv_id", "doi", "s2_paper_id", "s2_corpus_id"]},
        "value": {"type": "string", "minLength": 1, "maxLength": 500},
    },
    "required": ["type", "value"],
    "additionalProperties": False,
}
_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
_CURSOR = {"type": "string", "maxLength": 1000}
_CHUNK_LIMIT = {"type": "integer", "minimum": 500, "maximum": 12000, "default": 8000}
_GRAPH_PROPS = {"paper": _PAPER_LOCATOR, "cursor": _CURSOR, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "publishedAfter": _DATE}


def search_arxiv(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    return call(value(academic, "arxiv"), "search", ArxivSearchInput(**args))


def get_arxiv_paper(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    return call(value(academic, "arxiv_papers"), "get_paper", args["arxivId"], args.get("sectionId"), args.get("cursor"), args.get("maxChars"))


def resolve_academic_identity(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    locator = PaperLocator(**args["paper"]) if "paper" in args else None
    return call(value(academic, "identity"), "resolve", locator)


def get_citing_papers(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    locator = PaperLocator(**args["paper"]) if "paper" in args else None
    return call(value(academic, "graph"), "get_citing_papers", locator, args.get("cursor"), args.get("limit"), {"publishedAfter": args.get("publishedAfter")} if args.get("publishedAfter") else None)


def get_referenced_papers(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    locator = PaperLocator(**args["paper"]) if "paper" in args else None
    return call(value(academic, "graph"), "get_referenced_papers", locator, args.get("cursor"), args.get("limit"), {"publishedAfter": args.get("publishedAfter")} if args.get("publishedAfter") else None)


def get_semantic_recommendations(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    locator = PaperLocator(**args["paper"]) if "paper" in args else None
    return call(value(academic, "graph"), "get_recommendations", locator, args.get("limit"))


def explore_research_frontier(executor: Any, args: dict[str, Any]) -> Any:
    academic = value(value(executor, "deps"), "academic")
    frontier = value(academic, "frontier")
    return call(frontier, {"start": "start", "expand": "expand", "continue": "continue"}[args["action"]], args)


class AcademicTools(ToolGroup):
    name = "academic"
    handlers = {
        "search_arxiv": search_arxiv,
        "get_arxiv_paper": get_arxiv_paper,
        "resolve_academic_identity": resolve_academic_identity,
        "get_citing_papers": get_citing_papers,
        "get_referenced_papers": get_referenced_papers,
        "get_semantic_recommendations": get_semantic_recommendations,
        "explore_research_frontier": explore_research_frontier,
    }
    descriptions = {
        "search_arxiv": "Search arXiv metadata and abstracts using a bounded paginated query. Use sort=submitted_date for recent work. Results do not include full text; use get_arxiv_paper for selected papers.",
        "get_arxiv_paper": "Fetch the official arXiv HTML version of a selected paper, convert it to Markdown, and return one bounded chunk. Use sectionId or nextCursor to continue. Do not assume the first chunk is the whole paper.",
        "resolve_academic_identity": "Resolve a local document ID, arXiv ID, DOI, Semantic Scholar paperId, or CorpusId to one verified paper identity. Do not continue through an ambiguous or conflicting identity.",
        "get_citing_papers": "Return a bounded page of papers that cite the target paper. These are incoming citations: each returned citing paper points to the target. Coverage may be partial; use nextCursor only when more results are needed.",
        "get_referenced_papers": "Return a bounded page of papers cited by the target paper. These are outgoing references from the target to historical work.",
        "get_semantic_recommendations": "Return a bounded list of Semantic Scholar recommendations for one paper. Provider order is preserved and is not a final relevance judgment.",
        "explore_research_frontier": "Run one bounded deterministic research-frontier round. Use action=start with a seed and research objective, action=expand only after semantically selecting up to three returned canonical paper IDs, and action=continue only with a returned resume token. The tool groups citation, recommendation, and recent arXiv candidates without a single relevance score.",
    }
    schemas = {
        "search_arxiv": object_schema({"query": {"type": "string", "minLength": 1, "maxLength": 500}, "cursor": _CURSOR, "pageSize": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}, "sort": {"type": "string", "enum": ["relevance", "submitted_date"], "default": "relevance"}, "categories": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 40}, "maxItems": 5, "default": []}}, ["query"]),
        "get_arxiv_paper": object_schema({"arxivId": {"type": "string", "minLength": 1, "maxLength": 200}, "sectionId": {"type": "string", "minLength": 1, "maxLength": 200}, "cursor": _CURSOR, "maxChars": _CHUNK_LIMIT}, ["arxivId"]),
        "resolve_academic_identity": object_schema({"paper": _PAPER_LOCATOR}, ["paper"]),
        "get_citing_papers": object_schema(_GRAPH_PROPS, ["paper"]),
        "get_referenced_papers": object_schema(_GRAPH_PROPS, ["paper"]),
        "get_semantic_recommendations": object_schema({"paper": _PAPER_LOCATOR, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}}, ["paper"]),
        "explore_research_frontier": object_schema({"action": {"type": "string", "enum": ["start", "expand", "continue"]}, "seed": _PAPER_LOCATOR, "objective": {"type": "string", "maxLength": 2000}, "branches": {"type": "array", "items": {"type": "string", "enum": ["citations", "recommendations", "arxiv_recent"]}, "maxItems": 3}, "searchQueries": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 500}, "maxItems": 3}, "publishedAfter": _DATE, "strictArxivOnly": {"type": "boolean", "default": False}, "frontierId": {"type": "string", "format": "uuid"}, "paperIds": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 500}, "maxItems": 3}, "resumeToken": {"type": "string", "format": "uuid"}}, ["action"]),
    }