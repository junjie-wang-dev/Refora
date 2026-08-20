from pathlib import Path


MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def test_sync_functions_keep_security_definer_hardening() -> None:
    for path in sorted(MIGRATIONS.glob("*_sync_*.sql")):
        sql = path.read_text(encoding="utf-8").lower()
        for body in sql.split("create or replace function public.")[1:]:
            definition = body.split("$$;", 1)[0]
            assert "security definer" in definition
            assert "set search_path = ''" in definition


def test_sync_hardening_enforces_privacy_idempotency_and_quotas() -> None:
    sql = (MIGRATIONS / "202608200002_sync_hardening.sql").read_text(
        encoding="utf-8"
    ).lower()
    assert "operation id was reused for a different request" in sql
    assert "deleted entities cannot retain a payload" in sql
    assert "document entities must use a sha-256 entity id" in sql
    assert "account sync storage quota exceeded" in sql
    assert "cursor exceeds the library sequence" in sql
    assert "refora_sync_list_libraries" in sql
    assert "refora_sync_delete_library" in sql
    assert "grant execute" in sql
    assert "to service_role" not in sql


def test_sync_operation_ledger_is_compact_bounded_and_short_lived() -> None:
    sql = (MIGRATIONS / "202608200003_sync_operation_limits.sql").read_text(
        encoding="utf-8"
    ).lower()
    assert "result = result - 'payload'" in sql
    assert "octet_length(result::text) <= 4096" in sql
    assert "interval '1 day'" in sql
    assert "account sync operation quota exceeded" in sql
    assert ">= 20000" in sql
    assert "refora_sync_push_v2_internal" in sql
    assert "from public, anon, authenticated" in sql
