from __future__ import annotations

import pytest

from refora_server.agent.engine_schema import (
    INTERRUPT_STATUS_PENDING,
    INTERRUPT_STATUS_RESOLVED,
    RUN_STATUS_CANCELLED,
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_INTERRUPTED,
    RUN_STATUS_QUEUED,
    RUN_STATUS_RUNNING,
    RunTransitionError,
    TERMINAL_RUN_STATUSES,
    TOOL_EFFECT_STATUS_DONE,
    TOOL_EFFECT_STATUS_ERROR,
    TOOL_EFFECT_STATUS_RUNNING,
    is_allowed_run_transition,
    is_active_run,
    is_terminal_run,
    protocol_status,
    transition_run_status,
)


def test_protocol_status_maps_run_and_interrupted_and_idle():
    assert protocol_status(RUN_STATUS_RUNNING) == "running"
    assert protocol_status(RUN_STATUS_INTERRUPTED) == "waiting"
    assert protocol_status(RUN_STATUS_COMPLETED) == "idle"
    assert protocol_status(RUN_STATUS_QUEUED) == "idle"


def test_terminal_and_active_run_predicates():
    assert is_terminal_run(RUN_STATUS_COMPLETED)
    assert is_terminal_run(RUN_STATUS_FAILED)
    assert is_terminal_run(RUN_STATUS_CANCELLED)
    assert is_terminal_run(RUN_STATUS_INTERRUPTED)
    assert not is_terminal_run(RUN_STATUS_RUNNING)
    assert not is_terminal_run(RUN_STATUS_QUEUED)
    assert is_active_run(RUN_STATUS_RUNNING)
    assert is_active_run(RUN_STATUS_QUEUED)
    assert not is_active_run(RUN_STATUS_COMPLETED)


def test_allowed_run_transitions_from_queued():
    assert is_allowed_run_transition(RUN_STATUS_QUEUED, RUN_STATUS_RUNNING)
    assert is_allowed_run_transition(RUN_STATUS_QUEUED, RUN_STATUS_CANCELLED)
    assert is_allowed_run_transition(RUN_STATUS_QUEUED, RUN_STATUS_FAILED)
    assert not is_allowed_run_transition(RUN_STATUS_QUEUED, RUN_STATUS_COMPLETED)
    assert not is_allowed_run_transition(RUN_STATUS_QUEUED, RUN_STATUS_INTERRUPTED)


def test_allowed_run_transitions_from_running():
    for target in (
        RUN_STATUS_RUNNING,
        RUN_STATUS_COMPLETED,
        RUN_STATUS_FAILED,
        RUN_STATUS_CANCELLED,
        RUN_STATUS_INTERRUPTED,
    ):
        assert is_allowed_run_transition(RUN_STATUS_RUNNING, target), target
    assert not is_allowed_run_transition(RUN_STATUS_RUNNING, RUN_STATUS_QUEUED)


def test_allowed_run_transitions_from_interrupted_resume_path():
    assert is_allowed_run_transition(RUN_STATUS_INTERRUPTED, RUN_STATUS_RUNNING)
    assert is_allowed_run_transition(RUN_STATUS_INTERRUPTED, RUN_STATUS_CANCELLED)
    assert is_allowed_run_transition(RUN_STATUS_INTERRUPTED, RUN_STATUS_FAILED)


def test_terminal_to_self_allowed():
    assert is_allowed_run_transition(RUN_STATUS_COMPLETED, RUN_STATUS_COMPLETED)
    assert is_allowed_run_transition(RUN_STATUS_FAILED, RUN_STATUS_FAILED)


def test_transition_run_status_returns_target_on_success():
    assert transition_run_status(RUN_STATUS_QUEUED, RUN_STATUS_RUNNING) == RUN_STATUS_RUNNING


def test_transition_run_status_raises_on_invalid():
    with pytest.raises(RunTransitionError) as exc:
        transition_run_status(RUN_STATUS_QUEUED, RUN_STATUS_COMPLETED)
    assert exc.value.current == RUN_STATUS_QUEUED
    assert exc.value.target == RUN_STATUS_COMPLETED


def test_terminal_set_contains_lifecycle_states():
    assert TERMINAL_RUN_STATUSES == {
        RUN_STATUS_INTERRUPTED,
        RUN_STATUS_COMPLETED,
        RUN_STATUS_FAILED,
        RUN_STATUS_CANCELLED,
    }


def test_tool_effect_and_interrupt_constants_stable():
    assert TOOL_EFFECT_STATUS_RUNNING == "running"
    assert TOOL_EFFECT_STATUS_DONE == "done"
    assert TOOL_EFFECT_STATUS_ERROR == "error"
    assert INTERRUPT_STATUS_PENDING == "pending"
    assert INTERRUPT_STATUS_RESOLVED == "resolved"