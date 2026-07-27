import time

import pytest

from conftest import make_agent_tool_effects_repo, make_workspaces_repo, open_migrated_db


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
    assert second == first
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
    assert again["status"] == "done"
    assert again["result"] == '{"ok": true}'


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
