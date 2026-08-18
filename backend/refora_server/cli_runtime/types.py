from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CliInvocation:
    executable: str
    args: tuple[str, ...]
    cwd: str
    stdin: str
    env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CliRuntimeCapabilities:
    native_web_search: bool
    mcp: bool
    session_resume: bool

    def to_dict(self) -> dict[str, bool]:
        return {
            "nativeWebSearch": self.native_web_search,
            "mcp": self.mcp,
            "sessionResume": self.session_resume,
        }


@dataclass(frozen=True)
class CliModelInfo:
    id: str
    label: str
    reasoning_efforts: tuple[str, ...] = ()
    default_reasoning_effort: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "reasoningEfforts": list(self.reasoning_efforts),
            "defaultReasoningEffort": self.default_reasoning_effort,
        }


@dataclass(frozen=True)
class CliRuntimeInspection:
    ok: bool
    runtime_id: str
    executable_path: str | None = None
    version: str | None = None
    authenticated: bool | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "runtimeId": self.runtime_id,
            "executablePath": self.executable_path,
            "version": self.version,
            "authenticated": self.authenticated,
            "error": self.error,
        }
