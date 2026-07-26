from __future__ import annotations

import pytest

from conftest import (
    insert_run,
    insert_thread,
    make_agent_runs_repo,
    make_agent_traces_repo,
    make_chat_repo,
    open_migrated_db,
)
from refora_server.agent.engine import RunStateMachine
from refora_server.agent.engine_schema import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_INTERRUPTED,
    RUN_STATUS_QUEUED,
    RUN_STATUS_RUNNING,
    RunTransitionError,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def thread(db):
    return make_chat_repo(db)["createThread"](None, "provider-1")


@pytest.fixture
def machine(db):
    return RunStateMachine(
        make_agent_runs_repo(db),
        make_agent_traces_repo(db),
        clock=lambda: 42,
    )


def test_open_creates_running_run_trace(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_QUEUED)
    run = make_agent_runs_repo(db)["get"]("run-1")
    trace = machine.open(run, {"runId": "run-1", "checkpointBefore": "ckpt-1"})
    assert trace["kind"] == "run"
    assert trace["name"] == "agent"
    assert trace["status"] == "running"
    assert trace["seq"] == 0
    assert trace["startedAt"] == 42
    assert trace["checkpointId"] == "ckpt-1"


def test_transition_queued_to_running_persists_status(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_QUEUED)
    run, trace = machine.transition(
        "run-1",
        RUN_STATUS_QUEUED,
        RUN_STATUS_RUNNING,
        {"endedAt": None, "error": None},
    )
    assert run["status"] == RUN_STATUS_RUNNING
    assert run["endedAt"] is None
    assert trace is None


def test_transition_running_to_completed_records_terminal_trace(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_RUNNING)
    run_trace = machine.open(
        {"id": "run-1", "threadId": thread["id"]},
        {"runId": "run-1"},
    )
    run, trace = machine.transition(
        "run-1",
        RUN_STATUS_RUNNING,
        RUN_STATUS_COMPLETED,
        {"endedAt": 99},
        run_trace,
        trace_output="Answer",
    )
    assert run["status"] == RUN_STATUS_COMPLETED
    assert run["endedAt"] == 99
    assert trace is not None
    assert trace["status"] == "done"
    assert trace["output"] == "Answer"
    assert trace["endedAt"] == 42


def test_transition_running_to_interrupted_records_interrupted_trace(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_RUNNING)
    run_trace = machine.open(
        {"id": "run-1", "threadId": thread["id"]},
        {"runId": "run-1"},
    )
    run, trace = machine.transition(
        "run-1",
        RUN_STATUS_RUNNING,
        RUN_STATUS_INTERRUPTED,
        {"checkpointAfter": "ckpt-2", "endedAt": 99},
        run_trace,
        trace_output="Interrupted",
    )
    assert run["status"] == RUN_STATUS_INTERRUPTED
    assert run["checkpointAfter"] == "ckpt-2"
    assert trace["status"] == "interrupted"
    assert trace["output"] == "Interrupted"


def test_transition_running_to_failed_uses_error_as_trace_output(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_RUNNING)
    run_trace = machine.open(
        {"id": "run-1", "threadId": thread["id"]},
        {"runId": "run-1"},
    )
    run, trace = machine.transition(
        "run-1",
        RUN_STATUS_RUNNING,
        RUN_STATUS_FAILED,
        {"error": "boom", "endedAt": 5},
        run_trace,
    )
    assert run["status"] == RUN_STATUS_FAILED
    assert run["error"] == "boom"
    assert trace["status"] == "error"
    assert trace["output"] == "boom"


def test_transition_interrupted_to_running_resume(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_INTERRUPTED)
    run, trace = machine.transition(
        "run-1",
        RUN_STATUS_INTERRUPTED,
        RUN_STATUS_RUNNING,
        {"endedAt": None, "error": None},
    )
    assert run["status"] == RUN_STATUS_RUNNING
    assert trace is None


def test_transition_invalid_raises(db, thread, machine):
    insert_run(db, threadId=thread["id"], status=RUN_STATUS_QUEUED)
    with pytest.raises(RunTransitionError):
        machine.transition("run-1", RUN_STATUS_QUEUED, RUN_STATUS_COMPLETED)


def test_terminal_trace_status_lookup(db, thread, machine):
    assert machine.terminal_trace_status(RUN_STATUS_COMPLETED) == "done"
    assert machine.terminal_trace_status(RUN_STATUS_FAILED) == "error"
    assert machine.terminal_trace_status(RUN_STATUS_CANCELLED) == "cancelled"
    assert machine.terminal_trace_status(RUN_STATUS_INTERRUPTED) == "interrupted"
    assert machine.terminal_trace_status(RUN_STATUS_RUNNING) is None


def test_is_active_predicate(db, thread, machine):
    assert machine.is_active(RUN_STATUS_RUNNING)
    assert machine.is_active(RUN_STATUS_QUEUED)
    assert not machine.is_active(RUN_STATUS_COMPLETED)
    assert not machine.is_active(RUN_STATUS_INTERRUPTED)