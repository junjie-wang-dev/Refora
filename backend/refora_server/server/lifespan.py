from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
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
from refora_server.agent.providers import create_agent, create_model
from refora_server.cli_runtime import CliRuntimeEngine, create_cli_runtime_registry
from refora_server.cli_runtime.tool_broker import CliToolBroker
from refora_server.db.connection import close_database, get_search_mode, open_database
from refora_server.db.settings_seed import seed_default_settings
from refora_server.library.paths import resolveFromLibrary
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.server.connector import create_connector_broker
from refora_server.server.events import create_event_bus
from refora_server.server.services.academic_runtime import create_academic_runtime
from refora_server.server.services.lifespan_support import (
    LazyAgentRuntime,
    download_mineru_file,
    mineru_worker_path,
    schedule_event,
    summary_prompt,
    trash_mineru_path,
    unavailable_agent_capability,
    unavailable_ocr_service,
)
from refora_server.services.agent_runtime import createAgentRuntime
from refora_server.services.agent_profiles import createAgentProfilesService
from refora_server.services.agent_intent import assemble_recovery
from refora_server.services.agent_tools import AgentToolContext, create_agent_tools
from refora_server.services.ai_providers import createAiProvidersService
from refora_server.services.ai_summary import createAiSummaryService
from refora_server.services.chat_history import createChatHistoryService
from refora_server.services.clipboard_temp import create_clipboard_temp_service
from refora_server.services.document_text import createDocumentTextService
from refora_server.services.document_presence import create_document_presence_service
from refora_server.services.export import createExportService
from refora_server.services.mineru import (
    MineruEngineManagerDeps,
    MineruWorkerProcessDeps,
    create_mineru_engine_manager,
    create_mineru_worker_process,
)
from refora_server.services.metadata import create_metadata_service
from refora_server.services.model_http_clients import create_model_http_client_pool
from refora_server.services.ocr import OcrServiceDeps, create_ocr_service
from refora_server.services.proxy import normalize_proxy_rules
from refora_server.services.related_papers import find_related_papers
from refora_server.services.sandbox import SandboxOptions, createSandboxService
from refora_server.services.thread_title import createThreadTitleService
from refora_server.services.watcher import createWatcherService
from refora_server.services.web_search import createWebSearchService
from refora_server.services.web_fetch import fetchUrlAsync
from refora_server.services.workspaces import createWorkspacesService
from refora_server.library.importer import createImporter


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
        events: Any | None = None
        connector: Any | None = None
        model_http_clients: dict[str, Any] | None = None
        mineru: dict[str, Any] | None = None
        ocr: dict[str, Any] | None = None
        watcher: dict[str, Any] = {}
        metadata_service: dict[str, Any] = {}
        document_presence: dict[str, Any] = {}
        summary_service: dict[str, Any] = {}
        agent_runtime: dict[str, Any] | None = None
        cli_runtime: Any | None = None
        recovery_task: asyncio.Task[Any] | None = None
        database = db
        owns_database = database is None
        try:
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
            cli_registry = create_cli_runtime_registry()
            cli_tool_broker = CliToolBroker(
                state_dir or os.path.dirname(os.path.abspath(db_path)),
                f"http://127.0.0.1:{getattr(app.state, 'port', 0)}",
                os.environ.get("REFORA_SERVER_TOKEN", ""),
            )
            runtime_sessions = repos.get("agentRuntimeSessions") or {
                "get": lambda *_args: None,
                "put": lambda *_args: None,
                "delete": lambda *_args: None,
            }
            cli_runtime = CliRuntimeEngine(
                cli_registry,
                cli_tool_broker,
                runtime_sessions,
                repos.get("agentRuns") or {},
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
            clipboard_temp = create_clipboard_temp_service()
            clipboard_temp["cleanupStale"]()
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
                sandbox_cancelled = bool(cancel_sandbox(run_id)) if callable(cancel_sandbox) else False
                cli_cancelled = cli_runtime.cancel_nowait(run_id)
                return sandbox_cancelled or cli_cancelled

            def finish_agent_run(run_id: str) -> None:
                run_cancel_events.pop(run_id, None)

            def proxy_url() -> str:
                settings_repo = repos.get("settings")
                get_setting = (
                    settings_repo.get("get")
                    if isinstance(settings_repo, dict)
                    else getattr(settings_repo, "get", None)
                )
                value = get_setting("proxyUrl", "") if callable(get_setting) else ""
                try:
                    return normalize_proxy_rules(value)
                except ValueError:
                    return ""

            model_http_clients = create_model_http_client_pool()

            def configured_model(provider: dict[str, Any]) -> Any:
                options = model_http_clients["modelOptions"](proxy_url())
                return create_model(provider, **options)

            emit = events.broadcast
            mineru = create_mineru_engine_manager(
                MineruEngineManagerDeps(
                    userDataDir=(
                        user_data_dir
                        or state_dir
                        or os.path.dirname(os.path.abspath(db_path))
                    ),
                    downloadFile=lambda url, destination, cancel_event, on_progress: (
                        download_mineru_file(
                            url,
                            destination,
                            cancel_event,
                            on_progress,
                            proxy=proxy_url() or None,
                        )
                    ),
                    trashItem=lambda path: trash_mineru_path(connector, path),
                    emitProgress=lambda progress: schedule_event(
                        events, "mineru.install-progress", progress.to_dict()
                    ),
                )
            )
            complete_repos = {"documents", "settings", "watchFolders", "categories", "webSearchConfig"}.issubset(repos)
            ocr_repos_ready = {"documents", "documentOcr"}.issubset(repos)
            importer = {}
            exporter = {}
            web_search = {}
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
                        "emitProgress": lambda data: schedule_event(
                            events, "import.progress", data, server_loop
                        ),
                    },
                )

                def enqueue_imported_metadata(result: dict[str, Any]) -> None:
                    errors = result.get("errors")
                    if isinstance(errors, list):
                        for error in errors:
                            if isinstance(error, dict) and isinstance(error.get("message"), str):
                                schedule_event(
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
                        "logger": logging.getLogger("refora.watcher"),
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
                        "decryptKeyAsync": decrypt_search_key,
                        "getProxy": proxy_url,
                    },
                )
            worker_path = mineru_worker_path()
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
                        emitProgress=lambda data: schedule_event(events, "ocr.progress", data),
                        emitCompleted=lambda data: schedule_event(events, "ocr.completed", data),
                        emitError=lambda data: schedule_event(events, "ocr.error", data),
                    ),
                )
                await ocr["initialize"]()
            elif not ocr_repos_ready:
                ocr = unavailable_ocr_service("OCR repositories are not available")
            else:
                ocr = unavailable_ocr_service("MinerU worker script is missing")

            document_text = createDocumentTextService(repos)

            async def generate_summary(payload: dict[str, Any]) -> Any:
                provider = payload.get("provider")
                if not isinstance(provider, dict):
                    raise RuntimeError("AI summary provider is unavailable")
                prompt = summary_prompt(payload.get("text"), payload.get("combined"))
                response = await configured_model(provider).ainvoke(
                    [{"role": "user", "content": prompt}]
                )
                return getattr(response, "content", response)

            summary_service = createAiSummaryService(
                repos,
                {
                    "generate_summary": generate_summary,
                    "load_text": document_text["getOrExtract"],
                    "emit_delta": lambda document_id, _summary_id: schedule_event(
                        events, "ai.summary.updated", document_id, server_loop
                    ),
                    "emit_error": lambda document_id, message: schedule_event(
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
                response = configured_model(provider).invoke(
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

            academic_runtime = create_academic_runtime(
                repos,
                app.state.library_folder,
                proxy_url,
                {
                    "cache": create_academic_cache,
                    "arxiv": create_arxiv_client,
                    "semantic_scholar": create_semantic_scholar_client,
                    "identity": create_academic_identity_service,
                    "graph": create_academic_graph_service,
                    "frontier": create_research_frontier_service,
                    "arxiv_papers": create_arxiv_paper_service,
                },
            )
            academic = academic_runtime["services"]
            arxiv_client = academic_runtime.get("arxiv")
            arxiv_papers = academic_runtime.get("arxiv_papers")
            academic_identity = academic_runtime.get("identity")
            academic_graph = academic_runtime.get("graph")
            academic_frontier = academic_runtime.get("frontier")
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
                    workspace_items_repo=repos.get("workspaceItems"),
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
            set_library_health_check = watcher.get("setLibraryHealthCheck")
            if callable(set_library_health_check):
                set_library_health_check(document_presence.get("checkNow"))
            start_watcher = watcher.get("startScanning")
            if callable(start_watcher):
                start_watcher()
            services = {
                "repos": repos,
                "importer": importer,
                "watcher": watcher,
                "export": exporter,
                "webSearch": web_search,
                "mineru": mineru,
                "ocr": ocr,
                "aiProviders": createAiProvidersService(
                    repos,
                    {"get_proxy": proxy_url},
                ),
                "getProxy": proxy_url,
                "agentProfiles": (
                    createAgentProfilesService(repos, {"cliRuntime": cli_runtime})
                    if "agentProfiles" in repos
                    else {}
                ),
                "cliRuntime": cli_runtime,
                "cliToolBroker": cli_tool_broker,
                "clipboardTemp": clipboard_temp,
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
                        "agentRuntime": LazyAgentRuntime(app),
                        "academic": academic,
                        "importer": importer,
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
                        return unavailable_agent_capability()
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
                        "message": "Balanced OCR cache is ready. Continue with read_paper using source=ocr.",
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
                    schedule_event(
                        events,
                        "workspace.items.changed",
                        {"workspaceId": workspace_id, "reason": reason},
                        server_loop,
                    )

                def report_created(report: dict[str, Any]) -> None:
                    schedule_event(
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
                        return unavailable_agent_capability()
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
                        return unavailable_agent_capability()
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
                    else unavailable_agent_capability,
                    "web_fetch": lambda value: run_on_server_loop(
                        fetchUrlAsync(
                            value,
                            cancelEvent=cancel_event,
                            proxy=proxy_url() or None,
                        ),
                        cancel_event,
                    ),
                    "execute_sandbox": execute_sandbox,
                    "preview_workspace_asset": lambda workspace_id, asset_id: services[
                        "workspaces"
                    ]["previewAsset"](workspace_id, asset_id),
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
                        "read_workspace_item",
                        "add_docs_to_workspace",
                        "create_workspace_connections",
                        "generate_report",
                        "explore_research_frontier",
                    }
                profile = request.get("agentProfile")
                if isinstance(profile, dict) and profile.get("kind") == "cli":
                    enabled.discard("__execute")
                if not web_search.get("isEnabled", lambda: False)():
                    enabled -= {"web_search", "web_fetch"}
                if "install_runtime_packages" not in sandbox:
                    enabled.discard("install_runtime_packages")
                return [tool for tool in tools if tool.name in enabled]

            async def generate_thread_title(
                thread_id: str,
                provider: dict[str, Any],
            ) -> str | None:
                if provider.get("backendType") == "cli":
                    return None
                return await asyncio.to_thread(
                    services["threadTitle"]["generateThreadTitle"],
                    thread_id,
                    provider,
                )

            def create_runtime_model(provider: dict[str, Any]) -> Any:
                if provider.get("backendType") == "cli":
                    return None
                return configured_model(provider)

            def create_runtime_agent(
                model: Any, tools: list[Any], request: dict[str, Any]
            ) -> Any:
                provider = request.get("provider")
                if isinstance(provider, dict) and provider.get("backendType") == "cli":
                    return cli_runtime.create_agent(tools, request)
                return create_agent(model, tools, request)

            agent_runtime = createAgentRuntime(
                repos,
                {
                    "emit": events.broadcast,
                    "connector": connector,
                    "createTools": create_tools,
                    "createModel": create_runtime_model,
                    "createAgent": create_runtime_agent,
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
            yield
        finally:
            if recovery_task is not None:
                recovery_task.cancel()
                await asyncio.gather(recovery_task, return_exceptions=True)
            destroy_summary = summary_service.get("destroy")
            if callable(destroy_summary):
                await destroy_summary()
            if agent_runtime is not None:
                await agent_runtime["destroy"]()
            if cli_runtime is not None:
                await cli_runtime.destroy()
            if model_http_clients is not None:
                await model_http_clients["destroy"]()
            destroy_metadata = metadata_service.get("destroy")
            if callable(destroy_metadata):
                await destroy_metadata()
            destroy_presence = document_presence.get("destroy")
            if callable(destroy_presence):
                await destroy_presence()
            stop_watcher = watcher.get("stopScanning")
            if callable(stop_watcher):
                stop_watcher()
            if ocr is not None:
                await ocr["stopWorker"]()
                await ocr["destroy"]()
            if mineru is not None:
                mineru["destroy"]()
            if connector is not None:
                await connector.cancel_pending()
            if events is not None:
                await events.flush()
            if owns_database and database is not None:
                close_database(database)

    return lifespan
