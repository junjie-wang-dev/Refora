from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from typing import Any

from refora_server.cli_runtime.registry import CliRuntimeRegistry
from refora_server.cli_runtime.tool_broker import CliToolBroker


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            _message_text(item.get("text") if isinstance(item, dict) else item)
            for item in value
        )
    if isinstance(value, dict):
        return _message_text(value.get("content") or value.get("text"))
    return "" if value is None else str(value)


def _segment_separator(before: str, after: str) -> str:
    if not before or not after:
        return ""
    trailing = len(before) - len(before.rstrip("\n"))
    leading = len(after) - len(after.lstrip("\n"))
    return "\n" * max(0, 2 - trailing - leading)


_SENSITIVE_ENV_PREFIXES = ("REFORA_",)


def _cli_subprocess_environment(extra: dict[str, Any]) -> dict[str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not any(key.startswith(prefix) for prefix in _SENSITIVE_ENV_PREFIXES)
    }
    environment.update(extra)
    return environment


def _build_prompt(request: dict[str, Any], resumed: bool) -> str:
    messages = request.get("messages") if isinstance(request.get("messages"), list) else []
    if resumed:
        messages = [
            message
            for message in messages[-1:]
            if isinstance(message, dict) and message.get("role") in {"user", "human"}
        ]
    parts: list[str] = []
    system_prompt = request.get("systemPrompt")
    if isinstance(system_prompt, str) and system_prompt.strip():
        parts.append(f"[System instructions]\n{system_prompt.strip()}")
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        label = "User" if role in {"user", "human"} else "Assistant"
        text = _message_text(message.get("content"))
        if text:
            parts.append(f"[{label}]\n{text}")
    if resumed and not parts and isinstance(request.get("cliApprovalReplay"), list):
        parts.append(
            "[User]\nContinue the interrupted task. Repeat any pending Refora tool call "
            "that is still required; its recorded user decision will be applied once."
        )
    return "\n\n".join(parts)


