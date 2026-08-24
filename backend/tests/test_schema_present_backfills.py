from __future__ import annotations

import sqlite3

from conftest import MIGRATIONS_DIR, SCHEMA_SQL, open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories.ai_providers import createAiProvidersRepository


def test_legacy_provider_model_migration_preserves_model_as_base_model() -> None:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
    for name in (
        "0002_drop_categories_moveToLibrary.sql",
        "0003_filepaths_to_relative.sql",
        "0004_add_pages_issue.sql",
        "0005_ai_workspace.sql",
    ):
        db.executescript((MIGRATIONS_DIR / name).read_text(encoding="utf-8"))
    db.execute("PRAGMA user_version = 5")
    db.execute(
        "INSERT INTO ai_providers(id, name, baseUrl, model, apiKeyEnc, createdAt) "
        "VALUES ('provider-1', 'Legacy', 'https://example.test/v1', "
        "'legacy-model', NULL, 1)"
    )

    run_migrations(_SqliteAdapter(db))

    row = db.execute(
        "SELECT model, baseModel FROM ai_providers WHERE id = 'provider-1'"
    ).fetchone()
    assert row["model"] == "legacy-model"
    assert row["baseModel"] == "legacy-model"
    db.close()


def test_schema_present_agent_profile_migration_runs_data_backfill() -> None:
    db = open_migrated_db()
    providers = createAiProvidersRepository(db)
    provider = providers["create"](
        {
            "presetId": "custom",
            "name": "Recovered provider",
            "baseUrl": "https://example.test/v1",
            "apiProtocol": "openai-compatible",
            "reasoningControl": "openai",
            "reasoningEffort": "medium",
            "model": "model-1",
            "models": ["model-1"],
            "baseModel": "model-1",
            "variant": "",
            "variantFormat": "dash",
            "apiKeyEnc": None,
            "temperature": 0.4,
            "maxTokens": 1024,
        }
    )
    db.execute("DELETE FROM agent_profiles WHERE apiProviderId = ?", [provider["id"]])
    db.execute("PRAGMA user_version = 30")

    run_migrations(_SqliteAdapter(db))

    row = db.execute(
        "SELECT id, apiProviderId FROM agent_profiles WHERE apiProviderId = ?",
        [provider["id"]],
    ).fetchone()
    assert row is not None
    assert row["id"] == f"api-{provider['id']}"
    db.close()
