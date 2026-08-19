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
        "providerId": "provider-1",
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
        "enabledToolNames": ["search_documents"],
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
            "name": "search_documents",
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
            "name": "search_documents",
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
        "name": "search_documents",
        "toolCallId": "call-search-1",
        "input": '{"query":"test"}',
        "output": '{"apiKey":"[redacted]","items":[1]}',
    }
    assert repos["chat"]["getThread"]("thread-1")["headCheckpointId"] == "checkpoint-after"
    traces = repos["agentTraces"]["listByRun"]("run-1")
    assert [trace["kind"] for trace in traces] == [
        "run",
        "message",
        "reasoning",
        "tool",
    ]
    assert traces[0]["status"] == "done"
    assert traces[1]["output"] == "Hello "
    assert traces[2]["output"] == "considering"
    assert traces[3]["status"] == "done"
    assert traces[3]["input"] is not None
    assert traces[3]["endedAt"] == 1000
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
    assert token["runId"] == "run-1"
    assert token["threadId"] == "thread-1"
    assert token["token"] == "Hello "
    assert isinstance(token["stepId"], str)
    done = next(payload for event, payload in seen if event == "ai.chat.done")
    assert done == {"runId": "run-1", "threadId": "thread-1", "finalText": "Answer"}
    trace = next(
        payload
        for event, payload in seen
        if event == "ai.chat.trace" and payload["step"]["kind"] == "tool"
    )
    assert trace["threadId"] == "thread-1"
    assert trace["step"]["kind"] == "tool"
    statuses = [
        payload["status"]
        for event, payload in seen
        if event == "ai.chat.run-status"
    ]
    assert statuses == ["queued", "running", "completed"]


def test_tool_boundaries_keep_cli_message_segments_chronological(repos, db):
    insert_thread(db)
    seen = []

    async def stream(agent, req, mode):
        yield {
            "event": "token",
            "delta": "Checking sources.",
            "new_message": True,
        }
        yield {
            "event": "on_tool_start",
            "name": "refora.search_documents",
            "run_id": "call-search-1",
            "data": {"input": {"query": "agents"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "refora.search_documents",
            "run_id": "call-search-1",
            "data": {"output": {"items": []}},
        }
        yield {
            "event": "token",
            "delta": "Final answer.",
            "new_message": True,
        }
        yield {
            "event": "done",
            "result": {"content": "Checking sources.\n\nFinal answer."},
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

    result = asyncio.run(runtime["send"](request()))

    assert result["status"] == "completed"
    traces = repos["agentTraces"]["listByRun"]("run-1")
    visible = [trace for trace in traces if trace["kind"] != "run"]
    assert [trace["kind"] for trace in visible] == ["message", "tool", "message"]
    assert [trace["output"] for trace in visible if trace["kind"] == "message"] == [
        "Checking sources.",
        "Final answer.",
    ]
    tokens = [
        payload["token"]
        for event, payload in seen
        if event == "ai.chat.token"
    ]
    assert tokens == ["Checking sources.", "\n\nFinal answer."]
    assert repos["chat"]["listMessages"]("thread-1")[-1]["content"] == (
        "Checking sources.\n\nFinal answer."
    )


def test_send_persists_the_provider_selected_for_this_run(repos, db):
    insert_thread(db, providerId="provider-original")

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": {"content": "Answer"}}

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
        },
    )

    result = asyncio.run(
        runtime["send"](request(providerId="provider-selected"))
    )

    assert result["status"] == "completed"
    assert repos["agentRuns"]["get"]("run-1")["providerId"] == "provider-selected"
    assert repos["chat"]["getThread"]("thread-1")["providerId"] == "provider-original"


def test_send_persists_the_active_reader_document_for_recovery(repos, db):
    insert_thread(db)
    document_id = insert_doc(db, id="doc-reader")

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": {"content": "Answer"}}

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
        },
    )

    result = asyncio.run(
        runtime["send"](request(activeDocumentId=document_id))
    )

    assert result["status"] == "completed"
    assert repos["agentRuns"]["get"]("run-1")["activeDocumentId"] == "doc-reader"


