import json
import sqlite3

import pytest

from conftest import MIGRATIONS_DIR, SCHEMA_SQL
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations


@pytest.mark.parametrize(
    ("library_name", "sibling_name"),
    [
        ("Library_2025", "LibraryX2025"),
        ("Library%2025", "LibraryArchive2025"),
    ],
)
def test_forward_migration_repairs_legacy_like_wildcard_path_damage(
    tmp_path, library_name: str, sibling_name: str
) -> None:
    library = tmp_path / library_name
    sibling = tmp_path / sibling_name
    library.mkdir()
    sibling.mkdir()
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
    db.executescript(
        (MIGRATIONS_DIR / "0002_drop_categories_moveToLibrary.sql").read_text(
            encoding="utf-8"
        )
    )
    db.execute("PRAGMA user_version = 2")
    db.execute(
        "INSERT INTO settings(key, value) VALUES ('libraryFolderPath', ?)",
        [json.dumps(str(library))],
    )
    outside_path = sibling / "nested" / "outside.pdf"
    inside_path = library / "nested" / "inside.pdf"
    ambiguous_source = sibling / "ambiguous.pdf"
    legacy_ambiguous_relative = str(ambiguous_source)[len(str(library)) + 1 :]
    ambiguous_library = library / legacy_ambiguous_relative
    outside_path.parent.mkdir()
    inside_path.parent.mkdir()
    ambiguous_library.parent.mkdir(parents=True, exist_ok=True)
    outside_path.write_bytes(b"%PDF outside")
    inside_path.write_bytes(b"%PDF inside")
    ambiguous_source.write_bytes(b"%PDF original")
    ambiguous_library.write_bytes(b"%PDF managed")
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, addedAt, updatedAt) "
        "VALUES (?, ?, ?, ?, 1, 1)",
        ["outside", str(outside_path), str(outside_path.parent), outside_path.name],
    )
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, addedAt, updatedAt) "
        "VALUES (?, ?, ?, ?, 1, 1)",
        ["inside", str(inside_path), str(inside_path.parent), inside_path.name],
    )
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, addedAt, updatedAt) "
        "VALUES (?, ?, ?, ?, 1, 1)",
        [
            "ambiguous",
            str(ambiguous_source),
            str(ambiguous_source.parent),
            ambiguous_source.name,
        ],
    )

    result = run_migrations(_SqliteAdapter(db))

    assert result.to_version == 38
    assert db.execute(
        "SELECT filePath FROM documents WHERE id = 'outside'"
    ).fetchone()["filePath"] == str(outside_path)
    assert db.execute(
        "SELECT filePath FROM documents WHERE id = 'inside'"
    ).fetchone()["filePath"] == "nested/inside.pdf"
    assert db.execute(
        "SELECT filePath FROM documents WHERE id = 'ambiguous'"
    ).fetchone()["filePath"] == legacy_ambiguous_relative
    assert db.execute(
        "SELECT COUNT(*) FROM legacy_path_repair_candidates"
    ).fetchone()[0] == 0
