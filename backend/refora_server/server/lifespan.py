from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from refora_server.academic import (
    create_academic_cache,
    create_academic_graph_service,
    create_academic_identity_service,
    create_arxiv_client,
    create_arxiv_paper_service,
    create_research_frontier_service,
    create_semantic_scholar_client,
)
from refora_server.academic.arxiv import FetchResponse
from refora_server.agent.providers import create_agent, create_model
from refora_server.db.connection import close_database, get_search_mode, open_database
from refora_server.db.settings_seed import seed_default_settings
from refora_server.library.paths import resolveFromLibrary
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.server.connector import create_connector_broker
from refora_server.server.events import create_event_bus
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_intent import assemble_recovery
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.ai_summary import createAiSummaryService
from refora_server.services.academic_serializer import (
    serialize_arxiv_search_response,
    serialize_paper,
    serialize_paper_fulltext_response,
    serialize_semantic_recommendations_response,
)
from refora_server.services.chat_history import createChatHistoryService
from refora_server.services.document_text import createDocumentTextService
from refora_server.services.document_presence import create_document_presence_service
from refora_server.services.export import createExportService
from refora_server.services.library import createLibraryService
from refora_server.services.mineru import (
    MineruEngineManagerDeps,
    MineruWorkerProcessDeps,
    create_mineru_engine_manager,
    create_mineru_worker_process,
)
from refora_server.services.metadata import create_metadata_service
from refora_server.services.ocr import OcrServiceDeps, create_ocr_service
from refora_server.services.related_papers import find_related_papers
from refora_server.services.sandbox import SandboxOptions, createSandboxService
from refora_server.services.thread_title import createThreadTitleService
from refora_server.services.watcher import createWatcherService
from refora_server.services.web_search import createWebSearchService
from refora_server.services.web_fetch import fetchUrlAsync
from refora_server.services.workspaces import createWorkspacesService
from refora_server.library.importer import createImporter


