from __future__ import annotations

import hmac
import os
import secrets

from typing import Any

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


def _make_app(
    token: str | None = None,
    db_path: str | None = None,
    library_folder: str = "",
    db: Any | None = None,
) -> FastAPI:
    lifespan = None
    if db_path is not None:
        from refora_server.server.lifespan import create_lifespan

        lifespan = create_lifespan(db_path, library_folder, db)
    app = FastAPI(
        title="Refora Server",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
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

    @app.post("/shutdown")
    async def shutdown(_: None = Depends(require_token)) -> JSONResponse:
        request_shutdown = getattr(app.state, "request_shutdown", None)
        if callable(request_shutdown):
            request_shutdown()
        return JSONResponse({"ok": True, "data": {"ack": True}})

    return app


def configure_app(app: FastAPI) -> None:
    if getattr(app.state, "routes_configured", False):
        return
    repos = app.state.repos
    services = app.state.services
    connector = app.state.connector
    require_token = app.state.require_token
    from refora_server.server.routes import (
        create_ai_router,
        create_library_router,
        create_workspaces_router,
    )
    from refora_server.server.websocket import create_websocket_handler

    library_deps = {
        "require_token": require_token,
        "documents": repos["documents"],
        "categories": repos["categories"],
        "importer": services["importer"],
        "watcher": services["watcher"],
        "library": services["library"],
        "settings": repos["settings"],
        "services": services,
        "repos": repos,
        "web_search": services["webSearch"],
        "web_search_config": repos["webSearchConfig"],
        "ai_providers": services["aiProviders"],
        "ai_providers_repo": repos["aiProviders"],
        "exporter": services["export"],
        "connector": connector,
        "metadata": {},
    }
    workspace_deps = {
        "require_token": require_token,
        "workspaces": services["workspaces"],
        "mineru": services["mineru"],
        "ocr": services["ocr"],
        "connector": connector,
    }
    ai_deps = {
        "require_token": require_token,
        "repos": repos,
        "services": services,
        "agentRuntime": app.state.agent_runtime,
    }
    app.include_router(create_library_router(library_deps))
    app.include_router(create_workspaces_router(workspace_deps))
    app.include_router(create_ai_router(ai_deps))
    token = getattr(app.state.token_verifier, "_token", None)
    app.add_api_websocket_route(
        "/ws",
        create_websocket_handler(app.state.event_bus, connector, token),
    )
    app.state.routes_configured = True


def create_app(
    db_path: str | None = None,
    library_folder: str = "",
    db: Any | None = None,
) -> FastAPI:
    token = os.environ.get("REFORA_SERVER_TOKEN")
    return _make_app(token, db_path, library_folder, db)


def create_app_with_token(
    token: str | None,
    db_path: str | None = None,
    library_folder: str = "",
    db: Any | None = None,
) -> FastAPI:
    return _make_app(token, db_path, library_folder, db)


def generate_token() -> str:
    return secrets.token_urlsafe(32)
