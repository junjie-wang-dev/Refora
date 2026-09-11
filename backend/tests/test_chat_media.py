from conftest import LATEST_SCHEMA_VERSION
import asyncio
import json
import sqlite3
import sys

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from conftest import insert_thread, open_migrated_db
from refora_server.agent.tools.library import _ocr_image_links
from refora_server.cli_runtime.engine import CliRuntimeEngine
from refora_server.cli_runtime.registry import CliRuntimeRegistry
from refora_server.cli_runtime.tool_broker import CliToolBroker
from refora_server.cli_runtime.types import CliInvocation
from refora_server.db import migrations
from refora_server.db.connection import _SqliteAdapter
from refora_server.repositories import create_repositories
from refora_server.services.agent_events import _message_media, _message_text, _structured_tool_result
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.chat_attachments import normalize_media
from test_agent_runtime import Agent, request
from test_agent_profiles import _SegmentAdapter


@pytest.fixture
def db():
    connection = open_migrated_db()
    yield connection
    connection.close()


@pytest.mark.parametrize(("block", "kind", "source"), [
    ({"type": "image_url", "image_url": {"url": "https://example.test/figure.png"}}, "image", {"type": "remote", "url": "https://example.test/figure.png"}),
    ({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}}, "image", {"type": "inline", "dataUrl": "data:image/png;base64,aGVsbG8="}),
    ({"type": "image", "source_type": "base64", "mime_type": "image/webp", "data": "aGVsbG8="}, "image", {"type": "inline", "dataUrl": "data:image/webp;base64,aGVsbG8="}),
    ({"type": "image_generation_call", "result": "aGVsbG8="}, "image", {"type": "inline", "dataUrl": "data:image/png;base64,aGVsbG8="}),
    ({"inlineData": {"mimeType": "image/png", "data": "aGVsbG8="}}, "image", {"type": "inline", "dataUrl": "data:image/png;base64,aGVsbG8="}),
    ({"type": "input_audio", "input_audio": {"data": "aGVsbG8=", "format": "wav"}}, "audio", {"type": "inline", "dataUrl": "data:audio/wav;base64,aGVsbG8="}),
    ({"type": "video_url", "video_url": "https://example.test/video.mp4"}, "video", {"type": "remote", "url": "https://example.test/video.mp4"}),
    ({"type": "file", "file_data": "data:application/pdf;base64,aGVsbG8=", "filename": "report.pdf"}, "file", {"type": "inline", "dataUrl": "data:application/pdf;base64,aGVsbG8="}),
    ({"type": "image", "url": "refora-document://ocr/paper%20one/result/assets/figure.png"}, "image", {"type": "ocr", "documentId": "paper one", "resultKey": "result", "path": "assets/figure.png"}),
    ({"type": "image", "url": "refora-asset://asset/picture"}, "image", {"type": "asset", "assetId": "picture"}),
    ({"type": "file", "url": "/outputs/results.csv"}, "file", {"type": "sandbox", "runId": "run-one", "path": "outputs/results.csv"}),
])
def test_provider_media_blocks_keep_typed_sources_and_text(block, kind, source):
    value = AIMessage(content=[{"type": "text", "text": "Evidence"}, block])
    assert _message_text(value) == "Evidence"
    media = _message_media(value, "run-one")
    assert len(media) == 1
    assert media[0]["kind"] == kind
    assert media[0]["source"] == source
    assert _message_media({"messages": [value]}, "run-one") == media


def test_media_in_additional_audio_output_is_preserved():
    value = AIMessage(content="", additional_kwargs={"audio": {"data": "aGVsbG8=", "format": "mp3"}})
    assert _message_media(value)[0]["source"] == {"type": "inline", "dataUrl": "data:audio/mp3;base64,aGVsbG8="}


