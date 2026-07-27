import json

import pytest

from conftest import insert_message, insert_thread, make_chat_repo, open_migrated_db
from refora_server.services.chat_history import (
    createChatHistoryService,
    historyToMessages,
    parseToolPayload,
    sanitizeToolCallPairs,
    truncateHistoryByTokens,
    truncateOutput,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def chat_repo(db):
    return make_chat_repo(db)


def _svc(chat_repo):
    return createChatHistoryService({"chat": chat_repo})


def test_build_history_messages_user_and_assistant(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, id="m1", role="user", content="hello")
    insert_message(db, threadId=thread, id="m2", role="assistant", content="hi there")
    msgs = _svc(chat_repo)["buildHistoryMessages"](thread)
    assert msgs == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
    ]


def test_build_history_messages_tool_injects_assistant_call(chat_repo, db):
    thread = insert_thread(db, id="t1")
    payload = json.dumps(
        {"name": "search", "toolCallId": "call-1", "input": "query", "output": "result text"}
    )
    insert_message(db, threadId=thread, id="m1", role="tool", content=payload)
    msgs = _svc(chat_repo)["buildHistoryMessages"](thread)
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] == ""
    assert msgs[0]["tool_calls"] == [
        {"id": "call-1", "name": "search", "args": {"raw": "query"}}
    ]
    assert msgs[1] == {
        "role": "tool",
        "content": "result text",
        "tool_call_id": "call-1",
        "name": "search",
    }


def test_build_history_messages_consecutive_tool_calls_each_get_assistant(chat_repo, db):
    thread = insert_thread(db, id="t1")
    first = json.dumps({"name": "one", "input": "{}", "output": "1"})
    second = json.dumps(
        {"v": 2, "name": "two", "toolCallId": "call-2", "input": "{}", "output": "2"}
    )
    insert_message(db, threadId=thread, id="m1", role="tool", content=first)
    insert_message(db, threadId=thread, id="m2", role="tool", content=second)
    msgs = _svc(chat_repo)["buildHistoryMessages"](thread)
    assert [m["role"] for m in msgs] == ["assistant", "tool", "assistant", "tool"]
    assert msgs[1]["tool_call_id"] == "legacy_m1"
    assert msgs[3]["tool_call_id"] == "call-2"


def test_parse_tool_payload_invalid_json():
    result = parseToolPayload("not json")
    assert result["name"] == "unknown"
    assert result["toolCallId"] is None
    assert result["input"] == "not json"
    assert result["output"] == "not json"


def test_parse_tool_payload_object_input():
    result = parseToolPayload(json.dumps({"name": "t", "input": {"a": 1}, "output": [1]}))
    assert result["name"] == "t"
    assert json.loads(result["input"]) == {"a": 1}
    assert json.loads(result["output"]) == [1]


def test_truncate_output_short():
    assert truncateOutput("short", 100) == "short"


def test_truncate_output_long():
    out = truncateOutput("x" * 200, 50)
    assert out.endswith("...[truncated]")
    assert len(out) <= 50 + len("\n...[truncated]")


def test_sanitize_removes_orphan_tool_messages():
    msgs: list[dict] = [
        {"role": "tool", "content": "orphan", "tool_call_id": "nope", "name": "x"},
        {"role": "user", "content": "hi"},
    ]
    sanitizeToolCallPairs(msgs)
    assert msgs == [{"role": "user", "content": "hi"}]


def test_sanitize_drops_assistant_with_only_unpaired_calls():
    msgs: list[dict] = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "name": "n", "args": {}}],
        },
        {"role": "user", "content": "hi"},
    ]
    sanitizeToolCallPairs(msgs)
    assert msgs == [{"role": "user", "content": "hi"}]


def test_sanitize_inserts_placeholder_for_partially_unpaired():
    msgs: list[dict] = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "c1", "name": "n", "args": {}},
                {"id": "c2", "name": "m", "args": {}},
            ],
        },
        {"role": "tool", "content": "r1", "tool_call_id": "c1", "name": "n"},
    ]
    sanitizeToolCallPairs(msgs)
    assert len(msgs) == 3
    assert msgs[1]["role"] == "tool"
    assert msgs[1]["tool_call_id"] == "c2"
    assert msgs[1]["content"] == "[Tool result unavailable]"
    assert msgs[2]["tool_call_id"] == "c1"


def test_history_to_messages_empty():
    assert historyToMessages([]) == []


def test_build_history_messages_empty_thread(chat_repo, db):
    thread = insert_thread(db, id="t1")
    assert _svc(chat_repo)["buildHistoryMessages"](thread) == []


def test_legacy_tool_call_id_uses_message_id(chat_repo, db):
    thread = insert_thread(db, id="t1")
    payload = json.dumps({"name": "search", "output": "out"})
    insert_message(db, threadId=thread, id="msg-9", role="tool", content=payload)
    msgs = _svc(chat_repo)["buildHistoryMessages"](thread)
    assert msgs[0]["tool_calls"][0]["id"] == "legacy_msg-9"


def test_token_truncation_preserves_tool_call_pairs_and_cjk_budget():
    messages = [
        {"role": "user", "content": "旧" * 9000},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call-1", "name": "search", "args": {"query": "x"}}],
        },
        {
            "role": "tool",
            "content": "result",
            "tool_call_id": "call-1",
            "name": "search",
        },
        {"role": "assistant", "content": "latest"},
    ]

    result = truncateHistoryByTokens(messages)

    assert result[0]["role"] == "assistant"
    assert [message["role"] for message in result] == ["assistant", "tool", "assistant"]
    assert result[0]["tool_calls"][0]["id"] == result[1]["tool_call_id"]
