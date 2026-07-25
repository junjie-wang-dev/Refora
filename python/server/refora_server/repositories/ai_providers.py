import json
import sqlite3
import time
import uuid
from typing import Any

from refora_server.repositories.errors import RepoError
from refora_server.providers.catalog import (
    getProviderPreset,
    providerRequiresApiKey,
)


_API_PROTOCOLS: tuple[str, ...] = ("openai-responses", "openai-compatible")
_REASONING_CONTROLS: tuple[str, ...] = ("openai", "thinking", "enable-thinking", "none")
_REASONING_EFFORTS: tuple[str, ...] = (
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
_VARIANT_FORMATS: tuple[str, ...] = ("dash", "colon", "none")
_VARIANT_PATTERN_SUFFIXES = ("high", "xhigh", "max", "fast", "thinking")

_INSERT_COLUMNS: tuple[str, ...] = (
    "id",
    "presetId",
    "name",
    "baseUrl",
    "apiProtocol",
    "reasoningControl",
    "reasoningEffort",
    "model",
    "modelsJson",
    "baseModel",
    "variant",
    "variantFormat",
    "apiKeyEnc",
    "temperature",
    "maxTokens",
    "createdAt",
)

_UPDATE_FIELDS: tuple[str, ...] = (
    "presetId",
    "name",
    "baseUrl",
    "apiProtocol",
    "reasoningControl",
    "reasoningEffort",
    "model",
    "baseModel",
    "variant",
    "variantFormat",
    "temperature",
    "maxTokens",
)


def now_ms() -> int:
    return int(time.time() * 1000)


def newId() -> str:
    return str(uuid.uuid4())


def _as_format(v: Any) -> str:
    if v in _VARIANT_FORMATS:
        return v
    return "dash"


def _parse_model_id(full_model: str) -> tuple[str, str]:
    trimmed = full_model.strip()
    if not trimmed:
        return ("", "")
    lower = trimmed.lower()
    for suffix in _VARIANT_PATTERN_SUFFIXES:
        for sep in ("-", ":"):
            token = sep + suffix
            idx = lower.rfind(token)
            if idx != -1 and idx + len(token) == len(lower):
                return (trimmed[:idx], suffix)
    return (trimmed, "")


def _compose_model_id(base_model: str, variant: str, fmt: str = "dash") -> str:
    base = base_model.strip()
    v = variant.strip()
    if not base:
        return ""
    if not v or fmt == "none":
        return base
    if fmt == "colon":
        return f"{base}:{v}"
    return f"{base}-{v}"


def _parse_models(value: Any) -> list[str] | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, list):
        return None
    models: list[str] = []
    seen: set[str] = set()
    for model in parsed:
        if not isinstance(model, str):
            continue
        m = model.strip()
        if len(m) > 0 and m not in seen:
            seen.add(m)
            models.append(m)
    return models if models else None


def _serialize_models(models: list[str] | None) -> str | None:
    if models and len(models) > 0:
        return json.dumps(models)
    return None


def _normalize_api_protocol(v: Any) -> str:
    return v if v in _API_PROTOCOLS else "openai-compatible"


def _normalize_reasoning_control(v: Any) -> str:
    return v if v in _REASONING_CONTROLS else "openai"


def _normalize_reasoning_effort(v: Any) -> str:
    return v if v in _REASONING_EFFORTS else "medium"


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return default


def _map_provider(row: Any) -> dict[str, Any]:
    model = _row_get(row, "model", "") or ""
    base_model = _row_get(row, "baseModel") or ""
    variant = _row_get(row, "variant")
    variant_format = _row_get(row, "variantFormat")
    parsed_base, parsed_variant = _parse_model_id(model)
    base = base_model or parsed_base or model
    v = variant if variant is not None else parsed_variant
    if v is None:
        v = ""
    fmt = _as_format(variant_format)
    preset_id = _row_get(row, "presetId") or "custom"
    api_key_enc = _row_get(row, "apiKeyEnc")
    return {
        "id": _row_get(row, "id"),
        "presetId": preset_id,
        "name": _row_get(row, "name"),
        "baseUrl": _row_get(row, "baseUrl"),
        "apiProtocol": _normalize_api_protocol(_row_get(row, "apiProtocol")),
        "reasoningControl": _normalize_reasoning_control(
            _row_get(row, "reasoningControl")
        ),
        "reasoningEffort": _normalize_reasoning_effort(
            _row_get(row, "reasoningEffort")
        ),
        "model": model or _compose_model_id(base, v, fmt),
        "models": _parse_models(_row_get(row, "modelsJson")),
        "baseModel": base,
        "variant": v,
        "variantFormat": fmt,
        "temperature": _row_get(row, "temperature"),
        "maxTokens": _row_get(row, "maxTokens"),
        "hasKey": api_key_enc is not None,
        "createdAt": _row_get(row, "createdAt"),
    }


def _map_raw(row: Any) -> dict[str, Any]:
    mapped = _map_provider(row)
    mapped["apiKeyEnc"] = _row_get(row, "apiKeyEnc")
    del mapped["hasKey"]
    return mapped


