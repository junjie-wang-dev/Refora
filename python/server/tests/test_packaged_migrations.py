from pathlib import Path

from refora_server.db.migrations import _schema_dir


def test_schema_dir_uses_packaged_resources_when_available(tmp_path: Path) -> None:
    package = tmp_path / "Resources" / "python-server" / "refora_server" / "db"
    package.mkdir(parents=True)
    (tmp_path / "Resources" / "python-server" / "db").mkdir()
    (tmp_path / "Resources" / "python-server" / "db" / "schema.sql").write_text("SELECT 1;", encoding="utf-8")
    module_path = package / "migrations.py"

    assert _schema_dir(module_path) == tmp_path / "Resources" / "python-server" / "db"
