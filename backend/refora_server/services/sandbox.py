from __future__ import annotations

import mimetypes
import os
import resource
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, BinaryIO, Callable

from refora_server.agent.db_snapshot import cleanup_snapshot, create_db_snapshot
from refora_server.agent.readonly_files import write_readonly_files_manifest
from refora_server.services.agent_runtime_manager import (
    DownloadFile,
    ManagedRuntimeManager,
    RuntimeManagerOptions,
    runtime_paths,
)

DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_CPU_SECONDS = 30
DEFAULT_MEMORY_MB = 512
DEFAULT_FILE_SIZE_MB = 16
DEFAULT_OUTPUT_BYTES = 256 * 1024
MAX_COMMAND_CHARS = 100_000
MAX_TIMEOUT_SECONDS = 300
MAX_CHANGED_FILES = 200
RUNTIME_INSTALL_TIMEOUT_SECONDS = 10 * 60

_RESOURCE_EXIT_CODE = 137
_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_MEMORY_POLL_SECONDS = 0.1
_BLOCKED_READ_PATHS = (
    "/Users",
    "/Volumes",
    "/private/tmp",
    "/private/var/folders",
    "/Network",
)


@dataclass(frozen=True)
class SandboxResult:
    stdout: str
    stderr: str
    status: str
    exit_code: int
    timed_out: bool = False
    cancelled: bool = False
    truncated: bool = False
    error: str | None = None
    duration_ms: int = 0
    signal_name: str | None = None
    changed_files: tuple[dict[str, Any], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "status": self.status,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "cancelled": self.cancelled,
            "truncated": self.truncated,
            "error": self.error,
            "durationMs": self.duration_ms,
            "signal": self.signal_name,
            "changedFiles": list(self.changed_files),
        }


@dataclass(frozen=True)
class SandboxOptions:
    sandbox_root: str | None = None
    shared_root: str | None = None
    cwd: str | None = None
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    cpu_seconds: int = DEFAULT_CPU_SECONDS
    memory_mb: int = DEFAULT_MEMORY_MB
    file_size_mb: int = DEFAULT_FILE_SIZE_MB
    max_output_bytes: int = DEFAULT_OUTPUT_BYTES
    shell_executable: str = "/bin/bash"
    sandbox_executable: str = _SANDBOX_EXEC
    python_executable: str | None = None
    node_executable: str | None = None
    uv_executable: str | None = None
    pnpm_executable: str | None = None
    architecture: str | None = None
    download_file: DownloadFile | None = None
    discover_runtime_path: bool = True
    read_only_paths: tuple[str, ...] = ()
    db_path: str | None = None
    documents_repo: Any = None
    workspace_assets_repo: Any = None
    extra_env: dict[str, str] = field(default_factory=dict)
    cancel_event: threading.Event | None = None


@dataclass(frozen=True)
class _FileSnapshot:
    mtime_ns: int
    size: int


def _sandbox_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")


def _allow_subpath(operation: str, path: str) -> str:
    return f'({operation} (subpath "{_sandbox_literal(path)}"))'


def _sandbox_profile(
    sandbox_root: Path,
    read_only_paths: tuple[str, ...],
    writable_paths: tuple[str, ...] = (),
    allow_network: bool = False,
) -> str:
    rules = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow sysctl-read)",
        "(allow file-read*)",
        " ".join(
            [
                "(deny file-read*",
                *[f'(subpath "{_sandbox_literal(path)}")' for path in _BLOCKED_READ_PATHS],
                ")",
            ]
        ),
        '(allow file-write* (literal "/dev/null"))',
    ]
    rules.append(_allow_subpath("allow file-read*", str(sandbox_root)))
    rules.append(_allow_subpath("allow file-write*", str(sandbox_root)))
    for path in writable_paths:
        rules.append(_allow_subpath("allow file-read*", path))
        rules.append(_allow_subpath("allow file-write*", path))
    for path in read_only_paths:
        rules.append(_allow_subpath("allow file-read*", path))
    if allow_network:
        rules.append("(allow network-outbound)")
    return " ".join(rules)


