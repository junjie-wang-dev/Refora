import sqlite3

from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories.pdf_annotations import createPdfAnnotationsRepository


def test_pdf_annotations_migration_and_repository_roundtrip() -> None:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    run_migrations(_SqliteAdapter(db))
    db.execute(
        """
        INSERT INTO documents(
          id, filePath, originalFolderPath, fileName, starred, addedAt,
          updatedAt, metadataStatus, metadataAttempts, editedFields, fileMissing
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("doc-1", "paper.pdf", "", "paper.pdf", 0, 1, 1, "done", 0, "[]", 0),
    )
    repository = createPdfAnnotationsRepository(db)
    annotations = [{
        "id": "note-1",
        "kind": "note",
        "page": 1,
        "color": "#f2c94c",
        "text": "",
        "comment": "Local note",
        "createdAt": 1,
        "point": {"x": 0.1, "y": 0.2},
    }]

    assert repository.get("doc-1") == []
    assert repository.set("doc-1", annotations) == annotations
    assert repository.get("doc-1") == annotations

    db.execute("DELETE FROM documents WHERE id = ?", ("doc-1",))
    assert db.execute(
        "SELECT count(*) FROM pdf_annotations WHERE documentId = ?",
        ("doc-1",),
    ).fetchone()[0] == 0
