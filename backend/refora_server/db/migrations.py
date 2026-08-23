from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from refora_server.library.authors import normalizeAuthors
from refora_server.library.document_ids import is_safe_document_id

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
_AUTHOR_ACRONYM_RE = re.compile(r"[A-Za-z][A-Za-z0-9]{1,9}")
_AUTHOR_WORD_RE = re.compile(r"[A-Za-z0-9]+")
_INSTITUTION_PHRASE_RE = re.compile(
    r"\b(?:university|institute|institution|laborator(?:y|ies)|department|"
    r"cent(?:er|re)|association|society|corporation|company|foundation|"
    r"organi[sz]ation|committee|consortium|council|agency|ministry|hospital|"
    r"school|college|academy|government)\b",
    re.IGNORECASE,
)
_ACRONYM_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "at",
        "de",
        "der",
        "for",
        "in",
        "la",
        "of",
        "on",
        "the",
        "to",
    }
)
_EXACT_LEGACY_AUTHOR_REPAIRS = {
    "CSAIL California Institute of Technology": "California Institute of Technology, CSAIL",
    "CSAIL Massachusetts Institute of Technology": "Massachusetts Institute of Technology, CSAIL",
}


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
    def execute(self, sql: str, params: list[object]) -> None: ...
    def fetchall(self, sql: str, params: list[object]) -> list[Any]: ...


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


def _sync_library_identity_schema_present(db: SqliteLike) -> bool:
    return _has_columns(
        db,
        "sync_state",
        ["libraryId", "remoteLibraryId", "enabled", "updatedAt"],
    ) and not any(
        db.has_object("table", table)
        for table in ("sync_outbox", "sync_entity_versions", "sync_conflicts")
    )


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
    if version == 28:
        return _has_columns(db, "workspace_notes", ["color"])
    if version == 29:
        return _has_objects(db, [("table", "pdf_annotations")])
    if version == 30:
        return _has_columns(db, "agent_runs", ["activeDocumentId"])
    if version == 31:
        return _has_columns(db, "chat_threads", ["agentProfileId"]) and _has_columns(
            db, "agent_runs", ["agentProfileId", "runtimeSessionId"]
        ) and _has_objects(
            db,
            [
                ("table", "agent_profiles"),
                ("table", "agent_runtime_sessions"),
                ("index", "idx_agent_profiles_kind"),
            ],
        )
    if version == 32:
        if _sync_library_identity_schema_present(db):
            return True
        return _has_objects(
            db,
            [
                ("table", "sync_state"),
                ("table", "sync_outbox"),
                ("table", "sync_entity_versions"),
                ("table", "sync_conflicts"),
                ("index", "idx_sync_outbox_pending"),
                ("index", "idx_sync_conflicts_unresolved"),
            ],
        )
    if version == 33:
        if _sync_library_identity_schema_present(db):
            return True
        return _has_columns(db, "sync_state", ["enabled"]) and _has_objects(
            db,
            [
                ("trigger", "sync_outbox_validate_insert"),
                ("trigger", "sync_outbox_validate_update"),
                ("trigger", "sync_entity_versions_validate_insert"),
                ("trigger", "sync_entity_versions_validate_update"),
                ("trigger", "sync_conflicts_validate_insert"),
                ("trigger", "sync_conflicts_validate_update"),
            ],
        )
    if version == 34:
        return _sync_library_identity_schema_present(db)
    if version == 37:
        return _has_columns(
            db,
            "documents",
            ["fileDevice", "fileInode", "fileMtimeNs"],
        )
    return version <= current


def _regular_file(path: str) -> bool:
    return os.path.isfile(path) and not os.path.islink(path)