def test_opaque_provider_files_have_a_visible_unavailable_placeholder():
    media = _message_media({"content": [{"type": "file", "file_id": "file-provider", "filename": "report.pdf"}]})
    assert media[0]["title"] == "report.pdf"
    assert media[0]["source"]["type"] == "unavailable"


def test_media_normalization_rejects_unsafe_local_sources_and_deduplicates():
    media = [
        {"kind": "image", "source": {"type": "remote", "url": "https://example.test/figure.png"}},
        {"kind": "image", "source": {"type": "remote", "url": "https://example.test/figure.png"}},
        {"kind": "image", "source": {"type": "remote", "url": "file:///tmp/private.png"}},
        {"kind": "image", "source": {"type": "ocr", "documentId": "paper", "resultKey": "result", "path": "images/../../secret"}},
        {"kind": "file", "source": {"type": "sandbox", "runId": "run", "path": "outputs/../private.txt"}},
    ]
    assert len(normalize_media(media)) == 1
    assert normalize_media(media) == normalize_media(normalize_media(media))


def test_structured_tool_results_keep_complete_records_separately_from_diagnostics():
    records = [{"docId": f"paper-{index}", "title": f"Paper {index}", "abstract": "Evidence " * 100} for index in range(40)]
    wrapped = ToolMessage(content=json.dumps({"papers": records, "apiKey": "secret"}), tool_call_id="call")
    result = _structured_tool_result(wrapped, "search_documents")
    assert len(json.dumps(result)) > 4000
    assert result["papers"] == records
    assert result["apiKey"] == "[redacted]"
    assert _structured_tool_result(wrapped, "search_arxiv") is None


def test_oversized_tool_results_remain_valid_bounded_json_and_mark_truncation():
    result = _structured_tool_result({"items": [{"content": "x" * 100_000} for _ in range(100)]}, "web_search")
    assert result["_truncated"] is True
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= 256 * 1024
    assert result["items"][0]["content"]


def test_ocr_images_are_qualified_with_document_and_result_without_changing_external_links():
    markdown = "![Figure](images/figure.png) ![Other](assets/plot.png) ![External](https://example.test/a.png) ![Bad](images/%2e%2e/private.png)"
    qualified = _ocr_image_links(markdown, "paper one", "result")
    assert "![Figure](refora-document://ocr/paper%20one/result/assets/figure.png)" in qualified
    assert "![Other](refora-document://ocr/paper%20one/result/assets/plot.png)" in qualified
    assert "![External](https://example.test/a.png)" in qualified
    assert "![Bad](images/%2e%2e/private.png)" in qualified


def make_runtime(repos, stream, events, **deps):
    return createAgentRuntime(repos, {
        "createTools": lambda req: [], "createModel": lambda provider: "model",
        "createAgent": lambda model, tools, req: Agent(), "stream": stream,
        "emit": lambda name, payload: events.append((name, payload)), **deps,
    })


def test_streamed_media_only_answer_is_cached_once_persisted_and_restored(db):
    insert_thread(db)
    repos = create_repositories(db)
    events = []
    cached = []
    block = {"type": "image", "source_type": "base64", "mime_type": "image/png", "data": "aGVsbG8="}

    async def persist(media, req):
        cached.extend(media)
        return [{**item, "source": {"type": "cached", "mediaId": "cached-picture"}} for item in media]

    async def stream(agent, req, mode):
        yield {"event": "on_chat_model_stream", "data": {"chunk": AIMessageChunk(content=[block])}}
        yield {"event": "complete", "result": {"messages": [AIMessage(content=[block])]}}

    result = asyncio.run(make_runtime(repos, stream, events, persistMedia=persist)["send"](request()))
    assert result["status"] == "completed"
    assert len(cached) == 1
    message = repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]
    assert message["content"] == ""
    assert message["media"][0]["source"] == {"type": "cached", "mediaId": "cached-picture"}
    done = next(payload for name, payload in events if name == "ai.chat.done")
    assert done["media"] == message["media"]
    media_events = [payload for name, payload in events if name == "ai.chat.media"]
    assert len(media_events) == 1
    run_trace = next(step for step in repos["agentTraces"]["listByRun"]("run-1") if step["kind"] == "run")
    assert run_trace["result"]["media"] == message["media"]


