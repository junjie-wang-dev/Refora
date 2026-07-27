import json
import os
import sqlite3
import time
import uuid
from typing import Any, Callable, TypedDict

from refora_server.library.authors import normalizeAuthors
from refora_server.library.paths import resolveFromLibrary, toLibraryRelative
from refora_server.repositories.errors import RepoError

EDITABLE_FIELDS: tuple[str, ...] = (
    "title",
    "authors",
    "year",
    "venue",
    "volume",
    "issue",
    "pages",
    "abstract",
    "keywords",
    "url",
    "doi",
    "arxivId",
    "note",
    "affiliations",
)

COLUMN_FOR: dict[str, str] = {
    "title": "title",
    "authors": "authors",
    "year": "year",
    "venue": "venue",
    "volume": "volume",
    "issue": "issue",
    "pages": "pages",
    "abstract": "abstract",
    "keywords": "keywords",
    "url": "url",
    "doi": "doi",
    "arxivId": "arxivId",
    "note": "note",
    "affiliations": "affiliations",
}

FTS_LIKE_COLUMNS: tuple[str, ...] = (
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

DOCUMENT_COLUMNS: tuple[str, ...] = (
    "id",
    "filePath",
    "originalFolderPath",
    "fileName",
    "fileSize",
    "fileHash",
    "title",
    "authors",
    "year",
    "venue",
    "volume",
    "issue",
    "pages",
    "abstract",
    "keywords",
    "url",
    "doi",
    "arxivId",
    "note",
    "affiliations",
    "starred",
    "addedAt",
    "lastReadAt",
    "updatedAt",
    "metadataSource",
    "metadataStatus",
    "metadataAttempts",
    "editedFields",
    "remoteValues",
    "fileMissing",
)

SORT_FIELDS: frozenset[str] = frozenset(
    {"title", "authors", "year", "venue", "addedAt", "filePath"}
)
SORT_DIRS: frozenset[str] = frozenset({"asc", "desc"})


class DocumentsRepoDeps(TypedDict):
    getLibraryFolder: Callable[[], str]
    getSearchMode: Callable[[], str]


def now_ms() -> int:
    return int(time.time() * 1000)


def newId() -> str:
    return str(uuid.uuid4())


def _is_editable_field(key: str) -> bool:
    return key in EDITABLE_FIELDS


def validatePatch(patch: dict[str, str]) -> list[str]:
    raw_keys = list(patch.keys())
    for key in raw_keys:
        if not _is_editable_field(key):
            raise RepoError("forbidden_field", f'field "{key}" is not editable', key)
        if not isinstance(patch[key], str):
            raise RepoError("invalid_value", f'field "{key}" must be a string', key)
    return raw_keys


def _parse_edited_fields(raw: Any) -> list[str]:
    if not isinstance(raw, str):
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [v for v in parsed if isinstance(v, str) and _is_editable_field(v)]


def _parse_remote_values(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str) or len(raw) == 0:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, dict):
        author_value = parsed.get("authors")
        if isinstance(author_value, dict) and isinstance(author_value.get("value"), str):
            normalized = normalizeAuthors(author_value["value"])
            author_value["value"] = normalized or ""
        return parsed
    return None


def _safe_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return None


def _map_document(row: sqlite3.Row, library_folder: str) -> dict[str, Any]:
    raw_file_path = row["filePath"]
    raw_original_folder_path = row["originalFolderPath"]
    return {
        "id": row["id"],
        "filePath": resolveFromLibrary(raw_file_path, library_folder),
        "originalFolderPath": (
            raw_original_folder_path
            if raw_original_folder_path and os.path.isabs(raw_original_folder_path)
            else resolveFromLibrary(raw_original_folder_path, library_folder)
        ),
        "fileName": row["fileName"],
        "fileSize": _safe_int(row["fileSize"]),
        "fileHash": row["fileHash"] if row["fileHash"] is not None else None,
        "title": row["title"] if row["title"] is not None else None,
        "authors": normalizeAuthors(row["authors"]),
        "year": row["year"] if row["year"] is not None else None,
        "venue": row["venue"] if row["venue"] is not None else None,
        "volume": row["volume"] if row["volume"] is not None else None,
        "issue": row["issue"] if row["issue"] is not None else None,
        "pages": row["pages"] if row["pages"] is not None else None,
        "abstract": row["abstract"] if row["abstract"] is not None else None,
        "keywords": row["keywords"] if row["keywords"] is not None else None,
        "url": row["url"] if row["url"] is not None else None,
        "doi": row["doi"] if row["doi"] is not None else None,
        "arxivId": row["arxivId"] if row["arxivId"] is not None else None,
        "note": row["note"] if row["note"] is not None else None,
        "affiliations": row["affiliations"] if row["affiliations"] is not None else None,
        "starred": _safe_int(row["starred"]) or 0,
        "addedAt": _safe_int(row["addedAt"]) or 0,
        "lastReadAt": _safe_int(row["lastReadAt"]),
        "updatedAt": _safe_int(row["updatedAt"]) or 0,
        "metadataSource": row["metadataSource"] if row["metadataSource"] is not None else None,
        "metadataStatus": row["metadataStatus"],
        "metadataAttempts": _safe_int(row["metadataAttempts"]) or 0,
        "editedFields": _parse_edited_fields(row["editedFields"]),
        "remoteValues": _parse_remote_values(row["remoteValues"]),
        "fileMissing": row["fileMissing"],
    }


