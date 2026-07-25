from __future__ import annotations

import pytest

from conftest import make_agent_memories_repo, make_workspaces_repo, open_migrated_db
from refora_server.services.agent_memory import (
    MAX_MEMORY_FILE_CHARS,
    ReadonlyMemoryBackend,
    ensure_memory_files,
    read_memories,
    update_memory,
)


def test_memory_files_are_scoped_and_revisions_are_retained():
    db = open_migrated_db()
    repos = {"agentMemories": make_agent_memories_repo(db)}
    workspace = make_workspaces_repo(db)["create"]("Research")

    ensure_memory_files(repos, None)
    ensure_memory_files(repos, workspace["id"])
    first = update_memory(repos, workspace["id"], "/research.md", "first")
    second = update_memory(repos, workspace["id"], "/research.md", "second")

    assert "/research.md" not in read_memories(repos, None)
    assert read_memories(repos, workspace["id"])["/research.md"] == "second"
    assert second["revision"] == 3
    assert [revision["content"] for revision in repos["agentMemories"]["listRevisions"](first["id"])] == ["second", "first", ""]


def test_memory_validation_rejects_invalid_scope_path_and_size():
    db = open_migrated_db()
    repos = {"agentMemories": make_agent_memories_repo(db)}

    with pytest.raises(ValueError, match="Unsupported"):
        update_memory(repos, None, "/research.md", "no")
    with pytest.raises(ValueError, match="too large"):
        update_memory(repos, None, "/brief.md", "x" * (MAX_MEMORY_FILE_CHARS + 1))


def test_readonly_memory_backend_line_numbers_and_rejects_writes():
    backend = ReadonlyMemoryBackend({"brief.md": "one\ntwo"})

    assert backend.read("/brief.md", offset=1)["content"] == "2: two"
    assert backend.write("/brief.md", "changed")["error"]
    assert backend.upload_files([("/new.md", b"x")])[0]["error"] == "permission_denied"
