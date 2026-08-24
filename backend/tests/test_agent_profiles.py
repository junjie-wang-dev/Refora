from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys

import pytest

from refora_server.cli_runtime.definitions import (
    CodexCliAdapter,
    GeminiCliAdapter,
)
from refora_server.cli_runtime.engine import (
    CliRuntimeEngine,
    _build_prompt,
    _cli_subprocess_environment,
)
from refora_server.cli_runtime.mcp_server import _handle
from refora_server.cli_runtime.registry import CliRuntimeRegistry
from refora_server.cli_runtime.types import CliInvocation, CliRuntimeCapabilities
from refora_server.cli_runtime.tool_broker import CliToolBroker
from refora_server.db.connection import open_database
from refora_server.repositories.agent_profiles import (
    createAgentProfilesRepository,
    createAgentRuntimeSessionsRepository,
)
from refora_server.repositories.ai_providers import createAiProvidersRepository
from refora_server.services.agent_capabilities import resolve_agent_capabilities


def test_cli_profile_and_runtime_session_roundtrip(tmp_path):
    db, _ = open_database(str(tmp_path / "library.sqlite"))
    profiles = createAgentProfilesRepository(db)
    sessions = createAgentRuntimeSessionsRepository(db)

    profile = profiles["create"](
        {
            "name": "Codex local",
            "kind": "cli",
            "cliRuntimeId": "codex",
            "model": "default",
            "reasoningEffort": "high",
            "nativeWebSearch": True,
            "webSearchPolicy": "auto",
        }
    )

    assert profile["kind"] == "cli"
    assert profile["nativeWebSearch"] is True
    updated = profiles["update"](
        profile["id"], {"model": "gpt-5.6-codex", "webSearchPolicy": "refora"}
    )
    assert updated["model"] == "gpt-5.6-codex"
    assert updated["webSearchPolicy"] == "refora"

    db.execute(
        "INSERT INTO chat_threads (id, workspaceId, providerId, agentProfileId, createdAt) VALUES (?, NULL, ?, ?, ?)",
        ["thread-1", profile["id"], profile["id"], 1],
    )
    saved = sessions["put"]("thread-1", profile["id"], "codex", "session-1")
    assert saved["sessionId"] == "session-1"
    assert sessions["get"]("thread-1", profile["id"], "codex") == saved
    db.close()


def test_api_profile_can_reference_an_api_provider(tmp_path):
    db, _ = open_database(str(tmp_path / "library.sqlite"))
    providers = createAiProvidersRepository(db)
    profiles = createAgentProfilesRepository(db)
    provider = providers["create"](
        {
            "name": "OpenAI",
            "presetId": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-5.6",
        }
    )
    profile = profiles["create"](
        {
            "id": f"api-{provider['id']}",
            "name": provider["name"],
            "kind": "api",
            "apiProviderId": provider["id"],
            "model": provider["model"],
        }
    )

    assert profiles["getByApiProvider"](provider["id"])["id"] == profile["id"]
    providers["delete"](provider["id"])
    assert profiles["get"](profile["id"]) is None
    db.close()


def test_search_capability_resolver_deduplicates_native_search():
    profile = {
        "kind": "cli",
        "nativeWebSearch": True,
        "webSearchPolicy": "auto",
    }
    resolved = resolve_agent_capabilities(
        profile,
        ["search_documents", "web_search", "web_fetch"],
        runtime_native_web_search=True,
    )

    assert resolved["useNativeWebSearch"] is True
    assert resolved["enabledToolNames"] == ["search_documents", "web_fetch"]

    profile["webSearchPolicy"] = "refora"
    resolved = resolve_agent_capabilities(
        profile,
        ["search_documents", "web_search", "web_fetch"],
        runtime_native_web_search=True,
    )
    assert resolved["useNativeWebSearch"] is False
    assert "web_search" in resolved["enabledToolNames"]


def test_api_native_search_requires_responses_api_support():
    profile = {
        "kind": "api",
        "nativeWebSearch": True,
        "webSearchPolicy": "auto",
    }
    fallback = resolve_agent_capabilities(
        profile,
        ["search_documents", "web_search", "web_fetch"],
    )

    assert fallback["useNativeWebSearch"] is False
    assert "web_search" in fallback["enabledToolNames"]

    profile["webSearchPolicy"] = "native"
    with pytest.raises(ValueError, match="Native Web search is not available"):
        resolve_agent_capabilities(
            profile,
            ["search_documents", "web_search", "web_fetch"],
        )

    native = resolve_agent_capabilities(
        profile,
        ["search_documents", "web_search", "web_fetch"],
        api_native_web_search=True,
    )
    assert native["useNativeWebSearch"] is True
    assert native["enabledToolNames"] == ["search_documents", "web_fetch"]


