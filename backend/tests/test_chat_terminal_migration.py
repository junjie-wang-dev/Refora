from conftest import make_chat_repo, make_workspaces_repo, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations


def test_terminal_message_migration_removes_legacy_protocol_copy() -> None:
    db = open_migrated_db()
    workspace = make_workspaces_repo(db)["create"]("Workspace")
    chat = make_chat_repo(db)
    thread = chat["createThread"](workspace["id"], "provider")
    cancelled_exact = chat["addMessage"](
        thread["id"], "assistant", "[Response cancelled by user]"
    )
    cancelled_partial = chat["addMessage"](
        thread["id"],
        "assistant",
        "Partial cancelled\n\n[Response cancelled by user]",
    )
    failed_partial = chat["addMessage"](
        thread["id"],
        "assistant",
        "Partial failed\n\n[Response interrupted: provider disconnected]",
    )
    completed_legacy_text = chat["addMessage"](
        thread["id"], "assistant", "[Response cancelled by user]"
    )
    for run_id, status, message_id, started_at in (
        ("cancel-exact", "cancelled", cancelled_exact["id"], 1),
        ("cancel-partial", "cancelled", cancelled_partial["id"], 2),
        ("failed-partial", "failed", failed_partial["id"], 3),
        ("completed", "completed", completed_legacy_text["id"], 4),
    ):
        db.execute(
            "INSERT INTO agent_runs "
            "(id, threadId, providerId, modelId, status, assistantMessageId, startedAt) "
            "VALUES (?, ?, 'provider', 'model', ?, ?, ?)",
            [run_id, thread["id"], status, message_id, started_at],
        )
    db.execute("PRAGMA user_version = 37")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 40
    messages = {message["id"]: message for message in chat["listMessages"](thread["id"])}
    assert cancelled_exact["id"] not in messages
    assert messages[cancelled_partial["id"]]["content"] == "Partial cancelled"
    assert messages[cancelled_partial["id"]]["runStatus"] == "cancelled"
    assert messages[failed_partial["id"]]["content"] == "Partial failed"
    assert messages[failed_partial["id"]]["runStatus"] == "failed"
    assert messages[completed_legacy_text["id"]]["content"] == (
        "[Response cancelled by user]"
    )
    assert db.execute(
        "SELECT assistantMessageId FROM agent_runs WHERE id = 'cancel-exact'"
    ).fetchone()["assistantMessageId"] is None
    assert db.execute(
        "SELECT COUNT(*) FROM legacy_chat_terminal_cleanup"
    ).fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM sqlite_master "
        "WHERE type = 'index' AND name = 'idx_agent_runs_assistant_message'"
    ).fetchone()[0] == 1