class CliRuntimeAgent:
    checkpointer = False

    def __init__(
        self,
        registry: CliRuntimeRegistry,
        broker: CliToolBroker,
        sessions: Any,
        tools: list[Any],
        request: dict[str, Any],
        on_close: Callable[[str], None],
    ) -> None:
        self._registry = registry
        self._broker = broker
        self._sessions = sessions
        self._tools = tools
        self._request = request
        self._on_close = on_close
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_chunks: list[bytes] = []
        self._final_text: list[str] = []
        self._mcp: dict[str, Any] | None = None
        self._waiting_approval = False
        self._closed = False

    def update_request(self, request: dict[str, Any]) -> None:
        self._request = request

    async def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._broker.close_run(self._request["runId"])
        self._on_close(self._request["runId"])

    async def _start(self) -> None:
        request = self._request
        profile = request["agentProfile"]
        runtime_id = profile["cliRuntimeId"]
        adapter = self._registry.get(runtime_id)
        session = None
        if request.get("replaceLastExchange") is not True:
            session = self._sessions["get"](
                request["threadId"], profile["id"], runtime_id
            )
        session_id = session.get("sessionId") if isinstance(session, dict) else None
        prompt = _build_prompt(request, bool(session_id))
        self._mcp = self._broker.open_run(request["runId"], self._tools)
        replay = request.get("cliApprovalReplay")
        if self._mcp is not None and isinstance(replay, list):
            self._broker.set_replay_approvals(
                request["runId"],
                [item for item in replay if isinstance(item, dict)],
            )
        invocation = adapter.build_invocation(
            profile,
            request,
            prompt,
            session_id,
            self._mcp,
        )
        environment = _cli_subprocess_environment(invocation.env)
        self._process = await asyncio.create_subprocess_exec(
            invocation.executable,
            *invocation.args,
            cwd=invocation.cwd,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert self._process.stdin is not None
        assert self._process.stderr is not None
        self._process.stdin.write(invocation.stdin.encode("utf-8"))
        await self._process.stdin.drain()
        self._process.stdin.close()

        async def read_stderr() -> None:
            assert self._process is not None
            assert self._process.stderr is not None
            while True:
                chunk = await self._process.stderr.read(8192)
                if not chunk:
                    return
                self._stderr_chunks.append(chunk)

        self._stderr_task = asyncio.create_task(read_stderr())

    async def cancel(self) -> None:
        process = self._process
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        if self._stderr_task is not None:
            await asyncio.gather(self._stderr_task, return_exceptions=True)
        await self._close()

    async def astream_events(self, _invocation: Any, **_kwargs: Any):
        request = self._request
        profile = request["agentProfile"]
        runtime_id = profile["cliRuntimeId"]
        adapter = self._registry.get(runtime_id)
        if self._process is None:
            try:
                await self._start()
            except BaseException:
                await self._close()
                raise
        elif self._waiting_approval:
            decisions = request.get("decisions")
            if not isinstance(decisions, list):
                raise ValueError("CLI approval decisions are required")
            self._broker.resolve_approvals(request["runId"], decisions)
            self._waiting_approval = False
        assert self._process is not None
        assert self._process.stdout is not None
        approval_task = (
            asyncio.create_task(self._broker.next_approvals(request["runId"]))
            if self._mcp is not None
            else None
        )
        read_task: asyncio.Task[bytes] | None = None
        try:
            while True:
                read_task = asyncio.create_task(self._process.stdout.readline())
                waiting: set[asyncio.Task[Any]] = {read_task}
                if approval_task is not None:
                    waiting.add(approval_task)
                done, _pending = await asyncio.wait(
                    waiting, return_when=asyncio.FIRST_COMPLETED
                )
                if read_task in done:
                    line = read_task.result()
                    read_task = None
                    if not line:
                        break
                elif approval_task is not None and approval_task in done:
                    read_task.cancel()
                    await asyncio.gather(read_task, return_exceptions=True)
                    read_task = None
                    actions = approval_task.result()
                    approval_task = None
                    self._waiting_approval = True
                    yield {
                        "event": "interrupted",
                        "state": {
                            "tasks": [
                                {
                                    "interrupts": [
                                        {
                                            "value": {
                                                "actionRequests": actions,
                                                "reviewConfigs": [
                                                    {"allowedDecisions": ["approve", "reject"]}
                                                    for _action in actions
                                                ],
                                            }
                                        }
                                    ]
                                }
                            ]
                        },
                    }
                    return
                else:
                    continue
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                runtime_session_id = adapter.session_id(payload)
                if runtime_session_id:
                    self._sessions["put"](
                        request["threadId"],
                        profile["id"],
                        runtime_id,
                        runtime_session_id,
                    )
                    request["runtimeSessionId"] = runtime_session_id
                    runs = request.get("agentRunsRepo")
                    if isinstance(runs, dict) and callable(runs.get("update")):
                        runs["update"](request["runId"], {"runtimeSessionId": runtime_session_id})
                for event in adapter.parse_event(payload):
                    if event.get("event") == "token" and isinstance(event.get("delta"), str):
                        separator = ""
                        if event.get("new_message") is True and self._final_text:
                            separator = _segment_separator(
                                "".join(self._final_text), event["delta"]
                            )
                            if separator:
                                self._final_text.append(separator)
                        self._final_text.append(event["delta"])
                        if separator:
                            event = {**event, "delta": separator + event["delta"]}
                    yield event
                result_text = adapter.result_text(payload)
                if result_text and not self._final_text:
                    self._final_text.append(result_text)
            return_code = await self._process.wait()
            if approval_task is not None:
                approval_task.cancel()
                await asyncio.gather(approval_task, return_exceptions=True)
                approval_task = None
            if self._stderr_task is not None:
                await asyncio.gather(self._stderr_task, return_exceptions=True)
            if return_code != 0:
                detail = b"".join(self._stderr_chunks).decode("utf-8", errors="replace").strip()
                raise RuntimeError(detail or f"{adapter.label} exited with status {return_code}")
            yield {
                "event": "done",
                "result": {"content": "".join(self._final_text)},
            }
            await self._close()
        except BaseException:
            if not self._waiting_approval:
                await self.cancel()
            raise
        finally:
            if read_task is not None:
                read_task.cancel()
                await asyncio.gather(read_task, return_exceptions=True)
            if approval_task is not None:
                approval_task.cancel()
                await asyncio.gather(approval_task, return_exceptions=True)


class CliRuntimeEngine:
    def __init__(
        self,
        registry: CliRuntimeRegistry,
        broker: CliToolBroker,
        sessions: Any,
        agent_runs: Any,
    ) -> None:
        self.registry = registry
        self.broker = broker
        self.sessions = sessions
        self.agent_runs = agent_runs
        self._agents: dict[str, CliRuntimeAgent] = {}

    def inspect(self, runtime_id: str, executable_path: str | None = None) -> dict[str, Any]:
        return self.registry.inspect(runtime_id, executable_path)

    def list_models(self, runtime_id: str, executable_path: str | None = None) -> dict[str, Any]:
        return self.registry.list_models(runtime_id, executable_path)

    def create_agent(self, tools: list[Any], request: dict[str, Any]) -> CliRuntimeAgent:
        run_id = request["runId"]
        existing = self._agents.get(run_id)
        enriched = {**request, "agentRunsRepo": self.agent_runs}
        if existing is not None:
            existing.update_request(enriched)
            return existing
        agent = CliRuntimeAgent(
            self.registry,
            self.broker,
            self.sessions,
            tools,
            enriched,
            lambda closed_run_id: self._agents.pop(closed_run_id, None),
        )
        self._agents[run_id] = agent
        return agent

    async def cancel(self, run_id: str) -> bool:
        agent = self._agents.get(run_id)
        if agent is None:
            return False
        await agent.cancel()
        return True

    def cancel_nowait(self, run_id: str) -> bool:
        if run_id not in self._agents:
            return False
        asyncio.create_task(self.cancel(run_id))
        return True

    async def destroy(self) -> None:
        agents = list(self._agents.values())
        for agent in agents:
            await agent.cancel()
        self._agents.clear()
