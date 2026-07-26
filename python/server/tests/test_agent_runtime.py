import asyncio

import pytest

from conftest import insert_doc, insert_thread, make_workspaces_repo, open_migrated_db
from refora_server.repositories import create_repositories
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def repos(db):
    return create_repositories(db)


def request(**overrides):
    value = {
        "runId": "run-1",
        "threadId": "thread-1",
        "workspaceId": None,
        "checkpointPath": "/tmp/checkpoints.sqlite",
        "checkpointBefore": "checkpoint-before",
        "provider": {
            "model": "test-model",
            "baseUrl": "https://example.test/v1",
            "apiKey": "secret-api-key",
            "useResponsesApi": False,
            "modelKwargs": {},
            "temperature": None,
            "maxTokens": None,
        },
        "systemPrompt": "test",
        "messages": [{"role": "user", "content": "Explain this"}],
        "enabledToolNames": ["search_library"],
        "sandboxRoot": None,
        "memories": {},
        "includeResearchMemory": False,
        "recursionLimit": 10,
    }
    value.update(overrides)
    return value


class Agent:
    def __init__(self, cancelled=None):
        self.cancelled = cancelled

    async def cancel(self):
        if self.cancelled is not None:
            self.cancelled.set()


class NativeSnapshot:
    def __init__(self):
        self.config = {"configurable": {"checkpoint_id": "checkpoint-native"}}
        self.values = {}
        self.tasks = ()
        self.next = ()


class NativeAgent:
    def __init__(self):
        self.invocation = None
        self.config = None
        self.version = None

    async def astream_events(self, invocation, *, config, version):
        self.invocation = invocation
        self.config = config
        self.version = version
        yield {"event": "on_chat_model_stream", "data": {"chunk": NativeMessage("Native ")}}
        yield {
            "event": "on_chain_end",
            "name": "LangGraph",
            "data": {"output": {"messages": [{"content": "Native answer"}]}},
        }

    async def aget_state(self, config):
        assert config["configurable"]["thread_id"] == "thread-1"
        return NativeSnapshot()


class NativeMessage:
    def __init__(self, content):
        self.content = content


def test_send_persists_checkpoints_messages_traces_and_events(repos, db):
    insert_thread(db)
    seen = []
    tools_seen = []
    model_seen = []

    async def stream(agent, req, mode):
        assert mode == "send"
        yield {"event": "token", "delta": "Hello "}
        yield {"event": "reasoning", "delta": "considering"}
        yield {
            "event": "on_tool_end",
            "name": "search_library",
            "parent_ids": ["parent-1"],
            "data": {"output": {"apiKey": "secret-api-key", "items": [1]}},
            "tags": ["tool"],
            "metadata": {"langgraph_checkpoint_ns": "agent"},
        }
        yield {
            "event": "complete",
            "result": {
                "messages": [
                    {"type": "tool", "content": "Found one paper"},
                    {"content": "Answer"},
                ]
            },
            "state": {"config": {"configurable": {"checkpoint_id": "checkpoint-after"}}},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "clock": lambda: 1000,
            "createTools": lambda req: tools_seen.append(req["runId"]) or ["tool"],
            "createModel": lambda provider: model_seen.append(provider) or "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
            "generateTitle": lambda thread_id, provider: "Research Title",
            "emit": lambda event, payload: seen.append((event, payload)),
        },
    )

    result = asyncio.run(runtime["send"](request()))

    assert result["status"] == "completed"
    assert tools_seen == ["run-1"]
    assert model_seen == [request()["provider"]]
    run = repos["agentRuns"]["get"]("run-1")
    assert run["status"] == "completed"
    assert run["checkpointBefore"] == "checkpoint-before"
    assert run["checkpointAfter"] == "checkpoint-after"
    messages = repos["chat"]["listMessages"]("thread-1")
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "Explain this"),
        ("tool", "Found one paper"),
        ("assistant", "Answer"),
    ]
    assert repos["chat"]["getThread"]("thread-1")["headCheckpointId"] == "checkpoint-after"
    traces = repos["agentTraces"]["listByRun"]("run-1")
    assert [trace["kind"] for trace in traces] == ["run", "tool"]
    assert traces[0]["status"] == "done"
    assert "secret-api-key" not in str(seen)
    assert {event for event, _ in seen} >= {
        "ai.chat.token",
        "ai.chat.reasoning",
        "ai.chat.trace",
        "ai.chat.done",
        "ai.chat.run-status",
        "ai.chat.title-updated",
    }


