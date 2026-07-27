from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_FILE = SCHEMA_DIR / "schema.sql"
MIGRATIONS_DIR = SCHEMA_DIR / "migrations"

FTS_COLUMNS: tuple[str, ...] = (
    "title",
    "authors",
    "venue",
    "year",
    "keywords",
    "abstract",
    "url",
    "note",
    "fileName",
)

_FILENAME_VERSION_RE = re.compile(r"(\d+)_")


@dataclass(frozen=True)
class MigrationFile:
    version: int
    sql: str


@dataclass(frozen=True)
class MigrationResult:
    from_version: int
    to_version: int
    trigram: bool
    search_mode: str


class SqliteLike(Protocol):
    def exec(self, sql: str) -> None: ...
    def exec_script(self, sql: str) -> None: ...
    def get_user_version(self) -> int: ...
    def set_user_version(self, version: int) -> None: ...
    def has_column(self, table: str, column: str) -> bool: ...
    def has_object(self, type: str, name: str) -> bool: ...


_cached_migrations: list[MigrationFile] | None = None


def load_migration_files() -> list[MigrationFile]:
    global _cached_migrations
    if _cached_migrations is not None:
        return _cached_migrations

    loaded: list[MigrationFile] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        match = _FILENAME_VERSION_RE.search(path.name)
        if not match:
            continue
        version = int(match.group(1))
        if version <= 0:
            continue
        sql = path.read_text(encoding="utf-8")
        loaded.append(MigrationFile(version=version, sql=sql))
    loaded.sort(key=lambda m: m.version)
    _cached_migrations = loaded
    return _cached_migrations


def _load_schema_sql() -> str:
    return SCHEMA_FILE.read_text(encoding="utf-8")


def trigram_available(db: SqliteLike) -> bool:
    try:
        db.exec_script("CREATE VIRTUAL TABLE IF NOT EXISTS _trigram_probe USING fts5(x, tokenize='trigram')")
        db.exec_script("DROP TABLE IF EXISTS _trigram_probe")
        return True
    except Exception:
        return False


def schema_for_tokenizer(use_trigram: bool) -> str:
    schema_sql = _load_schema_sql()
    if use_trigram:
        return schema_sql
    return schema_sql.replace("tokenize='trigram'", "tokenize='unicode61'")


def _has_columns(db: SqliteLike, table: str, columns: list[str]) -> bool:
    return all(db.has_column(table, column) for column in columns)


def _has_objects(db: SqliteLike, objects: list[tuple[str, str]]) -> bool:
    return all(db.has_object(obj_type, name) for obj_type, name in objects)


def migration_schema_present(db: SqliteLike, version: int) -> bool:
    current = db.get_user_version()
    if version == 12:
        return _has_columns(db, "documents", ["affiliations"])
    if version == 13:
        return _has_columns(
            db,
            "ai_providers",
            ["presetId", "apiProtocol", "reasoningControl", "reasoningEffort"],
        )
    if version == 14:
        return _has_columns(db, "workspace_items", ["noteId", "width", "height"]) and _has_objects(
            db,
            [
                ("table", "workspace_notes"),
                ("index", "uq_workspace_items_document"),
                ("index", "uq_workspace_items_report"),
                ("index", "uq_workspace_items_note"),
            ],
        )
    if version == 15:
        return _has_columns(db, "workspace_items", ["x", "y", "zIndex"]) and _has_objects(
            db,
            [
                ("table", "workspace_canvas_state"),
                ("index", "idx_workspace_items_canvas"),
            ],
        )
    if version == 16:
        return _has_columns(db, "workspace_notes", ["noteType"])
    if version == 17:
        return _has_columns(db, "ai_providers", ["modelsJson"])
    if version == 18:
        return _has_objects(
            db,
            [
                ("table", "workspace_connections"),
                ("index", "idx_workspace_connections_workspace"),
            ],
        )
    if version == 19:
        return _has_columns(db, "workspace_items", ["assetId"]) and _has_objects(
            db,
            [
                ("table", "workspace_assets"),
                ("index", "idx_workspace_assets_workspace"),
                ("index", "uq_workspace_items_asset"),
            ],
        )
    if version == 21:
        return _has_objects(
            db,
            [
                ("table", "document_ocr_jobs"),
                ("table", "document_ocr_results"),
                ("index", "idx_document_ocr_jobs_document"),
                ("index", "idx_document_ocr_jobs_status"),
                ("index", "idx_document_ocr_results_document"),
            ],
        )
    if version == 22:
        return _has_columns(db, "documents", ["arxivId"])
    if version == 24:
        return _has_columns(db, "chat_threads", ["headCheckpointId", "agentStateVersion"]) and _has_columns(
            db,
            "agent_trace_steps",
            ["parentStepId", "agentName", "namespace", "depth", "checkpointId"],
        ) and _has_objects(
            db,
            [
                ("table", "agent_runs"),
                ("table", "workspace_agent_memories"),
                ("table", "workspace_agent_memory_revisions"),
                ("table", "agent_interrupts"),
                ("table", "agent_tool_effects"),
            ],
        )
    if version == 25:
        return _has_objects(db, [("table", "web_search_config")])
    return version <= current


def run_migrations(db: SqliteLike) -> MigrationResult:
    from_version = db.get_user_version()
    use_trigram = trigram_available(db)

    if from_version < 1:
        db.exec_script(schema_for_tokenizer(use_trigram))
        db.set_user_version(1)

    for migration in load_migration_files():
        current_version = db.get_user_version()
        if migration.version < 12 and migration.version <= current_version:
            continue
        if migration.version >= 12 and migration_schema_present(db, migration.version):
            if current_version < migration.version:
                db.set_user_version(migration.version)
            continue
        try:
            db.exec_script("BEGIN;\n" + migration.sql)
            db.set_user_version(max(current_version, migration.version))
            db.exec("COMMIT")
        except Exception:
            db.exec("ROLLBACK")
            raise

    to_version = db.get_user_version()
    return MigrationResult(
        from_version=from_version,
        to_version=to_version,
        trigram=use_trigram,
        search_mode="trigram" if use_trigram else "like",
    )


def fts_columns() -> tuple[str, ...]:
    return FTS_COLUMNS
