import asyncio
import json
import sqlite3
from typing import TypedDict

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from conftest import insert_doc, insert_thread, make_workspaces_repo, open_migrated_db
from refora_server.repositories import create_repositories
from refora_server.services.agent_runtime import (
    ACADEMIC_PERSISTENCE_REDACTION,
    AcademicRedactingSerializer,
    createAgentRuntime,
)
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
    def __init__(self, content, additional_kwargs=None):
        self.content = content
        self.additional_kwargs = additional_kwargs or {}


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
            "event": "on_tool_start",
            "name": "search_library",
            "run_id": "call-search-1",
            "data": {
                "input": {
                    "input": {"query": "test"},
                    "tool_call_id": "call-search-1",
                }
            },
        }
        yield {
            "event": "on_tool_end",
            "name": "search_library",
            "run_id": "call-search-1",
            "parent_ids": ["parent-1"],
            "data": {
                "input": {
                    "input": {"query": "test"},
                    "tool_call_id": "call-search-1",
                },
                "output": {"apiKey": "secret-api-key", "items": [1]},
            },
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
    assert [message["role"] for message in messages] == ["user", "tool", "assistant"]
    tool_payload = json.loads(messages[1]["content"])
    assert tool_payload == {
        "v": 2,
        "name": "search_library",
        "toolCallId": "call-search-1",
        "input": '{"query":"test"}',
        "output": '{"apiKey":"[redacted]","items":[1]}',
    }
    assert repos["chat"]["getThread"]("thread-1")["headCheckpointId"] == "checkpoint-after"
    traces = repos["agentTraces"]["listByRun"]("run-1")
    assert [trace["kind"] for trace in traces] == ["run", "tool"]
    assert traces[0]["status"] == "done"
    assert traces[1]["status"] == "done"
    assert traces[1]["input"] is not None
    assert traces[1]["endedAt"] == 1000
    assert "secret-api-key" not in str(seen)
    assert {event for event, _ in seen} >= {
        "ai.chat.token",
        "ai.chat.reasoning",
        "ai.chat.trace",
        "ai.chat.done",
        "ai.chat.run-status",
        "ai.chat.title-updated",
    }
    token = next(payload for event, payload in seen if event == "ai.chat.token")
    assert token == {"runId": "run-1", "threadId": "thread-1", "token": "Hello "}
    done = next(payload for event, payload in seen if event == "ai.chat.done")
    assert done == {"runId": "run-1", "threadId": "thread-1", "finalText": "Answer"}
    trace = next(payload for event, payload in seen if event == "ai.chat.trace")
    assert trace["threadId"] == "thread-1"
    assert trace["step"]["kind"] == "tool"
    statuses = [
        payload["status"]
        for event, payload in seen
        if event == "ai.chat.run-status"
    ]
    assert statuses == ["queued", "running", "completed"]


def test_checkpoint_serializer_redacts_academic_calls_and_outputs():
    serializer = AcademicRedactingSerializer()
    value = {
        "messages": [
            AIMessage(
                content=[
                    {
                        "type": "tool_call",
                        "id": "content-academic-call",
                        "name": "search_arxiv",
                        "args": {"query": "content private topic"},
                    }
                ],
                tool_calls=[
                    {
                        "id": "academic-call",
                        "name": "search_arxiv",
                        "args": {"query": "private topic"},
                    }
                ],
                response_metadata={
                    "nested": {
                        "id": "metadata-academic-call",
                        "name": "search_arxiv",
                        "args": {"query": "metadata private topic"},
                    }
                },
            ),
            ToolMessage(
                content="private abstract",
                name="search_arxiv",
                tool_call_id="academic-call",
            ),
            ToolMessage(
                content="local result",
                name="search_library",
                tool_call_id="local-call",
            ),
        ]
    }

    decoded = serializer.loads_typed(serializer.dumps_typed(value))

    assert decoded["messages"][0].tool_calls[0]["args"] == {"omitted": True}
    assert decoded["messages"][0].content[0]["args"] == {"omitted": True}
    assert decoded["messages"][0].response_metadata["nested"]["args"] == {
        "omitted": True
    }
    assert decoded["messages"][1].content == ACADEMIC_PERSISTENCE_REDACTION
    assert decoded["messages"][2].content == "local result"


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
    assert (
        "ai.chat.token",
        {"runId": "run-1", "threadId": "thread-1", "token": "Native "},
    ) in seen


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
    assert "secret-api-key" not in error["message"]


def test_cancel_terminalizes_active_run(repos, db):
    insert_thread(db)
    started = asyncio.Event()
    released = asyncio.Event()
    cancelled_runs = []

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
                "cancelRun": lambda run_id: cancelled_runs.append(run_id),
            },
        )
        pending = asyncio.create_task(runtime["send"](request()))
        await started.wait()
        assert await runtime["cancel"]("run-1") == {"runId": "run-1", "cancelled": True}
        return await pending

    result = asyncio.run(exercise())

    assert result["status"] == "cancelled"
    assert cancelled_runs == ["run-1"]
    assert repos["agentRuns"]["get"]("run-1")["status"] == "cancelled"
    assert repos["agentTraces"]["listByRun"]("run-1")[0]["status"] == "cancelled"
    assert repos["chat"]["listMessages"]("thread-1")[-1]["content"] == "Starting"