def test_published_artifacts_are_assistant_attachments_and_structured_trace_results(db):
    insert_thread(db)
    repos = create_repositories(db)
    events = []
    published = {"published": [{"path": "outputs/chart.png", "assetId": "asset-one", "fileName": "chart.png", "mimeType": "image/png"}], "errors": []}

    async def stream(agent, req, mode):
        yield {"event": "on_tool_start", "run_id": "publish", "name": "publish_workspace_artifacts", "data": {"input": {"paths": ["outputs/chart.png"]}}}
        yield {"event": "on_tool_end", "run_id": "publish", "name": "publish_workspace_artifacts", "data": {"output": ToolMessage(content=json.dumps(published), tool_call_id="publish")}}
        yield {"event": "complete", "result": {"content": "Created chart"}}

    asyncio.run(make_runtime(repos, stream, events)["send"](request()))
    message = repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]
    assert message["media"][0]["kind"] == "image"
    assert message["attachments"] == [{"type": "asset", "assetId": "asset-one", "title": "chart.png"}]
    trace = next(step for step in repos["agentTraces"]["listByRun"]("run-1") if step["name"] == "publish_workspace_artifacts")
    assert trace["result"] == published
    assert message["media"][0]["toolStepId"] == trace["id"]
    snapshot = next(step for step in repos["agentTraces"]["listByRun"]("run-1") if step["kind"] == "run")
    assert snapshot["result"]["media"][0]["toolStepId"] == trace["id"]


def test_media_survives_failed_run_even_without_text(db):
    insert_thread(db)
    repos = create_repositories(db)
    events = []

    async def stream(agent, req, mode):
        yield {"event": "media", "media": [{"kind": "audio", "source": {"type": "remote", "url": "https://example.test/audio.wav"}}]}
        raise RuntimeError("Provider stopped")

    result = asyncio.run(make_runtime(repos, stream, events)["send"](request()))
    assert result["status"] == "failed"
    message = repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]
    assert message["runStatus"] == "failed"
    assert message["media"][0]["kind"] == "audio"
    assert next(payload for name, payload in events if name == "ai.chat.done")["media"] == message["media"]


def test_media_cache_failure_keeps_text_and_visible_media_error(db):
    insert_thread(db)
    repos = create_repositories(db)
    events = []

    async def persist(media, req):
        raise OSError("disk full")

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": {"content": [{"type": "text", "text": "Here is the figure"}, {"type": "image_url", "image_url": "data:image/png;base64,aGVsbG8="}]}}

    result = asyncio.run(make_runtime(repos, stream, events, persistMedia=persist)["send"](request()))
    assert result["status"] == "completed"
    message = repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]
    assert message["content"] == "Here is the figure"
    assert message["media"][0]["source"]["type"] == "unavailable"


def test_recovery_and_restarted_cancellation_keep_already_generated_media(db):
    insert_thread(db)
    repos = create_repositories(db)
    media = normalize_media([{"kind": "image", "source": {"type": "cached", "mediaId": "figure"}}])
    def add_persisted(run_id, status):
        repos["agentRuns"]["create"]({"id": run_id, "threadId": "thread-1", "providerId": "provider-1", "modelId": "model", "status": status})
        repos["agentTraces"]["addStep"]({"threadId": "thread-1", "runId": run_id, "kind": "run", "status": status, "seq": 0, "startedAt": 1, "result": {"media": media}})

    add_persisted("recover-run", "running")

    async def stream(agent, req, mode):
        yield {"event": "complete", "result": {"content": "Recovered"}}

    runtime = make_runtime(repos, stream, [])
    assert asyncio.run(runtime["recover"](request(runId="recover-run", recoverLatestCheckpoint=True)))["status"] == "completed"
    assert repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]["media"] == media
    add_persisted("cancel-run", "running")
    assert asyncio.run(runtime["cancel"]("cancel-run"))["cancelled"] is True
    last = repos["chat"]["listMessagesPage"]("thread-1")["messages"][-1]
    assert last["media"] == media
    assert last["runStatus"] == "cancelled"


