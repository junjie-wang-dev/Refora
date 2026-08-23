from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse


_NOT_FOUND_CODES = {"not_found", "file_missing"}
_CONFLICT_CODES = {
    "busy",
    "conflict",
    "duplicate",
    "invalid_order",
    "stale",
    "state_error",
}
_UNAVAILABLE_CODES = {
    "connector_timeout",
    "dependency_unavailable",
    "engine_unavailable",
    "not_ready",
    "unavailable",
}
_VALIDATION_CODES = {"bad_request", "validation"}


def success(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": True, "data": data})


def failure(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error": {"code": code, "message": message}},
    )


def error_response(error: Exception) -> JSONResponse:
    if isinstance(error, HTTPException):
        detail = error.detail if isinstance(error.detail, dict) else {}
        code = detail.get("code") if isinstance(detail.get("code"), str) else "unauthorized"
        message = detail.get("message") if isinstance(detail.get("message"), str) else str(error.detail)
        return failure(error.status_code, code, message)

    code = getattr(error, "code", "")
    message = getattr(error, "message", "") or str(error) or "Internal server error"
    if not isinstance(code, str):
        code = ""
    if code in _NOT_FOUND_CODES:
        return failure(404, "not_found", message)
    if code in _CONFLICT_CODES:
        return failure(409, "conflict", message)
    if code in _UNAVAILABLE_CODES:
        return failure(503, "unavailable", message)
    if code == "identifier_network_error":
        return failure(503, code, message)
    if code == "internal":
        return failure(500, "internal", "Internal server error")
    if isinstance(error, PermissionError):
        return failure(403, "forbidden", message)
    if isinstance(error, sqlite3.DatabaseError):
        if "malformed" in message.lower() or "not a database" in message.lower():
            return failure(
                500,
                "database_corrupt",
                "Refora's local database is damaged. Quit Refora and restore or repair the library database.",
            )
        return failure(500, "database_error", "Refora could not read or update the local database.")
    if (
        code in _VALIDATION_CODES
        or (isinstance(error, (TypeError, ValueError)) and not code)
    ):
        return failure(400, "validation", message)
    if code:
        if code.startswith("invalid_") or code in {
            "forbidden_field",
            "inside_library",
            "contains_library",
            "proxy_failed",
        }:
            return failure(400, code, message)
        return failure(400, code, message)
    if isinstance(error, RuntimeError):
        normalized = message.lower()
        if "database" in normalized:
            return failure(500, "internal", "Internal server error")
        if any(word in normalized for word in ("unavailable", "not installed", "runtime")):
            return failure(503, "unavailable", message)
        if any(word in normalized for word in ("already", "while", "before uninstall", "active")):
            return failure(409, "conflict", message)
        return failure(500, "internal", "Internal server error")
    return failure(500, "internal", "Internal server error")
