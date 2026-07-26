from refora_server.db.migrations import MIGRATIONS_DIR, SCHEMA_FILE


def test_database_resources_are_owned_by_the_python_package() -> None:
    assert SCHEMA_FILE.parent.name == "db"
    assert SCHEMA_FILE.is_file()
    assert MIGRATIONS_DIR.parent == SCHEMA_FILE.parent
    assert len(tuple(MIGRATIONS_DIR.glob("*.sql"))) >= 25
