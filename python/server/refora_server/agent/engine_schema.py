from __future__ import annotations

from typing import Final


RUN_STATUS_QUEUED: Final[str] = "queued"
RUN_STATUS_RUNNING: Final[str] = "running"
RUN_STATUS_INTERRUPTED: Final[str] = "interrupted"
RUN_STATUS_COMPLETED: Final[str] = "completed"
RUN_STATUS_FAILED: Final[str] = "failed"
RUN_STATUS_CANCELLED: Final[str] = "cancelled"

RUN_STATUSES: Final[frozenset[str]] = frozenset(
    {
        RUN_STATUS_QUEUED,
        RUN_STATUS_RUNNING,
        RUN_STATUS_INTERRUPTED,
        RUN_STATUS_COMPLETED,
        RUN_STATUS_FAILED,
        RUN_STATUS_CANCELLED,
    }
)
TERMINAL_RUN_STATUSES: Final[frozenset[str]] = frozenset(
    {
        RUN_STATUS_INTERRUPTED,
        RUN_STATUS_COMPLETED,
        RUN_STATUS_FAILED,
        RUN_STATUS_CANCELLED,
    }
)
ACTIVE_RUN_STATUSES: Final[frozenset[str]] = frozenset({RUN_STATUS_QUEUED, RUN_STATUS_RUNNING})

TOOL_EFFECT_STATUS_RUNNING: Final[str] = "running"
TOOL_EFFECT_STATUS_DONE: Final[str] = "done"
TOOL_EFFECT_STATUS_ERROR: Final[str] = "error"

TOOL_EFFECT_STATUSES: Final[frozenset[str]] = frozenset(
    {
        TOOL_EFFECT_STATUS_RUNNING,
        TOOL_EFFECT_STATUS_DONE,
        TOOL_EFFECT_STATUS_ERROR,
    }
)
TERMINAL_TOOL_EFFECT_STATUSES: Final[frozenset[str]] = frozenset(
    {TOOL_EFFECT_STATUS_DONE, TOOL_EFFECT_STATUS_ERROR}
)

TRACE_STATUS_RUNNING: Final[str] = "running"
TRACE_STATUS_DONE: Final[str] = "done"
TRACE_STATUS_ERROR: Final[str] = "error"
TRACE_STATUS_INTERRUPTED: Final[str] = "interrupted"
TRACE_STATUS_CANCELLED: Final[str] = "cancelled"

TRACE_STATUSES: Final[frozenset[str]] = frozenset(
    {
        TRACE_STATUS_RUNNING,
        TRACE_STATUS_DONE,
        TRACE_STATUS_ERROR,
        TRACE_STATUS_INTERRUPTED,
        TRACE_STATUS_CANCELLED,
    }
)
TERMINAL_TRACE_STATUSES: Final[frozenset[str]] = frozenset(
    {
        TRACE_STATUS_DONE,
        TRACE_STATUS_ERROR,
        TRACE_STATUS_INTERRUPTED,
        TRACE_STATUS_CANCELLED,
    }
)

INTERRUPT_STATUS_PENDING: Final[str] = "pending"
INTERRUPT_STATUS_RESOLVED: Final[str] = "resolved"

INTERRUPT_STATUSES: Final[frozenset[str]] = frozenset(
    {INTERRUPT_STATUS_PENDING, INTERRUPT_STATUS_RESOLVED}
)


PROTOCOL_STATUS_RUNNING: Final[str] = "running"
PROTOCOL_STATUS_WAITING: Final[str] = "waiting"
PROTOCOL_STATUS_IDLE: Final[str] = "idle"


def protocol_status(run_status: str) -> str:
    if run_status == RUN_STATUS_RUNNING:
        return PROTOCOL_STATUS_RUNNING
    if run_status == RUN_STATUS_INTERRUPTED:
        return PROTOCOL_STATUS_WAITING
    return PROTOCOL_STATUS_IDLE


def is_terminal_run(status: str) -> bool:
    return status in TERMINAL_RUN_STATUSES


def is_active_run(status: str) -> bool:
    return status in ACTIVE_RUN_STATUSES


_ALLOWED_RUN_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    RUN_STATUS_QUEUED: frozenset(
        {RUN_STATUS_RUNNING, RUN_STATUS_CANCELLED, RUN_STATUS_FAILED}
    ),
    RUN_STATUS_RUNNING: frozenset(
        {
            RUN_STATUS_RUNNING,
            RUN_STATUS_COMPLETED,
            RUN_STATUS_FAILED,
            RUN_STATUS_CANCELLED,
            RUN_STATUS_INTERRUPTED,
        }
    ),
    RUN_STATUS_INTERRUPTED: frozenset(
        {RUN_STATUS_RUNNING, RUN_STATUS_CANCELLED, RUN_STATUS_FAILED}
    ),
}


def is_allowed_run_transition(current: str, target: str) -> bool:
    if current == target and current in TERMINAL_RUN_STATUSES:
        return True
    allowed = _ALLOWED_RUN_TRANSITIONS.get(current)
    if allowed is None:
        return target == current
    return target in allowed


class RunTransitionError(ValueError):
    def __init__(self, current: str, target: str) -> None:
        super().__init__(f"Invalid agent run status transition: {current} -> {target}")
        self.current = current
        self.target = target


def transition_run_status(current: str, target: str) -> str:
    if not is_allowed_run_transition(current, target):
        raise RunTransitionError(current, target)
    return target