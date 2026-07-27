import pytest

from conftest import (
    insert_run,
    make_agent_interrupts_repo,
    make_chat_repo,
    open_migrated_db,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def _make_thread(db, *, workspaceId=None, providerId="provider-1"):
    chat = make_chat_repo(db)
    return chat["createThread"](workspaceId, providerId)


ACTIONS = [
    {
        "name": "search",
        "args": {"query": "transformers"},
        "description": "run a web search",
        "allowedDecisions": ["approve", "reject", "edit"],
    }
]


def test_create_round_trips_payload_json(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    assert created["id"]
    assert created["runId"] == "run-1"
    assert created["threadId"] == thread["id"]
    assert created["checkpointId"] is None
    assert created["actions"] == ACTIONS
    assert created["status"] == "pending"
    assert created["decision"] is None
    assert created["createdAt"] > 0
    assert created["resolvedAt"] is None

    raw = db.execute(
        "SELECT payload, status, decision FROM agent_interrupts WHERE id = ?",
        [created["id"]],
    ).fetchone()
    import json

    assert json.loads(raw["payload"]) == ACTIONS
    assert raw["status"] == "pending"
    assert raw["decision"] is None


def test_create_with_checkpoint(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {
            "runId": "run-1",
            "threadId": thread["id"],
            "checkpointId": "ckpt-1",
            "actions": ACTIONS,
        }
    )
    assert created["checkpointId"] == "ckpt-1"


def test_get_missing_returns_none(db):
    repo = make_agent_interrupts_repo(db)
    assert repo["get"]("nonexistent") is None


def test_get_returns_record(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    got = repo["get"](created["id"])
    assert got is not None
    assert got["id"] == created["id"]
    assert got == created


def test_get_pending_by_run_returns_latest(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    first = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    db.execute(
        "UPDATE agent_interrupts SET createdAt = ? WHERE id = ?",
        [first["createdAt"] - 1000, first["id"]],
    )
    second = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )

    pending = repo["getPendingByRun"]("run-1")
    assert pending is not None
    assert pending["id"] == second["id"]


def test_get_pending_by_run_ignores_resolved(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    repo["resolve"](created["id"], ["approve"])

    assert repo["getPendingByRun"]("run-1") is None


def test_get_pending_by_run_missing_returns_none(db):
    repo = make_agent_interrupts_repo(db)
    assert repo["getPendingByRun"]("run-9") is None


def test_resolve_sets_status_and_decision(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    decisions = ["approve", "reject"]
    resolved = repo["resolve"](created["id"], decisions)

    assert resolved is not None
    assert resolved["status"] == "resolved"
    assert resolved["decision"] == decisions
    assert resolved["resolvedAt"] is not None
    assert resolved["resolvedAt"] >= created["createdAt"]

    raw = db.execute(
        "SELECT status, decision FROM agent_interrupts WHERE id = ?",
        [created["id"]],
    ).fetchone()
    import json

    assert raw["status"] == "resolved"
    assert json.loads(raw["decision"]) == decisions


def test_resolve_only_affects_pending(db):
    thread = _make_thread(db)
    insert_run(db, threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )
    first = repo["resolve"](created["id"], ["approve"])
    assert first is not None
    assert first["status"] == "resolved"

    second = repo["resolve"](created["id"], ["reject"])
    assert second is not None
    assert second["status"] == "resolved"
    assert second["decision"] == ["approve"]


def test_resolve_missing_returns_none(db):
    repo = make_agent_interrupts_repo(db)
    assert repo["resolve"]("nonexistent", ["approve"]) is None


def test_cascade_delete_run(db):
    thread = _make_thread(db)
    insert_run(db, id="run-1", threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )

    db.execute("DELETE FROM agent_runs WHERE id = ?", ["run-1"])

    assert repo["get"](created["id"]) is None


def test_cascade_delete_thread(db):
    thread = _make_thread(db)
    insert_run(db, id="run-1", threadId=thread["id"])
    repo = make_agent_interrupts_repo(db)

    created = repo["create"](
        {"runId": "run-1", "threadId": thread["id"], "actions": ACTIONS}
    )

    db.execute("DELETE FROM chat_threads WHERE id = ?", [thread["id"]])

    assert repo["get"](created["id"]) is None