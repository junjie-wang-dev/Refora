import pytest

from conftest import (
    make_agent_runs_repo,
    make_agent_traces_repo,
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


def _step_input(thread, **overrides):
    base = {
        "threadId": thread["id"],
        "runId": "run-1",
        "kind": "tool",
        "status": "running",
        "startedAt": 1000,
        "seq": 0,
    }
    base.update(overrides)
    return base


def test_add_step_with_defaults(thread, db):
    repo = make_agent_traces_repo(db)
    step = repo["addStep"](_step_input(thread))
    assert step["threadId"] == thread["id"]
    assert step["runId"] == "run-1"
    assert step["kind"] == "tool"
    assert step["name"] is None
    assert step["input"] is None
    assert step["output"] is None
    assert step["status"] == "running"
    assert step["startedAt"] == 1000
    assert step["endedAt"] is None
    assert step["seq"] == 0
    assert step["inputTokens"] is None
    assert step["outputTokens"] is None
    assert step["totalTokens"] is None
    assert step["parentStepId"] is None
    assert step["agentName"] is None
    assert step["namespace"] is None
    assert step["depth"] == 0
    assert step["checkpointId"] is None


def test_add_step_generates_id_when_omitted(thread, db):
    repo = make_agent_traces_repo(db)
    step = repo["addStep"](_step_input(thread))
    assert step["id"]
    row = db.execute(
        "SELECT id FROM agent_trace_steps WHERE id = ?", [step["id"]]
    ).fetchone()
    assert row is not None


def test_add_step_with_all_optional_fields(thread, db):
    repo = make_agent_traces_repo(db)
    step = repo["addStep"](
        _step_input(
            thread,
            name="search",
            input="q",
            output="r",
            endedAt=2000,
            inputTokens=10,
            outputTokens=20,
            totalTokens=30,
            parentStepId="step-0",
            agentName="deep",
            namespace="ns",
            depth=2,
            checkpointId="ckpt-1",
        )
    )
    assert step["name"] == "search"
    assert step["input"] == "q"
    assert step["output"] == "r"
    assert step["endedAt"] == 2000
    assert step["inputTokens"] == 10
    assert step["outputTokens"] == 20
    assert step["totalTokens"] == 30
    assert step["parentStepId"] == "step-0"
    assert step["agentName"] == "deep"
    assert step["namespace"] == "ns"
    assert step["depth"] == 2
    assert step["checkpointId"] == "ckpt-1"


def test_add_step_depth_defaults_to_zero_when_none(thread, db):
    repo = make_agent_traces_repo(db)
    step = repo["addStep"](_step_input(thread, depth=None))
    assert step["depth"] == 0


def test_field_contract_matches_agent_trace_step_type(thread, db):
    repo = make_agent_traces_repo(db)
    step = repo["addStep"](_step_input(thread))
    assert set(step.keys()) == {
        "id",
        "threadId",
        "runId",
        "kind",
        "name",
        "input",
        "output",
        "status",
        "startedAt",
        "endedAt",
        "seq",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "parentStepId",
        "agentName",
        "namespace",
        "depth",
        "checkpointId",
    }


def test_update_step_missing_returns_none(db):
    repo = make_agent_traces_repo(db)
    assert repo["updateStep"]("nonexistent", {"status": "done"}) is None


def test_update_step_partial_fields(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="s1"))
    updated = repo["updateStep"](
        "s1", {"output": "result", "status": "done", "endedAt": 5000}
    )
    assert updated["output"] == "result"
    assert updated["status"] == "done"
    assert updated["endedAt"] == 5000
    assert updated["input"] is None
    assert updated["startedAt"] == 1000


def test_update_step_preserves_unset_fields(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](
        _step_input(
            thread,
            id="s1",
            input="orig-input",
            output="orig-output",
            status="running",
            endedAt=111,
        )
    )
    updated = repo["updateStep"]("s1", {"status": "done"})
    assert updated["input"] == "orig-input"
    assert updated["output"] == "orig-output"
    assert updated["status"] == "done"
    assert updated["endedAt"] == 111


