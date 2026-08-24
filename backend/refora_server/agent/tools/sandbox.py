from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, object_schema, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}


def _artifact_path(path: Any) -> Any:
    if isinstance(path, str) and path.startswith("/outputs/"):
        return path[1:]
    return path


def publish_workspace_artifacts(executor: Any, args: dict[str, Any]) -> Any:
    paths = [_artifact_path(path) for path in args.get("paths", [])]
    return call(value(executor, "deps"), "publish_artifacts", executor.context.workspace_id, paths, {key: args[key] for key in ("x", "y") if key in args})


def install_runtime_packages(executor: Any, args: dict[str, Any]) -> Any:
    return call(
        value(executor, "deps"),
        "install_runtime_packages",
        executor.context.workspace_id,
        {**args, "_runId": executor.context.run_id},
    )


def execute_sandbox(executor: Any, args: dict[str, Any]) -> Any:
    deps = value(executor, "deps")
    runner = value(deps, "execute_sandbox")
    if not callable(runner):
        return {"error": {"code": "sandbox_unavailable", "message": "OS-level sandbox execution is unavailable."}}
    return call(
        deps,
        "execute_sandbox",
        args.get("command", ""),
        {**args, "_runId": executor.context.run_id},
    )


class SandboxTools(ToolGroup):
    name = "sandbox"
    handlers = {
        "publish_workspace_artifacts": publish_workspace_artifacts,
        "install_runtime_packages": install_runtime_packages,
        "__execute": execute_sandbox,
    }
    descriptions = {
        "publish_workspace_artifacts": "Publish final files from the current agent sandbox to the selected Workspace as managed WorkspaceAsset cards. Paths may use the filesystem tool form /outputs/file.ext or the sandbox-relative form outputs/file.ext. Without a selected Workspace the files remain in the default sandbox.",
        "install_runtime_packages": "Install shared Python 3.12 or Node.js 24 runtimes and version-pinned packages for the current Workspace or default sandbox without an approval prompt. Package lifecycle scripts and Python source builds are disabled.",
        "__execute": "Run a shell command without an approval prompt inside the current agent sandbox. Writes are confined to the sandbox, the command starts in work/, and publishable files go to $REFORA_OUTPUTS. Network access is denied and user-home files are unreadable.",
    }
    schemas = {
        "publish_workspace_artifacts": object_schema({"paths": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 500}, "minItems": 1, "maxItems": 20}, "x": {"type": "number"}, "y": {"type": "number"}}, ["paths"]),
        "install_runtime_packages": object_schema({"runtimes": {"type": "array", "items": {"type": "string", "enum": ["python", "node"]}, "maxItems": 2, "default": []}, "python": {"type": "array", "items": object_schema({"name": {"type": "string", "minLength": 1, "maxLength": 120}, "version": {"type": "string", "minLength": 1, "maxLength": 80}}, ["name", "version"]), "maxItems": 20, "default": []}, "node": {"type": "array", "items": object_schema({"name": {"type": "string", "minLength": 1, "maxLength": 120}, "version": {"type": "string", "minLength": 1, "maxLength": 80}}, ["name", "version"]), "maxItems": 20, "default": []}}),
        "__execute": object_schema(
            {
                "command": _TEXT,
                "cwd": {"type": "string", "maxLength": 500},
                "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 300},
            },
            ["command"],
        ),
    }
