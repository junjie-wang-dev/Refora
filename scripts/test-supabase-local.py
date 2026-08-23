from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from urllib.parse import unquote, urlparse

import pg8000.dbapi


ROOT = Path(__file__).resolve().parents[1]


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def connect():
    parsed_url = urlparse(require_env("REFORA_SUPABASE_TEST_DB_URL"))
    return pg8000.dbapi.connect(
        user=unquote(parsed_url.username or ""),
        password=require_env("REFORA_SUPABASE_TEST_DB_PASSWORD"),
        host=parsed_url.hostname,
        port=parsed_url.port or 5432,
        database=parsed_url.path.lstrip("/") or "postgres",
        timeout=15,
        ssl_context=False,
    )


def apply_sql(connection, path: Path) -> None:
    cursor = connection.cursor()
    try:
        cursor.execute(path.read_text(encoding="utf-8"))
        connection.commit()
    except Exception as error:
        connection.rollback()
        raise RuntimeError(f"Failed to apply {path.name}") from error
    finally:
        cursor.close()


def load_rpc_suite() -> ModuleType:
    path = ROOT / "scripts" / "test-supabase-rpc.py"
    spec = importlib.util.spec_from_file_location("refora_supabase_rpc_suite", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the Supabase RPC suite")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    connection = connect()
    try:
        apply_sql(connection, ROOT / "scripts" / "supabase-test-bootstrap.sql")
        for migration in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            apply_sql(connection, migration)
    finally:
        connection.close()
    load_rpc_suite().main()


if __name__ == "__main__":
    main()