def test_update_step_unset_keeps_existing_ignores_none_status(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="s1", status="running"))
    updated = repo["updateStep"]("s1", {"status": None})
    assert updated["status"] == "running"


def test_update_step_explicit_none_clears_nullable_field(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](
        _step_input(thread, id="s1", output="has-output", endedAt=999)
    )
    updated = repo["updateStep"](
        "s1", {"output": None, "endedAt": None, "input": None}
    )
    assert updated["output"] is None
    assert updated["endedAt"] is None
    assert updated["input"] is None


def test_update_step_explicit_none_clears_input(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="s1", input="orig"))
    updated = repo["updateStep"]("s1", {"input": None})
    assert updated["input"] is None


def test_update_step_token_fields(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="s1"))
    updated = repo["updateStep"](
        "s1",
        {"inputTokens": 5, "outputTokens": 7, "totalTokens": 12},
    )
    assert updated["inputTokens"] == 5
    assert updated["outputTokens"] == 7
    assert updated["totalTokens"] == 12


def test_update_step_token_fields_omitted_preserve_existing(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](
        _step_input(
            thread,
            id="s1",
            inputTokens=5,
            outputTokens=7,
            totalTokens=12,
        )
    )
    updated = repo["updateStep"]("s1", {"status": "done"})
    assert updated["inputTokens"] == 5
    assert updated["outputTokens"] == 7
    assert updated["totalTokens"] == 12


def test_update_step_token_fields_explicit_none(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](
        _step_input(
            thread,
            id="s1",
            inputTokens=5,
            outputTokens=7,
            totalTokens=12,
        )
    )
    updated = repo["updateStep"](
        "s1",
        {"inputTokens": None, "outputTokens": None, "totalTokens": None},
    )
    assert updated["inputTokens"] is None
    assert updated["outputTokens"] is None
    assert updated["totalTokens"] is None


