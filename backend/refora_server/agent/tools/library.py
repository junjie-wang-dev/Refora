from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, object_schema, repo, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}
_DOC_ID = {"type": "string", "description": "The docId of the paper"}
_OFFSET = {"type": "integer", "minimum": 0, "default": 0}
_CHUNK_LIMIT = {"type": "integer", "minimum": 500, "maximum": 40000, "default": 40000}


def search_library(executor: Any, args: dict[str, Any]) -> Any:
    docs = call(repo(executor.repos, "documents"), "search", args.get("query", ""), 20)
    return [{"docId": doc["id"], "title": doc.get("title") or doc.get("fileName"), "authors": doc.get("authors"), "year": doc.get("year")} for doc in docs[:20]]


def get_paper_metadata(executor: Any, args: dict[str, Any]) -> Any:
    doc = call(repo(executor.repos, "documents"), "get", args["docId"])
    return doc or {"error": "Document not found."}


def read_paper_fulltext(executor: Any, args: dict[str, Any]) -> Any:
    return _read_fulltext(executor, args, False)


def read_paper_ocr_fulltext(executor: Any, args: dict[str, Any]) -> Any:
    return _read_fulltext(executor, args, True)


def _read_fulltext(executor: Any, args: dict[str, Any], ocr: bool) -> dict[str, Any]:
    doc = call(repo(executor.repos, "documents"), "get", args["docId"])
    if not doc:
        return {"error": "Document not found."}

    ocr_fn = value(executor.deps, "read_ocr_fulltext")
    ocr_cached = call(executor.deps, "read_ocr_fulltext", args["docId"]) if callable(ocr_fn) else None

    source = "extracted"
    ocr_result: Any = None

    if ocr_cached is not None:
        text = ocr_cached["markdown"]
        source = "mineru_ocr"
        ocr_result = ocr_cached["result"]
    elif ocr:
        return {
            "status": "ocr_cache_missing",
            "docId": args["docId"],
            "nextTool": "prepare_paper_ocr",
            "approval": "handled_by_application",
            "instruction": "Call prepare_paper_ocr now. Do not ask for approval in assistant text; the application will show the approval UI.",
        }
    else:
        text = call(executor.deps, "read_paper_fulltext", args["docId"])
        if not text or len(text.strip()) < 100:
            return {
                "docId": args["docId"],
                "title": doc.get("title") or doc.get("fileName"),
                "status": "extraction_poor",
                "totalChars": len(text),
                "source": "extracted",
                "message": "The extracted text is empty or too short, likely a scanned or image-based PDF. Call read_paper_ocr_fulltext to use OCR, or prepare_paper_ocr to generate an OCR cache first.",
                "nextTool": "read_paper_ocr_fulltext",
            }

    offset, limit = max(0, int(args.get("offset", 0))), min(40_000, max(500, int(args.get("limit", 40_000))))
    chunk_count = max(1, (len(text) + limit - 1) // limit)
    response = {
        "docId": args["docId"],
        "title": doc.get("title") or doc.get("fileName"),
        "offset": offset,
        "limit": limit,
        "totalChars": len(text),
        "nextOffset": offset + limit if offset + limit < len(text) else None,
        "chunkIndex": offset // limit,
        "chunkCount": chunk_count,
        "text": text[offset:offset + limit],
        "source": source,
    }
    if offset >= len(text):
        response["message"] = "offset past end"
    if ocr_result is not None:
        response["profile"] = ocr_result["profile"]
        response["resultKey"] = ocr_result["resultKey"]
    return response


def get_paper_summary(executor: Any, args: dict[str, Any]) -> Any:
    summary = call(repo(executor.repos, "aiSummaries"), "getSummary", args["docId"])
    return summary["content"] if summary and summary.get("content") is not None else {"error": "No summary is available."}


def request_summary(executor: Any, args: dict[str, Any]) -> Any:
    document_id = args["docId"].strip()
    document = call(repo(executor.repos, "documents"), "get", document_id)
    if document is None:
        return {"status": "error", "message": "Document not found."}
    summary = call(repo(executor.repos, "aiSummaries"), "getSummary", document_id)
    if summary and summary.get("content"):
        return {"status": "ready", "summary": summary["content"]}
    service = value(executor.deps, "ai_summary")
    if callable(service):
        call(executor.deps, "ai_summary", document_id)
        return {"status": "queued", "docId": document_id}
    return {"status": "unavailable", "docId": document_id}


def open_paper(executor: Any, args: dict[str, Any]) -> Any:
    return call(executor.deps, "open_paper", args["docId"])


def find_related_papers(executor: Any, args: dict[str, Any]) -> Any:
    return call(executor.deps, "find_related_papers", args["docId"], args.get("limit", 8))


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
        "read_paper_fulltext": "Read a chunk of the full text of a paper by its docId. If a MinerU OCR cache exists for the paper, it is used automatically (source=mineru_ocr) since OCR preserves formulas, tables, and multi-column order better than plain extraction. Otherwise plain pypdf extraction is used (source=extracted). Use offset (character position, default 0) and limit (max characters per call, 500-40000, default 40000) to paginate. Returns JSON with {docId, title, offset, limit, totalChars, nextOffset, chunkIndex, chunkCount, text, source}. If nextOffset is not null, call again with offset=nextOffset to read the next chunk. When nextOffset is null you have reached the end of the paper. If the response has status=extraction_poor, the plain extraction is empty or too short (likely a scanned PDF); call read_paper_ocr_fulltext next, or prepare_paper_ocr to generate an OCR cache. When the text contains garbled formulas, broken tables, or disordered multi-column text, switch to read_paper_ocr_fulltext for higher-quality OCR Markdown.",
        "read_paper_ocr_fulltext": "Read a chunk of existing MinerU OCR Markdown for a paper by docId without running OCR or requiring approval. Use this when read_paper_fulltext returns garbled formulas, broken tables, disordered multi-column text, or status=extraction_poor, and no OCR cache is present yet. The result includes its OCR profile. If no current OCR cache exists, call prepare_paper_ocr directly instead of asking for approval in assistant text; the application handles approval before execution. Use offset and limit (500-40000, default 40000) to paginate cached Markdown until nextOffset is null.",
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
