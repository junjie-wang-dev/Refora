import pytest

from conftest import insert_message, insert_thread, make_chat_repo, open_migrated_db
from refora_server.services.thread_title import createThreadTitleService, derive_thread_title


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def chat_repo(db):
    return make_chat_repo(db)


def _provider(**overrides):
    base = {
        "model": "gpt-5.6-terra",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-test",
        "presetId": "openai",
        "apiProtocol": "openai-responses",
        "reasoningControl": "openai",
        "reasoningEffort": "medium",
        "supportsReasoning": False,
    }
    base.update(overrides)
    return base


def _svc(chat_repo, generate_title):
    deps = {"generate_title": generate_title}
    return createThreadTitleService({"chat": chat_repo}, deps)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("   \n\t  ", "New chat"),
        ("  Explain\nthis  ", "Explain this"),
        (
            "This first sentence is deliberately long. This second sentence is ignored.",
            "This first sentence is deliberately long.",
        ),
        ("word " * 20, "word word word word word word word word word word…"),
        ("汉" * 51, "汉" * 50 + "…"),
    ],
)
def test_derive_thread_title(text, expected):
    assert derive_thread_title(text) == expected


def test_generate_title_returns_cleaned_title(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="Summarize the latest transformer paper")
    captured: dict = {}

    def gen(req):
        captured["req"] = req
        return '" Transformer Advances "'

    svc = _svc(chat_repo, gen)
    title = svc["generateThreadTitle"](thread, _provider())
    assert title == "Transformer Advances"
    assert captured["req"]["userMessage"] == "Summarize the latest transformer paper"


def test_generate_title_strips_trailing_period(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hello")
    svc = _svc(chat_repo, lambda req: "A title.")
    assert svc["generateThreadTitle"](thread, _provider()) == "A title"


def test_generate_title_too_long_returns_none(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hello")
    svc = _svc(chat_repo, lambda req: "x" * 120)
    assert svc["generateThreadTitle"](thread, _provider()) is None


def test_generate_title_empty_returns_none(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hello")
    svc = _svc(chat_repo, lambda req: "")
    assert svc["generateThreadTitle"](thread, _provider()) is None


def test_generate_title_no_user_message_returns_none(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="assistant", content="hi")
    svc = _svc(chat_repo, lambda req: "Title")
    assert svc["generateThreadTitle"](thread, _provider()) is None


def test_generate_title_truncates_long_message(chat_repo, db):
    thread = insert_thread(db, id="t1")
    long_msg = "word " * 200
    insert_message(db, threadId=thread, role="user", content=long_msg)
    captured: dict = {}

    def gen(req):
        captured["msg"] = req["userMessage"]
        return "Short"

    svc = _svc(chat_repo, gen)
    svc["generateThreadTitle"](thread, _provider())
    assert len(captured["msg"]) <= 500


def test_generate_title_reasoning_model_max_tokens(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hi")
    captured: dict = {}

    def gen(req):
        captured["config"] = req["provider"]
        captured["reasoning"] = req["reasoningModel"]
        return "Title"

    svc = _svc(chat_repo, gen)
    svc["generateThreadTitle"](thread, _provider(supportsReasoning=True))
    assert captured["reasoning"] is True
    assert captured["config"]["maxTokens"] == 512


def test_generate_title_plain_model_uses_reasoning_budget(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hi")
    captured: dict = {}

    def gen(req):
        captured["config"] = req["provider"]
        captured["reasoning"] = req["reasoningModel"]
        return "Title"

    svc = _svc(chat_repo, gen)
    svc["generateThreadTitle"](
        thread,
        _provider(model="gpt-4.1-mini", supportsReasoning=False),
    )
    assert captured["reasoning"] is True
    assert captured["config"]["maxTokens"] == 512


def test_generate_title_exception_returns_none(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, role="user", content="hi")

    def gen(req):
        raise RuntimeError("boom")

    svc = _svc(chat_repo, gen)
    assert svc["generateThreadTitle"](thread, _provider()) is None


def test_generate_title_uses_first_user_message(chat_repo, db):
    thread = insert_thread(db, id="t1")
    insert_message(db, threadId=thread, id="m1", role="user", content="first question")
    insert_message(db, threadId=thread, id="m2", role="assistant", content="answer")
    insert_message(db, threadId=thread, id="m3", role="user", content="second question")
    captured: dict = {}

    def gen(req):
        captured["msg"] = req["userMessage"]
        return "Title"

    svc = _svc(chat_repo, gen)
    svc["generateThreadTitle"](thread, _provider())
    assert captured["msg"] == "first question"