def test_delete_thread_removes_checkpoint_rows(repos, db, tmp_path):
    insert_thread(db)
    repos["agentRuns"]["create"](
        {
            "id": "run-1",
            "threadId": "thread-1",
            "providerId": "provider-1",
            "modelId": "model-1",
            "status": "completed",
        }
    )
    checkpoint_path = tmp_path / "checkpoints.sqlite"
    connection = sqlite3.connect(checkpoint_path)
    connection.executescript(
        """
        CREATE TABLE checkpoints (
            thread_id TEXT,
            checkpoint_ns TEXT,
            checkpoint_id TEXT
        );
        CREATE TABLE writes (
            thread_id TEXT,
            checkpoint_ns TEXT,
            checkpoint_id TEXT
        );
        INSERT INTO checkpoints VALUES ('thread-1', '', 'checkpoint-1');
        INSERT INTO checkpoints VALUES ('thread-other', '', 'checkpoint-2');
        INSERT INTO writes VALUES ('thread-1', '', 'checkpoint-1');
        INSERT INTO writes VALUES ('thread-other', '', 'checkpoint-2');
        """
    )
    connection.close()
    runtime = createAgentRuntime(
        repos,
        {"checkpointPath": str(checkpoint_path)},
    )

    asyncio.run(runtime["deleteThread"]("thread-1"))

    connection = sqlite3.connect(checkpoint_path)
    assert connection.execute(
        "SELECT thread_id FROM checkpoints ORDER BY thread_id"
    ).fetchall() == [("thread-other",)]
    assert connection.execute(
        "SELECT thread_id FROM writes ORDER BY thread_id"
    ).fetchall() == [("thread-other",)]
    connection.close()


def test_delete_thread_waits_for_active_run_cancellation(repos, db, tmp_path):
    insert_thread(db)
    started = asyncio.Event()
    blocked = asyncio.Event()

    async def stream(agent, req, mode):
        started.set()
        await blocked.wait()
        yield {"event": "complete", "result": "late", "state": {}}

    async def exercise():
        runtime = createAgentRuntime(
            repos,
            {
                "createTools": lambda req: [],
                "createModel": lambda provider: "model",
                "createAgent": lambda model, tools, req: Agent(),
                "stream": stream,
                "checkpointPath": str(tmp_path / "checkpoints.sqlite"),
            },
        )
        await runtime["start"](
            request(
                checkpointPath=str(tmp_path / "checkpoints.sqlite"),
                checkpointBefore=None,
            )
        )
        await started.wait()
        await runtime["deleteThread"]("thread-1")

    asyncio.run(exercise())

    assert repos["agentRuns"]["get"]("run-1")["status"] == "cancelled"


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
    approval_steps = [step for step in run_traces if step["kind"] == "tool"]
    assert len(approval_steps) == 1
    assert approval_steps[0]["name"] == "publish"
    assert approval_steps[0]["status"] == "interrupted"
    assert json.loads(approval_steps[0]["input"]) == {"path": "out"}
    assert repos["agentRuns"]["get"]("run-1")["status"] == "completed"


