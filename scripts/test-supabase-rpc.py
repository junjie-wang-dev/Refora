from __future__ import annotations

import os
import json
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi


USER_A = "10000000-0000-0000-0000-000000000001"
USER_B = "20000000-0000-0000-0000-000000000002"
LIBRARY_A = "10000000-0000-0000-0000-000000000010"
LIBRARY_B = "20000000-0000-0000-0000-000000000010"
DEVICE_A = "10000000-0000-0000-0000-000000000020"
APPLIED_OPERATION = "10000000-0000-0000-0000-000000000030"
CONFLICT_OPERATION = "10000000-0000-0000-0000-000000000031"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def become_postgres(cursor: Any) -> None:
    cursor.execute("reset role")
    cursor.execute("set role postgres")


def become_user(cursor: Any, user_id: str) -> None:
    become_postgres(cursor)
    cursor.execute("select set_config('request.jwt.claim.sub', %s, true)", (user_id,))
    cursor.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
    cursor.execute("set local role authenticated")


def ssl_context() -> bool:
    value = os.environ.get("REFORA_SUPABASE_TEST_SSL", "true").strip().lower()
    if value not in {"true", "false"}:
        raise RuntimeError("REFORA_SUPABASE_TEST_SSL must be true or false")
    return value == "true"


def expect_sqlstate(
    cursor: Any,
    sqlstate: str,
    query: str,
    params: tuple[Any, ...] = (),
) -> None:
    cursor.execute("savepoint expected_error")
    try:
        cursor.execute(query, params)
    except pg8000.dbapi.DatabaseError as error:
        cursor.execute("rollback to savepoint expected_error")
        cursor.execute("release savepoint expected_error")
        details = error.args[0] if error.args and isinstance(error.args[0], dict) else {}
        received = details.get("C")
        if received != sqlstate:
            raise AssertionError(
                f"Expected SQLSTATE {sqlstate}, received {received}: {error}"
            ) from error
        return
    cursor.execute("rollback to savepoint expected_error")
    cursor.execute("release savepoint expected_error")
    raise AssertionError(f"Expected SQLSTATE {sqlstate}")


def push(
    cursor: Any,
    operation_id: str,
    entity_id: str,
    base_version: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    cursor.execute(
        """
        select public.refora_sync_push(
          %s, %s, %s, 'category', %s, %s, false, %s::jsonb
        )
        """,
        (
            LIBRARY_A,
            DEVICE_A,
            operation_id,
            entity_id,
            base_version,
            json.dumps(payload),
        ),
    )
    result = cursor.fetchone()[0]
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict):
        raise AssertionError("Sync push did not return a JSON object")
    return result


