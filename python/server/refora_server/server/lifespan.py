from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from fastapi import FastAPI
from langchain_openai import ChatOpenAI

from refora_server.db.connection import close_database, get_search_mode, open_database
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.server.connector import create_connector_broker
from refora_server.server.events import create_event_bus
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.ai_summary import createAiSummaryService
from refora_server.services.chat_history import createChatHistoryService
from refora_server.services.export import createExportService
from refora_server.services.library import createLibraryService
from refora_server.services.mineru import (
    MineruEngineManagerDeps,
    MineruWorkerProcessDeps,
    create_mineru_engine_manager,
    create_mineru_worker_process,
)
from refora_server.services.ocr import OcrServiceDeps, create_ocr_service
from refora_server.services.thread_title import createThreadTitleService
from refora_server.services.watcher import createWatcherService
from refora_server.services.web_search import createWebSearchService
from refora_server.services.workspaces import createWorkspacesService
from refora_server.library.importer import createImporter


def _mineru_worker_path() -> str:
    configured = os.environ.get("REFORA_MINERU_WORKER_PATH")
    if configured:
        return configured
    package_root = Path(__file__).resolve().parents[2]
    candidates = (
        package_root.parent / "mineru" / "mineru_worker.py",
        package_root.parents[1] / "resources" / "mineru_worker.py",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return str(candidates[0])


async def _download_mineru_file(
    url: str,
    destination: str,
    cancel_event: asyncio.Event,
    on_progress: Any,
) -> None:
    try:
        import httpx
    except ImportError as error:
        raise RuntimeError("MinerU download support is unavailable") from error
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    received = 0
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                raw_total = response.headers.get("content-length")
                total = int(raw_total) if raw_total and raw_total.isdigit() else None
                with open(destination, "wb") as output:
                    os.chmod(destination, 0o600)
                    async for chunk in response.aiter_bytes(64 * 1024):
                        if cancel_event.is_set():
                            raise RuntimeError("MinerU installation was cancelled")
                        output.write(chunk)
                        received += len(chunk)
                        on_progress(received, total)
        if cancel_event.is_set():
            raise RuntimeError("MinerU installation was cancelled")
    except BaseException:
        try:
            os.unlink(destination)
        except FileNotFoundError:
            pass
        raise


async def _trash_mineru_path(connector: Any, path: str) -> None:
    result = await connector.trash_item(path)
    if isinstance(result, dict) and result.get("ok"):
        return
    error = result.get("error") if isinstance(result, dict) else None
    message = error.get("message") if isinstance(error, dict) else "No response from the native connector"
    raise RuntimeError(f"Native Trash connector is unavailable: {message}")


def _schedule_event(events: Any, name: str, data: Any) -> None:
    task = asyncio.create_task(events.broadcast(name, data))

    def consume_result(completed: asyncio.Task[Any]) -> None:
        try:
            completed.result()
        except Exception:
            pass

    task.add_done_callback(consume_result)


def _unavailable_ocr_service(reason: str) -> dict[str, Any]:
    async def unavailable(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"OCR service is unavailable: {reason}")

    async def stop_worker() -> None:
        return None

    def destroy() -> None:
        return None

    return {
        "initialize": unavailable,
        "getState": unavailable,
        "startOcr": unavailable,
        "cancelOcr": unavailable,
        "getOcrState": unavailable,
        "getMarkdown": unavailable,
        "readMarkdown": unavailable,
        "prepareDocumentDelete": unavailable,
        "stopWorker": stop_worker,
        "destroy": destroy,
    }


def _create_model(provider: dict[str, Any]) -> ChatOpenAI:
    options: dict[str, Any] = {
        "model": provider["model"],
        "api_key": provider["apiKey"],
        "base_url": provider["baseUrl"],
        "streaming": True,
        "use_responses_api": provider.get("useResponsesApi", False),
        "model_kwargs": dict(provider.get("modelKwargs") or {}),
    }
    if provider.get("temperature") is not None:
        options["temperature"] = provider["temperature"]
    if provider.get("maxTokens") is not None:
        options["max_completion_tokens"] = provider["maxTokens"]
    if isinstance(provider.get("reasoning"), dict):
        options["reasoning"] = provider["reasoning"]
    return ChatOpenAI(**options)


def _create_agent(model: ChatOpenAI, tools: list[Any], request: dict[str, Any]) -> Any:
    return create_deep_agent(
        model=model,
        tools=tools,
        system_prompt=request.get("systemPrompt") or None,
        backend=StateBackend(),
        interrupt_on={
            "prepare_paper_ocr": True,
            "publish_workspace_artifacts": True,
            "install_runtime_packages": True,
            "propose_workspace_memory_update": True,
        },
    )


def _unavailable_agent_capability(*_args: Any, **_kwargs: Any) -> Any:
    raise RuntimeError("Agent capability is unavailable")


def create_lifespan(
    db_path: str,
    library_folder: str,
    db: Any | None = None,
):
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = db
        owns_database = database is None
        if database is None:
            database, _ = open_database(db_path)
        app.state.db = database
        app.state.db_path = db_path
        app.state.library_folder = library_folder
        repos = create_repositories(
            database,
            RepositoryDeps(
                getLibraryFolder=lambda: app.state.library_folder,
                getSearchMode=get_search_mode,
            ),
        )
        events = create_event_bus()
        connector = create_connector_broker(events)
        emit = events.broadcast
        mineru = create_mineru_engine_manager(
            MineruEngineManagerDeps(
                userDataDir=os.path.dirname(os.path.abspath(db_path)),
                downloadFile=_download_mineru_file,
                trashItem=lambda path: _trash_mineru_path(connector, path),
                emitProgress=lambda progress: _schedule_event(
                    events, "mineru.install-progress", progress.to_dict()
                ),
            )
        )
        complete_repos = {"documents", "settings", "watchFolders", "categories", "webSearchConfig"}.issubset(repos)
        ocr_repos_ready = {"documents", "documentOcr"}.issubset(repos)
        importer = {}
        watcher = {}
        exporter = {}
        web_search = {}
        library = createLibraryService(repos, {"emit": lambda event, data: emit(event, data)})
        if complete_repos:
            importer = createImporter(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "emitProgress": lambda data: emit("import.progress", data),
                },
            )
            watcher = createWatcherService(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "onNewPdf": lambda paths: importer["importFiles"](paths, True),
                },
            )
            exporter = createExportService(repos)
            web_search = createWebSearchService(repos, {})
        worker_path = _mineru_worker_path()
        if ocr_repos_ready and os.path.isfile(worker_path):
            worker = create_mineru_worker_process(
                MineruWorkerProcessDeps(engineManager=mineru, workerScriptPath=worker_path)
            )
            ocr = create_ocr_service(
                repos,
                OcrServiceDeps(
                    engineManager=mineru,
                    worker=worker,
                    getLibraryFolder=lambda: app.state.library_folder,
                    emitProgress=lambda data: _schedule_event(events, "ocr.progress", data),
                    emitCompleted=lambda data: _schedule_event(events, "ocr.completed", data),
                    emitError=lambda data: _schedule_event(events, "ocr.error", data),
                ),
            )
            await ocr["initialize"]()
        elif not ocr_repos_ready:
            ocr = _unavailable_ocr_service("OCR repositories are not available")
        else:
            ocr = _unavailable_ocr_service("MinerU worker script is missing")
        services = {
            "library": library,
            "importer": importer,
            "watcher": watcher,
            "export": exporter,
            "webSearch": web_search,
            "mineru": mineru,
            "ocr": ocr,
            "aiProviders": createAiProvidersService(repos),
            "aiSummary": createAiSummaryService(repos),
            "chatHistory": createChatHistoryService(repos),
            "threadTitle": createThreadTitleService(repos),
            "workspaces": createWorkspacesService(
                repos,
                {
                    "connector": connector,
                    "getSandboxPath": lambda workspace_id: f"{app.state.library_folder}/.refora/sandboxes/{workspace_id}",
                },
            ),
        }

        def create_tools(request: dict[str, Any]) -> list[Any]:
            enabled_names = request.get("enabledToolNames")
            if not isinstance(enabled_names, list):
                return []
            enabled = {name for name in enabled_names if isinstance(name, str)}
            tool_deps = {
                "repos": repos,
                "interrupt": lambda *_args: None,
                "ai_summary": _unavailable_agent_capability,
                "read_ocr_fulltext": _unavailable_agent_capability,
                "publish_artifacts": _unavailable_agent_capability,
                "install_runtime_packages": _unavailable_agent_capability,
                "prepare_paper_ocr": _unavailable_agent_capability,
                "web_search": web_search.get("search", _unavailable_agent_capability),
                "web_fetch": _unavailable_agent_capability,
                "academic": {},
            }
            tools = create_agent_tools(
                AgentToolContext(
                    run_id=request["runId"],
                    thread_id=request.get("threadId"),
                    workspace_id=request.get("workspaceId"),
                ),
                tool_deps,
            )
            return [tool for tool in tools if tool.name in enabled]

        agent_runtime = createAgentRuntime(
            repos,
            {
                "emit": events.broadcast,
                "connector": connector,
                "createTools": create_tools,
                "createModel": _create_model,
                "createAgent": _create_agent,
                "generateTitle": services["threadTitle"].get("generateThreadTitle"),
            },
        )
        app.state.repos = repos
        app.state.services = services
        app.state.event_bus = events
        app.state.connector = connector
        app.state.agent_runtime = agent_runtime
        if hasattr(app.state, "require_token"):
            from refora_server.server.app import configure_app

            configure_app(app)
        try:
            yield
        finally:
            await ocr["stopWorker"]()
            ocr["destroy"]()
            mineru["destroy"]()
            await connector.cancel_pending()
            await events.flush()
            if owns_database:
                close_database(database)

    return lifespan
