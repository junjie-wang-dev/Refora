from __future__ import annotations

import shlex
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from refora_server.agent.risk import RiskClass, RiskOverrides, classify, is_consequential


_SHELL_OPERATORS = (";", "&", "|", ">", "<", "`", "$(", "(", "\n", "\r")
_AUTO_APPROVED_EXTERNAL_TOOLS = frozenset(
    {
        "publish_workspace_artifacts",
        "install_runtime_packages",
    }
)


def _has_shell_operators(command: str) -> bool:
    return any(operator in command for operator in _SHELL_OPERATORS)


class Mode(str, Enum):
    DISCUSS = "discuss"
    PLAN = "plan"
    INTERACTIVE = "interactive"


READ_ONLY_MODES = frozenset({Mode.DISCUSS, Mode.PLAN})


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""
    needs_user: bool = False
    rule: str = ""


@dataclass
class PermissionEngine:
    sandbox_root: Path | str | None = None
    mode: Mode = Mode.INTERACTIVE
    allowed_commands: list[str] = field(default_factory=list)
    session_allow_tools: set[str] = field(default_factory=set)
    session_allow_commands: set[str] = field(default_factory=set)
    risk_overrides: RiskOverrides | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.mode, Mode):
            self.mode = Mode(self.mode)
        if self.sandbox_root is not None:
            self.sandbox_root = Path(self.sandbox_root).expanduser().resolve()
        self.allowed_commands = list(self.allowed_commands)
        self.session_allow_tools = set(self.session_allow_tools)
        self.session_allow_commands = set(self.session_allow_commands)

    def evaluate(
        self,
        tool_name: str,
        arguments: Mapping[str, Any] | None,
        metadata: Any = None,
    ) -> Decision:
        arguments = arguments or {}
        risk = classify(tool_name, metadata, self.risk_overrides)

        if risk is RiskClass.NETWORK_READ:
            return Decision(True, "network read allowed")

        if self.mode in READ_ONLY_MODES and is_consequential(risk):
            return Decision(False, f"{self.mode.value} mode is read-only")

        if risk is RiskClass.WRITE_LOCAL and "path" in arguments:
            path = arguments["path"]
            if not isinstance(path, str) or not self._under_sandbox_root(path):
                return Decision(False, f"path is not in the sandbox root: {path}")

        if risk is RiskClass.READ:
            return Decision(True, "low risk")

        if risk is RiskClass.WRITE_LOCAL:
            return Decision(True, "local workspace write")

        if risk is RiskClass.EXEC:
            if self.sandbox_root is not None:
                return Decision(True, "sandboxed command execution")
            command = arguments.get("command")
            if isinstance(command, str) and self._command_allowed(command):
                return Decision(True, "command on allowlist")
            if isinstance(command, str) and command in self.session_allow_commands:
                return Decision(True, "command allowed for session")

        if tool_name in _AUTO_APPROVED_EXTERNAL_TOOLS:
            return Decision(True, "built-in workspace operation")

        if tool_name in self.session_allow_tools:
            return Decision(True, "tool allowed for session")

        return Decision(False, "requires approval", needs_user=True)

    def allow_tool_for_session(self, tool_name: str) -> None:
        self.session_allow_tools.add(tool_name)

    def allow_command_for_session(self, command: str) -> None:
        if command:
            self.session_allow_commands.add(command)

    def _under_sandbox_root(self, path: str) -> bool:
        if self.sandbox_root is None:
            return True
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = self.sandbox_root / candidate
        try:
            candidate.resolve().relative_to(self.sandbox_root)
        except ValueError:
            return False
        return True

    def _command_allowed(self, command: str) -> bool:
        if _has_shell_operators(command):
            return False
        try:
            argv = shlex.split(command)
        except ValueError:
            return False
        if not argv:
            return False
        for allowed in self.allowed_commands:
            try:
                prefix = shlex.split(allowed)
            except ValueError:
                continue
            if prefix and argv[: len(prefix)] == prefix:
                return True
        return False
