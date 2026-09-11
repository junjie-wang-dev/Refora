from __future__ import annotations

import json
import time
import uuid
from typing import Any, Callable

from refora_server.repositories.errors import RepoError


def merge_documents(db: Any, get: Callable, update: Callable, target_id: str, source_ids: list[str]) -> dict[str, Any]:
    ids = list(dict.fromkeys(source_ids))
    if not ids or target_id in ids or len(ids) > 499:
        raise RepoError("invalid_value", "Select a primary document and at least one other document")
    target = get(target_id)
    sources = [get(document_id) for document_id in ids]
    if target is None or any(source is None for source in sources):
        raise RepoError("not_found", "One of the selected documents no longer exists")
    placeholders = ", ".join("?" for _ in [target_id, *ids])
    if db.execute(f"SELECT 1 FROM document_ocr_jobs WHERE documentId IN ({placeholders}) AND status IN ('queued', 'running') LIMIT 1", [target_id, *ids]).fetchone():
        raise RepoError("ocr_in_progress", "Wait for OCR to finish or cancel it before merging these documents")
    db.execute("SAVEPOINT merge_documents")
    try:
        for source in sources:
            source_id = source["id"]
            annotation_row = db.execute("SELECT annotationsJson FROM pdf_annotations WHERE documentId = ?", [source_id]).fetchone()
            source_annotations = json.loads(annotation_row[0]) if annotation_row else []
            if source_annotations and target.get("filePath") and (not source.get("fileHash") or not target.get("fileHash") or source.get("fileHash") != target.get("fileHash")):
                raise RepoError("annotation_pdf_mismatch", "Annotated PDFs have different content. Keep the annotated PDF as the primary document, or merge only identical PDF versions.")
            patch = {key: str(value) for key, value in source.items() if key in ("title", "authors", "year", "venue", "volume", "issue", "pages", "abstract", "keywords", "url", "doi", "arxivId", "affiliations") and value and not target.get(key)}
            notes = [value for value in (target.get("note"), source.get("note")) if value]
            if len(notes) == 2 and notes[0] != notes[1]:
                patch["note"] = "\n\n".join(notes)
            elif notes:
                patch["note"] = notes[0]
            if patch:
                update(target_id, patch)
            if not target.get("filePath") and source.get("filePath"):
                columns = ("filePath", "originalFolderPath", "fileName", "fileSize", "fileHash", "fileMissing", "fileDevice", "fileInode", "fileMtimeNs")
                db.execute("UPDATE documents SET " + ", ".join(f"{column} = (SELECT {column} FROM documents WHERE id = ?)" for column in columns) + " WHERE id = ?", [*[source_id] * len(columns), target_id])
            db.execute("UPDATE documents SET starred = MAX(starred, ?), lastReadAt = NULLIF(MAX(COALESCE(lastReadAt, 0), ?), 0), updatedAt = ? WHERE id = ?", [source.get("starred", 0), source.get("lastReadAt") or 0, int(time.time() * 1000), target_id])
            db.execute("INSERT OR IGNORE INTO document_categories(documentId, categoryId) SELECT ?, categoryId FROM document_categories WHERE documentId = ?", [target_id, source_id])
            if source_annotations:
                row = db.execute("SELECT annotationsJson FROM pdf_annotations WHERE documentId = ?", [target_id]).fetchone()
                annotations = json.loads(row[0]) if row else []
                for annotation in source_annotations:
                    if annotation in annotations:
                        continue
                    if any(value.get("id") == annotation.get("id") for value in annotations):
                        annotation = {**annotation, "id": str(uuid.uuid4())}
                    annotations.append(annotation)
                db.execute("INSERT INTO pdf_annotations(documentId, annotationsJson, updatedAt) VALUES (?, ?, ?) ON CONFLICT(documentId) DO UPDATE SET annotationsJson = excluded.annotationsJson, updatedAt = excluded.updatedAt", [target_id, json.dumps(annotations), int(time.time() * 1000)])
            cards = db.execute("SELECT id, workspaceId FROM workspace_items WHERE docId = ?", [source_id]).fetchall()
            for card in cards:
                primary = db.execute("SELECT id FROM workspace_items WHERE workspaceId = ? AND docId = ?", [card["workspaceId"], target_id]).fetchone()
                if primary is None:
                    db.execute("UPDATE workspace_items SET docId = ? WHERE id = ?", [target_id, card["id"]])
                else:
                    for column in ("sourceItemId", "targetItemId"):
                        other = "targetItemId" if column == "sourceItemId" else "sourceItemId"
                        db.execute(f"UPDATE OR IGNORE workspace_connections SET {column} = ? WHERE {column} = ? AND {other} <> ?", [primary[0], card["id"], primary[0]])
                    db.execute("DELETE FROM workspace_items WHERE id = ?", [card["id"]])
            for table, column in (("ai_report_sources", "docId"), ("document_ocr_jobs", "documentId"), ("document_ocr_results", "documentId"), ("ai_summaries", "docId"), ("agent_runs", "activeDocumentId"), ("chat_messages", "activeDocumentId")):
                db.execute(f"UPDATE OR IGNORE {table} SET {column} = ? WHERE {column} = ?", [target_id, source_id])
            for row in db.execute("SELECT id, sourceDocIds FROM ai_reports").fetchall():
                values = json.loads(row["sourceDocIds"] or "[]")
                if source_id in values:
                    values = list(dict.fromkeys(target_id if value == source_id else value for value in values))
                    db.execute("UPDATE ai_reports SET sourceDocIds = ? WHERE id = ?", [json.dumps(values), row["id"]])
            if source.get("fileHash"):
                db.execute("INSERT OR IGNORE INTO document_file_aliases(fileHash, documentId) VALUES (?, ?)", [source["fileHash"], target_id])
            db.execute("UPDATE document_file_aliases SET documentId = ? WHERE documentId = ?", [target_id, source_id])
            db.execute("DELETE FROM documents WHERE id = ?", [source_id])
            target = get(target_id)
        db.execute("RELEASE merge_documents")
    except Exception:
        db.execute("ROLLBACK TO merge_documents")
        db.execute("RELEASE merge_documents")
        raise
    return target
