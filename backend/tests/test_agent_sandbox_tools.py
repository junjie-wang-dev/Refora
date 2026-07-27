from __future__ import annotations

import json

from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor


def test_execute_tool_forwards_run_id_for_process_cancellation():
    calls = []

    def execute_sandbox(command, args):
        calls.append((command, args))
        return {"status": "ok", "stdout": "done"}

    executor = AgentToolExecutor(
        AgentToolContext(run_id="run-1", thread_id="thread-1"),
        {"execute_sandbox": execute_sandbox},
    )
    result = json.loads(
        executor.execute(
            "__execute",
            {"command": "printf done", "cwd": "work", "timeoutSeconds": 30},
        )
    )
    assert result == {"status": "ok", "stdout": "done"}
    assert calls == [
        (
            "printf done",
            {
                "command": "printf done",
                "cwd": "work",
                "timeoutSeconds": 30,
                "_runId": "run-1",
            },
        )
    ]


def test_execute_tool_fails_closed_without_an_os_sandbox_dependency():
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run-1", thread_id="thread-1"),
        {},
    )
    result = json.loads(executor.execute("__execute", {"command": "printf unsafe"}))
    assert result == {
        "error": {
            "code": "sandbox_unavailable",
            "message": "OS-level sandbox execution is unavailable.",
        }
    }


def test_publish_tool_accepts_filesystem_virtual_output_paths():
    calls = []

    def publish_artifacts(workspace_id, paths, placement):
        calls.append((workspace_id, paths, placement))
        return {"published": [{"path": path} for path in paths], "errors": []}

    executor = AgentToolExecutor(
        AgentToolContext(
            run_id="run-1",
            thread_id="thread-1",
            workspace_id="workspace-1",
        ),
        {"publish_artifacts": publish_artifacts},
    )
    result = json.loads(
        executor.execute(
            "publish_workspace_artifacts",
            {
                "paths": ["/outputs/report.md", "outputs/chart.png"],
                "x": 40,
                "y": 80,
            },
        )
    )

    assert result["errors"] == []
    assert calls == [
        (
            "workspace-1",
            ["outputs/report.md", "outputs/chart.png"],
            {"x": 40, "y": 80},
        )
    ]


def test_install_tool_forwards_run_id_and_requires_exact_versions_in_schema():
    calls = []

    def install_runtime_packages(workspace_id, args):
        calls.append((workspace_id, args))
        return {"status": "ok"}

    executor = AgentToolExecutor(
        AgentToolContext(
            run_id="run-1",
            thread_id="thread-1",
            workspace_id="workspace-1",
        ),
        {"install_runtime_packages": install_runtime_packages},
    )
    result = json.loads(
        executor.execute(
            "install_runtime_packages",
            {"python": [{"name": "requests", "version": "2.32.3"}]},
        )
    )
    assert result == {"status": "ok"}
    assert calls == [
        (
            "workspace-1",
            {
                "python": [{"name": "requests", "version": "2.32.3"}],
                "_runId": "run-1",
            },
        )
    ]
