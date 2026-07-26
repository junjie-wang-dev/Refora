from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, ids, object_schema, repo, value, workspace
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}


def list_workspace_context(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    return {"workspaceId": ws, "items": call(repo(executor.repos, "workspaceItems"), "list", ws), "connections": call(repo(executor.repos, "workspaceConnections"), "list", ws)}


def search_workspace_docs(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    item_doc_ids = {item["docId"] for item in call(repo(executor.repos, "workspaceItems"), "list", ws) if item.get("docId")}
    docs = call(repo(executor.repos, "documents"), "search", args.get("query", ""), 50) if args.get("query") else call(repo(executor.repos, "documents"), "list", {"mode": "all"})
    return [{"docId": doc["id"], "title": doc.get("title") or doc.get("fileName"), "authors": doc.get("authors"), "year": doc.get("year")} for doc in docs if doc["id"] in item_doc_ids][:50]


def add_docs_to_workspace(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    requested = ids(args.get("docIds"))
    documents = repo(executor.repos, "documents")
    items = repo(executor.repos, "workspaceItems")
    present = {item["docId"] for item in call(items, "list", ws) if item.get("docId")}
    valid = [doc_id for doc_id in requested if call(documents, "get", doc_id)]
    added = call(items, "add", ws, "document", [doc_id for doc_id in valid if doc_id not in present])
    return {"added": [item["docId"] for item in added], "alreadyInWorkspace": [doc_id for doc_id in requested if doc_id in present], "missing": [doc_id for doc_id in requested if doc_id not in valid]}


def create_workspace_connections(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    items = {item["id"] for item in call(repo(executor.repos, "workspaceItems"), "list", ws)}
    created, errors = [], []
    for connection in args.get("connections", []):
        source, target = connection.get("sourceItemId"), connection.get("targetItemId")
        if not source or not target or source == target or source not in items or target not in items:
            errors.append({"connection": connection, "message": "Invalid workspace connection"})
            continue
        created.append(call(repo(executor.repos, "workspaceConnections"), "create", ws, source, target, connection.get("sourceAnchor", "right"), connection.get("targetAnchor", "left")))
    return {"created": created, "errors": errors}


def generate_report(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    report = call(repo(executor.repos, "aiReports"), "create", ws, args["title"], args["contentMd"], ids(args.get("sourceDocIds")))
    call(repo(executor.repos, "workspaceItems"), "add", ws, "report", [report["id"]])
    return report


def list_workspace_assets(executor: Any, args: dict[str, Any]) -> Any:
    return call(repo(executor.repos, "workspaceAssets"), "list", workspace(executor))


def list_workspace_notes(executor: Any, args: dict[str, Any]) -> Any:
    return call(repo(executor.repos, "workspaceNotes"), "list", workspace(executor))


_CONNECTION_ITEM_SCHEMA = object_schema(
    {
        "sourceItemId": {"type": "string", "minLength": 1},
        "targetItemId": {"type": "string", "minLength": 1},
        "sourceAnchor": {"type": "string", "enum": ["top", "right", "bottom", "left"], "default": "right"},
        "targetAnchor": {"type": "string", "enum": ["top", "right", "bottom", "left"], "default": "left"},
    },
    ["sourceItemId", "targetItemId"],
)


class WorkspaceTools(ToolGroup):
    name = "workspace"
    handlers = {
        "list_workspace_context": list_workspace_context,
        "search_workspace_docs": search_workspace_docs,
        "add_docs_to_workspace": add_docs_to_workspace,
        "create_workspace_connections": create_workspace_connections,
        "generate_report": generate_report,
        "list_workspace_assets": list_workspace_assets,
        "list_workspace_notes": list_workspace_notes,
    }
    descriptions = {
        "list_workspace_context": "List the current workspace cards and connections. Returns itemIds for documents, reports, notes, and assets plus existing directed connections. Use the returned itemIds with create_workspace_connections.",
        "search_workspace_docs": "Search documents in the current workspace by title, authors, abstract, or keywords (full-text). Returns JSON [{docId, title, authors, year, hasSummary}]. Pass an empty string to list all workspace documents.",
        "add_docs_to_workspace": "Add documents from the library to the current workspace board. Pass docIds as a comma-separated list or JSON array string. Returns JSON with added, alreadyInWorkspace, and missing arrays.",
        "create_workspace_connections": "Create directed connections between cards in the current workspace. Call list_workspace_context first and use only itemIds returned by it. Invalid, duplicate, and self connections are reported without creating them.",
        "generate_report": "Create and pin a structured report to the workspace board. Use this when the user asks for a report, survey, or comparison. sourceDocIds accepts a comma-separated list or a JSON array string of docIds.",
    }
    schemas = {
        "list_workspace_context": object_schema({}),
        "search_workspace_docs": object_schema({"query": _TEXT}, ["query"]),
        "add_docs_to_workspace": object_schema({"docIds": _TEXT}, ["docIds"]),
        "create_workspace_connections": object_schema({"connections": {"type": "array", "minItems": 1, "maxItems": 20, "items": _CONNECTION_ITEM_SCHEMA}}, ["connections"]),
        "generate_report": object_schema({"title": _TEXT, "contentMd": _TEXT, "sourceDocIds": {"type": "string", "description": "Comma-separated list or JSON array string of docIds"}}, ["title", "contentMd", "sourceDocIds"]),
        "list_workspace_assets": object_schema({}),
        "list_workspace_notes": object_schema({}),
    }