from __future__ import annotations

from collections.abc import Callable
from enum import Enum
from typing import Any

from refora_server.agent.application_catalog import APPLICATION_ACTIONS, resolve_application_call


class RiskClass(str, Enum):
    READ = "read"
    NETWORK_READ = "network_read"
    WRITE_LOCAL = "write_local"
    EXEC = "exec"
    EXTERNAL = "external"
    DESTRUCTIVE = "destructive"


RiskOverrides = Callable[[str], RiskClass | None]


_BASE: dict[str, RiskClass] = {
    "list_workspaces": RiskClass.READ,
    "list_documents": RiskClass.READ,
    "list_categories": RiskClass.READ,
    "list_workspace_contents": RiskClass.READ,
    "create_workspace": RiskClass.WRITE_LOCAL,
    "rename_workspace": RiskClass.WRITE_LOCAL,
    "update_workspace_layout": RiskClass.WRITE_LOCAL,
    "reorder_workspace_items": RiskClass.WRITE_LOCAL,
    "add_workspace_items": RiskClass.WRITE_LOCAL,
    "set_workspace_canvas": RiskClass.WRITE_LOCAL,
    "update_workspace_connection": RiskClass.WRITE_LOCAL,
    "create_workspace_note": RiskClass.WRITE_LOCAL,
    "update_workspace_note": RiskClass.WRITE_LOCAL,
    "import_workspace_files": RiskClass.WRITE_LOCAL,
    "update_workspace_asset": RiskClass.WRITE_LOCAL,
    "create_category": RiskClass.WRITE_LOCAL,
    "rename_category": RiskClass.WRITE_LOCAL,
    "set_document_categories": RiskClass.WRITE_LOCAL,
    "set_documents_starred": RiskClass.WRITE_LOCAL,
    "update_document": RiskClass.WRITE_LOCAL,
    "import_pdfs": RiskClass.WRITE_LOCAL,
    "refresh_document_metadata": RiskClass.WRITE_LOCAL,
    "delete_workspace": RiskClass.DESTRUCTIVE,
    "remove_workspace_items": RiskClass.DESTRUCTIVE,
    "delete_workspace_connections": RiskClass.DESTRUCTIVE,
    "delete_workspace_note": RiskClass.DESTRUCTIVE,
    "delete_workspace_report": RiskClass.DESTRUCTIVE,
    "delete_workspace_asset": RiskClass.DESTRUCTIVE,
    "delete_category": RiskClass.DESTRUCTIVE,
    "delete_documents": RiskClass.DESTRUCTIVE,

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
    "update_report": RiskClass.WRITE_LOCAL,
    "add_docs_to_workspace": RiskClass.WRITE_LOCAL,
    "create_workspace_connections": RiskClass.WRITE_LOCAL,
    "prepare_paper_ocr": RiskClass.WRITE_LOCAL,
    "publish_workspace_artifacts": RiskClass.EXTERNAL,
    "install_runtime_packages": RiskClass.EXTERNAL,
    "propose_workspace_memory_update": RiskClass.EXTERNAL,
    "__execute": RiskClass.EXEC,
}


def classify(
    tool_name: str,
    metadata: Any = None,
    overrides: RiskOverrides | None = None,
    *,
    arguments: Any = None,
) -> RiskClass:
    if tool_name in APPLICATION_ACTIONS:
        try:
            operation, _ = resolve_application_call(tool_name, arguments)
        except ValueError:
            return RiskClass.EXTERNAL
        return RiskClass.READ if operation == '__application_help' else classify(operation, overrides=overrides)
    if overrides is not None:
        override = overrides(tool_name)
        if override is not None:
            return override
    risk = _BASE.get(tool_name)
    if risk is not None:
        return risk
    return RiskClass.EXTERNAL


def is_consequential(risk: RiskClass) -> bool:
    return risk is not RiskClass.READ
