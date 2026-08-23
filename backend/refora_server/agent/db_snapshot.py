from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path


_LIBRARY_TABLES = (
    "documents",
    "categories",
    "document_categories",
    "ai_summaries",
    "document_ocr_results",
    "pdf_annotations",
)
_WORKSPACE_TABLES = (
    "workspaces",
    "workspace_items",
    "workspace_notes",
    "workspace_assets",
    "workspace_connections",
    "workspace_canvas_state",
    "ai_reports",
)


def _table_exists(database: sqlite3.Connection, table: str) -> bool:
    return database.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def _copy_table(
    source: sqlite3.Connection,
    destination: sqlite3.Connection,
    table: str,
    where: str = "",
    params: tuple[object, ...] = (),
) -> None:
    row = source.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if row is None or not isinstance(row[0], str):
        return
    destination.execute(row[0])
    columns = [
        item[1]
        for item in source.execute(f'PRAGMA table_info("{table}")').fetchall()
        if isinstance(item[1], str)
    ]
    if not columns:
        return
    quoted_columns = ", ".join(f'"{column}"' for column in columns)
    query = f'SELECT {quoted_columns} FROM "{table}"'
    if where:
        query += f" WHERE {where}"
    cursor = source.execute(query, params)
    insert = (
        f'INSERT INTO "{table}" ({quoted_columns}) VALUES '
        f"({', '.join('?' for _ in columns)})"
    )
    while rows := cursor.fetchmany(500):
        destination.executemany(insert, rows)


def create_db_snapshot(
    db_path: str | Path,
    dest_path: str | Path,
    workspace_id: str | None = None,
) -> Path:
    source_path = Path(db_path).expanduser().resolve()
    destination_path = Path(dest_path).expanduser().resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination_path.with_name(
        f"{destination_path.name}.tmp-{uuid.uuid4().hex}"
    )
    source_uri = f"{source_path.as_uri()}?mode=ro"
    try:
        with sqlite3.connect(source_uri, uri=True) as source:
            source.execute("PRAGMA query_only = ON")
            source.execute("PRAGMA busy_timeout = 5000")
            with sqlite3.connect(temporary_path) as destination:
                destination.execute(
                    "CREATE TABLE refora_readonly_context ("
                    "schemaVersion INTEGER NOT NULL, scope TEXT NOT NULL, workspaceId TEXT)"
                )
                destination.execute(
                    "INSERT INTO refora_readonly_context VALUES (?, ?, ?)",
                    (2, "workspace" if workspace_id else "library", workspace_id),
                )
                has_workspace_items = _table_exists(source, "workspace_items")
                document_scope = ""
                document_params: tuple[object, ...] = ()
                if workspace_id:
                    if has_workspace_items:
                        document_scope = (
                            "id IN (SELECT docId FROM workspace_items "
                            "WHERE workspaceId = ? AND docId IS NOT NULL)"
                        )
                        document_params = (workspace_id,)
                    else:
                        document_scope = "0"
                for table in _LIBRARY_TABLES:
                    if not _table_exists(source, table):
                        continue
                    if table == "documents":
                        _copy_table(
                            source,
                            destination,
                            table,
                            document_scope,
                            document_params,
                        )
                    elif table == "categories" and workspace_id:
                        _copy_table(
                            source,
                            destination,
                            table,
                            "id IN (SELECT categoryId FROM document_categories "
                            "WHERE documentId IN (SELECT docId FROM workspace_items "
                            "WHERE workspaceId = ? AND docId IS NOT NULL))",
                            (workspace_id,),
                        )
                    elif table == "document_categories" and workspace_id:
                        _copy_table(
                            source,
                            destination,
                            table,
                            "documentId IN (SELECT docId FROM workspace_items "
                            "WHERE workspaceId = ? AND docId IS NOT NULL)",
                            (workspace_id,),
                        )
                    elif workspace_id:
                        document_column = "docId" if table == "ai_summaries" else "documentId"
                        _copy_table(
                            source,
                            destination,
                            table,
                            f"{document_column} IN (SELECT docId FROM workspace_items "
                            "WHERE workspaceId = ? AND docId IS NOT NULL)",
                            (workspace_id,),
                        )
                    else:
                        _copy_table(source, destination, table)
                if workspace_id:
                    for table in _WORKSPACE_TABLES:
                        if not _table_exists(source, table):
                            continue
                        column = "id" if table == "workspaces" else "workspaceId"
                        _copy_table(
                            source,
                            destination,
                            table,
                            f"{column} = ?",
                            (workspace_id,),
                        )
                destination.commit()
        os.chmod(temporary_path, 0o400)
        os.replace(temporary_path, destination_path)
        os.chmod(destination_path, 0o400)
        return destination_path
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def cleanup_snapshot(dest_path: str | Path) -> None:
    Path(dest_path).unlink(missing_ok=True)
