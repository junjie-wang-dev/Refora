import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


def _map_category(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "sortOrder": row["sortOrder"],
        "createdAt": row["createdAt"],
    }


def createCategoriesRepository(db):
    def list_() -> list[dict[str, Any]]:
        cur = db.execute("SELECT * FROM categories ORDER BY sortOrder, name")
        rows = cur.fetchall()
        return [_map_category(r) for r in rows]

    def create(name: str) -> dict[str, Any]:
        id = str(uuid.uuid4())
        created_at = int(time.time() * 1000)
        db.execute(
            "INSERT INTO categories (id, name, sortOrder, createdAt) VALUES (?, ?, ?, ?)",
            [id, name, 0, created_at],
        )
        cur = db.execute("SELECT * FROM categories WHERE id = ?", [id])
        row = cur.fetchone()
        return _map_category(row)

    def rename(id: str, name: str) -> None:
        cur = db.execute(
            "UPDATE categories SET name = ? WHERE id = ?", [name, id]
        )
        if cur.rowcount == 0:
            raise RepoError("not_found", f"category not found: {id}")

    def remove(id: str) -> None:
        db.execute("DELETE FROM categories WHERE id = ?", [id])

    def assign(docId: str, catId: str) -> None:
        db.execute(
            "INSERT OR IGNORE INTO document_categories (documentId, categoryId) VALUES (?, ?)",
            [docId, catId],
        )

    def unassign(docId: str, catId: str) -> None:
        db.execute(
            "DELETE FROM document_categories WHERE documentId = ? AND categoryId = ?",
            [docId, catId],
        )

    def listForDocument(docId: str) -> list[dict[str, Any]]:
        cur = db.execute(
            "SELECT c.* FROM categories c JOIN document_categories dc ON c.id = dc.categoryId "
            "WHERE dc.documentId = ? ORDER BY c.sortOrder, c.name",
            [docId],
        )
        rows = cur.fetchall()
        return [_map_category(r) for r in rows]

    def countByCategory() -> dict[str, int]:
        cur = db.execute(
            "SELECT categoryId AS id, count(*) AS count FROM document_categories GROUP BY categoryId"
        )
        rows = cur.fetchall()
        return {row["id"]: row["count"] for row in rows}

    def getAllDocumentCategories() -> list[dict[str, str]]:
        cur = db.execute(
            "SELECT documentId, categoryId FROM document_categories"
        )
        rows = cur.fetchall()
        return [
            {"documentId": row["documentId"], "categoryId": row["categoryId"]}
            for row in rows
        ]

    return {
        "list": list_,
        "create": create,
        "rename": rename,
        "delete": remove,
        "assign": assign,
        "unassign": unassign,
        "listForDocument": listForDocument,
        "countByCategory": countByCategory,
        "getAllDocumentCategories": getAllDocumentCategories,
    }