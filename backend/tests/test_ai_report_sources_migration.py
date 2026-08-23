from conftest import make_doc, make_workspaces_repo, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories


def test_ai_report_sources_migration_backfills_valid_documents_and_cascades() -> None:
    db = open_migrated_db()
    db.execute("DROP TABLE ai_report_sources")
    repos = create_repositories(db)
    repos["documents"]["insert"](make_doc(id="document"))
    workspace = make_workspaces_repo(db)["create"]("Research")
    db.execute(
        "INSERT INTO ai_reports(id, workspaceId, title, contentMd, sourceDocIds, createdAt) "
        "VALUES ('report', ?, 'Report', '', '[\"document\", \"missing\", \"document\"]', 1)",
        [workspace["id"]],
    )
    db.execute("PRAGMA user_version = 39")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 40
    rows = db.execute(
        "SELECT docId, ordinal FROM ai_report_sources WHERE reportId = 'report'"
    ).fetchall()
    assert [(row["docId"], row["ordinal"]) for row in rows] == [("document", 0)]
    repos["documents"]["delete"]("document")
    assert db.execute(
        "SELECT COUNT(*) FROM ai_report_sources WHERE reportId = 'report'"
    ).fetchone()[0] == 0


def test_current_migration_does_not_restore_removed_legacy_sources() -> None:
    db = open_migrated_db()
    repos = create_repositories(db)
    repos["documents"]["insert"](make_doc(id="document"))
    workspace = make_workspaces_repo(db)["create"]("Research")
    report = repos["aiReports"]["create"](
        workspace["id"],
        "Report",
        "",
        ["document"],
    )

    repos["documents"]["delete"]("document")
    repos["documents"]["insert"](make_doc(id="document"))
    run_migrations(_SqliteAdapter(db))

    assert db.execute(
        "SELECT COUNT(*) FROM ai_report_sources WHERE reportId = ?",
        [report["id"]],
    ).fetchone()[0] == 0
