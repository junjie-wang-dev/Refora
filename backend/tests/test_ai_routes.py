from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from langchain_core.tools import StructuredTool

from refora_server.cli_runtime.tool_broker import CliToolBroker
from refora_server.db.errors import RepoError
from refora_server.server.routes.ai import create_ai_router


class FakeRuntime:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.resumed: list[dict[str, Any]] = []
        self.cancelled: list[str] = []
        self.deleted_threads: list[str] = []

    async def send(self, payload: dict[str, Any]) -> dict[str, str]:
        self.sent.append(payload)
        return {"runId": payload["runId"], "threadId": payload["threadId"]}

    async def start(self, payload: dict[str, Any]) -> dict[str, str]:
        return await self.send(payload)

    async def resume(self, payload: dict[str, Any]) -> str:
        self.resumed.append(payload)
        return payload["runId"]

    async def cancel(self, run_id: str) -> None:
        self.cancelled.append(run_id)

    async def deleteThread(self, thread_id: str) -> None:
        self.deleted_threads.append(thread_id)


class FakeSummaryService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def queueSummary(self, document_id: str, provider: dict[str, Any]) -> str:
        self.calls.append((document_id, provider))
        return "summary-1"


class FakeDocumentTextService:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def getOrExtract(self, document_id: str) -> str:
        self.calls.append(document_id)
        return "Extracted document text"


