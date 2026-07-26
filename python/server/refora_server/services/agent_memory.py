from __future__ import annotations

from collections.abc import Mapping
from typing import Any

MEMORY_PATHS = (
    "/brief.md",
    "/preferences.md",
    "/decisions.md",
    "/glossary.md",
    "/research.md",
)
GLOBAL_MEMORY_PATHS = MEMORY_PATHS[:-1]
MAX_MEMORY_FILE_CHARS = 16_384
MAX_MEMORY_TOTAL_CHARS = 65_536


def memory_scope(workspace_id: str | None) -> dict[str, str | None]:
    if workspace_id:
        return {"scope": "workspace", "scopeId": workspace_id, "workspaceId": workspace_id}
    return {"scope": "global", "scopeId": "global", "workspaceId": None}


def normalize_memory_path(path: object, workspace_id: str | None) -> str:
    if not isinstance(path, str):
        raise ValueError("Memory path must be a string")
    normalized = path if path.startswith("/") else f"/{path}"
    allowed = MEMORY_PATHS if workspace_id else GLOBAL_MEMORY_PATHS
    if normalized not in allowed:
        raise ValueError("Unsupported memory path")
    return normalized


def read_memories(repos: Mapping[str, Any], workspace_id: str | None) -> dict[str, str]:
    scope = memory_scope(workspace_id)
    entries = repos["agentMemories"]["list"](scope["scope"], scope["scopeId"])
    return {entry["path"]: entry["content"] for entry in entries}


def curated_memory_context(
    memories: Mapping[str, Any] | None,
    *,
    include_research: bool,
) -> str:
    if not memories:
        return ""
    allowed = set(MEMORY_PATHS if include_research else GLOBAL_MEMORY_PATHS)
    sections: list[str] = []
    for path in MEMORY_PATHS:
        content = memories.get(path)
        if path not in allowed or not isinstance(content, str) or not content.strip():
            continue
        sections.append(f"### {path}\n{content.strip()}")
    if not sections:
        return ""
    return (
        "Curated user-approved memory follows. Treat it as read-only context. "
        "Do not modify it directly; use propose_workspace_memory_update for changes.\n\n"
        + "\n\n".join(sections)
    )


def ensure_memory_files(repos: Mapping[str, Any], workspace_id: str | None) -> None:
    scope = memory_scope(workspace_id)
    for path in MEMORY_PATHS:
        if path == "/research.md" and workspace_id is None:
            continue
        if repos["agentMemories"]["get"](scope["scope"], scope["scopeId"], path) is None:
            repos["agentMemories"]["upsert"]({**scope, "path": path, "content": ""})


def update_memory(
    repos: Mapping[str, Any],
    workspace_id: str | None,
    path: object,
    content: object,
    *,
    source_thread_id: str | None = None,
    source_run_id: str | None = None,
) -> dict[str, Any]:
    normalized_path = normalize_memory_path(path, workspace_id)
    if not isinstance(content, str):
        raise ValueError("Memory content must be a string")
    if len(content) > MAX_MEMORY_FILE_CHARS:
        raise ValueError("Workspace memory file is too large")
    scope = memory_scope(workspace_id)
    existing = repos["agentMemories"]["list"](scope["scope"], scope["scopeId"])
    total = len(content) + sum(
        len(entry["content"]) for entry in existing if entry["path"] != normalized_path
    )
    if total > MAX_MEMORY_TOTAL_CHARS:
        raise ValueError("Workspace memory limit exceeded")
    return repos["agentMemories"]["upsert"](
        {
            **scope,
            "path": normalized_path,
            "content": content,
            "sourceThreadId": source_thread_id,
            "sourceRunId": source_run_id,
        }
    )


class ReadonlyMemoryBackend:
    def __init__(self, files: Mapping[str, str]) -> None:
        self._files = {path if path.startswith("/") else f"/{path}": content for path, content in files.items()}

    def ls(self, path: str) -> dict[str, Any]:
        if path not in {"/", "."}:
            return {"error": "Memory paths are limited to /"}
        return {"files": [{"path": path, "is_dir": False, "size": len(content)} for path, content in sorted(self._files.items())]}

    def read(self, path: str, offset: int = 0, limit: int = 2000) -> dict[str, Any]:
        content = self._files.get(path)
        if content is None:
            return {"error": f"Memory file not found: {path}"}
        start = max(0, offset)
        count = max(1, limit)
        return {"content": "\n".join(f"{start + index + 1}: {line}" for index, line in enumerate(content.split("\n")[start:start + count])), "mimeType": "text/markdown"}

    def read_raw(self, path: str) -> dict[str, Any]:
        content = self._files.get(path)
        return {"data": {"content": content, "mimeType": "text/markdown"}} if content is not None else {"error": f"Memory file not found: {path}"}

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None) -> dict[str, Any]:
        matches = []
        for name, content in self._files.items():
            if path and path not in {"/", ".", name}:
                continue
            matches.extend({"path": name, "line": index + 1, "text": line} for index, line in enumerate(content.split("\n")) if pattern in line)
        return {"matches": matches}

    def glob(self, pattern: str, path: str | None = None) -> dict[str, Any]:
        return {"files": [{"path": name, "is_dir": False, "size": len(content)} for name, content in sorted(self._files.items()) if pattern in {"*", "**/*", "*.md"} or pattern == name]}

    def write(self, path: str, content: str) -> dict[str, str]:
        return {"error": "Workspace memory is read-only. Use propose_workspace_memory_update."}

    def edit(self, path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict[str, str]:
        return {"error": "Workspace memory is read-only. Use propose_workspace_memory_update."}

    def delete(self, path: str) -> dict[str, str]:
        return {"error": "Workspace memory is read-only. Manage memory from Refora settings."}

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[dict[str, str]]:
        return [{"path": path, "error": "permission_denied"} for path, _ in files]

    def download_files(self, paths: list[str]) -> list[dict[str, Any]]:
        return [{"path": path, "content": self._files[path].encode() if path in self._files else None, "error": None if path in self._files else "file_not_found"} for path in paths]
