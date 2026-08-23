from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from refora_server.services.uv_artifact import (
    UV_RELEASES,
    UV_VERSION,
    normalize_macos_architecture,
    uv_download_url,
)

NODE_VERSION = "24.18.0"
PNPM_VERSION = "11.9.0"
NODE_RELEASES = {
    "arm64": {
        "archive": f"node-v{NODE_VERSION}-darwin-arm64.tar.gz",
        "sha256": "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    },
    "x64": {
        "archive": f"node-v{NODE_VERSION}-darwin-x64.tar.gz",
        "sha256": "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    },
}

MAX_PACKAGES = 20
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

_PYTHON_PACKAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_NODE_PACKAGE = re.compile(r"^(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9][A-Za-z0-9._-]*$")
_EXACT_VERSION = re.compile(r"^[0-9]+(?:\.[0-9A-Za-z-]+)+(?:[+._-][0-9A-Za-z.-]+)?$")

DownloadFile = Callable[[str, Path, threading.Event], None]
RunFile = Callable[[list[str], Path, dict[str, str], threading.Event], dict[str, Any]]


@dataclass(frozen=True)
class RuntimeManagerOptions:
    architecture: str | None = None
    download_file: DownloadFile | None = None
    python_executable: str | None = None
    node_executable: str | None = None
    uv_executable: str | None = None
    pnpm_executable: str | None = None
    discover_path: bool = True


@dataclass(frozen=True)
class RuntimePaths:
    sandbox_root: Path
    shared_root: Path
    runtime_root: Path
    uv_store: Path
    pnpm_store: Path
    environment_root: Path


@dataclass(frozen=True)
class RuntimeEnvironment:
    python_path: str | None
    node_path: str | None
    uv_path: str | None
    pnpm_path: str | None
    path: str


def detect_architecture(machine: str | None = None) -> str:
    return normalize_macos_architecture(machine)


def package_specs(requests: Any, *, kind: str) -> list[str]:
    if not isinstance(requests, list):
        raise ValueError(f"{kind} packages must be a list")
    pattern = _PYTHON_PACKAGE if kind == "python" else _NODE_PACKAGE
    specs: list[str] = []
    for request in requests:
        if not isinstance(request, dict):
            raise ValueError(f"Invalid {kind} package request")
        name = request.get("name")
        version = request.get("version")
        if not isinstance(name, str) or not pattern.fullmatch(name):
            raise ValueError(f"Invalid {kind} package name: {name}")
        if not isinstance(version, str) or not _EXACT_VERSION.fullmatch(version):
            raise ValueError(f"An exact version is required for {kind} package: {name}")
        specs.append(f"{name}=={version}" if kind == "python" else f"{name}@{version}")
    return specs


def runtime_paths(sandbox_root: str | Path, shared_root: str | Path) -> RuntimePaths:
    sandbox = Path(sandbox_root).expanduser().resolve()
    shared = Path(shared_root).expanduser().resolve()
    return RuntimePaths(
        sandbox_root=sandbox,
        shared_root=shared,
        runtime_root=shared / "runtimes",
        uv_store=shared / "stores" / "uv",
        pnpm_store=shared / "stores" / "pnpm",
        environment_root=sandbox / "env",
    )


def _default_download(url: str, destination: Path, cancel_event: threading.Event) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Refora/0.1"})
    received = 0
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        raw_total = response.headers.get("content-length")
        total = int(raw_total) if raw_total and raw_total.isdigit() else None
        if total is not None and total > MAX_DOWNLOAD_BYTES:
            raise RuntimeError("Runtime archive exceeds the download size limit")
        while True:
            if cancel_event.is_set():
                raise RuntimeError("Runtime installation was cancelled")
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_DOWNLOAD_BYTES:
                raise RuntimeError("Runtime archive exceeds the download size limit")
            output.write(chunk)
    os.chmod(destination, 0o600)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _extract_archive(archive: Path, destination: Path, *, strip_components: int) -> None:
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tarfile.open(archive, "r:gz") as source:
        members = []
        for member in source.getmembers():
            parts = Path(member.name).parts[strip_components:]
            if not parts:
                continue
            member.name = str(Path(*parts))
            members.append(member)
        source.extractall(destination, members=members, filter="data")


def _atomic_directory(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = destination.parent / f".{destination.name}.previous"
    if backup.exists() or backup.is_symlink():
        if backup.is_dir() and not backup.is_symlink():
            shutil.rmtree(backup)
        else:
            backup.unlink()
    if destination.exists() or destination.is_symlink():
        os.replace(destination, backup)
    try:
        os.replace(source, destination)
    except BaseException:
        if backup.exists() or backup.is_symlink():
            os.replace(backup, destination)
        raise
    if backup.exists() or backup.is_symlink():
        if backup.is_dir() and not backup.is_symlink():
            shutil.rmtree(backup)
        else:
            backup.unlink()


def _atomic_symlink(target: str, destination: Path) -> None:
    temporary = destination.parent / f".{destination.name}.next"
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, destination)


def _executable(path: str | Path | None) -> str | None:
    if not path:
        return None
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        resolved = shutil.which(str(candidate))
        if not resolved:
            return None
        candidate = Path(resolved)
    try:
        candidate = candidate.resolve()
    except OSError:
        return None
    return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None


def _version(executable: str, prefix: str) -> bool:
    try:
        result = subprocess.run(
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=5,
            check=False,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"},
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and result.stdout.strip().startswith(prefix)


def _managed_python_candidates(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    result: list[Path] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name, reverse=True):
        if not entry.is_dir() and not entry.is_symlink():
            continue
        result.extend(
            (
                entry / "bin" / "python3.12",
                entry / "bin" / "python3",
                entry / "bin" / "python",
            )
        )
    return result


class ManagedRuntimeManager:
    def __init__(
        self,
        options: RuntimeManagerOptions,
        run_file: RunFile,
    ) -> None:
        self._options = options
        self._architecture = detect_architecture(options.architecture)
        self._download = options.download_file or _default_download
        self._run_file = run_file
        self._install_lock = threading.Lock()
        self._version_cache: dict[tuple[str, str], bool] = {}

    @property
    def architecture(self) -> str:
        return self._architecture

    def _ensure_layout(self, paths: RuntimePaths) -> None:
        for directory in (
            paths.shared_root,
            paths.runtime_root / "python",
            paths.runtime_root / "node",
            paths.runtime_root / "tools",
            paths.uv_store,
            paths.pnpm_store,
            paths.environment_root,
        ):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        pyproject = paths.sandbox_root / "pyproject.toml"
        if not pyproject.exists():
            pyproject.write_text(
                '[project]\nname = "refora-agent-workspace"\nversion = "0.0.0"\n'
                'requires-python = ">=3.12,<3.13"\ndependencies = []\n',
                encoding="utf-8",
            )
            os.chmod(pyproject, 0o600)
        package_json = paths.sandbox_root / "package.json"
        if not package_json.exists():
            package_json.write_text(
                '{"name":"refora-agent-workspace","private":true,"version":"0.0.0"}\n',
                encoding="utf-8",
            )
            os.chmod(package_json, 0o600)

    def _compatible(self, candidates: list[str | Path], kind: str) -> str | None:
        prefix = "Python 3.12." if kind == "python" else "v24."
        for candidate in candidates:
            path = _executable(candidate)
            if not path:
                continue
            key = (kind, path)
            compatible = self._version_cache.get(key)
            if compatible is None:
                compatible = _version(path, prefix)
                self._version_cache[key] = compatible
            if compatible:
                return path
        return None

    def resolve(self, paths: RuntimePaths) -> RuntimeEnvironment:
        self._ensure_layout(paths)
        configured_python = self._options.python_executable or os.environ.get("REFORA_AGENT_PYTHON")
        configured_node = self._options.node_executable or os.environ.get("REFORA_AGENT_NODE")
        configured_uv = self._options.uv_executable or os.environ.get("REFORA_AGENT_UV")
        configured_pnpm = self._options.pnpm_executable or os.environ.get("REFORA_AGENT_PNPM")
        python = self._compatible(
            [
                paths.environment_root / "python" / "bin" / "python",
                configured_python or "",
                *_managed_python_candidates(paths.runtime_root / "python"),
                shutil.which("python3") if self._options.discover_path else "",
            ],
            "python",
        )
        node = self._compatible(
            [
                configured_node or "",
                paths.runtime_root / "node" / "current" / "bin" / "node",
                shutil.which("node") if self._options.discover_path else "",
            ],
            "node",
        )
        uv = next(
            (
                path
                for path in (
                    _executable(configured_uv),
                    _executable(paths.runtime_root / "tools" / "uv"),
                    _executable(shutil.which("uv")) if self._options.discover_path else None,
                )
                if path
            ),
            None,
        )
        pnpm = next(
            (
                path
                for path in (
                    _executable(configured_pnpm),
                    _executable(
                        paths.runtime_root
                        / "tools"
                        / "pnpm"
                        / "node_modules"
                        / "pnpm"
                        / "bin"
                        / "pnpm.cjs"
                    ),
                    _executable(shutil.which("pnpm")) if self._options.discover_path else None,
                )
                if path
            ),
            None,
        )
        binaries = [
            paths.environment_root / "python" / "bin",
            paths.sandbox_root / "node_modules" / ".bin",
            Path(python).parent if python else None,
            Path(node).parent if node else None,
            Path(uv).parent if uv else None,
            Path(pnpm).parent if pnpm else None,
            Path("/usr/bin"),
            Path("/bin"),
        ]
        path = ":".join(dict.fromkeys(str(item) for item in binaries if item))
        return RuntimeEnvironment(python, node, uv, pnpm, path)

    def _download_verified(
        self,
        url: str,
        destination: Path,
        expected_sha256: str,
        cancel_event: threading.Event,
    ) -> None:
        self._download(url, destination, cancel_event)
        actual = _sha256_file(destination)
        if actual != expected_sha256:
            raise RuntimeError(f"Runtime checksum mismatch for {url}")

    def _ensure_uv(self, paths: RuntimePaths, cancel_event: threading.Event) -> str:
        existing = _executable(paths.runtime_root / "tools" / "uv")
        if existing:
            return existing
        release = UV_RELEASES[self._architecture]
        paths.runtime_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".uv-install-", dir=paths.runtime_root) as raw:
            temporary = Path(raw)
            archive = temporary / release["archive"]
            extracted = temporary / "extracted"
            self._download_verified(
                uv_download_url(release),
                archive,
                release["sha256"],
                cancel_event,
            )
            _extract_archive(archive, extracted, strip_components=1)
            source = extracted / "uv"
            if not source.is_file():
                raise RuntimeError("Verified uv archive did not contain the uv executable")
            os.chmod(source, 0o755)
            destination = paths.runtime_root / "tools" / "uv"
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.replace(source, destination)
        return str(destination)

    def _ensure_node(self, paths: RuntimePaths, cancel_event: threading.Event) -> str:
        destination = paths.runtime_root / "node" / f"v{NODE_VERSION}"
        executable = destination / "bin" / "node"
        if not _executable(executable):
            release = NODE_RELEASES[self._architecture]
            paths.runtime_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(prefix=".node-install-", dir=paths.runtime_root) as raw:
                temporary = Path(raw)
                archive = temporary / release["archive"]
                extracted = temporary / "extracted"
                self._download_verified(
                    f"https://nodejs.org/download/release/v{NODE_VERSION}/{release['archive']}",
                    archive,
                    release["sha256"],
                    cancel_event,
                )
                _extract_archive(archive, extracted, strip_components=1)
                installed = extracted / "bin" / "node"
                if not installed.is_file():
                    raise RuntimeError("Verified Node archive did not contain the node executable")
                os.chmod(installed, 0o755)
                _atomic_directory(extracted, destination)
        current = paths.runtime_root / "node" / "current"
        current.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        _atomic_symlink(f"v{NODE_VERSION}", current)
        return str(current / "bin" / "node")

    def _ensure_python(
        self,
        paths: RuntimePaths,
        runtime: RuntimeEnvironment,
        cancel_event: threading.Event,
    ) -> str:
        if runtime.python_path:
            return runtime.python_path
        uv = runtime.uv_path or self._ensure_uv(paths, cancel_event)
        result = self._run_file(
            [
                uv,
                "python",
                "install",
                "3.12",
                "--install-dir",
                str(paths.runtime_root / "python"),
            ],
            paths.shared_root,
            {
                "PATH": "/usr/bin:/bin",
                "HOME": str(paths.shared_root),
                "UV_CACHE_DIR": str(paths.uv_store),
                "UV_PYTHON_INSTALL_DIR": str(paths.runtime_root / "python"),
            },
            cancel_event,
        )
        if result["status"] != "ok":
            raise RuntimeError(result["stderr"] or "Managed Python 3.12 installation failed")
        installed = self._compatible(_managed_python_candidates(paths.runtime_root / "python"), "python")
        if not installed:
            raise RuntimeError("Managed Python 3.12 installation did not produce an executable")
        return installed

    def _ensure_pnpm(
        self,
        paths: RuntimePaths,
        runtime: RuntimeEnvironment,
        cancel_event: threading.Event,
    ) -> str:
        if runtime.pnpm_path:
            return runtime.pnpm_path
        node = runtime.node_path or self._ensure_node(paths, cancel_event)
        npm = Path(node).parent / "npm"
        if not _executable(npm):
            raise RuntimeError("Managed Node.js installation did not contain npm")
        destination = paths.runtime_root / "tools" / "pnpm"
        with tempfile.TemporaryDirectory(prefix=".pnpm-install-", dir=paths.runtime_root) as raw:
            temporary = Path(raw)
            extracted = temporary / "pnpm"
            result = self._run_file(
                [
                    str(npm),
                    "install",
                    "--prefix",
                    str(extracted),
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--save-exact",
                    f"pnpm@{PNPM_VERSION}",
                ],
                paths.shared_root,
                {
                    "PATH": f"{Path(node).parent}:/usr/bin:/bin",
                    "HOME": str(paths.shared_root),
                    "npm_config_cache": str(paths.pnpm_store / "npm-cache"),
                    "npm_config_ignore_scripts": "true",
                },
                cancel_event,
            )
            if result["status"] != "ok":
                raise RuntimeError(result["stderr"] or "Managed pnpm installation failed")
            installed = extracted / "node_modules" / "pnpm" / "bin" / "pnpm.cjs"
            if not installed.is_file():
                raise RuntimeError("Managed pnpm installation did not produce pnpm.cjs")
            os.chmod(installed, 0o755)
            _atomic_directory(extracted, destination)
        return str(destination / "node_modules" / "pnpm" / "bin" / "pnpm.cjs")

    def install(
        self,
        workspace_id: str | None,
        args: dict[str, Any],
        paths: RuntimePaths,
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        python_specs = package_specs(args.get("python", []), kind="python")
        node_specs = package_specs(args.get("node", []), kind="node")
        if len(python_specs) + len(node_specs) > MAX_PACKAGES:
            raise ValueError(f"A maximum of {MAX_PACKAGES} packages can be installed at once")
        runtimes = args.get("runtimes", [])
        if not isinstance(runtimes, list) or any(item not in {"python", "node"} for item in runtimes):
            raise ValueError("Unsupported runtime was requested")
        requested_runtimes = list(dict.fromkeys(runtimes))
        if not requested_runtimes and not python_specs and not node_specs:
            raise ValueError("No runtimes or packages were requested")
        with self._install_lock:
            self._ensure_layout(paths)
            runtime = self.resolve(paths)
            if "python" in requested_runtimes or python_specs:
                self._ensure_python(paths, runtime, cancel_event)
            if ("node" in requested_runtimes or node_specs) and not runtime.node_path:
                self._ensure_node(paths, cancel_event)
            runtime = self.resolve(paths)
            if python_specs and not runtime.uv_path:
                self._ensure_uv(paths, cancel_event)
            if node_specs and not runtime.pnpm_path:
                self._ensure_pnpm(paths, runtime, cancel_event)
            runtime = self.resolve(paths)
            output: list[dict[str, Any]] = []
            workspace_env = {
                "PATH": runtime.path,
                "HOME": str(paths.sandbox_root / "work"),
                "TMPDIR": str(paths.sandbox_root / "tmp"),
                "UV_CACHE_DIR": str(paths.uv_store),
                "PNPM_STORE_DIR": str(paths.pnpm_store),
                "REFORA_SANDBOX": str(paths.sandbox_root),
                "REFORA_WORK": str(paths.sandbox_root / "work"),
                "REFORA_SCRIPTS": str(paths.sandbox_root / "scripts"),
                "REFORA_OUTPUTS": str(paths.sandbox_root / "outputs"),
            }
            if python_specs:
                if not runtime.python_path or not runtime.uv_path:
                    raise RuntimeError("Managed Python 3.12 and uv are unavailable")
                environment_python = paths.environment_root / "python" / "bin" / "python"
                if not environment_python.is_file():
                    created = self._run_file(
                        [
                            runtime.uv_path,
                            "--no-config",
                            "venv",
                            "--python",
                            runtime.python_path,
                            str(paths.environment_root / "python"),
                        ],
                        paths.sandbox_root,
                        {
                            **workspace_env,
                            "UV_PYTHON_INSTALL_DIR": str(paths.runtime_root / "python"),
                        },
                        cancel_event,
                    )
                    output.append(created)
                    if created["status"] != "ok":
                        return self._result(
                            created["status"],
                            workspace_id,
                            requested_runtimes,
                            python_specs,
                            node_specs,
                            output,
                        )
                installed = self._run_file(
                    [
                        runtime.uv_path,
                        "--no-config",
                        "pip",
                        "install",
                        "--python",
                        str(environment_python),
                        "--only-binary",
                        ":all:",
                        *python_specs,
                    ],
                    paths.sandbox_root,
                    {
                        **workspace_env,
                        "UV_PYTHON_INSTALL_DIR": str(paths.runtime_root / "python"),
                    },
                    cancel_event,
                )
                output.append(installed)
                if installed["status"] != "ok":
                    return self._result(
                        installed["status"],
                        workspace_id,
                        requested_runtimes,
                        python_specs,
                        node_specs,
                        output,
                    )
            if node_specs:
                if not runtime.node_path or not runtime.pnpm_path:
                    raise RuntimeError("Managed Node.js 24 and pnpm are unavailable")
                pnpm_argv = [runtime.pnpm_path]
                if runtime.pnpm_path.endswith((".cjs", ".js")):
                    pnpm_argv = [runtime.node_path, runtime.pnpm_path]
                installed = self._run_file(
                    [
                        *pnpm_argv,
                        "add",
                        "--save-exact",
                        "--ignore-scripts",
                        "--store-dir",
                        str(paths.pnpm_store),
                        *node_specs,
                    ],
                    paths.sandbox_root,
                    {
                        **workspace_env,
                        "PNPM_HOME": str(paths.runtime_root / "tools"),
                        "npm_config_ignore_scripts": "true",
                    },
                    cancel_event,
                )
                output.append(installed)
                if installed["status"] != "ok":
                    return self._result(
                        installed["status"],
                        workspace_id,
                        requested_runtimes,
                        python_specs,
                        node_specs,
                        output,
                    )
            return self._result(
                "ok",
                workspace_id,
                requested_runtimes,
                python_specs,
                node_specs,
                output,
            )

    @staticmethod
    def _result(
        status: str,
        workspace_id: str | None,
        runtimes: list[str],
        python: list[str],
        node: list[str],
        output: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "status": status,
            "workspaceId": workspace_id,
            "runtimes": runtimes,
            "python": python,
            "node": node,
            "output": output,
        }