class FakeRepos:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.threads = {
            "thread-1": {
                "id": "thread-1",
                "workspaceId": "workspace-1",
                "providerId": "provider-1",
                "title": None,
                "headCheckpointId": None,
                "agentStateVersion": 2,
            },
            "thread-global": {
                "id": "thread-global",
                "workspaceId": None,
                "providerId": "provider-1",
                "title": "Global",
                "headCheckpointId": None,
                "agentStateVersion": 2,
            },
        }
        self.memories = {
            ("workspace", "workspace-1"): [
                {
                    "id": "memory-1",
                    "scope": "workspace",
                    "scopeId": "workspace-1",
                    "workspaceId": "workspace-1",
                    "path": "/brief.md",
                    "content": "Before",
                    "revision": 1,
                }
            ],
            ("global", "global"): [],
        }
        self.reports = {
            "report-1": {
                "id": "report-1",
                "workspaceId": "workspace-1",
                "title": "Original",
                "contentMd": "# Original",
                "sourceDocIds": ["doc-1"],
                "model": "model-1",
                "createdAt": 1,
            }
        }
        self.documents = {"get": self.get_document}
        self.settings = {
            "get": lambda key, default="": '"provider-1"'
            if key == "activeProviderId"
            else default
        }
        self.aiProviders = {
            "list": lambda: [{"id": "provider-1"}],
            "getRaw": lambda provider_id: {"id": provider_id} if provider_id == "provider-1" else None,
        }
        self.workspaces = {"list": lambda: [{"id": "workspace-1", "name": "Workspace"}]}
        self.workspaceItems = {"list": self.list_workspace_items}
        self.aiSummaries = {"getFullText": self.get_full_text, "getSummary": self.get_summary}
        self.chat = {
            "createThread": self.create_thread,
            "getThread": self.get_thread,
            "listThreads": self.list_threads,
            "listMessages": self.list_messages,
            "deleteThread": self.delete_thread,
            "updateTitle": self.update_title,
        }
        self.agentTraces = {
            "listByThread": self.list_traces,
            "usageStats": self.usage_stats,
        }
        self.agentRuns = {"listByThread": self.list_runs, "get": self.get_run}
        self.agentInterrupts = {"getPendingByRun": self.pending_interrupt}
        self.agentMemories = {
            "get": self.get_memory,
            "list": self.list_memories,
            "upsert": self.upsert_memory,
            "remove": self.remove_memory,
        }
        self.aiReports = {
            "list": self.list_reports,
            "get": self.get_report,
            "update": self.update_report,
            "delete": self.delete_report,
        }

    def get_document(self, document_id: str) -> dict[str, str] | None:
        self.calls.append(("documents.get", document_id))
        return {"id": document_id, "fileName": "Paper.pdf"} if document_id == "doc-1" else None

    def list_workspace_items(self, workspace_id: str) -> list[dict[str, Any]]:
        if workspace_id == "workspace-1":
            return [
                {"id": "item-1", "workspaceId": workspace_id, "kind": "document", "docId": "doc-1"},
            ]
        return []

    def create_thread(self, workspace_id: str | None, provider_id: str) -> dict[str, Any]:
        thread = {
            "id": "thread-new",
            "workspaceId": workspace_id,
            "providerId": provider_id,
            "title": None,
            "headCheckpointId": None,
            "agentStateVersion": 2,
        }
        self.threads[thread["id"]] = thread
        return thread

    def get_full_text(self, document_id: str) -> dict[str, str] | None:
        self.calls.append(("summaries.getFullText", document_id))
        return {"text": "Cached text"} if document_id == "doc-1" else None

    def get_summary(self, document_id: str) -> dict[str, Any] | None:
        self.calls.append(("summaries.getSummary", document_id))
        if document_id != "doc-1":
            return None
        return {"docId": "doc-1", "model": "model-1", "content": {"core": "Core"}}

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        self.calls.append(("chat.getThread", thread_id))
        return self.threads.get(thread_id)

    def list_threads(self, workspace_id: str | None) -> list[dict[str, Any]]:
        self.calls.append(("chat.listThreads", workspace_id))
        return [thread for thread in self.threads.values() if thread["workspaceId"] == workspace_id]

    def list_messages(self, thread_id: str) -> list[dict[str, Any]]:
        self.calls.append(("chat.listMessages", thread_id))
        return [
            {"id": "message-1", "threadId": thread_id, "role": "user", "content": "Hello"},
            {"id": "message-tool", "threadId": thread_id, "role": "tool", "content": "tool output"},
        ]

    def delete_thread(self, thread_id: str) -> None:
        self.calls.append(("chat.deleteThread", thread_id))
        del self.threads[thread_id]

    def update_title(self, thread_id: str, title: str) -> dict[str, Any]:
        self.calls.append(("chat.updateTitle", (thread_id, title)))
        self.threads[thread_id]["title"] = title
        return self.threads[thread_id]

    def list_traces(self, thread_id: str) -> list[dict[str, Any]]:
        self.calls.append(("traces.listByThread", thread_id))
        return [{"id": "trace-1", "threadId": thread_id, "runId": "run-1", "kind": "run"}]

    def usage_stats(self) -> dict[str, Any]:
        self.calls.append(("traces.usageStats", None))
        return {
            "totalTokens": 120,
            "inputTokens": 80,
            "outputTokens": 40,
            "conversationCount": 2,
            "turnCount": 3,
            "modelCallCount": 4,
            "activeDays": 1,
            "models": [{"model": "model-1", "tokens": 120, "calls": 4}],
            "activity": [{"date": "2026-07-29", "tokens": 120, "turns": 3}],
        }

    def list_runs(self, thread_id: str) -> list[dict[str, str]]:
        self.calls.append(("runs.listByThread", thread_id))
        return [{"id": "run-older"}, {"id": "run-1"}]

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        if run_id != "run-1":
            return None
        return {
            "id": "run-1",
            "threadId": "thread-1",
            "providerId": "provider-1",
            "modelId": "model-1",
            "status": "interrupted",
            "checkpointBefore": None,
            "checkpointAfter": "checkpoint-1",
            "replacesRunId": None,
            "userMessageId": "message-1",
            "assistantMessageId": None,
            "startedAt": 1,
            "endedAt": 2,
            "error": None,
        }

    def pending_interrupt(self, run_id: str) -> dict[str, Any] | None:
        self.calls.append(("interrupts.getPendingByRun", run_id))
        return {"id": "interrupt-1", "runId": run_id, "threadId": "thread-1", "status": "pending"} if run_id == "run-1" else None

    def list_memories(self, scope: str, scope_id: str) -> list[dict[str, Any]]:
        self.calls.append(("memories.list", (scope, scope_id)))
        return self.memories[(scope, scope_id)]

    def get_memory(self, scope: str, scope_id: str, path: str) -> dict[str, Any] | None:
        return next(
            (memory for memory in self.memories[(scope, scope_id)] if memory["path"] == path),
            None,
        )

    def upsert_memory(self, input: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("memories.upsert", input))
        entries = self.memories[(input["scope"], input["scopeId"])]
        memory = next((item for item in entries if item["path"] == input["path"]), None)
        if memory is None:
            memory = {
                "id": f"memory-{len(entries) + 1}",
                **input,
                "revision": 0,
            }
            entries.append(memory)
        memory.update({"content": input["content"], "revision": memory["revision"] + 1})
        return memory

    def remove_memory(self, scope: str, scope_id: str, path: str) -> int:
        self.calls.append(("memories.remove", (scope, scope_id, path)))
        self.memories[(scope, scope_id)] = [
            memory for memory in self.memories[(scope, scope_id)] if memory["path"] != path
        ]
        return 1

    def list_reports(self, workspace_id: str) -> list[dict[str, Any]]:
        self.calls.append(("reports.list", workspace_id))
        return [report for report in self.reports.values() if report["workspaceId"] == workspace_id]

    def get_report(self, report_id: str) -> dict[str, Any] | None:
        self.calls.append(("reports.get", report_id))
        return self.reports.get(report_id)

    def update_report(self, report_id: str, patch: dict[str, str]) -> dict[str, Any]:
        self.calls.append(("reports.update", (report_id, patch)))
        if report_id not in self.reports:
            raise RepoError("not_found", f"report not found: {report_id}")
        self.reports[report_id].update(patch)
        return self.reports[report_id]

    def delete_report(self, report_id: str) -> None:
        self.calls.append(("reports.delete", report_id))
        if report_id not in self.reports:
            raise RepoError("not_found", f"report not found: {report_id}")
        del self.reports[report_id]


