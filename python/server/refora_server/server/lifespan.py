from __future__ import annotations

import asyncio
import os
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
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.server.connector import create_connector_broker
from refora_server.server.events import create_event_bus
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.ai_summary import createAiSummaryService
from refora_server.services.academic_serializer import (
    serialize_arxiv_search_response,
    serialize_paper_fulltext_response,
    serialize_semantic_recommendations_response,
)
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
from refora_server.services.sandbox import createSandboxService
from refora_server.services.thread_title import createThreadTitleService
from refora_server.services.watcher import createWatcherService
from refora_server.services.web_search import createWebSearchService
from refora_server.services.web_fetch import fetchUrl
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


def _unavailable_agent_capability(*_args: Any, **_kwargs: Any) -> dict[str, str]:
    return {
        "status": "unavailable",
        "code": "agent_capability_unavailable",
        "message": "Agent capability is unavailable",
    }


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

        def generate_summary(payload: dict[str, Any]) -> Any:
            provider = payload.get("provider")
            if not isinstance(provider, dict):
                raise RuntimeError("AI summary provider is unavailable")
            text = payload.get("text")
            combined = payload.get("combined")
            if isinstance(text, str):
                prompt = (
                    "Summarize the following paper excerpt for a literature manager. "
                    "Preserve concrete findings, methods, and limitations.\n\n"
                    f"{text}"
                )
            elif isinstance(combined, str):
                prompt = (
                    "Combine the following excerpt summaries into JSON with exactly the keys "
                    "core (string) and keyPoints (array of strings).\n\n"
                    f"{combined}"
                )
            else:
                raise RuntimeError("AI summary input is unavailable")
            response = create_model(provider).invoke(
                [{"role": "user", "content": prompt}]
            )
            return getattr(response, "content", response)

        summary_service = createAiSummaryService(
            repos, {"generate_summary": generate_summary}
        )

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
            ) as client:
                response = await client.get(url, headers=request_headers)
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
                "arxiv": {"search": search_arxiv},
                "arxiv_papers": {"get_paper": get_arxiv_paper},
                "identity": academic_identity,
                "graph": {
                    "get_citing_papers": academic_graph.get_citing_papers,
                    "get_referenced_papers": academic_graph.get_referenced_papers,
                    "get_recommendations": get_semantic_recommendations,
                },
                "frontier": academic_frontier,
            }
        sandbox = createSandboxService()
        services = {
            "library": library,
            "importer": importer,
            "watcher": watcher,
            "export": exporter,
            "webSearch": web_search,
            "mineru": mineru,
            "ocr": ocr,
            "aiProviders": createAiProvidersService(repos),
            "aiSummary": summary_service,
            "academic": academic,
            "sandbox": sandbox,
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

            async def request_summary(document_id: str) -> Any:
                provider = request.get("provider")
                if not isinstance(provider, dict):
                    return _unavailable_agent_capability()
                return await summary_service["summarize"](document_id, provider)

            async def read_ocr_fulltext(document_id: str) -> str:
                document = repos["documents"]["get"](document_id)
                if document is None:
                    raise RuntimeError(f"Document not found: {document_id}")
                result = repos["documentOcr"]["getResult"](
                    document_id, document.get("fileHash")
                )
                if result is None or result.get("stale"):
                    return ""
                return await ocr["readMarkdown"](document_id, result["resultKey"])

            async def prepare_paper_ocr(document_id: str) -> dict[str, Any]:
                job_id = await ocr["startOcr"](document_id, "balanced")
                return {"status": "queued", "jobId": job_id, "documentId": document_id}

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
                return {"published": published, "errors": [*errors, *imported["errors"]]}

            install_runtime_packages = sandbox.get(
                "install_runtime_packages", _unavailable_agent_capability
            )
            tool_deps = {
                "repos": repos,
                "interrupt": lambda *_args: None,
                "ai_summary": request_summary,
                "read_ocr_fulltext": read_ocr_fulltext,
                "publish_artifacts": publish_artifacts,
                "install_runtime_packages": install_runtime_packages,
                "prepare_paper_ocr": prepare_paper_ocr,
                "web_search": web_search.get("search", _unavailable_agent_capability),
                "web_fetch": fetchUrl,
                "execute_sandbox": sandbox["execute_sandbox"],
                "academic": academic,
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
                "createModel": create_model,
                "createAgent": create_agent,
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
