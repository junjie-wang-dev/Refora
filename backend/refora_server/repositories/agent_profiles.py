from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError


_KINDS = frozenset({"api", "cli"})
_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
_SEARCH_POLICIES = frozenset({"auto", "native", "refora", "disabled"})


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _map_profile(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "apiProviderId": row["apiProviderId"],
        "cliRuntimeId": row["cliRuntimeId"],
        "executablePath": row["executablePath"],
        "model": row["model"],
        "reasoningEffort": row["reasoningEffort"],
        "nativeWebSearch": bool(row["nativeWebSearch"]),
        "webSearchPolicy": row["webSearchPolicy"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    }


def createAgentProfilesRepository(db: Any):
    def _fetch(profile_id: str) -> sqlite3.Row | None:
        return db.execute(
            "SELECT * FROM agent_profiles WHERE id = ?", [profile_id]
        ).fetchone()

    def list_() -> list[dict[str, Any]]:
        rows = db.execute(
            "SELECT * FROM agent_profiles ORDER BY createdAt, id"
        ).fetchall()
        return [_map_profile(row) for row in rows]

    def get(profile_id: str) -> dict[str, Any] | None:
        row = _fetch(profile_id)
        return _map_profile(row) if row is not None else None

    def getByApiProvider(provider_id: str) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM agent_profiles WHERE apiProviderId = ?", [provider_id]
        ).fetchone()
        return _map_profile(row) if row is not None else None

    def create(input: dict[str, Any]) -> dict[str, Any]:
        kind = input.get("kind")
        if kind not in _KINDS:
            raise RepoError("invalid_input", "Agent profile kind must be api or cli")
        name = _optional_text(input.get("name"))
        if name is None:
            raise RepoError("invalid_input", "Agent profile name is required")
        api_provider_id = _optional_text(input.get("apiProviderId"))
        runtime_id = _optional_text(input.get("cliRuntimeId"))
        if kind == "api" and api_provider_id is None:
            raise RepoError("invalid_input", "API agent profile requires apiProviderId")
        if kind == "cli" and runtime_id is None:
            raise RepoError("invalid_input", "CLI agent profile requires cliRuntimeId")
        effort = input.get("reasoningEffort")
        policy = input.get("webSearchPolicy")
        now = _now_ms()
        profile_id = input.get("id") or _new_id()
        try:
            db.execute(
                "INSERT INTO agent_profiles "
                "(id, name, kind, apiProviderId, cliRuntimeId, executablePath, model, reasoningEffort, "
                "nativeWebSearch, webSearchPolicy, createdAt, updatedAt) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    profile_id,
                    name,
                    kind,
                    api_provider_id if kind == "api" else None,
                    runtime_id if kind == "cli" else None,
                    _optional_text(input.get("executablePath")) if kind == "cli" else None,
                    str(input.get("model") or "").strip(),
                    effort if effort in _EFFORTS else "medium",
                    1 if input.get("nativeWebSearch") is True else 0,
                    policy if policy in _SEARCH_POLICIES else "auto",
                    now,
                    now,
                ],
            )
        except sqlite3.IntegrityError as error:
            raise RepoError("conflict", "Agent profile already exists or is invalid") from error
        row = _fetch(profile_id)
        assert row is not None
        return _map_profile(row)

    def update(profile_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = get(profile_id)
        if current is None:
            raise RepoError("not_found", f"agent profile not found: {profile_id}")
        allowed = {
            "name",
            "executablePath",
            "model",
            "reasoningEffort",
            "nativeWebSearch",
            "webSearchPolicy",
        }
        next_value = {**current, **{key: value for key, value in patch.items() if key in allowed}}
        name = _optional_text(next_value.get("name"))
        if name is None:
            raise RepoError("invalid_input", "Agent profile name is required")
        effort = next_value.get("reasoningEffort")
        policy = next_value.get("webSearchPolicy")
        if effort not in _EFFORTS or policy not in _SEARCH_POLICIES:
            raise RepoError("invalid_input", "Agent profile settings are invalid")
        db.execute(
            "UPDATE agent_profiles SET name = ?, executablePath = ?, model = ?, reasoningEffort = ?, "
            "nativeWebSearch = ?, webSearchPolicy = ?, updatedAt = ? WHERE id = ?",
            [
                name,
                _optional_text(next_value.get("executablePath")) if current["kind"] == "cli" else None,
                str(next_value.get("model") or "").strip(),
                effort,
                1 if next_value.get("nativeWebSearch") is True else 0,
                policy,
                _now_ms(),
                profile_id,
            ],
        )
        row = _fetch(profile_id)
        assert row is not None
        return _map_profile(row)

    def remove(profile_id: str) -> None:
        cur = db.execute("DELETE FROM agent_profiles WHERE id = ?", [profile_id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"agent profile not found: {profile_id}")

    return {
        "list": list_,
        "get": get,
        "getByApiProvider": getByApiProvider,
        "create": create,
        "update": update,
        "delete": remove,
    }


def createAgentRuntimeSessionsRepository(db: Any):
    def get(thread_id: str, profile_id: str, runtime_id: str) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM agent_runtime_sessions WHERE threadId = ? AND agentProfileId = ? AND runtimeId = ?",
            [thread_id, profile_id, runtime_id],
        ).fetchone()
        if row is None:
            return None
        return {
            "threadId": row["threadId"],
            "agentProfileId": row["agentProfileId"],
            "runtimeId": row["runtimeId"],
            "sessionId": row["sessionId"],
            "createdAt": row["createdAt"],
            "updatedAt": row["updatedAt"],
        }

    def put(thread_id: str, profile_id: str, runtime_id: str, session_id: str) -> dict[str, Any]:
        now = _now_ms()
        db.execute(
            "INSERT INTO agent_runtime_sessions "
            "(threadId, agentProfileId, runtimeId, sessionId, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(threadId, agentProfileId, runtimeId) DO UPDATE SET sessionId = excluded.sessionId, updatedAt = excluded.updatedAt",
            [thread_id, profile_id, runtime_id, session_id, now, now],
        )
        result = get(thread_id, profile_id, runtime_id)
        assert result is not None
        return result

    def remove(thread_id: str, profile_id: str, runtime_id: str) -> None:
        db.execute(
            "DELETE FROM agent_runtime_sessions WHERE threadId = ? AND agentProfileId = ? AND runtimeId = ?",
            [thread_id, profile_id, runtime_id],
        )

    return {"get": get, "put": put, "delete": remove}
