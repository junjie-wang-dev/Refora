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

    assert result.to_version == 38
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


def test_forward_migration_restores_recognizable_institution_authors() -> None:
    db = open_migrated_db()
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, authors, addedAt, updatedAt) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            "institutions",
            "/tmp/institutions.pdf",
            "/tmp",
            "institutions.pdf",
            "OpenAI, Inc.; University of California, Berkeley; "
            "Massachusetts Institute of Technology, CSAIL; "
            "California Institute of Technology, CSAIL; "
            "European Molecular Biology Laboratory, EMBL; "
            "National Institute of Standards and Technology, NIST; "
            "Harvard University Press; Smith, Jane",
            1,
            1,
        ],
    )
    db.execute("PRAGMA user_version = 26")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 38
    assert db.execute(
        "SELECT authors FROM documents WHERE id = 'institutions'"
    ).fetchone()["authors"] == (
        "OpenAI, Inc.; University of California, Berkeley; "
        "Massachusetts Institute of Technology, CSAIL; "
        "California Institute of Technology, CSAIL; "
        "European Molecular Biology Laboratory, EMBL; "
        "National Institute of Standards and Technology, NIST; "
        "Harvard University Press; Jane Smith"
    )


def test_forward_migration_preserves_already_correct_institution_authors() -> None:
    db = open_migrated_db()
    authors = (
        "Massachusetts Institute of Technology, CSAIL; "
        "California Institute of Technology, CSAIL; Harvard University; "
        "European Molecular Biology Laboratory, EMBL; "
        "National Institute of Standards and Technology, NIST; "
        "MIT Computer Science Department; WHO Research Institute"
    )
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, authors, addedAt, updatedAt) "
        "VALUES ('correct', '/tmp/correct.pdf', '/tmp', 'correct.pdf', ?, 1, 1)",
        [authors],
    )
    db.execute("PRAGMA user_version = 35")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 38
    assert db.execute(
        "SELECT authors FROM documents WHERE id = 'correct'"
    ).fetchone()["authors"] == authors


def test_forward_migration_repairs_only_provable_corrupted_institutions() -> None:
    db = open_migrated_db()
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, authors, addedAt, updatedAt) "
        "VALUES ('legacy', '/tmp/legacy.pdf', '/tmp', 'legacy.pdf', ?, 1, 1)",
        [
            "EMBL European Molecular Biology Laboratory; "
            "NIST National Institute of Standards and Technology; "
            "CSAIL California Institute of Technology; "
            "MIT Computer Science Department; WHO Research Institute"
        ],
    )
    db.execute("PRAGMA user_version = 35")

    result = run_migrations(_SqliteAdapter(db))

    expected = (
        "European Molecular Biology Laboratory, EMBL; "
        "National Institute of Standards and Technology, NIST; "
        "California Institute of Technology, CSAIL; "
        "MIT Computer Science Department; WHO Research Institute"
    )
    assert result.to_version == 38
    assert db.execute(
        "SELECT authors FROM documents WHERE id = 'legacy'"
    ).fetchone()["authors"] == expected
    assert db.execute(
        "SELECT authors FROM docs_fts WHERE rowid = "
        "(SELECT rowid FROM documents WHERE id = 'legacy')"
    ).fetchone()["authors"] == expected
