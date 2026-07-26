from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, ids, object_schema, repo, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}
_DOC_ID = {"type": "string", "description": "The docId of the paper"}
_OFFSET = {"type": "integer", "minimum": 0, "default": 0}
_CHUNK_LIMIT = {"type": "integer", "minimum": 500, "maximum": 12000, "default": 8000}


def search_library(executor: Any, args: dict[str, Any]) -> Any:
    docs = call(executor.repos, "search", args.get("query", ""), 20) if hasattr(executor, "repos") else call(value(executor, "deps"), "search", args.get("query", ""), 20)
    return [{"docId": doc["id"], "title": doc.get("title") or doc.get("fileName"), "authors": doc.get("authors"), "year": doc.get("year")} for doc in docs[:20]]


def get_paper_metadata(executor: Any, args: dict[str, Any]) -> Any:
    doc = call(executor.repos if hasattr(executor, "repos") else value(executor, "deps"), "get", args["docId"])
    return doc or {"error": "Document not found."}


def read_paper_fulltext(executor: Any, args: dict[str, Any]) -> Any:
    return _read_fulltext(executor, args, False)


def read_paper_ocr_fulltext(executor: Any, args: dict[str, Any]) -> Any:
    return _read_fulltext(executor, args, True)


def _read_fulltext(executor: Any, args: dict[str, Any], ocr: bool) -> dict[str, Any]:
    documents = executor.repos if hasattr(executor, "repos") else value(executor, "deps")
    doc = call(documents, "get", args["docId"])
    if not doc:
        return {"error": "Document not found."}
    if ocr:
        text = call(value(executor, "deps"), "read_ocr_fulltext", args["docId"])
    else:
        entry = call(repo(executor.repos if hasattr(executor, "repos") else value(executor, "deps"), "aiSummaries"), "getFullText", args["docId"])
        text = entry.get("text", "") if entry else ""
    offset, limit = max(0, int(args.get("offset", 0))), min(12_000, max(500, int(args.get("limit", 8_000))))
    return {"docId": args["docId"], "title": doc.get("title") or doc.get("fileName"), "offset": offset, "limit": limit, "totalChars": len(text), "nextOffset": offset + limit if offset + limit < len(text) else None, "text": text[offset:offset + limit]}


def get_paper_summary(executor: Any, args: dict[str, Any]) -> Any:
    summary = call(repo(executor.repos if hasattr(executor, "repos") else value(executor, "deps"), "aiSummaries"), "getSummary", args["docId"])
    return summary["content"] if summary and summary.get("content") is not None else {"error": "No summary is available."}


def request_summary(executor: Any, args: dict[str, Any]) -> Any:
    service = value(executor.deps, "ai_summary")
    if callable(service):
        call(executor.deps, "ai_summary", args["docId"])
        return {"status": "queued", "docId": args["docId"]}
    return {"status": "unavailable", "docId": args["docId"]}


def open_paper(executor: Any, args: dict[str, Any]) -> Any:
    return call(value(executor, "deps"), "open_paper", args["docId"])


def find_related_papers(executor: Any, args: dict[str, Any]) -> Any:
    return call(value(executor, "deps"), "find_related_papers", args["docId"], args.get("limit", 8))


class LibraryTools(ToolGroup):
    name = "library"
    handlers = {
        "search_library": search_library,
        "get_paper_metadata": get_paper_metadata,
        "read_paper_fulltext": read_paper_fulltext,
        "read_paper_ocr_fulltext": read_paper_ocr_fulltext,
        "get_paper_summary": get_paper_summary,
        "request_summary": request_summary,
        "open_paper": open_paper,
        "find_related_papers": find_related_papers,
    }
    descriptions = {
        "search_library": "Search the entire document library by full-text query. Returns a JSON array of objects [{docId, title, authors, year}]. Use this when the user asks about papers that may not be in the current workspace.",
        "get_paper_metadata": "Get full metadata of a paper by its docId. Returns a JSON object with title, authors, year, venue, abstract, keywords, doi, arxivId, url, and other fields.",
        "read_paper_fulltext": "Read a chunk of the full extracted text of a paper by its docId. Use offset (character position, default 0) and limit (max characters per call, 500-12000, default 8000) to paginate. Returns JSON with {docId, title, offset, limit, totalChars, nextOffset, chunkIndex, chunkCount, text}. If nextOffset is not null, call again with offset=nextOffset to read the next chunk. When nextOffset is null you have reached the end of the paper.",
        "read_paper_ocr_fulltext": "Read a chunk of existing MinerU OCR Markdown for a paper by docId without running OCR or requiring approval. Always try read_paper_fulltext first and use this only when the regular extraction is empty, garbled, structurally ambiguous, or insufficient for exact formulas, tables, multi-column order, or scanned pages. The result includes its OCR profile. If no current OCR cache exists, call prepare_paper_ocr directly instead of asking for approval in assistant text; the application handles approval before execution. Use offset and limit to paginate cached Markdown until nextOffset is null.",
        "get_paper_summary": "Get the cached AI summary of a paper by its docId. Returns a JSON summary object, or a notice that no summary is available yet.",
        "request_summary": "Queues background AI summary generation for a paper to cache it for future use. Does NOT return a summary when none exists - it returns status queued immediately. For an immediate summary, use read_paper_fulltext to read the paper and summarize it yourself.",
        "open_paper": "Open a paper PDF in the system default viewer by its docId. Use when the user wants to view or read a paper.",
        "find_related_papers": "Find related papers that already exist in the local library using title, keywords, abstract, authors, venue, and year metadata. Returns ranked results and whether each paper is already in the current workspace. Does not access the network.",
    }
    schemas = {
        "search_library": object_schema({"query": _TEXT}, ["query"]),
        "get_paper_metadata": object_schema({"docId": _DOC_ID}, ["docId"]),
        "read_paper_fulltext": object_schema({"docId": _DOC_ID, "offset": _OFFSET, "limit": _CHUNK_LIMIT}, ["docId"]),
        "read_paper_ocr_fulltext": object_schema({"docId": _DOC_ID, "offset": _OFFSET, "limit": _CHUNK_LIMIT}, ["docId"]),
        "get_paper_summary": object_schema({"docId": _DOC_ID}, ["docId"]),
        "request_summary": object_schema({"docId": _DOC_ID}, ["docId"]),
        "open_paper": object_schema({"docId": _DOC_ID}, ["docId"]),
        "find_related_papers": object_schema({"docId": _DOC_ID, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8}}, ["docId"]),
    }