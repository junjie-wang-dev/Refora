from __future__ import annotations

import shlex
import sys
import threading
import time
from pathlib import Path

import pytest

from refora_server.services.sandbox import (
    SandboxExecutor,
    SandboxOptions,
    _sandbox_profile,
    execute,
)


@pytest.fixture
def sandbox_options(tmp_path: Path) -> SandboxOptions:
    options = SandboxOptions(
        sandbox_root=str(tmp_path / "sandbox"),
        timeout_seconds=5,
        cpu_seconds=5,
    )
    probe = execute("printf probe", options)
    if probe["error"] == "sandbox_unavailable" or "sandbox_apply: Operation not permitted" in probe["stderr"]:
        pytest.skip("sandbox-exec cannot be nested in this test environment")
    assert probe["status"] == "ok", probe
    return options


def test_profile_is_deny_by_default_and_has_no_broad_user_or_temp_access(tmp_path: Path):
    root = (tmp_path / "sandbox").resolve()
    profile = _sandbox_profile(root, ())
    assert "(deny default)" in profile
    assert f'(allow file-write* (subpath "{root}"))' in profile
    assert '(allow file-read* (subpath "/Users"))' not in profile
    assert '(allow file-read* (subpath "/private/tmp"))' not in profile
    assert "(allow network" not in profile


def test_execute_requires_an_explicit_sandbox_root():
    with pytest.raises(ValueError, match="sandbox root"):
        execute("printf nope", SandboxOptions(timeout_seconds=5, cpu_seconds=5))


def test_execute_normal_output_and_status(sandbox_options: SandboxOptions):
    result = execute("printf 55", sandbox_options)
    assert result["status"] == "ok"
    assert result["exitCode"] == 0
    assert result["stdout"] == "55"
    assert result["timedOut"] is False
    assert result["truncated"] is False


def test_execute_captures_stderr(sandbox_options: SandboxOptions):
    result = execute("printf 'boom\\n' >&2; printf ok", sandbox_options)
    assert result["status"] == "ok"
    assert result["stdout"] == "ok"
    assert "boom" in result["stderr"]


def test_execute_returns_nonzero_on_runtime_error(sandbox_options: SandboxOptions):
    result = execute("printf nope >&2; exit 7", sandbox_options)
    assert result["status"] == "error"
    assert result["exitCode"] == 7
    assert "nope" in result["stderr"]


def test_execute_timeout_terminates_sleeping_process(tmp_path: Path, sandbox_options: SandboxOptions):
    options = SandboxOptions(
        **{
            **sandbox_options.__dict__,
            "sandbox_root": str(tmp_path / "timeout-sandbox"),
            "timeout_seconds": 1,
        }
    )
    result = execute("sleep 30", options)
    assert result["status"] == "timeout"
    assert result["timedOut"] is True
    assert result["exitCode"] != 0


def test_execute_cpu_limit_terminates_busy_loop(tmp_path: Path, sandbox_options: SandboxOptions):
    options = SandboxOptions(
        **{
            **sandbox_options.__dict__,
            "sandbox_root": str(tmp_path / "cpu-sandbox"),
            "timeout_seconds": 10,
            "cpu_seconds": 1,
        }
    )
    result = execute("while :; do :; done", options)
    assert result["status"] == "resource_limit"
    assert result["timedOut"] is False


def test_execute_truncates_oversized_output(tmp_path: Path, sandbox_options: SandboxOptions):
    options = SandboxOptions(
        **{
            **sandbox_options.__dict__,
            "sandbox_root": str(tmp_path / "output-sandbox"),
            "max_output_bytes": 4096,
        }
    )
    result = execute("yes A | head -c 1048576", options)
    assert result["truncated"] is True
    assert len(result["stdout"].encode("utf-8", errors="replace")) <= 4096


def test_execute_rejects_oversized_command(tmp_path: Path):
    with pytest.raises(ValueError):
        execute(
            "printf x\n" * 20_000,
            SandboxOptions(
                sandbox_root=str(tmp_path / "sandbox"),
                timeout_seconds=5,
                cpu_seconds=5,
            ),
        )


def test_execute_rejects_nonpositive_timeout(tmp_path: Path):
    with pytest.raises(ValueError):
        execute(
            "printf 1",
            SandboxOptions(
                sandbox_root=str(tmp_path / "sandbox"),
                timeout_seconds=0,
                cpu_seconds=5,
            ),
        )


def test_sandbox_cannot_read_arbitrary_user_file(
    tmp_path: Path,
    sandbox_options: SandboxOptions,
):
    private_file = tmp_path / "private.txt"
    private_file.write_text("outside-secret", encoding="utf-8")
    result = execute(f"cat {shlex.quote(str(private_file))}", sandbox_options)
    assert result["status"] == "error"
    assert "outside-secret" not in result["stdout"]