def test_native_langgraph_events_produce_tokens_result_and_checkpoint(repos, db, tmp_path):
    insert_thread(db)
    agent = NativeAgent()
    seen = []
    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: agent,
            "emit": lambda event, payload: seen.append((event, payload)),
        },
    )

    result = asyncio.run(
        runtime["send"](
            request(checkpointPath=str(tmp_path / "checkpoints.sqlite"))
        )
    )

    assert result["status"] == "completed"
    assert agent.invocation == {"messages": [{"role": "user", "content": "Explain this"}]}
    assert agent.config["configurable"]["thread_id"] == "thread-1"
    assert agent.version == "v2"
    assert repos["agentRuns"]["get"]("run-1")["checkpointAfter"] == "checkpoint-native"
    assert repos["chat"]["listMessages"]("thread-1")[-1]["content"] == "Native answer"
    assert ("ai.chat.token", {"runId": "run-1", "threadId": "thread-1", "delta": "Native "}) in seen


def test_send_failure_persists_failed_run_and_error_event(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        raise RuntimeError("provider rejected secret-api-key")
        yield None

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
            "emit": lambda event, payload: seen.append((event, payload)),
        },
    )

    result = asyncio.run(runtime["send"](request()))

    assert result["status"] == "failed"
    assert repos["agentRuns"]["get"]("run-1")["status"] == "failed"
    assert repos["agentTraces"]["listByRun"]("run-1")[0]["status"] == "error"
    error = next(payload for event, payload in seen if event == "ai.chat.error")
    assert error["error"]["code"] == "agent_failed"
    assert "secret-api-key" not in error["error"]["message"]


def test_cancel_terminalizes_active_run(repos, db):
    insert_thread(db)
    started = asyncio.Event()
    released = asyncio.Event()

    async def stream(agent, req, mode):
        yield {"event": "token", "delta": "Starting"}
        started.set()
        await released.wait()
        yield {"event": "complete", "result": "late", "state": {}}

    async def exercise():
        runtime = createAgentRuntime(
            repos,
            {
                "createTools": lambda req: [],
                "createModel": lambda provider: "model",
                "createAgent": lambda model, tools, req: Agent(released),
                "stream": stream,
            },
        )
        pending = asyncio.create_task(runtime["send"](request()))
        await started.wait()
        assert await runtime["cancel"]("run-1") == {"runId": "run-1", "cancelled": True}
        return await pending

    result = asyncio.run(exercise())

    assert result["status"] == "cancelled"
    assert repos["agentRuns"]["get"]("run-1")["status"] == "cancelled"
    assert repos["agentTraces"]["listByRun"]("run-1")[0]["status"] == "cancelled"


