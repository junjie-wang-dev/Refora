import pytest

from conftest import (
    insert_message,
    insert_thread,
    make_agent_runs_repo,
    make_chat_repo,
    make_workspaces_repo,
    open_migrated_db,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def thread(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    return make_chat_repo(db)["createThread"](w["id"], "provider-1")


def test_create_with_defaults(thread, db):
    repo = make_agent_runs_repo(db)
    run = repo["create"](
        {
            "id": "run-1",
            "threadId": thread["id"],
            "providerId": "provider-1",
            "modelId": "model-1",
        }
    )
    assert run["id"] == "run-1"
    assert run["threadId"] == thread["id"]
    assert run["providerId"] == "provider-1"
    assert run["modelId"] == "model-1"
    assert run["status"] == "queued"
    assert run["checkpointBefore"] is None
    assert run["checkpointAfter"] is None
    assert run["replacesRunId"] is None
    assert run["userMessageId"] is None
    assert run["assistantMessageId"] is None
    assert run["startedAt"] > 0
    assert run["endedAt"] is None
    assert run["error"] is None


def test_create_with_explicit_values(thread, db):
    repo = make_agent_runs_repo(db)
    user_msg = insert_message(db, threadId=thread["id"], id="msg-1", role="user")
    run = repo["create"](
        {
            "id": "run-1",
            "threadId": thread["id"],
            "providerId": "provider-1",
            "modelId": "model-1",
            "status": "running",
            "checkpointBefore": "ckpt-before",
            "replacesRunId": None,
            "userMessageId": user_msg,
            "startedAt": 500,
        }
    )
    assert run["status"] == "running"
    assert run["checkpointBefore"] == "ckpt-before"
    assert run["userMessageId"] == "msg-1"
    assert run["startedAt"] == 500


def test_create_generates_id_when_omitted(thread, db):
    repo = make_agent_runs_repo(db)
    run = repo["create"](
        {
            "threadId": thread["id"],
            "providerId": "provider-1",
            "modelId": "model-1",
        }
    )
    assert run["id"]
    assert repo["get"](run["id"]) == run


def test_get_missing_returns_none(db):
    repo = make_agent_runs_repo(db)
    assert repo["get"]("nonexistent") is None


def test_list_by_thread_orders_by_started_at(thread, db):
    repo = make_agent_runs_repo(db)
    r1 = repo["create"](
        {"threadId": thread["id"], "providerId": "p1", "modelId": "m1", "startedAt": 100}
    )
    r2 = repo["create"](
        {"threadId": thread["id"], "providerId": "p1", "modelId": "m1", "startedAt": 50}
    )
    r3 = repo["create"](
        {"threadId": thread["id"], "providerId": "p1", "modelId": "m1", "startedAt": 200}
    )
    ids = [r["id"] for r in repo["listByThread"](thread["id"])]
    assert ids == [r2["id"], r1["id"], r3["id"]]


def test_list_by_thread_empty(thread, db):
    repo = make_agent_runs_repo(db)
    assert repo["listByThread"](thread["id"]) == []


def test_list_by_thread_isolates_by_thread(thread, db):
    repo = make_agent_runs_repo(db)
    other = insert_thread(db, id="thread-2", providerId="p1")
    repo["create"](
        {"threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    repo["create"](
        {"threadId": other, "providerId": "p1", "modelId": "m1"}
    )
    assert len(repo["listByThread"](thread["id"])) == 1
    assert len(repo["listByThread"](other)) == 1


def test_update_partial_fields(thread, db):
    repo = make_agent_runs_repo(db)
    run = repo["create"](
        {"id": "run-1", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    updated = repo["update"](
        "run-1",
        {"status": "running", "checkpointAfter": "ckpt-after"},
    )
    assert updated["status"] == "running"
    assert updated["checkpointAfter"] == "ckpt-after"
    assert updated["checkpointBefore"] is None
    assert updated["endedAt"] is None


def test_update_completed_run(thread, db):
    repo = make_agent_runs_repo(db)
    repo["create"](
        {"id": "run-1", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    assistant_msg = insert_message(
        db, threadId=thread["id"], id="msg-2", role="assistant"
    )
    updated = repo["update"](
        "run-1",
        {
            "status": "completed",
            "assistantMessageId": assistant_msg,
            "endedAt": 9999,
        },
    )
    assert updated["status"] == "completed"
    assert updated["assistantMessageId"] == "msg-2"
    assert updated["endedAt"] == 9999


def test_update_failed_run_with_error(thread, db):
    repo = make_agent_runs_repo(db)
    repo["create"](
        {"id": "run-1", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    updated = repo["update"](
        "run-1",
        {"status": "failed", "error": "boom", "endedAt": 1234},
    )
    assert updated["status"] == "failed"
    assert updated["error"] == "boom"
    assert updated["endedAt"] == 1234


def test_update_preserves_unset_fields(thread, db):
    repo = make_agent_runs_repo(db)
    repo["create"](
        {
            "id": "run-1",
            "threadId": thread["id"],
            "providerId": "p1",
            "modelId": "m1",
            "status": "running",
            "checkpointBefore": "ckpt-b",
        }
    )
    updated = repo["update"]("run-1", {"checkpointAfter": "ckpt-a"})
    assert updated["status"] == "running"
    assert updated["checkpointBefore"] == "ckpt-b"
    assert updated["checkpointAfter"] == "ckpt-a"


def test_update_missing_returns_none(db):
    repo = make_agent_runs_repo(db)
    assert repo["update"]("nonexistent", {"status": "completed"}) is None


def test_reconcile_running_cancels_queued_and_running(thread, db):
    repo = make_agent_runs_repo(db)
    repo["create"](
        {"id": "r-q", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    repo["create"](
        {
            "id": "r-r",
            "threadId": thread["id"],
            "providerId": "p1",
            "modelId": "m1",
            "status": "running",
        }
    )
    repo["create"](
        {
            "id": "r-d",
            "threadId": thread["id"],
            "providerId": "p1",
            "modelId": "m1",
            "status": "completed",
        }
    )
    count = repo["reconcileRunning"]("app-shutdown", endedAt=8888)
    assert count == 2
    assert repo["get"]("r-q")["status"] == "cancelled"
    assert repo["get"]("r-q")["error"] == "app-shutdown"
    assert repo["get"]("r-q")["endedAt"] == 8888
    assert repo["get"]("r-r")["status"] == "cancelled"
    assert repo["get"]("r-d")["status"] == "completed"


def test_reconcile_running_no_matches_returns_zero(thread, db):
    repo = make_agent_runs_repo(db)
    repo["create"](
        {
            "id": "r-1",
            "threadId": thread["id"],
            "providerId": "p1",
            "modelId": "m1",
            "status": "completed",
        }
    )
    assert repo["reconcileRunning"]("err") == 0


def test_delete_thread_cascades_agent_runs(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    repo = make_agent_runs_repo(db)
    repo["create"](
        {"id": "r-1", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    repo["create"](
        {"id": "r-2", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )

    chat["deleteThread"](thread["id"])

    assert repo["get"]("r-1") is None
    assert repo["get"]("r-2") is None
    assert repo["listByThread"](thread["id"]) == []


def test_replaces_run_id_set_null_on_delete(thread, db):
    repo = make_agent_runs_repo(db)
    parent = repo["create"](
        {"id": "r-parent", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    child = repo["create"](
        {
            "id": "r-child",
            "threadId": thread["id"],
            "providerId": "p1",
            "modelId": "m1",
            "replacesRunId": parent["id"],
        }
    )
    assert child["replacesRunId"] == "r-parent"

    db.execute("DELETE FROM agent_runs WHERE id = ?", [parent["id"]])

    fetched = repo["get"]("r-child")
    assert fetched is not None
    assert fetched["replacesRunId"] is None


def test_field_contract_matches_agent_run_type(thread, db):
    repo = make_agent_runs_repo(db)
    run = repo["create"](
        {"id": "run-1", "threadId": thread["id"], "providerId": "p1", "modelId": "m1"}
    )
    assert set(run.keys()) == {
        "id",
        "threadId",
        "providerId",
        "modelId",
        "status",
        "checkpointBefore",
        "checkpointAfter",
        "replacesRunId",
        "userMessageId",
        "assistantMessageId",
        "startedAt",
        "endedAt",
        "error",
    }