import pytest

from conftest import make_chat_repo, make_workspaces_repo, open_migrated_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def test_create_thread_with_workspace(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "provider-1")
    assert thread["id"]
    assert thread["workspaceId"] == w["id"]
    assert thread["providerId"] == "provider-1"
    assert thread["createdAt"] > 0
    assert thread["title"] is None
    assert thread["headCheckpointId"] is None
    assert thread["agentStateVersion"] == 0


def test_create_thread_global(db):
    chat = make_chat_repo(db)
    thread = chat["createThread"](None, "provider-1")
    assert thread["workspaceId"] is None
    assert thread["providerId"] == "provider-1"


def test_create_thread_returns_stable_id(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "provider-1")
    got = chat["getThread"](thread["id"])
    assert got is not None
    assert got["id"] == thread["id"]
    assert got == thread


def test_get_thread_missing_returns_none(db):
    chat = make_chat_repo(db)
    assert chat["getThread"]("nonexistent") is None


def test_list_threads_empty(db):
    chat = make_chat_repo(db)
    assert chat["listThreads"](None) == []


def test_list_threads_workspace_scoped(db):
    ws = make_workspaces_repo(db)
    w1 = ws["create"]("One")
    w2 = ws["create"]("Two")
    chat = make_chat_repo(db)
    t1 = chat["createThread"](w1["id"], "p1")
    t2 = chat["createThread"](w2["id"], "p2")

    in_w1 = chat["listThreads"](w1["id"])
    assert [t["id"] for t in in_w1] == [t1["id"]]
    in_w2 = chat["listThreads"](w2["id"])
    assert [t["id"] for t in in_w2] == [t2["id"]]


