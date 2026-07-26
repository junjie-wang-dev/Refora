from __future__ import annotations

from typing import Any

from refora_server.agent.tools.common import call, object_schema, value
from refora_server.agent.tools.registry import ToolGroup

_TEXT = {"type": "string"}


def publish_workspace_artifacts(executor: Any, args: dict[str, Any]) -> Any:
    return call(value(executor, "deps"), "publish_artifacts", executor.context.workspace_id, args.get("paths", []), {key: args[key] for key in ("x", "y") if key in args})


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
        "publish_workspace_artifacts": "Publish final files from the current agent sandbox to the selected Workspace as managed WorkspaceAsset cards. Use relative sandbox paths, normally under outputs/. Without a selected Workspace the files remain in the default sandbox.",
        "install_runtime_packages": "Install shared Python 3.12 or Node.js 24 runtimes and version-pinned packages for the current Workspace or default sandbox. The user must approve downloads and installation. Package lifecycle scripts and Python source builds are disabled.",
        "__execute": "Run a shell command inside the current agent sandbox. The command can read and write only the sandbox, starts in work/, and can place publishable files in $REFORA_OUTPUTS. OS-level isolation blocks access to user files and the network.",
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
