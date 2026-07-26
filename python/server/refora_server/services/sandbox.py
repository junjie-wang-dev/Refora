from __future__ import annotations

import os
import resource
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 10
DEFAULT_CPU_SECONDS = 5
DEFAULT_MEMORY_MB = 512
DEFAULT_FILE_SIZE_MB = 16
DEFAULT_OUTPUT_BYTES = 256 * 1024
MAX_CODE_CHARS = 100_000

_TIMEOUT_EXIT_CODE = 124
_RESOURCE_EXIT_CODE = 137

_RESOURCE_LIMITS = (
    (resource.RLIMIT_CPU, "RLIMIT_CPU"),
    (resource.RLIMIT_FSIZE, "RLIMIT_FSIZE"),
)

_MEMORY_LIMITS = (
    (resource.RLIMIT_AS, "RLIMIT_AS"),
    (resource.RLIMIT_DATA, "RLIMIT_DATA"),
)

_CHILD_RUNNER = """
import resource as _resource
import sys as _sys

_memory_mb = int(_sys.argv[1])
_fsize_mb = int(_sys.argv[2])
_code = _sys.stdin.read()

_applied = []
try:
    for _rid, _name in ((getattr(_resource, "RLIMIT_AS", None), "RLIMIT_AS"),
                        (getattr(_resource, "RLIMIT_DATA", None), "RLIMIT_DATA")):
        if _rid is None:
            continue
        _cur = _resource.getrlimit(_rid)
        _limit = _memory_mb * 1024 * 1024
        if _cur[1] != -1 and _limit > _cur[1]:
            _limit = _cur[1]
        _resource.setrlimit(_rid, (_limit, _cur[1]))
        _applied.append(_name)
except (ValueError, OSError):
    pass

_fsize = _fsize_mb * 1024 * 1024
try:
    _resource.setrlimit(_resource.RLIMIT_FSIZE, (_fsize, _fsize))
except (ValueError, OSError):
    pass

_namespace = {"__name__": "__main__", "__builtins__": __builtins__}
try:
    exec(compile(_code, "<sandbox>", "exec"), _namespace)
except MemoryError:
    _sys.stderr.write("MemoryError: sandbox memory limit exceeded\\n")
    _sys.exit(__SANDBOX_MEM_EXIT__)
except SystemExit:
    raise
except BaseException:
    import traceback as _tb
    _sys.stderr.write(_tb.format_exc())
    _sys.exit(1)
"""


@dataclass(frozen=True)
class SandboxResult:
    stdout: str
    stderr: str
    status: str
    exit_code: int
    timed_out: bool = False
    truncated: bool = False
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "status": self.status,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "truncated": self.truncated,
            "error": self.error,
        }


@dataclass(frozen=True)
class SandboxOptions:
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    cpu_seconds: int = DEFAULT_CPU_SECONDS
    memory_mb: int = DEFAULT_MEMORY_MB
    file_size_mb: int = DEFAULT_FILE_SIZE_MB
    max_output_bytes: int = DEFAULT_OUTPUT_BYTES
    python_executable: str = sys.executable
    extra_env: dict[str, str] = field(default_factory=dict)


def _build_preexec(cpu_seconds: int, file_size_mb: int):
    def _preexec() -> None:
        for rid, _name in _RESOURCE_LIMITS:
            limit = (cpu_seconds if rid == resource.RLIMIT_CPU else file_size_mb * 1024 * 1024)
            try:
                current = resource.getrlimit(rid)
                if current[1] != -1 and limit > current[1]:
                    limit = current[1]
                resource.setrlimit(rid, (limit, current[1]))
            except (ValueError, OSError):
                continue

    return _preexec


def _truncate(text: str, max_bytes: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text, False
    return encoded[:max_bytes].decode("utf-8", errors="replace"), True


def _terminate(process: subprocess.Popen, pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        process.wait(timeout=1)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def _runner_script(memory_exit_code: int) -> str:
    return _CHILD_RUNNER.replace("__SANDBOX_MEM_EXIT__", str(memory_exit_code))


def execute(code: str, options: SandboxOptions | None = None) -> dict[str, Any]:
    if not isinstance(code, str):
        raise TypeError("Sandbox code must be a string")
    if len(code) > MAX_CODE_CHARS:
        raise ValueError("Sandbox code exceeds the maximum length")
    opts = options or SandboxOptions()
    if opts.timeout_seconds <= 0 or opts.cpu_seconds <= 0:
        raise ValueError("Sandbox timeouts must be positive")

    runner = _runner_script(_RESOURCE_EXIT_CODE)
    env = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"}
    }
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env.update(opts.extra_env)

    try:
        process = subprocess.Popen(
            [opts.python_executable, "-I", "-S", "-c", runner, str(opts.memory_mb), str(opts.file_size_mb)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            start_new_session=True,
            preexec_fn=_build_preexec(opts.cpu_seconds, opts.file_size_mb),
        )
    except OSError as error:
        return SandboxResult(
            stdout="",
            stderr=str(error),
            status="error",
            exit_code=-1,
            error="sandbox_spawn_failed",
        ).as_dict()

    pgid = process.pid
    timed_out = False
    try:
        stdout, stderr = process.communicate(input=code, timeout=opts.timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        _terminate(process, pgid)
        try:
            stdout, stderr = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            stdout, stderr = process.stdout.read() if process.stdout else "", process.stderr.read() if process.stderr else ""

    stdout, stdout_truncated = _truncate(stdout or "", opts.max_output_bytes)
    stderr, stderr_truncated = _truncate(stderr or "", opts.max_output_bytes)

    exit_code = process.returncode if process.returncode is not None else -1
    truncated = stdout_truncated or stderr_truncated

    if timed_out:
        status = "timeout"
    elif exit_code == _RESOURCE_EXIT_CODE or exit_code == -24:
        status = "resource_limit"
    elif exit_code == 0:
        status = "ok"
    else:
        status = "error"

    return SandboxResult(
        stdout=stdout,
        stderr=stderr,
        status=status,
        exit_code=exit_code,
        timed_out=timed_out,
        truncated=truncated,
    ).as_dict()


class SandboxExecutor:
    def __init__(self, options: SandboxOptions | None = None) -> None:
        self._options = options or SandboxOptions()

    def execute(self, code: str, options: SandboxOptions | None = None) -> dict[str, Any]:
        return execute(code, options or self._options)

    def execute_sandbox(self, command: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        arguments = args or {}
        overrides: dict[str, Any] = {}
        for key, attr in (
            ("timeoutSeconds", "timeout_seconds"),
            ("cpuSeconds", "cpu_seconds"),
            ("memoryMb", "memory_mb"),
            ("fileSizeMb", "file_size_mb"),
        ):
            value = arguments.get(key)
            if isinstance(value, (int, float)) and value > 0:
                overrides[attr] = int(value)
        merged = SandboxOptions(**{**self._options.__dict__, **overrides})
        return execute(command, merged)


def createSandboxService(options: SandboxOptions | None = None) -> dict[str, Any]:
    executor = SandboxExecutor(options)

    def execute_sandbox(command: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        return executor.execute_sandbox(command, args)

    return {"execute": executor.execute, "execute_sandbox": execute_sandbox}
