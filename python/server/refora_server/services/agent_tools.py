from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from langchain_core.tools import StructuredTool

from refora_server.academic.types import ArxivSearchInput, PaperLocator, to_json
from refora_server.services.agent_memory import update_memory

IDEMPOTENT_TOOL_NAMES = {
    "generate_report",
    "add_docs_to_workspace",
    "create_workspace_connections",
    "publish_workspace_artifacts",
    "install_runtime_packages",
    "propose_workspace_memory_update",
}
APPROVAL_TOOL_NAMES = {
    "prepare_paper_ocr",
    "publish_workspace_artifacts",
    "install_runtime_packages",
    "propose_workspace_memory_update",
}


@dataclass(frozen=True)
class AgentToolContext:
    run_id: str
    thread_id: str | None = None
    workspace_id: str | None = None


def _value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def _call(source: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    fn = _value(source, name)
    if not callable(fn):
        raise ValueError(f"Agent dependency is unavailable: {name}")
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(result)
        raise RuntimeError("Async agent tools must be invoked outside an active event loop")
    return result


def _json(value: Any) -> str:
    return json.dumps(to_json(value), ensure_ascii=False, separators=(",", ":"))


def _error(error: Exception) -> str:
    return _json({"error": {"code": getattr(error, "code", "agent_tool_failed"), "message": str(error)}})


def _ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    if not isinstance(value, str):
        return []
    try:
        decoded = json.loads(value)
        if isinstance(decoded, list):
            return [item for item in decoded if isinstance(item, str) and item]
    except ValueError:
        pass
    return [item.strip() for item in value.split(",") if item.strip()]


class AgentToolExecutor:
    def __init__(self, context: AgentToolContext, deps: Any) -> None:
        self.context = context
        self.deps = deps
        self.repos = _value(deps, "repos", deps)
        self.todos: list[dict[str, str]] = []

    def execute(self, name: str, arguments: Mapping[str, Any] | None = None, tool_call_id: str | None = None) -> str:
        arguments = dict(arguments or {})
        try:
            if name in APPROVAL_TOOL_NAMES:
                approval = _value(self.deps, "interrupt")
                if not callable(approval):
                    raise ValueError(f"Approval handler is unavailable for {name}")
                result = _call(self.deps, "interrupt", name, arguments)
                if result is not None:
                    return _json(result)
            if name in IDEMPOTENT_TOOL_NAMES:
                return self._effect(name, arguments, tool_call_id)
            return _json(self._dispatch(name, arguments))
        except Exception as error:
            return _error(error)

    def _effect(self, name: str, arguments: dict[str, Any], tool_call_id: str | None) -> str:
        if not tool_call_id:
            return _json(self._dispatch(name, arguments))
        effects = _value(self.repos, "agentToolEffects")
        if effects is None:
            raise ValueError("Agent tool effects repository is unavailable")
        existing = _call(effects, "get", self.context.run_id, tool_call_id)
        if existing and existing["status"] == "done" and isinstance(existing.get("result"), str):
            return existing["result"]
        if existing and existing["status"] == "running":
            return _json({"error": "This tool call has an unknown outcome from an interrupted run."})
        _call(effects, "begin", {"runId": self.context.run_id, "toolCallId": tool_call_id, "toolName": name, "workspaceId": self.context.workspace_id})
        try:
            result = _json(self._dispatch(name, arguments))
        except Exception as error:
            _call(effects, "finish", self.context.run_id, tool_call_id, "error", str(error))
            raise
        _call(effects, "finish", self.context.run_id, tool_call_id, "done", result)
        return result

    def _repo(self, name: str) -> Any:
        repo = _value(self.repos, name)
        if repo is None:
            raise ValueError(f"Repository is unavailable: {name}")
        return repo

    def _workspace(self) -> str:
        if not self.context.workspace_id:
            raise ValueError("A Workspace must be selected for this tool")
        return self.context.workspace_id

    def _dispatch(self, name: str, args: dict[str, Any]) -> Any:
        if name == "search_library":
            docs = _call(self._repo("documents"), "search", args.get("query", ""), 20)
            return [{"docId": doc["id"], "title": doc.get("title") or doc.get("fileName"), "authors": doc.get("authors"), "year": doc.get("year")} for doc in docs[:20]]
        if name == "get_paper_metadata":
            doc = _call(self._repo("documents"), "get", args["docId"])
            return doc or {"error": "Document not found."}
        if name == "read_paper_fulltext":
            return self._read_fulltext(args, False)
        if name == "read_paper_ocr_fulltext":
            return self._read_fulltext(args, True)
        if name == "get_paper_summary":
            summary = _call(self._repo("aiSummaries"), "getSummary", args["docId"])
            return summary["content"] if summary and summary.get("content") is not None else {"error": "No summary is available."}
        if name == "request_summary":
            service = _value(self.deps, "ai_summary")
            if callable(service):
                _call(self.deps, "ai_summary", args["docId"])
                return {"status": "queued", "docId": args["docId"]}
            return {"status": "unavailable", "docId": args["docId"]}
        if name == "list_workspace_context":
            workspace = self._workspace()
            return {"workspaceId": workspace, "items": _call(self._repo("workspaceItems"), "list", workspace), "connections": _call(self._repo("workspaceConnections"), "list", workspace)}
        if name == "search_workspace_docs":
            workspace = self._workspace()
            item_doc_ids = {item["docId"] for item in _call(self._repo("workspaceItems"), "list", workspace) if item.get("docId")}
            docs = _call(self._repo("documents"), "search", args.get("query", ""), 50) if args.get("query") else _call(self._repo("documents"), "list", {"mode": "all"})
            return [{"docId": doc["id"], "title": doc.get("title") or doc.get("fileName"), "authors": doc.get("authors"), "year": doc.get("year")} for doc in docs if doc["id"] in item_doc_ids][:50]
        if name == "add_docs_to_workspace":
            workspace = self._workspace()
            requested = _ids(args.get("docIds"))
            documents = self._repo("documents")
            items = self._repo("workspaceItems")
            present = {item["docId"] for item in _call(items, "list", workspace) if item.get("docId")}
            valid = [doc_id for doc_id in requested if _call(documents, "get", doc_id)]
            added = _call(items, "add", workspace, "document", [doc_id for doc_id in valid if doc_id not in present])
            return {"added": [item["docId"] for item in added], "alreadyInWorkspace": [doc_id for doc_id in requested if doc_id in present], "missing": [doc_id for doc_id in requested if doc_id not in valid]}
        if name == "create_workspace_connections":
            workspace = self._workspace()
            items = {item["id"] for item in _call(self._repo("workspaceItems"), "list", workspace)}
            created, errors = [], []
            for connection in args.get("connections", []):
                source, target = connection.get("sourceItemId"), connection.get("targetItemId")
                if not source or not target or source == target or source not in items or target not in items:
                    errors.append({"connection": connection, "message": "Invalid workspace connection"})
                    continue
                created.append(_call(self._repo("workspaceConnections"), "create", workspace, source, target, connection.get("sourceAnchor", "right"), connection.get("targetAnchor", "left")))
            return {"created": created, "errors": errors}
        if name == "generate_report":
            workspace = self._workspace()
            report = _call(self._repo("aiReports"), "create", workspace, args["title"], args["contentMd"], _ids(args.get("sourceDocIds")))
            _call(self._repo("workspaceItems"), "add", workspace, "report", [report["id"]])
            return report
        if name == "list_workspace_assets":
            return _call(self._repo("workspaceAssets"), "list", self._workspace())
        if name == "list_workspace_notes":
            return _call(self._repo("workspaceNotes"), "list", self._workspace())
        if name == "publish_workspace_artifacts":
            return _call(self.deps, "publish_artifacts", self.context.workspace_id, args.get("paths", []), {key: args[key] for key in ("x", "y") if key in args})
        if name == "install_runtime_packages":
            return _call(self.deps, "install_runtime_packages", self.context.workspace_id, args)
        if name == "prepare_paper_ocr":
            return _call(self.deps, "prepare_paper_ocr", args["docId"])
        if name == "propose_workspace_memory_update":
            return update_memory(self.repos, self.context.workspace_id, args["path"], args["content"], source_thread_id=self.context.thread_id, source_run_id=self.context.run_id)
        if name == "write_todos":
            todos = args.get("todos")
            if not isinstance(todos, list) or any(not isinstance(todo, Mapping) or not isinstance(todo.get("content"), str) or todo.get("status") not in {"pending", "in_progress", "completed"} for todo in todos):
                raise ValueError("Todos are invalid")
            self.todos = [{"content": todo["content"].strip(), "status": todo["status"]} for todo in todos if todo["content"].strip()]
            return {"todos": self.todos}
        if name == "web_search":
            return _call(self.deps, "web_search", args)
        if name == "web_fetch":
            return _call(self.deps, "web_fetch", args)
        if name in {"search_arxiv", "get_arxiv_paper", "resolve_academic_identity", "get_citing_papers", "get_referenced_papers", "get_semantic_recommendations", "explore_research_frontier"}:
            return self._academic(name, args)
        raise ValueError(f"Unsupported agent tool: {name}")

    def _read_fulltext(self, args: dict[str, Any], ocr: bool) -> dict[str, Any]:
        doc = _call(self._repo("documents"), "get", args["docId"])
        if not doc:
            return {"error": "Document not found."}
        if ocr:
            text = _call(self.deps, "read_ocr_fulltext", args["docId"])
        else:
            entry = _call(self._repo("aiSummaries"), "getFullText", args["docId"])
            text = entry.get("text", "") if entry else ""
        offset, limit = max(0, int(args.get("offset", 0))), min(12_000, max(500, int(args.get("limit", 8_000))))
        return {"docId": args["docId"], "title": doc.get("title") or doc.get("fileName"), "offset": offset, "limit": limit, "totalChars": len(text), "nextOffset": offset + limit if offset + limit < len(text) else None, "text": text[offset:offset + limit]}

    def _academic(self, name: str, args: dict[str, Any]) -> Any:
        academic = _value(self.deps, "academic")
        if name == "search_arxiv":
            return _call(_value(academic, "arxiv"), "search", ArxivSearchInput(**args))
        if name == "get_arxiv_paper":
            return _call(_value(academic, "arxiv_papers"), "get_paper", args["arxivId"], args.get("sectionId"), args.get("cursor"), args.get("maxChars"))
        locator = PaperLocator(**args["paper"]) if "paper" in args else None
        if name == "resolve_academic_identity":
            return _call(_value(academic, "identity"), "resolve", locator)
        if name == "get_citing_papers":
            return _call(_value(academic, "graph"), "get_citing_papers", locator, args.get("cursor"), args.get("limit"), {"publishedAfter": args.get("publishedAfter")} if args.get("publishedAfter") else None)
        if name == "get_referenced_papers":
            return _call(_value(academic, "graph"), "get_referenced_papers", locator, args.get("cursor"), args.get("limit"), {"publishedAfter": args.get("publishedAfter")} if args.get("publishedAfter") else None)
        if name == "get_semantic_recommendations":
            return _call(_value(academic, "graph"), "get_recommendations", locator, args.get("limit"))
        frontier = _value(academic, "frontier")
        return _call(frontier, {"start": "start", "expand": "expand", "continue": "continue"}[args["action"]], args)


def _schema(required: list[str], properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def create_agent_tools(context: AgentToolContext, deps: Any) -> list[StructuredTool]:
    executor = AgentToolExecutor(context, deps)
    text = {"type": "string"}
    schemas = {
        "search_library": _schema(["query"], {"query": text}), "get_paper_metadata": _schema(["docId"], {"docId": text}),
        "read_paper_fulltext": _schema(["docId"], {"docId": text, "offset": {"type": "integer", "default": 0}, "limit": {"type": "integer", "default": 8000}}),
        "read_paper_ocr_fulltext": _schema(["docId"], {"docId": text, "offset": {"type": "integer", "default": 0}, "limit": {"type": "integer", "default": 8000}}),
        "get_paper_summary": _schema(["docId"], {"docId": text}), "request_summary": _schema(["docId"], {"docId": text}),
        "list_workspace_context": _schema([], {}), "search_workspace_docs": _schema(["query"], {"query": text}),
        "add_docs_to_workspace": _schema(["docIds"], {"docIds": text}), "create_workspace_connections": _schema(["connections"], {"connections": {"type": "array"}}),
        "generate_report": _schema(["title", "contentMd", "sourceDocIds"], {"title": text, "contentMd": text, "sourceDocIds": text}),
        "list_workspace_assets": _schema([], {}), "list_workspace_notes": _schema([], {}),
        "publish_workspace_artifacts": _schema(["paths"], {"paths": {"type": "array"}, "x": {"type": "number"}, "y": {"type": "number"}}),
        "install_runtime_packages": _schema([], {"runtimes": {"type": "array"}, "python": {"type": "array"}, "node": {"type": "array"}}),
        "prepare_paper_ocr": _schema(["docId"], {"docId": text}),
        "propose_workspace_memory_update": _schema(["path", "content", "rationale"], {"path": text, "content": text, "rationale": text}),
        "write_todos": _schema(["todos"], {"todos": {"type": "array"}}), "web_search": _schema(["query"], {"query": text}),
        "web_fetch": _schema(["url"], {"url": text, "maxChars": {"type": "integer", "default": 20000}}),
        "search_arxiv": _schema(["query"], {"query": text}), "get_arxiv_paper": _schema(["arxivId"], {"arxivId": text}),
        "resolve_academic_identity": _schema(["paper"], {"paper": {"type": "object"}}), "get_citing_papers": _schema(["paper"], {"paper": {"type": "object"}}),
        "get_referenced_papers": _schema(["paper"], {"paper": {"type": "object"}}), "get_semantic_recommendations": _schema(["paper"], {"paper": {"type": "object"}}),
        "explore_research_frontier": _schema(["action"], {"action": text}),
    }
    return [StructuredTool(name=name, description=name.replace("_", " "), args_schema=schema, func=lambda _name=name, **arguments: executor.execute(_name, arguments, arguments.pop("_refora_tool_call_id", None))) for name, schema in schemas.items()]
