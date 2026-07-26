from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

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

    async def summarize(self, document_id: str, provider: dict[str, Any]) -> str:
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
        self.workspaceItems = {"list": lambda workspace_id: []}
        self.aiSummaries = {"getFullText": self.get_full_text, "getSummary": self.get_summary}
        self.chat = {
            "createThread": self.create_thread,
            "getThread": self.get_thread,
            "listThreads": self.list_threads,
            "listMessages": self.list_messages,
            "deleteThread": self.delete_thread,
            "updateTitle": self.update_title,
        }
        self.agentTraces = {"listByThread": self.list_traces}
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
        return [{"id": "message-1", "threadId": thread_id, "role": "user", "content": "Hello"}]

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
            "checkpointBefore": None,
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

    class FakeConnector:
        async def get_api_key(self, provider_id: str) -> dict[str, Any]:
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
    assert text.calls == ["doc-1", "doc-1"]
    assert summary.calls[0][0] == "doc-1"
    assert summary.calls[0][1]["__text"] == "Extracted document text"
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
