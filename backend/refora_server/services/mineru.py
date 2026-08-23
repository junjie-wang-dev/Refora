from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import shutil
import signal
import stat
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from refora_server.ocr.paths import safe_makedirs, sha256_file
from refora_server.ocr.types import (
    MINERU_VERSION,
    MINERU_WORKER_PROTOCOL_VERSION,
    MineruEngineState,
    MineruInstallStage,
)

UV_VERSION = "0.11.16"
MINERU_PYTHON_VERSION = "3.12.13"
UV_RELEASES: dict[str, dict[str, str]] = {
    "arm64": {
        "archive": "uv-aarch64-apple-darwin.tar.gz",
        "sha256": "2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb",
    },
    "x64": {
        "archive": "uv-x86_64-apple-darwin.tar.gz",
        "sha256": "6b91ae3de155f51bd1f5b74814821c79f016a176561f252cd9ddfb976939af2e",
    },
}

_MAX_STDIO_BYTES = 2_000_000
_RUN_FILE_TIMEOUT_SECONDS = 2 * 60 * 60
_PROCESS_TERMINATE_GRACE_SECONDS = 5
_ARCHIVE_TIMEOUT_SECONDS = 2 * 60
_PYTHON_INSTALL_TIMEOUT_SECONDS = 30 * 60
_VENV_TIMEOUT_SECONDS = 5 * 60
_PACKAGE_INSTALL_TIMEOUT_SECONDS = 60 * 60
_MODEL_DOWNLOAD_TIMEOUT_SECONDS = 2 * 60 * 60
_HEALTH_CHECK_TIMEOUT_SECONDS = 60


def _runtime_resource_path(name: str) -> str:
    path = Path(__file__).resolve().parent.parent / "mineru_runtime" / name
    if not path.is_file():
        raise RuntimeError(f"MinerU runtime resource is missing: {name}")
    return str(path)


def _resource_sha256(name: str) -> str:
    digest = hashlib.sha256()
    with open(_runtime_resource_path(name), "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def now_ms() -> int:
    return int(time.time() * 1000)


def _detect_architecture() -> str:
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "arm64"
    return "x64"


def _is_within(parent: str, candidate: str) -> bool:
    rel = os.path.relpath(candidate, parent)
    if rel == "":
        return True
    if rel == "..":
        return False
    return not rel.startswith(".." + os.sep) and not os.path.isabs(rel)


def _is_symlink(path: str) -> bool:
    try:
        return stat.S_ISLNK(os.lstat(path).st_mode)
    except OSError:
        return False


def _is_dir(path: str) -> bool:
    try:
        return stat.S_ISDIR(os.stat(path).st_mode)
    except OSError:
        return False


def _is_regular_file(path: str) -> bool:
    try:
        return stat.S_ISREG(os.stat(path).st_mode)
    except OSError:
        return False


def _is_executable(path: str) -> bool:
    try:
        st = os.stat(path)
    except OSError:
        return False
    return bool(st.st_mode & stat.S_IXUSR)


def _path_exists(path: str) -> bool:
    try:
        os.lstat(path)
        return True
    except OSError:
        return False


class DownloadFileFn(Protocol):
    def __call__(
        self,
        url: str,
        destination: str,
        cancel_event: asyncio.Event,
        on_progress: Callable[[int, int | None], None],
    ) -> Awaitable[None]: ...


class TrashItemFn(Protocol):
    def __call__(self, path: str) -> Awaitable[None]: ...


@dataclass
class MineruEngineManagerDeps:
    userDataDir: str
    downloadFile: DownloadFileFn
    trashItem: TrashItemFn
    environment: dict[str, str] | None = None
    architecture: str | None = None
    emitProgress: Callable[[MineruInstallProgress], None] | None = None
    readInstallRoot: Callable[[str], str] | None = None
    writeInstallRoot: Callable[[str, str], None] | None = None


@dataclass
class MineruInstallProgress:
    installId: str
    startedAt: int
    stage: MineruInstallStage
    currentArtifact: str | None = None
    bytesReceived: int = 0
    bytesTotal: int | None = None
    percent: float | None = None
    cancellable: bool = True
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "installId": self.installId,
            "startedAt": self.startedAt,
            "stage": self.stage,
            "currentArtifact": self.currentArtifact,
            "bytesReceived": self.bytesReceived,
            "bytesTotal": self.bytesTotal,
            "percent": self.percent,
            "cancellable": self.cancellable,
            "message": self.message,
        }


@dataclass
class MineruEngineStatus:
    state: MineruEngineState
    installRoot: str
    installPath: str | None
    version: str | None
    architecture: str
    pythonPath: str | None
    modelConfigPath: str | None
    installedAt: int | None
    diskBytes: int | None
    error: str | None
    progress: MineruInstallProgress | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "installRoot": self.installRoot,
            "installPath": self.installPath,
            "version": self.version,
            "architecture": self.architecture,
            "pythonPath": self.pythonPath,
            "modelConfigPath": self.modelConfigPath,
            "installedAt": self.installedAt,
            "diskBytes": self.diskBytes,
            "error": self.error,
            "progress": self.progress.to_dict() if self.progress is not None else None,
        }