def _repair_legacy_paths(db: SqliteLike) -> None:
    if not db.has_object("table", "legacy_path_repair_candidates"):
        return
    rows = db.fetchall(
        "SELECT c.documentId, c.candidatePath, c.relativePath, s.value "
        "FROM legacy_path_repair_candidates c "
        "LEFT JOIN settings s ON s.key = 'libraryFolderPath'",
        [],
    )
    if not rows:
        return
    db.exec("BEGIN")
    try:
        for row in rows:
            document_id = row[0]
            candidate_path = row[1]
            relative_path = row[2]
            raw_library = row[3]
            if not all(
                isinstance(value, str)
                for value in (document_id, candidate_path, relative_path, raw_library)
            ):
                continue
            try:
                library_folder = json.loads(raw_library)
            except (TypeError, ValueError):
                continue
            if not isinstance(library_folder, str) or not library_folder:
                continue
            library_path = os.path.realpath(
                os.path.join(library_folder, relative_path)
            )
            if _regular_file(library_path):
                db.execute(
                    "DELETE FROM legacy_path_repair_candidates WHERE documentId = ?",
                    [document_id],
                )
                continue
            if not _regular_file(candidate_path):
                continue
            db.execute(
                "UPDATE documents SET filePath = ? WHERE id = ? AND filePath = ?",
                [candidate_path, document_id, relative_path],
            )
            db.execute(
                "DELETE FROM legacy_path_repair_candidates WHERE documentId = ?",
                [document_id],
            )
        db.exec("COMMIT")
    except Exception:
        db.exec("ROLLBACK")
        raise


def _new_document_id(db: SqliteLike) -> str:
    while True:
        candidate = str(uuid.uuid4())
        if not db.fetchall("SELECT 1 FROM documents WHERE id = ?", [candidate]):
            return candidate


def _repair_report_sources(db: SqliteLike, old_id: str, new_id: str) -> None:
    rows = db.fetchall("SELECT id, sourceDocIds FROM ai_reports", [])
    for row in rows:
        report_id = row[0]
        raw_sources = row[1]
        if not isinstance(report_id, str) or not isinstance(raw_sources, str):
            continue
        try:
            sources = json.loads(raw_sources)
        except (TypeError, ValueError):
            continue
        if not isinstance(sources, list) or old_id not in sources:
            continue
        updated = [new_id if source == old_id else source for source in sources]
        db.execute(
            "UPDATE ai_reports SET sourceDocIds = ? WHERE id = ?",
            [json.dumps(updated, ensure_ascii=False), report_id],
        )


def _repair_unsafe_document_ids(db: SqliteLike) -> None:
    if not db.has_object("table", "legacy_document_id_repair_candidates"):
        return
    rows = db.fetchall(
        "SELECT documentId FROM legacy_document_id_repair_candidates ORDER BY documentId",
        [],
    )
    candidates = [row[0] for row in rows if isinstance(row[0], str)]
    if not candidates:
        return
    columns = [
        row[1]
        for row in db.fetchall("PRAGMA table_info(documents)", [])
        if isinstance(row[1], str) and row[1] != "id"
    ]
    quoted_columns = ", ".join(f'"{column}"' for column in columns)
    db.exec("BEGIN")
    try:
        for old_id in candidates:
            if is_safe_document_id(old_id):
                db.execute(
                    "DELETE FROM legacy_document_id_repair_candidates WHERE documentId = ?",
                    [old_id],
                )
                continue
            new_id = _new_document_id(db)
            db.execute(
                f'INSERT INTO documents (id, {quoted_columns}) '
                f'SELECT ?, {quoted_columns} FROM documents WHERE id = ?',
                [new_id, old_id],
            )
            for table, column in (
                ("document_categories", "documentId"),
                ("workspace_items", "docId"),
                ("document_ocr_jobs", "documentId"),
                ("document_ocr_results", "documentId"),
                ("pdf_annotations", "documentId"),
                ("agent_runs", "activeDocumentId"),
                ("legacy_path_repair_candidates", "documentId"),
            ):
                db.execute(
                    f'UPDATE "{table}" SET "{column}" = ? WHERE "{column}" = ?',
                    [new_id, old_id],
                )
            db.execute(
                "UPDATE ai_summaries SET docId = ? WHERE docId = ?",
                [new_id, old_id],
            )
            _repair_report_sources(db, old_id, new_id)
            db.execute(
                "DELETE FROM legacy_document_id_repair_candidates WHERE documentId = ?",
                [old_id],
            )
            db.execute("DELETE FROM documents WHERE id = ?", [old_id])
        db.exec("COMMIT")
    except Exception:
        db.exec("ROLLBACK")
        raise


