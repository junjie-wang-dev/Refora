import sqlite3

from conftest import make_doc, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db import migrations
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories


def test_ai_summary_migration_removes_orphans_and_cascades_document_deletes() -> None:
    db = open_migrated_db()
    db.execute("DROP TABLE ai_summaries")
    db.executescript(
        """
        CREATE TABLE ai_summaries (
          docId TEXT PRIMARY KEY,
          model TEXT,
          summaryJson TEXT,
          fullText TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          fullTextHash TEXT
        );
        """
    )
    repos = create_repositories(db)
    repos["documents"]["insert"](make_doc(id="document"))
    db.execute(
        "INSERT INTO ai_summaries(docId, model, summaryJson, fullText, createdAt, updatedAt, fullTextHash) "
        "VALUES ('document', 'model', '{}', 'text', 1, 1, 'hash')"
    )
    db.execute(
        "INSERT INTO ai_summaries(docId, model, summaryJson, fullText, createdAt, updatedAt, fullTextHash) "
        "VALUES ('orphan', 'model', '{}', 'text', 1, 1, 'hash')"
    )
    db.execute("PRAGMA user_version = 38")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 40
    assert db.execute(
        "SELECT 1 FROM ai_summaries WHERE docId = 'document'"
    ).fetchone() is not None
    assert db.execute(
        "SELECT 1 FROM ai_summaries WHERE docId = 'orphan'"
    ).fetchone() is None
    repos["documents"]["delete"]("document")
    assert db.execute("SELECT COUNT(*) FROM ai_summaries").fetchone()[0] == 0


def test_like_search_schema_omits_unused_fts(monkeypatch) -> None:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    monkeypatch.setattr(migrations, "trigram_available", lambda _db: False)

    result = run_migrations(_SqliteAdapter(db))

    assert result.search_mode == "like"
    names = {
        row["name"]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE name IN ('docs_fts', 'documents_ai', 'documents_ad', 'documents_au')"
        ).fetchall()
    }
    assert names == set()