def test_replace_exchange_is_committed_with_new_message_run_and_trace_cleanup(
    repos, db
):
    insert_thread(db)
    first_user = repos["chat"]["addMessage"]("thread-1", "user", "Old question")
    repos["chat"]["addMessage"]("thread-1", "assistant", "Old answer")
    repos["agentRuns"]["create"](
        {
            "id": "run-old",
            "threadId": "thread-1",
            "providerId": "provider-1",
            "modelId": "test-model",
            "status": "completed",
            "checkpointBefore": "checkpoint-parent",
            "userMessageId": first_user["id"],
        }
    )
    repos["agentTraces"]["addStep"](
        {
            "threadId": "thread-1",
            "runId": "run-old",
            "kind": "run",
            "name": "agent",
            "status": "done",
            "startedAt": 1,
            "endedAt": 2,
            "seq": 0,
        }
    )
    repos["chat"]["updateAgentState"]("thread-1", "checkpoint-old", 2)

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": {"content": "New answer"}}

    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: Agent(),
            "stream": stream,
            "agentStateVersion": 2,
        },
    )

    result = asyncio.run(
        runtime["send"](
            request(
                replaceLastExchange=True,
                replaceRunId="run-old",
                checkpointBefore="checkpoint-parent",
                messages=[{"role": "user", "content": "New question"}],
            )
        )
    )

    assert result["status"] == "completed"
    messages = repos["chat"]["listMessages"]("thread-1")
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "New question"),
        ("assistant", "New answer"),
    ]
    assert repos["agentTraces"]["listByRun"]("run-old") == []
    replacement = repos["agentRuns"]["get"]("run-1")
    assert replacement["replacesRunId"] == "run-old"
    assert replacement["checkpointBefore"] == "checkpoint-parent"


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
                name="search_documents",
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
    token = next(payload for event, payload in seen if event == "ai.chat.token")
    assert token["runId"] == "run-1"
    assert token["threadId"] == "thread-1"
    assert token["token"] == "Native "
    assert isinstance(token["stepId"], str)


def test_runtime_attaches_async_sqlite_checkpointer_to_async_graph(
    repos, db, tmp_path
):
    insert_thread(db)

    class CheckpointState(TypedDict):
        messages: list[dict[str, str]]

    def answer(state: CheckpointState) -> CheckpointState:
        return {
            "messages": [
                *state["messages"],
                {"role": "assistant", "content": "Persisted answer"},
            ]
        }

    builder = StateGraph(CheckpointState)
    builder.add_node("answer", answer)
    builder.add_edge(START, "answer")
    builder.add_edge("answer", END)
    graph = builder.compile()
    checkpoint_path = tmp_path / "async-checkpoints.sqlite"
    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: graph,
        },
    )

    result = asyncio.run(
        runtime["send"](
            request(
                checkpointPath=str(checkpoint_path),
                checkpointBefore=None,
            )
        )
    )

    assert result["status"] == "completed"
    connection = sqlite3.connect(checkpoint_path)
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"checkpoints", "writes"} <= tables
        assert connection.execute(
            "SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?",
            ["thread-1"],
        ).fetchone()[0] > 0
    finally:
        connection.close()


