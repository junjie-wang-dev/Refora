import time
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from conftest import make_agent_tool_effects_repo, make_workspaces_repo, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories


def _now_ms() -> int:
    return int(time.time() * 1000)


def _insert_thread(db, *, id="thread-1", providerId="provider-1"):
    db.execute(
        "INSERT INTO chat_threads (id, workspaceId, providerId, createdAt) "
        "VALUES (?, NULL, ?, ?)",
        [id, providerId, _now_ms()],
    )
    return id


def _insert_run(db, *, id="run-1", threadId="thread-1", status="running"):
    db.execute(
        "INSERT INTO agent_runs "
        "(id, threadId, providerId, modelId, status, startedAt) "
        "VALUES (?, ?, 'provider-1', 'model-1', ?, ?)",
        [id, threadId, status, _now_ms()],
    )
    return id


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def test_get_returns_none_when_missing(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    assert repo["get"]("run-1", "call-1") is None


def test_begin_creates_running_effect(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    effect = repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    assert effect["runId"] == "run-1"
    assert effect["toolCallId"] == "call-1"
    assert effect["toolName"] == "read_file"
    assert effect["workspaceId"] is None
    assert effect["status"] == "running"
    assert effect["result"] is None
    assert effect["createdAt"] > 0
    assert effect["updatedAt"] >= effect["createdAt"]


def test_begin_is_idempotent_returns_existing(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    first = repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    second = repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    assert first is not None
    assert second is None
    assert repo["get"]("run-1", "call-1")["toolCallId"] == "call-1"
    rows = db.execute(
        "SELECT COUNT(*) FROM agent_tool_effects WHERE runId = ? AND toolCallId = ?",
        ["run-1", "call-1"],
    ).fetchone()
    assert rows[0] == 1


def test_begin_idempotent_after_finish_does_not_reset(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    repo["finish"]("run-1", "call-1", "done", '{"ok": true}')
    again = repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    assert again is None
    persisted = repo["get"]("run-1", "call-1")
    assert persisted["status"] == "done"
    assert persisted["result"] == '{"ok": true}'


def test_begin_atomically_claims_once_across_threads():
    db = sqlite3.connect(
        ":memory:", isolation_level=None, check_same_thread=False
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    run_migrations(_SqliteAdapter(db))
    _insert_thread(db)
    _insert_run(db)
    repo = create_repositories(db)["agentToolEffects"]
    barrier = threading.Barrier(2)

    def claim():
        barrier.wait()
        return repo["begin"](
            {
                "runId": "run-1",
                "toolCallId": "call-1",
                "toolName": "add_docs_to_workspace",
                "workspaceId": None,
            }
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: claim(), range(2)))
        assert sum(result is not None for result in results) == 1
        assert repo["get"]("run-1", "call-1")["status"] == "running"
    finally:
        db.close()


def test_finish_done(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    finished = repo["finish"]("run-1", "call-1", "done", '{"path": "/a"}')
    assert finished is not None
    assert finished["status"] == "done"
    assert finished["result"] == '{"path": "/a"}'
    assert finished["updatedAt"] >= finished["createdAt"]


def test_finish_error(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    finished = repo["finish"]("run-1", "call-1", "error", "boom")
    assert finished is not None
    assert finished["status"] == "error"
    assert finished["result"] == "boom"


def test_finish_returns_none_when_missing(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    assert repo["finish"]("run-1", "missing-call", "done", "{}") is None


def test_begin_with_workspace_id_persists(db):
    ws = make_workspaces_repo(db)
    workspace = ws["create"]("Research")
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    effect = repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": workspace["id"],
        }
    )
    assert effect["workspaceId"] == workspace["id"]


def test_run_cascade_deletes_effects(db):
    _insert_thread(db)
    _insert_run(db)
    repo = make_agent_tool_effects_repo(db)
    repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "read_file",
            "workspaceId": None,
        }
    )
    repo["begin"](
        {
            "runId": "run-1",
            "toolCallId": "call-2",
            "toolName": "write_file",
            "workspaceId": None,
        }
    )
    assert repo["get"]("run-1", "call-1") is not None
    assert repo["get"]("run-1", "call-2") is not None
    db.execute("DELETE FROM agent_runs WHERE id = ?", ["run-1"])
    assert repo["get"]("run-1", "call-1") is None
    assert repo["get"]("run-1", "call-2") is None
