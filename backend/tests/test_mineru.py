from __future__ import annotations

import asyncio
import json
import os
import stat
import sys

import pytest

from conftest import open_migrated_db
from refora_server.services import mineru as mineru_mod
from refora_server.services.mineru import (
    MineruEngineManagerDeps,
    MineruRuntime,
    MineruWorkerProcessDeps,
    create_mineru_engine_manager,
    create_mineru_worker_process,
)

UV_RELEASE = mineru_mod.UV_RELEASES["arm64"]


@pytest.mark.asyncio
async def test_run_file_drains_output_after_capture_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(mineru_mod, "_MAX_STDIO_BYTES", 16 * 1024)
    children = []

    output = await asyncio.wait_for(
        mineru_mod._run_file(
            sys.executable,
            [
                "-c",
                "import os; os.write(1, b'a' * 1000000); os.write(2, b'b' * 1000000)",
            ],
            cwd=str(tmp_path),
            env=dict(os.environ),
            cancel_event=asyncio.Event(),
            on_child=children.append,
            timeout_seconds=3,
        ),
        timeout=5,
    )

    assert len(output.encode()) <= 32 * 1024 + 1
    assert children[-1] is None


@pytest.mark.asyncio
async def test_run_file_times_out_and_releases_child(tmp_path):
    children = []

    with pytest.raises(RuntimeError, match="timed out"):
        await mineru_mod._run_file(
            sys.executable,
            ["-c", "import time; time.sleep(60)"],
            cwd=str(tmp_path),
            env=dict(os.environ),
            cancel_event=asyncio.Event(),
            on_child=children.append,
            timeout_seconds=0.05,
        )

    assert children[-1] is None
    assert children[0].returncode is not None


@pytest.mark.asyncio
async def test_worker_cancel_kills_and_reaps_sigterm_ignoring_process(
    tmp_path, monkeypatch
):
    script = tmp_path / "worker.py"
    script.write_text(
        "\n".join(
            [
                "import json, signal, sys",
                "signal.signal(signal.SIGTERM, lambda *_: None)",
                "for line in sys.stdin:",
                "    request = json.loads(line)",
                "    method = request.get('method')",
                "    if method == 'hello':",
                (
                    "        result = {'protocolVersion': "
                    f"{mineru_mod.MINERU_WORKER_PROTOCOL_VERSION!r}, "
                    f"'mineruVersion': {mineru_mod.MINERU_VERSION!r}}}"
                ),
                "        print(json.dumps({'id': request['id'], 'result': result}), flush=True)",
                "    elif method == 'parse':",
                "        print(json.dumps({'event': 'progress', 'requestId': request['id'], 'stage': 'parsing'}), flush=True)",
            ]
        ),
        encoding="utf-8",
    )
    runtime = MineruRuntime(
        installPath=str(tmp_path),
        pythonPath=sys.executable,
        modelConfigPath=str(tmp_path / "model.json"),
        modelRevision="test",
        environment=dict(os.environ),
    )

    async def get_runtime():
        return runtime

    children = []
    spawn = asyncio.create_subprocess_exec

    async def capture_child(*args, **kwargs):
        child = await spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(mineru_mod.asyncio, "create_subprocess_exec", capture_child)
    worker = create_mineru_worker_process(
        MineruWorkerProcessDeps(
            engineManager={"getRuntime": get_runtime},
            workerScriptPath=str(script),
            terminateGraceMs=25,
        )
    )
    parsing = asyncio.Event()
    parse_task = asyncio.create_task(
        worker["parse"](
            str(tmp_path / "input.pdf"),
            str(tmp_path / "output"),
            "balanced",
            lambda _progress: parsing.set(),
        )
    )
    await asyncio.wait_for(parsing.wait(), timeout=2)

    await asyncio.wait_for(worker["cancel"](), timeout=2)

    with pytest.raises(RuntimeError, match="cancelled"):
        await parse_task
    assert len(children) == 1
    assert children[0].returncode == -mineru_mod.signal.SIGKILL
    assert children[0].stdout.at_eof()
    assert children[0].stderr.at_eof()
    await worker["destroy"]()


