from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import secrets
import sys
import uuid
from pathlib import Path
from typing import Any

from langchain_core.messages import ToolMessage

from refora_server.agent.risk import RiskClass, classify


_RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class CliToolBroker:
    def __init__(self, state_dir: str, base_url: str, server_token: str) -> None:
        self._root = Path(state_dir) / "cli-mcp"
        self._base_url = base_url
        self._server_token = server_token
        self._runs: dict[str, dict[str, Any]] = {}

    def _artifact_path(self, run_id: str, suffix: str) -> Path:
        if not isinstance(run_id, str) or _RUN_ID_PATTERN.fullmatch(run_id) is None:
            raise ValueError("CLI tool run ID is invalid")
        root = self._root.resolve()
        path = (root / f"{run_id}{suffix}").resolve()
        if path.parent != root:
            raise ValueError("CLI tool artifact path is invalid")
        return path

    def open_run(self, run_id: str, tools: list[Any]) -> dict[str, Any] | None:
        path = self._artifact_path(run_id, ".json")
        allowed = {
            tool.name: tool
            for tool in tools
            if isinstance(getattr(tool, "name", None), str)
        }
        if not allowed:
            return None
        token = secrets.token_urlsafe(32)
        self._runs[run_id] = {
            "token": token,
            "tools": allowed,
            "approvals": asyncio.Queue(),
            "pending": {},
            "activeBatch": [],
            "replay": [],
            "artifacts": set(),
        }
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = {
            "baseUrl": self._base_url,
            "serverToken": self._server_token,
            "runId": run_id,
            "runToken": token,
        }
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
        self._runs[run_id]["artifacts"].add(path)
        frozen = bool(getattr(sys, "frozen", False))
        args = ["mcp-stdio", "--config", str(path)] if frozen else [
            "-m",
            "refora_server.cli_runtime.mcp_server",
            "--config",
            str(path),
        ]
        return {
            "command": sys.executable,
            "args": chr(0).join(args),
            "cwd": str(
                Path(sys.executable).resolve().parent
                if frozen
                else Path(__file__).resolve().parents[2]
            ),
            "configPath": str(path),
            "writeConfig": lambda name, value: self.write_runtime_config(
                run_id, name, value
            ),
        }

    def write_runtime_config(
        self, run_id: str, name: str, value: dict[str, Any]
    ) -> str:
        entry = self._runs.get(run_id)
        if entry is None:
            raise RuntimeError("CLI tool session is unavailable")
        safe_name = "".join(
            character for character in name if character.isalnum() or character in {"-", "_"}
        )
        if not safe_name:
            raise ValueError("CLI runtime configuration name is invalid")
        path = self._artifact_path(run_id, f".{safe_name}.json")
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(value, separators=(",", ":")).encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
        entry["artifacts"].add(path)
        return str(path)

    def close_run(self, run_id: str) -> None:
        entry = self._runs.pop(run_id, None)
        if entry is None:
            return
        for pending in entry["pending"].values():
            future = pending.get("future")
            if isinstance(future, asyncio.Future) and not future.done():
                future.cancel()
        for path in entry["artifacts"]:
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def _resolve(self, run_id: str, token: str) -> dict[str, Any]:
        entry = self._runs.get(run_id)
        if entry is None or not secrets.compare_digest(entry["token"], token):
            raise PermissionError("Invalid or expired CLI tool session")
        return entry

    def list_tools(self, run_id: str, token: str) -> list[dict[str, Any]]:
        entry = self._resolve(run_id, token)
        result: list[dict[str, Any]] = []
        for tool in entry["tools"].values():
            schema_source = getattr(tool, "args_schema", None)
            schema_builder = getattr(schema_source, "model_json_schema", None)
            if isinstance(schema_source, dict):
                schema = schema_source
            elif callable(schema_builder):
                schema = schema_builder()
            else:
                input_schema = getattr(tool, "get_input_jsonschema", None)
                schema = input_schema() if callable(input_schema) else {"type": "object"}
            result.append(
                {
                    "name": tool.name,
                    "description": getattr(tool, "description", "") or "",
                    "inputSchema": schema,
                    "annotations": {
                        "readOnlyHint": classify(tool.name) is RiskClass.READ,
                    },
                }
            )
        return result

    async def next_approvals(self, run_id: str) -> list[dict[str, Any]]:
        entry = self._runs.get(run_id)
        if entry is None:
            raise RuntimeError("CLI tool session is unavailable")
        first = await entry["approvals"].get()
        await asyncio.sleep(0)
        approval_ids = [first]
        while True:
            try:
                approval_ids.append(entry["approvals"].get_nowait())
            except asyncio.QueueEmpty:
                break
        entry["activeBatch"] = approval_ids
        return [
            {
                "name": entry["pending"][approval_id]["name"],
                "args": entry["pending"][approval_id]["arguments"],
                "description": entry["pending"][approval_id]["description"],
            }
            for approval_id in approval_ids
        ]

    def resolve_approvals(
        self, run_id: str, decisions: list[dict[str, Any]]
    ) -> None:
        entry = self._runs.get(run_id)
        if entry is None:
            raise RuntimeError("CLI tool session is unavailable")
        approval_ids = entry["activeBatch"]
        if len(approval_ids) != len(decisions):
            raise ValueError("CLI approval decisions do not match pending tool calls")
        for approval_id, decision in zip(approval_ids, decisions):
            pending = entry["pending"].get(approval_id)
            if pending is None:
                raise RuntimeError("CLI tool approval is no longer pending")
            future = pending["future"]
            if not future.done():
                future.set_result(decision)
        entry["activeBatch"] = []

    def set_replay_approvals(
        self, run_id: str, approvals: list[dict[str, Any]]
    ) -> None:
        entry = self._runs.get(run_id)
        if entry is None:
            raise RuntimeError("CLI tool session is unavailable")
        entry["replay"] = [dict(approval) for approval in approvals]

    async def _invoke_tool(
        self, tool: Any, arguments: dict[str, Any], tool_call_id: str | None
    ) -> Any:
        invocation: Any = arguments
        if tool_call_id:
            invocation = {
                "type": "tool_call",
                "id": tool_call_id,
                "name": tool.name,
                "args": arguments,
            }
        async_invoke = getattr(tool, "ainvoke", None)
        if callable(async_invoke):
            result = await async_invoke(invocation)
        else:
            invoke = getattr(tool, "invoke", None)
            if not callable(invoke):
                raise RuntimeError(f"CLI tool cannot be invoked: {tool.name}")
            result = await asyncio.to_thread(invoke, invocation)
            if inspect.isawaitable(result):
                result = await result
        return result.content if isinstance(result, ToolMessage) else result

    async def call_tool(
        self,
        run_id: str,
        token: str,
        name: str,
        arguments: dict[str, Any],
        tool_call_id: str | None = None,
    ) -> Any:
        entry = self._resolve(run_id, token)
        tool = entry["tools"].get(name)
        if tool is None:
            raise ValueError(f"CLI tool is unavailable: {name}")
        if classify(name) is RiskClass.READ:
            return await self._invoke_tool(tool, arguments, tool_call_id)
        for index, replay in enumerate(entry["replay"]):
            if replay.get("name") == name and replay.get("args") == arguments:
                decision = entry["replay"].pop(index).get("decision")
                if isinstance(decision, dict) and decision.get("type") == "approve":
                    return await self._invoke_tool(tool, arguments, tool_call_id)
                raise PermissionError(f"User rejected CLI tool execution: {name}")
        approval_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        entry["pending"][approval_id] = {
            "name": name,
            "arguments": dict(arguments),
            "description": getattr(tool, "description", "") or f"Tool execution requires approval: {name}",
            "toolCallId": tool_call_id,
            "future": future,
        }
        await entry["approvals"].put(approval_id)
        try:
            decision = await future
            decision_type = decision.get("type") if isinstance(decision, dict) else None
            if decision_type == "reject":
                raise PermissionError(f"User rejected CLI tool execution: {name}")
            if decision_type == "edit":
                edited = decision.get("edited_action") or decision.get("editedAction")
                if not isinstance(edited, dict) or edited.get("name") != name:
                    raise ValueError("Edited CLI approval is invalid")
                edited_arguments = edited.get("args")
                if not isinstance(edited_arguments, dict):
                    raise ValueError("Edited CLI tool arguments are invalid")
                arguments = edited_arguments
            elif decision_type != "approve":
                raise ValueError("CLI tool approval decision is invalid")
            return await self._invoke_tool(tool, arguments, tool_call_id)
        finally:
            entry["pending"].pop(approval_id, None)
