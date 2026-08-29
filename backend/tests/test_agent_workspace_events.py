from __future__ import annotations

import json

from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor


def _effects():
    return {
        "get": lambda _run_id, _tool_call_id: None,
        "begin": lambda _input: {"status": "running"},
        "finish": lambda _run_id, _tool_call_id, _status, _result: None,
    }


def test_workspace_mutations_emit_refresh_events():
    changed: list[tuple[str, str]] = []
    reports = []
    transactions = []
    items = [
        {"id": "source", "kind": "document", "docId": "doc-1"},
        {"id": "target", "kind": "document", "docId": "doc-2"},
    ]
    repos = {
        "documents": {"get": lambda document_id: {"id": document_id}},
        "workspaceItems": {
            "list": lambda _workspace_id: list(items),
            "add": lambda _workspace_id, kind, identifiers: [
                {"id": f"{kind}-{identifier}", "docId": identifier}
                for identifier in identifiers
            ],
        },
        "workspaceConnections": {
            "list": lambda _workspace_id: [],
            "create": lambda *_args: {"id": "connection-1"}
        },
        "aiReports": {
            "create": lambda workspace_id, title, content, source_ids, model: {
                "id": "report-1",
                "workspaceId": workspace_id,
                "title": title,
                "contentMd": content,
                "sourceDocIds": source_ids,
                "model": model,
            }
        },
        "agentToolEffects": _effects(),
        "transaction": lambda operation: transactions.append("transaction")
        or operation(),
    }
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": repos,
            "workspace_changed": lambda workspace_id, reason: changed.append(
                (workspace_id, reason)
            ),
            "report_created": reports.append,
            "model": "model-1",
        },
    )

    json.loads(
        executor.execute(
            "add_docs_to_workspace", {"docIds": ["doc-3"]}, "add-call"
        )
    )
    json.loads(
        executor.execute(
            "create_workspace_connections",
            {
                "connections": [
                    {"sourceItemId": "source", "targetItemId": "target"}
                ]
            },
            "connection-call",
        )
    )
    json.loads(
        executor.execute(
            "generate_report",
            {"title": "Report", "contentMd": "Body", "sourceDocIds": ["doc-1"]},
            "report-call",
        )
    )

    assert changed == [
        ("workspace", "agent_add_docs"),
        ("workspace", "other"),
        ("workspace", "other"),
    ]
    assert transactions == ["transaction", "transaction"]
    assert reports == [
        {
            "id": "report-1",
            "workspaceId": "workspace",
            "title": "Report",
            "contentMd": "Body",
            "sourceDocIds": ["doc-1"],
            "model": "model-1",
        }
    ]


def test_update_report_is_scoped_to_the_current_workspace_and_emits_refresh():
    changed: list[tuple[str, str]] = []
    updates: list[tuple[str, dict[str, str]]] = []
    reports = {
        "report-current": {
            "id": "report-current",
            "workspaceId": "workspace",
            "title": "Current report",
            "contentMd": "Original",
        },
        "report-other": {
            "id": "report-other",
            "workspaceId": "other-workspace",
            "title": "Other report",
            "contentMd": "Private",
        },
    }

    def update(report_id: str, patch: dict[str, str]):
        updates.append((report_id, patch))
        reports[report_id].update(patch)
        return reports[report_id]

    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": {
                "aiReports": {
                    "get": reports.get,
                    "update": update,
                }
            },
            "workspace_changed": lambda workspace_id, reason: changed.append(
                (workspace_id, reason)
            ),
        },
    )

    updated = json.loads(
        executor.execute(
            "update_report",
            {"reportId": "report-current", "contentMd": "Revised"},
        )
    )
    outside = json.loads(
        executor.execute(
            "update_report",
            {"reportId": "report-other", "title": "Leaked"},
        )
    )

    assert updated == {
        "updated": True,
        "reportId": "report-current",
        "title": "Current report",
        "workspaceId": "workspace",
    }
    assert updates == [("report-current", {"contentMd": "Revised"})]
    assert changed == [("workspace", "other")]
    assert outside["error"]["message"] == (
        "Report is not available in the current workspace"
    )


def test_workspace_search_reports_summary_availability():
    repos = {
        "workspaceItems": {
            "list": lambda _workspace_id: [
                {"kind": "document", "docId": "doc-1"}
            ]
        },
        "documents": {
            "list": lambda _filter: [
                {
                    "id": "doc-1",
                    "title": "Paper",
                    "authors": "Ada",
                    "year": "2024",
                }
            ]
        },
        "aiSummaries": {
            "getSummary": lambda _document_id: {"content": {"core": "Summary"}}
        },
    }
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {"repos": repos},
    )

    result = json.loads(
        executor.execute(
            "search_documents", {"query": "", "scope": "workspace"}
        )
    )

    assert result[0]["hasSummary"] is True