@pytest.mark.asyncio
async def test_worker_timeout_kills_and_reaps_sigterm_ignoring_process(
    tmp_path, monkeypatch
):
    script = tmp_path / "worker.py"
    script.write_text(
        "\n".join(
            [
                "import json, signal, sys",
                "signal.signal(signal.SIGTERM, lambda *_: None)",
                "for line in sys.stdin:",
                "    request = json.loads(line)",
                "    if request.get('method') == 'hello':",
                (
                    "        result = {'protocolVersion': "
                    f"{mineru_mod.MINERU_WORKER_PROTOCOL_VERSION!r}, "
                    f"'mineruVersion': {mineru_mod.MINERU_VERSION!r}}}"
                ),
                "        print(json.dumps({'id': request['id'], 'result': result}), flush=True)",
            ]
        ),
        encoding="utf-8",
    )
    runtime = MineruRuntime(
        installPath=str(tmp_path),
        pythonPath=sys.executable,
        modelConfigPath=str(tmp_path / "model.json"),
        modelRevision="test",
        environment=dict(os.environ),
    )

    async def get_runtime():
        return runtime

    children = []
    spawn = asyncio.create_subprocess_exec

    async def capture_child(*args, **kwargs):
        child = await spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(mineru_mod.asyncio, "create_subprocess_exec", capture_child)
    worker = create_mineru_worker_process(
        MineruWorkerProcessDeps(
            engineManager={"getRuntime": get_runtime},
            workerScriptPath=str(script),
            requestTimeoutMs=25,
            terminateGraceMs=25,
        )
    )

    with pytest.raises(RuntimeError, match="timed out"):
        await worker["parse"](
            str(tmp_path / "input.pdf"),
            str(tmp_path / "output"),
            "balanced",
            lambda _progress: None,
        )
    await asyncio.wait_for(worker["destroy"](), timeout=2)

    assert len(children) == 1
    assert children[0].returncode == -mineru_mod.signal.SIGKILL
    assert children[0].stdout.at_eof()
    assert children[0].stderr.at_eof()


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


def _manifest(architecture="arm64", **overrides):
    return {
        "version": mineru_mod.MINERU_VERSION,
        "architecture": architecture,
        "pythonRelativePath": "runtime/venv/bin/python",
        "modelConfigRelativePath": "mineru.json",
        "modelRevision": f"sha256:{mineru_mod._resource_sha256('model-manifest.json')}",
        "runtimeLockSha256": mineru_mod._resource_sha256("uv.lock"),
        "modelManifestSha256": mineru_mod._resource_sha256("model-manifest.json"),
        "installedAt": 123,
        "diskBytes": None,
        **overrides,
    }


@pytest.fixture
def manager(tmp_path, monkeypatch):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])

    def fake_run_file(
        command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
    ):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                with open(os.path.join(extracted, "uv"), "wb") as fh:
                    fh.write(b"")
            elif "python" in args and "install" in args:
                assert args[2] == mineru_mod.MINERU_PYTHON_VERSION
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif "sync" in args:
                assert "--locked" in args
                assert args[args.index("--extra") + 1] == "arm64"
                assert env["VIRTUAL_ENV"].endswith("runtime/venv")
            elif args and args[0].endswith("model_installer.py"):
                with open(args[2], "w") as fh:
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
    manifest = _manifest(modelRevision="rev")
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
    manifest = _manifest(modelRevision="rev-1")
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
async def test_status_rejects_stale_runtime_lock(tmp_path):
    deps = _make_deps(tmp_path, trash_paths=[], download_calls=[])
    mgr = create_mineru_engine_manager(deps)
    path = _install_path(tmp_path)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "installed-manifest.json"), "w") as fh:
        json.dump(_manifest(runtimeLockSha256="0" * 64), fh)
    _make_executable(os.path.join(path, "runtime", "venv", "bin", "python"))
    with open(os.path.join(path, "mineru.json"), "w") as fh:
        json.dump({"models": {}}, fh)
    status = await mgr["getStatus"]()
    assert status.state == "invalid"


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
    assert manifest["runtimeLockSha256"] == mineru_mod._resource_sha256("uv.lock")
    assert manifest["modelManifestSha256"] == mineru_mod._resource_sha256(
        "model-manifest.json"
    )


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

    def fake_run_file(
        command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
    ):
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

    def fake_run_file(
        command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
    ):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                open(os.path.join(extracted, "uv"), "wb").close()
            elif "python" in args and "install" in args:
                assert args[2] == mineru_mod.MINERU_PYTHON_VERSION
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif args and args[0].endswith("model_installer.py"):
                with open(args[2], "w") as fh:
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

    def fake_run_file(
        command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
    ):
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
    assert runtime.modelRevision == f"sha256:{mineru_mod._resource_sha256('model-manifest.json')}"
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


