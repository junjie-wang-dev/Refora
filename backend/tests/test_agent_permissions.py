from __future__ import annotations

import pytest

from refora_server.agent.permissions import Mode, PermissionEngine
from refora_server.agent.risk import RiskClass, classify


def test_interactive_mode_allows_read_tools():
    decision = PermissionEngine().evaluate("search_documents", {"query": "agents"})

    assert decision.allowed
    assert not decision.needs_user


def test_interactive_mode_requires_approval_for_external_tools():
    decision = PermissionEngine().evaluate("prepare_paper_ocr", {"docId": "doc-1"})

    assert not decision.allowed
    assert decision.needs_user


@pytest.mark.parametrize(
    "tool_name",
    [
        "search_arxiv",
        "get_arxiv_paper",
        "get_related_academic_papers",
        "explore_research_frontier",
        "web_search",
        "web_fetch",
    ],
)
def test_network_reads_are_allowed_without_approval_in_every_mode(tool_name):
    for mode in Mode:
        decision = PermissionEngine(mode=mode).evaluate(tool_name, {})
        assert decision.allowed
        assert not decision.needs_user
        assert decision.reason == "network read allowed"


def test_network_read_can_be_allowed_for_the_session():
    engine = PermissionEngine(mode=Mode.PLAN)
    engine.allow_tool_for_session("web_search")

    decision = engine.evaluate("web_search", {"query": "agents"})

    assert decision.allowed
    assert not decision.needs_user
    assert decision.reason == "network read allowed"


def test_plan_mode_rejects_local_writes():
    decision = PermissionEngine(mode=Mode.PLAN).evaluate(
        "generate_report",
        {"title": "Report", "contentMd": "# Report", "sourceDocIds": "[]"},
    )

    assert not decision.allowed
    assert "plan mode" in decision.reason


def test_plan_mode_allows_read_tools():
    decision = PermissionEngine(mode=Mode.PLAN).evaluate("search_documents", {"query": "agents"})

    assert decision.allowed
    assert not decision.needs_user


@pytest.mark.parametrize(
    "tool_name",
    [
        "generate_report",
        "add_docs_to_workspace",
        "create_workspace_connections",
    ],
)
def test_interactive_mode_allows_refora_workspace_writes(tool_name):
    decision = PermissionEngine().evaluate(tool_name, {})

    assert decision.allowed
    assert not decision.needs_user


def test_interactive_mode_allows_os_isolated_sandbox_commands_without_approval():
    engine = PermissionEngine(sandbox_root="/tmp/refora-sandbox")

    decision = engine.evaluate("__execute", {"command": "python -m pytest; rm -rf /"})

    assert decision.allowed
    assert not decision.needs_user
    assert decision.reason == "sandboxed command execution"


def test_interactive_mode_allows_allowlisted_sandbox_commands_without_approval():
    engine = PermissionEngine(
        sandbox_root="/tmp/refora-sandbox",
        allowed_commands=["python -m pytest"],
    )

    decision = engine.evaluate("__execute", {"command": "python -m pytest -q"})

    assert decision.allowed
    assert not decision.needs_user
    assert decision.reason == "sandboxed command execution"


def test_sandbox_command_without_a_managed_root_still_requires_approval():
    decision = PermissionEngine().evaluate(
        "__execute", {"command": "python analyze.py"}
    )

    assert not decision.allowed
    assert decision.needs_user


def test_plan_mode_rejects_os_isolated_sandbox_commands():
    decision = PermissionEngine(mode=Mode.PLAN).evaluate(
        "__execute", {"command": "python analyze.py"}
    )

    assert not decision.allowed
    assert not decision.needs_user
    assert "plan mode" in decision.reason


def test_unattended_auto_mode_is_not_supported():
    with pytest.raises(ValueError):
        PermissionEngine(mode="auto")


def test_unknown_tools_are_approval_gated():
    decision = PermissionEngine().evaluate("new_unclassified_tool", {})

    assert not decision.allowed
    assert decision.needs_user


def test_classify_refora_tools():
    expected = {
        "search_documents": RiskClass.READ,
        "get_paper_context": RiskClass.READ,
        "read_paper": RiskClass.READ,
        "list_workspace_context": RiskClass.READ,
        "read_workspace_item": RiskClass.READ,
        "find_related_papers": RiskClass.READ,
        "search_arxiv": RiskClass.NETWORK_READ,
        "get_arxiv_paper": RiskClass.NETWORK_READ,
        "get_related_academic_papers": RiskClass.NETWORK_READ,
        "explore_research_frontier": RiskClass.NETWORK_READ,
        "web_search": RiskClass.NETWORK_READ,
        "web_fetch": RiskClass.NETWORK_READ,
        "open_paper": RiskClass.READ,
        "write_todos": RiskClass.READ,
        "ls": RiskClass.READ,
        "read_file": RiskClass.READ,
        "glob": RiskClass.READ,
        "grep": RiskClass.READ,
        "task": RiskClass.READ,
        "write_file": RiskClass.WRITE_LOCAL,
        "edit_file": RiskClass.WRITE_LOCAL,
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


@pytest.mark.parametrize("tool_name", ["write_file", "edit_file"])
def test_interactive_mode_allows_sandbox_filesystem_writes(tool_name):
    decision = PermissionEngine(sandbox_root="/tmp/refora-sandbox").evaluate(
        tool_name,
        {"file_path": "/outputs/report.md"},
    )

    assert decision.allowed
    assert not decision.needs_user