def _order_by_clause(mode: str, sort: dict[str, str] | None) -> str:
    if sort is not None and sort.get("field") in SORT_FIELDS and sort.get("dir") in SORT_DIRS:
        return f'ORDER BY {sort["field"]} {sort["dir"]}'
    if mode == "recentlyRead":
        return "ORDER BY lastReadAt DESC"
    return "ORDER BY addedAt DESC"


def createDocumentsRepository(db, deps: DocumentsRepoDeps):
    def lib() -> str:
        return deps["getLibraryFolder"]()

    def list_(filter: dict[str, Any]) -> list[dict[str, Any]]:
        where = ""
        params: list[Any] = []
        mode = filter.get("mode")
        if mode == "recentlyRead":
            where = "WHERE lastReadAt IS NOT NULL"
        elif mode == "recentlyAdded":
            where = "WHERE addedAt >= ?"
            params.append(now_ms() - 7 * 24 * 60 * 60 * 1000)
        elif mode == "starred":
            where = "WHERE starred = 1"
        elif mode == "category":
            where = "WHERE id IN (SELECT documentId FROM document_categories WHERE categoryId = ?)"
            params.append(filter.get("categoryId"))
        order = _order_by_clause(mode, filter.get("sort"))
        cur = db.execute(f"SELECT * FROM documents {where} {order}", params)
        rows = cur.fetchall()
        lf = lib()
        return [_map_document(r, lf) for r in rows]

    def counts() -> dict[str, int]:
        cur = db.execute(
            'SELECT '
            'count(*) AS "all", '
            'count(*) FILTER (WHERE lastReadAt IS NOT NULL) AS recentlyRead, '
            'count(*) FILTER (WHERE starred = 1) AS starred '
            'FROM documents'
        )
        row = cur.fetchone()
        cur = db.execute(
            "SELECT count(*) AS c FROM documents WHERE addedAt >= ?",
            [now_ms() - 7 * 24 * 60 * 60 * 1000],
        )
        r2 = cur.fetchone()
        return {
            "all": row["all"],
            "recentlyRead": row["recentlyRead"],
            "recentlyAdded": r2["c"],
            "starred": row["starred"],
        }

    def search(q: str, limit: int = 500) -> list[dict[str, Any]]:
        trimmed = q.strip()
        if len(trimmed) == 0:
            return []
        safe_limit = (
            max(1, min(500, int(limit)))
            if isinstance(limit, (int, float)) and limit == limit
            else 500
        )
        if len(trimmed) >= 3 and deps["getSearchMode"]() == "trigram":
            literal_query = '"' + trimmed.replace('"', '""') + '"'
            cur = db.execute(
                "SELECT d.* FROM documents d JOIN docs_fts f ON d.rowid = f.rowid "
                "WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?",
                [literal_query, safe_limit],
            )
            rows = cur.fetchall()
            lf = lib()
            return [_map_document(r, lf) for r in rows]
        escaped = trimmed.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        like = f"%{escaped}%"
        clauses = " OR ".join(f"{c} LIKE ? ESCAPE '\\'" for c in FTS_LIKE_COLUMNS)
        params = [like] * len(FTS_LIKE_COLUMNS) + [safe_limit]
        cur = db.execute(f"SELECT * FROM documents WHERE {clauses} LIMIT ?", params)
        rows = cur.fetchall()
        lf = lib()
        return [_map_document(r, lf) for r in rows]

    def get(id: str) -> dict[str, Any] | None:
        cur = db.execute("SELECT * FROM documents WHERE id = ?", [id])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_document(row, lib())

    def insert(doc: dict[str, Any]) -> dict[str, Any]:
        lf = lib()
        values: list[Any] = [
            doc["id"],
            toLibraryRelative(doc["filePath"], lf),
            doc["originalFolderPath"],
            doc["fileName"],
            doc.get("fileSize"),
            doc.get("fileHash"),
            doc.get("title"),
            normalizeAuthors(doc.get("authors")),
            doc.get("year"),
            doc.get("venue"),
            doc.get("volume"),
            doc.get("issue"),
            doc.get("pages"),
            doc.get("abstract"),
            doc.get("keywords"),
            doc.get("url"),
            doc.get("doi"),
            doc.get("arxivId") if doc.get("arxivId") is not None else None,
            doc.get("note"),
            doc.get("affiliations") if doc.get("affiliations") is not None else None,
            doc.get("starred", 0),
            doc.get("addedAt"),
            doc.get("lastReadAt"),
            doc.get("updatedAt"),
            doc.get("metadataSource"),
            doc.get("metadataStatus"),
            doc.get("metadataAttempts", 0),
            json.dumps(doc.get("editedFields", [])),
            None if doc.get("remoteValues") is None else json.dumps(doc.get("remoteValues")),
            doc.get("fileMissing", 0),
        ]
        placeholders = ", ".join("?" for _ in DOCUMENT_COLUMNS)
        col_list = ", ".join(DOCUMENT_COLUMNS)
        db.execute(
            f"INSERT INTO documents ({col_list}) VALUES ({placeholders})", values
        )
        result = get(doc["id"])
        assert result is not None
        return result

    def update(id: str, patch: dict[str, str]) -> dict[str, Any]:
        keys = validatePatch(patch)
        if "authors" in patch:
            patch = {
                **patch,
                "authors": normalizeAuthors(patch["authors"]) or "",
            }
        current = get(id)
        if current is None:
            raise RepoError("not_found", f"document not found: {id}")
        if len(keys) == 0:
            return current
        edited = list(current["editedFields"])
        for key in keys:
            value = patch[key]
            if value == "":
                edited = [f for f in edited if f != key]
            elif key not in edited:
                edited.append(key)
        sets = ", ".join(f"{COLUMN_FOR[k]} = ?" for k in keys)
        params: list[Any] = [patch[k] for k in keys]
        params.append(json.dumps(edited))
        params.append(id)
        db.execute(f"UPDATE documents SET {sets}, editedFields = ? WHERE id = ?", params)
        result = get(id)
        assert result is not None
        return result

    def remove(id: str) -> None:
        db.execute("DELETE FROM documents WHERE id = ?", [id])

    def bulkDelete(ids: list[str]) -> None:
        if len(ids) == 0:
            return
        placeholders = ", ".join("?" for _ in ids)
        db.execute(f"DELETE FROM documents WHERE id IN ({placeholders})", ids)

    def deleteAll() -> None:
        db.execute("DELETE FROM documents")

    def setStarred(id: str, value: bool) -> None:
        db.execute(
            "UPDATE documents SET starred = ? WHERE id = ?",
            [1 if value else 0, id],
        )

    def findByPath(filePath: str) -> dict[str, Any] | None:
        lf = lib()
        rel = toLibraryRelative(filePath, lf)
        cur = db.execute("SELECT * FROM documents WHERE filePath = ?", [rel])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_document(row, lf)

    def findByHash(fileHash: str) -> dict[str, Any] | None:
        lf = lib()
        cur = db.execute("SELECT * FROM documents WHERE fileHash = ?", [fileHash])
        row = cur.fetchone()
        if row is None:
            return None
        return _map_document(row, lf)

    def updateFilePath(id: str, filePath: str, fileName: str) -> None:
        rel = toLibraryRelative(filePath, lib())
        db.execute(
            "UPDATE documents SET filePath = ?, fileName = ?, updatedAt = ? WHERE id = ?",
            [rel, fileName, now_ms(), id],
        )

    def updateFileIdentity(
        id: str, filePath: str, fileName: str, fileSize: int, fileHash: str
    ) -> None:
        rel = toLibraryRelative(filePath, lib())
        db.execute(
            "UPDATE documents SET filePath = ?, fileName = ?, fileSize = ?, fileHash = ?, "
            "fileMissing = 0, updatedAt = ? WHERE id = ?",
            [rel, fileName, fileSize, fileHash, now_ms(), id],
        )

    def setMetadataStatus(
        id: str, status: str, source: str | None = None
    ) -> None:
        if source is None:
            db.execute(
                "UPDATE documents SET metadataStatus = ?, updatedAt = ? WHERE id = ?",
                [status, now_ms(), id],
            )
        else:
            db.execute(
                "UPDATE documents SET metadataStatus = ?, metadataSource = ?, updatedAt = ? WHERE id = ?",
                [status, source, now_ms(), id],
            )

    def incrementMetadataAttempts(id: str) -> int:
        db.execute(
            "UPDATE documents SET metadataAttempts = metadataAttempts + 1, updatedAt = ? WHERE id = ?",
            [now_ms(), id],
        )
        cur = db.execute(
            "SELECT metadataAttempts AS a FROM documents WHERE id = ?", [id]
        )
        row = cur.fetchone()
        return row["a"] if row is not None else 0

    def setLastReadAt(id: str, ts: int | None) -> None:
        db.execute(
            "UPDATE documents SET lastReadAt = ?, updatedAt = ? WHERE id = ?",
            [ts, now_ms(), id],
        )

    def setFileMissing(id: str, missing: bool) -> None:
        db.execute(
            "UPDATE documents SET fileMissing = ?, updatedAt = ? WHERE id = ?",
            [1 if missing else 0, now_ms(), id],
        )

    def getResumableMetadataRows() -> list[dict[str, Any]]:
        lf = lib()
        cur = db.execute(
            "SELECT * FROM documents WHERE metadataStatus = 'pending' "
            "OR (metadataStatus = 'failed' AND metadataAttempts < 3)"
        )
        rows = cur.fetchall()
        return [_map_document(r, lf) for r in rows]

    def setRemoteValues(id: str, remoteValues: dict[str, Any] | None) -> None:
        if remoteValues is not None:
            author_value = remoteValues.get("authors")
            if isinstance(author_value, dict) and isinstance(author_value.get("value"), str):
                normalized = normalizeAuthors(author_value["value"])
                remoteValues = {
                    **remoteValues,
                    "authors": {
                        **author_value,
                        "value": normalized or "",
                    },
                }
        db.execute(
            "UPDATE documents SET remoteValues = ?, updatedAt = ? WHERE id = ?",
            [None if remoteValues is None else json.dumps(remoteValues), now_ms(), id],
        )

    def applyMetadataFields(
        id: str,
        fields: dict[str, str],
        remoteValues: dict[str, Any] | None,
        status: str,
        source: str | None,
    ) -> dict[str, Any]:
        keys = validatePatch(fields)
        if "authors" in fields:
            fields = {
                **fields,
                "authors": normalizeAuthors(fields["authors"]) or "",
            }
        if remoteValues is not None:
            author_value = remoteValues.get("authors")
            if isinstance(author_value, dict) and isinstance(author_value.get("value"), str):
                normalized = normalizeAuthors(author_value["value"])
                remoteValues = {
                    **remoteValues,
                    "authors": {
                        **author_value,
                        "value": normalized or "",
                    },
                }
        current = get(id)
        current_status = current["metadataStatus"] if current is not None else "pending"
        if (
            len(keys) == 0
            and remoteValues is None
            and status == current_status
        ):
            assert current is not None
            return current
        parts: list[str] = []
        params: list[Any] = []
        for key in keys:
            parts.append(f"{COLUMN_FOR[key]} = ?")
            params.append(fields[key])
        parts.append("remoteValues = ?")
        params.append(None if remoteValues is None else json.dumps(remoteValues))
        parts.append("metadataStatus = ?")
        params.append(status)
        if source is not None:
            parts.append("metadataSource = ?")
            params.append(source)
        parts.append("updatedAt = ?")
        params.append(now_ms())
        sql = "UPDATE documents SET " + ", ".join(parts) + " WHERE id = ?"
        params.append(id)
        db.execute(sql, params)
        result = get(id)
        assert result is not None
        return result

    return {
        "list": list_,
        "counts": counts,
        "search": search,
        "get": get,
        "insert": insert,
        "update": update,
        "delete": remove,
        "bulkDelete": bulkDelete,
        "deleteAll": deleteAll,
        "setStarred": setStarred,
        "findByPath": findByPath,
        "findByHash": findByHash,
        "updateFilePath": updateFilePath,
        "updateFileIdentity": updateFileIdentity,
        "setMetadataStatus": setMetadataStatus,
        "incrementMetadataAttempts": incrementMetadataAttempts,
        "setLastReadAt": setLastReadAt,
        "setFileMissing": setFileMissing,
        "getResumableMetadataRows": getResumableMetadataRows,
        "setRemoteValues": setRemoteValues,
        "applyMetadataFields": applyMetadataFields,
    }
