import pytest

from conftest import make_doc, make_docs_repo, open_schema_db
from refora_server.repositories.ai_summaries import createAiSummariesRepository

AI_SUMMARY_MIGRATIONS = [
    "0005_ai_workspace.sql",
    "0008_ai_summary_fulltext_hash.sql",
]


@pytest.fixture
def db():
    db = open_schema_db()
    for name in AI_SUMMARY_MIGRATIONS:
        db.executescript(_read_migration(name))
    yield db
    db.close()


def _read_migration(name: str) -> str:
    from pathlib import Path

    migrations_dir = Path(__file__).resolve().parents[1] / "refora_server" / "db" / "migrations"
    return (migrations_dir / name).read_text(encoding="utf-8")


def _insert_doc(db, doc_id: str = "doc-1") -> None:
    repo = make_docs_repo(db, library_folder="/lib")
    repo["insert"](make_doc(id=doc_id, file_path="/lib/paper.pdf", file_name="paper.pdf"))


def _repo(db):
    return createAiSummariesRepository(db)


def _content(core="Core finding", key_points=None, methods="Methods", contribution="Contribution"):
    return {
        "core": core,
        "keyPoints": key_points if key_points is not None else ["point one", "point two"],
        "methods": methods,
        "contribution": contribution,
    }


def test_get_summary_returns_none_when_absent(db):
    _insert_doc(db, doc_id="doc-1")
    assert _repo(db)["getSummary"]("doc-1") is None


def test_get_summary_returns_none_for_unknown_doc(db):
    assert _repo(db)["getSummary"]("missing") is None


def test_set_summary_creates_new_row(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    content = _content()
    repo["setSummary"]("doc-1", "gpt-4o", content)
    summary = repo["getSummary"]("doc-1")
    assert summary is not None
    assert summary["docId"] == "doc-1"
    assert summary["model"] == "gpt-4o"
    assert summary["content"] == content
    assert summary["createdAt"] == summary["updatedAt"]
    assert isinstance(summary["createdAt"], int)


def test_set_summary_updates_existing_same_doc_id(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setSummary"]("doc-1", "gpt-4o", _content(core="first"))
    first = repo["getSummary"]("doc-1")
    assert first is not None
    assert first["content"]["core"] == "first"

    repo["setSummary"]("doc-1", "claude-3", _content(core="second"))
    updated = repo["getSummary"]("doc-1")
    assert updated is not None
    assert updated["model"] == "claude-3"
    assert updated["content"]["core"] == "second"
    assert updated["updatedAt"] >= first["createdAt"]
    assert updated["createdAt"] == first["createdAt"]


def test_summary_content_round_trips_through_json(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    content = _content(
        core="A" * 50,
        key_points=["a", "b", "c"],
        methods="quantitative",
        contribution="significant",
    )
    repo["setSummary"]("doc-1", "m", content)
    assert repo["getSummary"]("doc-1")["content"] == content


def test_summary_content_null_when_summary_json_missing(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setFullText"]("doc-1", "some text", "hash-1")
    summary = repo["getSummary"]("doc-1")
    assert summary is not None
    assert summary["content"] is None
    assert summary["model"] is None


def test_set_full_text_creates_and_returns(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    assert repo["getFullText"]("doc-1") is None
    repo["setFullText"]("doc-1", "extracted text", "hash-doc-1")
    result = repo["getFullText"]("doc-1")
    assert result == {"text": "extracted text", "hash": "hash-doc-1"}


def test_set_full_text_updates_existing(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setFullText"]("doc-1", "first text", "h1")
    repo["setFullText"]("doc-1", "second text", "h2")
    result = repo["getFullText"]("doc-1")
    assert result == {"text": "second text", "hash": "h2"}


def test_set_full_text_preserves_summary(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    content = _content()
    repo["setSummary"]("doc-1", "m", content)
    repo["setFullText"]("doc-1", "text", "hash")
    summary = repo["getSummary"]("doc-1")
    assert summary["content"] == content
    assert summary["model"] == "m"
    assert repo["getFullText"]("doc-1") == {"text": "text", "hash": "hash"}


def test_set_summary_preserves_full_text(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setFullText"]("doc-1", "cached text", "hash-1")
    repo["setSummary"]("doc-1", "m", _content())
    assert repo["getFullText"]("doc-1") == {"text": "cached text", "hash": "hash-1"}


def test_fulltext_hash_round_trip_null(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setFullText"]("doc-1", "text", None)
    result = repo["getFullText"]("doc-1")
    assert result == {"text": "text", "hash": None}


def test_delete_removes_summary(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["setSummary"]("doc-1", "m", _content())
    repo["setFullText"]("doc-1", "text", "hash")
    repo["delete"]("doc-1")
    assert repo["getSummary"]("doc-1") is None
    assert repo["getFullText"]("doc-1") is None


def test_delete_is_idempotent(db):
    _insert_doc(db, doc_id="doc-1")
    repo = _repo(db)
    repo["delete"]("doc-1")
    repo["delete"]("doc-1")
    assert repo["getSummary"]("doc-1") is None


def test_summaries_are_isolated_per_doc_id(db):
    _insert_doc(db, doc_id="doc-1")
    _insert_doc(db, doc_id="doc-2")
    repo = _repo(db)
    repo["setSummary"]("doc-1", "m1", _content(core="one"))
    repo["setSummary"]("doc-2", "m2", _content(core="two"))
    assert repo["getSummary"]("doc-1")["content"]["core"] == "one"
    assert repo["getSummary"]("doc-2")["content"]["core"] == "two"
    repo["delete"]("doc-1")
    assert repo["getSummary"]("doc-1") is None
    assert repo["getSummary"]("doc-2") is not None
