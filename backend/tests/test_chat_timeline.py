from conftest import LATEST_SCHEMA_VERSION
import base64
import json
import sqlite3

import pytest

from conftest import make_agent_runs_repo, make_agent_traces_repo, make_chat_repo, open_migrated_db
from refora_server.db import migrations
from refora_server.db.connection import _SqliteAdapter
from refora_server.repositories.errors import RepoError
from refora_server.services.chat_attachments import attachment_snapshots, display_message


@pytest.fixture
def db():
    connection = open_migrated_db()
    yield connection
    connection.close()


def add_message(db, thread_id, message_id, role="user", timestamp=1000, content=None):
    db.execute(
        "INSERT INTO chat_messages(id, threadId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        [message_id, thread_id, role, content or message_id, timestamp],
    )


def add_step(repo, thread_id, run_id, step_id):
    return repo["addStep"]({
        "id": step_id, "threadId": thread_id, "runId": run_id,
        "kind": "tool", "name": "read_paper", "status": "running",
        "startedAt": 1000, "seq": 0,
    })


def open_version_40(monkeypatch):
    connection = sqlite3.connect(":memory:", isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    prior_migrations = [item for item in migrations.load_migration_files() if item.version <= 40]
    with monkeypatch.context() as patch:
        patch.setattr(migrations, "load_migration_files", lambda: prior_migrations)
        result = migrations.run_migrations(_SqliteAdapter(connection))
    assert result.to_version == 40
    assert not _SqliteAdapter(connection).has_column("chat_messages", "attachments")
    assert not _SqliteAdapter(connection).has_column("agent_trace_steps", "revision")
    return connection


def test_history_pages_preserve_timestamp_ties_and_do_not_shift_after_concurrent_insert(db):
    chat = make_chat_repo(db)
    thread_id = chat["createThread"](None, "provider")["id"]
    for index in range(7):
        add_message(db, thread_id, f"message-{index}", "user" if index % 2 == 0 else "assistant")
    add_message(db, thread_id, "tool-message", "tool")
    add_message(db, thread_id, "system-message", "system")

    latest = chat["listMessagesPage"](thread_id, limit=3)
    assert [item["id"] for item in latest["messages"]] == ["message-4", "message-5", "message-6"]
    add_message(db, thread_id, "concurrent", "assistant")
    older = chat["listMessagesPage"](thread_id, latest["nextCursor"], 3)
    oldest = chat["listMessagesPage"](thread_id, older["nextCursor"], 3)
    assert [item["id"] for item in older["messages"]] == ["message-1", "message-2", "message-3"]
    assert [item["id"] for item in oldest["messages"]] == ["message-0"]
    assert oldest["nextCursor"] is None
    assert chat["listMessagesPage"](thread_id, limit=1)["messages"][0]["id"] == "concurrent"


def test_history_pages_use_timestamp_before_insertion_order_and_cursor_survives_deletion(db):
    chat = make_chat_repo(db)
    thread_id = chat["createThread"](None, "provider")["id"]
    add_message(db, thread_id, "newer", timestamp=2000)
    add_message(db, thread_id, "older", timestamp=1000)
    latest = chat["listMessagesPage"](thread_id, limit=1)
    assert latest["messages"][0]["id"] == "newer"
    db.execute("DELETE FROM chat_messages WHERE id = 'newer'")
    assert chat["listMessagesPage"](thread_id, latest["nextCursor"], 1)["messages"][0]["id"] == "older"


def test_history_cursor_cannot_be_reused_for_another_thread(db):
    chat = make_chat_repo(db)
    source = chat["createThread"](None, "provider")["id"]
    destination = chat["createThread"](None, "provider")["id"]
    add_message(db, source, "first")
    add_message(db, source, "second")
    cursor = chat["listMessagesPage"](source, limit=1)["nextCursor"]
    with pytest.raises(RepoError, match="Invalid history cursor"):
        chat["listMessagesPage"](destination, cursor)


@pytest.mark.parametrize("cursor", ["bad-cursor", "a" * 501, 10, base64.urlsafe_b64encode(b'["thread",true,1]').decode()])
def test_history_rejects_malformed_cursors(db, cursor):
    with pytest.raises(RepoError, match="Invalid history cursor"):
        make_chat_repo(db)["listMessagesPage"]("thread", cursor)


@pytest.mark.parametrize("limit", [0, 101, True, 2.5, "10"])
def test_history_rejects_invalid_page_sizes(db, limit):
    with pytest.raises(RepoError, match="History page size"):
        make_chat_repo(db)["listMessagesPage"]("thread", limit=limit)


def test_history_associates_user_and_assistant_with_latest_run_at_same_timestamp(db):
    chat = make_chat_repo(db)
    runs = make_agent_runs_repo(db)
    thread_id = chat["createThread"](None, "provider")["id"]
    question = chat["addMessage"](thread_id, "user", "Question")
    answer = chat["addMessage"](thread_id, "assistant", "Answer")
    for run_id, status in [("z-earlier", "failed"), ("a-latest", "completed")]:
        runs["create"]({
            "id": run_id, "threadId": thread_id, "providerId": "provider",
            "modelId": "model", "userMessageId": question["id"], "startedAt": 1000,
        })
        runs["update"](run_id, {"assistantMessageId": answer["id"], "status": status})
    messages = chat["listMessagesPage"](thread_id)["messages"]
    assert len(messages) == 2
    assert all(item["runId"] == "a-latest" and item["runStatus"] == "completed" for item in messages)


def test_trace_updates_after_cursor_are_delivered_once_and_scoped_to_requested_run(db):
    thread_id = make_chat_repo(db)["createThread"](None, "provider")["id"]
    traces = make_agent_traces_repo(db)
    first = add_step(traces, thread_id, "run-one", "step-one")
    other = add_step(traces, thread_id, "run-two", "step-two")
    initial = traces["listRunChanges"]("run-one")
    assert [item["id"] for item in initial["traces"]] == [first["id"]]
    assert initial["revision"] == first["revision"]
    traces["updateStep"](other["id"], {"status": "done", "output": "Other result"})
    assert traces["listRunChanges"]("run-one", initial["revision"]) == {
        "traces": [], "revision": initial["revision"],
    }
    completed = traces["updateStep"](first["id"], {"status": "done", "output": "Evidence", "endedAt": 2000})
    delta = traces["listRunChanges"]("run-one", initial["revision"])
    assert delta["traces"] == [completed]
    assert completed["revision"] > other["revision"]
    assert traces["listRunChanges"]("run-one", delta["revision"])["traces"] == []
    new_step = add_step(traces, thread_id, "run-one", "next-step")
    assert traces["listRunChanges"]("run-one", delta["revision"])["traces"] == [new_step]


def test_trace_history_filters_by_both_thread_and_runs(db):
    chat = make_chat_repo(db)
    source = chat["createThread"](None, "provider")["id"]
    other = chat["createThread"](None, "provider")["id"]
    traces = make_agent_traces_repo(db)
    own = add_step(traces, source, "run-one", "own")
    add_step(traces, other, "run-two", "other")
    assert traces["listByRuns"](source, ["run-one", "run-two"]) == [own]
    assert traces["listByRuns"](source, []) == []


def test_message_metadata_keeps_model_context_and_clean_display_separate(db):
    chat = make_chat_repo(db)
    thread_id = chat["createThread"](None, "provider")["id"]
    attachments = [{"type": "document", "docId": "paper", "title": "Research paper"}]
    raw = "Compare findings\n\n[Attached workspace files]\n- type: document\n  docId: paper\n  itemId: card"
    saved = chat["addMessage"](thread_id, "user", raw, {
        "displayContent": "Compare findings", "attachments": attachments, "activeDocumentId": "paper",
    })
    reread = chat["listMessagesPage"](thread_id)["messages"][0]
    assert reread["content"] == saved["content"] == raw
    assert reread["attachments"] == attachments
    visible = display_message(reread)
    assert visible["content"] == "Compare findings"
    assert visible["attachments"] == attachments
    assert visible["activeDocumentId"] == "paper"
    assert "displayContent" not in visible
    assert reread["content"] == raw
    empty_display = {**reread, "displayContent": ""}
    assert display_message(empty_display)["content"] == ""


def test_legacy_attachment_blocks_become_cards_without_changing_canonical_message(db):
    chat = make_chat_repo(db)
    thread_id = chat["createThread"](None, "provider")["id"]
    raw = (
        "Read these\n\n[Attached workspace files]\n"
        "- type: document\n  docId: paper\n  itemId: card-one\n  title: Paper title\n"
        "- type: asset\n  assetId: asset\n  itemId: card-two\n  fileName: data.csv"
    )
    saved = chat["addMessage"](thread_id, "user", raw)
    visible = display_message(saved)
    assert visible["content"] == "Read these"
    assert visible["attachments"] == [
        {"type": "document", "docId": "paper", "title": "Paper title"},
        {"type": "asset", "assetId": "asset", "title": "data.csv"},
    ]
    assert chat["listMessages"](thread_id)[0]["content"] == raw
    assert display_message({**saved, "role": "assistant"})["content"] == raw


@pytest.mark.parametrize("block", [
    "User-authored notes", "- type: unknown\n  itemId: card", "- type: document\n  docId: paper",
])
def test_legacy_parser_preserves_unrecognized_user_text(block):
    content = f"Question\n\n[Attached workspace files]\n{block}"
    assert display_message({"role": "user", "content": content}) == {"role": "user", "content": content}


def test_attachment_titles_come_from_local_records_and_duplicate_references_are_removed():
    snapshots = attachment_snapshots({
        "documents": {"get": lambda identifier: {"title": "Local title"} if identifier == "paper" else None},
        "workspaceAssets": {"get": lambda _: {"fileName": "results.csv"}},
    }, [
        {"type": "document", "docId": "paper", "title": "Untrusted title"},
        {"type": "document", "docId": "paper"},
        {"type": "asset", "assetId": "asset"},
        {"type": "document", "docId": "missing", "title": "Invented title"},
    ])
    assert snapshots == [
        {"type": "document", "docId": "paper", "title": "Local title"},
        {"type": "asset", "assetId": "asset", "title": "results.csv"},
        {"type": "document", "docId": "missing"},
    ]


def test_version_40_upgrade_preserves_messages_and_traces_and_replay_preserves_revisions(monkeypatch):
    db = open_version_40(monkeypatch)
    try:
        thread_id = make_chat_repo(db)["createThread"](None, "provider")["id"]
        add_message(db, thread_id, "legacy-question", content="Original question")
        db.execute(
            "INSERT INTO agent_trace_steps(id, threadId, runId, kind, status, startedAt, seq, output) "
            "VALUES ('legacy-step', ?, 'legacy-run', 'tool', 'done', 1000, 0, 'Original evidence')",
            [thread_id],
        )
        result = migrations.run_migrations(_SqliteAdapter(db))
        assert result.from_version == 40 and result.to_version == LATEST_SCHEMA_VERSION
        message = db.execute("SELECT * FROM chat_messages WHERE id = 'legacy-question'").fetchone()
        assert message["content"] == "Original question"
        assert message["displayContent"] is None and json.loads(message["attachments"]) == []
        assert message["activeDocumentId"] is None
        traces = make_agent_traces_repo(db)
        prior = traces["listRunChanges"]("legacy-run")
        assert prior["revision"] > 0
        assert prior["traces"][0]["output"] == "Original evidence"
        migrations.run_migrations(_SqliteAdapter(db))
        assert traces["listRunChanges"]("legacy-run") == prior
        changed = traces["updateStep"]("legacy-step", {"output": "Updated evidence"})
        assert changed["revision"] > prior["revision"]
        assert traces["listRunChanges"]("legacy-run", prior["revision"])["traces"] == [changed]
        inserted = add_step(traces, thread_id, "legacy-run", "new-step")
        assert inserted["revision"] > changed["revision"]
    finally:
        db.close()


def test_timeline_upgrade_rolls_back_all_schema_changes_if_migration_fails(monkeypatch):
    db = open_version_40(monkeypatch)
    try:
        thread_id = make_chat_repo(db)["createThread"](None, "provider")["id"]
        add_message(db, thread_id, "preserved")
        broken_migrations = [
            migrations.MigrationFile(item.version, item.sql + "\nINVALID SQL;")
            if item.version == 41 else item
            for item in migrations.load_migration_files()
        ]
        monkeypatch.setattr(migrations, "load_migration_files", lambda: broken_migrations)
        with pytest.raises(sqlite3.OperationalError):
            migrations.run_migrations(_SqliteAdapter(db))
        adapter = _SqliteAdapter(db)
        assert adapter.get_user_version() == 40
        assert not adapter.has_column("chat_messages", "attachments")
        assert not adapter.has_column("agent_trace_steps", "revision")
        assert not adapter.has_object("table", "agent_trace_clock")
        assert db.execute("SELECT content FROM chat_messages WHERE id = 'preserved'").fetchone()[0] == "preserved"
    finally:
        db.close()


def test_legacy_attachment_display_preserves_user_prose_after_reference():
    content = (
        'Question\n\n[Attached workspace files]\n'
        '- type: document\n  itemId: card\n  docId: paper\n  title: Paper\n'
        'Additional instructions written by the user.'
    )
    message = {'role': 'user', 'content': content}
    assert display_message(message)['content'] == content


def test_chat_search_snippet_uses_display_content(db):
    from refora_server.repositories import create_repositories

    repos = create_repositories(db)
    thread = repos['chat']['createThread'](None, 'provider')
    repos['chat']['addMessage'](thread['id'], 'user', 'Discuss evidence\n[Attached workspace files]\nitemId: hidden-internal-id', {
        'displayContent': 'Discuss evidence',
        'attachments': [{'type': 'document', 'docId': 'paper', 'title': 'Named paper'}],
    })
    results = repos['chat']['search']('evidence')
    assert results[0]['snippet'] == 'Discuss evidence'
    assert repos['chat']['search']('hidden-internal-id') == []