def test_failed_resume_keeps_interrupt_pending_and_can_retry(repos, db):
    insert_thread(db)
    resume_attempts = 0

    async def stream(agent, req, mode):
        nonlocal resume_attempts
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
                                        "actionRequests": [
                                            {"name": "publish", "args": {"path": "out"}}
                                        ],
                                        "reviewConfigs": [
                                            {"allowedDecisions": ["approve", "reject"]}
                                        ],
                                    }
                                }
                            ]
                        }
                    ],
                },
            }
            return
        resume_attempts += 1
        if resume_attempts == 1:
            raise RuntimeError("temporary provider failure")
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
        },
    )
    asyncio.run(runtime["send"](request()))

    first = asyncio.run(
        runtime["resume"](
            {"runId": "run-1", "decisions": [{"type": "approve"}]}
        )
    )

    assert first["status"] == "interrupted"
    assert repos["agentRuns"]["get"]("run-1")["status"] == "interrupted"
    assert repos["agentInterrupts"]["getPendingByRun"]("run-1") is not None

    second = asyncio.run(
        runtime["resume"](
            {"runId": "run-1", "decisions": [{"type": "approve"}]}
        )
    )

    assert second["status"] == "completed"
    assert repos["agentInterrupts"]["getPendingByRun"]("run-1") is None


def test_tool_error_finishes_the_matching_running_trace(repos, db):
    insert_thread(db)

    async def stream(agent, req, mode):
        yield {
            "event": "on_tool_start",
            "name": "web_fetch",
            "run_id": "tool-run-1",
            "data": {"input": {"url": "https://example.test"}},
        }
        yield {
            "event": "on_tool_error",
            "name": "web_fetch",
            "run_id": "tool-run-1",
            "data": {"error": "fetch failed"},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
        },
    )

    result = asyncio.run(runtime["send"](request()))

    assert result["status"] == "failed"
    tool_steps = [
        step
        for step in repos["agentTraces"]["listByRun"]("run-1")
        if step["kind"] == "tool"
    ]
    assert len(tool_steps) == 1
    assert tool_steps[0]["status"] == "error"
    assert tool_steps[0]["output"] == "fetch failed"


def test_memory_edit_decision_is_validated_and_normalized_for_langgraph(repos, db):
    workspace = make_workspaces_repo(db)["create"]("Research")
    insert_thread(db, workspaceId=workspace["id"])
    resume_decisions = []

    async def stream(agent, req, mode):
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
                                        "actionRequests": [
                                            {
                                                "name": "propose_workspace_memory_update",
                                                "args": {
                                                    "path": "/brief.md",
                                                    "content": "before",
                                                    "rationale": "stable",
                                                },
                                            }
                                        ],
                                        "reviewConfigs": [
                                            {
                                                "allowedDecisions": [
                                                    "approve",
                                                    "edit",
                                                    "reject",
                                                ]
                                            }
                                        ],
                                    }
                                }
                            ]
                        }
                    ],
                },
            }
            return
        resume_decisions.extend(req["decisions"])
        yield {
            "event": "complete",
            "result": {"messages": [{"content": "Updated"}]},
            "state": {"config": {"configurable": {"checkpoint_id": "checkpoint-after"}}},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
        },
    )
    asyncio.run(runtime["send"](request(workspaceId=workspace["id"])))

    invalid = asyncio.run(
        runtime["resume"](
            {
                "runId": "run-1",
                "decisions": [
                    {
                        "type": "edit",
                        "editedAction": {
                            "name": "propose_workspace_memory_update",
                            "args": {
                                "path": "/research.md",
                                "content": "after",
                                "rationale": "",
                            },
                        },
                    }
                ],
            }
        )
    )
    assert invalid["status"] == "failed"
    assert "rationale" in invalid["error"]
    assert repos["agentInterrupts"]["getPendingByRun"]("run-1") is not None

    resumed = asyncio.run(
        runtime["resume"](
            {
                "runId": "run-1",
                "decisions": [
                    {
                        "type": "edit",
                        "editedAction": {
                            "name": "propose_workspace_memory_update",
                            "args": {
                                "path": "/research.md",
                                "content": "after",
                                "rationale": "durable finding",
                            },
                        },
                    }
                ],
            }
        )
    )

    assert resumed["status"] == "completed"
    assert resume_decisions == [
        {
            "type": "edit",
            "edited_action": {
                "name": "propose_workspace_memory_update",
                "args": {
                    "path": "/research.md",
                    "content": "after",
                    "rationale": "durable finding",
                },
            },
        }
    ]


