from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

import refora_server.services.agent_runtime_manager as runtime_module
from refora_server.services.agent_runtime_manager import (
    NODE_RELEASES,
    NODE_VERSION,
    UV_RELEASES,
    UV_VERSION,
    ManagedRuntimeManager,
    RuntimeManagerOptions,
    detect_architecture,
    package_specs,
    runtime_paths,
)


def _ok_runner(*_args):
    return {
        "status": "ok",
        "exitCode": 0,
        "stdout": "",
        "stderr": "",
        "timedOut": False,
        "cancelled": False,
        "truncated": False,
    }


@pytest.mark.parametrize(
    ("machine", "expected"),
    (("arm64", "arm64"), ("aarch64", "arm64"), ("x86_64", "x64"), ("amd64", "x64")),
)
def test_architecture_normalization(machine: str, expected: str):
    assert detect_architecture(machine) == expected


@pytest.mark.parametrize("architecture", ("arm64", "x64"))
def test_uv_download_selects_architecture_and_reuses_verified_install(
    tmp_path: Path,
    monkeypatch,
    architecture: str,
):
    downloads = []

    def download(url, destination, _cancel_event):
        downloads.append(url)
        destination.write_bytes(b"verified archive")

    release = UV_RELEASES[architecture]
    monkeypatch.setattr(runtime_module, "_sha256_file", lambda _path: release["sha256"])

    def extract(_archive, destination, *, strip_components):
        assert strip_components == 1
        destination.mkdir(parents=True)
        executable = destination / "uv"
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

    monkeypatch.setattr(runtime_module, "_extract_archive", extract)
    manager = ManagedRuntimeManager(
        RuntimeManagerOptions(
            architecture=architecture,
            download_file=download,
            discover_path=False,
        ),
        _ok_runner,
    )
    paths = runtime_paths(tmp_path / "sandbox", tmp_path / "shared")
    first = manager._ensure_uv(paths, threading.Event())
    second = manager._ensure_uv(paths, threading.Event())
    assert first == second
    assert Path(first).is_file()
    assert downloads == [
        f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{release['archive']}"
    ]


def test_checksum_failure_does_not_publish_runtime(tmp_path: Path):
    def download(_url, destination, _cancel_event):
        destination.write_bytes(b"tampered")

    manager = ManagedRuntimeManager(
        RuntimeManagerOptions(
            architecture="arm64",
            download_file=download,
            discover_path=False,
        ),
        _ok_runner,
    )
    paths = runtime_paths(tmp_path / "sandbox", tmp_path / "shared")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        manager._ensure_uv(paths, threading.Event())
    assert not (paths.runtime_root / "tools" / "uv").exists()


def test_existing_managed_node_is_reused_without_download(tmp_path: Path):
    paths = runtime_paths(tmp_path / "sandbox", tmp_path / "shared")
    node = paths.runtime_root / "node" / f"v{NODE_VERSION}" / "bin" / "node"
    node.parent.mkdir(parents=True)
    node.write_text("#!/bin/sh\nprintf 'v24.18.0\\n'\n", encoding="utf-8")
    node.chmod(0o755)
    downloads = []
    manager = ManagedRuntimeManager(
        RuntimeManagerOptions(
            architecture="arm64",
            download_file=lambda *args: downloads.append(args),
            discover_path=False,
        ),
        _ok_runner,
    )
    result = manager.install(
        "workspace-1",
        {"runtimes": ["node"]},
        paths,
        threading.Event(),
    )
    assert result["status"] == "ok"
    assert downloads == []
    current = paths.runtime_root / "node" / "current"
    assert current.is_symlink()
    assert current.resolve() == node.parents[1]


def test_node_release_metadata_is_fixed_for_both_architectures():
    assert set(NODE_RELEASES) == {"arm64", "x64"}
    for architecture, release in NODE_RELEASES.items():
        assert release["archive"] == f"node-v{NODE_VERSION}-darwin-{architecture}.tar.gz"
        assert len(release["sha256"]) == 64
        int(release["sha256"], 16)


def test_package_specs_require_exact_versions():
    assert package_specs(
        [{"name": "requests", "version": "2.32.3"}],
        kind="python",
    ) == ["requests==2.32.3"]
    assert package_specs(
        [{"name": "@scope/pkg", "version": "1.2.3"}],
        kind="node",
    ) == ["@scope/pkg@1.2.3"]
    for version in (None, "latest", "^1.2.3", ">=2", "1.2.*"):
        with pytest.raises(ValueError, match="exact version"):
            package_specs([{"name": "requests", "version": version}], kind="python")


def test_install_operations_are_serialized(tmp_path: Path):
    tools = tmp_path / "tools"
    tools.mkdir()
    python = tools / "python"
    python.write_text("#!/bin/sh\nprintf 'Python 3.12.9\\n'\n", encoding="utf-8")
    python.chmod(0o755)
    uv = tools / "uv"
    uv.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    uv.chmod(0o755)
    state = {"active": 0, "maximum": 0}
    state_lock = threading.Lock()

    def run_file(argv, _cwd, _env, _cancel_event):
        with state_lock:
            state["active"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
        try:
            if "venv" in argv:
                destination = Path(argv[-1])
                executable = destination / "bin" / "python"
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)
            time.sleep(0.03)
            return _ok_runner()
        finally:
            with state_lock:
                state["active"] -= 1

    manager = ManagedRuntimeManager(
        RuntimeManagerOptions(
            architecture="arm64",
            python_executable=str(python),
            uv_executable=str(uv),
            discover_path=False,
        ),
        run_file,
    )
    results = []

    def install(name: str):
        results.append(
            manager.install(
                name,
                {"python": [{"name": "requests", "version": "2.32.3"}]},
                runtime_paths(tmp_path / name, tmp_path / "shared"),
                threading.Event(),
            )
        )

    threads = [threading.Thread(target=install, args=(name,)) for name in ("one", "two")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert len(results) == 2
    assert all(result["status"] == "ok" for result in results)
    assert state["maximum"] == 1
