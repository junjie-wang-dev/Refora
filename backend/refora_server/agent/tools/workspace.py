from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, ids, object_schema, repo, value, workspace
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}


def _transaction(executor: Any, operation: Any) -> Any:
    transaction = value(executor.repos, "transaction")
    return transaction(operation) if callable(transaction) else operation()


def list_workspace_context(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    reports = {
        report["id"]: report
        for report in call(repo(executor.repos, "aiReports"), "list", ws)
    }
    notes = {
        note["id"]: note
        for note in call(repo(executor.repos, "workspaceNotes"), "list", ws)
    }
    assets = {
        asset["id"]: asset
        for asset in call(repo(executor.repos, "workspaceAssets"), "list", ws)
    }
    context_items = []
    for item in call(repo(executor.repos, "workspaceItems"), "list", ws):
        context_item = {
            "itemId": item["id"],
            "kind": item["kind"],
            "sortOrder": item["sortOrder"],
        }
        if item["kind"] == "document" and item.get("docId"):
            document = call(
                repo(executor.repos, "documents"), "get", item["docId"]
            )
            summary = call(
                repo(executor.repos, "aiSummaries"),
                "getSummary",
                item["docId"],
            )
            context_item.update(
                {
                    "docId": item["docId"],
                    "title": (
                        document.get("title")
                        or document.get("fileName")
                        or item["docId"]
                    )
                    if document
                    else item["docId"],
                    "authors": document.get("authors") or "" if document else "",
                    "year": document.get("year") or "" if document else "",
                    "hasSummary": bool(summary and summary.get("content")),
                    "unavailable": document is None,
                }
            )
        elif item["kind"] == "report" and item.get("reportId"):
            report = reports.get(item["reportId"])
            context_item.update(
                {
                    "reportId": item["reportId"],
                    "title": report.get("title") or item["reportId"]
                    if report
                    else item["reportId"],
                    "sourceDocIds": report.get("sourceDocIds") or []
                    if report
                    else [],
                    "unavailable": report is None,
                }
            )
        elif item["kind"] == "note" and item.get("noteId"):
            note = notes.get(item["noteId"])
            context_item.update(
                {
                    "noteId": item["noteId"],
                    "title": note.get("title") or item["noteId"]
                    if note
                    else item["noteId"],
                    "noteType": note.get("noteType") if note else None,
                    "unavailable": note is None,
                }
            )
        elif item["kind"] == "asset" and item.get("assetId"):
            asset = assets.get(item["assetId"])
            context_item.update(
                {
                    "assetId": item["assetId"],
                    "fileName": asset.get("fileName") or item["assetId"]
                    if asset
                    else item["assetId"],
                    "mimeType": asset.get("mimeType") if asset else None,
                    "previewKind": asset.get("previewKind") if asset else None,
                    "fileMissing": asset.get("fileMissing", 1) if asset else 1,
                    "unavailable": asset is None,
                }
            )
        else:
            context_item["unavailable"] = True
        context_items.append(context_item)
    connections = [
        {
            "connectionId": connection["id"],
            "sourceItemId": connection["sourceItemId"],
            "targetItemId": connection["targetItemId"],
            "sourceAnchor": connection["sourceAnchor"],
            "targetAnchor": connection["targetAnchor"],
        }
        for connection in call(
            repo(executor.repos, "workspaceConnections"), "list", ws
        )
    ]
    return {
        "workspaceId": ws,
        "itemCount": len(context_items),
        "connectionCount": len(connections),
        "items": context_items,
        "connections": connections,
    }


def read_workspace_item(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    item = next(
        (
            current
            for current in call(repo(executor.repos, "workspaceItems"), "list", ws)
            if current.get("id") == args["itemId"]
        ),
        None,
    )
    if item is None:
        raise ValueError("Item is not available in the current workspace")
    kind = item.get("kind")
    if kind == "document" and item.get("docId"):
        document = call(repo(executor.repos, "documents"), "get", item["docId"])
        if document is None:
            raise ValueError("Document is not available in the current workspace")
        summaries = value(executor.repos, "aiSummaries")
        summary = (
            call(summaries, "getSummary", item["docId"])
            if summaries
            else None
        )
        data = {
            **document,
            "docId": item["docId"],
            "hasSummary": bool(summary and summary.get("content")),
            "summary": summary.get("content") if summary else None,
        }
    elif kind == "report" and item.get("reportId"):
        data = call(repo(executor.repos, "aiReports"), "get", item["reportId"])
        if data is None or data.get("workspaceId") != ws:
            raise ValueError("Report is not available in the current workspace")
    elif kind == "note" and item.get("noteId"):
        data = call(repo(executor.repos, "workspaceNotes"), "get", item["noteId"])
        if data is None or data.get("workspaceId") != ws:
            raise ValueError("Note is not available in the current workspace")
    elif kind == "asset" and item.get("assetId"):
        asset = call(repo(executor.repos, "workspaceAssets"), "get", item["assetId"])
        if asset is None or asset.get("workspaceId") != ws:
            raise ValueError("Asset is not available in the current workspace")
        preview = (
            call(
                executor.deps,
                "preview_workspace_asset",
                ws,
                item["assetId"],
            )
            if asset.get("previewKind") == "text"
            else None
        )
        data = {**asset, "preview": preview}
    else:
        raise ValueError("Workspace item type is unsupported")
    return {"itemId": item["id"], "kind": kind, "data": data}


def add_docs_to_workspace(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    requested = ids(args.get("docIds"))
    documents = repo(executor.repos, "documents")
    items = repo(executor.repos, "workspaceItems")
    present = {item["docId"] for item in call(items, "list", ws) if item.get("docId")}
    valid = [doc_id for doc_id in requested if call(documents, "get", doc_id)]
    added = call(items, "add", ws, "document", [doc_id for doc_id in valid if doc_id not in present])
    if added and callable(value(executor.deps, "workspace_changed")):
        call(executor.deps, "workspace_changed", ws, "agent_add_docs")
    return {"added": [item["docId"] for item in added], "alreadyInWorkspace": [doc_id for doc_id in requested if doc_id in present], "missing": [doc_id for doc_id in requested if doc_id not in valid]}


def create_workspace_connections(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    items = {item["id"] for item in call(repo(executor.repos, "workspaceItems"), "list", ws)}
    connections_repo = repo(executor.repos, "workspaceConnections")
    existing = {
        (connection["sourceItemId"], connection["targetItemId"])
        for connection in call(connections_repo, "list", ws)
    }
    requested = set()
    valid, errors = [], []
    for connection in args.get("connections", []):
        source, target = connection.get("sourceItemId"), connection.get("targetItemId")
        error = None
        if not source or not target or source not in items or target not in items:
            error = "Connection endpoint is not in the current workspace."
        elif source == target:
            error = "A card cannot connect to itself."
        elif (source, target) in existing or (source, target) in requested:
            error = "Connection already exists."
        if error is not None:
            errors.append(
                {
                    "sourceItemId": source,
                    "targetItemId": target,
                    "message": error,
                }
            )
            continue
        requested.add((source, target))
        valid.append(connection)
    created = _transaction(
        executor,
        lambda: [
            call(
                connections_repo,
                "create",
                ws,
                connection["sourceItemId"],
                connection["targetItemId"],
                connection.get("sourceAnchor", "right"),
                connection.get("targetAnchor", "left"),
            )
            for connection in valid
        ],
    )
    if created and callable(value(executor.deps, "workspace_changed")):
        call(executor.deps, "workspace_changed", ws, "other")
    return {"created": created, "errors": errors}


def generate_report(executor: Any, args: dict[str, Any]) -> Any:
    ws = workspace(executor)
    workspace_doc_ids = {
        item["docId"]
        for item in call(repo(executor.repos, "workspaceItems"), "list", ws)
        if item.get("kind") == "document" and item.get("docId")
    }
    source_doc_ids = [
        document_id
        for document_id in ids(args.get("sourceDocIds"))
        if document_id in workspace_doc_ids
    ]

    def create() -> Any:
        created = call(
            repo(executor.repos, "aiReports"),
            "create",
            ws,
            args["title"],
            args["contentMd"],
            source_doc_ids,
            value(executor.deps, "model"),
        )
        call(
            repo(executor.repos, "workspaceItems"),
            "add",
            ws,
            "report",
            [created["id"]],
        )
        return created

    report = _transaction(executor, create)
    if callable(value(executor.deps, "report_created")):
        call(executor.deps, "report_created", report)
    if callable(value(executor.deps, "workspace_changed")):
        call(executor.deps, "workspace_changed", ws, "other")
    return {
        "created": True,
        "reportId": report["id"],
        "title": report["title"],
        "workspaceId": ws,
        "sourceDocIds": report["sourceDocIds"],
    }


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
        "read_workspace_item": read_workspace_item,
        "add_docs_to_workspace": add_docs_to_workspace,
        "create_workspace_connections": create_workspace_connections,
        "generate_report": generate_report,
    }
    descriptions = {
        "list_workspace_context": "List the current workspace cards and connections. Returns itemIds for documents, reports, notes, and assets plus existing directed connections. Use the returned itemIds with create_workspace_connections.",
        "read_workspace_item": "Read one current workspace card by itemId from list_workspace_context. Returns full report or note content, document metadata and cached summary, or asset metadata and text preview.",
        "add_docs_to_workspace": "Add documents from the library to the current workspace board. Pass docIds as a comma-separated list or JSON array string. Returns JSON with added, alreadyInWorkspace, and missing arrays.",
        "create_workspace_connections": "Create directed connections between cards in the current workspace. Call list_workspace_context first and use only itemIds returned by it. Invalid, duplicate, and self connections are reported without creating them.",
        "generate_report": "Create and pin a structured report to the workspace board. Use this when the user asks for a report, survey, or comparison. sourceDocIds accepts a comma-separated list or a JSON array string of docIds.",
    }
    schemas = {
        "list_workspace_context": object_schema({}),
        "read_workspace_item": object_schema({"itemId": _TEXT}, ["itemId"]),
        "add_docs_to_workspace": object_schema({"docIds": _TEXT}, ["docIds"]),
        "create_workspace_connections": object_schema({"connections": {"type": "array", "minItems": 1, "maxItems": 20, "items": _CONNECTION_ITEM_SCHEMA}}, ["connections"]),
        "generate_report": object_schema({"title": _TEXT, "contentMd": _TEXT, "sourceDocIds": {"type": "string", "description": "Comma-separated list or JSON array string of docIds"}}, ["title", "contentMd", "sourceDocIds"]),
    }