def provider() -> dict[str, Any]:
    return {
        "model": "model-1",
        "baseUrl": "https://provider.invalid/v1",
        "apiKey": "request-only-secret",
        "useResponsesApi": False,
        "modelKwargs": {},
        "temperature": None,
        "maxTokens": None,
    }


def send_payload() -> dict[str, Any]:
    return {
        "runId": "run-1",
        "threadId": "thread-1",
        "workspaceId": "workspace-1",
        "text": "Hello",
        "providerId": "provider-1",
    }


def make_client(runtime: FakeRuntime | None = None):
    repos = FakeRepos()
    summary = FakeSummaryService()
    text = FakeDocumentTextService()
    runtime = runtime or FakeRuntime()

    class FakeProviderService:
        def getProvider(self, provider_id: str) -> dict[str, Any]:
            return {"id": provider_id}

        def buildProviderConfig(
            self,
            provider_id: str,
            api_key: str,
            *,
            model_id: str | None = None,
            features: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            return {
                **provider(),
                "apiKey": api_key,
                "model": model_id or "model-1",
            }

        def resolveProvider(self, provider_id: str, api_key: str) -> dict[str, Any]:
            return {**provider(), "id": provider_id, "apiKey": api_key}

        def getEncryptedApiKey(self, provider_id: str) -> bytes:
            return f"encrypted:{provider_id}".encode()

    class FakeConnector:
        async def decrypt_api_key(self, encrypted: bytes) -> dict[str, Any]:
            return {"ok": True, "data": {"apiKey": "request-only-secret"}}

    connector = FakeConnector()
    deleted_frontiers: list[str] = []

    class FakeFrontier:
        async def delete_thread(self, thread_id: str) -> None:
            deleted_frontiers.append(thread_id)

    async def require_token(request: Request) -> None:
        if request.headers.get("X-Refora-Token") != "test-token":
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthorized", "message": "Invalid or missing token"},
            )

    app = FastAPI()
    app.include_router(
        create_ai_router(
            {
                "repos": repos.__dict__,
                "services": {
                    "aiSummary": summary,
                    "documentText": text,
                    "aiProviders": FakeProviderService(),
                    "academic": {"frontier": FakeFrontier()},
                },
                "agentRuntime": runtime,
                "connector": connector,
                "require_token": require_token,
            }
        )
    )
    app.state.connector = connector
    app.state.db_path = "/tmp/refora-ai-routes-test.sqlite"
    app.state.library_folder = "/tmp/refora-ai-routes-library"
    app.state.deleted_frontiers = deleted_frontiers
    return TestClient(app), repos, summary, text, runtime


