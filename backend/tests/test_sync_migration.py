from conftest import open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import MIGRATIONS_DIR, run_migrations


def test_sync_foundation_keeps_only_library_identity_and_opt_in_state() -> None:
    db = open_migrated_db()
    state = db.execute("SELECT * FROM sync_state WHERE id = 1").fetchone()
    assert state is not None
    assert len(state["libraryId"]) == 36
    assert state["enabled"] == 0
    assert state["remoteLibraryId"] is None
    assert set(state.keys()) == {
        "id",
        "libraryId",
        "remoteLibraryId",
        "enabled",
        "updatedAt",
    }
    for table in ("sync_outbox", "sync_entity_versions", "sync_conflicts"):
        assert db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()[0] == 0


def test_sync_library_identity_survives_device_state_removal() -> None:
    db = open_migrated_db()
    db.execute("DROP TABLE sync_state")
    db.executescript(
        (MIGRATIONS_DIR / "0032_sync_foundation.sql").read_text(encoding="utf-8")
    )
    db.executescript(
        (MIGRATIONS_DIR / "0033_sync_hardening.sql").read_text(encoding="utf-8")
    )
    db.execute(
        """
        UPDATE sync_state
        SET remoteLibraryId = 'remote-library', enabled = 1, updatedAt = 42
        WHERE id = 1
        """
    )
    db.execute(
        """
        INSERT INTO sync_outbox (
          operationId, entityType, entityId, operation, payloadJson, createdAt, updatedAt
        ) VALUES ('obsolete-operation', 'category', 'category-1', 'upsert', '{}', 1, 1)
        """
    )
    db.execute("PRAGMA user_version = 33")

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 40
    state = db.execute("SELECT * FROM sync_state WHERE id = 1").fetchone()
    assert state["remoteLibraryId"] == "remote-library"
    assert state["enabled"] == 1
    assert state["updatedAt"] == 42
    assert db.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'"
    ).fetchone()[0] == 0