def test_workspace_context_enriches_cards_and_connections():
    repos = {
        "workspaceItems": {
            "list": lambda _workspace_id: [
                {
                    "id": "item-doc",
                    "kind": "document",
                    "docId": "doc-1",
                    "sortOrder": 0,
                },
                {
                    "id": "item-report",
                    "kind": "report",
                    "reportId": "report-1",
                    "sortOrder": 1,
                },
            ]
        },
        "workspaceConnections": {
            "list": lambda _workspace_id: [
                {
                    "id": "connection-1",
                    "sourceItemId": "item-doc",
                    "targetItemId": "item-report",
                    "sourceAnchor": "right",
                    "targetAnchor": "left",
                }
            ]
        },
        "documents": {
            "get": lambda _document_id: {
                "title": "Paper",
                "authors": "Ada",
                "year": "2025",
            }
        },
        "aiSummaries": {"getSummary": lambda _document_id: {"content": "Summary"}},
        "aiReports": {
            "list": lambda _workspace_id: [
                {
                    "id": "report-1",
                    "title": "Report",
                    "sourceDocIds": ["doc-1"],
                }
            ]
        },
        "workspaceNotes": {"list": lambda _workspace_id: []},
        "workspaceAssets": {"list": lambda _workspace_id: []},
    }
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {"repos": repos},
    )

    result = json.loads(executor.execute("list_workspace_context", {}))

    assert result["itemCount"] == 2
    assert result["connectionCount"] == 1
    assert result["items"][0] == {
        "itemId": "item-doc",
        "kind": "document",
        "sortOrder": 0,
        "docId": "doc-1",
        "title": "Paper",
        "authors": "Ada",
        "year": "2025",
        "hasSummary": True,
        "unavailable": False,
    }
    assert result["items"][1]["reportId"] == "report-1"
    assert result["connections"][0]["connectionId"] == "connection-1"


def test_workspace_item_reads_full_report_only_from_current_workspace():
    reports = {
        "report-current": {
            "id": "report-current",
            "workspaceId": "workspace",
            "title": "Current report",
            "contentMd": "# Complete report\n\nDetails",
            "sourceDocIds": ["doc-1"],
            "model": "model-1",
            "createdAt": 1,
        },
        "report-other": {
            "id": "report-other",
            "workspaceId": "other-workspace",
            "title": "Other report",
            "contentMd": "Private",
            "sourceDocIds": [],
            "model": None,
            "createdAt": 2,
        },
    }
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": {
                "workspaceItems": {
                    "list": lambda _workspace_id: [
                        {
                            "id": "item-current",
                            "kind": "report",
                            "reportId": "report-current",
                        },
                        {
                            "id": "item-other",
                            "kind": "report",
                            "reportId": "report-other",
                        },
                    ]
                },
                "aiReports": {"get": reports.get},
            }
        },
    )

    current = json.loads(
        executor.execute("read_workspace_item", {"itemId": "item-current"})
    )
    other = json.loads(
        executor.execute("read_workspace_item", {"itemId": "item-other"})
    )

    assert current["kind"] == "report"
    assert current["data"]["contentMd"] == "# Complete report\n\nDetails"
    assert other["error"]["message"] == "Report is not available in the current workspace"


def test_workspace_item_asset_preview_uses_scoped_workspace_service():
    calls = []
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": {
                "workspaceItems": {
                    "list": lambda _workspace_id: [
                        {
                            "id": "item-asset",
                            "kind": "asset",
                            "assetId": "asset-1",
                        }
                    ]
                },
                "workspaceAssets": {
                    "get": lambda _asset_id: {
                        "id": "asset-1",
                        "workspaceId": "workspace",
                        "fileName": "data.csv",
                        "previewKind": "text",
                    }
                },
            },
            "preview_workspace_asset": lambda workspace_id, asset_id: calls.append(
                (workspace_id, asset_id)
            )
            or {"content": "alpha,beta", "truncated": False},
        },
    )

    result = json.loads(
        executor.execute("read_workspace_item", {"itemId": "item-asset"})
    )

    assert result["data"]["fileName"] == "data.csv"
    assert result["data"]["preview"] == {
        "content": "alpha,beta",
        "truncated": False,
    }
    assert calls == [("workspace", "asset-1")]


def test_workspace_item_returns_non_text_asset_metadata_without_previewing():
    calls = []
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": {
                "workspaceItems": {
                    "list": lambda _workspace_id: [
                        {
                            "id": "item-image",
                            "kind": "asset",
                            "assetId": "asset-image",
                        }
                    ]
                },
                "workspaceAssets": {
                    "get": lambda _asset_id: {
                        "id": "asset-image",
                        "workspaceId": "workspace",
                        "fileName": "figure.png",
                        "previewKind": "image",
                    }
                },
            },
            "preview_workspace_asset": lambda *_args: calls.append(_args),
        },
    )

    result = json.loads(
        executor.execute("read_workspace_item", {"itemId": "item-image"})
    )

    assert result["data"]["fileName"] == "figure.png"
    assert result["data"]["previewKind"] == "image"
    assert result["data"]["preview"] is None
    assert calls == []
