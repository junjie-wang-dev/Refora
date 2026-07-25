from __future__ import annotations

import hmac
import os
import secrets

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

_ALLOWED_LOOPBACK_ORIGINS = {
    "http://127.0.0.1",
    "http://localhost",
    "http://127.0.0.1:0",
}


def _loopback_origins() -> list[str]:
    env_origins = os.environ.get("REFORA_CORS_ORIGINS", "")
    origins = [o.strip() for o in env_origins.split(",") if o.strip()]
    if origins:
        return origins
    return [
        "http://127.0.0.1",
        "http://localhost",
        "http://127.0.0.1:0",
        "http://localhost:0",
    ]


class TokenVerifier:
    def __init__(self, token: str | None) -> None:
        self._token = token

    def verify(self, request: Request) -> bool:
        if not self._token:
            return True
        supplied = request.headers.get("X-Refora-Token", "")
        if not supplied:
            return False
        return hmac.compare_digest(supplied, self._token)


def _make_app(token: str | None = None) -> FastAPI:
    app = FastAPI(title="Refora Server", version="0.1.0", docs_url=None, redoc_url=None)
    verifier = TokenVerifier(token)
    app.state.token_verifier = verifier

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_loopback_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Refora-Token"],
    )

    async def require_token(request: Request) -> None:
        if not verifier.verify(request):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "unauthorized", "message": "Invalid or missing token"},
            )

    app.state.require_token = require_token

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "data": {"status": "ok"}})

    @app.get("/ready")
    async def ready(request: Request, _: None = Depends(require_token)) -> JSONResponse:
        return JSONResponse({"ok": True, "data": {"status": "ready"}})

    return app


def create_app() -> FastAPI:
    token = os.environ.get("REFORA_SERVER_TOKEN")
    return _make_app(token)


def create_app_with_token(token: str | None) -> FastAPI:
    return _make_app(token)


def generate_token() -> str:
    return secrets.token_urlsafe(32)