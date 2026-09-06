import sqlite3

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories
from refora_server.server.routes.ai import create_ai_router


@pytest.fixture
def timeline():
    db = sqlite3.connect(":memory:", isolation_level=None, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    run_migrations(_SqliteAdapter(db))
    repos = create_repositories(db)
    thread = repos["chat"]["createThread"](None, "provider")

    def authorize(request):
        if request.headers.get("X-Refora-Token") != "local-test":
            raise HTTPException(status_code=401, detail="Token required")

    app = FastAPI()
    app.include_router(create_ai_router({"repos": repos, "require_token": authorize}))
    with TestClient(app, headers={"X-Refora-Token": "local-test"}) as client:
        yield repos, thread["id"], client
    db.close()


def create_run(repos, thread_id, run_id, user_id=None):
    return repos["agentRuns"]["create"]({
        "id": run_id, "threadId": thread_id, "providerId": "provider", "modelId": "model",
        "status": "running", "userMessageId": user_id,
    })


def add_step(repos, thread_id, run_id, output="First"):
    return repos["agentTraces"]["addStep"]({
        "threadId": thread_id, "runId": run_id, "kind": "message", "status": "running",
        "name": "assistant_message", "output": output, "startedAt": 1, "seq": 1,
    })


def test_history_page_scopes_traces_and_keeps_pending_run(timeline):
    repos, thread_id, client = timeline
    first = repos["chat"]["addMessage"](thread_id, "user", "Old question")
    create_run(repos, thread_id, "old", first["id"])
    add_step(repos, thread_id, "old", "Old answer")
    repos["agentRuns"]["update"]("old", {"status": "completed"})
    current = repos["chat"]["addMessage"](thread_id, "user", "Question\ninternal context", {
        "displayContent": "Question", "attachments": [{"type": "document", "docId": "paper", "title": "Named paper"}],
        "activeDocumentId": None,
    })
    create_run(repos, thread_id, "current", current["id"])
    add_step(repos, thread_id, "current")
    repos["agentRuns"]["update"]("current", {"status": "interrupted"})

    response = client.get(f"/ai/chat/threads/{thread_id}/history-page", params={"limit": 1})
    assert response.status_code == 200
    page = response.json()["data"]
    assert page["messages"][0]["content"] == "Question"
    assert page["messages"][0]["attachments"][0]["title"] == "Named paper"
    assert page["messages"][0]["activeDocumentId"] is None
    assert page["messages"][0]["runId"] == "current"
    assert "displayContent" not in page["messages"][0]
    assert {step["runId"] for step in page["traces"]} == {"current"}
    assert page["activeRun"]["status"] == "interrupted"

    older = client.get(f"/ai/chat/threads/{thread_id}/history-page", params={"before": page["nextCursor"], "limit": 1}).json()["data"]
    assert [message["id"] for message in older["messages"]] == [first["id"]]
    assert {step["runId"] for step in older["traces"]} == {"old"}
    assert older["activeRun"] is None
    assert older["nextCursor"] is None
    assert repos["chat"]["listMessages"](thread_id)[-1]["content"] == "Question\ninternal context"
    assert client.get(f"/ai/chat/threads/{thread_id}/history").json()["data"][-1]["content"] == "Question"


def test_run_snapshot_returns_only_changed_steps_and_terminal_status(timeline):
    repos, thread_id, client = timeline
    create_run(repos, thread_id, "run")
    step = add_step(repos, thread_id, "run")
    create_run(repos, thread_id, "other")
    add_step(repos, thread_id, "other", "Unrelated")
    first = client.get("/ai/chat/runs/run/snapshot").json()["data"]
    assert [item["id"] for item in first["traces"]] == [step["id"]]
    unchanged = client.get("/ai/chat/runs/run/snapshot", params={"afterRevision": first["revision"]}).json()["data"]
    assert unchanged["traces"] == []
    repos["agentTraces"]["updateStep"](step["id"], {"output": "Finished", "status": "done", "endedAt": 2})
    repos["agentRuns"]["update"]("run", {"status": "completed", "endedAt": 2})
    finished = client.get("/ai/chat/runs/run/snapshot", params={"afterRevision": first["revision"]}).json()["data"]
    assert finished["run"]["status"] == "completed"
    assert finished["traces"][0]["output"] == "Finished"
    assert finished["revision"] > first["revision"]


def test_timeline_endpoints_validate_scope_cursor_and_authorization(timeline):
    repos, thread_id, client = timeline
    create_run(repos, thread_id, "run")
    for endpoint in [f"/ai/chat/threads/{thread_id}/history-page", "/ai/chat/runs/run/snapshot"]:
        response = client.get(endpoint, headers={"X-Refora-Token": "wrong"})
        assert response.status_code == 401
        assert response.json()["ok"] is False
    for params in [{"before": "invalid"}, {"limit": 0}, {"limit": 101}]:
        response = client.get(f"/ai/chat/threads/{thread_id}/history-page", params=params)
        assert response.status_code == 400
        assert response.json()["ok"] is False
    assert client.get("/ai/chat/threads/missing/history-page").status_code == 404
    assert client.get("/ai/chat/runs/missing/snapshot").status_code == 404
    assert client.get("/ai/chat/runs/run/snapshot", params={"afterRevision": -1}).status_code == 400
