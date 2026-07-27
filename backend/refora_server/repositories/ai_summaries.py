import json
import sqlite3
import time
from typing import Any


def now_ms() -> int:
    return int(time.time() * 1000)


def _parse_summary_content(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str) or len(raw) == 0:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _safe_int(v: Any) -> int:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return 0


def _map_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "docId": row["docId"],
        "model": row["model"] if row["model"] is not None else None,
        "content": _parse_summary_content(row["summaryJson"]),
        "createdAt": _safe_int(row["createdAt"]),
        "updatedAt": _safe_int(row["updatedAt"]),
    }


def createAiSummariesRepository(db):
    def getSummary(docId: str) -> dict[str, Any] | None:
        cur = db.execute("SELECT * FROM ai_summaries WHERE docId = ?", [docId])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_summary(row)

    def setSummary(docId: str, model: str, content: dict[str, Any]) -> None:
        now = now_ms()
        summary_json = json.dumps(content)
        db.execute(
            "INSERT INTO ai_summaries (docId, model, summaryJson, fullText, createdAt, updatedAt) "
            "VALUES (?, ?, ?, NULL, ?, ?) "
            "ON CONFLICT(docId) DO UPDATE SET "
            "model = excluded.model, "
            "summaryJson = excluded.summaryJson, "
            "updatedAt = excluded.updatedAt",
            [docId, model, summary_json, now, now],
        )

    def getFullText(docId: str) -> dict[str, Any] | None:
        cur = db.execute(
            "SELECT fullText, fullTextHash FROM ai_summaries WHERE docId = ?",
            [docId],
        )
        row = cur.fetchone()
        if row is None or row["fullText"] is None:
            return None
        return {"text": row["fullText"], "hash": row["fullTextHash"] if row["fullTextHash"] is not None else None}

    def setFullText(docId: str, text: str, hash: str | None) -> None:
        now = now_ms()
        db.execute(
            "INSERT INTO ai_summaries (docId, model, summaryJson, fullText, fullTextHash, createdAt, updatedAt) "
            "VALUES (?, NULL, NULL, ?, ?, ?, ?) "
            "ON CONFLICT(docId) DO UPDATE SET "
            "fullText = excluded.fullText, "
            "fullTextHash = excluded.fullTextHash, "
            "updatedAt = excluded.updatedAt",
            [docId, text, hash, now, now],
        )

    def remove(docId: str) -> None:
        db.execute("DELETE FROM ai_summaries WHERE docId = ?", [docId])

    return {
        "getSummary": getSummary,
        "setSummary": setSummary,
        "getFullText": getFullText,
        "setFullText": setFullText,
        "delete": remove,
    }