def main() -> None:
    database_url = require_env("REFORA_SUPABASE_TEST_DB_URL")
    password = require_env("REFORA_SUPABASE_TEST_DB_PASSWORD")
    parsed_url = urlparse(database_url)
    connection = pg8000.dbapi.connect(
        user=unquote(parsed_url.username or ""),
        password=password,
        host=parsed_url.hostname,
        port=parsed_url.port or 5432,
        database=parsed_url.path.lstrip("/") or "postgres",
        timeout=15,
        ssl_context=ssl_context(),
    )
    checks = 0
    cursor = connection.cursor()
    try:
        if cursor is not None:
            cursor.execute("begin")
            become_postgres(cursor)
            cursor.execute(
                """
                insert into auth.users (
                  instance_id,
                  id,
                  aud,
                  role,
                  email,
                  encrypted_password,
                  email_confirmed_at,
                  raw_app_meta_data,
                  raw_user_meta_data,
                  created_at,
                  updated_at,
                  confirmation_token,
                  email_change,
                  email_change_token_new,
                  recovery_token
                ) values
                  (
                    '00000000-0000-0000-0000-000000000000',
                    %s,
                    'authenticated',
                    'authenticated',
                    'sync-a@example.invalid',
                    '',
                    now(),
                    '{}'::jsonb,
                    '{}'::jsonb,
                    now(),
                    now(),
                    '',
                    '',
                    '',
                    ''
                  ),
                  (
                    '00000000-0000-0000-0000-000000000000',
                    %s,
                    'authenticated',
                    'authenticated',
                    'sync-b@example.invalid',
                    '',
                    now(),
                    '{}'::jsonb,
                    '{}'::jsonb,
                    now(),
                    now(),
                    '',
                    '',
                    '',
                    ''
                  )
                """,
                (USER_A, USER_B),
            )

            become_user(cursor, USER_A)
            cursor.execute(
                "select public.refora_sync_register_library(%s, 'Library A')",
                (LIBRARY_A,),
            )
            checks += 1
            cursor.execute(
                "select public.refora_sync_register_device(%s, 'Device A')",
                (DEVICE_A,),
            )
            checks += 1
            cursor.execute("select count(*) from public.refora_sync_list_libraries()")
            assert cursor.fetchone()[0] == 1
            checks += 1

            applied = push(
                cursor,
                APPLIED_OPERATION,
                "category-a",
                0,
                {"name": "Reading", "sortOrder": 0},
            )
            assert applied["status"] == "applied"
            checks += 1

            conflict = push(
                cursor,
                CONFLICT_OPERATION,
                "category-a",
                0,
                {"name": "Stale", "sortOrder": 1},
            )
            assert conflict["status"] == "conflict"
            assert "payload" not in conflict
            checks += 1
            assert push(
                cursor,
                CONFLICT_OPERATION,
                "category-a",
                0,
                {"name": "Stale", "sortOrder": 1},
            ) == conflict
            checks += 1

            expect_sqlstate(
                cursor,
                "22023",
                """
                select public.refora_sync_push(
                  %s, %s, %s, 'category', 'different-category', 0, false, %s::jsonb
                )
                """,
                (
                    LIBRARY_A,
                    DEVICE_A,
                    CONFLICT_OPERATION,
                    json.dumps({"name": "Different", "sortOrder": 2}),
                ),
            )
            checks += 1
            expect_sqlstate(cursor, "42501", "select count(*) from refora_sync.entities")
            checks += 1
            become_postgres(cursor)
            cursor.execute("grant usage on schema refora_sync to authenticated")
            cursor.execute("grant select on refora_sync.libraries to authenticated")
            become_user(cursor, USER_A)
            cursor.execute("select count(*) from refora_sync.libraries")
            assert cursor.fetchone()[0] == 0
            checks += 1
            expect_sqlstate(
                cursor,
                "42501",
                """
                select public.refora_sync_push_v2_internal(
                  %s, %s, %s, 'category', 'private-call', 0, false, %s::jsonb
                )
                """,
                (
                    LIBRARY_A,
                    DEVICE_A,
                    "10000000-0000-0000-0000-000000000032",
                    json.dumps({"name": "Private", "sortOrder": 3}),
                ),
            )
            checks += 1

            become_postgres(cursor)
            cursor.execute(
                """
                select
                  octet_length(result::text) <= 4096,
                  not (result ? 'payload'),
                  expires_at <= created_at + interval '1 day'
                from refora_sync.operations
                where user_id = %s and operation_id = %s
                """,
                (USER_A, CONFLICT_OPERATION),
            )
            compact, payload_absent, short_lived = cursor.fetchone()
            assert compact and payload_absent and short_lived
            checks += 1

            become_user(cursor, USER_B)
            cursor.execute(
                "select public.refora_sync_register_library(%s, 'Library B')",
                (LIBRARY_B,),
            )
            checks += 1
            cursor.execute("select count(*) from public.refora_sync_list_libraries()")
            assert cursor.fetchone()[0] == 1
            checks += 1
            expect_sqlstate(
                cursor,
                "42501",
                "select * from public.refora_sync_pull(%s, 0, 100)",
                (LIBRARY_A,),
            )
            checks += 1
    finally:
        cursor.close()
        connection.rollback()
        connection.close()
    print(f"Supabase sync RPC integration checks passed: {checks}")


if __name__ == "__main__":
    main()