def test_cli_uses_native_shell_instead_of_refora_execute():
    cli = resolve_agent_capabilities(
        {"kind": "cli", "webSearchPolicy": "refora"},
        ["search_documents", "__execute"],
    )
    api = resolve_agent_capabilities(
        {"kind": "api", "webSearchPolicy": "refora"},
        ["search_documents", "__execute"],
    )

    assert cli["enabledToolNames"] == ["search_documents"]
    assert api["enabledToolNames"] == ["search_documents", "__execute"]


def test_codex_invocation_is_run_scoped_and_never_bypasses_sandbox(monkeypatch, tmp_path):
    adapter = CodexCliAdapter()
    monkeypatch.setattr(adapter, "resolve_executable", lambda configured: "/usr/bin/codex")
    profile = {
        "executablePath": None,
        "model": "default",
        "reasoningEffort": "high",
    }
    request = {
        "sandboxRoot": str(tmp_path),
        "useNativeWebSearch": True,
        "provider": {
            "model": "gpt-5.6-luna",
            "reasoningEffort": "ultra",
        },
    }
    invocation = adapter.build_invocation(
        profile,
        request,
        "Read this paper",
        None,
        {
            "command": "/usr/bin/python3",
            "args": "-m\0refora_server.cli_runtime.mcp_server\0--config\0/tmp/run.json",
            "cwd": str(tmp_path),
        },
    )

    assert invocation.args[:2] == ("--search", "exec")
    assert "--json" in invocation.args
    assert "--ignore-user-config" in invocation.args
    assert "--sandbox" in invocation.args
    assert 'approval_policy="never"' in invocation.args
    assert "sandbox_workspace_write.network_access=true" in invocation.args
    assert invocation.args[invocation.args.index("--model") + 1] == "gpt-5.6-luna"
    assert 'model_reasoning_effort="ultra"' in invocation.args
    assert "dangerously-bypass-approvals-and-sandbox" not in " ".join(invocation.args)
    assert any("mcp_servers.refora.command" in value for value in invocation.args)
    assert any("mcp_servers.refora.cwd" in value for value in invocation.args)
    assert 'mcp_servers.refora.default_tools_approval_mode="approve"' in invocation.args
    assert "mcp_servers.refora.enabled=true" in invocation.args
    assert "mcp_servers.refora.required=true" in invocation.args


def test_codex_resumed_prompt_refreshes_workspace_system_instructions():
    prompt = _build_prompt(
        {
            "systemPrompt": "Inspect the current workspace before answering.",
            "messages": [
                {"role": "user", "content": "Old question"},
                {"role": "assistant", "content": "Old answer"},
                {"role": "user", "content": "How many reports are there?"},
            ],
        },
        True,
    )

    assert prompt == (
        "[System instructions]\nInspect the current workspace before answering.\n\n"
        "[User]\nHow many reports are there?"
    )


