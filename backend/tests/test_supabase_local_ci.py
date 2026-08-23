from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_local_harness_bootstraps_and_applies_every_migration() -> None:
    harness = (ROOT / "scripts" / "test-supabase-local.py").read_text(
        encoding="utf-8"
    )
    bootstrap = (ROOT / "scripts" / "supabase-test-bootstrap.sql").read_text(
        encoding="utf-8"
    ).lower()
    assert "supabase-test-bootstrap.sql" in harness
    assert 'glob("*.sql")' in harness
    assert "auth.uid()" in bootstrap
    assert "create role authenticated" in bootstrap
    assert "create table if not exists auth.users" in bootstrap


def test_ci_and_release_gate_on_real_postgres_suite() -> None:
    for name in ("ci.yml", "release.yml"):
        workflow = (ROOT / ".github" / "workflows" / name).read_text(
            encoding="utf-8"
        )
        assert "image: postgres:17.6-bookworm" in workflow
        assert (
            "uv run --project backend --locked python scripts/test-supabase-local.py"
            in workflow
        )
        assert "needs: [verify, e2e, supabase]" in workflow
        assert "REFORA_SUPABASE_TEST_SSL: 'false'" in workflow