def test_list_by_thread_orders_by_started_at_then_seq(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", startedAt=100, seq=0))
    repo["addStep"](_step_input(thread, id="b", startedAt=50, seq=0))
    repo["addStep"](_step_input(thread, id="c", startedAt=100, seq=1))
    ids = [s["id"] for s in repo["listByThread"](thread["id"])]
    assert ids == ["b", "a", "c"]


def test_list_by_thread_empty(thread, db):
    repo = make_agent_traces_repo(db)
    assert repo["listByThread"](thread["id"]) == []


def test_list_by_thread_isolates_by_thread(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    t1 = chat["createThread"](w["id"], "p1")
    t2 = chat["createThread"](w["id"], "p1")
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(t1, id="a"))
    repo["addStep"](_step_input(t2, id="b"))
    assert [s["id"] for s in repo["listByThread"](t1["id"])] == ["a"]
    assert [s["id"] for s in repo["listByThread"](t2["id"])] == ["b"]


def test_list_by_run_orders_by_seq(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", runId="r1", seq=2))
    repo["addStep"](_step_input(thread, id="b", runId="r1", seq=0))
    repo["addStep"](_step_input(thread, id="c", runId="r1", seq=1))
    repo["addStep"](_step_input(thread, id="d", runId="r2", seq=0))
    ids = [s["id"] for s in repo["listByRun"]("r1")]
    assert ids == ["b", "c", "a"]
    assert [s["id"] for s in repo["listByRun"]("r2")] == ["d"]


def test_list_by_run_empty(thread, db):
    repo = make_agent_traces_repo(db)
    assert repo["listByRun"]("nonexistent") == []


def test_delete_by_thread(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a"))
    repo["addStep"](_step_input(thread, id="b"))
    count = repo["deleteByThread"](thread["id"])
    assert count == 2
    assert repo["listByThread"](thread["id"]) == []


def test_delete_by_thread_isolates_by_thread(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    t1 = chat["createThread"](w["id"], "p1")
    t2 = chat["createThread"](w["id"], "p1")
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(t1, id="a"))
    repo["addStep"](_step_input(t2, id="b"))
    assert repo["deleteByThread"](t1["id"]) == 1
    assert repo["listByThread"](t2["id"]) != []


def test_delete_by_run(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", runId="r1"))
    repo["addStep"](_step_input(thread, id="b", runId="r1"))
    repo["addStep"](_step_input(thread, id="c", runId="r2"))
    count = repo["deleteByRun"](thread["id"], "r1")
    assert count == 2
    remaining = repo["listByThread"](thread["id"])
    assert [s["id"] for s in remaining] == ["c"]


def test_delete_by_run_isolates_by_thread_and_run(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", runId="r1"))
    repo["addStep"](_step_input(thread, id="b", runId="r1"))
    assert repo["deleteByRun"](thread["id"], "r2") == 0
    assert len(repo["listByThread"](thread["id"])) == 2


def test_delete_older_than(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", startedAt=100))
    repo["addStep"](_step_input(thread, id="b", startedAt=200))
    repo["addStep"](_step_input(thread, id="c", startedAt=300))
    count = repo["deleteOlderThan"](200)
    assert count == 1
    ids = [s["id"] for s in repo["listByThread"](thread["id"])]
    assert ids == ["b", "c"]


def test_delete_older_than_boundary_excludes_equal(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a", startedAt=200))
    assert repo["deleteOlderThan"](200) == 0
    assert repo["deleteOlderThan"](201) == 1


def test_reconcile_running_cancels_running(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="r1", status="running"))
    repo["addStep"](_step_input(thread, id="r2", status="running"))
    repo["addStep"](_step_input(thread, id="d1", status="done"))
    count = repo["reconcileRunning"]("shutdown", endedAt=9999)
    assert count == 2
    rows = {s["id"]: s for s in repo["listByThread"](thread["id"])}
    assert rows["r1"]["status"] == "cancelled"
    assert rows["r1"]["endedAt"] == 9999
    assert rows["r2"]["status"] == "cancelled"
    assert rows["d1"]["status"] == "done"


def test_reconcile_running_preserves_existing_output(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](
        _step_input(thread, id="r1", status="running", output="partial")
    )
    repo["addStep"](
        _step_input(thread, id="r2", status="running", output=None)
    )
    repo["reconcileRunning"]("fallback", endedAt=8888)
    rows = {s["id"]: s for s in repo["listByThread"](thread["id"])}
    assert rows["r1"]["output"] == "partial"
    assert rows["r2"]["output"] == "fallback"


def test_reconcile_running_no_matches_returns_zero(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="d1", status="done"))
    assert repo["reconcileRunning"]("x", endedAt=1) == 0


def test_reconcile_running_defaults_ended_at(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="r1", status="running"))
    repo["reconcileRunning"]("shutdown")
    step = repo["listByThread"](thread["id"])[0]
    assert step["status"] == "cancelled"
    assert step["endedAt"] is not None
    assert step["endedAt"] > 0


def test_delete_thread_cascades_agent_traces(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="a"))
    repo["addStep"](_step_input(thread, id="b"))

    chat["deleteThread"](thread["id"])

    assert repo["listByThread"](thread["id"]) == []
    assert (
        db.execute(
            "SELECT COUNT(*) AS c FROM agent_trace_steps WHERE threadId = ?",
            [thread["id"]],
        ).fetchone()["c"]
        == 0
    )


def test_update_step_returns_complete_step(thread, db):
    repo = make_agent_traces_repo(db)
    repo["addStep"](_step_input(thread, id="s1"))
    updated = repo["updateStep"]("s1", {"status": "done"})
    assert set(updated.keys()) == {
        "id",
        "threadId",
        "runId",
        "kind",
        "name",
        "input",
        "output",
        "status",
        "startedAt",
        "endedAt",
        "seq",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "parentStepId",
        "agentName",
        "namespace",
        "depth",
        "checkpointId",
    }
