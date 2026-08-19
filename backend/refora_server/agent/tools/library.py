from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, object_schema, repo, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}
_DOC_ID = {"type": "string", "description": "The docId of the paper"}
_OFFSET = {"type": "integer", "minimum": 0, "default": 0}
_CHUNK_LIMIT = {"type": "integer", "minimum": 500, "maximum": 40000, "default": 40000}
_SEARCH_SCOPE = {"type": "string", "enum": ["workspace", "library"]}
_READ_SOURCE = {"type": "string", "enum": ["auto", "ocr", "extracted"], "default": "auto"}


def search_documents(executor: Any, args: dict[str, Any]) -> Any:
    documents = repo(executor.repos, "documents")
    query = args.get("query", "")
    docs = (
        call(documents, "search", query, 50)
        if query
        else call(documents, "list", {"mode": "all"})
    )
    workspace_id = value(executor.context, "workspace_id")
    scope = args.get("scope") or ("workspace" if workspace_id else "library")
    if scope == "workspace":
        if not workspace_id:
            raise ValueError("Workspace document search requires a selected workspace")
        workspace_doc_ids = {
            item["docId"]
            for item in call(
                repo(executor.repos, "workspaceItems"), "list", workspace_id
            )
            if item.get("docId")
        }
        docs = [doc for doc in docs if doc["id"] in workspace_doc_ids]
    max_results = 50 if scope == "workspace" else 20
    summaries = value(executor.repos, "aiSummaries")
    return [
        {
            "docId": doc["id"],
            "title": doc.get("title") or doc.get("fileName"),
            "authors": doc.get("authors"),
            "year": doc.get("year"),
            "hasSummary": bool(
                summaries
                and (
                    summary := call(summaries, "getSummary", doc["id"])
                )
                and summary.get("content")
            ),
        }
        for doc in docs[:max_results]
    ]


def get_paper_context(executor: Any, args: dict[str, Any]) -> Any:
    doc = call(repo(executor.repos, "documents"), "get", args["docId"])
    if doc is None:
        return {"error": "Document not found."}
    summaries = value(executor.repos, "aiSummaries")
    summary = call(summaries, "getSummary", args["docId"]) if summaries else None
    content = summary.get("content") if summary else None
    return {**doc, "docId": doc["id"], "hasSummary": bool(content), "summary": content}


def read_paper(executor: Any, args: dict[str, Any]) -> Any:
    doc = call(repo(executor.repos, "documents"), "get", args["docId"])
    if not doc:
        return {"error": "Document not found."}

    requested_source = args.get("source", "auto")
    ocr_fn = value(executor.deps, "read_ocr_fulltext")
    ocr_cached = (
        call(executor.deps, "read_ocr_fulltext", args["docId"])
        if requested_source != "extracted" and callable(ocr_fn)
        else None
    )

    source = "extracted"
    ocr_result: Any = None

    if ocr_cached is not None:
        text = ocr_cached["markdown"]
        source = "mineru_ocr"
        ocr_result = ocr_cached["result"]
    elif requested_source == "ocr":
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
                "message": "The extracted text is empty or too short, likely a scanned or image-based PDF. Call prepare_paper_ocr to generate an OCR cache.",
                "nextTool": "prepare_paper_ocr",
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


def open_paper(executor: Any, args: dict[str, Any]) -> Any:
    return call(executor.deps, "open_paper", args["docId"])


def find_related_papers(executor: Any, args: dict[str, Any]) -> Any:
    return call(executor.deps, "find_related_papers", args["docId"], args.get("limit", 8))


class LibraryTools(ToolGroup):
    name = "library"
    handlers = {
        "search_documents": search_documents,
        "get_paper_context": get_paper_context,
        "read_paper": read_paper,
        "open_paper": open_paper,
        "find_related_papers": find_related_papers,
    }
    descriptions = {
        "search_documents": "Search documents by title, authors, abstract, or keywords. scope=workspace limits results to the selected workspace; scope=library searches the full local library. An empty query lists documents in scope.",
        "get_paper_context": "Get a paper's complete metadata and cached summary, when available, using its docId.",
        "read_paper": "Read paginated paper text. source=auto prefers cached OCR, source=ocr requires cached OCR, and source=extracted forces plain PDF extraction. Call prepare_paper_ocr if OCR is needed but missing.",
        "open_paper": "Open a paper PDF in the system default viewer by its docId. Use when the user wants to view or read a paper.",
        "find_related_papers": "Find related papers that already exist in the local library using title, keywords, abstract, authors, venue, and year metadata. Returns ranked results and whether each paper is already in the current workspace. Does not access the network.",
    }
    schemas = {
        "search_documents": object_schema({"query": _TEXT, "scope": _SEARCH_SCOPE}, ["query"]),
        "get_paper_context": object_schema({"docId": _DOC_ID}, ["docId"]),
        "read_paper": object_schema({"docId": _DOC_ID, "source": _READ_SOURCE, "offset": _OFFSET, "limit": _CHUNK_LIMIT}, ["docId"]),
        "open_paper": object_schema({"docId": _DOC_ID}, ["docId"]),
        "find_related_papers": object_schema({"docId": _DOC_ID, "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8}}, ["docId"]),
    }
