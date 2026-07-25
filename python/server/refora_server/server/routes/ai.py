from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from refora_server.db.errors import RepoError


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


def _provider_config(value: Any) -> dict[str, Any]:
    provider = _body_object(value)
    for field in ("model", "baseUrl", "apiKey"):
        _required_string(provider.get(field), f"provider.{field}")
    if not isinstance(provider.get("useResponsesApi"), bool):
        raise RouteError("validation", "provider.useResponsesApi must be a boolean")
    if not isinstance(provider.get("modelKwargs"), dict):
        raise RouteError("validation", "provider.modelKwargs must be an object")
    for field in ("temperature", "maxTokens"):
        value = provider.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise RouteError("validation", f"provider.{field} must be a number or null")
    reasoning = provider.get("reasoning")
    if reasoning is not None:
        if not isinstance(reasoning, dict) or not isinstance(reasoning.get("effort"), str) or reasoning.get("summary") != "auto":
            raise RouteError("validation", "provider.reasoning must contain effort and summary")
    return provider


def _string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise RouteError("validation", f"{field} must be an array of strings")
    return value


def _thread_scope(repos: Any, thread_id: str) -> tuple[dict[str, Any], str, str, str | None]:
    chat = _value(repos, "chat")
    thread = _value(chat, "getThread")(thread_id)
    if thread is None:
        raise RouteError("not_found", f"thread not found: {thread_id}", 404)
    workspace_id = thread.get("workspaceId")
    if workspace_id is None:
        return thread, "global", "global", None
    return thread, "workspace", workspace_id, workspace_id


def _memory_by_id(memories: Any, scope: str, scope_id: str, memory_id: str) -> dict[str, Any]:
    memory = next(
        (item for item in _value(memories, "list")(scope, scope_id) if item.get("id") == memory_id),
        None,
    )
    if memory is None:
        raise RouteError("not_found", f"memory not found: {memory_id}", 404)
    return memory


def create_ai_router(deps: Any) -> APIRouter:
    repos = _value(deps, "repos")
    services = _value(deps, "services", {})
    runtime = _value(deps, "agentRuntime")
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
            provider = _provider_config(body.get("provider"))
            documents = _value(repos, "documents")
            if documents is not None and _value(documents, "get")(document_id) is None:
                raise RouteError("not_found", f"document not found: {document_id}", 404)
            if summary_service is None:
                raise RouteError("unavailable", "AI summary service is unavailable", 503)
            summary_id = await _resolve(_value(summary_service, "summarize")(document_id, provider))
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
            for field in ("runId", "threadId", "checkpointPath", "systemPrompt"):
                _required_string(body.get(field), field)
            if body.get("workspaceId") is not None:
                _required_string(body.get("workspaceId"), "workspaceId")
            if body.get("checkpointBefore") is not None:
                _required_string(body.get("checkpointBefore"), "checkpointBefore")
            _provider_config(body.get("provider"))
            _string_list(body.get("enabledToolNames"), "enabledToolNames")
            if body.get("sandboxRoot") is not None:
                _required_string(body.get("sandboxRoot"), "sandboxRoot")
            if not isinstance(body.get("memories"), dict) or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in body["memories"].items()
            ):
                raise RouteError("validation", "memories must be an object of strings")
            if not isinstance(body.get("includeResearchMemory"), bool):
                raise RouteError("validation", "includeResearchMemory must be a boolean")
            if isinstance(body.get("recursionLimit"), bool) or not isinstance(body.get("recursionLimit"), int):
                raise RouteError("validation", "recursionLimit must be an integer")
            for field in ("messages", "decisions"):
                if field in body and not isinstance(body[field], list):
                    raise RouteError("validation", f"{field} must be an array")
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
            result = await _resolve(_value(runtime, "send")(body))
            run_id = result if isinstance(result, str) else _value(result, "runId", body["runId"])
            return {"runId": _required_string(run_id, "runId")}

        return await execute(authorization, action)

    @router.post("/ai/chat/resume")
    async def resume_chat(
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, str]:
            body = await _read_body(request)
            _required_string(body.get("runId"), "runId")
            _required_string(body.get("threadId"), "threadId")
            if not isinstance(body.get("decisions"), list):
                raise RouteError("validation", "decisions must be an array")
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
            result = await _resolve(_value(runtime, "resume")(body))
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
            if runtime is None:
                raise RouteError("unavailable", "Agent runtime is unavailable", 503)
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

    @router.get("/ai/chat/threads/{thread_id}/pending-interrupt")
    async def get_pending_interrupt(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, Any] | None:
            _thread_scope(repos, thread_id)
            runs = _value(_value(repos, "agentRuns"), "listByThread")(thread_id)
            interrupts = _value(repos, "agentInterrupts")
            for run in reversed(runs):
                pending = _value(interrupts, "getPendingByRun")(run["id"])
                if pending is not None:
                    return pending
            return None

        return await execute(authorization, action)

    @router.delete("/ai/chat/threads/{thread_id}")
    async def delete_thread(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, bool]:
            _thread_scope(repos, thread_id)
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

    @router.get("/ai/chat/threads/{thread_id}/memories")
    async def list_memories(
        thread_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> list[dict[str, Any]]:
            _, scope, scope_id, _ = _thread_scope(repos, thread_id)
            return _value(_value(repos, "agentMemories"), "list")(scope, scope_id)

        return await execute(authorization, action)

    @router.put("/ai/chat/threads/{thread_id}/memories/{memory_id}")
    async def update_memory(
        thread_id: str,
        memory_id: str,
        request: Request,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        async def action() -> dict[str, Any]:
            body = await _read_body(request)
            value = body.get("value")
            if not isinstance(value, str):
                raise RouteError("validation", "value must be a string")
            _, scope, scope_id, workspace_id = _thread_scope(repos, thread_id)
            memories = _value(repos, "agentMemories")
            memory = _memory_by_id(memories, scope, scope_id, memory_id)
            return _value(memories, "upsert")(
                {
                    "scope": scope,
                    "scopeId": scope_id,
                    "workspaceId": workspace_id,
                    "path": memory["path"],
                    "content": value,
                    "sourceThreadId": thread_id,
                }
            )

        return await execute(authorization, action)

    @router.delete("/ai/chat/threads/{thread_id}/memories/{memory_id}")
    async def delete_memory(
        thread_id: str,
        memory_id: str,
        authorization: JSONResponse | None = Depends(authorize),
    ) -> JSONResponse:
        def action() -> dict[str, bool]:
            _, scope, scope_id, _ = _thread_scope(repos, thread_id)
            memories = _value(repos, "agentMemories")
            memory = _memory_by_id(memories, scope, scope_id, memory_id)
            _value(memories, "remove")(scope, scope_id, memory["path"])
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