@dataclass
class MineruInstallManifest:
    version: str
    architecture: str
    pythonRelativePath: str
    modelConfigRelativePath: str
    modelRevision: str
    runtimeLockSha256: str
    modelManifestSha256: str
    installedAt: int
    diskBytes: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "architecture": self.architecture,
            "pythonRelativePath": self.pythonRelativePath,
            "modelConfigRelativePath": self.modelConfigRelativePath,
            "modelRevision": self.modelRevision,
            "runtimeLockSha256": self.runtimeLockSha256,
            "modelManifestSha256": self.modelManifestSha256,
            "installedAt": self.installedAt,
            "diskBytes": self.diskBytes,
        }


@dataclass
class MineruRuntime:
    installPath: str
    pythonPath: str
    modelConfigPath: str
    modelRevision: str
    environment: dict[str, str]


def _prefs_path(user_data_dir: str) -> str:
    return os.path.join(user_data_dir, "refora-prefs.json")


def read_mineru_install_root(user_data_dir: str) -> str:
    p = _prefs_path(user_data_dir)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        value = data.get("mineruInstallRoot") if isinstance(data, dict) else None
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def write_mineru_install_root(user_data_dir: str, folder: str) -> None:
    p = _prefs_path(user_data_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    data: dict[str, Any] = {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, ValueError):
        pass
    data["mineruInstallRoot"] = folder
    tmp = f"{p}.tmp-{uuid.uuid4()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def _require_safe_managed_path(root: str, target: str) -> None:
    resolved_root = os.path.realpath(os.path.abspath(root))
    resolved_target = os.path.realpath(os.path.abspath(target))
    if not _is_within(resolved_root, resolved_target):
        raise RuntimeError("MinerU managed path is outside the install root")
    segments = [s for s in os.path.relpath(resolved_target, resolved_root).split(os.sep) if s]
    current = resolved_root
    for index, segment in enumerate(segments):
        current = os.path.join(current, segment)
        try:
            entry = os.lstat(current)
        except FileNotFoundError:
            break
        except OSError:
            break
        if stat.S_ISLNK(entry.st_mode):
            raise RuntimeError("MinerU managed directories cannot be symbolic links")
        if index < len(segments) - 1 and not stat.S_ISDIR(entry.st_mode):
            raise RuntimeError("MinerU managed path contains a non-directory entry")


async def _run_file(
    command: str,
    args: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    cancel_event: asyncio.Event,
    on_child: Callable[[asyncio.subprocess.Process | None], None],
    timeout_seconds: float = _RUN_FILE_TIMEOUT_SECONDS,
) -> str:
    try:
        child = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        raise RuntimeError(f"Failed to start {command}: {error}") from error
    on_child(child)

    async def _read_stream(stream: asyncio.StreamReader) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = await stream.read(64 * 1024)
            if not chunk:
                break
            remaining = _MAX_STDIO_BYTES - total
            if remaining > 0:
                kept = chunk[:remaining]
                chunks.append(kept)
                total += len(kept)
        return b"".join(chunks)

    async def _terminate_child() -> None:
        if child.returncode is not None:
            return
        try:
            if child.pid:
                os.killpg(os.getpgid(child.pid), signal_terminate())
        except ProcessLookupError:
            return
        except OSError:
            try:
                child.terminate()
            except ProcessLookupError:
                return
        try:
            await asyncio.wait_for(
                asyncio.shield(child.wait()),
                timeout=_PROCESS_TERMINATE_GRACE_SECONDS,
            )
        except TimeoutError:
            try:
                if child.pid:
                    os.killpg(os.getpgid(child.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
            await child.wait()

    cancel_task = asyncio.ensure_future(cancel_event.wait())
    stdout_task = asyncio.ensure_future(_read_stream(child.stdout))
    stderr_task = asyncio.ensure_future(_read_stream(child.stderr))
    wait_task = asyncio.ensure_future(child.wait())

    timed_out = False
    try:
        done, _ = await asyncio.wait(
            {wait_task, cancel_task},
            timeout=timeout_seconds,
            return_when=asyncio.FIRST_COMPLETED,
        )
        timed_out = not done
        if cancel_event.is_set() or timed_out:
            await _terminate_child()
        await wait_task
        stdout_bytes, stderr_bytes = await asyncio.gather(stdout_task, stderr_task)
        if cancel_event.is_set():
            raise RuntimeError("MinerU installation was cancelled")
        if timed_out:
            raise RuntimeError(
                f"MinerU installation command timed out after {timeout_seconds:g} seconds"
            )
    except BaseException:
        await _terminate_child()
        await asyncio.gather(
            stdout_task,
            stderr_task,
            wait_task,
            return_exceptions=True,
        )
        raise
    finally:
        cancel_task.cancel()
        await asyncio.gather(cancel_task, return_exceptions=True)
        on_child(None)

    code = child.returncode
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    if code != 0:
        message = stderr.strip() or stdout.strip() or f"Process exited with {code}"
        raise RuntimeError(message)
    return "\n".join([p for p in (stdout, stderr) if p]).strip()


def signal_terminate() -> int:
    return signal.SIGTERM


async def _managed_python(root: str) -> str | None:
    try:
        entries = sorted(os.listdir(root), reverse=True)
    except OSError:
        return None
    for entry in entries:
        candidate_dir = os.path.join(root, entry, "bin")
        if not os.path.isdir(candidate_dir):
            continue
        for name in ("python3.12", "python3", "python"):
            candidate = os.path.join(candidate_dir, name)
            if _is_executable(candidate):
                return candidate
    return None


ProgressListener = Callable[[MineruInstallProgress], None]


def create_mineru_engine_manager(deps: MineruEngineManagerDeps):
    architecture = deps.architecture or _detect_architecture()
    runtime_project_path = os.path.dirname(_runtime_resource_path("pyproject.toml"))
    runtime_lock_sha256 = _resource_sha256("uv.lock")
    model_manifest_path = _runtime_resource_path("model-manifest.json")
    model_manifest_sha256 = _resource_sha256("model-manifest.json")
    model_installer_path = _runtime_resource_path("model_installer.py")
    listeners: set[ProgressListener] = set()
    state: dict[str, Any] = {
        "progress": None,
        "install_task": None,
        "cancel_event": None,
        "active_child": None,
        "install_started_at": None,
        "last_error": None,
    }
    env_base: dict[str, str] = dict(os.environ if deps.environment is None else deps.environment)

    def _read_install_root() -> str:
        reader = deps.readInstallRoot or read_mineru_install_root
        return reader(deps.userDataDir) or os.path.join(deps.userDataDir, "engines")

    def _write_install_root(folder: str) -> None:
        writer = deps.writeInstallRoot or write_mineru_install_root
        writer(deps.userDataDir, folder)

    def _install_path() -> str:
        return os.path.join(
            _read_install_root(),
            "Refora",
            "MinerU",
            MINERU_VERSION,
            f"darwin-{architecture}",
        )

    def _manifest_path() -> str:
        return os.path.join(_install_path(), "installed-manifest.json")

    def _emit(
        install_id: str,
        stage: MineruInstallStage,
        message: str,
        percent: float | None,
        **extra: Any,
    ) -> None:
        progress = MineruInstallProgress(
            installId=install_id,
            startedAt=state["install_started_at"] or now_ms(),
            stage=stage,
            currentArtifact=extra.get("currentArtifact"),
            bytesReceived=extra.get("bytesReceived", 0),
            bytesTotal=extra.get("bytesTotal"),
            percent=percent,
            cancellable=stage != "completed",
            message=message,
        )
        state["progress"] = progress
        if deps.emitProgress is not None:
            deps.emitProgress(progress)
        for listener in list(listeners):
            listener(progress)

    async def _read_manifest() -> MineruInstallManifest | None:
        try:
            with open(_manifest_path(), "r", encoding="utf-8") as fh:
                parsed = json.load(fh)
        except (OSError, ValueError):
            return None
        if not isinstance(parsed, dict):
            return None
        if (
            parsed.get("version") != MINERU_VERSION
            or parsed.get("architecture") != architecture
            or not parsed.get("pythonRelativePath")
            or not parsed.get("modelConfigRelativePath")
            or parsed.get("runtimeLockSha256") != runtime_lock_sha256
            or parsed.get("modelManifestSha256") != model_manifest_sha256
        ):
            return None
        try:
            return MineruInstallManifest(
                version=parsed["version"],
                architecture=parsed["architecture"],
                pythonRelativePath=parsed["pythonRelativePath"],
                modelConfigRelativePath=parsed["modelConfigRelativePath"],
                modelRevision=parsed.get("modelRevision", ""),
                runtimeLockSha256=parsed["runtimeLockSha256"],
                modelManifestSha256=parsed["modelManifestSha256"],
                installedAt=int(parsed.get("installedAt", 0)),
                diskBytes=parsed.get("diskBytes"),
            )
        except (KeyError, TypeError, ValueError):
            return None

    async def _get_status() -> MineruEngineStatus:
        root = _read_install_root()
        path = _install_path()
        if state["install_task"] is not None and state["progress"] is not None:
            return MineruEngineStatus(
                state="installing",
                installRoot=root,
                installPath=path,
                version=MINERU_VERSION,
                architecture=architecture,
                pythonPath=None,
                modelConfigPath=None,
                installedAt=None,
                diskBytes=None,
                error=None,
                progress=state["progress"],
            )
        try:
            _require_safe_managed_path(root, path)
        except RuntimeError as error:
            return MineruEngineStatus(
                state="invalid",
                installRoot=root,
                installPath=path,
                version=None,
                architecture=architecture,
                pythonPath=None,
                modelConfigPath=None,
                installedAt=None,
                diskBytes=None,
                error=str(error),
                progress=None,
            )
        manifest = await _read_manifest()
        if manifest is None:
            path_exists = _path_exists(path)
            return MineruEngineStatus(
                state="invalid" if path_exists else "notInstalled",
                installRoot=root,
                installPath=path if path_exists else None,
                version=None,
                architecture=architecture,
                pythonPath=None,
                modelConfigPath=None,
                installedAt=None,
                diskBytes=None,
                error=(
                    "MinerU installation is incomplete or invalid"
                    if path_exists
                    else state["last_error"]
                ),
                progress=None,
            )
        python_path = os.path.join(path, manifest.pythonRelativePath)
        model_config_path = os.path.join(path, manifest.modelConfigRelativePath)
        if not _is_executable(python_path) or not _is_regular_file(model_config_path):
            return MineruEngineStatus(
                state="invalid",
                installRoot=root,
                installPath=path,
                version=manifest.version,
                architecture=architecture,
                pythonPath=None,
                modelConfigPath=None,
                installedAt=manifest.installedAt,
                diskBytes=manifest.diskBytes,
                error="MinerU runtime or model configuration is missing",
                progress=None,
            )
        return MineruEngineStatus(
            state="installed",
            installRoot=root,
            installPath=path,
            version=manifest.version,
            architecture=architecture,
            pythonPath=python_path,
            modelConfigPath=model_config_path,
            installedAt=manifest.installedAt,
            diskBytes=manifest.diskBytes,
            error=None,
            progress=None,
        )

    def _install_environment(path: str) -> dict[str, str]:
        home = os.path.join(path, "home")
        return {
            **env_base,
            "PATH": "/usr/bin:/bin",
            "HOME": home,
            "UV_CACHE_DIR": os.path.join(path, "cache", "uv"),
            "UV_PYTHON_INSTALL_DIR": os.path.join(path, "runtime", "python"),
            "HF_HOME": os.path.join(path, "models", "huggingface"),
            "MODELSCOPE_CACHE": os.path.join(path, "models", "modelscope"),
            "MINERU_TOOLS_CONFIG_JSON": os.path.join(path, "mineru.json"),
        }

    async def _set_install_root(folder: str) -> MineruEngineStatus:
        if state["install_task"] is not None:
            raise RuntimeError("Cannot change the install path while MinerU is installing")
        if not folder or not os.path.isabs(folder):
            raise RuntimeError("MinerU install path must be absolute")
        resolved = os.path.normpath(os.path.abspath(folder))
        safe_makedirs(resolved)
        if _is_symlink(resolved) or not _is_dir(resolved):
            raise RuntimeError("MinerU install path must be a regular directory")
        if not os.access(resolved, os.W_OK):
            raise RuntimeError("MinerU install path must be writable")
        current = await _get_status()
        if current.state == "installed" and current.installRoot != resolved:
            raise RuntimeError("Uninstall MinerU before changing its install path")
        _write_install_root(resolved)
        state["last_error"] = None
        return await _get_status()

    async def _install(install_root: str | None = None) -> MineruEngineStatus:
        if state["install_task"] is not None:
            await state["install_task"]
            return await _get_status()
        if install_root is not None:
            await _set_install_root(install_root)

        async def _run() -> MineruEngineStatus:
            existing = await _get_status()
            if existing.state == "installed":
                return existing
            install_id = str(uuid.uuid4())
            cancel_event = asyncio.Event()
            state["install_started_at"] = now_ms()
            state["cancel_event"] = cancel_event
            path = _install_path()
            release = UV_RELEASES[architecture]
            environment = _install_environment(path)
            archive = os.path.join(path, ".downloads", release["archive"])
            extracted = os.path.join(path, ".downloads", "uv-extracted")
            state["last_error"] = None
            try:
                _emit(install_id, "preparing", "Preparing the MinerU installation", None)
                _require_safe_managed_path(_read_install_root(), path)
                if _path_exists(path):
                    await deps.trashItem(path)
                safe_makedirs(os.path.join(path, ".downloads"))
                safe_makedirs(os.path.join(path, "home"))
                safe_makedirs(os.path.join(path, "models"))
                safe_makedirs(os.path.join(path, "cache"))
                _emit(
                    install_id,
                    "installingTools",
                    "Downloading the verified uv runtime",
                    0,
                    currentArtifact=release["archive"],
                )

                def _on_download(received: int, total: int | None) -> None:
                    ratio = (min(received / total, 1) if total else None)
                    _emit(
                        install_id,
                        "installingTools",
                        "Downloading the verified uv runtime",
                        None if ratio is None else ratio * 100,
                        currentArtifact=release["archive"],
                        bytesReceived=received,
                        bytesTotal=total,
                    )

                await deps.downloadFile(
                    f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{release['archive']}",
                    archive,
                    cancel_event,
                    _on_download,
                )
                if (await _sha256(archive)) != release["sha256"]:
                    raise RuntimeError("Downloaded uv runtime failed checksum verification")
                safe_makedirs(extracted)
                await _run_file(
                    "/usr/bin/tar",
                    ["-xzf", archive, "--strip-components", "1", "-C", extracted],
                    cwd=path,
                    env={"PATH": "/usr/bin:/bin"},
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_ARCHIVE_TIMEOUT_SECONDS,
                )
                uv_path = os.path.join(path, "runtime", "uv")
                safe_makedirs(os.path.join(path, "runtime"))
                os.chmod(os.path.join(extracted, "uv"), 0o755)
                os.replace(os.path.join(extracted, "uv"), uv_path)
                _emit(
                    install_id,
                    "installingPython",
                    f"Installing managed Python {MINERU_PYTHON_VERSION}",
                    None,
                    currentArtifact=f"Python {MINERU_PYTHON_VERSION}",
                )
                await _run_file(
                    uv_path,
                    ["python", "install", MINERU_PYTHON_VERSION, "--install-dir", os.path.join(path, "runtime", "python")],
                    cwd=path,
                    env=environment,
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_PYTHON_INSTALL_TIMEOUT_SECONDS,
                )
                python_bin = await _managed_python(os.path.join(path, "runtime", "python"))
                if not python_bin:
                    raise RuntimeError("Managed Python installation did not produce an executable")
                venv = os.path.join(path, "runtime", "venv")
                await _run_file(
                    uv_path,
                    ["venv", "--python", python_bin, venv],
                    cwd=path,
                    env=environment,
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_VENV_TIMEOUT_SECONDS,
                )
                venv_python = os.path.join(venv, "bin", "python")
                mineru_extra = "all" if architecture == "arm64" else "core"
                _emit(
                    install_id,
                    "installingMineru",
                    f"Installing MinerU {MINERU_VERSION}",
                    None,
                    currentArtifact=f"mineru[{mineru_extra}]=={MINERU_VERSION}",
                )
                await _run_file(
                    uv_path,
                    [
                        "sync",
                        "--project",
                        runtime_project_path,
                        "--locked",
                        "--no-dev",
                        "--no-install-project",
                        "--active",
                        "--extra",
                        architecture,
                    ],
                    cwd=path,
                    env={
                        **environment,
                        "VIRTUAL_ENV": venv,
                        "UV_PROJECT_ENVIRONMENT": venv,
                    },
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_PACKAGE_INSTALL_TIMEOUT_SECONDS,
                )
                await _run_file(
                    uv_path,
                    ["pip", "check", "--python", venv_python],
                    cwd=path,
                    env=environment,
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_HEALTH_CHECK_TIMEOUT_SECONDS,
                )
                _emit(
                    install_id,
                    "downloadingModels",
                    "Downloading MinerU models",
                    None,
                    currentArtifact="MinerU models",
                )
                await _run_file(
                    venv_python,
                    [model_installer_path, model_manifest_path, os.path.join(path, "mineru.json")],
                    cwd=path,
                    env=environment,
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_MODEL_DOWNLOAD_TIMEOUT_SECONDS,
                )
                _emit(install_id, "healthCheck", "Checking the MinerU runtime", None)
                output = await _run_file(
                    venv_python,
                    ["-c", "from mineru.version import __version__; print(__version__)"],
                    cwd=path,
                    env=environment,
                    cancel_event=cancel_event,
                    on_child=_on_child,
                    timeout_seconds=_HEALTH_CHECK_TIMEOUT_SECONDS,
                )
                if MINERU_VERSION not in output.split():
                    raise RuntimeError(f"Installed MinerU reported an unexpected version: {output}")
                config_path = os.path.join(path, "mineru.json")
                if not _is_regular_file(config_path):
                    raise RuntimeError("MinerU model download did not create a model configuration")
                _emit(install_id, "finalizing", "Finalizing the MinerU installation", None)
                manifest = MineruInstallManifest(
                    version=MINERU_VERSION,
                    architecture=architecture,
                    pythonRelativePath="runtime/venv/bin/python",
                    modelConfigRelativePath="mineru.json",
                    modelRevision=f"sha256:{model_manifest_sha256}",
                    runtimeLockSha256=runtime_lock_sha256,
                    modelManifestSha256=model_manifest_sha256,
                    installedAt=now_ms(),
                    diskBytes=None,
                )
                temporary_manifest = f"{_manifest_path()}.tmp-{uuid.uuid4()}"
                with open(temporary_manifest, "w", encoding="utf-8") as fh:
                    json.dump(manifest.to_dict(), fh, indent=2)
                try:
                    os.chmod(temporary_manifest, 0o600)
                except OSError:
                    pass
                os.replace(temporary_manifest, _manifest_path())
                shutil.rmtree(os.path.join(path, ".downloads"), ignore_errors=True)
                _emit(install_id, "completed", "MinerU is ready", 100, cancellable=False)
                state["progress"] = None
                return await _get_status()
            except Exception as error:
                state["last_error"] = (
                    None if cancel_event.is_set() else str(error) or error.__class__.__name__
                )
                try:
                    _require_safe_managed_path(_read_install_root(), path)
                    shutil.rmtree(path, ignore_errors=True)
                except Exception:
                    pass
                raise
            finally:
                state["active_child"] = None
                state["cancel_event"] = None

        def _on_child(child: asyncio.subprocess.Process | None) -> None:
            state["active_child"] = child

        task = asyncio.ensure_future(_run())
        state["install_task"] = task
        try:
            return await task
        finally:
            state["install_task"] = None
            state["progress"] = None
            state["install_started_at"] = None

    async def _cancel_install() -> MineruEngineStatus:
        cancel_event: asyncio.Event | None = state["cancel_event"]
        if cancel_event is None:
            return await _get_status()
        cancel_event.set()
        child = state["active_child"]
        if child is not None and child.returncode is None:
            try:
                os.killpg(os.getpgid(child.pid), signal_terminate())
            except (ProcessLookupError, OSError):
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass
        task = state["install_task"]
        if task is not None:
            try:
                await task
            except Exception:
                pass
        return await _get_status()

    async def _uninstall() -> MineruEngineStatus:
        if state["install_task"] is not None:
            raise RuntimeError("Cancel the active MinerU installation before uninstalling")
        path = _install_path()
        _require_safe_managed_path(_read_install_root(), path)
        if _path_exists(path):
            await deps.trashItem(path)
        state["last_error"] = None
        return await _get_status()

    def _on_progress(listener: ProgressListener) -> Callable[[], None]:
        listeners.add(listener)

        def _unlisten() -> None:
            listeners.discard(listener)

        return _unlisten

    async def _get_runtime() -> MineruRuntime:
        status = await _get_status()
        if (
            status.state != "installed"
            or not status.installPath
            or not status.pythonPath
            or not status.modelConfigPath
        ):
            raise RuntimeError("MinerU is not installed")
        manifest = await _read_manifest()
        if manifest is None:
            raise RuntimeError("MinerU installation manifest is invalid")
        _require_safe_managed_path(status.installRoot, status.installPath)
        env = _install_environment(status.installPath)
        env["MINERU_MODEL_SOURCE"] = "local"
        return MineruRuntime(
            installPath=status.installPath,
            pythonPath=status.pythonPath,
            modelConfigPath=status.modelConfigPath,
            modelRevision=manifest.modelRevision,
            environment=env,
        )

    def _destroy() -> None:
        cancel_event = state["cancel_event"]
        if cancel_event is not None:
            cancel_event.set()
        child = state["active_child"]
        if child is not None and child.returncode is None:
            try:
                os.killpg(os.getpgid(child.pid), signal_terminate())
            except (ProcessLookupError, OSError):
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass
        state["active_child"] = None
        listeners.clear()

    async def _sha256(path: str) -> str:
        return await asyncio.to_thread(sha256_file, path)

    return {
        "getStatus": _get_status,
        "status": _get_status,
        "install": _install,
        "cancelInstall": _cancel_install,
        "uninstall": _uninstall,
        "setInstallRoot": _set_install_root,
        "onProgress": _on_progress,
        "getRuntime": _get_runtime,
        "destroy": _destroy,
    }


MineruEngineManager = dict[str, Any]
MineruStatus = MineruEngineStatus


@dataclass
class WorkerProgress:
    stage: str
    progress: float | None = None


@dataclass
class ParseResult:
    markdown: str
    blocks: str
    middle: str
    assets: str | None
    pageCount: int | None
    blockCount: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "markdown": self.markdown,
            "blocks": self.blocks,
            "middle": self.middle,
            "assets": self.assets,
            "pageCount": self.pageCount,
            "blockCount": self.blockCount,
        }


@dataclass
class MineruWorkerProcessDeps:
    engineManager: MineruEngineManager
    workerScriptPath: str
    idleTimeoutMs: int = 5 * 60 * 1000
    requestTimeoutMs: int = 2 * 60 * 60 * 1000
    terminateGraceMs: int = 5_000


def create_mineru_worker_process(deps: MineruWorkerProcessDeps):
    idle_timeout_ms = deps.idleTimeoutMs
    request_timeout_ms = deps.requestTimeoutMs
    terminate_grace_seconds = max(deps.terminateGraceMs, 0) / 1000
    state: dict[str, Any] = {
        "child": None,
        "startup": None,
        "idle_handle": None,
        "active_parse_id": None,
        "parse_in_flight": False,
        "cancel_requested": False,
        "stopping": False,
        "destroyed": False,
        "pending": {},
        "reader_task": None,
        "stderr_task": None,
        "termination_task": None,
    }

    def _clear_idle() -> None:
        handle = state["idle_handle"]
        if handle is not None:
            handle.cancel()
            state["idle_handle"] = None

    def _reject_pending(error: Exception) -> None:
        pending: dict[str, Any] = state["pending"]
        for request in list(pending.values()):
            request["timer"].cancel()
            request["reject"](error)
        pending.clear()
        state["active_parse_id"] = None

    def _signal_child(
        child: asyncio.subprocess.Process, term_signal: int
    ) -> None:
        try:
            os.killpg(os.getpgid(child.pid), term_signal)
        except (ProcessLookupError, OSError):
            try:
                child.send_signal(term_signal)
            except (ProcessLookupError, OSError):
                pass

    async def _clear_io_tasks() -> None:
        tasks = [
            task
            for task in (state["reader_task"], state["stderr_task"])
            if isinstance(task, asyncio.Task)
        ]
        state["reader_task"] = None
        state["stderr_task"] = None
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _terminate_and_reap(
        child: asyncio.subprocess.Process,
    ) -> None:
        wait_task = asyncio.ensure_future(child.wait())
        if child.returncode is None:
            _signal_child(child, signal.SIGTERM)
            done, _ = await asyncio.wait(
                {wait_task}, timeout=terminate_grace_seconds
            )
            if not done:
                _signal_child(child, signal.SIGKILL)
        await asyncio.gather(wait_task, return_exceptions=True)
        await _clear_io_tasks()
        if state["child"] is child:
            state["child"] = None

    def _begin_termination(error: Exception) -> asyncio.Task[Any]:
        existing = state["termination_task"]
        if isinstance(existing, asyncio.Task) and not existing.done():
            return existing

        async def terminate() -> None:
            state["stopping"] = True
            _reject_pending(error)
            child = state["child"]
            if child is not None:
                await _terminate_and_reap(child)
            else:
                await _clear_io_tasks()
            state["stopping"] = False

        task = asyncio.ensure_future(terminate())
        state["termination_task"] = task

        def clear(completed: asyncio.Task[Any]) -> None:
            if state["termination_task"] is completed:
                state["termination_task"] = None

        task.add_done_callback(clear)
        return task

    def _handle_message(message: dict[str, Any]) -> None:
        event = message.get("event")
        if event == "progress":
            request_id = message.get("requestId")
            if request_id:
                request = state["pending"].get(request_id)
                on_progress = request.get("onProgress") if request else None
                stage = message.get("stage")
                if on_progress and stage:
                    on_progress(WorkerProgress(stage=stage, progress=message.get("progress")))
            return
        msg_id = message.get("id")
        if not msg_id:
            return
        request = state["pending"].get(msg_id)
        if not request:
            return
        state["pending"].pop(msg_id, None)
        request["timer"].cancel()
        if state["active_parse_id"] == msg_id:
            state["active_parse_id"] = None
        error = message.get("error")
        if error:
            code = error.get("code") or "MineruWorkerError" if isinstance(error, dict) else "MineruWorkerError"
            message_text = (
                error.get("message") or "MinerU worker request failed"
                if isinstance(error, dict)
                else "MinerU worker request failed"
            )
            err = RuntimeError(message_text)
            err.name = code
            request["reject"](err)
            return
        request["resolve"](message.get("result"))

    async def _reader_loop(stream: asyncio.StreamReader) -> None:
        while True:
            try:
                line = await stream.readline()
            except Exception:
                break
            if not line:
                break
            try:
                message = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            if isinstance(message, dict):
                _handle_message(message)

    async def _start() -> None:
        if state["destroyed"]:
            raise RuntimeError("MinerU worker is unavailable")
        termination = state["termination_task"]
        if isinstance(termination, asyncio.Task):
            await asyncio.gather(termination, return_exceptions=True)
        if state["child"] is not None:
            return
        if state["startup"] is not None:
            await state["startup"]
            return

        async def _do_start() -> None:
            runtime = await deps.engineManager["getRuntime"]()
            if state["destroyed"]:
                raise RuntimeError("MinerU worker is unavailable")
            state["stopping"] = False
            spawned = await asyncio.create_subprocess_exec(
                runtime.pythonPath,
                "-u",
                deps.workerScriptPath,
                cwd=runtime.installPath,
                env=runtime.environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            state["child"] = spawned
            state["reader_task"] = asyncio.ensure_future(_reader_loop(spawned.stdout))

            async def _drain_stderr() -> None:
                assert spawned.stderr is not None
                while True:
                    try:
                        line = await spawned.stderr.readline()
                    except Exception:
                        break
                    if not line:
                        break

            state["stderr_task"] = asyncio.ensure_future(_drain_stderr())
            hello = await _send_request("hello", {}, 30_000)
            if (
                not isinstance(hello, dict)
                or hello.get("protocolVersion") != MINERU_WORKER_PROTOCOL_VERSION
                or hello.get("mineruVersion") != MINERU_VERSION
            ):
                await _begin_termination(
                    RuntimeError("MinerU worker protocol or version is incompatible")
                )
                raise RuntimeError("MinerU worker protocol or version is incompatible")

        startup = asyncio.ensure_future(_do_start())
        state["startup"] = startup
        try:
            await startup
        finally:
            state["startup"] = None

    def _send_request(
        method: str,
        params: dict[str, Any],
        timeout_ms: int | None = None,
        on_progress: Callable[[WorkerProgress], None] | None = None,
    ) -> asyncio.Future:
        loop = asyncio.get_event_loop()
        child: asyncio.subprocess.Process | None = state["child"]
        timeout = timeout_ms if timeout_ms is not None else request_timeout_ms
        future: asyncio.Future = loop.create_future()
        if child is None or child.stdin is None or child.stdin.is_closing():
            future.set_exception(RuntimeError("MinerU worker is unavailable"))
            return future
        request_id = str(uuid.uuid4())

        def _on_timeout() -> None:
            state["pending"].pop(request_id, None)
            if state["active_parse_id"] == request_id:
                state["active_parse_id"] = None
            if not future.done():
                future.set_exception(RuntimeError(f"MinerU worker request timed out: {method}"))
            _begin_termination(
                RuntimeError(f"MinerU worker request timed out: {method}")
            )

        timer = loop.call_later(timeout / 1000, _on_timeout)
        state["pending"][request_id] = {
            "resolve": future.set_result,
            "reject": future.set_exception,
            "onProgress": on_progress,
            "timer": timer,
        }
        payload = json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
        assert child.stdin is not None

        def _write_done(write_future: asyncio.Future) -> None:
            if write_future.cancelled() or write_future.exception() is None:
                return
            request = state["pending"].pop(request_id, None)
            if request is None:
                return
            request["timer"].cancel()
            if not future.done():
                future.set_exception(write_future.exception())

        write_future = asyncio.ensure_future(_write(child.stdin, payload))
        write_future.add_done_callback(_write_done)
        if method == "parse":
            state["active_parse_id"] = request_id
        return future

    async def _write(stream: asyncio.StreamWriter, payload: str) -> None:
        stream.write(payload.encode("utf-8"))
        await stream.drain()

    def _schedule_idle_shutdown() -> None:
        _clear_idle()
        loop = asyncio.get_event_loop()
        state["idle_handle"] = loop.call_later(idle_timeout_ms / 1000, _schedule_callback)

    def _schedule_callback() -> None:
        asyncio.ensure_future(_stop())

    async def _parse(
        input_path: str,
        output_path: str,
        profile: str,
        on_progress: Callable[[WorkerProgress], None],
    ) -> ParseResult:
        if state["parse_in_flight"]:
            raise RuntimeError("MinerU is already processing a document")
        state["parse_in_flight"] = True
        state["cancel_requested"] = False
        _clear_idle()
        try:
            await _start()
            if state["cancel_requested"]:
                await _stop()
                raise RuntimeError("MinerU conversion was cancelled")
            result = await _send_request(
                "parse",
                {"inputPath": input_path, "outputPath": output_path, "profile": profile, "language": "ch"},
                request_timeout_ms,
                on_progress,
            )
            if not isinstance(result, dict):
                raise RuntimeError("MinerU worker returned an invalid parse result")
            return ParseResult(
                markdown=result.get("markdown", ""),
                blocks=result.get("blocks", ""),
                middle=result.get("middle", ""),
                assets=result.get("assets"),
                pageCount=result.get("pageCount"),
                blockCount=int(result.get("blockCount", 0)),
            )
        finally:
            state["parse_in_flight"] = False
            state["cancel_requested"] = False
            if not state["destroyed"]:
                _schedule_idle_shutdown()

    async def _cancel() -> None:
        if not state["parse_in_flight"]:
            return
        state["cancel_requested"] = True
        await _begin_termination(RuntimeError("MinerU conversion was cancelled"))

    async def _stop() -> None:
        _clear_idle()
        child = state["child"]
        if child is None:
            termination = state["termination_task"]
            if isinstance(termination, asyncio.Task):
                await asyncio.gather(termination, return_exceptions=True)
            return
        state["stopping"] = True
        try:
            try:
                await asyncio.wait_for(
                    asyncio.shield(_send_request("shutdown", {}, 5_000)),
                    timeout=5.0,
                )
            except Exception:
                pass
        finally:
            await _begin_termination(RuntimeError("MinerU worker stopped"))

    async def _destroy() -> None:
        _clear_idle()
        state["destroyed"] = True
        state["cancel_requested"] = True
        await _begin_termination(RuntimeError("MinerU worker stopped"))

    return {
        "parse": _parse,
        "cancel": _cancel,
        "stop": _stop,
        "destroy": _destroy,
    }


MineruWorkerProcess = dict[str, Any]
createMineruEngineManager = create_mineru_engine_manager
createMineruWorkerProcess = create_mineru_worker_process


__all__ = [
    "MineruEngineManager",
    "MineruEngineManagerDeps",
    "MineruEngineStatus",
    "MineruStatus",
    "MineruInstallManifest",
    "MineruInstallProgress",
    "MineruRuntime",
    "MineruWorkerProcess",
    "MineruWorkerProcessDeps",
    "ParseResult",
    "WorkerProgress",
    "createMineruEngineManager",
    "createMineruWorkerProcess",
    "create_mineru_engine_manager",
    "create_mineru_worker_process",
    "read_mineru_install_root",
    "write_mineru_install_root",
]