def test_interrupt_then_resume_resolves_decisions_and_completes(repos, db):
    insert_thread(db)
    modes = []
    seen = []

    async def stream(agent, req, mode):
        modes.append(mode)
        if mode == "send":
            yield {
                "event": "interrupted",
                "state": {
                    "config": {"configurable": {"checkpoint_id": "checkpoint-waiting"}},
                    "tasks": [
                        {
                            "interrupts": [
                                {
                                    "value": {
                                        "actionRequests": [{"name": "publish", "args": {"path": "out"}}],
                                        "reviewConfigs": [{"allowedDecisions": ["approve", "reject"]}],
                                    }
                                }
                            ]
                        }
                    ],
                },
            }
            return
        yield {
            "event": "complete",
            "result": {"messages": [{"content": "Published"}]},
            "state": {"config": {"configurable": {"checkpoint_id": "checkpoint-after"}}},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
            "emit": lambda event, payload: seen.append((event, payload)),
        },
    )

    interrupted = asyncio.run(runtime["send"](request()))
    resumed = asyncio.run(runtime["resume"]({"runId": "run-1", "decisions": [{"type": "approve"}], "provider": request()["provider"]}))

    assert interrupted["status"] == "interrupted"
    assert resumed["status"] == "completed"
    assert modes == ["send", "resume"]
    interrupt = repos["agentInterrupts"]["getPendingByRun"]("run-1")
    assert interrupt is None
    assert repos["agentRuns"]["get"]("run-1")["checkpointAfter"] == "checkpoint-after"
    assert any(event == "ai.chat.interrupted" for event, _ in seen)
    assert any(event == "ai.chat.done" for event, _ in seen)

    run_traces = repos["agentTraces"]["listByRun"]("run-1")
    run_steps = [step for step in run_traces if step["kind"] == "run"]
    assert [step["status"] for step in run_steps] == ["interrupted", "done"]
    assert repos["agentRuns"]["get"]("run-1")["status"] == "completed"


def test_resume_replays_persisted_tool_effect_for_same_tool_call_id(repos, db):
    insert_thread(db)
    insert_doc(db, id="doc-1")
    ws = make_workspaces_repo(db)["create"]("Research")
    tool_call = {
        "type": "tool_call",
        "name": "add_docs_to_workspace",
        "id": "call-replay",
        "args": {"docIds": "doc-1"},
    }

    def create_tools(req):
        return create_agent_tools(
            AgentToolContext(run_id=req["runId"], workspace_id=ws["id"]),
            {"repos": repos},
        )

    async def stream(agent, req, mode):
        tools = agent if isinstance(agent, list) else []
        tool = next((t for t in tools if t.name == "add_docs_to_workspace"), None)
        if mode == "send":
            if tool is not None:
                tool.invoke(tool_call, {})
            yield {
                "event": "interrupted",
                "state": {
                    "config": {"configurable": {"checkpoint_id": "checkpoint-waiting"}},
                    "tasks": [
                        {
                            "interrupts": [
                                {
                                    "value": {
                                        "actionRequests": [{"name": "add_docs_to_workspace", "args": {"docIds": "doc-1"}}],
                                        "reviewConfigs": [{"allowedDecisions": ["approve", "reject"]}],
                                    }
                                }
                            ]
                        }
                    ],
                },
            }
            return
        if tool is not None:
            tool.invoke(tool_call, {})
        yield {
            "event": "complete",
            "result": {"messages": [{"content": "Done"}]},
            "state": {"config": {"configurable": {"checkpoint_id": "checkpoint-after"}}},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": create_tools,
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: tools,
            "stream": stream,
        },
    )

    interrupted = asyncio.run(runtime["send"](request()))
    persisted = repos["agentToolEffects"]["get"]("run-1", "call-replay")
    assert persisted is not None
    assert persisted["status"] == "done"

    resumed = asyncio.run(
        runtime["resume"](
            {
                "runId": "run-1",
                "decisions": [{"type": "approve"}],
                "provider": request()["provider"],
            }
        )
    )

    assert interrupted["status"] == "interrupted"
    assert resumed["status"] == "completed"
    replayed = repos["agentToolEffects"]["get"]("run-1", "call-replay")
    assert replayed == persisted
    rows = db.execute(
        "SELECT COUNT(*) FROM agent_tool_effects WHERE runId = ? AND toolCallId = ?",
        ["run-1", "call-replay"],
    ).fetchone()
    assert rows[0] == 1