def test_recover_continues_existing_run_from_latest_checkpoint(repos, db, tmp_path):
    insert_thread(db)
    user_message = repos["chat"]["addMessage"](
        "thread-1", "user", "Question before restart"
    )
    repos["agentRuns"]["create"](
        {
            "id": "run-1",
            "threadId": "thread-1",
            "providerId": "provider-1",
            "modelId": "test-model",
            "status": "running",
            "checkpointBefore": "checkpoint-parent",
            "userMessageId": user_message["id"],
        }
    )
    old_trace = repos["agentTraces"]["addStep"](
        {
            "threadId": "thread-1",
            "runId": "run-1",
            "kind": "message",
            "name": "assistant_message",
            "output": "Partial ",
            "status": "running",
            "startedAt": 1,
            "seq": 1,
        }
    )

    class RecoverAgent:
        invocation = "unset"
        config = None

        async def astream_events(self, invocation, *, config, version):
            self.invocation = invocation
            self.config = config
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": NativeMessage("continued")},
            }
            yield {
                "event": "on_chain_end",
                "name": "LangGraph",
                "data": {"output": {"messages": [{"content": "Partial continued"}]}},
            }

        async def aget_state(self, config):
            return NativeSnapshot()

    agent = RecoverAgent()
    runtime = createAgentRuntime(
        repos,
        {
            "createTools": lambda req: [],
            "createModel": lambda provider: "model",
            "createAgent": lambda model, tools, req: agent,
        },
    )

    result = asyncio.run(
        runtime["recover"](
            request(
                checkpointPath=str(tmp_path / "checkpoints.sqlite"),
                recoverLatestCheckpoint=True,
                messages=[],
            )
        )
    )

    assert result["status"] == "completed"
    assert agent.invocation is None
    assert agent.config["configurable"] == {"thread_id": "thread-1"}
    recovered_traces = repos["agentTraces"]["listByRun"]("run-1")
    recovered_old_trace = next(
        trace for trace in recovered_traces if trace["id"] == old_trace["id"]
    )
    assert recovered_old_trace["status"] == "cancelled"
    assert recovered_old_trace["endedAt"] is not None
    assert recovered_old_trace["output"] == "Partial "
    assert repos["agentRuns"]["get"]("run-1")["status"] == "completed"
    assert repos["chat"]["listMessages"]("thread-1")[-1]["content"] == "Partial continued"


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


@pytest.mark.parametrize("tool_name", ["search_arxiv", "refora.search_arxiv"])
def test_academic_tool_output_is_not_traced_or_persisted_as_chat_history(
    repos, db, tool_name
):
    insert_thread(db)

    async def stream(agent, req, mode):
        yield {
            "event": "on_tool_end",
            "name": tool_name,
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
                        name=tool_name,
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
    assert tool_trace["input"] is None
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


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (
            [{"type": "reasoning", "reasoning": "normalized summary", "index": 0}],
            "normalized summary",
        ),
        (
            [
                {
                    "type": "reasoning",
                    "summary": [
                        {
                            "type": "summary_text",
                            "text": "responses summary",
                            "index": 0,
                        }
                    ],
                    "index": 0,
                }
            ],
            "responses summary",
        ),
    ],
)
def test_reasoning_content_blocks_emit_reasoning(repos, db, content, expected):
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
            "data": {"chunk": NativeMessage(content)},
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

    asyncio.run(runtime["send"](request()))

    reasoning = next(
        payload for event, payload in seen if event == "ai.chat.reasoning"
    )
    assert reasoning["token"] == expected
    assert not [payload for event, payload in seen if event == "ai.chat.token"]


def test_model_end_backfills_reasoning_when_stream_event_omits_it(repos, db):
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
            "event": "on_chat_model_end",
            "name": "test-model",
            "run_id": "llm-reasoning",
            "data": {
                "output": {
                    "generations": [
                        [
                            {
                                "message": NativeMessage(
                                    "Visible answer",
                                    {"reasoning_content": "final reasoning"},
                                )
                            }
                        ]
                    ]
                }
            },
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

    asyncio.run(runtime["send"](request()))

    reasoning = [
        payload["token"] for event, payload in seen if event == "ai.chat.reasoning"
    ]
    assert reasoning == ["final reasoning"]