def test_refora_mcp_initialization_guides_workspace_tool_usage():
    response = _handle(
        {},
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        },
    )

    assert response is not None
    result = response["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert "list_workspace_context" in result["instructions"]
    assert "read_workspace_item" in result["instructions"]


def test_codex_jsonl_events_map_to_agent_runtime_events():
    adapter = CodexCliAdapter()
    assert adapter.session_id({"type": "thread.started", "thread_id": "thread-codex"}) == "thread-codex"
    assert adapter.parse_event(
        {
            "type": "item.completed",
            "item": {"id": "item-1", "type": "agent_message", "text": "Answer"},
        }
    ) == [{"event": "token", "delta": "Answer", "new_message": True}]
    assert adapter.parse_event(
        {
            "type": "item.updated",
            "item": {"id": "item-1", "type": "agent_message", "text": "Answer"},
        }
    ) == []
    tool_event = adapter.parse_event(
        {
            "type": "item.started",
            "item": {
                "id": "item-2",
                "type": "mcp_tool_call",
                "server": "refora",
                "tool": "search_documents",
                "arguments": {"query": "agents"},
            },
        }
    )[0]
    assert tool_event["event"] == "on_tool_start"
    assert tool_event["name"] == "refora.search_documents"


class _Schema:
    @staticmethod
    def model_json_schema():
        return {"type": "object", "properties": {"query": {"type": "string"}}}


class _ReadTool:
    name = "search_documents"
    description = "Search the local library"
    args_schema = _Schema

    async def ainvoke(self, arguments):
        return {"query": arguments["query"], "count": 1}


class _WriteTool:
    name = "generate_report"
    description = "Write a report"
    args_schema = _Schema

    async def ainvoke(self, arguments):
        return {"title": arguments["query"], "created": True}


class _ApprovalTool(_WriteTool):
    name = "propose_workspace_memory_update"
    description = "Propose a memory update"


class _OcrTool(_WriteTool):
    name = "prepare_paper_ocr"
    description = "Prepare paper OCR"

    async def ainvoke(self, arguments):
        return {"docId": arguments["docId"], "queued": True}


class _ToolCallAwareApprovalTool(_ApprovalTool):
    async def ainvoke(self, invocation):
        return invocation


@pytest.mark.parametrize(
    "run_id",
    ["../escaped", "nested/run", "run.with-dot", "", "x" * 129],
)
def test_cli_tool_broker_rejects_unsafe_run_ids(tmp_path, run_id):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")

    with pytest.raises(ValueError, match="run ID is invalid"):
        broker.open_run(run_id, [_ReadTool()])

    assert not (tmp_path / "escaped.json").exists()
    assert broker._runs == {}


def test_cli_tool_broker_mcp_entrypoint_has_explicit_import_root(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    config = broker.open_run("run-1", [_ReadTool()])
    assert config is not None
    message = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        }
    )

    result = subprocess.run(
        [config["command"], *config["args"].split(chr(0))],
        input=f"{message}\n",
        capture_output=True,
        text=True,
        cwd=config["cwd"],
        env={"PATH": "/usr/bin:/bin", "PYTHONNOUSERSITE": "1"},
        timeout=5,
        check=False,
    )

    assert result.returncode == 0
    assert os.path.isfile(os.path.join(config["cwd"], "refora_server", "__init__.py"))
    response = json.loads(result.stdout)
    assert response["result"]["serverInfo"]["name"] == "refora"
    assert "list_workspace_context" in response["result"]["instructions"]
    broker.close_run("run-1")