def _mineru_worker_path() -> str:
    configured = os.environ.get("REFORA_MINERU_WORKER_PATH")
    if configured:
        return configured
    package_root = Path(__file__).resolve().parents[2]
    candidates = (
        package_root / "workers" / "mineru_worker.py",
        package_root.parent / "mineru" / "mineru_worker.py",
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


def _schedule_event(
    events: Any,
    name: str,
    data: Any,
    loop: asyncio.AbstractEventLoop | None = None,
) -> None:
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if loop is not None and running_loop is not loop:
        future = asyncio.run_coroutine_threadsafe(events.broadcast(name, data), loop)
        future.add_done_callback(_consume_future)
        return
    task = asyncio.create_task(events.broadcast(name, data))

    def consume_result(completed: asyncio.Task[Any]) -> None:
        try:
            completed.result()
        except Exception:
            pass

    task.add_done_callback(consume_result)


def _consume_future(completed: Any) -> None:
    try:
        completed.result()
    except BaseException:
        pass


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


def _unavailable_agent_capability(*_args: Any, **_kwargs: Any) -> dict[str, str]:
    return {
        "status": "unavailable",
        "code": "agent_capability_unavailable",
        "message": "Agent capability is unavailable",
    }


class _LazyAgentRuntime(dict):
    def __init__(self, app: FastAPI) -> None:
        self._app = app

    def _resolve(self) -> dict[str, Any]:
        runtime = getattr(self._app.state, "agent_runtime", None)
        return runtime if isinstance(runtime, dict) else {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._resolve().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self._resolve()[key]

    def __contains__(self, key: object) -> bool:
        return key in self._resolve()


def _summary_prompt(text: str | None, combined: str | None) -> str:
    if isinstance(text, str):
        return (
            "You are a research assistant reading text extracted from a PDF. "
            "Capture at most two essential facts from this excerpt in no more than "
            "60 words total. Be concise and factual; do not write a long "
            "interpretation.\n\n"
            f"Extracted PDF text:\n{text}"
        )
    if isinstance(combined, str):
        return (
            "You are a research assistant. Create a brief factual overview from the "
            "extracted PDF section notes below. Respond in the paper's primary "
            "language with ONLY a JSON object containing exactly two fields: "
            '"core" (one or two short sentences, at most 80 words) and "keyPoints" '
            "(an array of 3 to 5 concise strings, each at most 20 words). Do not add "
            "methods, contribution, analysis, markdown, or commentary.\n\n"
            f"Extracted PDF section notes:\n{combined}"
        )
    raise RuntimeError("AI summary input is unavailable")


def create_lifespan(
    db_path: str,
    library_folder: str,
    db: Any | None = None,
    *,
    state_dir: str | None = None,
    user_data_dir: str | None = None,
    language: str = "en",
):
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = db
        owns_database = database is None
        if database is None:
            database, _ = open_database(db_path)
        if callable(getattr(database, "execute", None)):
            seed_default_settings(database, "zh" if language == "zh" else "en")
        if library_folder and callable(getattr(database, "execute", None)):
            database.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                ("libraryFolderPath", json.dumps(library_folder)),
            )
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
        agent_runs = repos.get("agentRuns")
        list_active_runs = (
            agent_runs.get("listActive")
            if isinstance(agent_runs, dict)
            else None
        )
        startup_active_runs = list_active_runs() if callable(list_active_runs) else []
        events = create_event_bus()
        connector = create_connector_broker(events)
        server_loop = asyncio.get_running_loop()
        run_cancel_events: dict[str, asyncio.Event] = {}

        async def await_run_operation(
            operation: Any, cancel_event: asyncio.Event
        ) -> Any:
            task = asyncio.ensure_future(operation)
            cancel_task = asyncio.create_task(cancel_event.wait())
            done, _ = await asyncio.wait(
                {task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if cancel_task in done and cancel_event.is_set():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise asyncio.CancelledError()
            cancel_task.cancel()
            await asyncio.gather(cancel_task, return_exceptions=True)
            return await task

        def run_on_server_loop(
            operation: Any, cancel_event: asyncio.Event
        ) -> Any:
            future = asyncio.run_coroutine_threadsafe(
                await_run_operation(operation, cancel_event), server_loop
            )
            return future.result()

        def cancel_agent_network(run_id: str) -> None:
            event = run_cancel_events.get(run_id)
            if event is not None:
                server_loop.call_soon_threadsafe(event.set)

        def cancel_agent_run(run_id: str) -> bool:
            cancel_agent_network(run_id)
            cancel_sandbox = sandbox.get("cancel")
            return bool(cancel_sandbox(run_id)) if callable(cancel_sandbox) else False

        def finish_agent_run(run_id: str) -> None:
            run_cancel_events.pop(run_id, None)

        emit = events.broadcast
        mineru = create_mineru_engine_manager(
            MineruEngineManagerDeps(
                userDataDir=(
                    user_data_dir
                    or state_dir
                    or os.path.dirname(os.path.abspath(db_path))
                ),
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
        metadata_service: dict[str, Any] = {}
        library = createLibraryService(
            repos,
            {
                "emit": lambda event, data: _schedule_event(
                    events, event, data, server_loop
                )
            },
        )

        def proxy_url() -> str:
            settings_repo = repos.get("settings")
            get_setting = (
                settings_repo.get
                if callable(getattr(settings_repo, "get", None))
                else settings_repo.get("get")
                if isinstance(settings_repo, dict)
                else None
            )
            value = get_setting("proxyUrl", "") if callable(get_setting) else ""
            return value.strip() if isinstance(value, str) else ""

        if complete_repos:
            async def confirm_duplicate(file_name: str) -> bool:
                result = await connector.dialog_choose(
                    "Duplicate File",
                    f'"{file_name}" has the same content as a file already in your library. Skip this file?',
                    ["Skip", "Import Anyway"],
                    0,
                    0,
                )
                if not isinstance(result, dict) or result.get("ok") is not True:
                    return True
                data = result.get("data")
                return not isinstance(data, dict) or data.get("response") != 1

            importer = createImporter(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "confirmDuplicate": confirm_duplicate,
                    "emitProgress": lambda data: _schedule_event(
                        events, "import.progress", data, server_loop
                    ),
                },
            )

            def enqueue_imported_metadata(result: dict[str, Any]) -> None:
                errors = result.get("errors")
                if isinstance(errors, list):
                    for error in errors:
                        if isinstance(error, dict) and isinstance(error.get("message"), str):
                            _schedule_event(
                                events,
                                "import.toast",
                                error["message"],
                                server_loop,
                            )
                imported = result.get("imported")
                if not isinstance(imported, list):
                    return
                document_ids = [
                    value
                    for value in imported
                    if isinstance(value, str) and value
                ]
                if document_ids:
                    enqueue = metadata_service.get("enqueue")
                    if callable(enqueue):
                        for document_id in document_ids:
                            enqueue(document_id)

            importer["onComplete"](enqueue_imported_metadata)
            watcher = createWatcherService(
                repos,
                {
                    "getLibraryFolder": lambda: app.state.library_folder,
                    "onNewPdf": lambda paths: importer["importFiles"](paths, True),
                },
            )
            exporter = createExportService(repos)
            async def decrypt_search_key(
                api_key_enc: bytes, _provider: str | None = None
            ) -> str:
                result = await connector.decrypt_api_key(api_key_enc)
                if not isinstance(result, dict) or result.get("ok") is not True:
                    error = result.get("error") if isinstance(result, dict) else None
                    message = (
                        error.get("message")
                        if isinstance(error, dict)
                        else "Native key decryption failed"
                    )
                    raise RuntimeError(str(message))
                data = result.get("data")
                api_key = data.get("apiKey") if isinstance(data, dict) else None
                if not isinstance(api_key, str) or not api_key:
                    raise RuntimeError(
                        "Native key storage returned an invalid payload"
                    )
                return api_key

            web_search = createWebSearchService(
                repos,
                {
                    "decryptKey": connector.decrypt_api_key_sync,
                    "decryptKeyAsync": decrypt_search_key,
                    "getProxy": proxy_url,
                },
            )
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

        document_text = createDocumentTextService(repos)

        def generate_summary(payload: dict[str, Any]) -> Any:
            provider = payload.get("provider")
            if not isinstance(provider, dict):
                raise RuntimeError("AI summary provider is unavailable")
            prompt = _summary_prompt(payload.get("text"), payload.get("combined"))
            response = create_model(provider).invoke(
                [{"role": "user", "content": prompt}]
            )
            return getattr(response, "content", response)

        summary_service = createAiSummaryService(
            repos,
            {
                "generate_summary": generate_summary,
                "load_text": document_text["getOrExtract"],
                "emit_delta": lambda document_id, _summary_id: _schedule_event(
                    events, "ai.summary.updated", document_id, server_loop
                ),
                "emit_error": lambda document_id, message: _schedule_event(
                    events,
                    "ai.summary.error",
                    {"docId": document_id, "message": message},
                    server_loop,
                ),
            },
        )

        def generate_title(payload: dict[str, Any]) -> str:
            provider = payload.get("provider")
            user_message = payload.get("userMessage")
            if not isinstance(provider, dict) or not isinstance(user_message, str):
                raise RuntimeError("Thread title input is unavailable")
            prompt = (
                "Generate a concise title (3-8 words, no quotes, no punctuation at the end) "
                "for a research conversation that starts with this user message. "
                "Reply with ONLY the title, nothing else.\n\n"
                f"User message: {user_message[:500]}"
            )
            response = create_model(provider).invoke(
                [{"role": "user", "content": prompt}]
            )
            content = getattr(response, "content", response)
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        return part["text"]
            additional = getattr(response, "additional_kwargs", None)
            if isinstance(additional, dict):
                reasoning_content = additional.get("reasoning_content")
                if isinstance(reasoning_content, str):
                    lines = [
                        line.strip()
                        for line in reasoning_content.splitlines()
                        if line.strip()
                    ]
                    if lines:
                        return lines[-1]
            return ""

        async def academic_fetch(url: str, options: dict[str, Any]) -> FetchResponse:
            try:
                import httpx
            except ImportError as error:
                raise RuntimeError("Academic network support is unavailable") from error
            signal = options.get("signal")
            if isinstance(signal, asyncio.Event) and signal.is_set():
                raise asyncio.CancelledError()
            timeout_ms = options.get("timeout_ms")
            timeout = (
                max(1, int(timeout_ms)) / 1000
                if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool)
                else 20.0
            )
            headers = options.get("headers")
            request_headers = headers if isinstance(headers, dict) else None
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=options.get("follow_redirects") is True,
                **({"proxy": proxy_url()} if proxy_url() else {}),
            ) as client:
                request_task = asyncio.create_task(
                    client.get(url, headers=request_headers)
                )
                if isinstance(signal, asyncio.Event):
                    cancel_task = asyncio.create_task(signal.wait())
                    done, _ = await asyncio.wait(
                        {request_task, cancel_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if cancel_task in done and signal.is_set():
                        request_task.cancel()
                        await asyncio.gather(
                            request_task, return_exceptions=True
                        )
                        raise asyncio.CancelledError()
                    cancel_task.cancel()
                    await asyncio.gather(cancel_task, return_exceptions=True)
                response = await request_task
            if isinstance(signal, asyncio.Event) and signal.is_set():
                raise asyncio.CancelledError()
            return FetchResponse(
                status=response.status_code,
                text=response.text,
                headers=dict(response.headers),
                final_url=str(response.url),
            )

        academic: dict[str, Any] = {}
        if "documents" in repos:
            academic_cache = create_academic_cache(
                os.path.join(app.state.library_folder, ".refora", "academic-cache")
            )
            arxiv_client = create_arxiv_client(academic_fetch, academic_cache)
            semantic_scholar_client = create_semantic_scholar_client(
                academic_fetch, academic_cache
            )
            academic_identity = create_academic_identity_service(
                repos["documents"], semantic_scholar_client
            )
            academic_graph = create_academic_graph_service(
                academic_identity, semantic_scholar_client
            )
            academic_frontier = create_research_frontier_service(
                academic_identity,
                academic_graph,
                arxiv_client,
                os.path.join(app.state.library_folder, ".refora", "academic-frontiers"),
            )
            arxiv_papers = create_arxiv_paper_service(arxiv_client, academic_cache)

            async def search_arxiv(request: Any) -> dict[str, Any]:
                return serialize_arxiv_search_response(await arxiv_client.search(request))

            async def get_arxiv_by_id(arxiv_id: str) -> dict[str, Any] | None:
                paper = await arxiv_client.get_by_id(arxiv_id)
                return serialize_paper(paper, "arxiv") if paper is not None else None

            async def search_arxiv_title(
                title: str, page_size: int = 5
            ) -> dict[str, Any]:
                return serialize_arxiv_search_response(
                    await arxiv_client.search_title(title, page_size)
                )

            async def get_arxiv_paper(
                arxiv_id: str,
                section_id: str | None = None,
                cursor: str | None = None,
                max_chars: int | None = None,
            ) -> dict[str, Any]:
                return serialize_paper_fulltext_response(
                    await arxiv_papers.get_paper(arxiv_id, section_id, cursor, max_chars)
                )

            async def get_semantic_recommendations(
                locator: Any, limit: int | None = None
            ) -> dict[str, Any]:
                return serialize_semantic_recommendations_response(
                    await academic_graph.get_recommendations(locator, limit)
                )

            academic = {
                "arxiv": {
                    "search": search_arxiv,
                    "getById": get_arxiv_by_id,
                    "searchTitle": search_arxiv_title,
                },
                "arxiv_papers": {"get_paper": get_arxiv_paper},
                "identity": academic_identity,
                "graph": {
                    "get_citing_papers": academic_graph.get_citing_papers,
                    "get_referenced_papers": academic_graph.get_referenced_papers,
                    "get_recommendations": get_semantic_recommendations,
                },
                "frontier": academic_frontier,
            }
        def list_readonly_workspace_assets(workspace_id: str) -> list[dict[str, Any]]:
            assets = repos["workspaceAssets"]["list"](workspace_id)
            return [
                {
                    **asset,
                    "filePath": resolveFromLibrary(
                        asset["filePath"], app.state.library_folder
                    ),
                }
                for asset in assets
            ]

        sandbox = createSandboxService(
            SandboxOptions(
                shared_root=os.path.join(
                    os.path.abspath(app.state.library_folder),
                    ".refora-agent",
                    "shared",
                ),
                db_path=db_path,
                documents_repo=repos.get("documents"),
                workspace_assets_repo={"list": list_readonly_workspace_assets},
            )
        )
        if isinstance(repos.get("documents"), dict):
            metadata_service = create_metadata_service(
                repos,
                academic=academic,
                emit=events.broadcast,
                proxy=proxy_url,
            )
        else:
            async def destroy_metadata() -> None:
                return None

            metadata_service = {
                "resumeOnStartup": lambda: None,
                "destroy": destroy_metadata,
            }
        metadata_service["resumeOnStartup"]()
        start_watcher = watcher.get("startScanning")
        if callable(start_watcher):
            start_watcher()
        if isinstance(repos.get("documents"), dict):
            document_presence = create_document_presence_service(
                repos,
                emit=events.broadcast,
            )
        else:
            async def destroy_document_presence() -> None:
                return None

            document_presence = {
                "start": lambda: None,
                "destroy": destroy_document_presence,
            }
        document_presence["start"]()
        services = {
            "repos": repos,
            "library": library,
            "importer": importer,
            "watcher": watcher,
            "export": exporter,
            "webSearch": web_search,
            "mineru": mineru,
            "ocr": ocr,
            "aiProviders": createAiProvidersService(repos),
            "aiSummary": summary_service,
            "documentText": document_text,
            "documentPresence": document_presence,
            "metadata": metadata_service,
            "academic": academic,
            "sandbox": sandbox,
            "chatHistory": createChatHistoryService(repos),
            "threadTitle": createThreadTitleService(
                repos, {"generate_title": generate_title}
            ),
            "workspaces": createWorkspacesService(
                repos,
                {
                    "connector": connector,
                    "getSandboxPath": lambda workspace_id: f"{app.state.library_folder}/.refora/sandboxes/{workspace_id}",
                    "agentRuntime": _LazyAgentRuntime(app),
                    "academic": academic,
                },
            ),
        }

        def create_tools(request: dict[str, Any]) -> list[Any]:
            enabled_names = request.get("enabledToolNames")
            enabled = (
                {name for name in enabled_names if isinstance(name, str)}
                if isinstance(enabled_names, list)
                else set()
            )
            run_id = request["runId"]
            cancel_event = run_cancel_events.get(run_id)
            if cancel_event is None or cancel_event.is_set():
                cancel_event = asyncio.Event()
                run_cancel_events[run_id] = cancel_event
                server_loop.call_later(
                    6 * 60 * 60,
                    lambda: (
                        run_cancel_events.pop(run_id, None)
                        if run_cancel_events.get(run_id) is cancel_event
                        else None
                    ),
                )

            def run_academic(operation: Any) -> Any:
                return run_on_server_loop(operation, cancel_event)

            def request_summary(document_id: str) -> Any:
                provider = request.get("provider")
                if not isinstance(provider, dict):
                    return _unavailable_agent_capability()
                server_loop.call_soon_threadsafe(
                    summary_service["queueSummary"], document_id, provider
                )
                return {"status": "queued", "docId": document_id}

            def read_paper_fulltext(document_id: str) -> str:
                return run_on_server_loop(
                    document_text["getOrExtract"](document_id),
                    cancel_event,
                )

            def read_ocr_fulltext(document_id: str) -> dict[str, Any] | None:
                return run_on_server_loop(
                    ocr["readCachedForAgent"](document_id),
                    cancel_event,
                )

            def prepare_paper_ocr(document_id: str) -> dict[str, Any]:
                cached = run_on_server_loop(
                    ocr["prepareForAgent"](document_id, cancel_event),
                    cancel_event,
                )
                result = cached["result"]
                markdown = cached["markdown"]
                document = repos["documents"]["get"](document_id)
                return {
                    "status": "ready",
                    "docId": document_id,
                    "title": (
                        document.get("title") or document.get("fileName")
                        if document
                        else document_id
                    ),
                    "source": "mineru_ocr",
                    "profile": result["profile"],
                    "resultKey": result["resultKey"],
                    "totalChars": len(markdown),
                    "message": "Balanced OCR cache is ready. Continue with read_paper_ocr_fulltext.",
                }

            def open_paper(document_id: str) -> dict[str, Any]:
                document = repos["documents"]["get"](document_id)
                if document is None:
                    return {"error": "Document not found.", "docId": document_id}
                workspace_id = request.get("workspaceId")
                if isinstance(workspace_id, str):
                    workspace_doc_ids = {
                        item["docId"]
                        for item in repos["workspaceItems"]["list"](workspace_id)
                        if item.get("kind") == "document"
                    }
                    if document_id not in workspace_doc_ids:
                        return {
                            "error": "Document is not in the current workspace.",
                            "docId": document_id,
                        }
                result = asyncio.run_coroutine_threadsafe(
                    connector.open_path(document["filePath"]),
                    server_loop,
                ).result(timeout=31)
                if not isinstance(result, dict) or result.get("ok") is not True:
                    error = result.get("error") if isinstance(result, dict) else None
                    return {
                        "error": error.get("message")
                        if isinstance(error, dict)
                        else "Failed to open document.",
                        "docId": document_id,
                    }
                return {
                    "opened": True,
                    "docId": document_id,
                    "title": document.get("title") or document.get("fileName"),
                }

            def related(document_id: str, limit: int = 8) -> dict[str, Any]:
                return find_related_papers(
                    repos,
                    document_id,
                    limit,
                    request.get("workspaceId")
                    if isinstance(request.get("workspaceId"), str)
                    else None,
                )

            def workspace_changed(workspace_id: str, reason: str) -> None:
                _schedule_event(
                    events,
                    "workspace.items.changed",
                    {"workspaceId": workspace_id, "reason": reason},
                    server_loop,
                )

            def report_created(report: dict[str, Any]) -> None:
                _schedule_event(
                    events,
                    "ai.report.created",
                    report,
                    server_loop,
                )

            def publish_artifacts(
                workspace_id: str | None,
                paths: list[str],
                placement: dict[str, Any] | None = None,
            ) -> dict[str, Any]:
                if not workspace_id:
                    return {
                        "published": [],
                        "errors": [
                            {
                                "path": path,
                                "message": "No workspace is selected; artifact remains in the default sandbox.",
                            }
                            for path in paths
                            if isinstance(path, str)
                        ],
                    }
                sandbox_root = request.get("sandboxRoot")
                if not isinstance(sandbox_root, str) or not sandbox_root:
                    return _unavailable_agent_capability()
                outputs_root = os.path.realpath(os.path.join(sandbox_root, "outputs"))
                resolved_paths: list[tuple[str, str]] = []
                errors: list[dict[str, str]] = []
                for path in paths:
                    if not isinstance(path, str) or not path.strip() or os.path.isabs(path):
                        errors.append({"path": str(path), "message": "Artifact paths must be non-empty and relative"})
                        continue
                    candidate = os.path.realpath(os.path.join(sandbox_root, path))
                    try:
                        inside_outputs = os.path.commonpath([outputs_root, candidate]) == outputs_root
                    except ValueError:
                        inside_outputs = False
                    if not inside_outputs or os.path.islink(candidate) or not os.path.isfile(candidate):
                        errors.append({"path": path, "message": "Only regular files under the sandbox outputs directory can be published"})
                        continue
                    resolved_paths.append((path, candidate))
                imported = services["workspaces"]["importAssets"](
                    workspace_id, [candidate for _, candidate in resolved_paths], placement
                )
                published = [
                    {
                        "path": next(
                            (
                                path
                                for path, candidate in resolved_paths
                                if candidate == asset["sourcePath"]
                            ),
                            asset["sourcePath"],
                        ),
                        "assetId": asset["id"],
                        "fileName": asset["fileName"],
                    }
                    for asset in imported["imported"]
                ]
                if published:
                    workspace_changed(workspace_id, "other")
                return {"published": published, "errors": [*errors, *imported["errors"]]}

            sandbox_root = request["sandboxRoot"]

            def execute_sandbox(command: str, args: dict[str, Any] | None = None) -> Any:
                return sandbox["execute_sandbox"](
                    command,
                    {
                        **(args or {}),
                        "_sandboxRoot": sandbox_root,
                        "_workspaceId": request.get("workspaceId"),
                    },
                )

            def install_runtime_packages(
                workspace_id: str | None,
                args: dict[str, Any] | None = None,
            ) -> Any:
                installer = sandbox.get("install_runtime_packages")
                if not callable(installer):
                    return _unavailable_agent_capability()
                return installer(
                    workspace_id,
                    {**(args or {}), "_sandboxRoot": sandbox_root},
                )

            tool_academic: dict[str, Any] = {}
            if academic:
                tool_academic = {
                    "arxiv": {
                        "search": lambda value: run_academic(
                            arxiv_client.search(value, cancel_event)
                        )
                    },
                    "arxiv_papers": {
                        "get_paper": lambda arxiv_id, section_id=None, cursor=None, max_chars=None: run_academic(
                            arxiv_papers.get_paper(
                                arxiv_id,
                                section_id,
                                cursor,
                                max_chars,
                                cancel_event,
                            )
                        )
                    },
                    "identity": {
                        "resolve": lambda locator: run_academic(
                            academic_identity.resolve(locator, cancel_event)
                        )
                    },
                    "graph": {
                        "get_citing_papers": lambda locator, cursor=None, limit=None, signal=None, filters=None: run_academic(
                            academic_graph.get_citing_papers(
                                locator,
                                cursor,
                                limit,
                                cancel_event,
                                filters,
                            )
                        ),
                        "get_referenced_papers": lambda locator, cursor=None, limit=None, signal=None, filters=None: run_academic(
                            academic_graph.get_referenced_papers(
                                locator,
                                cursor,
                                limit,
                                cancel_event,
                                filters,
                            )
                        ),
                        "get_recommendations": lambda locator, limit=None: run_academic(
                            academic_graph.get_recommendations(
                                locator, limit, cancel_event
                            )
                        ),
                    },
                    "frontier": {
                        "start": lambda value: run_academic(
                            academic_frontier.start(value, cancel_event)
                        ),
                        "expand": lambda value: run_academic(
                            academic_frontier.expand(value, cancel_event)
                        ),
                        "continue_page": lambda value: run_academic(
                            academic_frontier.continue_page(
                                value, cancel_event
                            )
                        ),
                    },
                }

            tool_deps = {
                "repos": repos,
                "ai_summary": request_summary,
                "read_paper_fulltext": read_paper_fulltext,
                "read_ocr_fulltext": read_ocr_fulltext,
                "open_paper": open_paper,
                "find_related_papers": related,
                "publish_artifacts": publish_artifacts,
                "install_runtime_packages": install_runtime_packages,
                "prepare_paper_ocr": prepare_paper_ocr,
                "web_search": (
                    lambda value: run_on_server_loop(
                        web_search["searchAsync"](value, cancel_event),
                        cancel_event,
                    )
                )
                if callable(web_search.get("searchAsync"))
                else _unavailable_agent_capability,
                "web_fetch": lambda value: run_on_server_loop(
                    fetchUrlAsync(
                        value,
                        cancelEvent=cancel_event,
                        proxy=proxy_url() or None,
                    ),
                    cancel_event,
                ),
                "execute_sandbox": execute_sandbox,
                "workspace_changed": workspace_changed,
                "report_created": report_created,
                "model": (
                    request["provider"].get("model")
                    if isinstance(request.get("provider"), dict)
                    else None
                ),
                "academic": tool_academic,
            }
            tools = create_agent_tools(
                AgentToolContext(
                    run_id=request["runId"],
                    thread_id=request.get("threadId"),
                    workspace_id=request.get("workspaceId"),
                ),
                tool_deps,
            )
            if not request.get("workspaceId"):
                enabled -= {
                    "list_workspace_context",
                    "search_workspace_docs",
                    "add_docs_to_workspace",
                    "create_workspace_connections",
                    "generate_report",
                    "list_workspace_assets",
                    "list_workspace_notes",
                }
            if not web_search.get("isEnabled", lambda: False)():
                enabled -= {"web_search", "web_fetch"}
            if "install_runtime_packages" not in sandbox:
                enabled.discard("install_runtime_packages")
            return [tool for tool in tools if tool.name in enabled]

        async def generate_thread_title(
            thread_id: str,
            provider: dict[str, Any],
        ) -> str | None:
            return await asyncio.to_thread(
                services["threadTitle"]["generateThreadTitle"],
                thread_id,
                provider,
            )

        agent_runtime = createAgentRuntime(
            repos,
            {
                "emit": events.broadcast,
                "connector": connector,
                "createTools": create_tools,
                "createModel": create_model,
                "createAgent": create_agent,
                "generateTitle": generate_thread_title,
                "cancelRun": cancel_agent_run,
                "finishRun": finish_agent_run,
                "checkpointPath": os.path.join(
                    os.path.dirname(os.path.abspath(db_path)),
                    ".refora-agent",
                    "shared",
                    "checkpoints-python.sqlite",
                ),
                "agentStateVersion": 2,
            },
        )
        app.state.repos = repos
        app.state.services = services
        app.state.event_bus = events
        app.state.connector = connector
        app.state.agent_runtime = agent_runtime
        app.state.cancel_agent_network = cancel_agent_network
        recovery_task: asyncio.Task[Any] | None = None
        if startup_active_runs:
            async def recover_active_runs() -> None:
                await events.wait_for_subscriber("connector.decrypt-api-key")
                for persisted_run in startup_active_runs:
                    run_id = persisted_run.get("id")
                    try:
                        current = repos["agentRuns"]["get"](run_id)
                        if current is None or current.get("status") not in {
                            "queued",
                            "running",
                        }:
                            continue
                        assembled = await assemble_recovery(
                            current,
                            repos=repos,
                            services=services,
                            connector=connector,
                            db_path=db_path,
                            library_folder=app.state.library_folder,
                        )
                        await agent_runtime["startRecover"](assembled)
                    except Exception as error:
                        message = f"Failed to recover agent run after sidecar restart: {error}"
                        repos["agentRuns"]["update"](
                            run_id,
                            {
                                "status": "failed",
                                "endedAt": int(time.time() * 1000),
                                "error": message,
                            },
                        )
                        for step in repos["agentTraces"]["listByRun"](run_id):
                            if step.get("status") == "running":
                                repos["agentTraces"]["updateStep"](
                                    step["id"],
                                    {
                                        "status": "error",
                                        "output": step.get("output") or message,
                                        "endedAt": int(time.time() * 1000),
                                    },
                                )
                        await events.broadcast(
                            "ai.chat.error",
                            {
                                "runId": run_id,
                                "threadId": persisted_run.get("threadId"),
                                "message": message,
                            },
                        )
                        await events.broadcast(
                            "ai.chat.run-status",
                            {
                                "runId": run_id,
                                "threadId": persisted_run.get("threadId"),
                                "status": "failed",
                            },
                        )

            recovery_task = asyncio.create_task(recover_active_runs())
        if hasattr(app.state, "require_token"):
            from refora_server.server.app import configure_app

            configure_app(app)
        try:
            yield
        finally:
            if recovery_task is not None:
                recovery_task.cancel()
                await asyncio.gather(recovery_task, return_exceptions=True)
            await agent_runtime["destroy"]()
            await metadata_service["destroy"]()
            await document_presence["destroy"]()
            stop_watcher = watcher.get("stopScanning")
            if callable(stop_watcher):
                stop_watcher()
            await ocr["stopWorker"]()
            ocr["destroy"]()
            mineru["destroy"]()
            await connector.cancel_pending()
            await events.flush()
            if owns_database:
                close_database(database)

    return lifespan