def _cleanup_legacy_chat_terminal_messages(db: SqliteLike) -> None:
    if not db.has_object("table", "legacy_chat_terminal_cleanup"):
        return
    if not db.fetchall("SELECT 1 FROM legacy_chat_terminal_cleanup WHERE id = 1", []):
        return
    rows = db.fetchall(
        "SELECT m.id, m.content, r.status FROM chat_messages m "
        "JOIN agent_runs r ON r.assistantMessageId = m.id "
        "WHERE r.status IN ('cancelled', 'failed')",
        [],
    )
    cancelled_suffix = "\n\n[Response cancelled by user]"
    failed_marker = "\n\n[Response interrupted: "
    db.exec("BEGIN")
    try:
        for row in rows:
            message_id = row[0]
            content = row[1]
            status = row[2]
            if not all(isinstance(value, str) for value in (message_id, content, status)):
                continue
            cleaned: str | None = None
            if status == "cancelled":
                if content == "[Response cancelled by user]":
                    cleaned = ""
                elif content.endswith(cancelled_suffix):
                    cleaned = content[: -len(cancelled_suffix)]
            elif status == "failed" and content.endswith("]"):
                marker_index = content.rfind(failed_marker)
                if marker_index >= 0:
                    cleaned = content[:marker_index]
            if cleaned is None:
                continue
            if cleaned:
                db.execute(
                    "UPDATE chat_messages SET content = ? WHERE id = ?",
                    [cleaned, message_id],
                )
            else:
                db.execute("DELETE FROM chat_messages WHERE id = ?", [message_id])
        db.execute("DELETE FROM legacy_chat_terminal_cleanup WHERE id = 1", [])
        db.exec("COMMIT")
    except Exception:
        db.exec("ROLLBACK")
        raise


def _repair_institution_author(author: str) -> str:
    exact = _EXACT_LEGACY_AUTHOR_REPAIRS.get(author)
    if exact is not None:
        return exact
    if "," in author:
        return author
    acronym, separator, phrase = author.partition(" ")
    if not separator or not _AUTHOR_ACRONYM_RE.fullmatch(acronym):
        return author
    if not _INSTITUTION_PHRASE_RE.search(phrase):
        return author
    words = _AUTHOR_WORD_RE.findall(phrase)
    derived = "".join(
        word[0] for word in words if word.casefold() not in _ACRONYM_STOPWORDS
    )
    if len(derived) < 2 or acronym.casefold() != derived.casefold():
        return author
    return f"{phrase}, {acronym}"


def _repair_legacy_authors(db: SqliteLike) -> None:
    if not db.has_object("table", "legacy_author_repair_pending"):
        return
    if not db.fetchall("SELECT 1 FROM legacy_author_repair_pending WHERE id = 1", []):
        return
    db.exec("BEGIN")
    try:
        rows = db.fetchall(
            "SELECT rowid, authors FROM documents "
            "WHERE authors IS NOT NULL AND trim(authors) <> ''",
            [],
        )
        for row in rows:
            rowid = row[0]
            authors = row[1]
            if not isinstance(authors, str):
                continue
            parts = [part.strip() for part in authors.split(";") if part.strip()]
            repaired = [_repair_institution_author(part) for part in parts]
            if repaired != parts:
                db.execute(
                    "UPDATE documents SET authors = ? WHERE rowid = ?",
                    ["; ".join(repaired), rowid],
                )
        db.execute("DELETE FROM legacy_author_repair_pending WHERE id = 1", [])
        db.exec("COMMIT")
    except Exception:
        db.exec("ROLLBACK")
        raise


def _normalize_document_authors(db: SqliteLike) -> None:
    rows = db.fetchall(
        "SELECT rowid, authors FROM documents "
        "WHERE authors IS NOT NULL AND trim(authors) <> ''",
        [],
    )
    db.exec("BEGIN")
    try:
        for row in rows:
            rowid = row[0]
            authors = row[1]
            if not isinstance(authors, str):
                continue
            normalized = normalizeAuthors(authors)
            if normalized != authors:
                db.execute(
                    "UPDATE documents SET authors = ? WHERE rowid = ?",
                    [normalized, rowid],
                )
        db.set_user_version(27)
        db.exec("COMMIT")
    except Exception:
        db.exec("ROLLBACK")
        raise


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
        if migration.version == 27 and current_version < 27:
            _normalize_document_authors(db)
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

    _repair_legacy_paths(db)
    _repair_legacy_authors(db)
    _repair_unsafe_document_ids(db)
    _cleanup_legacy_chat_terminal_messages(db)

    to_version = db.get_user_version()
    return MigrationResult(
        from_version=from_version,
        to_version=to_version,
        trigram=use_trigram,
        search_mode="trigram" if use_trigram else "like",
    )


def fts_columns() -> tuple[str, ...]:
    return FTS_COLUMNS