async def _impl_noop(
    command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
):
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

    def fake_run_file(
        command, args, *, cwd, env, cancel_event, on_child, timeout_seconds
    ):
        async def _impl():
            on_child(_FakeChild())
            if command.endswith("tar"):
                extracted = os.path.join(cwd, ".downloads", "uv-extracted")
                os.makedirs(extracted, exist_ok=True)
                open(os.path.join(extracted, "uv"), "wb").close()
            elif "python" in args and "install" in args:
                assert args[2] == mineru_mod.MINERU_PYTHON_VERSION
                idx = args.index("--install-dir") if "--install-dir" in args else None
                py_dir = args[idx + 1] if idx is not None else os.path.join(cwd, "runtime", "python")
                _make_executable(os.path.join(py_dir, "3.12", "bin", "python3.12"))
            elif "venv" in args:
                venv = args[-1]
                _make_executable(os.path.join(venv, "bin", "python"))
            elif args and args[0].endswith("model_installer.py"):
                with open(args[2], "w") as fh:
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


def _worker_script_path() -> str:
    from refora_server.server.lifespan import _mineru_worker_path

    return _mineru_worker_path()


def test_mineru_worker_script_exists_and_resolves():
    path = _worker_script_path()
    assert os.path.isfile(path), f"MinerU worker script not found: {path}"


def test_mineru_worker_script_protocol_constants():
    import importlib.util

    path = _worker_script_path()
    assert os.path.isfile(path), f"MinerU worker script not found: {path}"
    spec = importlib.util.spec_from_file_location("mineru_worker_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.PROTOCOL_VERSION == 1
    assert module.PROCESSING_WINDOW_SIZE == 1
    assert callable(module.handle)
    assert callable(module.parse_document)


def test_mineru_worker_maps_page_progress_into_parse_range():
    import importlib.util

    path = _worker_script_path()
    spec = importlib.util.spec_from_file_location("mineru_worker_progress", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.parsing_progress(0, 20) == 0.05
    assert module.parsing_progress(10, 20) == pytest.approx(0.475)
    assert module.parsing_progress(20, 20) == 0.9
    assert module.parsing_progress(0, 0) is None


def test_mineru_worker_forwards_processing_pages_updates():
    import importlib.util

    path = _worker_script_path()
    spec = importlib.util.spec_from_file_location("mineru_worker_tqdm", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    updates = []

    class FakeTqdm:
        def __init__(self, *args, **kwargs):
            self.n = 0
            self.total = kwargs.get("total")

        def update(self, amount=1):
            self.n += amount
            return True

    progress_tqdm = module.create_progress_tqdm(
        FakeTqdm,
        lambda current, total: updates.append((current, total)),
    )
    pages = progress_tqdm(total=12, desc="Processing pages")
    other = progress_tqdm(total=12, desc="OCR-det")

    pages.update(4)
    other.update(4)
    pages.update(4)

    assert updates == [(4, 12), (8, 12)]


def test_mineru_worker_handle_rejects_unknown_methods():
    import importlib.util

    path = _worker_script_path()
    spec = importlib.util.spec_from_file_location("mineru_worker_unknown", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with pytest.raises(ValueError, match="Unsupported worker method"):
        module.handle({"id": "req-1", "method": "bogus"})