@pytest.mark.asyncio
async def test_cli_forwards_assistant_media_without_echoing_user_media(tmp_path):
    image = {"type": "image_url", "image_url": "https://example.test/figure.png"}
    payloads = [{"type": "message", "role": "user", "content": [image]}, {"type": "message", "role": "assistant", "content": [image]}]

    class MediaAdapter(_SegmentAdapter):
        def build_invocation(self, profile, req, prompt, session_id, mcp):
            script = "import json\nfor payload in " + repr(payloads) + ":\n print(json.dumps(payload),flush=True)\n"
            return CliInvocation(executable=sys.executable, args=("-u", "-c", script), cwd=req["sandboxRoot"], stdin=prompt)

    engine = CliRuntimeEngine(
        CliRuntimeRegistry([MediaAdapter()]),
        CliToolBroker(str(tmp_path), "http://127.0.0.1:1", "server-token"),
        {"get": lambda *_: None, "put": lambda *_: None, "delete": lambda *_: None},
        {"update": lambda *_: None},
    )
    req = request(sandboxRoot=str(tmp_path), agentProfile={"id": "profile", "cliRuntimeId": "segment-test"})
    events = [event async for event in engine.create_agent([], req).astream_events({})]
    media_events = [event for event in events if event["event"] == "media"]
    assert len(media_events) == 1
    assert media_events[0]["media"][0]["source"] == {"type": "remote", "url": "https://example.test/figure.png"}


def test_version_41_upgrade_preserves_history_and_tracks_structured_result_changes(monkeypatch):
    connection = sqlite3.connect(":memory:", isolation_level=None)
    connection.row_factory = sqlite3.Row
    adapter = _SqliteAdapter(connection)
    prior = [migration for migration in migrations.load_migration_files() if migration.version <= 41]
    try:
        with monkeypatch.context() as patch:
            patch.setattr(migrations, "load_migration_files", lambda: prior)
            migrations.run_migrations(adapter)
        insert_thread(connection)
        connection.execute("INSERT INTO chat_messages(id, threadId, role, content, createdAt) VALUES ('old', 'thread-1', 'assistant', 'Preserved answer', 1)")
        assert migrations.run_migrations(adapter).to_version == LATEST_SCHEMA_VERSION
        repos = create_repositories(connection)
        assert repos["chat"]["listMessages"]("thread-1")[0]["content"] == "Preserved answer"
        step = repos["agentTraces"]["addStep"]({"threadId": "thread-1", "runId": "run", "kind": "tool", "status": "done", "seq": 0, "startedAt": 1})
        updated = repos["agentTraces"]["updateStep"](step["id"], {"result": {"papers": [{"docId": "paper"}]}})
        assert updated["revision"] > step["revision"]
        assert repos["agentTraces"]["listRunChanges"]("run", step["revision"])["traces"] == [updated]
        assert migrations.run_migrations(adapter).from_version == LATEST_SCHEMA_VERSION
        assert repos["agentTraces"]["listByRun"]("run")[0] == updated
    finally:
        connection.close()


def test_cached_and_public_http_provider_references_keep_their_source_type():
    cached = _message_media({'type': 'image', 'url': 'refora-asset://media/' + 'a' * 64})
    assert cached[0]['source'] == {'type': 'cached', 'mediaId': 'a' * 64}
    remote = _message_media({'type': 'image', 'url': 'http://example.test/figure.png'})
    assert remote[0]['source'] == {'type': 'remote', 'url': 'http://example.test/figure.png'}