def createAiProvidersRepository(db: Any):
    def _fetch(id: str) -> Any | None:
        cur = db.execute("SELECT * FROM ai_providers WHERE id = ?", [id])
        return cur.fetchone()

    def list_() -> list[dict[str, Any]]:
        cur = db.execute("SELECT * FROM ai_providers ORDER BY createdAt")
        rows = cur.fetchall()
        return [_map_provider(r) for r in rows]

    def get(id: str) -> dict[str, Any] | None:
        row = _fetch(id)
        if row is None:
            return None
        return _map_provider(row)

    def getRaw(id: str) -> dict[str, Any] | None:
        row = _fetch(id)
        if row is None:
            return None
        return _map_raw(row)

    def create(input: dict[str, Any]) -> dict[str, Any]:
        id = newId()
        now = now_ms()
        preset_id = input.get("presetId") or "custom"
        model = input.get("model") or ""
        base_model = input.get("baseModel")
        variant = input.get("variant")
        variant_format = _as_format(input.get("variantFormat"))
        parsed_base, parsed_variant = _parse_model_id(model)
        base = base_model or parsed_base or model
        v = variant if variant is not None else parsed_variant
        if v is None:
            v = ""
        resolved_model = model or _compose_model_id(base, v, variant_format)
        values: list[Any] = [
            id,
            preset_id,
            input.get("name"),
            input.get("baseUrl"),
            _normalize_api_protocol(
                input.get("apiProtocol")
                if input.get("apiProtocol") is not None
                else getProviderPreset(preset_id)["apiProtocol"]
            ),
            _normalize_reasoning_control(
                input.get("reasoningControl")
                if input.get("reasoningControl") is not None
                else getProviderPreset(preset_id)["reasoningControl"]
            ),
            _normalize_reasoning_effort(
                input.get("reasoningEffort")
                if input.get("reasoningEffort") is not None
                else getProviderPreset(preset_id)["defaultReasoningEffort"]
            ),
            resolved_model,
            _serialize_models(input.get("models")),
            base,
            v,
            variant_format,
            input.get("apiKeyEnc"),
            input.get("temperature"),
            input.get("maxTokens"),
            now,
        ]
        placeholders = ", ".join("?" for _ in _INSERT_COLUMNS)
        col_list = ", ".join(_INSERT_COLUMNS)
        db.execute(
            f"INSERT INTO ai_providers ({col_list}) VALUES ({placeholders})", values
        )
        row = _fetch(id)
        assert row is not None
        return _map_provider(row)

    def update(id: str, patch: dict[str, Any]) -> dict[str, Any]:
        sets: list[str] = []
        params: list[Any] = []
        if "presetId" in patch and patch["presetId"] is not None:
            sets.append("presetId = ?")
            params.append(patch["presetId"])
        if "name" in patch and patch["name"] is not None:
            sets.append("name = ?")
            params.append(patch["name"])
        if "baseUrl" in patch and patch["baseUrl"] is not None:
            sets.append("baseUrl = ?")
            params.append(patch["baseUrl"])
        if "apiProtocol" in patch and patch["apiProtocol"] is not None:
            sets.append("apiProtocol = ?")
            params.append(_normalize_api_protocol(patch["apiProtocol"]))
        if "reasoningControl" in patch and patch["reasoningControl"] is not None:
            sets.append("reasoningControl = ?")
            params.append(_normalize_reasoning_control(patch["reasoningControl"]))
        if "reasoningEffort" in patch and patch["reasoningEffort"] is not None:
            sets.append("reasoningEffort = ?")
            params.append(_normalize_reasoning_effort(patch["reasoningEffort"]))
        if "model" in patch and patch["model"] is not None:
            sets.append("model = ?")
            params.append(patch["model"])
        if "models" in patch:
            sets.append("modelsJson = ?")
            params.append(_serialize_models(patch["models"]))
        if "baseModel" in patch and patch["baseModel"] is not None:
            sets.append("baseModel = ?")
            params.append(patch["baseModel"])
        if "variant" in patch and patch["variant"] is not None:
            sets.append("variant = ?")
            params.append(patch["variant"])
        if "variantFormat" in patch and patch["variantFormat"] is not None:
            sets.append("variantFormat = ?")
            params.append(_as_format(patch["variantFormat"]))
        if "apiKeyEnc" in patch:
            sets.append("apiKeyEnc = ?")
            params.append(patch["apiKeyEnc"])
        if "temperature" in patch:
            sets.append("temperature = ?")
            params.append(patch["temperature"])
        if "maxTokens" in patch:
            sets.append("maxTokens = ?")
            params.append(patch["maxTokens"])
        if len(sets) == 0:
            row = _fetch(id)
            if row is None:
                raise RepoError("not_found", f"provider not found: {id}")
            return _map_provider(row)
        params.append(id)
        cur = db.execute(
            f"UPDATE ai_providers SET {', '.join(sets)} WHERE id = ?", params
        )
        if cur.rowcount == 0:
            raise RepoError("not_found", f"provider not found: {id}")
        row = _fetch(id)
        assert row is not None
        return _map_provider(row)

    def remove(id: str) -> None:
        cur = db.execute("DELETE FROM ai_providers WHERE id = ?", [id])
        if cur.rowcount == 0:
            raise RepoError("not_found", f"provider not found: {id}")

    return {
        "list": list_,
        "get": get,
        "getRaw": getRaw,
        "create": create,
        "update": update,
        "delete": remove,
    }