def request(client: TestClient, method: str, path: str, **kwargs: Any):
    headers = kwargs.pop("headers", {})
    return client.request(method, path, headers={"X-Refora-Token": "test-token", **headers}, **kwargs)


def test_cli_tool_route_serializes_structured_tool_result(tmp_path) -> None:
    broker = CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token")
    tool = StructuredTool.from_function(
        name="list_workspace_context",
        description="List workspace context",
        func=lambda: '{"workspaceId":"workspace-1","itemCount":0,"items":[]}',
    )
    config = broker.open_run("run-1", [tool])
    assert config is not None
    token = broker._runs["run-1"]["token"]
    app = FastAPI()
    app.include_router(
        create_ai_router({"services": {"cliToolBroker": broker}})
    )

    response = TestClient(app).post(
        "/ai/cli-tools/run-1/call",
        headers={"X-Refora-Run-Token": token},
        json={
            "name": "list_workspace_context",
            "arguments": {},
            "toolCallId": "mcp-call-1",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": '{"workspaceId":"workspace-1","itemCount":0,"items":[]}',
    }
    broker.close_run("run-1")


def test_token_dependency_returns_error_envelope() -> None:
    client, _, _, _, _ = make_client()

    response = client.get("/ai/summary/doc-1")

    assert response.status_code == 401
    assert response.json() == {
        "ok": False,
        "error": {"code": "unauthorized", "message": "Invalid or missing token"},
    }


def test_document_text_summary_and_request_only_provider_key() -> None:
    client, repos, summary, text, _ = make_client()

    doc_text = request(client, "GET", "/ai/doc-text/doc-1")
    started = request(client, "POST", "/ai/summarize", json={"documentId": "doc-1"})
    existing = request(client, "GET", "/ai/summary/doc-1")
    missing = request(client, "GET", "/ai/doc-text/missing")

    assert doc_text.json() == {"ok": True, "data": {"text": "Extracted document text"}}
    assert started.json() == {"ok": True, "data": {"summaryId": "summary-1"}}
    assert existing.json()["data"]["content"] == {"core": "Core"}
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    assert text.calls == ["doc-1"]
    assert summary.calls[0][0] == "doc-1"
    assert summary.calls[0][1]["apiKey"] == "request-only-secret"
    assert "request-only-secret" not in repr(repos.calls)


def test_send_resume_cancel_only_use_injected_runtime() -> None:
    client, repos, _, _, runtime = make_client()
    payload = send_payload()

    sent = request(client, "POST", "/ai/chat/send", json=payload)
    resumed = request(
        client,
        "POST",
        "/ai/chat/resume",
        json={"runId": "run-1", "threadId": "thread-1", "decisions": [{"action": "approve"}]},
    )
    cancelled = request(client, "POST", "/ai/chat/cancel", json={"runId": "run-1"})

    assert sent.json() == {
        "ok": True,
        "data": {"runId": "run-1", "threadId": "thread-1"},
    }
    assert resumed.json() == {"ok": True, "data": {"runId": "run-1"}}
    assert cancelled.json() == {"ok": True, "data": {"ack": True}}
    assert runtime.sent[0]["runId"] == "run-1"
    assert runtime.sent[0]["threadId"] == "thread-1"
    assert runtime.sent[0]["messages"][-1] == {"role": "user", "content": "Hello"}
    assert runtime.sent[0]["provider"]["apiKey"] == "request-only-secret"
    assert runtime.resumed[0]["runId"] == "run-1"
    assert runtime.resumed[0]["threadId"] == "thread-1"
    assert runtime.cancelled == ["run-1"]
    assert "request-only-secret" not in repr(repos.calls)


def test_chat_history_traces_interrupt_threads_and_memories() -> None:
    client, _, _, _, runtime = make_client()

    threads = request(client, "GET", "/ai/chat/threads", params={"workspaceId": "workspace-1"})
    history = request(client, "GET", "/ai/chat/threads/thread-1/history")
    traces = request(client, "GET", "/ai/chat/threads/thread-1/traces")
    usage = request(client, "GET", "/ai/usage")
    run = request(client, "GET", "/ai/chat/runs/run-1")
    interrupt = request(client, "GET", "/ai/chat/runs/run-1/pending-interrupt")
    renamed = request(client, "PATCH", "/ai/chat/threads/thread-1", json={"title": "Renamed"})
    memories = request(client, "GET", "/ai/memories", params={"workspaceId": "workspace-1"})
    updated_memory = request(
        client,
        "PUT",
        "/ai/memories",
        json={"workspaceId": "workspace-1", "path": "/brief.md", "value": "After"},
    )
    deleted_memory = request(
        client,
        "DELETE",
        "/ai/memories",
        params={"workspaceId": "workspace-1", "path": "/brief.md"},
    )
    deleted_thread = request(client, "DELETE", "/ai/chat/threads/thread-global")

    assert threads.json()["data"][0]["id"] == "thread-1"
    assert history.json()["data"][0]["content"] == "Hello"
    assert traces.json()["data"][0]["id"] == "trace-1"
    assert usage.json()["data"]["totalTokens"] == 120
    assert run.json()["data"]["status"] == "interrupted"
    assert interrupt.json()["data"]["id"] == "interrupt-1"
    assert renamed.json()["data"]["title"] == "Renamed"
    assert memories.json()["data"][0]["content"] == "Before"
    assert updated_memory.json()["data"]["content"] == "After"
    assert deleted_memory.json() == {"ok": True, "data": {"ack": True}}
    assert deleted_thread.json() == {"ok": True, "data": {"ack": True}}
    assert runtime.deleted_threads == ["thread-global"]
    assert client.app.state.deleted_frontiers == ["thread-global"]


def test_reports_and_error_envelopes() -> None:
    client, _, _, _, _ = make_client()

    reports = request(client, "GET", "/ai/reports", params={"workspaceId": "workspace-1"})
    updated = request(client, "PATCH", "/ai/reports/report-1", json={"title": "Updated"})
    deleted = request(client, "DELETE", "/ai/reports/report-1")
    missing_report = request(client, "DELETE", "/ai/reports/missing")
    missing_workspace = request(client, "GET", "/ai/reports")
    invalid_send = request(client, "POST", "/ai/chat/send", json={"runId": "run-1"})
    missing_thread = request(client, "GET", "/ai/chat/threads/missing/history")

    assert reports.json()["data"][0]["title"] == "Original"
    assert updated.json()["data"]["title"] == "Updated"
    assert deleted.json() == {"ok": True, "data": {"ack": True}}
    assert missing_report.status_code == 404
    assert missing_report.json()["error"]["code"] == "not_found"
    assert missing_workspace.status_code == 400
    assert missing_workspace.json()["error"]["code"] == "validation"
    assert invalid_send.status_code == 400
    assert invalid_send.json()["error"]["code"] == "validation"
    assert missing_thread.status_code == 404
    assert missing_thread.json()["error"]["code"] == "not_found"


def test_chat_intent_rejects_internal_runtime_fields_and_returns_python_thread_id() -> None:
    client, _, _, _, runtime = make_client()

    created = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-new",
            "workspaceId": None,
            "text": "Start a conversation",
            "providerId": "provider-1",
        },
    )
    rejected = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-injected",
            "workspaceId": None,
            "text": "Ignore the boundary",
            "providerId": "provider-1",
            "provider": provider(),
        },
    )

    assert created.json()["data"] == {
        "runId": "run-new",
        "threadId": "thread-new",
    }
    assert runtime.sent[-1]["threadId"] == "thread-new"
    assert runtime.sent[-1]["enabledToolNames"]
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "validation"