@pytest.mark.asyncio
async def test_cli_tool_broker_auto_approves_workspace_writes(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    config = broker.open_run("run-1", [_ReadTool(), _WriteTool()])
    assert config is not None
    config_path = config["configPath"]
    assert os.stat(config_path).st_mode & 0o777 == 0o600
    run_token = broker._runs["run-1"]["token"]
    tools = broker.list_tools("run-1", run_token)
    assert [tool["name"] for tool in tools] == ["search_documents", "generate_report"]
    assert tools[0]["annotations"] == {"readOnlyHint": True}
    assert tools[1]["annotations"] == {"readOnlyHint": False}
    assert await broker.call_tool("run-1", run_token, "search_documents", {"query": "AI"}) == {
        "query": "AI",
        "count": 1,
    }
    assert await broker.call_tool(
        "run-1", run_token, "generate_report", {"query": "AI"}
    ) == {"title": "AI", "created": True}
    runtime_config = config["writeConfig"]("runtime", {"enabled": True})
    assert os.stat(runtime_config).st_mode & 0o777 == 0o600
    broker.close_run("run-1")
    assert not os.path.exists(config_path)
    assert not os.path.exists(runtime_config)


@pytest.mark.asyncio
async def test_cli_tool_broker_requires_approval_for_ocr(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    broker.open_run("run-1", [_OcrTool()])
    run_token = broker._runs["run-1"]["token"]
    call = asyncio.create_task(
        broker.call_tool("run-1", run_token, "prepare_paper_ocr", {"docId": "doc-1"})
    )

    approvals = await broker.next_approvals("run-1")

    assert approvals == [{
        "name": "prepare_paper_ocr",
        "args": {"docId": "doc-1"},
        "description": "Prepare paper OCR",
    }]
    assert call.done() is False
    broker.resolve_approvals("run-1", [{"type": "approve"}])
    assert await call == {"docId": "doc-1", "queued": True}
    broker.close_run("run-1")


@pytest.mark.asyncio
async def test_cli_tool_broker_returns_rejection_to_the_cli(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    config = broker.open_run("run-1", [_ApprovalTool()])
    run_token = broker._runs["run-1"]["token"]
    call = asyncio.create_task(
        broker.call_tool(
            "run-1",
            run_token,
            "propose_workspace_memory_update",
            {"query": "AI"},
        )
    )
    await broker.next_approvals("run-1")
    broker.resolve_approvals("run-1", [{"type": "reject"}])
    with pytest.raises(PermissionError, match="User rejected"):
        await call
    broker.close_run("run-1")
    assert not os.path.exists(config["configPath"])


@pytest.mark.asyncio
async def test_cli_tool_broker_replays_approval_once_with_tool_call_identity(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    broker.open_run("run-1", [_ToolCallAwareApprovalTool()])
    run_token = broker._runs["run-1"]["token"]
    broker.set_replay_approvals(
        "run-1",
        [
            {
                "name": "propose_workspace_memory_update",
                "args": {"query": "AI"},
                "decision": {"type": "approve"},
            }
        ],
    )

    result = await broker.call_tool(
        "run-1",
        run_token,
        "propose_workspace_memory_update",
        {"query": "AI"},
        "mcp-call-1",
    )

    assert result == {
        "type": "tool_call",
        "id": "mcp-call-1",
        "name": "propose_workspace_memory_update",
        "args": {"query": "AI"},
    }
    assert broker._runs["run-1"]["replay"] == []
    broker.close_run("run-1")


def test_gemini_invocation_uses_isolated_settings_and_maps_events(monkeypatch, tmp_path):
    adapter = GeminiCliAdapter()
    monkeypatch.setattr(adapter, "resolve_executable", lambda configured: "/usr/bin/gemini")
    captured = {}

    def write_config(name, value):
        captured[name] = value
        return str(tmp_path / "settings.json")

    invocation = adapter.build_invocation(
        {"model": "default", "reasoningEffort": "medium", "executablePath": None},
        {"sandboxRoot": str(tmp_path), "useNativeWebSearch": False},
        "Read this paper",
        "gemini-session",
        {
            "command": "/usr/bin/python3",
            "args": "-m\0refora_server.cli_runtime.mcp_server\0--config\0/tmp/run.json",
            "cwd": str(tmp_path),
            "writeConfig": write_config,
        },
    )
    assert invocation.args[:2] == ("--output-format", "stream-json")
    assert "--sandbox" in invocation.args
    assert invocation.args[invocation.args.index("--approval-mode") + 1] == "yolo"
    assert invocation.env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"].endswith("settings.json")
    assert captured["gemini-settings"]["tools"]["core"] == []
    assert captured["gemini-settings"]["mcpServers"]["refora"]["trust"] is True
    assert captured["gemini-settings"]["mcpServers"]["refora"]["cwd"] == str(tmp_path)
    assert captured["gemini-settings"]["security"]["disableYoloMode"] is False
    assert adapter.session_id({"type": "init", "session_id": "gemini-session"}) == "gemini-session"
    assert adapter.parse_event(
        {"type": "message", "role": "assistant", "content": "Answer"}
    ) == [{"event": "token", "delta": "Answer"}]


def test_cli_model_catalogs_follow_runtime_capabilities(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "slug": "gpt-5.6-sol",
                        "display_name": "GPT-5.6-Sol",
                        "visibility": "list",
                        "default_reasoning_level": "low",
                        "supported_reasoning_levels": [
                            {"effort": "low"},
                            {"effort": "medium"},
                            {"effort": "high"},
                            {"effort": "xhigh"},
                            {"effort": "max"},
                            {"effort": "ultra"},
                        ],
                    },
                    {
                        "slug": "hidden-model",
                        "display_name": "Hidden",
                        "visibility": "hide",
                        "supported_reasoning_levels": [{"effort": "medium"}],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    codex_models = CodexCliAdapter().list_models(None)
    gemini = GeminiCliAdapter()

    assert [model.id for model in codex_models] == ["default", "gpt-5.6-sol"]
    assert codex_models[1].reasoning_efforts == (
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
    )
    assert codex_models[1].default_reasoning_effort == "low"
    assert [model.id for model in gemini.list_models(None)] == [
        "default",
        "auto",
        "pro",
        "flash",
        "flash-lite",
    ]
    assert gemini.reasoning_mode == "managed"


class _ApprovalAdapter:
    id = "approval-test"
    label = "Approval test"
    capabilities = CliRuntimeCapabilities(
        native_web_search=False,
        mcp=True,
        session_resume=False,
    )

    def build_invocation(self, profile, request, prompt, session_id, mcp):
        script = (
            "import json,time;"
            "print(json.dumps({'type':'init'}),flush=True);"
            "print(json.dumps({'type':'progress','text':'Preparing report.'}),flush=True);"
            "time.sleep(0.5);"
            "print(json.dumps({'type':'message','text':'Finished'}),flush=True)"
        )
        return CliInvocation(
            executable=sys.executable,
            args=("-u", "-c", script),
            cwd=request["sandboxRoot"],
            stdin=prompt,
        )

    def parse_event(self, payload):
        if payload.get("type") == "init":
            return [{"event": "on_chat_model_start", "name": self.id}]
        if payload.get("type") == "progress":
            return [
                {"event": "token", "delta": payload["text"], "new_message": True}
            ]
        if payload.get("type") == "message":
            return [
                {"event": "token", "delta": payload["text"], "new_message": True},
                {"event": "on_chat_model_end", "name": self.id, "data": {}},
            ]
        return []

    def session_id(self, payload):
        return None

    def result_text(self, payload):
        return None


class _SegmentAdapter:
    id = "segment-test"
    label = "Segment test"
    capabilities = CliRuntimeCapabilities(
        native_web_search=False,
        mcp=False,
        session_resume=False,
    )

    def build_invocation(self, profile, request, prompt, session_id, mcp):
        script = (
            "import json;"
            "print(json.dumps({'text':'Checking sources.'}),flush=True);"
            "print(json.dumps({'text':'Final answer.'}),flush=True)"
        )
        return CliInvocation(
            executable=sys.executable,
            args=("-u", "-c", script),
            cwd=request["sandboxRoot"],
            stdin=prompt,
        )

    def parse_event(self, payload):
        text = payload.get("text")
        return [
            {"event": "token", "delta": text, "new_message": True}
        ] if isinstance(text, str) else []

    def session_id(self, payload):
        return None

    def result_text(self, payload):
        return None


@pytest.mark.asyncio
async def test_cli_engine_separates_complete_assistant_messages(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    sessions = {
        "get": lambda *_args: None,
        "put": lambda *_args: None,
        "delete": lambda *_args: None,
    }
    engine = CliRuntimeEngine(
        CliRuntimeRegistry([_SegmentAdapter()]),
        broker,
        sessions,
        {"update": lambda *_args: None},
    )
    request = {
        "runId": "run-segments",
        "threadId": "thread-segments",
        "sandboxRoot": str(tmp_path),
        "messages": [{"role": "user", "content": "Inspect sources"}],
        "agentProfile": {
            "id": "profile-segments",
            "cliRuntimeId": "segment-test",
        },
    }

    events = [
        event
        async for event in engine.create_agent([], request).astream_events({})
    ]

    assert [event.get("delta") for event in events if event["event"] == "token"] == [
        "Checking sources.",
        "\n\nFinal answer.",
    ]
    assert events[-1]["result"]["content"] == (
        "Checking sources.\n\nFinal answer."
    )


@pytest.mark.asyncio
async def test_cli_engine_resumes_the_same_process_after_tool_approval(tmp_path):
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    sessions = {
        "get": lambda *_args: None,
        "put": lambda *_args: None,
        "delete": lambda *_args: None,
    }
    engine = CliRuntimeEngine(
        CliRuntimeRegistry([_ApprovalAdapter()]),
        broker,
        sessions,
        {"update": lambda *_args: None},
    )
    request = {
        "runId": "run-approval",
        "threadId": "thread-approval",
        "sandboxRoot": str(tmp_path),
        "messages": [{"role": "user", "content": "Create a report"}],
        "agentProfile": {
            "id": "profile-approval",
            "cliRuntimeId": "approval-test",
        },
    }
    agent = engine.create_agent([_ApprovalTool()], request)
    first_stream = agent.astream_events({})
    assert (await anext(first_stream))["event"] == "on_chat_model_start"
    assert (await anext(first_stream))["delta"] == "Preparing report."
    run_token = broker._runs["run-approval"]["token"]
    call = asyncio.create_task(
        broker.call_tool(
            "run-approval",
            run_token,
            "propose_workspace_memory_update",
            {"query": "AI"},
        )
    )
    interrupted = await anext(first_stream)
    assert interrupted["event"] == "interrupted"
    with pytest.raises(StopAsyncIteration):
        await anext(first_stream)
    resumed = engine.create_agent(
        [_ApprovalTool()], {**request, "decisions": [{"type": "approve"}]}
    )
    assert resumed is agent
    resumed_events = [event async for event in resumed.astream_events({})]
    assert await call == {"title": "AI", "created": True}
    assert [event["event"] for event in resumed_events] == [
        "token",
        "on_chat_model_end",
        "done",
    ]
    assert resumed_events[0]["delta"] == "\n\nFinished"
    assert resumed_events[-1]["result"]["content"] == (
        "Preparing report.\n\nFinished"
    )
    assert engine._agents == {}


class _EnvProbeAdapter:
    id = "env-probe"
    label = "Env probe"
    capabilities = CliRuntimeCapabilities(
        native_web_search=False,
        mcp=False,
        session_resume=False,
    )

    def build_invocation(self, profile, request, prompt, session_id, mcp):
        script = (
            "import json,os;"
            "leaked=sorted(k for k in os.environ if k.startswith('REFORA_'));"
            "print(json.dumps({'text': 'leaked=' + repr(leaked)}),flush=True)"
        )
        return CliInvocation(
            executable=sys.executable,
            args=("-u", "-c", script),
            cwd=request["sandboxRoot"],
            stdin=prompt,
            env={"PROBE_MARKER": "present"},
        )

    def parse_event(self, payload):
        text = payload.get("text")
        return [
            {"event": "token", "delta": text, "new_message": True}
        ] if isinstance(text, str) else []

    def session_id(self, payload):
        return None

    def result_text(self, payload):
        return None


@pytest.mark.asyncio
async def test_cli_engine_strips_refora_env_from_subprocess(tmp_path, monkeypatch):
    monkeypatch.setenv("REFORA_SERVER_TOKEN", "secret-token")
    monkeypatch.setenv("REFORA_OTHER_SECRET", "other-secret")
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    sessions = {
        "get": lambda *_args: None,
        "put": lambda *_args: None,
        "delete": lambda *_args: None,
    }
    engine = CliRuntimeEngine(
        CliRuntimeRegistry([_EnvProbeAdapter()]),
        broker,
        sessions,
        {"update": lambda *_args: None},
    )
    request = {
        "runId": "run-env",
        "threadId": "thread-env",
        "sandboxRoot": str(tmp_path),
        "messages": [{"role": "user", "content": "Report environment"}],
        "agentProfile": {
            "id": "profile-env",
            "cliRuntimeId": "env-probe",
        },
    }

    events = [
        event
        async for event in engine.create_agent([], request).astream_events({})
    ]

    delta = next(event["delta"] for event in events if event["event"] == "token")
    assert delta == "leaked=[]"


def test_cli_environment_uses_runtime_specific_allowlists(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/Users/tester")
    monkeypatch.setenv("CODEX_HOME", "/Users/tester/.codex-custom")
    monkeypatch.setenv("OPENAI_API_KEY", "codex-key")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "unrelated-secret")
    monkeypatch.setenv("REFORA_SERVER_TOKEN", "server-secret")

    codex = _cli_subprocess_environment({"ADAPTER_SETTING": "on"}, "codex")
    gemini = _cli_subprocess_environment({}, "gemini")
    unknown = _cli_subprocess_environment({}, "custom")

    assert codex["PATH"] == "/usr/bin:/bin"
    assert codex["HOME"] == "/Users/tester"
    assert codex["CODEX_HOME"] == "/Users/tester/.codex-custom"
    assert codex["OPENAI_API_KEY"] == "codex-key"
    assert codex["ADAPTER_SETTING"] == "on"
    assert "GEMINI_API_KEY" not in codex
    assert gemini["GEMINI_API_KEY"] == "gemini-key"
    assert "OPENAI_API_KEY" not in gemini
    assert "CODEX_HOME" not in unknown
    for environment in (codex, gemini, unknown):
        assert "AWS_SECRET_ACCESS_KEY" not in environment
        assert "REFORA_SERVER_TOKEN" not in environment
