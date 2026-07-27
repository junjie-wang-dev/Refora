from __future__ import annotations

import asyncio
import json
from typing import Any

from conftest import insert_doc, insert_thread, open_migrated_db
from langgraph.types import Command
from refora_server.repositories import create_repositories
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools


class ScriptedAgent:
    def __init__(self, repos: dict[str, Any], tools: list[Any], outputs: list[str], statuses: list[str]):
        self._repos = repos
        self._tools = tools
        self._outputs = outputs
        self._statuses = statuses

    async def astream_events(self, invocation: Any, *, config: dict[str, Any], version: str):
        assert version == "v2"
        self._statuses.append(self._repos["agentRuns"]["get"]("run-e2e")["status"])
        tool = next(item for item in self._tools if item.name == "add_docs_to_workspace")
        result = tool.invoke(
            {
                "type": "tool_call",
                "name": "add_docs_to_workspace",
                "id": "tool-call-e2e",
                "args": {"docIds": "doc-e2e"},
            },
            {},
        )
        content = result.content if hasattr(result, "content") else result
        self._outputs.append(content)
        if not isinstance(invocation, Command):
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
                                                "name": "add_docs_to_workspace",
                                                "args": {"docIds": "doc-e2e"},
                                            }
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
        yield {
            "event": "on_chain_end",
            "name": "LangGraph",
            "data": {"output": {"messages": [{"content": "Document added"}]}},
        }


def test_agent_run_persists_and_replays_tool_effect_after_resume(tmp_path) -> None:
    db = open_migrated_db()
    try:
        repos = create_repositories(db)
        workspace = repos["workspaces"]["create"]("E2E Workspace")
        insert_thread(db, id="thread-e2e", workspaceId=workspace["id"])
        insert_doc(db, id="doc-e2e")
        outputs: list[str] = []
        statuses: list[str] = []

        def create_tools(request: dict[str, Any]) -> list[Any]:
            return create_agent_tools(
                AgentToolContext(
                    run_id=request["runId"],
                    thread_id=request["threadId"],
                    workspace_id=request.get("workspaceId"),
                ),
                {"repos": repos},
            )

        runtime = createAgentRuntime(
            repos,
            {
                "createTools": create_tools,
                "createModel": lambda provider: "local-test-model",
                "createAgent": lambda model, tools, request: ScriptedAgent(
                    repos, tools, outputs, statuses
                ),
            },
        )
        request = {
            "runId": "run-e2e",
            "threadId": "thread-e2e",
            "workspaceId": workspace["id"],
            "checkpointPath": str(tmp_path / "checkpoints.sqlite"),
            "checkpointBefore": None,
            "provider": {
                "model": "local-test-model",
                "baseUrl": "https://provider.invalid/v1",
                "apiKey": "test-key",
                "useResponsesApi": False,
                "modelKwargs": {},
                "temperature": None,
                "maxTokens": None,
            },
            "systemPrompt": "Use the library.",
            "messages": [{"role": "user", "content": "Add the paper"}],
            "enabledToolNames": ["add_docs_to_workspace"],
            "sandboxRoot": None,
            "memories": {},
            "includeResearchMemory": False,
            "recursionLimit": 10,
        }

        interrupted = asyncio.run(runtime["send"](request))
        effect = repos["agentToolEffects"]["get"]("run-e2e", "tool-call-e2e")

        assert interrupted["status"] == "interrupted"
        assert repos["agentRuns"]["get"]("run-e2e")["status"] == "interrupted"
        assert effect is not None
        assert effect["status"] == "done"
        assert json.loads(effect["result"]) == {
            "added": ["doc-e2e"],
            "alreadyInWorkspace": [],
            "missing": [],
        }
        assert len(repos["workspaceItems"]["list"](workspace["id"])) == 1

        completed = asyncio.run(
            runtime["resume"](
                {"runId": "run-e2e", "decisions": [{"type": "approve"}]}
            )
        )

        assert completed["status"] == "completed"
        assert repos["agentRuns"]["get"]("run-e2e")["status"] == "completed"
        assert outputs[0] == outputs[1] == effect["result"]
        assert statuses == ["running", "running"]
        assert len(repos["workspaceItems"]["list"](workspace["id"])) == 1
    finally:
        db.close()