def test_existing_thread_allows_provider_switch_for_new_run() -> None:
    client, repos, _, _, runtime = make_client()

    response = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-provider-switch",
            "threadId": "thread-1",
            "workspaceId": "workspace-1",
            "text": "Use another provider",
            "providerId": "provider-2",
        },
    )

    assert response.status_code == 200
    assert runtime.sent[-1]["providerId"] == "provider-2"
    assert repos.threads["thread-1"]["providerId"] == "provider-1"


def test_replace_exchange_is_validated_before_runtime_mutation() -> None:
    client, repos, _, _, runtime = make_client()

    missing_thread = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-replace-new",
            "workspaceId": None,
            "text": "Retry",
            "providerId": "provider-1",
            "replaceLastExchange": True,
        },
    )
    wrong_run = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-replace-invalid",
            "threadId": "thread-1",
            "workspaceId": "workspace-1",
            "text": "Retry",
            "providerId": "provider-1",
            "replaceLastExchange": True,
            "replaceRunId": "run-other",
        },
    )

    assert missing_thread.status_code == 400
    assert wrong_run.status_code == 400
    assert runtime.sent == []
    assert repos.list_messages("thread-1")[0]["content"] == "Hello"


def test_chat_history_filters_tool_messages() -> None:
    client, _, _, _, _ = make_client()

    history = request(client, "GET", "/ai/chat/threads/thread-1/history")

    messages = history.json()["data"]
    assert [message["role"] for message in messages] == ["user"]
    assert all(message["role"] != "tool" for message in messages)


