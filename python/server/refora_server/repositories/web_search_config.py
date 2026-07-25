from __future__ import annotations

import time
from typing import Any

from refora_server.db.errors import RepoError
from refora_server.web.types import WEB_SEARCH_PROVIDERS, is_valid_provider

_PROVIDER_COLUMNS = ("provider", "tavilyApiKeyEnc", "braveApiKeyEnc", "updatedAt")


def _to_bytes(value: Any) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        return bytes(value)
    raise RepoError(
        "invalid_data", "Stored web search API key has an invalid format"
    )


def _map_row(row: Any) -> dict[str, Any]:
    return {
        "provider": row["provider"],
        "tavilyApiKeyEnc": _to_bytes(row["tavilyApiKeyEnc"]),
        "braveApiKeyEnc": _to_bytes(row["braveApiKeyEnc"]),
        "updatedAt": row["updatedAt"],
    }


def createWebSearchConfigRepository(db: Any):
    def get() -> dict[str, Any]:
        row = db.execute(
            "SELECT provider, tavilyApiKeyEnc, braveApiKeyEnc, updatedAt "
            "FROM web_search_config WHERE id = 1"
        ).fetchone()
        if row is None:
            raise RepoError("not_found", "Web search configuration is missing")
        return _map_row(row)

    def update(patch: dict[str, Any]) -> dict[str, Any]:
        sets: list[str] = []
        params: list[Any] = []

        provider = patch.get("provider")
        if provider is not None:
            if not is_valid_provider(provider):
                raise RepoError("invalid_input", f"Unknown web search provider: {provider}")
            sets.append("provider = ?")
            params.append(provider)

        if "tavilyApiKeyEnc" in patch:
            value = patch["tavilyApiKeyEnc"]
            if value is not None and not isinstance(value, (bytes, bytearray, memoryview)):
                raise RepoError(
                    "invalid_input", "tavilyApiKeyEnc must be bytes or null"
                )
            sets.append("tavilyApiKeyEnc = ?")
            params.append(bytes(value) if value is not None else None)

        if "braveApiKeyEnc" in patch:
            value = patch["braveApiKeyEnc"]
            if value is not None and not isinstance(value, (bytes, bytearray, memoryview)):
                raise RepoError(
                    "invalid_input", "braveApiKeyEnc must be bytes or null"
                )
            sets.append("braveApiKeyEnc = ?")
            params.append(bytes(value) if value is not None else None)

        if not sets:
            return get()

        sets.append("updatedAt = ?")
        params.append(int(time.time() * 1000))
        params.append(1)
        db.execute(
            "UPDATE web_search_config SET " + ", ".join(sets) + " WHERE id = ?",
            params,
        )
        return get()

    return {"get": get, "update": update}