from __future__ import annotations

import json
import time
from typing import Any


class PdfAnnotationsRepository:
    def __init__(self, db: Any) -> None:
        self._db = db

    def get(self, document_id: str) -> list[dict[str, Any]]:
        row = self._db.execute(
            "SELECT annotationsJson FROM pdf_annotations WHERE documentId = ?",
            (document_id,),
        ).fetchone()
        if row is None:
            return []
        try:
            value = json.loads(row[0])
        except (TypeError, ValueError):
            return []
        return value if isinstance(value, list) else []

    def set(
        self,
        document_id: str,
        annotations: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        encoded = json.dumps(annotations, allow_nan=False, separators=(",", ":"))
        self._db.execute(
            """
            INSERT INTO pdf_annotations(documentId, annotationsJson, updatedAt)
            VALUES (?, ?, ?)
            ON CONFLICT(documentId) DO UPDATE SET
              annotationsJson = excluded.annotationsJson,
              updatedAt = excluded.updatedAt
            """,
            (document_id, encoded, int(time.time() * 1000)),
        )
        return annotations


def createPdfAnnotationsRepository(db: Any) -> PdfAnnotationsRepository:
    return PdfAnnotationsRepository(db)