def _inside(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _ensure_paths(options: SandboxOptions) -> tuple[Path, Path, dict[str, Path]]:
    if not options.sandbox_root:
        raise ValueError("A sandbox root is required for command execution")
    root = Path(options.sandbox_root).expanduser().resolve()
    shared_root = (
        Path(options.shared_root).expanduser().resolve()
        if options.shared_root
        else (root.parent / "shared").resolve()
    )
    roots = {
        "work": root / "work",
        "scripts": root / "scripts",
        "outputs": root / "outputs",
        "tmp": root / "tmp",
        "environment": root / "env",
        "shared": shared_root,
        "runtimes": shared_root / "runtimes",
        "uv_store": shared_root / "stores" / "uv",
        "pnpm_store": shared_root / "stores" / "pnpm",
    }
    root.mkdir(parents=True, exist_ok=True)
    for path in roots.values():
        path.mkdir(parents=True, exist_ok=True)
    requested_cwd = options.cwd or "work"
    raw_cwd = Path(requested_cwd)
    cwd = raw_cwd.resolve() if raw_cwd.is_absolute() else (root / raw_cwd).resolve()
    if not _inside(root, cwd) or not cwd.is_dir():
        raise ValueError("Sandbox cwd must be an existing directory inside the sandbox root")
    for parent in (cwd, *cwd.parents):
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError("Sandbox cwd cannot contain symlinks")
    return root, cwd, roots


def _normalize_read_only_paths(paths: tuple[str, ...]) -> tuple[str, ...]:
    normalized: list[str] = []
    for raw in paths:
        path = Path(raw).expanduser()
        if not path.is_absolute() or not path.exists():
            raise ValueError("Sandbox read-only paths must be existing absolute paths")
        normalized.append(str(path.resolve()))
    return tuple(dict.fromkeys(normalized))


def _build_environment(roots: dict[str, Path], options: SandboxOptions) -> dict[str, str]:
    binary_paths = [
        roots["environment"] / "python" / "bin",
        roots["work"].parent / "node_modules" / ".bin",
        roots["runtimes"] / "node" / "current" / "bin",
        roots["runtimes"] / "tools",
        Path("/usr/bin"),
        Path("/bin"),
        Path("/usr/sbin"),
        Path("/sbin"),
    ]
    env = {
        "HOME": str(roots["work"]),
        "TMPDIR": str(roots["tmp"]),
        "PATH": ":".join(str(path) for path in binary_paths),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "LC_CTYPE": os.environ.get("LC_CTYPE", "UTF-8"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "UV_CACHE_DIR": str(roots["uv_store"]),
        "PNPM_STORE_DIR": str(roots["pnpm_store"]),
        "REFORA_SANDBOX": str(roots["work"].parent),
        "REFORA_WORK": str(roots["work"]),
        "REFORA_SCRIPTS": str(roots["scripts"]),
        "REFORA_OUTPUTS": str(roots["outputs"]),
    }
    workspace_python = roots["environment"] / "python" / "bin" / "python"
    managed_node = roots["runtimes"] / "node" / "current" / "bin" / "node"
    if workspace_python.is_file():
        env["REFORA_PYTHON"] = str(workspace_python)
    if managed_node.is_file():
        env["REFORA_NODE"] = str(managed_node)
    env.update(options.extra_env)
    return env


PROCESS_LIMIT = 256


def _current_user_process_count() -> int | None:
    try:
        result = subprocess.run(
            ["/bin/ps", "-axo", "uid="],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    user_id = str(os.getuid())
    return sum(1 for line in result.stdout.splitlines() if line.strip() == user_id)


def _build_preexec(cpu_seconds: int, memory_mb: int, file_size_mb: int) -> Callable[[], None]:
    user_process_count = _current_user_process_count()

    def _preexec() -> None:
        limits: tuple[tuple[int | None, int], ...] = (
            (resource.RLIMIT_CPU, cpu_seconds),
            (resource.RLIMIT_FSIZE, file_size_mb * 1024 * 1024),
        )
        if sys.platform == "linux":
            limits += (
                (getattr(resource, "RLIMIT_AS", None), memory_mb * 1024 * 1024),
                (getattr(resource, "RLIMIT_DATA", None), memory_mb * 1024 * 1024),
            )
        for resource_id, requested in limits:
            if resource_id is None:
                continue
            try:
                _, hard = resource.getrlimit(resource_id)
                limit = min(requested, hard) if hard != resource.RLIM_INFINITY else requested
                resource.setrlimit(resource_id, (limit, hard))
            except (ValueError, OSError):
                continue
        if user_process_count is not None:
            try:
                soft, hard = resource.getrlimit(resource.RLIMIT_NPROC)
                target = user_process_count + PROCESS_LIMIT
                if hard != resource.RLIM_INFINITY:
                    target = min(target, hard)
                if soft == resource.RLIM_INFINITY or soft > target:
                    resource.setrlimit(resource.RLIMIT_NPROC, (target, hard))
            except (ValueError, OSError):
                pass

    return _preexec


def _terminate(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.terminate()
        except (ProcessLookupError, OSError):
            return
    try:
        process.wait(timeout=1)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def _process_group_rss_bytes(process_group_id: int) -> int | None:
    try:
        result = subprocess.run(
            ["/bin/ps", "-axo", "pgid=,rss="],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    total_kib = 0
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        try:
            pgid, rss_kib = (int(value) for value in fields)
        except ValueError:
            continue
        if pgid == process_group_id and rss_kib > 0:
            total_kib += rss_kib
    return total_kib * 1024


def _memory_limit_reached(process_group_id: int, memory_mb: int) -> bool | None:
    rss = _process_group_rss_bytes(process_group_id)
    if rss is None:
        return None
    return rss > memory_mb * 1024 * 1024


def _collect_output(
    stream: BinaryIO,
    limit: int,
    chunks: list[bytes],
    state: dict[str, bool],
) -> None:
    stored = 0
    while True:
        chunk = stream.read(64 * 1024)
        if not chunk:
            return
        remaining = max(0, limit - stored)
        if remaining:
            selected = chunk[:remaining]
            chunks.append(selected)
            stored += len(selected)
        if len(chunk) > remaining:
            state["truncated"] = True


def _snapshot_files(root: Path) -> dict[str, _FileSnapshot]:
    snapshot: dict[str, _FileSnapshot] = {}
    for name in ("work", "scripts", "outputs"):
        base = root / name
        for current_root, dirs, files in os.walk(base, followlinks=False):
            dirs[:] = [entry for entry in dirs if not (Path(current_root) / entry).is_symlink()]
            for entry in files:
                target = Path(current_root) / entry
                if target.is_symlink():
                    continue
                try:
                    info = target.stat()
                    relative = str(target.relative_to(root))
                except (OSError, ValueError):
                    continue
                snapshot[relative] = _FileSnapshot(info.st_mtime_ns, info.st_size)
                if len(snapshot) >= MAX_CHANGED_FILES * 5:
                    return snapshot
    return snapshot


def _changed_files(
    before: dict[str, _FileSnapshot],
    after: dict[str, _FileSnapshot],
) -> tuple[dict[str, Any], ...]:
    changed: list[dict[str, Any]] = []
    for path, current in after.items():
        previous = before.get(path)
        if previous == current:
            continue
        mime_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        changed.append({"path": path, "mimeType": mime_type, "size": current.size})
        if len(changed) >= MAX_CHANGED_FILES:
            break
    return tuple(changed)


def _prepare_readonly_context(
    options: SandboxOptions,
    roots: dict[str, Path],
    workspace_id: str | None,
) -> tuple[Path, Path] | None:
    if (
        not options.db_path
        or options.documents_repo is None
        or options.workspace_assets_repo is None
    ):
        return None
    readonly_root = roots["shared"] / "readonly"
    token = uuid.uuid4().hex
    snapshot_path = readonly_root / f"refora-readonly-{token}.db"
    manifest_path = readonly_root / f"readonly-files-{token}.json"
    try:
        create_db_snapshot(options.db_path, snapshot_path)
        write_readonly_files_manifest(
            workspace_id,
            options.documents_repo,
            options.workspace_assets_repo,
            manifest_path,
        )
        return snapshot_path, manifest_path
    except Exception:
        cleanup_snapshot(snapshot_path)
        manifest_path.unlink(missing_ok=True)
        raise


def _cleanup_readonly_context(context: tuple[Path, Path] | None) -> None:
    if context is None:
        return
    snapshot_path, manifest_path = context
    cleanup_snapshot(snapshot_path)
    manifest_path.unlink(missing_ok=True)


def execute(command: str, options: SandboxOptions | None = None) -> dict[str, Any]:
    if not isinstance(command, str):
        raise TypeError("Sandbox command must be a string")
    if not command.strip():
        raise ValueError("Sandbox command must not be empty")
    if len(command) > MAX_COMMAND_CHARS:
        raise ValueError("Sandbox command exceeds the maximum length")
    opts = options or SandboxOptions()
    if (
        opts.timeout_seconds <= 0
        or opts.cpu_seconds <= 0
        or opts.memory_mb <= 0
        or opts.file_size_mb <= 0
    ):
        raise ValueError("Sandbox resource limits must be positive")
    if opts.timeout_seconds > MAX_TIMEOUT_SECONDS:
        raise ValueError(f"Sandbox timeout cannot exceed {MAX_TIMEOUT_SECONDS} seconds")
    if sys.platform != "darwin" or not Path(opts.sandbox_executable).is_file():
        return SandboxResult(
            stdout="",
            stderr="OS-level sandbox execution is unavailable",
            status="unavailable",
            exit_code=-1,
            error="sandbox_unavailable",
        ).as_dict()

    root, cwd, roots = _ensure_paths(opts)
    read_only_paths = _normalize_read_only_paths(
        (*opts.read_only_paths, str(roots["shared"]))
    )
    profile = _sandbox_profile(root, read_only_paths)
    env = _build_environment(roots, opts)
    before = _snapshot_files(root)
    started_at = time.monotonic()
    argv = [
        opts.sandbox_executable,
        "-p",
        profile,
        opts.shell_executable,
        "--noprofile",
        "--norc",
        "-o",
        "pipefail",
        "-c",
        command,
    ]
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_build_preexec(opts.cpu_seconds, opts.memory_mb, opts.file_size_mb),
        )
    except OSError as error:
        return SandboxResult(
            stdout="",
            stderr=str(error),
            status="error",
            exit_code=-1,
            error="sandbox_spawn_failed",
            duration_ms=int((time.monotonic() - started_at) * 1000),
        ).as_dict()

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    output_state = {"truncated": False}
    readers = [
        threading.Thread(
            target=_collect_output,
            args=(process.stdout, opts.max_output_bytes, stdout_chunks, output_state),
            daemon=True,
        ),
        threading.Thread(
            target=_collect_output,
            args=(process.stderr, opts.max_output_bytes, stderr_chunks, output_state),
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    cancelled = False
    memory_limited = False
    memory_monitor_unavailable = False
    deadline = started_at + opts.timeout_seconds
    next_memory_check = started_at
    while process.poll() is None:
        if opts.cancel_event is not None and opts.cancel_event.is_set():
            cancelled = True
            _terminate(process)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _terminate(process)
            break
        if time.monotonic() >= next_memory_check:
            next_memory_check = time.monotonic() + _MEMORY_POLL_SECONDS
            memory_state = _memory_limit_reached(process.pid, opts.memory_mb)
            if memory_state is None:
                memory_monitor_unavailable = True
                _terminate(process)
                break
            if memory_state:
                memory_limited = True
                _terminate(process)
                break
        time.sleep(0.05)
    process.wait()
    for reader in readers:
        reader.join(timeout=2)

    stdout = b"".join(stdout_chunks).decode("utf-8", errors="replace")
    stderr = b"".join(stderr_chunks).decode("utf-8", errors="replace")
    exit_code = process.returncode if process.returncode is not None else -1
    signal_name = None
    if exit_code < 0:
        try:
            signal_name = signal.Signals(-exit_code).name
        except ValueError:
            signal_name = "SIGNALED"
    if cancelled:
        status = "cancelled"
    elif timed_out:
        status = "timeout"
    elif memory_monitor_unavailable:
        status = "unavailable"
    elif memory_limited or exit_code in (_RESOURCE_EXIT_CODE, -signal.SIGXCPU, -signal.SIGKILL):
        status = "resource_limit"
    elif exit_code == 0:
        status = "ok"
    else:
        status = "error"
    after = _snapshot_files(root)
    return SandboxResult(
        stdout=stdout,
        stderr=stderr,
        status=status,
        exit_code=exit_code,
        timed_out=timed_out,
        cancelled=cancelled,
        truncated=output_state["truncated"],
        error="memory_monitor_unavailable" if memory_monitor_unavailable else None,
        duration_ms=int((time.monotonic() - started_at) * 1000),
        signal_name=signal_name,
        changed_files=_changed_files(before, after),
    ).as_dict()


def _run_installer(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: int,
    max_output_bytes: int,
    cancel_event: threading.Event,
    sandbox_executable: str,
    cpu_seconds: int,
    memory_mb: int,
    file_size_mb: int,
) -> dict[str, Any]:
    started_at = time.monotonic()
    if not Path(sandbox_executable).is_file():
        return {
            "status": "unavailable",
            "exitCode": -1,
            "stdout": "",
            "stderr": "OS-level sandbox execution is unavailable",
            "timedOut": False,
            "cancelled": False,
            "truncated": False,
        }
    writable = []
    for raw in (
        str(cwd),
        env.get("HOME"),
        env.get("TMPDIR"),
        env.get("UV_CACHE_DIR"),
        env.get("PNPM_STORE_DIR"),
        env.get("UV_PYTHON_INSTALL_DIR"),
        env.get("REFORA_SANDBOX"),
    ):
        if not raw:
            continue
        path = Path(raw).expanduser().resolve()
        if path.is_absolute():
            writable.append(str(path))
    readable = []
    for raw in argv:
        path = Path(raw).expanduser()
        if not path.is_absolute() or not path.exists():
            continue
        resolved = path.resolve()
        readable.append(str(resolved.parent if resolved.is_file() else resolved))
    primary_root = Path(writable[0])
    profile = _sandbox_profile(
        primary_root,
        tuple(dict.fromkeys(readable)),
        tuple(dict.fromkeys(writable[1:])),
        allow_network=True,
    )
    sandboxed_argv = [sandbox_executable, "-p", profile, *argv]
    try:
        process = subprocess.Popen(
            sandboxed_argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_build_preexec(cpu_seconds, memory_mb, file_size_mb),
        )
    except OSError as error:
        return {
            "status": "error",
            "exitCode": -1,
            "stdout": "",
            "stderr": str(error),
            "timedOut": False,
            "cancelled": False,
            "truncated": False,
        }
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    output_state = {"truncated": False}
    readers = [
        threading.Thread(
            target=_collect_output,
            args=(process.stdout, max_output_bytes, stdout_chunks, output_state),
            daemon=True,
        ),
        threading.Thread(
            target=_collect_output,
            args=(process.stderr, max_output_bytes, stderr_chunks, output_state),
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()
    timed_out = False
    cancelled = False
    memory_limited = False
    memory_monitor_unavailable = False
    deadline = started_at + timeout_seconds
    next_memory_check = started_at
    while process.poll() is None:
        if cancel_event.is_set():
            cancelled = True
            _terminate(process)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _terminate(process)
            break
        if time.monotonic() >= next_memory_check:
            next_memory_check = time.monotonic() + _MEMORY_POLL_SECONDS
            memory_state = _memory_limit_reached(process.pid, memory_mb)
            if memory_state is None:
                memory_monitor_unavailable = True
                _terminate(process)
                break
            if memory_state:
                memory_limited = True
                _terminate(process)
                break
        time.sleep(0.05)
    process.wait()
    for reader in readers:
        reader.join(timeout=2)
    status = "ok" if process.returncode == 0 else "error"
    if cancelled:
        status = "cancelled"
    elif timed_out:
        status = "timeout"
    elif memory_monitor_unavailable:
        status = "unavailable"
    elif memory_limited or process.returncode in (
        _RESOURCE_EXIT_CODE,
        -signal.SIGXCPU,
        -signal.SIGKILL,
    ):
        status = "resource_limit"
    return {
        "status": status,
        "exitCode": process.returncode,
        "stdout": b"".join(stdout_chunks).decode("utf-8", errors="replace"),
        "stderr": (
            "Memory monitoring is unavailable"
            if memory_monitor_unavailable
            else b"".join(stderr_chunks).decode("utf-8", errors="replace")
        ),
        "timedOut": timed_out,
        "cancelled": cancelled,
        "truncated": output_state["truncated"],
        "durationMs": int((time.monotonic() - started_at) * 1000),
    }


class SandboxExecutor:
    def __init__(self, options: SandboxOptions | None = None) -> None:
        self._options = options or SandboxOptions()
        self._cancellations: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._runtime_manager = ManagedRuntimeManager(
            RuntimeManagerOptions(
                architecture=self._options.architecture,
                download_file=self._options.download_file,
                python_executable=self._options.python_executable,
                node_executable=self._options.node_executable,
                uv_executable=self._options.uv_executable,
                pnpm_executable=self._options.pnpm_executable,
                discover_path=self._options.discover_runtime_path,
            ),
            self._run_runtime_file,
        )

    def _run_runtime_file(
        self,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        return _run_installer(
            argv,
            cwd=cwd,
            env=env,
            timeout_seconds=RUNTIME_INSTALL_TIMEOUT_SECONDS,
            max_output_bytes=self._options.max_output_bytes,
            cancel_event=cancel_event,
            sandbox_executable=self._options.sandbox_executable,
            cpu_seconds=self._options.cpu_seconds,
            memory_mb=self._options.memory_mb,
            file_size_mb=self._options.file_size_mb,
        )

    def execute(self, command: str, options: SandboxOptions | None = None) -> dict[str, Any]:
        return execute(command, options or self._options)

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
        sandbox_root = arguments.get("_sandboxRoot", arguments.get("sandboxRoot"))
        if isinstance(sandbox_root, str) and sandbox_root:
            overrides["sandbox_root"] = sandbox_root
        cwd = arguments.get("cwd")
        if isinstance(cwd, str) and cwd:
            overrides["cwd"] = cwd
        run_id = arguments.get("_runId")
        workspace_id = arguments.get("_workspaceId")
        if not isinstance(workspace_id, str) or not workspace_id:
            workspace_id = None
        cancel_event = threading.Event()
        overrides["cancel_event"] = cancel_event
        merged = replace(self._options, **overrides)
        root, _, roots = _ensure_paths(merged)
        runtime = self._runtime_manager.resolve(
            runtime_paths(root, roots["shared"])
        )
        runtime_env = {"PATH": runtime.path}
        if runtime.python_path:
            runtime_env["REFORA_PYTHON"] = runtime.python_path
        if runtime.node_path:
            runtime_env["REFORA_NODE"] = runtime.node_path
        merged = replace(
            merged,
            extra_env={**runtime_env, **merged.extra_env},
        )
        if isinstance(run_id, str) and run_id:
            with self._lock:
                self._cancellations[run_id] = cancel_event
        readonly_context: tuple[Path, Path] | None = None
        try:
            try:
                readonly_context = _prepare_readonly_context(
                    merged, roots, workspace_id
                )
            except Exception as error:
                return SandboxResult(
                    stdout="",
                    stderr=str(error),
                    status="error",
                    exit_code=-1,
                    error="readonly_context_failed",
                ).as_dict()
            if readonly_context is not None:
                snapshot_path, manifest_path = readonly_context
                merged = replace(
                    merged,
                    read_only_paths=(
                        *merged.read_only_paths,
                        str(snapshot_path),
                        str(manifest_path),
                    ),
                    extra_env={
                        **merged.extra_env,
                        "REFORA_READONLY_DB": str(snapshot_path),
                        "REFORA_READONLY_FILES": str(manifest_path),
                    },
                )
            return execute(command, merged)
        finally:
            _cleanup_readonly_context(readonly_context)
            if isinstance(run_id, str) and run_id:
                with self._lock:
                    if self._cancellations.get(run_id) is cancel_event:
                        self._cancellations.pop(run_id, None)

    def cancel(self, run_id: str) -> bool:
        with self._lock:
            event = self._cancellations.get(run_id)
        if event is None:
            return False
        event.set()
        return True

    def install_runtime_packages(
        self,
        workspace_id: str | None,
        args: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        arguments = args or {}
        sandbox_root = arguments.get("_sandboxRoot", arguments.get("sandboxRoot"))
        options = replace(
            self._options,
            sandbox_root=sandbox_root
            if isinstance(sandbox_root, str) and sandbox_root
            else self._options.sandbox_root,
        )
        root, _, roots = _ensure_paths(options)
        run_id = arguments.get("_runId")
        cancel_event = threading.Event()
        if isinstance(run_id, str) and run_id:
            with self._lock:
                self._cancellations[run_id] = cancel_event
        try:
            return self._runtime_manager.install(
                workspace_id,
                arguments,
                runtime_paths(root, roots["shared"]),
                cancel_event,
            )
        finally:
            if isinstance(run_id, str) and run_id:
                with self._lock:
                    if self._cancellations.get(run_id) is cancel_event:
                        self._cancellations.pop(run_id, None)


def createSandboxService(options: SandboxOptions | None = None) -> dict[str, Any]:
    executor = SandboxExecutor(options)

    def execute_sandbox(command: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        return executor.execute_sandbox(command, args)

    return {
        "execute": executor.execute,
        "execute_sandbox": execute_sandbox,
        "install_runtime_packages": executor.install_runtime_packages,
        "cancel": executor.cancel,
    }