def test_list_threads_global_isolated(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    global_thread = chat["createThread"](None, "p1")
    ws_thread = chat["createThread"](w["id"], "p2")

    global_only = chat["listThreads"](None)
    assert [t["id"] for t in global_only] == [global_thread["id"]]
    assert ws_thread["id"] not in [t["id"] for t in global_only]


def test_list_threads_orders_by_createdAt_desc(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    t1 = chat["createThread"](w["id"], "p1")
    t2 = chat["createThread"](w["id"], "p2")
    db.execute(
        f"UPDATE chat_threads SET createdAt = {t1['createdAt'] + 1000} WHERE id = '{t1['id']}'"
    )
    ids = [t["id"] for t in chat["listThreads"](w["id"])]
    assert ids == [t1["id"], t2["id"]]


def test_update_title(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    updated = chat["updateTitle"](thread["id"], "New Title")
    assert updated["title"] == "New Title"
    assert updated["id"] == thread["id"]
    assert chat["getThread"](thread["id"])["title"] == "New Title"


def test_update_title_missing_raises(db):
    chat = make_chat_repo(db)
    with pytest.raises(RepoError) as exc:
        chat["updateTitle"]("missing", "Title")
    assert exc.value.code == "not_found"


def test_delete_thread(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["deleteThread"](thread["id"])
    assert chat["getThread"](thread["id"]) is None
    assert chat["listThreads"](w["id"]) == []


def test_delete_thread_missing_raises(db):
    chat = make_chat_repo(db)
    with pytest.raises(RepoError) as exc:
        chat["deleteThread"]("missing")
    assert exc.value.code == "not_found"


def test_delete_thread_cascades_messages(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "user", "hi")
    chat["addMessage"](thread["id"], "assistant", "hello")
    assert len(chat["listMessages"](thread["id"])) == 2

    chat["deleteThread"](thread["id"])
    assert chat["listMessages"](thread["id"]) == []


def test_delete_thread_cascades_agent_tables(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")

    db.execute(
        "INSERT INTO agent_runs (id, threadId, providerId, modelId, status, startedAt) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ["run-1", thread["id"], "p1", "model-1", "running", 1],
    )
    db.execute(
        "INSERT INTO agent_trace_steps "
        "(id, threadId, runId, kind, status, startedAt, seq) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["step-1", thread["id"], "run-1", "llm", "done", 1, 0],
    )

    assert db.execute(
        "SELECT COUNT(*) FROM agent_runs WHERE threadId = ?", [thread["id"]]
    ).fetchone()[0] == 1
    assert db.execute(
        "SELECT COUNT(*) FROM agent_trace_steps WHERE threadId = ?", [thread["id"]]
    ).fetchone()[0] == 1

    chat["deleteThread"](thread["id"])

    assert db.execute(
        "SELECT COUNT(*) FROM agent_runs WHERE threadId = ?", [thread["id"]]
    ).fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM agent_trace_steps WHERE threadId = ?", [thread["id"]]
    ).fetchone()[0] == 0


def test_add_message(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    msg = chat["addMessage"](thread["id"], "user", "Hello")
    assert msg["id"]
    assert msg["threadId"] == thread["id"]
    assert msg["role"] == "user"
    assert msg["content"] == "Hello"
    assert msg["createdAt"] > 0


def test_list_messages_ordered_by_createdAt(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    m1 = chat["addMessage"](thread["id"], "user", "first")
    m2 = chat["addMessage"](thread["id"], "assistant", "second")
    m3 = chat["addMessage"](thread["id"], "user", "third")
    messages = chat["listMessages"](thread["id"])
    assert [m["id"] for m in messages] == [m1["id"], m2["id"], m3["id"]]


def test_list_messages_empty(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    assert chat["listMessages"](thread["id"]) == []


def test_search_matches_messages_and_returns_workspace_context(db):
    workspace = make_workspaces_repo(db)["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](workspace["id"], "p1")
    chat["updateTitle"](thread["id"], "Architecture")
    message = chat["addMessage"](
        thread["id"], "user", "Explain the latent representation"
    )

    results = chat["search"]("latent representation")

    assert results == [
        {
            "threadId": thread["id"],
            "workspaceId": workspace["id"],
            "workspaceName": "Research",
            "title": "Architecture",
            "snippet": "Explain the latent representation",
            "role": "user",
            "matchedAt": message["createdAt"],
        }
    ]
    assert chat["search"]("   ") == []


def test_delete_last_exchange_removes_pair(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "user", "q1")
    chat["addMessage"](thread["id"], "assistant", "a1")
    chat["addMessage"](thread["id"], "user", "q2")
    chat["addMessage"](thread["id"], "assistant", "a2")

    deleted = chat["deleteLastExchange"](thread["id"])
    assert deleted == 2
    messages = chat["listMessages"](thread["id"])
    assert len(messages) == 2
    assert messages[0]["content"] == "q1"
    assert messages[1]["content"] == "a1"


def test_delete_last_exchange_only_user_no_assistant(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "user", "q1")
    chat["addMessage"](thread["id"], "assistant", "a1")
    chat["addMessage"](thread["id"], "user", "q2")

    deleted = chat["deleteLastExchange"](thread["id"])
    assert deleted == 1
    messages = chat["listMessages"](thread["id"])
    assert len(messages) == 2
    assert messages[0]["content"] == "q1"
    assert messages[1]["content"] == "a1"


def test_delete_last_exchange_includes_trailing_tool_messages(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "user", "q1")
    chat["addMessage"](thread["id"], "assistant", "a1")
    chat["addMessage"](thread["id"], "tool", "tool-result")
    chat["addMessage"](thread["id"], "user", "q2")
    chat["addMessage"](thread["id"], "assistant", "a2")
    chat["addMessage"](thread["id"], "tool", "tool-result-2")

    deleted = chat["deleteLastExchange"](thread["id"])
    assert deleted == 3
    messages = chat["listMessages"](thread["id"])
    assert len(messages) == 3
    assert messages[-1]["content"] == "tool-result"


def test_delete_last_exchange_no_user_messages_returns_zero(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "assistant", "a1")
    chat["addMessage"](thread["id"], "tool", "t1")

    deleted = chat["deleteLastExchange"](thread["id"])
    assert deleted == 0
    assert len(chat["listMessages"](thread["id"])) == 2


def test_delete_last_exchange_empty_thread(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    assert chat["deleteLastExchange"](thread["id"]) == 0


def test_delete_last_exchange_multiple_calls(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["addMessage"](thread["id"], "user", "q1")
    chat["addMessage"](thread["id"], "assistant", "a1")
    chat["addMessage"](thread["id"], "user", "q2")
    chat["addMessage"](thread["id"], "assistant", "a2")

    assert chat["deleteLastExchange"](thread["id"]) == 2
    assert chat["deleteLastExchange"](thread["id"]) == 2
    assert chat["listMessages"](thread["id"]) == []
    assert chat["deleteLastExchange"](thread["id"]) == 0


def test_update_agent_state(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    updated = chat["updateAgentState"](thread["id"], "ckpt-1", 3)
    assert updated["headCheckpointId"] == "ckpt-1"
    assert updated["agentStateVersion"] == 3
    assert updated["id"] == thread["id"]


def test_update_agent_state_null_checkpoint(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    chat["updateAgentState"](thread["id"], "ckpt-1", 2)
    updated = chat["updateAgentState"](thread["id"], None, 0)
    assert updated["headCheckpointId"] is None
    assert updated["agentStateVersion"] == 0


def test_update_agent_state_missing_raises(db):
    chat = make_chat_repo(db)
    with pytest.raises(RepoError) as exc:
        chat["updateAgentState"]("missing", None, 0)
    assert exc.value.code == "not_found"


def test_field_contract_matches_chat_thread_type(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    assert set(thread.keys()) == {
        "id",
        "workspaceId",
        "providerId",
        "createdAt",
        "title",
        "headCheckpointId",
        "agentStateVersion",
    }


def test_field_contract_matches_chat_message_type(db):
    ws = make_workspaces_repo(db)
    w = ws["create"]("Research")
    chat = make_chat_repo(db)
    thread = chat["createThread"](w["id"], "p1")
    msg = chat["addMessage"](thread["id"], "user", "hi")
    assert set(msg.keys()) == {"id", "threadId", "role", "content", "createdAt"}
