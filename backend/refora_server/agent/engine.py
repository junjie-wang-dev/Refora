from __future__ import annotations

from typing import Any, Callable, Protocol

from refora_server.agent.engine_schema import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_COMPLETED,
    RUN_STATUS_FAILED,
    RUN_STATUS_INTERRUPTED,
    RUN_STATUS_RUNNING,
    TRACE_STATUS_CANCELLED,
    TRACE_STATUS_DONE,
    TRACE_STATUS_ERROR,
    TRACE_STATUS_INTERRUPTED,
    TRACE_STATUS_RUNNING,
    is_allowed_run_transition,
    is_terminal_run,
)


class _RunWriter(Protocol):
    def update(self, run_id: str, patch: dict[str, Any]) -> dict[str, Any] | None: ...


class _TraceWriter(Protocol):
    def addStep(self, input: dict[str, Any]) -> dict[str, Any]: ...
    def updateStep(self, id: str, patch: dict[str, Any]) -> dict[str, Any] | None: ...


_RUN_TERMINAL_TRACE_STATUS: dict[str, str] = {
    RUN_STATUS_COMPLETED: TRACE_STATUS_DONE,
    RUN_STATUS_FAILED: TRACE_STATUS_ERROR,
    RUN_STATUS_CANCELLED: TRACE_STATUS_CANCELLED,
    RUN_STATUS_INTERRUPTED: TRACE_STATUS_INTERRUPTED,
}


class RunStateMachine:
    def __init__(
        self,
        runs: _RunWriter,
        traces: _TraceWriter,
        clock: Callable[[], int],
    ) -> None:
        self._runs = runs
        self._traces = traces
        self._clock = clock

    def open(self, run: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
        run_id = run["id"]
        thread_id = run["threadId"]
        return self._traces["addStep"](
            {
                "threadId": thread_id,
                "runId": run_id,
                "kind": "run",
                "name": "agent",
                "status": TRACE_STATUS_RUNNING,
                "startedAt": self._clock(),
                "seq": 0,
                "checkpointId": request.get("checkpointBefore"),
            }
        )

    def transition(
        self,
        run_id: str,
        current: str,
        target: str,
        patch: dict[str, Any] | None = None,
        run_trace: dict[str, Any] | None = None,
        trace_output: str | None = None,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if not is_allowed_run_transition(current, target):
            from refora_server.agent.engine_schema import RunTransitionError

            raise RunTransitionError(current, target)
        full_patch = {"status": target}
        if patch:
            full_patch.update(patch)
        run = self._runs["update"](run_id, full_patch)
        trace = None
        if run_trace is not None and target in _RUN_TERMINAL_TRACE_STATUS:
            output = trace_output
            if output is None and isinstance(patch, dict):
                output = patch.get("error")
            trace = self._traces["updateStep"](
                run_trace["id"],
                {
                    "status": _RUN_TERMINAL_TRACE_STATUS[target],
                    "endedAt": self._clock(),
                    "output": output,
                },
            )
        return run, trace

    def is_active(self, status: str) -> bool:
        return not is_terminal_run(status)

    def terminal_trace_status(self, run_status: str) -> str | None:
        return _RUN_TERMINAL_TRACE_STATUS.get(run_status)