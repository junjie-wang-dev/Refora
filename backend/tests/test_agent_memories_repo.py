import sqlite3

import pytest

from conftest import (
    make_agent_memories_repo,
    make_chat_repo,
    make_workspaces_repo,
    open_migrated_db,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def _make_workspace(db) -> str:
    ws = make_workspaces_repo(db)
    return ws["create"]("Research")["id"]


def _make_thread(db, workspaceId: str | None, providerId: str = "p1") -> str:
    chat = make_chat_repo(db)
    return chat["createThread"](workspaceId, providerId)["id"]


def _make_run(db, threadId: str, runId: str = "run-1") -> str:
    db.execute(
        "INSERT INTO agent_runs (id, threadId, providerId, modelId, status, startedAt) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [runId, threadId, "p1", "model-1", "running", 1],
    )
    return runId


def test_list_empty_workspace_scope_returns_empty(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    assert repo["list"]("workspace", wid) == []


def test_list_empty_global_scope_returns_empty(db):
    repo = make_agent_memories_repo(db)
    assert repo["list"]("global", "global") == []


def test_list_workspace_scope_returns_only_matching(db):
    ws = make_workspaces_repo(db)
    wid_a = ws["create"]("A")["id"]
    wid_b = ws["create"]("B")["id"]
    repo = make_agent_memories_repo(db)
    repo["upsert"]({"scope": "workspace", "scopeId": wid_a, "workspaceId": wid_a, "path": "a.md", "content": "A"})
    repo["upsert"]({"scope": "workspace", "scopeId": wid_b, "workspaceId": wid_b, "path": "b.md", "content": "B"})

    items_a = repo["list"]("workspace", wid_a)
    assert [m["path"] for m in items_a] == ["a.md"]
    assert items_a[0]["content"] == "A"


def test_list_orders_by_path(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    repo["upsert"]({"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "z.md", "content": "z"})
    repo["upsert"]({"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "a.md", "content": "a"})
    paths = [m["path"] for m in repo["list"]("workspace", wid)]
    assert paths == ["a.md", "z.md"]


def test_list_global_scope_separate_from_workspace(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    repo["upsert"]({"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "ws.md", "content": "ws"})
    repo["upsert"]({"scope": "global", "scopeId": "global", "workspaceId": None, "path": "g.md", "content": "g"})

    assert [m["path"] for m in repo["list"]("workspace", wid)] == ["ws.md"]
    assert [m["path"] for m in repo["list"]("global", "global")] == ["g.md"]


def test_get_existing(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    created = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v"}
    )
    got = repo["get"]("workspace", wid, "mem.md")
    assert got is not None
    assert got["id"] == created["id"]
    assert got["path"] == "mem.md"


def test_get_missing_returns_none(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    assert repo["get"]("workspace", wid, "nope.md") is None


def test_upsert_creates_new_memory_with_revision_one(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "first"}
    )
    assert mem["id"]
    assert mem["scope"] == "workspace"
    assert mem["scopeId"] == wid
    assert mem["workspaceId"] == wid
    assert mem["path"] == "mem.md"
    assert mem["content"] == "first"
    assert mem["revision"] == 1
    assert mem["sourceThreadId"] is None
    assert mem["sourceRunId"] is None
    assert mem["createdAt"] > 0
    assert mem["updatedAt"] == mem["createdAt"]

    revs = repo["listRevisions"](mem["id"])
    assert len(revs) == 1
    assert revs[0]["revision"] == 1
    assert revs[0]["content"] == "first"
    assert revs[0]["memoryId"] == mem["id"]


def test_upsert_update_increments_revision_and_inserts_revision_record(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v1"}
    )

    thread = _make_thread(db, wid)
    run = _make_run(db, thread)
    updated = repo["upsert"](
        {
            "scope": "workspace",
            "scopeId": wid,
            "workspaceId": wid,
            "path": "mem.md",
            "content": "v2",
            "sourceThreadId": thread,
            "sourceRunId": run,
        }
    )
    assert updated["revision"] == 2
    assert updated["content"] == "v2"
    assert updated["sourceThreadId"] == thread
    assert updated["sourceRunId"] == run
    assert updated["updatedAt"] >= updated["createdAt"]

    revs = repo["listRevisions"](updated["id"])
    assert [r["revision"] for r in revs] == [2, 1]
    assert revs[0]["content"] == "v2"
    assert revs[0]["sourceRunId"] == run
    assert revs[1]["content"] == "v1"


def test_upsert_multiple_updates_revision_counter(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v1"}
    )
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v2"}
    )
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v3"}
    )
    assert mem["revision"] == 3
    assert len(repo["listRevisions"](mem["id"])) == 3


def test_upsert_global_scope_inserts(db):
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "global", "scopeId": "global", "workspaceId": None, "path": "g.md", "content": "g"}
    )
    assert mem["scope"] == "global"
    assert mem["scopeId"] == "global"
    assert mem["workspaceId"] is None
    assert mem["revision"] == 1


def test_upsert_source_fields_default_null_on_create(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "x"}
    )
    assert mem["sourceThreadId"] is None
    assert mem["sourceRunId"] is None


def test_remove_deletes_memory(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "x"}
    )
    assert repo["remove"]("workspace", wid, "mem.md") == 1
    assert repo["get"]("workspace", wid, "mem.md") is None
    assert repo["list"]("workspace", wid) == []


def test_remove_missing_returns_zero(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    assert repo["remove"]("workspace", wid, "nope.md") == 0


def test_remove_cascades_revisions(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v1"}
    )
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v2"}
    )
    assert len(repo["listRevisions"](mem["id"])) == 2

    repo["remove"]("workspace", wid, "mem.md")

    assert (
        db.execute(
            "SELECT COUNT(*) FROM workspace_agent_memory_revisions WHERE memoryId = ?", [mem["id"]]
        ).fetchone()[0]
        == 0
    )


def test_list_revisions_orders_desc(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v1"}
    )
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v2"}
    )
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v3"}
    )
    revs = repo["listRevisions"](mem["id"])
    assert [r["revision"] for r in revs] == [3, 2, 1]


def test_list_revisions_missing_returns_empty(db):
    repo = make_agent_memories_repo(db)
    assert repo["listRevisions"]("nonexistent") == []


def test_scope_check_rejects_workspace_scope_with_null_workspaceId(db):
    repo = make_agent_memories_repo(db)
    with pytest.raises(sqlite3.IntegrityError):
        repo["upsert"](
            {"scope": "workspace", "scopeId": "global", "workspaceId": None, "path": "bad.md", "content": "x"}
        )


def test_scope_check_rejects_workspace_scopeId_mismatch(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    with pytest.raises(sqlite3.IntegrityError):
        repo["upsert"](
            {"scope": "workspace", "scopeId": "other", "workspaceId": wid, "path": "bad.md", "content": "x"}
        )


def test_scope_check_rejects_global_scope_with_workspaceId(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    with pytest.raises(sqlite3.IntegrityError):
        repo["upsert"](
            {"scope": "global", "scopeId": "global", "workspaceId": wid, "path": "bad.md", "content": "x"}
        )


def test_scope_check_rejects_global_scope_with_wrong_scopeId(db):
    repo = make_agent_memories_repo(db)
    with pytest.raises(sqlite3.IntegrityError):
        repo["upsert"](
            {"scope": "global", "scopeId": "other", "workspaceId": None, "path": "bad.md", "content": "x"}
        )


def test_unique_scope_scopeId_path(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "dup.md", "content": "a"}
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO workspace_agent_memories "
            "(id, scope, scopeId, workspaceId, path, content, revision, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)",
            ["x", "workspace", wid, wid, "dup.md", "b"],
        )


def test_workspace_delete_cascades_memories_and_revisions(db):
    ws = make_workspaces_repo(db)
    wid = ws["create"]("Research")["id"]
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v1"}
    )
    repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "v2"}
    )

    ws["delete"](wid)

    assert (
        db.execute(
            "SELECT COUNT(*) FROM workspace_agent_memories WHERE id = ?", [mem["id"]]
        ).fetchone()[0]
        == 0
    )
    assert (
        db.execute(
            "SELECT COUNT(*) FROM workspace_agent_memory_revisions WHERE memoryId = ?", [mem["id"]]
        ).fetchone()[0]
        == 0
    )


