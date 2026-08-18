from __future__ import annotations

import json
import os
import shutil
import subprocess
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from refora_server.cli_runtime.types import (
    CliInvocation,
    CliModelInfo,
    CliRuntimeCapabilities,
    CliRuntimeInspection,
)


_CODEX_REASONING_EFFORTS = frozenset(
    {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
_CLI_SEARCH_DIRS = (
    ".local/bin",
    ".npm-global/bin",
    ".volta/bin",
    ".bun/bin",
    ".asdf/shims",
    "Library/pnpm",
)
_CLI_SEARCH_GLOBS = (
    ".nvm/versions/node/*/bin",
    ".fnm/node-versions/*/installation/bin",
    ".asdf/installs/nodejs/*/bin",
    ".local/share/mise/installs/node/*/bin",
)


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def _toml_array(values: list[str]) -> str:
    return "[" + ",".join(_toml_string(value) for value in values) + "]"


def _resolve_executable(value: str | None, default: str) -> str:
    candidate = value.strip() if isinstance(value, str) and value.strip() else default
    candidate = os.path.expanduser(candidate)
    if os.path.isabs(candidate):
        if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            raise RuntimeError(f"CLI executable is unavailable: {candidate}")
        return candidate
    resolved = shutil.which(candidate)
    if resolved is not None:
        return resolved
    home = Path.home()
    candidates = [home / directory / candidate for directory in _CLI_SEARCH_DIRS]
    candidates.extend(
        [
            Path("/opt/homebrew/bin") / candidate,
            Path("/usr/local/bin") / candidate,
            Path("/opt/local/bin") / candidate,
        ]
    )
    for pattern in _CLI_SEARCH_GLOBS:
        candidates.extend(path / candidate for path in home.glob(pattern))
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise RuntimeError(f"CLI executable was not found: {candidate}")


class CliRuntimeAdapter(ABC):
    id: str
    label: str
    default_executable: str
    reasoning_mode = "select"
    capabilities: CliRuntimeCapabilities

    def resolve_executable(self, configured: str | None) -> str:
        return _resolve_executable(configured, self.default_executable)

    @abstractmethod
    def inspect(self, executable_path: str | None) -> CliRuntimeInspection:
        raise NotImplementedError

    @abstractmethod
    def list_models(self, executable_path: str | None) -> list[CliModelInfo]:
        raise NotImplementedError

    @abstractmethod
    def build_invocation(
        self,
        profile: dict[str, Any],
        request: dict[str, Any],
        prompt: str,
        session_id: str | None,
        mcp: dict[str, Any] | None,
    ) -> CliInvocation:
        raise NotImplementedError

    @abstractmethod
    def parse_event(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        raise NotImplementedError

    def session_id(self, payload: dict[str, Any]) -> str | None:
        return None

    def result_text(self, payload: dict[str, Any]) -> str | None:
        return None


class CodexCliAdapter(CliRuntimeAdapter):
    id = "codex"
    label = "OpenAI Codex CLI"
    default_executable = "codex"
    capabilities = CliRuntimeCapabilities(
        native_web_search=True,
        mcp=True,
        session_resume=True,
    )

    def inspect(self, executable_path: str | None) -> CliRuntimeInspection:
        try:
            executable = self.resolve_executable(executable_path)
            version_result = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            if version_result.returncode != 0:
                detail = version_result.stderr.strip() or version_result.stdout.strip()
                raise RuntimeError(detail or "Codex CLI version check failed")
            auth_result = subprocess.run(
                [executable, "login", "status"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            return CliRuntimeInspection(
                ok=auth_result.returncode == 0,
                runtime_id=self.id,
                executable_path=executable,
                version=version_result.stdout.strip() or version_result.stderr.strip(),
                authenticated=auth_result.returncode == 0,
                error=(
                    None
                    if auth_result.returncode == 0
                    else auth_result.stderr.strip() or auth_result.stdout.strip() or "Codex CLI is not authenticated"
                ),
            )
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            return CliRuntimeInspection(
                ok=False,
                runtime_id=self.id,
                error=str(error),
            )

    def list_models(self, executable_path: str | None) -> list[CliModelInfo]:
        codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        cache_path = codex_home / "models_cache.json"
        parsed_models: list[CliModelInfo] = []
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
            models = payload.get("models") if isinstance(payload, dict) else None
            if isinstance(models, list):
                for item in models:
                    if not isinstance(item, dict) or item.get("visibility") == "hide":
                        continue
                    slug = item.get("slug")
                    if not isinstance(slug, str) or not slug.strip():
                        continue
                    raw_levels = item.get("supported_reasoning_levels")
                    efforts: list[str] = []
                    if isinstance(raw_levels, list):
                        for level in raw_levels:
                            effort = level.get("effort") if isinstance(level, dict) else None
                            if isinstance(effort, str) and effort in _CODEX_REASONING_EFFORTS:
                                efforts.append(effort)
                    default_effort = item.get("default_reasoning_level")
                    if default_effort not in efforts:
                        default_effort = efforts[0] if efforts else None
                    label = item.get("display_name")
                    parsed_models.append(
                        CliModelInfo(
                            id=slug.strip(),
                            label=label.strip() if isinstance(label, str) and label.strip() else slug.strip(),
                            reasoning_efforts=tuple(efforts),
                            default_reasoning_effort=default_effort,
                        )
                    )
        except (OSError, ValueError, TypeError):
            parsed_models = []
        if parsed_models:
            default_model = parsed_models[0]
            return [
                CliModelInfo(
                    id="default",
                    label=f"CLI default ({default_model.label})",
                    reasoning_efforts=default_model.reasoning_efforts,
                    default_reasoning_effort=default_model.default_reasoning_effort,
                ),
                *parsed_models,
            ]
        return [
            CliModelInfo(
                id="default",
                label="CLI default",
                reasoning_efforts=("low", "medium", "high", "xhigh"),
                default_reasoning_effort="medium",
            )
        ]

    def build_invocation(
        self,
        profile: dict[str, Any],
        request: dict[str, Any],
        prompt: str,
        session_id: str | None,
        mcp: dict[str, Any] | None,
    ) -> CliInvocation:
        executable = self.resolve_executable(profile.get("executablePath"))
        native_search = request.get("useNativeWebSearch") is True
        root_args: list[str] = ["--search"] if native_search else []
        command_args = ["exec"]
        if session_id:
            command_args.extend(["resume", session_id])
        command_args.extend(
            [
                "--json",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
            ]
        )
        if not session_id:
            command_args.extend(["--sandbox", "workspace-write", "--cd", request["sandboxRoot"]])
        provider = request.get("provider")
        model = (
            provider.get("model")
            if isinstance(provider, dict)
            else profile.get("model")
        )
        if isinstance(model, str) and model.strip() and model.strip() != "default":
            command_args.extend(["--model", model.strip()])
        effort = (
            provider.get("reasoningEffort")
            if isinstance(provider, dict)
            else profile.get("reasoningEffort")
        )
        if isinstance(effort, str) and effort not in {"", "none"}:
            command_args.extend(["-c", f"model_reasoning_effort={_toml_string(effort)}"])
        if not native_search:
            command_args.extend(["-c", 'web_search="disabled"'])
        if mcp is not None:
            command_args.extend(
                [
                    "-c",
                    f"mcp_servers.refora.command={_toml_string(mcp['command'])}",
                    "-c",
                    f"mcp_servers.refora.args={_toml_array(mcp['args'].split(chr(0)))}",
                    "-c",
                    "mcp_servers.refora.startup_timeout_sec=10",
                    "-c",
                    "mcp_servers.refora.tool_timeout_sec=120",
                ]
            )
        command_args.append("-")
        return CliInvocation(
            executable=executable,
            args=tuple([*root_args, *command_args]),
            cwd=request["sandboxRoot"],
            stdin=prompt,
        )

    def session_id(self, payload: dict[str, Any]) -> str | None:
        if payload.get("type") != "thread.started":
            return None
        value = payload.get("thread_id") or payload.get("threadId")
        return value if isinstance(value, str) and value else None

    def parse_event(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = payload.get("type")
        if event_type == "turn.started":
            return [{"event": "on_chat_model_start", "name": "codex"}]
        if event_type in {"turn.failed", "error"}:
            detail = payload.get("error") or payload.get("message") or payload
            return [{"event": "error", "error": detail}]
        if event_type == "turn.completed":
            usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
            return [
                {"event": "on_chat_model_end", "name": "codex", "data": {"output": {"usage_metadata": usage}}}
            ]
        item = payload.get("item")
        if not isinstance(item, dict):
            return []
        item_type = item.get("type")
        item_id = item.get("id") if isinstance(item.get("id"), str) else None
        if item_type == "agent_message" and event_type == "item.completed":
            text = item.get("text")
            return [{"event": "token", "delta": text}] if isinstance(text, str) and text else []
        if item_type == "reasoning" and event_type == "item.completed":
            text = item.get("text")
            if not isinstance(text, str):
                text = item.get("summary")
            return [{"event": "reasoning", "delta": text}] if isinstance(text, str) and text else []
        tool_name = None
        tool_input: Any = None
        tool_output: Any = None
        if item_type == "command_execution":
            tool_name = "codex_shell"
            tool_input = {"command": item.get("command")}
            tool_output = {
                "status": item.get("status"),
                "exitCode": item.get("exit_code"),
                "output": item.get("aggregated_output"),
            }
        elif item_type == "mcp_tool_call":
            server = item.get("server")
            name = item.get("tool") or item.get("name")
            tool_name = f"{server}.{name}" if server and name else str(name or "mcp_tool")
            tool_input = item.get("arguments") or item.get("input")
            tool_output = item.get("result") or item.get("error") or {"status": item.get("status")}
        elif item_type == "web_search":
            tool_name = "native_web_search"
            tool_input = {"query": item.get("query")}
            tool_output = item.get("result") or {"status": item.get("status")}
        if tool_name is None:
            return []
        event = "on_tool_start" if event_type == "item.started" else "on_tool_end"
        if event_type not in {"item.started", "item.completed"}:
            return []
        return [
            {
                "event": event,
                "name": tool_name,
                "run_id": item_id,
                "data": {"input": tool_input, "output": tool_output},
            }
        ]


class GeminiCliAdapter(CliRuntimeAdapter):
    id = "gemini"
    label = "Gemini CLI"
    default_executable = "gemini"
    reasoning_mode = "managed"
    capabilities = CliRuntimeCapabilities(
        native_web_search=True,
        mcp=True,
        session_resume=True,
    )

    def inspect(self, executable_path: str | None) -> CliRuntimeInspection:
        try:
            executable = self.resolve_executable(executable_path)
            result = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            if result.returncode != 0:
                detail = result.stderr.strip() or result.stdout.strip()
                raise RuntimeError(detail or "Gemini CLI version check failed")
            return CliRuntimeInspection(
                ok=True,
                runtime_id=self.id,
                executable_path=executable,
                version=result.stdout.strip() or result.stderr.strip(),
                authenticated=None,
            )
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            return CliRuntimeInspection(ok=False, runtime_id=self.id, error=str(error))

    def list_models(self, executable_path: str | None) -> list[CliModelInfo]:
        return [
            CliModelInfo(id="default", label="Auto (CLI default)"),
            CliModelInfo(id="auto", label="Auto"),
            CliModelInfo(id="pro", label="Pro"),
            CliModelInfo(id="flash", label="Flash"),
            CliModelInfo(id="flash-lite", label="Flash-Lite"),
        ]

    def build_invocation(
        self,
        profile: dict[str, Any],
        request: dict[str, Any],
        prompt: str,
        session_id: str | None,
        mcp: dict[str, Any] | None,
    ) -> CliInvocation:
        executable = self.resolve_executable(profile.get("executablePath"))
        native_search = request.get("useNativeWebSearch") is True
        core_tools = ["google_web_search", "web_fetch"] if native_search else []
        environment: dict[str, str] = {"GEMINI_CLI_TRUST_WORKSPACE": "true"}
        if mcp is not None:
            writer = mcp.get("writeConfig")
            if not callable(writer):
                raise RuntimeError("Gemini CLI requires a run-scoped settings writer")
            settings_path = writer(
                "gemini-settings",
                {
                    "tools": {"core": core_tools, "allowed": core_tools},
                    "mcp": {"allowed": ["refora"]},
                    "mcpServers": {
                        "refora": {
                            "command": mcp["command"],
                            "args": mcp["args"].split(chr(0)),
                            "trust": True,
                        }
                    },
                    "security": {
                        "disableYoloMode": True,
                        "folderTrust": {"enabled": False},
                    },
                },
            )
            environment["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = settings_path
        args = ["--output-format", "stream-json", "--approval-mode", "default"]
        if mcp is not None:
            args.extend(["--allowed-mcp-server-names", "refora"])
        if session_id:
            args.extend(["--resume", session_id])
        provider = request.get("provider")
        model = (
            provider.get("model")
            if isinstance(provider, dict)
            else profile.get("model")
        )
        if isinstance(model, str) and model.strip() and model.strip() != "default":
            args.extend(["--model", model.strip()])
        return CliInvocation(
            executable=executable,
            args=tuple(args),
            cwd=request["sandboxRoot"],
            stdin=prompt,
            env=environment,
        )

    def session_id(self, payload: dict[str, Any]) -> str | None:
        value = payload.get("session_id") or payload.get("sessionId")
        return value if isinstance(value, str) and value else None

    def result_text(self, payload: dict[str, Any]) -> str | None:
        if payload.get("type") != "result":
            return None
        value = payload.get("response") or payload.get("result")
        return value if isinstance(value, str) and value else None

    def parse_event(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = payload.get("type")
        if event_type == "init":
            return [{"event": "on_chat_model_start", "name": "gemini"}]
        if event_type == "message":
            if payload.get("role") not in {"assistant", "model"}:
                return []
            text = payload.get("content") or payload.get("text") or payload.get("delta")
            return [{"event": "token", "delta": text}] if isinstance(text, str) and text else []
        if event_type == "tool_use":
            return [
                {
                    "event": "on_tool_start",
                    "name": str(payload.get("tool_name") or payload.get("name") or "gemini_tool"),
                    "run_id": payload.get("tool_id") or payload.get("id"),
                    "data": {"input": payload.get("parameters") or payload.get("arguments")},
                }
            ]
        if event_type == "tool_result":
            return [
                {
                    "event": "on_tool_end",
                    "name": str(payload.get("tool_name") or payload.get("name") or "gemini_tool"),
                    "run_id": payload.get("tool_id") or payload.get("id"),
                    "data": {"output": payload.get("output") or payload.get("result")},
                }
            ]
        if event_type == "error":
            return [{"event": "error", "error": payload.get("message") or payload}]
        if event_type == "result":
            stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
            return [
                {
                    "event": "on_chat_model_end",
                    "name": "gemini",
                    "data": {"output": {"usage_metadata": stats}},
                }
            ]
        return []