def test_sandbox_cannot_write_outside_root(
    tmp_path: Path,
    sandbox_options: SandboxOptions,
):
    outside = tmp_path / "outside.txt"
    result = execute(
        f"printf escaped > {shlex.quote(str(outside))}",
        sandbox_options,
    )
    assert result["status"] == "error"
    assert not outside.exists()


def test_outputs_are_writable_and_reported_as_changed_files(
    sandbox_options: SandboxOptions,
):
    result = execute("printf artifact > \"$REFORA_OUTPUTS/report.txt\"", sandbox_options)
    assert result["status"] == "ok"
    output = Path(sandbox_options.sandbox_root or "") / "outputs" / "report.txt"
    assert output.read_text(encoding="utf-8") == "artifact"
    assert result["changedFiles"] == [
        {"path": "outputs/report.txt", "mimeType": "text/plain", "size": 8}
    ]


def test_cwd_and_environment_point_inside_sandbox(sandbox_options: SandboxOptions):
    result = execute(
        "printf '%s\\n%s\\n%s\\n%s' \"$PWD\" \"$HOME\" \"$TMPDIR\" \"$REFORA_OUTPUTS\"",
        sandbox_options,
    )
    root = Path(sandbox_options.sandbox_root or "").resolve()
    assert result["stdout"].splitlines() == [
        str(root / "work"),
        str(root / "work"),
        str(root / "tmp"),
        str(root / "outputs"),
    ]


def test_workspace_environment_and_shared_managed_runtime_are_on_path(
    sandbox_options: SandboxOptions,
):
    root = Path(sandbox_options.sandbox_root or "").resolve()
    python = root / "env" / "python" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("#!/bin/sh\nprintf workspace-python\n", encoding="utf-8")
    python.chmod(0o755)
    package_command = root / "node_modules" / ".bin" / "workspace-package"
    package_command.parent.mkdir(parents=True)
    package_command.write_text("#!/bin/sh\nprintf workspace-package\n", encoding="utf-8")
    package_command.chmod(0o755)
    managed_node = root.parent / "shared" / "runtimes" / "node" / "current" / "bin" / "node"
    managed_node.parent.mkdir(parents=True)
    managed_node.write_text("#!/bin/sh\nprintf managed-node\n", encoding="utf-8")
    managed_node.chmod(0o755)
    result = execute("python; printf '\\n'; workspace-package; printf '\\n'; node", sandbox_options)
    assert result["status"] == "ok"
    assert result["stdout"].splitlines() == [
        "workspace-python",
        "workspace-package",
        "managed-node",
    ]


def test_managed_python_runtime_is_resolved_into_execute_path(
    sandbox_options: SandboxOptions,
):
    root = Path(sandbox_options.sandbox_root or "").resolve()
    shared = root.parent / "shared"
    managed_python = shared / "runtimes" / "python" / "cpython-3.12.9" / "bin" / "python3.12"
    managed_python.parent.mkdir(parents=True)
    managed_python.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = --version ]; then printf 'Python 3.12.9\\n'; "
        "else printf managed-python; fi\n",
        encoding="utf-8",
    )
    managed_python.chmod(0o755)
    executor = SandboxExecutor(
        SandboxOptions(
            sandbox_root=str(root),
            shared_root=str(shared),
            timeout_seconds=5,
            cpu_seconds=5,
            discover_runtime_path=False,
        )
    )
    result = executor.execute_sandbox("python3.12", {})
    assert result["status"] == "ok"
    assert result["stdout"] == "managed-python"
    assert result["changedFiles"] == []


def test_executor_class_reuses_defaults_and_overrides(sandbox_options: SandboxOptions):
    executor = SandboxExecutor(sandbox_options)
    default_result = executor.execute("printf 4")
    assert default_result["stdout"] == "4"
    overridden = executor.execute_sandbox(
        "sleep 20",
        {"timeoutSeconds": 1},
    )
    assert overridden["status"] == "timeout"


def test_executor_cancel_terminates_process_group(
    sandbox_options: SandboxOptions,
):
    executor = SandboxExecutor(sandbox_options)
    result: dict[str, object] = {}

    def run() -> None:
        result.update(executor.execute_sandbox("sleep 30 & wait", {"_runId": "run-1"}))

    thread = threading.Thread(target=run)
    thread.start()
    deadline = time.monotonic() + 2
    while not executor.cancel("run-1") and time.monotonic() < deadline:
        time.sleep(0.01)
    thread.join(timeout=3)
    assert not thread.is_alive()
    assert result["status"] == "cancelled"
    assert result["cancelled"] is True