def test_workspace_delete_direct_db_cascade(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "x"}
    )
    db.execute("DELETE FROM workspaces WHERE id = ?", [wid])
    assert (
        db.execute(
            "SELECT COUNT(*) FROM workspace_agent_memories WHERE id = ?", [mem["id"]]
        ).fetchone()[0]
        == 0
    )


def test_source_thread_delete_sets_null(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    thread = _make_thread(db, wid)
    mem = repo["upsert"](
        {
            "scope": "workspace",
            "scopeId": wid,
            "workspaceId": wid,
            "path": "mem.md",
            "content": "v1",
            "sourceThreadId": thread,
        }
    )
    assert mem["sourceThreadId"] == thread
    db.execute("DELETE FROM chat_threads WHERE id = ?", [thread])
    refreshed = repo["get"]("workspace", wid, "mem.md")
    assert refreshed["sourceThreadId"] is None


def test_memory_field_contract_matches_ts(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "x"}
    )
    assert set(mem.keys()) == {
        "id",
        "scope",
        "scopeId",
        "workspaceId",
        "path",
        "content",
        "revision",
        "sourceThreadId",
        "sourceRunId",
        "createdAt",
        "updatedAt",
    }


def test_revision_field_contract_matches_ts(db):
    wid = _make_workspace(db)
    repo = make_agent_memories_repo(db)
    mem = repo["upsert"](
        {"scope": "workspace", "scopeId": wid, "workspaceId": wid, "path": "mem.md", "content": "x"}
    )
    rev = repo["listRevisions"](mem["id"])[0]
    assert set(rev.keys()) == {
        "id",
        "memoryId",
        "revision",
        "content",
        "sourceThreadId",
        "sourceRunId",
        "createdAt",
    }


def test_create_repositories_includes_agent_memories(db):
    from refora_server.repositories import create_repositories

    repos = create_repositories(db)
    assert "agentMemories" in repos
    assert callable(repos["agentMemories"]["list"])
    assert callable(repos["agentMemories"]["get"])
    assert callable(repos["agentMemories"]["upsert"])
    assert callable(repos["agentMemories"]["remove"])
    assert callable(repos["agentMemories"]["listRevisions"])