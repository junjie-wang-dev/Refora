from __future__ import annotations

from refora_server.agent.permissions import Mode, PermissionEngine
from refora_server.agent.risk import RiskClass, classify


def test_interactive_mode_allows_read_tools():
    decision = PermissionEngine().evaluate("search_library", {"query": "agents"})

    assert decision.allowed
    assert not decision.needs_user


def test_interactive_mode_requires_approval_for_external_tools():
    decision = PermissionEngine().evaluate("prepare_paper_ocr", {"docId": "doc-1"})

    assert not decision.allowed
    assert decision.needs_user


def test_plan_mode_rejects_local_writes():
    decision = PermissionEngine(mode=Mode.PLAN).evaluate(
        "generate_report",
        {"title": "Report", "contentMd": "# Report", "sourceDocIds": "[]"},
    )

    assert not decision.allowed
    assert "plan mode" in decision.reason


def test_plan_mode_allows_read_tools():
    decision = PermissionEngine(mode=Mode.PLAN).evaluate("search_library", {"query": "agents"})

    assert decision.allowed
    assert not decision.needs_user


def test_shell_operators_do_not_bypass_command_allowlist():
    engine = PermissionEngine(allowed_commands=["python -m pytest"])

    decision = engine.evaluate("__execute", {"command": "python -m pytest; rm -rf /"})

    assert not decision.allowed
    assert decision.needs_user


def test_classify_refora_tools():
    expected = {
        "search_library": RiskClass.READ,
        "get_paper_metadata": RiskClass.READ,
        "read_paper_fulltext": RiskClass.READ,
        "read_paper_ocr_fulltext": RiskClass.READ,
        "get_paper_summary": RiskClass.READ,
        "list_workspace_context": RiskClass.READ,
        "search_workspace_docs": RiskClass.READ,
        "find_related_papers": RiskClass.READ,
        "search_arxiv": RiskClass.READ,
        "get_arxiv_paper": RiskClass.READ,
        "resolve_academic_identity": RiskClass.READ,
        "get_citing_papers": RiskClass.READ,
        "get_referenced_papers": RiskClass.READ,
        "get_semantic_recommendations": RiskClass.READ,
        "explore_research_frontier": RiskClass.READ,
        "web_search": RiskClass.READ,
        "web_fetch": RiskClass.READ,
        "list_workspace_assets": RiskClass.READ,
        "list_workspace_notes": RiskClass.READ,
        "open_paper": RiskClass.READ,
        "write_todos": RiskClass.READ,
        "request_summary": RiskClass.WRITE_LOCAL,
        "generate_report": RiskClass.WRITE_LOCAL,
        "add_docs_to_workspace": RiskClass.WRITE_LOCAL,
        "create_workspace_connections": RiskClass.WRITE_LOCAL,
        "prepare_paper_ocr": RiskClass.EXTERNAL,
        "publish_workspace_artifacts": RiskClass.EXTERNAL,
        "install_runtime_packages": RiskClass.EXTERNAL,
        "propose_workspace_memory_update": RiskClass.EXTERNAL,
        "__execute": RiskClass.EXEC,
    }

    assert {tool_name: classify(tool_name) for tool_name in expected} == expected