def test_chat_send_validates_attachment_workspace_ownership() -> None:
    client, _, _, _, runtime = make_client()

    valid = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-attach",
            "threadId": "thread-1",
            "workspaceId": "workspace-1",
            "text": "Read this",
            "providerId": "provider-1",
            "attachments": [{"type": "document", "docId": "doc-1"}],
        },
    )
    no_workspace = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-no-ws",
            "text": "Read this",
            "providerId": "provider-1",
            "attachments": [{"type": "document", "docId": "doc-1"}],
        },
    )
    foreign_doc = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-foreign",
            "threadId": "thread-1",
            "workspaceId": "workspace-1",
            "text": "Read this",
            "providerId": "provider-1",
            "attachments": [{"type": "document", "docId": "doc-missing"}],
        },
    )

    assert valid.status_code == 200
    assert valid.json()["data"]["runId"] == "run-attach"
    assert no_workspace.status_code == 400
    assert no_workspace.json()["error"]["code"] == "invalid_attachment"
    assert foreign_doc.status_code == 400
    assert foreign_doc.json()["error"]["code"] == "invalid_attachment"
    assert [sent["runId"] for sent in runtime.sent] == ["run-attach"]


def test_chat_send_adds_the_active_reader_document_to_agent_context() -> None:
    client, _, _, _, runtime = make_client()

    valid = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-reader",
            "threadId": "thread-global",
            "workspaceId": None,
            "activeDocumentId": "doc-1",
            "text": "Explain this paper",
            "providerId": "provider-1",
        },
    )
    missing = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-reader-missing",
            "threadId": "thread-global",
            "workspaceId": None,
            "activeDocumentId": "doc-missing",
            "text": "Explain this paper",
            "providerId": "provider-1",
        },
    )

    assert valid.status_code == 200
    assert "A paper is open in the active reader tab" in runtime.sent[0]["systemPrompt"]
    assert "Active reader paper:" in runtime.sent[0]["systemPrompt"]
    assert "docId=doc-1 | Paper.pdf | hasSummary=true" in runtime.sent[0]["systemPrompt"]
    assert runtime.sent[0]["activeDocumentId"] == "doc-1"
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "invalid_document"
    assert [sent["runId"] for sent in runtime.sent] == ["run-reader"]


def test_chat_send_reports_database_corruption_instead_of_internal_error() -> None:
    client, repos, _, _, runtime = make_client()

    def malformed_summary(_document_id: str) -> None:
        raise sqlite3.DatabaseError("database disk image is malformed")

    repos.aiSummaries["getSummary"] = malformed_summary

    response = request(
        client,
        "POST",
        "/ai/chat/send",
        json={
            "runId": "run-corrupt-database",
            "threadId": "thread-global",
            "workspaceId": None,
            "activeDocumentId": "doc-1",
            "text": "Explain this paper",
            "providerId": "provider-1",
        },
    )

    assert response.status_code == 500
    assert response.json() == {
        "ok": False,
        "error": {
            "code": "database_corrupt",
            "message": "Refora's local database is damaged. Quit Refora and restore or repair the library database.",
        },
    }
    assert runtime.sent == []
