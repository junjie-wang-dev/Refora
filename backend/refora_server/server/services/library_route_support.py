from __future__ import annotations

import base64
import inspect
import json
import math
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fastapi.responses import JSONResponse

from refora_server.services.proxy import normalize_proxy_rules


class UnavailableError(RuntimeError):
    code = "unavailable"


LIST_COLUMN_IDS = ("title", "authors", "year", "venue", "addedAt", "filePath")


def value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def dependency(deps: Any, *names: str) -> Any:
    for name in names:
        candidate = value(deps, name)
        if candidate is not None:
            return candidate
    for group in ("repos", "repositories", "services"):
        nested = value(deps, group)
        if nested is not None:
            for name in names:
                candidate = value(nested, name)
                if candidate is not None:
                    return candidate
    return None


def method(source: Any, name: str) -> Any:
    candidate = value(source, name)
    if not callable(candidate):
        raise UnavailableError(f"Dependency does not provide {name}")
    return candidate


def markdown_file_name(title: str) -> str:
    normalized = re.sub(r"\.md$", "", title.strip(), flags=re.IGNORECASE)
    normalized = re.sub(r'[<>:"/\\|?*]', "-", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip().rstrip(". ")[:120]
    return f"{normalized or 'card'}.md"


async def call(source: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    result = method(source, name)(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def success(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": True, "data": data})


def error_response(exc: Exception) -> JSONResponse:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", "") or str(exc) or "Internal server error"
    if code in {"not_found", "file_missing"}:
        return JSONResponse(status_code=404, content={"ok": False, "error": {"code": "not_found", "message": message}})
    if code in {"duplicate", "conflict", "state_error"}:
        return JSONResponse(status_code=409, content={"ok": False, "error": {"code": "conflict", "message": message}})
    if code in {"unavailable", "dependency_unavailable", "connector_timeout"}:
        return JSONResponse(status_code=503, content={"ok": False, "error": {"code": "unavailable", "message": message}})
    if code == "identifier_network_error":
        return JSONResponse(status_code=503, content={"ok": False, "error": {"code": code, "message": message}})
    if isinstance(exc, (ValueError, TypeError)) or code:
        return JSONResponse(status_code=400, content={"ok": False, "error": {"code": code or "validation", "message": message}})
    print(f"ERROR library route: {type(exc).__name__}: {exc}", flush=True)
    return JSONResponse(status_code=500, content={"ok": False, "error": {"code": "internal", "message": "Internal server error"}})


def body_dict(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("Request body must be an object")
    return body


def string(body: dict[str, Any], name: str, *, required: bool = True) -> str:
    candidate = body.get(name)
    if not isinstance(candidate, str) or (required and not candidate.strip()):
        raise ValueError(f"{name} must be a non-empty string")
    return candidate.strip()


def ids(body: dict[str, Any], name: str = "ids") -> list[str]:
    candidate = body.get(name)
    if not isinstance(candidate, list) or not candidate or any(not isinstance(item, str) or not item for item in candidate):
        raise ValueError(f"{name} must be a non-empty list of strings")
    return candidate


def absolute_directory(candidate: str) -> str:
    if not candidate or not os.path.isabs(candidate):
        raise ValueError("path must be an absolute directory path")
    resolved = os.path.abspath(candidate)
    if not os.path.isdir(resolved):
        raise ValueError("path must be an existing directory")
    return resolved


def provider_input(body: dict[str, Any]) -> dict[str, Any]:
    return {key: candidate for key, candidate in body.items() if key not in {"apiKey", "apiKeyEnc"}}


async def connector_call(connector: Any, operation: str, *args: Any) -> Any:
    names = {
        "trash": ("trashItem", "trash_item"),
        "open": ("openPath", "open_path"),
        "reveal": ("showInFolder", "show_in_folder"),
        "clipboard": ("clipboardWrite", "clipboard_write", "writeText", "write_text"),
        "clipboard_file": ("clipboardWriteFile", "clipboard_write_file"),
        "dialog_directory": ("dialogOpenDirectory", "dialog_open_directory"),
        "dialog_file": ("dialogOpenFile", "dialog_open_file"),
        "dialog_choose": ("dialogChoose", "dialog_choose"),
        "encrypt_api_key": ("encryptApiKey", "encrypt_api_key"),
        "decrypt_api_key": ("decryptApiKey", "decrypt_api_key"),
    }[operation]
    for name in names:
        if callable(value(connector, name)):
            result = await call(connector, name, *args)
            if isinstance(result, Mapping) and "ok" in result:
                if result.get("ok") is True:
                    return result.get("data")
                error = result.get("error")
                code = error.get("code") if isinstance(error, Mapping) else "connector_error"
                message = error.get("message") if isinstance(error, Mapping) else "Native connector failed"
                failure = RuntimeError(str(message))
                failure.code = str(code)
                raise failure
            return result
    raise UnavailableError(f"Connector does not provide {names[0]}")


def json_setting(settings: Any, key: str, default: Any) -> Any:
    return method(settings, "get")(key, default)


def absolute_regular_file(candidate: str, extensions: set[str], max_bytes: int) -> str:
    if not candidate or not os.path.isabs(candidate):
        raise ValueError("path must be absolute")
    path = Path(candidate)
    if path.suffix.lower() not in extensions:
        raise ValueError(f"path must have one of these extensions: {', '.join(sorted(extensions))}")
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError("path must be an existing regular file")
        if path.stat().st_size > max_bytes:
            raise ValueError(f"file exceeds the {max_bytes // (1024 * 1024)} MB limit")
        return str(path.resolve(strict=True))
    except OSError as exc:
        raise ValueError("path must be an existing regular file") from exc


def base64_blob(candidate: Any) -> bytes | None:
    if candidate is None:
        return None
    if not isinstance(candidate, str):
        raise UnavailableError("Native encryption returned an invalid payload")
    try:
        return base64.b64decode(candidate, validate=True)
    except ValueError as exc:
        raise UnavailableError("Native encryption returned invalid base64") from exc


def bounded_number(candidate: Any, minimum: float, maximum: float) -> int | None:
    if (
        isinstance(candidate, bool)
        or not isinstance(candidate, (int, float))
        or not math.isfinite(candidate)
        or candidate < minimum
        or candidate > maximum
    ):
        return None
    return math.floor(candidate + 0.5)


def window_bounds(candidate: Any) -> dict[str, Any] | None:
    if not isinstance(candidate, Mapping):
        return None
    x = bounded_number(candidate.get("x"), -100_000, 100_000)
    y = bounded_number(candidate.get("y"), -100_000, 100_000)
    width = bounded_number(candidate.get("width"), 800, 10_000)
    height = bounded_number(candidate.get("height"), 500, 10_000)
    if None in {x, y, width, height}:
        return None
    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "isMaximized": candidate.get("isMaximized") is True,
    }


def list_column_state(candidate: Any) -> dict[str, Any] | None:
    if not isinstance(candidate, Mapping):
        return None
    columns = candidate.get("columns")
    sort = candidate.get("sort")
    if (
        not isinstance(columns, list)
        or len(columns) != len(LIST_COLUMN_IDS)
        or not isinstance(sort, Mapping)
        or sort.get("field") not in LIST_COLUMN_IDS
        or sort.get("dir") not in {"asc", "desc"}
    ):
        return None
    normalized = []
    for column in columns:
        if not isinstance(column, Mapping) or column.get("id") not in LIST_COLUMN_IDS:
            return None
        width = bounded_number(column.get("width"), 40, 2_000)
        order = bounded_number(column.get("order"), 0, len(LIST_COLUMN_IDS) - 1)
        if width is None or order is None or not isinstance(column.get("visible"), bool):
            return None
        normalized.append({
            "id": column["id"],
            "visible": column["visible"],
            "width": width,
            "order": order,
        })
    if (
        {column["id"] for column in normalized} != set(LIST_COLUMN_IDS)
        or {column["order"] for column in normalized} != set(range(len(LIST_COLUMN_IDS)))
    ):
        return None
    return {
        "columns": normalized,
        "sort": {"field": sort["field"], "dir": sort["dir"]},
    }


async def apply_proxy_rules(connector: Any, rules: str) -> None:
    normalized = normalize_proxy_rules(rules)
    apply = value(connector, "applyProxy") or value(connector, "apply_proxy")
    if not callable(apply):
        raise UnavailableError("Connector does not provide applyProxy")
    result = apply(normalized)
    if inspect.isawaitable(result):
        result = await result
    if isinstance(result, Mapping) and result.get("ok") is False:
        error = result.get("error") or {}
        code = error.get("code") if isinstance(error, Mapping) else "connector_error"
        message = error.get("message") if isinstance(error, Mapping) else "Native proxy connector failed"
        failure = RuntimeError(str(message))
        failure.code = str(code)
        raise failure
