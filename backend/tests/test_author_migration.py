from conftest import open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations


def test_author_migration_normalizes_existing_rows_and_search_index() -> None:
    db = open_migrated_db()
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, title, authors, addedAt, updatedAt) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            "paper",
            "/tmp/paper.pdf",
            "/tmp",
            "paper.pdf",
            "DMesh++",
            "0003, Sanghyun Son; Gadelha, Matheus; Zhou, Yang; Yi-Ling Qiao",
            1,
            1,
        ],
    )
    db.execute("PRAGMA user_version = 26")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 34
    assert db.execute(
        "SELECT authors FROM documents WHERE id = 'paper'"
    ).fetchone()["authors"] == (
        "Sanghyun Son; Matheus Gadelha; Yang Zhou; Yi-Ling Qiao"
    )
    assert db.execute(
        "SELECT authors FROM docs_fts WHERE rowid = "
        "(SELECT rowid FROM documents WHERE id = 'paper')"
    ).fetchone()["authors"] == (
        "Sanghyun Son; Matheus Gadelha; Yang Zhou; Yi-Ling Qiao"
    )
    db.close()