def test_academic_tool_output_is_not_traced_or_persisted_as_chat_history(repos, db):
    insert_thread(db)

    async def stream(agent, req, mode):
        yield {
            "event": "on_tool_end",
            "name": "search_arxiv",
            "run_id": "academic-call",
            "data": {
                "input": {"query": "private topic"},
                "output": {"abstract": "private abstract"},
            },
        }
        yield {
            "event": "complete",
            "result": {
                "messages": [
                    ToolMessage(
                        content="private abstract",
                        name="search_arxiv",
                        tool_call_id="academic-call",
                    ),
                    AIMessage(content="Answer"),
                ]
            },
            "state": {"config": {"configurable": {"checkpoint_id": "checkpoint-after"}}},
        }

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
        },
    )

    result = asyncio.run(runtime["send"](request()))

    assert result["status"] == "completed"
    messages = repos["chat"]["listMessages"]("thread-1")
    assert [message["role"] for message in messages] == ["user", "assistant"]
    tool_trace = next(
        step
        for step in repos["agentTraces"]["listByRun"]("run-1")
        if step["kind"] == "tool"
    )
    assert tool_trace["output"] == ACADEMIC_PERSISTENCE_REDACTION


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


class ApprovalState(TypedDict):
    messages: list[dict[str, str]]


def test_real_langgraph_interrupt_resumes_with_command(repos, db):
    insert_thread(db)

    def approval_node(state: ApprovalState) -> ApprovalState:
        response = interrupt(
            {
                "action_requests": [
                    {"name": "publish", "args": {"path": "out/report.md"}}
                ],
                "review_configs": [
                    {"allowed_decisions": ["approve", "reject"]}
                ],
            }
        )
        decision = response["decisions"][0]["type"]
        return {
            "messages": [
                *state["messages"],
                {"role": "assistant", "content": f"Decision: {decision}"},
            ]
        }

    builder = StateGraph(ApprovalState)
    builder.add_node("approval", approval_node)
    builder.add_edge(START, "approval")
    builder.add_edge("approval", END)
    graph = builder.compile(checkpointer=InMemorySaver())
    providers_seen = []
    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: providers_seen.append(provider) or "model",
            "createAgent": lambda model, tools, req: graph,
        },
    )
    original_provider = {
        **request()["provider"],
        "reasoning": {"effort": "high"},
    }

    interrupted = asyncio.run(
        runtime["send"](
            request(
                checkpointBefore=None,
                checkpointPath=None,
                provider=original_provider,
            )
        )
    )
    completed = asyncio.run(
        runtime["resume"](
            {
                "runId": "run-1",
                "decisions": [{"type": "approve"}],
                "provider": {
                    "model": "test-model",
                    "baseUrl": "https://example.test/v1",
                },
            }
        )
    )

    assert interrupted["status"] == "interrupted"
    assert completed["status"] == "completed", completed
    assert providers_seen == [original_provider, original_provider]
    assert repos["chat"]["listMessages"]("thread-1")[-1]["content"] == "Decision: approve"


