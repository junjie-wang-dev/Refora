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