def test_create_sandbox_service_factory(sandbox_options: SandboxOptions):
    service = __import__(
        "refora_server.services.sandbox", fromlist=["createSandboxService"]
    ).createSandboxService(sandbox_options)
    assert callable(service["execute"])
    assert callable(service["execute_sandbox"])
    assert callable(service["install_runtime_packages"])
    assert callable(service["cancel"])
    result = service["execute_sandbox"]("printf 1", {})
    assert result["status"] == "ok"
    assert result["stdout"] == "1"


def test_package_install_requires_exact_versions(tmp_path: Path):
    executor = SandboxExecutor(SandboxOptions(sandbox_root=str(tmp_path / "sandbox")))
    with pytest.raises(ValueError, match="exact version"):
        executor.install_runtime_packages(
            None,
            {"python": [{"name": "requests", "version": ">=2"}]},
        )
    with pytest.raises(ValueError, match="exact version"):
        executor.install_runtime_packages(
            None,
            {"node": [{"name": "zod", "version": "latest"}]},
        )


def test_python_package_install_disables_source_builds_and_uses_sandbox_environment(
    tmp_path: Path,
):
    tools = tmp_path / "tools"
    tools.mkdir()
    python = tools / "python"
    python.write_text("#!/bin/sh\nprintf 'Python 3.12.9\\n'\n", encoding="utf-8")
    python.chmod(0o755)
    uv = tools / "uv"
    uv.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$*\" >> \"$REFORA_OUTPUTS/uv.log\"\n"
        "if [ \"$2\" = venv ]; then\n"
        "  mkdir -p \"$5/bin\"\n"
        "  printf '#!/bin/sh\\nexit 0\\n' > \"$5/bin/python\"\n"
        "  chmod 755 \"$5/bin/python\"\n"
        "fi\n",
        encoding="utf-8",
    )
    uv.chmod(0o755)
    root = tmp_path / "sandbox"
    executor = SandboxExecutor(
        SandboxOptions(
            sandbox_root=str(root),
            python_executable=str(python),
            uv_executable=str(uv),
            node_executable=str(tmp_path / "missing-node"),
            pnpm_executable=str(tmp_path / "missing-pnpm"),
            discover_runtime_path=False,
        )
    )
    result = executor.install_runtime_packages(
        None,
        {"python": [{"name": "requests", "version": "2.32.3"}]},
    )
    assert result["status"] == "ok"
    log = (root / "outputs" / "uv.log").read_text(encoding="utf-8")
    assert "--no-config venv --python" in log
    assert "--no-config pip install" in log
    assert "--only-binary :all: requests==2.32.3" in log
    assert str(root / "env" / "python") in log


def test_node_package_install_is_exact_and_disables_lifecycle_scripts(tmp_path: Path):
    tools = tmp_path / "tools"
    tools.mkdir()
    node = tools / "node"
    node.write_text("#!/bin/sh\nprintf 'v24.4.0\\n'\n", encoding="utf-8")
    node.chmod(0o755)
    pnpm = tools / "pnpm"
    pnpm.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$REFORA_OUTPUTS/pnpm.log\"\n",
        encoding="utf-8",
    )
    pnpm.chmod(0o755)
    root = tmp_path / "sandbox"
    executor = SandboxExecutor(
        SandboxOptions(
            sandbox_root=str(root),
            python_executable=str(tmp_path / "missing-python"),
            uv_executable=str(tmp_path / "missing-uv"),
            node_executable=str(node),
            pnpm_executable=str(pnpm),
            discover_runtime_path=False,
        )
    )
    result = executor.install_runtime_packages(
        "workspace-1",
        {"node": [{"name": "@scope/pkg", "version": "1.2.3"}]},
    )
    assert result["status"] == "ok"
    log = (root / "outputs" / "pnpm.log").read_text(encoding="utf-8")
    assert "--save-exact" in log
    assert "--ignore-scripts" in log
    assert "@scope/pkg@1.2.3" in log
    assert str(root.parent / "shared" / "stores" / "pnpm") in log
    assert (root / "package.json").is_file()


@pytest.mark.skipif(sys.platform != "linux", reason="Refora command execution is macOS-only")
def test_non_macos_execution_fails_closed(tmp_path: Path):
    result = execute(
        "printf unsafe",
        SandboxOptions(
            sandbox_root=str(tmp_path / "sandbox"),
            timeout_seconds=5,
            cpu_seconds=5,
        ),
    )
    assert result["status"] == "unavailable"
    assert result["error"] == "sandbox_unavailable"