def test_resume_validation_failure_emits_error_and_raw_status(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        yield {
            "event": "interrupted",
            "state": {
                "tasks": [
                    {
                        "interrupts": [
                            {
                                "value": {
                                    "actionRequests": [
                                        {"name": "publish", "args": {"path": "out"}}
                                    ],
                                    "reviewConfigs": [
                                        {"allowedDecisions": ["approve", "reject"]}
                                    ],
                                }
                            }
                        ]
                    }
                ]
            },
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
    asyncio.run(runtime["send"](request()))
    seen.clear()

    result = asyncio.run(
        runtime["resume"]({"runId": "run-1", "decisions": []})
    )

    assert result["status"] == "failed"
    assert [event for event, _ in seen] == [
        "ai.chat.error",
        "ai.chat.run-status",
    ]
    assert seen[-1][1]["status"] == "interrupted"


def test_reasoning_content_is_not_emitted_as_answer_token(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        yield {
            "event": "on_chat_model_start",
            "name": "test-model",
            "run_id": "llm-reasoning",
            "data": {"input": {"messages": []}},
        }
        yield {
            "event": "on_chat_model_stream",
            "run_id": "llm-reasoning",
            "data": {
                "chunk": NativeMessage(
                    "",
                    {"reasoning_content": "private chain"},
                )
            },
        }
        yield {
            "event": "on_chat_model_end",
            "name": "test-model",
            "run_id": "llm-reasoning",
            "data": {"output": AIMessage(content="Visible answer")},
        }
        yield {"event": "complete", "result": "Visible answer", "state": {}}

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

    assert result["status"] == "completed"
    reasoning = next(
        payload for event, payload in seen if event == "ai.chat.reasoning"
    )
    assert reasoning["token"] == "private chain"
    assert isinstance(reasoning["stepId"], str)
    assert not [payload for event, payload in seen if event == "ai.chat.token"]


def test_failure_preserves_partial_response_and_emits_done(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        yield {"event": "token", "delta": "Partial answer"}
        raise RuntimeError("provider disconnected")
        yield

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
    assistant = repos["chat"]["listMessages"]("thread-1")[-1]
    assert assistant["role"] == "assistant"
    assert assistant["content"].startswith("Partial answer")
    assert "provider disconnected" in assistant["content"]
    assert any(event == "ai.chat.done" for event, _ in seen)
    error = next(payload for event, payload in seen if event == "ai.chat.error")
    assert error["partialText"] == assistant["content"]


def test_new_run_supersedes_same_thread_without_late_assistant_write(repos, db):
    insert_thread(db)
    started = asyncio.Event()
    released = asyncio.Event()

    async def stream(agent, req, mode):
        if req["runId"] == "run-1":
            yield {"event": "token", "delta": "Old partial"}
            started.set()
            await released.wait()
            yield {"event": "complete", "result": "Old late answer", "state": {}}
            return
        yield {"event": "complete", "result": "New answer", "state": {}}

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
        first = asyncio.create_task(runtime["send"](request()))
        await started.wait()
        second = await runtime["send"](
            request(
                runId="run-2",
                messages=[{"role": "user", "content": "New question"}],
            )
        )
        return await first, second

    first, second = asyncio.run(exercise())

    assert first["status"] == "cancelled"
    assert second["status"] == "completed"
    assistants = [
        message["content"]
        for message in repos["chat"]["listMessages"]("thread-1")
        if message["role"] == "assistant"
    ]
    assert assistants == ["New answer"]


def test_llm_todo_and_failed_tool_traces_are_paired(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        yield {
            "event": "on_chat_model_start",
            "name": "test-model",
            "run_id": "llm-1",
            "data": {"input": {"messages": []}},
        }
        yield {
            "event": "on_chat_model_stream",
            "run_id": "llm-1",
            "data": {"chunk": NativeMessage("Answer")},
        }
        yield {
            "event": "on_chat_model_end",
            "name": "test-model",
            "run_id": "llm-1",
            "data": {
                "output": AIMessage(
                    content="Answer",
                    usage_metadata={
                        "input_tokens": 11,
                        "output_tokens": 7,
                        "total_tokens": 18,
                    },
                )
            },
        }
        yield {
            "event": "on_tool_start",
            "name": "write_todos",
            "run_id": "todo-1",
            "data": {"input": {"todos": []}},
        }
        yield {
            "event": "on_tool_end",
            "name": "write_todos",
            "run_id": "todo-1",
            "data": {"output": {"todos": []}},
        }
        yield {
            "event": "on_tool_start",
            "name": "search_library",
            "run_id": "tool-1",
            "data": {"input": {"query": "test"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_library",
            "run_id": "tool-1",
            "data": {
                "output": ToolMessage(
                    content='{"error":{"code":"failed","message":"no result"}}',
                    name="search_library",
                    tool_call_id="tool-1",
                    status="error",
                )
            },
        }
        yield {"event": "complete", "result": "Answer", "state": {}}

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

    assert result["status"] == "completed"
    traces = repos["agentTraces"]["listByRun"]("run-1")
    assert [(trace["kind"], trace["status"]) for trace in traces] == [
        ("run", "done"),
        ("llm", "done"),
        ("todo", "done"),
        ("tool", "error"),
    ]
    llm_trace = traces[1]
    assert (
        llm_trace["inputTokens"],
        llm_trace["outputTokens"],
        llm_trace["totalTokens"],
    ) == (11, 7, 18)
    token = next(payload for event, payload in seen if event == "ai.chat.token")
    assert token["stepId"] == llm_trace["id"]


def test_title_generation_does_not_delay_completed_run(repos, db):
    insert_thread(db)

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": "Answer", "state": {}}

    async def exercise():
        release_title = asyncio.Event()
        title_started = asyncio.Event()

        async def generate_title(thread_id, provider):
            title_started.set()
            await release_title.wait()
            return "Generated title"

        runtime = createAgentRuntime(
            repos,
            {
                "createTools": lambda req: [],
                "createModel": lambda provider: "model",
                "createAgent": lambda model, tools, req: Agent(),
                "stream": stream,
                "generateTitle": generate_title,
            },
        )
        result = await asyncio.wait_for(runtime["send"](request()), timeout=0.2)
        assert title_started.is_set()
        assert repos["chat"]["getThread"]("thread-1")["title"] is None
        release_title.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return result

    result = asyncio.run(exercise())

    assert result["status"] == "completed"
    assert repos["chat"]["getThread"]("thread-1")["title"] == "Generated title"
