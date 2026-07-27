import asyncio
import json

import pytest

from conftest import insert_doc, make_docs_repo, open_migrated_db
from refora_server.repositories.ai_summaries import createAiSummariesRepository
from refora_server.services.ai_summary import (
    build_provider_config,
    compactText,
    createAiSummaryService,
    isRetryableError,
    splitText,
    stripCodeFences,
    toSummaryContent,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def _repos(db):
    return {
        "documents": make_docs_repo(db, library_folder="/lib"),
        "aiSummaries": createAiSummariesRepository(db),
    }


def _provider(text: str | None = None, **overrides):
    base = {
        "model": "gpt-5.6-terra",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-test",
        "presetId": "openai",
        "apiProtocol": "openai-responses",
        "reasoningControl": "openai",
        "reasoningEffort": "medium",
    }
    if text is not None:
        base["__text"] = text
    base.update(overrides)
    return base


def test_split_text_short():
    assert splitText("short") == ["short"]


def test_split_text_empty():
    assert splitText("") == []


def test_split_text_chunks_with_overlap():
    text = "x" * 7000
    chunks = splitText(text, chunk_size=3000, overlap=200)
    assert len(chunks) >= 3
    assert sum(len(c) for c in chunks) >= len(text)


def test_compact_text_short():
    assert compactText("hello world", 100) == "hello world"


def test_compact_text_collapses_whitespace():
    assert compactText("a\n\nb   c", 100) == "a b c"


def test_compact_text_truncates_with_ellipsis():
    out = compactText("word " * 50, 30)
    assert out.endswith("\u2026")
    assert len(out) <= 31


def test_strip_code_fences():
    assert stripCodeFences('```json\n{"a":1}\n```') == '{"a":1}'


def test_strip_code_fences_plain():
    assert stripCodeFences("plain text") == "plain text"


def test_to_summary_content_valid():
    result = toSummaryContent({"core": "summary", "keyPoints": ["a", "b"]})
    assert result == {"core": "summary", "keyPoints": ["a", "b"]}


def test_to_summary_content_caps_key_points():
    result = toSummaryContent({"core": "c", "keyPoints": ["1", "2", "3", "4", "5", "6"]})
    assert len(result["keyPoints"]) == 5


def test_to_summary_content_non_dict():
    assert toSummaryContent("string") is None


def test_is_retryable_429():
    err = Exception("rate limit 429")
    assert isRetryableError(err) is True


def test_is_retryable_500():
    class Err(Exception):
        status = 503

    assert isRetryableError(Err("bad gateway")) is True


def test_is_retryable_400_not_retryable():
    class Err(Exception):
        status = 400

    assert isRetryableError(Err("bad request")) is False


def test_is_retryable_auth_not_retryable():
    class Err(Exception):
        lc_error_code = "MODEL_AUTHENTICATION"

    assert isRetryableError(Err("auth")) is False


def test_build_provider_config_basic():
    config = build_provider_config(_provider(), deep_thinking=False)
    assert config["model"] == "gpt-5.6-terra"
    assert config["baseUrl"] == "https://api.openai.com/v1"
    assert config["apiKey"] == "sk-test"
    assert "reasoning" not in config


def test_build_provider_config_disables_compatible_thinking():
    config = build_provider_config(
        _provider(
            presetId="deepseek",
            apiProtocol="openai-compatible",
            reasoningControl="thinking",
            model="deepseek-v4-flash",
        ),
        deep_thinking=False,
    )
    assert config["modelKwargs"]["thinking"] == {"type": "disabled"}


async def test_summarize_persists_summary(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    calls: list[dict] = []

    def gen(req):
        calls.append(req)
        if req.get("combined"):
            return json.dumps({"core": "Core finding", "keyPoints": ["p1", "p2"]})
        return "chunk summary"

    deps = {"generate_summary": gen}
    svc = createAiSummaryService(repos, deps)
    result = await svc["summarize"]("doc-1", _provider(text="A long document text body."))
    assert result == "doc-1"
    summary = repos["aiSummaries"]["getSummary"]("doc-1")
    assert summary is not None
    assert summary["model"] == "gpt-5.6-terra"
    assert summary["content"]["core"] == "Core finding"
    assert summary["content"]["keyPoints"] == ["p1", "p2"]
    assert len(calls) >= 2


async def test_summarize_empty_text_emits_error(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    errors: list[tuple[str, str]] = []
    deltas: list[str] = []
    deps = {
        "generate_summary": lambda req: "",
        "emit_error": lambda doc_id, msg: errors.append((doc_id, msg)),
        "emit_delta": lambda doc_id, sid: deltas.append(doc_id),
    }
    svc = createAiSummaryService(repos, deps)
    result = await svc["summarize"]("doc-1", _provider(text=""))
    assert result is None
    assert errors
    assert errors[0][0] == "doc-1"


async def test_summarize_missing_doc_returns_none(db):
    repos = _repos(db)
    deltas: list[str] = []
    deps = {
        "generate_summary": lambda req: "",
        "emit_delta": lambda doc_id, sid: deltas.append(doc_id),
    }
    svc = createAiSummaryService(repos, deps)
    result = await svc["summarize"]("missing", _provider(text="text"))
    assert result is None
    assert "missing" in deltas


async def test_summarize_retries_on_429(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    attempts = {"n": 0}

    async def sleep(_):
        pass

    def gen(req):
        attempts["n"] += 1
        if attempts["n"] < 3:
            err = Exception("429 rate limit")
            raise err
        if req.get("combined"):
            return json.dumps({"core": "ok", "keyPoints": []})
        return "chunk"

    deps = {"generate_summary": gen, "sleep": sleep}
    svc = createAiSummaryService(repos, deps)
    result = await svc["summarize"]("doc-1", _provider(text="document text here."))
    assert result == "doc-1"
    assert attempts["n"] >= 3
    summary = repos["aiSummaries"]["getSummary"]("doc-1")
    assert summary["content"]["core"] == "ok"


async def test_summarize_no_retry_on_auth_error(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)

    async def sleep(_):
        pass

    class AuthErr(Exception):
        lc_error_code = "MODEL_AUTHENTICATION"

    def gen(req):
        raise AuthErr("bad key")

    errors: list[tuple[str, str]] = []
    deps = {
        "generate_summary": gen,
        "sleep": sleep,
        "emit_error": lambda d, m: errors.append((d, m)),
    }
    svc = createAiSummaryService(repos, deps)
    result = await svc["summarize"]("doc-1", _provider(text="document text."))
    assert result is None
    assert errors
    assert "failed" in errors[0][1].lower()


async def test_summarize_falls_back_when_json_invalid(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)

    def gen(req):
        if req.get("combined"):
            return "not valid json at all"
        return "chunk summary text"

    deps = {"generate_summary": gen}
    svc = createAiSummaryService(repos, deps)
    await svc["summarize"]("doc-1", _provider(text="document text body content."))
    summary = repos["aiSummaries"]["getSummary"]("doc-1")
    assert summary is not None
    assert summary["content"]["keyPoints"] == []
    assert summary["content"]["core"]


async def test_summarize_uses_cached_full_text(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    repos["aiSummaries"]["setFullText"]("doc-1", "cached extracted text", "hash-1")
    captured: list[str] = []

    def gen(req):
        if req.get("text"):
            captured.append(req["text"])
            return "chunk summary"
        return json.dumps({"core": "from cache", "keyPoints": []})

    deps = {"generate_summary": gen}
    svc = createAiSummaryService(repos, deps)
    await svc["summarize"]("doc-1", _provider())
    assert captured
    assert captured[0] == "cached extracted text"


async def test_queued_summary_loads_text_in_background(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    started = asyncio.Event()
    release = asyncio.Event()

    async def load_text(doc_id):
        assert doc_id == "doc-1"
        started.set()
        await release.wait()
        return "loaded document text"

    def gen(req):
        if req.get("combined"):
            return json.dumps({"core": "queued summary", "keyPoints": []})
        return "chunk summary"

    svc = createAiSummaryService(
        repos,
        {"generate_summary": gen, "load_text": load_text},
    )
    result = svc["queueSummary"]("doc-1", _provider())

    assert result == "doc-1"
    assert repos["aiSummaries"]["getSummary"]("doc-1") is None
    await asyncio.wait_for(started.wait(), timeout=1)
    release.set()

    async def wait_for_summary():
        while repos["aiSummaries"]["getSummary"]("doc-1") is None:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait_for_summary(), timeout=1)
    assert repos["aiSummaries"]["getSummary"]("doc-1")["content"]["core"] == "queued summary"


async def test_queued_summary_deduplicates_active_document(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)
    started = asyncio.Event()
    release = asyncio.Event()
    loads = {"count": 0}

    async def load_text(_doc_id):
        loads["count"] += 1
        started.set()
        await release.wait()
        return "loaded document text"

    def gen(req):
        if req.get("combined"):
            return json.dumps({"core": "done", "keyPoints": []})
        return "chunk summary"

    svc = createAiSummaryService(
        repos,
        {"generate_summary": gen, "load_text": load_text},
    )
    assert svc["queueSummary"]("doc-1", _provider()) == "doc-1"
    await asyncio.wait_for(started.wait(), timeout=1)
    assert svc["queueSummary"]("doc-1", _provider()) == "doc-1"
    assert loads["count"] == 1
    release.set()

    async def wait_for_summary():
        while repos["aiSummaries"]["getSummary"]("doc-1") is None:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait_for_summary(), timeout=1)


async def test_summarize_destroy_prevents_persistence(db):
    insert_doc(db, id="doc-1")
    repos = _repos(db)

    def gen(req):
        return "chunk"

    deps = {"generate_summary": gen}
    svc = createAiSummaryService(repos, deps)
    svc["destroy"]()
    result = await svc["summarize"]("doc-1", _provider(text="text"))
    assert result is None
    assert repos["aiSummaries"]["getSummary"]("doc-1") is None


def test_content_to_text_from_string():
    from refora_server.services.ai_summary import _content_to_text

    assert _content_to_text("plain") == "plain"


def test_content_to_text_from_parts():
    from refora_server.services.ai_summary import _content_to_text

    assert _content_to_text([{"text": "a"}, {"text": "b"}]) == "ab"


async def test_summarize_concurrency_limited_to_two(db):
    for i in range(3):
        insert_doc(db, id=f"doc-{i}")
    repos = _repos(db)

    import threading
    import time

    sync_lock = threading.Lock()
    current = {"value": 0}
    high_water = {"value": 0}

    def gen(req):
        if req.get("combined"):
            return json.dumps({"core": "core", "keyPoints": []})
        return "chunk summary"

    def tracked_gen(req):
        with sync_lock:
            current["value"] += 1
            high_water["value"] = max(high_water["value"], current["value"])
        time.sleep(0.05)
        with sync_lock:
            current["value"] -= 1
        return gen(req)

    deps = {"generate_summary": tracked_gen}
    svc = createAiSummaryService(repos, deps)

    tasks = [
        asyncio.ensure_future(svc["summarize"](f"doc-{i}", _provider(text="document text body.")))
        for i in range(3)
    ]
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=10)

    assert high_water["value"] <= 2
    for i in range(3):
        summary = repos["aiSummaries"]["getSummary"](f"doc-{i}")
        assert summary is not None
        assert summary["content"]["core"] == "core"


async def test_summarize_third_job_waits_for_slot(db):
    for i in range(3):
        insert_doc(db, id=f"doc-{i}")
    repos = _repos(db)

    import threading
    import time

    started = {"value": 0}
    finished = {"value": 0}
    proceed = {"value": False}
    sync_lock = threading.Lock()

    def gen(req):
        if req.get("combined"):
            return json.dumps({"core": "core", "keyPoints": []})
        return "chunk summary"

    def blocked_gen(req):
        with sync_lock:
            started["value"] += 1
        while not proceed["value"]:
            time.sleep(0.01)
        with sync_lock:
            finished["value"] += 1
        return gen(req)

    deps = {"generate_summary": blocked_gen}
    svc = createAiSummaryService(repos, deps)

    tasks = [
        asyncio.ensure_future(svc["summarize"](f"doc-{i}", _provider(text="document text body.")))
        for i in range(3)
    ]
    await asyncio.sleep(0.2)
    assert started["value"] == 2
    assert finished["value"] == 0
    proceed["value"] = True
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=10)
    for i in range(3):
        summary = repos["aiSummaries"]["getSummary"](f"doc-{i}")
        assert summary is not None
        assert summary["content"]["core"] == "core"


def test_summary_chunk_prompt_carries_word_limit():
    from refora_server.server.lifespan import _summary_prompt

    prompt = _summary_prompt("excerpt text here", None)
    assert "60 words" in prompt
    assert "two essential facts" in prompt
    assert "Extracted PDF text:\nexcerpt text here" in prompt


def test_summary_final_prompt_carries_constraints():
    from refora_server.server.lifespan import _summary_prompt

    prompt = _summary_prompt(None, "combined notes here")
    assert "3 to 5" in prompt
    assert "20 words" in prompt
    assert "primary language" in prompt
    assert '"core"' in prompt
    assert '"keyPoints"' in prompt
    assert "Extracted PDF section notes:\ncombined notes here" in prompt


def test_summary_prompt_raises_without_input():
    from refora_server.server.lifespan import _summary_prompt

    with pytest.raises(RuntimeError):
        _summary_prompt(None, None)
