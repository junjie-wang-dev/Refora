from __future__ import annotations

import asyncio
import json
import os
import stat

import pytest

from conftest import open_migrated_db
from refora_server.services import mineru as mineru_mod
from refora_server.services.mineru import (
    MineruEngineManagerDeps,
    create_mineru_engine_manager,
)

UV_RELEASE = mineru_mod.UV_RELEASES["arm64"]


def _make_deps(tmp_path, *, trash_paths=None, download_calls=None):
    install_root = str(tmp_path / "userData" / "engines")

    async def download_file(url, destination, cancel_event, on_progress):
        download_calls.append({"url": url, "destination": destination})
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as fh:
            fh.write(b"fake-archive-bytes")
        on_progress(4, 10)

    async def trash_item(path):
        trash_paths.append(path)
        import shutil

        shutil.rmtree(path, ignore_errors=True)

    return MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
        environment={"PATH": "/usr/bin:/bin"},
    )


def _install_path(tmp_path):
    root = str(tmp_path / "userData" / "engines")
    return os.path.join(
        root,
        "Refora",
        "MinerU",
        mineru_mod.MINERU_VERSION,
        "darwin-arm64",
    )


def _install_path_for_root(user_data_dir):
    root = os.path.join(user_data_dir, "engines")
    return os.path.join(
        root,
        "Refora",
        "MinerU",
        mineru_mod.MINERU_VERSION,
        "darwin-arm64",
    )


def _make_executable(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("#!/bin/sh\n")
    os.chmod(path, 0o755)


@pytest.fixture
def manager(tmp_path, monkeypatch):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])

    def fake_run_file(command, args, *, cwd, env, cancel_event, on_child):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                with open(os.path.join(extracted, "uv"), "wb") as fh:
                    fh.write(b"")
            elif "python" in args and "install" in args:
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif "pip" in args and "install" in args:
                pass
            elif command.endswith("mineru-models-download"):
                with open(os.path.join(cwd, "mineru.json"), "w") as fh:
                    json.dump({"models": {}}, fh)
            elif "-c" in args and "mineru.version" in " ".join(args):
                return mineru_mod.MINERU_VERSION
            on_child(None)
            return ""

        return _impl()

    monkeypatch.setattr(mineru_mod, "_run_file", fake_run_file)
    monkeypatch.setattr(mineru_mod, "sha256_file", lambda path: UV_RELEASE["sha256"])
    return create_mineru_engine_manager(deps), deps


class _FakeChild:
    def __init__(self):
        self.returncode = None
        self.pid = 12345


