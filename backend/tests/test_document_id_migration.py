import json

import pytest

from conftest import make_doc, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.library.document_ids import is_safe_document_id
from refora_server.repositories import create_repositories


@pytest.mark.parametrize(
    "unsafe_id",
    ["legacy?query", "legacy#fragment", "legacy/path", "legacy%encoded", "legacy id"],
)
def test_unsafe_document_id_migration_rewrites_all_reserved_characters(
    unsafe_id: str,
) -> None:
    db = open_migrated_db()
    repos = create_repositories(db)
    repos["documents"]["insert"](make_doc(id=unsafe_id, title=unsafe_id))
    db.execute("PRAGMA user_version = 37")

    result = run_migrations(_SqliteAdapter(db))

    migrated = db.execute(
        "SELECT id FROM documents WHERE title = ?", [unsafe_id]
    ).fetchone()["id"]
    assert result.to_version == 38
    assert migrated != unsafe_id
    assert is_safe_document_id(migrated)
    assert db.execute(
        "SELECT COUNT(*) FROM documents WHERE id = ?", [unsafe_id]
    ).fetchone()[0] == 0


def test_unsafe_document_id_migration_preserves_all_document_associations() -> None:
    unsafe_id = "legacy/doc?section#one"
    db = open_migrated_db()
    repos = create_repositories(db)
    repos["documents"]["insert"](
        make_doc(id=unsafe_id, title="Unsafe legacy document")
    )
    repos["documents"]["insert"](make_doc(id="safe-document", title="Safe"))
    db.execute(
        "INSERT INTO categories(id, name, sortOrder, createdAt) VALUES ('category', 'Reading', 0, 1)"
    )
    db.execute(
        "INSERT INTO document_categories(documentId, categoryId) VALUES (?, 'category')",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO workspaces(id, name, createdAt, updatedAt) VALUES ('workspace', 'Workspace', 1, 1)"
    )
    db.execute(
        "INSERT INTO workspace_items(id, workspaceId, kind, docId, addedAt) "
        "VALUES ('item', 'workspace', 'document', ?, 1)",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO ai_summaries(docId, model, summaryJson, fullText, createdAt, updatedAt, fullTextHash) "
        "VALUES (?, 'model', '{}', 'text', 1, 1, 'hash')",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO ai_reports(id, workspaceId, title, contentMd, sourceDocIds, createdAt) "
        "VALUES ('report', 'workspace', 'Report', '', ?, 1)",
        [json.dumps([unsafe_id, "safe-document"])],
    )
    db.execute(
        "INSERT INTO document_ocr_jobs(" 
        "id, documentId, resultKey, sourceHash, profile, status, stage, createdAt, updatedAt"
        ") VALUES ('job', ?, 'result', 'hash', 'balanced', 'succeeded', 'completed', 1, 1)",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO document_ocr_results(" 
        "id, documentId, resultKey, sourceHash, mineruVersion, modelRevision, profile, "
        "optionsHash, schemaVersion, relativeRoot, markdownRelativePath, "
        "blocksRelativePath, manifestRelativePath, createdAt"
        ") VALUES ('ocr', ?, 'result', 'hash', '1', '1', 'balanced', 'options', 1, "
        "'root', 'document.md', 'blocks.jsonl', 'manifest.json', 1)",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO pdf_annotations(documentId, annotationsJson, updatedAt) VALUES (?, '[]', 1)",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO chat_threads(id, workspaceId, providerId, createdAt) "
        "VALUES ('thread', 'workspace', 'provider', 1)"
    )
    db.execute(
        "INSERT INTO agent_runs(id, threadId, providerId, modelId, status, startedAt, activeDocumentId) "
        "VALUES ('run', 'thread', 'provider', 'model', 'completed', 1, ?)",
        [unsafe_id],
    )
    db.execute(
        "INSERT INTO legacy_path_repair_candidates(documentId, candidatePath, relativePath) "
        "VALUES (?, '/missing/original.pdf', 'paper.pdf')",
        [unsafe_id],
    )
    db.execute("PRAGMA user_version = 37")

    result = run_migrations(_SqliteAdapter(db))

    migrated_id = db.execute(
        "SELECT id FROM documents WHERE title = 'Unsafe legacy document'"
    ).fetchone()["id"]
    assert result.to_version == 38
    assert is_safe_document_id(migrated_id)
    assert db.execute(
        "SELECT id FROM documents WHERE id = 'safe-document'"
    ).fetchone()["id"] == "safe-document"
    for table, column in (
        ("document_categories", "documentId"),
        ("workspace_items", "docId"),
        ("ai_summaries", "docId"),
        ("document_ocr_jobs", "documentId"),
        ("document_ocr_results", "documentId"),
        ("pdf_annotations", "documentId"),
        ("agent_runs", "activeDocumentId"),
        ("legacy_path_repair_candidates", "documentId"),
    ):
        assert db.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = ?',
            [migrated_id],
        ).fetchone()[0] == 1
        assert db.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = ?',
            [unsafe_id],
        ).fetchone()[0] == 0
    assert json.loads(
        db.execute("SELECT sourceDocIds FROM ai_reports WHERE id = 'report'").fetchone()[
            "sourceDocIds"
        ]
    ) == [migrated_id, "safe-document"]
    assert db.execute(
        "SELECT COUNT(*) FROM legacy_document_id_repair_candidates"
    ).fetchone()[0] == 0
