from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from refora_server.db.errors import RepoError
from refora_server.services.agent_intent import (
    assemble_resume,
    assemble_turn,
    resolved_provider,
    selected_provider_id,
)
from refora_server.services.agent_memory import (
    ensure_memory_files,
    memory_scope,
    normalize_memory_path,
    update_memory as update_scoped_memory,
)


class RouteError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _value(container: Any, name: str, default: Any = None) -> Any:
    if isinstance(container, Mapping):
        return container.get(name, default)
    return getattr(container, name, default)


async def _resolve(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _success(data: Any) -> JSONResponse:
    return JSONResponse({"ok": True, "data": data})


def _failure(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": {"code": code, "message": message}},
        status_code=status_code,
    )


def _error_response(error: Exception) -> JSONResponse:
    if isinstance(error, RouteError):
        return _failure(error.code, str(error), error.status_code)
    if isinstance(error, HTTPException):
        detail = error.detail if isinstance(error.detail, dict) else {}
        code = detail.get("code") if isinstance(detail.get("code"), str) else "unauthorized"
        message = detail.get("message") if isinstance(detail.get("message"), str) else "Invalid or missing token"
        return _failure(code, message, error.status_code)
    if isinstance(error, RepoError) or isinstance(getattr(error, "code", None), str):
        code = getattr(error, "code", "internal")
        status_code = {
            "not_found": 404,
            "conflict": 409,
            "unavailable": 503,
        }.get(code, 400 if code in {"bad_request", "validation"} or code.startswith("invalid_") else 500)
        return _failure(code, str(error), status_code)
    if isinstance(error, ValueError):
        return _failure("validation", str(error), 400)
    return _failure("internal", "Internal server error", 500)


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RouteError("validation", f"{field} must be a non-empty string")
    return value


def _optional_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _required_string(value, field)


def _body_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RouteError("validation", "Request body must be an object")
    return value


async def _read_body(request: Request) -> dict[str, Any]:
    try:
        return _body_object(await request.json())
    except RouteError:
        raise
    except Exception as error:
        raise RouteError("bad_request", "Request body must be valid JSON") from error


def _thread_scope(repos: Any, thread_id: str) -> tuple[dict[str, Any], str, str, str | None]:
    chat = _value(repos, "chat")
    thread = _value(chat, "getThread")(thread_id)
    if thread is None:
        raise RouteError("not_found", f"thread not found: {thread_id}", 404)
    workspace_id = thread.get("workspaceId")
    if workspace_id is None:
        return thread, "global", "global", None
    return thread, "workspace", workspace_id, workspace_id


def create_ai_router(deps: Any) -> APIRouter:
    repos = _value(deps, "repos")
    services = _value(deps, "services", {})
    runtime = _value(deps, "agentRuntime")
    connector = _value(deps, "connector")
    summary_service = _value(services, "aiSummary", _value(deps, "aiSummaryService"))
    document_text_service = _value(services, "documentText", _value(deps, "documentTextService"))
    require_token = _value(deps, "require_token")
    router = APIRouter()

    async def authorize(request: Request) -> JSONResponse | None:
        dependency = require_token or _value(request.app.state, "require_token")
        if dependency is None:
            return None
        try:
            await _resolve(dependency(request))
        except Exception as error:
            return _error_response(error)
        return None

    async def execute(
        authorization: JSONResponse | None,
        action: Callable[[], Any] | Callable[[], Awaitable[Any]],
    ) -> JSONResponse:
        if authorization is not None:
            return authorization
        try:
            return _success(await _resolve(action()))
        except Exception as error:
            return _error_response(error)

    @router.get("/ai/doc-text/{document_id}")
    async def get_doc_text(
        document_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, str]:
            _required_string(document_id, "documentId")
            documents = _value(repos, "documents")
            if documents is not None and _value(documents, "get")(document_id) is None:
                raise RouteError("not_found", f"document not found: {document_id}", 404)
            if document_text_service is not None:
                text = await _resolve(_value(document_text_service, "getOrExtract")(document_id))
            else:
                cached = _value(_value(repos, "aiSummaries"), "getFullText")(document_id)
                if cached is None:
                    raise RouteError("not_found", f"document text not found: {document_id}", 404)
                text = cached.get("text")
            if not isinstance(text, str):
                raise RouteError("internal", "Document text service returned invalid text", 500)
            return {"text": text}

        return await execute(authorization, action)

    @router.post("/ai/summarize")
    async def summarize(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, str]:
            body = await _read_body(request)
            document_id = _required_string(body.get("documentId"), "documentId")
            if "provider" in body:
                raise RouteError("validation", "provider is assembled by the server")
            documents = _value(repos, "documents")
            if documents is not None and _value(documents, "get")(document_id) is None:
                raise RouteError("not_found", f"document not found: {document_id}", 404)
            if summary_service is None:
                raise RouteError("unavailable", "AI summary service is unavailable", 503)
            provider_id = selected_provider_id(repos)
            summary_provider = await resolved_provider(
                services,
                connector or _value(request.app.state, "connector"),
                provider_id,
            )
            if document_text_service is None:
                raise RouteError("unavailable", "Document text service is unavailable", 503)
            text = await _resolve(
                _value(document_text_service, "getOrExtract")(document_id)
            )
            summary_id = await _resolve(
                _value(summary_service, "summarize")(
                    document_id,
                    {**summary_provider, "__text": text},
                )
            )
            return {"summaryId": summary_id if isinstance(summary_id, str) else document_id}

        return await execute(authorization, action)

    @router.get("/ai/summary/{document_id}")
    async def get_summary(
        document_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        return await execute(
            authorization,
            lambda: _value(_value(repos, "aiSummaries"), "getSummary")(document_id),
        )

    @router.post("/ai/chat/send")
    async def send_chat(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, str]:
            body = await _read_body(request)
            allowed_fields = {
                "runId",
                "threadId",
                "workspaceId",
                "text",
                "providerId",
                "model",
                "replaceLastExchange",
                "replaceRunId",
                "features",
                "attachments",
            }
            unknown_fields = sorted(set(body) - allowed_fields)
            if unknown_fields:
                raise RouteError(
                    "validation",
                    f"Unsupported chat intent fields: {', '.join(unknown_fields)}",
                )
            for field in ("runId", "text", "providerId"):
                _required_string(body.get(field), field)
            for internal_field in (
                "provider",
                "checkpointPath",
                "checkpointBefore",
                "systemPrompt",
                "messages",
                "decisions",
                "enabledToolNames",
                "sandboxRoot",
                "memories",
                "includeResearchMemory",
                "recursionLimit",
            ):
                if internal_field in body:
                    raise RouteError(
                        "validation",
                        f"{internal_field} is assembled by the server",
                    )
            if body.get("threadId") is not None:
                _required_string(body.get("threadId"), "threadId")
            if body.get("workspaceId") is not None:
                _required_string(body.get("workspaceId"), "workspaceId")
            if body.get("model") is not None:
                _required_string(body.get("model"), "model")
            if "replaceLastExchange" in body and not isinstance(body["replaceLastExchange"], bool):
                raise RouteError("validation", "replaceLastExchange must be a boolean")
            if body.get("replaceRunId") is not None:
                _required_string(body.get("replaceRunId"), "replaceRunId")
            if "features" in body and not isinstance(body["features"], dict):
                raise RouteError("validation", "features must be an object")
            if "attachments" in body:
                attachments = body["attachments"]
                if not isinstance(attachments, list) or any(
                    not isinstance(item, dict)
                    or item.get("type") != "document"
                    or not isinstance(item.get("docId"), str)
                    or not item["docId"].strip()
                    for item in attachments
                ):
                    raise RouteError("validation", "attachments must contain document references")
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
            assembled = await assemble_turn(
                body,
                repos=repos,
                services=services,
                connector=connector or _value(request.app.state, "connector"),
                db_path=_value(request.app.state, "db_path", ""),
                library_folder=_value(request.app.state, "library_folder", ""),
            )
            starter = _value(runtime, "start") or _value(runtime, "send")
            result = await _resolve(starter(assembled))
            run_id = result if isinstance(result, str) else _value(result, "runId", assembled["runId"])
            return {
                "runId": _required_string(run_id, "runId"),
                "threadId": _required_string(assembled["threadId"], "threadId"),
            }

        return await execute(authorization, action)

    @router.post("/ai/chat/resume")
    async def resume_chat(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, str]:
            body = await _read_body(request)
            if set(body) - {"runId", "threadId", "decisions"}:
                raise RouteError("validation", "Unsupported chat resume fields")
            _required_string(body.get("runId"), "runId")
            _required_string(body.get("threadId"), "threadId")
            if not isinstance(body.get("decisions"), list):
                raise RouteError("validation", "decisions must be an array")
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
            assembled = await assemble_resume(
                body,
                repos=repos,
                services=services,
                connector=connector or _value(request.app.state, "connector"),
                db_path=_value(request.app.state, "db_path", ""),
                library_folder=_value(request.app.state, "library_folder", ""),
            )
            starter = _value(runtime, "startResume") or _value(runtime, "resume")
            result = await _resolve(starter(assembled))
            run_id = result if isinstance(result, str) else _value(result, "runId", body["runId"])
            return {"runId": _required_string(run_id, "runId")}

        return await execute(authorization, action)

    @router.post("/ai/chat/cancel")
    async def cancel_chat(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, bool]:
            body = await _read_body(request)
            run_id = _required_string(body.get("runId"), "runId")
            if set(body) != {"runId"}:
                raise RouteError("validation", "Cancel accepts only runId")
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
            if _value(_value(repos, "agentRuns"), "get")(run_id) is None:
                raise RouteError("not_found", f"run not found: {run_id}", 404)
            await _resolve(_value(runtime, "cancel")(run_id))
            return {"ack": True}

        return await execute(authorization, action)

    @router.get("/ai/chat/threads")
    async def list_threads(
        workspaceId: str | None = None,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        return await execute(
            authorization,
            lambda: _value(_value(repos, "chat"), "listThreads")(workspaceId),
        )

    @router.get("/ai/chat/threads/{thread_id}/history")
    async def get_history(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        return await execute(
            authorization,
            lambda: (_thread_scope(repos, thread_id), _value(_value(repos, "chat"), "listMessages")(thread_id))[1],
        )

    @router.get("/ai/chat/threads/{thread_id}/traces")
    async def get_traces(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        return await execute(
            authorization,
            lambda: (_thread_scope(repos, thread_id), _value(_value(repos, "agentTraces"), "listByThread")(thread_id))[1],
        )

    @router.get("/ai/chat/runs/{run_id}")
    async def get_run(
        run_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, Any]:
            run = _value(_value(repos, "agentRuns"), "get")(run_id)
            if run is None:
                raise RouteError("not_found", f"run not found: {run_id}", 404)
            return run

        return await execute(authorization, action)

    @router.get("/ai/chat/runs/{run_id}/pending-interrupt")
    async def get_pending_interrupt(
        run_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, Any] | None:
            run = _value(_value(repos, "agentRuns"), "get")(run_id)
            if run is None:
                raise RouteError("not_found", f"run not found: {run_id}", 404)
            return _value(_value(repos, "agentInterrupts"), "getPendingByRun")(run_id)

        return await execute(authorization, action)

    @router.delete("/ai/chat/threads/{thread_id}")
    async def delete_thread(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, bool]:
            _thread_scope(repos, thread_id)
            delete_runtime_thread = _value(runtime, "deleteThread")
            if callable(delete_runtime_thread):
                await _resolve(delete_runtime_thread(thread_id))
            academic = _value(services, "academic", {})
            frontier = _value(academic, "frontier")
            delete_frontier_thread = _value(frontier, "delete_thread")
            if callable(delete_frontier_thread):
                await _resolve(delete_frontier_thread(thread_id))
            _value(_value(repos, "chat"), "deleteThread")(thread_id)
            return {"ack": True}

        return await execute(authorization, action)

    @router.patch("/ai/chat/threads/{thread_id}")
    async def rename_thread(
        thread_id: str,
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, Any]:
            body = await _read_body(request)
            title = _required_string(body.get("title"), "title")
            _thread_scope(repos, thread_id)
            return _value(_value(repos, "chat"), "updateTitle")(thread_id, title)

        return await execute(authorization, action)

    @router.get("/ai/memories")
    async def list_memories(
        workspaceId: str | None = None,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> list[dict[str, Any]]:
            if workspaceId is not None and not any(
                item.get("id") == workspaceId
                for item in _value(_value(repos, "workspaces"), "list")()
            ):
                raise RouteError("not_found", f"workspace not found: {workspaceId}", 404)
            ensure_memory_files(repos, workspaceId)
            scope = memory_scope(workspaceId)
            return _value(_value(repos, "agentMemories"), "list")(
                scope["scope"], scope["scopeId"]
            )

        return await execute(authorization, action)

    @router.put("/ai/memories")
    async def update_memory(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, Any]:
            body = await _read_body(request)
            workspace_id = body.get("workspaceId")
            if workspace_id is not None:
                _required_string(workspace_id, "workspaceId")
                if not any(
                    item.get("id") == workspace_id
                    for item in _value(_value(repos, "workspaces"), "list")()
                ):
                    raise RouteError("not_found", f"workspace not found: {workspace_id}", 404)
            path = normalize_memory_path(body.get("path"), workspace_id)
            value = body.get("value")
            if not isinstance(value, str):
                raise RouteError("validation", "value must be a string")
            return update_scoped_memory(repos, workspace_id, path, value)

        return await execute(authorization, action)

    @router.delete("/ai/memories")
    async def delete_memory(
        path: str,
        workspaceId: str | None = None,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, bool]:
            normalized = normalize_memory_path(path, workspaceId)
            scope = memory_scope(workspaceId)
            removed = _value(_value(repos, "agentMemories"), "remove")(
                scope["scope"], scope["scopeId"], normalized
            )
            if not removed:
                raise RouteError("not_found", f"memory not found: {normalized}", 404)
            return {"ack": True}

        return await execute(authorization, action)

    @router.get("/ai/reports")
    async def list_reports(
        workspaceId: str | None = None,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> list[dict[str, Any]]:
            workspace_id = _required_string(workspaceId, "workspaceId")
            return _value(_value(repos, "aiReports"), "list")(workspace_id)

        return await execute(authorization, action)

    @router.patch("/ai/reports/{report_id}")
    async def update_report(
        report_id: str,
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, Any]:
            body = await _read_body(request)
            patch = {key: body[key] for key in ("title", "contentMd") if key in body}
            if not patch:
                raise RouteError("validation", "At least one report field is required")
            if any(not isinstance(value, str) for value in patch.values()):
                raise RouteError("validation", "Report fields must be strings")
            return _value(_value(repos, "aiReports"), "update")(report_id, patch)

        return await execute(authorization, action)

    @router.delete("/ai/reports/{report_id}")
    async def delete_report(
        report_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, bool]:
            reports = _value(repos, "aiReports")
            if _value(reports, "get")(report_id) is None:
                raise RouteError("not_found", f"report not found: {report_id}", 404)
            _value(reports, "delete")(report_id)
            return {"ack": True}

        return await execute(authorization, action)

    return router
