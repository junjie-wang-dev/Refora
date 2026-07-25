from __future__ import annotations

import json

from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor, create_agent_tools


class Functions(dict):
    def __getattr__(self, name):
        return self[name]


def test_tool_factory_covers_read_web_academic_workspace_memory_and_todo_tools():
    tools = create_agent_tools(AgentToolContext(run_id="run"), {})
    names = {tool.name for tool in tools}

    assert {"search_library", "read_paper_fulltext", "web_search", "web_fetch", "search_arxiv", "get_semantic_recommendations", "list_workspace_context", "list_workspace_assets", "list_workspace_notes", "generate_report", "propose_workspace_memory_update", "write_todos"} <= names


def test_write_tool_uses_effects_and_replays_finished_result():
    calls = []
    state = {"effect": None}

    def get(run_id, tool_call_id):
        return state["effect"]

    def begin(value):
        calls.append(("begin", value))
        state["effect"] = {"status": "running"}
        return state["effect"]

    def finish(run_id, tool_call_id, status, result):
        calls.append(("finish", status))
        state["effect"] = {"status": status, "result": result}
        return state["effect"]

    items = Functions(list=lambda workspace_id: [], add=lambda workspace_id, kind, ids: [{"docId": doc_id} for doc_id in ids])
    docs = Functions(get=lambda doc_id: {"id": doc_id})
    repos = {"documents": docs, "workspaceItems": items, "agentToolEffects": Functions(get=get, begin=begin, finish=finish)}
    executor = AgentToolExecutor(AgentToolContext(run_id="run", workspace_id="workspace"), {"repos": repos})

    result = executor.execute("add_docs_to_workspace", {"docIds": "doc-1"}, "call-1")
    replay = executor.execute("add_docs_to_workspace", {"docIds": "doc-1"}, "call-1")

    assert json.loads(result)["added"] == ["doc-1"]
    assert replay == result
    assert [call[0] for call in calls] == ["begin", "finish"]


def test_approval_sensitive_memory_tool_interrupts_before_writing():
    interrupted = []
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run"),
        {"repos": {}, "interrupt": lambda name, args: interrupted.append((name, args)) or {"status": "interrupted"}},
    )

    result = json.loads(executor.execute("propose_workspace_memory_update", {"path": "/brief.md", "content": "x", "rationale": "stable"}, "call"))

    assert result == {"status": "interrupted"}
    assert interrupted[0][0] == "propose_workspace_memory_update"
