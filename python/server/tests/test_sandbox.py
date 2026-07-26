from __future__ import annotations

import sys

import pytest

from refora_server.services.sandbox import (
    SandboxExecutor,
    SandboxOptions,
    execute,
)


def test_execute_normal_output_and_status():
    result = execute("print(sum(range(11)))", SandboxOptions(timeout_seconds=5, cpu_seconds=5))
    assert result["status"] == "ok"
    assert result["exitCode"] == 0
    assert result["stdout"].strip() == "55"
    assert result["timedOut"] is False
    assert result["truncated"] is False


def test_execute_captures_stderr():
    result = execute(
        "import sys; sys.stderr.write('boom\\n'); print('ok')",
        SandboxOptions(timeout_seconds=5, cpu_seconds=5),
    )
    assert result["status"] == "ok"
    assert result["stdout"].strip() == "ok"
    assert "boom" in result["stderr"]


def test_execute_returns_nonzero_on_runtime_error():
    result = execute("raise ValueError('nope')", SandboxOptions(timeout_seconds=5, cpu_seconds=5))
    assert result["status"] == "error"
    assert result["exitCode"] != 0
    assert "ValueError" in result["stderr"]
    assert "nope" in result["stderr"]


def test_execute_timeout_terminates_sleeping_process():
    result = execute(
        "import time; time.sleep(30)",
        SandboxOptions(timeout_seconds=1, cpu_seconds=5),
    )
    assert result["status"] == "timeout"
    assert result["timedOut"] is True
    assert result["exitCode"] != 0


def test_execute_cpu_limit_terminates_busy_loop():
    result = execute(
        "while True:\n    pass",
        SandboxOptions(timeout_seconds=10, cpu_seconds=1),
    )
    assert result["status"] == "resource_limit"
    assert result["timedOut"] is False


def test_execute_file_size_limit_blocks_large_write(tmp_path):
    target = tmp_path / "big.bin"
    code = f"open({str(target)!r}, 'wb').write(b'x' * (50 * 1024 * 1024))"
    result = execute(code, SandboxOptions(timeout_seconds=10, cpu_seconds=5, file_size_mb=1))
    assert result["status"] == "error"
    assert result["exitCode"] != 0
    assert not target.exists() or target.stat().st_size < 50 * 1024 * 1024


def test_execute_truncates_oversized_output():
    result = execute(
        "print('A' * (1024 * 1024))",
        SandboxOptions(timeout_seconds=10, cpu_seconds=5, max_output_bytes=4096),
    )
    assert result["truncated"] is True
    assert len(result["stdout"].encode("utf-8", errors="replace")) <= 4096


def test_execute_rejects_oversized_code():
    with pytest.raises(ValueError):
        execute("x = 0\n" * 50_000, SandboxOptions(timeout_seconds=5, cpu_seconds=5))


def test_execute_rejects_nonpositive_timeout():
    with pytest.raises(ValueError):
        execute("print(1)", SandboxOptions(timeout_seconds=0, cpu_seconds=5))


def test_executor_class_reuses_defaults_and_overrides():
    executor = SandboxExecutor(SandboxOptions(timeout_seconds=5, cpu_seconds=5))
    default_result = executor.execute("print(2 + 2)")
    assert default_result["stdout"].strip() == "4"

    overridden = executor.execute_sandbox(
        "import time; time.sleep(20)",
        {"timeoutSeconds": 1},
    )
    assert overridden["status"] == "timeout"


def test_execute_sandbox_wrapper_returns_envelope_shape():
    executor = SandboxExecutor(SandboxOptions(timeout_seconds=5, cpu_seconds=5))
    result = executor.execute_sandbox("print('hi')", {})
    assert result["status"] == "ok"
    assert result["stdout"].strip() == "hi"
    for key in ("stdout", "stderr", "status", "exitCode", "timedOut", "truncated", "error"):
        assert key in result


def test_create_sandbox_service_factory():
    service = __import__(
        "refora_server.services.sandbox", fromlist=["createSandboxService"]
    ).createSandboxService(SandboxOptions(timeout_seconds=5, cpu_seconds=5))
    assert callable(service["execute"])
    assert callable(service["execute_sandbox"])
    result = service["execute_sandbox"]("print(1)", {})
    assert result["status"] == "ok"
    assert result["stdout"].strip() == "1"


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is honored on Linux only")
def test_execute_memory_limit_on_linux():
    result = execute(
        "x = [0] * (512 * 1024 * 1024)",
        SandboxOptions(timeout_seconds=10, cpu_seconds=5, memory_mb=64),
    )
    assert result["status"] == "resource_limit"