def test_model_end_does_not_duplicate_streamed_reasoning(repos, db):
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
                    {"reasoning_content": "streamed reasoning"},
                )
            },
        }
        yield {
            "event": "on_chat_model_end",
            "name": "test-model",
            "run_id": "llm-reasoning",
            "data": {
                "output": NativeMessage(
                    "Visible answer",
                    {"reasoning_content": "streamed reasoning"},
                )
            },
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

    asyncio.run(runtime["send"](request()))

    reasoning = [
        payload["token"] for event, payload in seen if event == "ai.chat.reasoning"
    ]
    assert reasoning == ["streamed reasoning"]


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
            "name": "search_documents",
            "run_id": "tool-1",
            "data": {"input": {"query": "test"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_documents",
            "run_id": "tool-1",
            "data": {
                "output": ToolMessage(
                    content='{"error":{"code":"failed","message":"no result"}}',
                    name="search_documents",
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
        ("message", "done"),
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
    message_trace = traces[2]
    assert token["stepId"] == message_trace["id"]


def test_streamed_tool_preview_is_reused_when_tool_starts(repos, db):
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
            "data": {
                "chunk": {
                    "tool_call_chunks": [
                        {"name": "write_file", "args": '{"path":"/tmp/', "index": 0}
                    ]
                }
            },
        }
        yield {
            "event": "on_chat_model_stream",
            "run_id": "llm-1",
            "data": {
                "chunk": {
                    "tool_call_chunks": [
                        {"args": 'result.md","content":"report"}', "index": 0}
                    ]
                }
            },
        }
        yield {
            "event": "on_tool_start",
            "name": "write_file",
            "run_id": "write-1",
            "data": {"input": {"path": "/tmp/result.md", "content": "report"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "write_file",
            "run_id": "write-1",
            "data": {"output": {"written": True}},
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
    llm_trace = next(trace for trace in traces if trace["kind"] == "llm")
    write_trace = [trace for trace in traces if trace["name"] == "write_file"]
    assert len(write_trace) == 1
    assert write_trace[0]["parentStepId"] == llm_trace["id"]
    assert write_trace[0]["status"] == "done"
    assert json.loads(write_trace[0]["input"]) == {
        "path": "/tmp/result.md",
        "content": "report",
    }
    trace_events = [
        payload["step"]
        for event, payload in seen
        if event == "ai.chat.trace" and payload["step"]["name"] == "write_file"
    ]
    assert [step["id"] for step in trace_events] == [write_trace[0]["id"]] * 3
    assert trace_events[0]["status"] == "running"
    assert trace_events[0]["input"] is None
    assert trace_events[1]["status"] == "running"
    assert trace_events[2]["status"] == "done"


def test_subagent_trace_preserves_delegation_hierarchy(repos, db):
    insert_thread(db)

    async def stream(agent, req, mode):
        yield {
            "event": "on_tool_start",
            "name": "task",
            "run_id": "task-1",
            "data": {
                "input": {
                    "subagent_type": "researcher",
                    "description": "Inspect evidence",
                }
            },
            "metadata": {"langgraph_checkpoint_ns": "root"},
        }
        yield {
            "event": "on_chat_model_start",
            "name": "test-model",
            "run_id": "child-llm",
            "parent_ids": ["task-1"],
            "metadata": {
                "lc_agent_name": "researcher",
                "langgraph_checkpoint_ns": "task:researcher",
            },
            "data": {"input": {"messages": []}},
        }
        yield {
            "event": "on_chat_model_end",
            "name": "test-model",
            "run_id": "child-llm",
            "parent_ids": ["task-1"],
            "metadata": {
                "lc_agent_name": "researcher",
                "langgraph_checkpoint_ns": "task:researcher",
            },
            "data": {"output": AIMessage(content="Evidence")},
        }
        yield {
            "event": "on_tool_end",
            "name": "task",
            "run_id": "task-1",
            "data": {"output": "Evidence"},
        }
        yield {"event": "complete", "result": "Answer", "state": {}}

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
    traces = repos["agentTraces"]["listByRun"]("run-1")
    delegation = next(trace for trace in traces if trace["kind"] == "subagent")
    child = next(trace for trace in traces if trace["kind"] == "llm")
    assert delegation["agentName"] == "researcher"
    assert delegation["namespace"] == "root"
    assert child["parentStepId"] == delegation["id"]
    assert child["agentName"] == "researcher"
    assert child["namespace"] == "task:researcher"
    assert child["depth"] == 1


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
        assert repos["chat"]["getThread"]("thread-1")["title"] == "Explain this"
        release_title.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert repos["chat"]["getThread"]("thread-1")["title"] == "Generated title"
        return result

    result = asyncio.run(exercise())

    assert result["status"] == "completed"
    assert repos["chat"]["getThread"]("thread-1")["title"] == "Generated title"
