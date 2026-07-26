from __future__ import annotations

from collections.abc import Callable
from enum import Enum
from typing import Any


class RiskClass(str, Enum):
    READ = "read"
    WRITE_LOCAL = "write_local"
    EXEC = "exec"
    EXTERNAL = "external"


RiskOverrides = Callable[[str], RiskClass | None]


_BASE: dict[str, RiskClass] = {
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
    "ls": RiskClass.READ,
    "read_file": RiskClass.READ,
    "glob": RiskClass.READ,
    "grep": RiskClass.READ,
    "task": RiskClass.READ,
    "write_file": RiskClass.WRITE_LOCAL,
    "edit_file": RiskClass.WRITE_LOCAL,
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


def classify(
    tool_name: str,
    metadata: Any = None,
    overrides: RiskOverrides | None = None,
) -> RiskClass:
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