@pytest.mark.asyncio
async def test_status_not_installed_when_absent(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    status = await mgr["getStatus"]()
    assert status.state == "notInstalled"
    assert status.installPath is None
    assert status.version is None
    assert status.error is None
    assert (await mgr["status"]()).state == "notInstalled"


@pytest.mark.asyncio
async def test_set_install_root_rejects_symbolic_link(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    target = tmp_path / "target"
    target.mkdir()
    symlink = tmp_path / "engines-link"
    symlink.symlink_to(target, target_is_directory=True)
    with pytest.raises(RuntimeError, match="regular directory"):
        await mgr["setInstallRoot"](str(symlink))


@pytest.mark.asyncio
async def test_status_invalid_when_path_exists_without_manifest(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    os.makedirs(_install_path(tmp_path), exist_ok=True)
    status = await mgr["getStatus"]()
    assert status.state == "invalid"
    assert status.installPath is not None
    assert status.error is not None


@pytest.mark.asyncio
async def test_status_invalid_when_manifest_missing_runtime(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    path = _install_path(tmp_path)
    os.makedirs(path, exist_ok=True)
    manifest = {
        "version": mineru_mod.MINERU_VERSION,
        "architecture": "arm64",
        "pythonRelativePath": "runtime/venv/bin/python",
        "modelConfigRelativePath": "mineru.json",
        "modelRevision": "rev",
        "installedAt": 123,
        "diskBytes": None,
    }
    with open(os.path.join(path, "installed-manifest.json"), "w") as fh:
        json.dump(manifest, fh)
    status = await mgr["getStatus"]()
    assert status.state == "invalid"
    assert status.error == "MinerU runtime or model configuration is missing"


@pytest.mark.asyncio
async def test_status_installed_when_manifest_and_runtime_present(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    path = _install_path(tmp_path)
    os.makedirs(path, exist_ok=True)
    manifest = {
        "version": mineru_mod.MINERU_VERSION,
        "architecture": "arm64",
        "pythonRelativePath": "runtime/venv/bin/python",
        "modelConfigRelativePath": "mineru.json",
        "modelRevision": "rev-1",
        "installedAt": 123,
        "diskBytes": None,
    }
    with open(os.path.join(path, "installed-manifest.json"), "w") as fh:
        json.dump(manifest, fh)
    _make_executable(os.path.join(path, "runtime", "venv", "bin", "python"))
    with open(os.path.join(path, "mineru.json"), "w") as fh:
        json.dump({"models": {}}, fh)
    status = await mgr["getStatus"]()
    assert status.state == "installed"
    assert status.version == mineru_mod.MINERU_VERSION
    assert status.pythonPath.endswith("runtime/venv/bin/python")
    assert status.modelConfigPath.endswith("mineru.json")


@pytest.mark.asyncio
async def test_install_creates_engine_and_reports_installed(manager):
    mgr, deps = manager
    status = await mgr["install"]()
    assert status.state == "installed"
    path = _install_path_for_root(deps.userDataDir)
    assert os.path.exists(os.path.join(path, "installed-manifest.json"))
    assert os.path.exists(os.path.join(path, "mineru.json"))
    with open(os.path.join(path, "installed-manifest.json")) as fh:
        manifest = json.load(fh)
    assert manifest["version"] == mineru_mod.MINERU_VERSION
    assert manifest["architecture"] == "arm64"
    assert manifest["pythonRelativePath"] == "runtime/venv/bin/python"


@pytest.mark.asyncio
async def test_install_is_idempotent_when_already_installed(manager):
    mgr, deps = manager
    first = await mgr["install"]()
    assert first.state == "installed"
    second = await mgr["install"]()
    assert second.state == "installed"


@pytest.mark.asyncio
async def test_install_emits_progress_events(manager):
    mgr, deps = manager
    events: list[str] = []
    mgr["onProgress"](lambda p: events.append(p.stage))
    await mgr["install"]()
    assert "preparing" in events
    assert "installingTools" in events
    assert "installingPython" in events
    assert "installingMineru" in events
    assert "downloadingModels" in events
    assert "healthCheck" in events
    assert "finalizing" in events
    assert "completed" in events


@pytest.mark.asyncio
async def test_cancel_install_aborts_in_progress_download(tmp_path, monkeypatch):
    trash_paths: list[str] = []
    cancel_seen = asyncio.Event()
    install_started = asyncio.Event()

    async def download_file(url, destination, cancel_event, on_progress):
        install_started.set()
        await cancel_event.wait()
        cancel_seen.set()
        raise RuntimeError("cancelled")

    async def trash_item(path):
        trash_paths.append(path)
        import shutil

        shutil.rmtree(path, ignore_errors=True)

    deps = MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
    )

    def fake_run_file(command, args, *, cwd, env, cancel_event, on_child):
        async def _impl():
            on_child(_FakeChild())
            on_child(None)
            return ""

        return _impl()

    monkeypatch.setattr(mineru_mod, "_run_file", fake_run_file)

    mgr = create_mineru_engine_manager(deps)
    install_task = asyncio.ensure_future(mgr["install"]())
    await install_started.wait()
    status = await mgr["cancelInstall"]()
    assert cancel_seen.is_set()
    with pytest.raises(Exception):
        await install_task
    assert status.state in ("notInstalled", "invalid")
    assert status.error is None


@pytest.mark.asyncio
async def test_uninstall_trashes_install_path(tmp_path, monkeypatch):
    trash_paths: list[str] = []

    async def download_file(url, destination, cancel_event, on_progress):
        with open(destination, "wb") as fh:
            fh.write(b"x")

    async def trash_item(path):
        trash_paths.append(path)
        import shutil

        shutil.rmtree(path, ignore_errors=True)

    deps = MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
    )

    def fake_run_file(command, args, *, cwd, env, cancel_event, on_child):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                open(os.path.join(extracted, "uv"), "wb").close()
            elif "python" in args and "install" in args:
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif command.endswith("mineru-models-download"):
                with open(os.path.join(cwd, "mineru.json"), "w") as fh:
                    json.dump({"models": {}}, fh)
            elif "-c" in args and "mineru.version" in " ".join(args):
                return mineru_mod.MINERU_VERSION
            on_child(None)
            return ""

        return _impl()

    monkeypatch.setattr(mineru_mod, "_run_file", fake_run_file)
    monkeypatch.setattr(mineru_mod, "sha256_file", lambda path: UV_RELEASE["sha256"])

    mgr = create_mineru_engine_manager(deps)
    await mgr["install"]()
    path = _install_path(tmp_path)
    assert os.path.exists(path)
    status = await mgr["uninstall"]()
    assert status.state == "notInstalled"
    assert trash_paths and trash_paths[-1] == path
    assert not os.path.exists(path)


@pytest.mark.asyncio
async def test_uninstall_rejects_while_installing(tmp_path, monkeypatch):
    install_started = asyncio.Event()

    async def download_file(url, destination, cancel_event, on_progress):
        install_started.set()
        await cancel_event.wait()
        raise RuntimeError("cancelled")

    async def trash_item(path):
        pass

    deps = MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
    )

    def fake_run_file(command, args, *, cwd, env, cancel_event, on_child):
        async def _impl():
            on_child(_FakeChild())
            on_child(None)
            return ""

        return _impl()

    monkeypatch.setattr(mineru_mod, "_run_file", fake_run_file)
    mgr = create_mineru_engine_manager(deps)
    install_task = asyncio.ensure_future(mgr["install"]())
    await install_started.wait()
    with pytest.raises(RuntimeError, match="Cancel the active"):
        await mgr["uninstall"]()
    await mgr["cancelInstall"]()
    with pytest.raises(Exception):
        await install_task


@pytest.mark.asyncio
async def test_get_runtime_raises_when_not_installed(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    with pytest.raises(RuntimeError, match="MinerU is not installed"):
        await mgr["getRuntime"]()


@pytest.mark.asyncio
async def test_get_runtime_returns_environment_after_install(manager):
    mgr, deps = manager
    await mgr["install"]()
    runtime = await mgr["getRuntime"]()
    assert runtime.modelRevision.startswith(f"mineru-{mineru_mod.MINERU_VERSION}")
    assert runtime.environment["MINERU_MODEL_SOURCE"] == "local"
    assert "HF_HOME" in runtime.environment


@pytest.mark.asyncio
async def test_install_checksum_failure_raises(tmp_path, monkeypatch):
    trash_paths: list[str] = []

    async def download_file(url, destination, cancel_event, on_progress):
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as fh:
            fh.write(b"bad-bytes")

    async def trash_item(path):
        trash_paths.append(path)
        import shutil

        shutil.rmtree(path, ignore_errors=True)

    deps = MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
    )
    monkeypatch.setattr(mineru_mod, "sha256_file", lambda path: "wrong-hash")
    monkeypatch.setattr(
        mineru_mod,
        "_run_file",
        lambda *a, **k: _impl_noop(*a, **k),
    )
    mgr = create_mineru_engine_manager(deps)
    with pytest.raises(RuntimeError, match="checksum"):
        await mgr["install"]()
    status = await mgr["getStatus"]()
    assert status.state == "notInstalled"
    assert status.error is not None
    assert "checksum" in status.error


async def _impl_noop(command, args, *, cwd, env, cancel_event, on_child):
    async def _i():
        on_child(_FakeChild())
        on_child(None)
        return ""

    return _i()


@pytest.mark.asyncio
async def test_install_health_check_wrong_version_raises(tmp_path, monkeypatch):
    async def download_file(url, destination, cancel_event, on_progress):
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as fh:
            fh.write(b"x")

    async def trash_item(path):
        import shutil

        shutil.rmtree(path, ignore_errors=True)

    deps = MineruEngineManagerDeps(
        userDataDir=str(tmp_path / "userData"),
        downloadFile=download_file,
        trashItem=trash_item,
        architecture="arm64",
    )

    def fake_run_file(command, args, *, cwd, env, cancel_event, on_child):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                open(os.path.join(extracted, "uv"), "wb").close()
            elif "python" in args and "install" in args:
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif command.endswith("mineru-models-download"):
                with open(os.path.join(cwd, "mineru.json"), "w") as fh:
                    json.dump({"models": {}}, fh)
            elif "-c" in args and "mineru.version" in " ".join(args):
                return "9.9.9"
            on_child(None)
            return ""

        return _impl()

    monkeypatch.setattr(mineru_mod, "_run_file", fake_run_file)
    monkeypatch.setattr(mineru_mod, "sha256_file", lambda path: UV_RELEASE["sha256"])
    mgr = create_mineru_engine_manager(deps)
    with pytest.raises(RuntimeError, match="unexpected version"):
        await mgr["install"]()
