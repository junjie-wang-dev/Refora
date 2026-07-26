from __future__ import annotations

import json

from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor


def _effects():
    return {
        "get": lambda _run_id, _tool_call_id: None,
        "begin": lambda _input: None,
        "finish": lambda _run_id, _tool_call_id, _status, _result: None,
    }


def test_workspace_mutations_emit_refresh_events():
    changed: list[tuple[str, str]] = []
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
            "create": lambda *_args: {"id": "connection-1"}
        },
        "aiReports": {
            "create": lambda workspace_id, title, content, source_ids: {
                "id": "report-1",
                "workspaceId": workspace_id,
                "title": title,
                "contentMd": content,
                "sourceDocIds": source_ids,
            }
        },
        "agentToolEffects": _effects(),
    }
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run", workspace_id="workspace"),
        {
            "repos": repos,
            "workspace_changed": lambda workspace_id, reason: changed.append(
                (workspace_id, reason)
            ),
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

    result = json.loads(executor.execute("search_workspace_docs", {"query": ""}))

    assert result[0]["hasSummary"] is True
