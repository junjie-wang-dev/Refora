from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock

from fastapi import FastAPI
from pypdf import PdfWriter
import pytest

from refora_server.server.connector import ConnectorBroker
from refora_server.server.lifespan import create_lifespan
from refora_server.server.services.lifespan_support import download_mineru_file


class EventSocket:
    def __init__(self) -> None:
        self.messages = []

    async def send_json(self, message) -> None:
        self.messages.append(message)


async def test_mineru_download_uses_proxy_and_closes_client(
    tmp_path,
    monkeypatch,
) -> None:
    captured = {}

    class Response:
        headers = {"content-length": "3"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def raise_for_status(self):
            return None

        async def aiter_bytes(self, _size):
            yield b"pdf"

    class Client:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            captured["closed"] = True
            return False

        def stream(self, method, url):
            captured["request"] = (method, url)
            return Response()

    monkeypatch.setattr("httpx.AsyncClient", Client)
    destination = tmp_path / "engine.bin"

    await download_mineru_file(
        "https://example.test/engine.bin",
        str(destination),
        asyncio.Event(),
        lambda *_args: None,
        proxy="socks5://127.0.0.1:1080",
    )

    assert destination.read_bytes() == b"pdf"
    assert captured == {
        "follow_redirects": True,
        "timeout": 60.0,
        "proxy": "socks5://127.0.0.1:1080",
        "request": ("GET", "https://example.test/engine.bin"),
        "closed": True,
    }


async def test_lifespan_starts_watcher_and_processes_metadata_in_python(
    tmp_path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    source = tmp_path / "paper.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(str(source))
    app = FastAPI(
        lifespan=create_lifespan(
            str(tmp_path / "refora.sqlite"),
            str(library),
        )
    )
    socket = EventSocket()

    async with app.router.lifespan_context(app):
        await app.state.event_bus.subscribe(
            socket,
            ["import.progress"],
        )
        result = await app.state.services["importer"]["importFiles"]([str(source)])
        await asyncio.sleep(0.01)

        assert app.state.services["watcher"]["_state"]["running"] is True
        assert len(result["imported"]) == 1
        assert {message["event"] for message in socket.messages} == {
            "import.progress"
        }
        document = app.state.repos["documents"]["get"](result["imported"][0])
        for _ in range(100):
            if document["metadataStatus"] != "pending":
                break
            await asyncio.sleep(0.01)
            document = app.state.repos["documents"]["get"](
                result["imported"][0]
            )
        assert document["metadataStatus"] in {"failed", "done"}

    assert app.state.services["watcher"]["_state"]["running"] is False


async def test_import_errors_are_forwarded_as_toast_events(tmp_path) -> None:
    library = tmp_path / "library"
    library.mkdir()
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-1.4\nbroken")
    app = FastAPI(
        lifespan=create_lifespan(
            str(tmp_path / "refora.sqlite"),
            str(library),
        )
    )
    socket = EventSocket()

    async with app.router.lifespan_context(app):
        await app.state.event_bus.subscribe(socket, ["import.toast"])
        result = await app.state.services["importer"]["importFiles"]([str(source)])
        await asyncio.sleep(0.01)

        assert result["imported"] == []
        assert result["errors"]
        assert socket.messages == [
            {
                "event": "import.toast",
                "data": result["errors"][0]["message"],
            }
        ]


async def test_lifespan_initializes_and_closes_resources(monkeypatch) -> None:
    db = object()
    open_database = Mock(return_value=(db, object()))
    close_database = Mock()
    repos = {
        "documents": object(),
        "agentRuns": {"listActive": Mock(return_value=[])},
        "agentTraces": {},
    }
    create_repositories = Mock(return_value=repos)
    events = Mock(flush=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    runtime = {"destroy": AsyncMock()}

    monkeypatch.setattr("refora_server.server.lifespan.open_database", open_database)
    monkeypatch.setattr("refora_server.server.lifespan.close_database", close_database)
    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", create_repositories)
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createThreadTitleService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", Mock(return_value=runtime))

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library"))
    async with app.router.lifespan_context(app):
        assert app.state.db is db
        assert app.state.repos is repos
        assert app.state.library_folder == "/tmp/library"
        assert app.state.connector is connector
        assert app.state.event_bus is events
        assert app.state.agent_runtime is runtime

    open_database.assert_called_once_with("/tmp/refora.db")
    connector.cancel_pending.assert_awaited_once()
    events.flush.assert_awaited_once()
    runtime["destroy"].assert_awaited_once()
    close_database.assert_called_once_with(db)


async def test_lifespan_closes_runner_owned_database(monkeypatch) -> None:
    db = object()
    close_database = Mock()

    monkeypatch.setattr("refora_server.server.lifespan.close_database", close_database)
    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", Mock(return_value={}))
    events = Mock(flush=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createThreadTitleService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    runtime = {"destroy": AsyncMock()}
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", Mock(return_value=runtime))

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))
    async with app.router.lifespan_context(app):
        assert app.state.db is db

    close_database.assert_not_called()
    runtime["destroy"].assert_awaited_once()


async def test_lifespan_recovers_active_runs_after_connector_subscription(
    monkeypatch,
) -> None:
    db = object()
    active_run = {
        "id": "run-recover",
        "threadId": "thread-1",
        "providerId": "provider-1",
        "modelId": "model-1",
        "status": "running",
    }
    repos = {
        "documents": object(),
        "agentRuns": {
            "listActive": Mock(return_value=[active_run]),
            "get": Mock(return_value=active_run),
            "update": Mock(),
        },
        "agentTraces": {
            "listByRun": Mock(return_value=[]),
            "updateStep": Mock(),
        },
    }
    events = Mock(
        flush=AsyncMock(),
        broadcast=AsyncMock(),
        wait_for_subscriber=AsyncMock(),
    )
    connector = Mock(cancel_pending=AsyncMock())
    runtime = {
        "destroy": AsyncMock(),
        "startRecover": AsyncMock(),
    }
    assembled = {
        "runId": "run-recover",
        "threadId": "thread-1",
    }
    assemble = AsyncMock(return_value=assembled)

    monkeypatch.setattr(
        "refora_server.server.lifespan.create_repositories",
        Mock(return_value=repos),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_event_bus",
        Mock(return_value=events),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_connector_broker",
        Mock(return_value=connector),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createAiProvidersService",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createAiSummaryService",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createChatHistoryService",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createThreadTitleService",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createWorkspacesService",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createAgentRuntime",
        Mock(return_value=runtime),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.assemble_recovery",
        assemble,
    )

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))
    async with app.router.lifespan_context(app):
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        events.wait_for_subscriber.assert_awaited_once_with(
            "connector.decrypt-api-key"
        )
        assemble.assert_awaited_once()
        runtime["startRecover"].assert_awaited_once_with(assembled)

    runtime["destroy"].assert_awaited_once()


async def test_lifespan_wires_agent_runtime_factories(monkeypatch) -> None:
    db = object()
    repos = {
        "documents": object(),
        "settings": {"get": lambda key, default="": (
            "http://127.0.0.1:8080" if key == "proxyUrl" else default
        )},
    }
    events = Mock(flush=AsyncMock(), broadcast=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    runtime = {"destroy": AsyncMock()}
    runtime_factory = Mock(return_value=runtime)
    tool_factory = Mock(
        return_value=[
            SimpleNamespace(name="search_documents"),
            SimpleNamespace(name="prepare_paper_ocr"),
            SimpleNamespace(name="list_workspace_context"),
            SimpleNamespace(name="web_search"),
        ]
    )
    model = SimpleNamespace(
        invoke=Mock(return_value=SimpleNamespace(content="Generated title")),
        ainvoke=AsyncMock(return_value=SimpleNamespace(content="Generated title")),
    )
    model_factory = Mock(return_value=model)
    agent_factory = Mock(return_value="agent")
    destroy_summary = AsyncMock()
    summary_factory = Mock(return_value={"destroy": destroy_summary})
    title_factory = Mock(return_value={"generateThreadTitle": Mock()})
    execute_sandbox = Mock(return_value={"status": "ok"})
    install_runtime_packages = Mock(return_value={"status": "ok"})
    cancel_sandbox = Mock(return_value=True)
    sandbox_factory = Mock(
        return_value={
            "execute_sandbox": execute_sandbox,
            "install_runtime_packages": install_runtime_packages,
            "cancel": cancel_sandbox,
        }
    )
    academic_loops: list[asyncio.AbstractEventLoop] = []
    academic_started = asyncio.Event()

    async def academic_search(value, signal):
        academic_loops.append(asyncio.get_running_loop())
        if getattr(value, "query", "") == "block":
            academic_started.set()
            await signal.wait()
            raise asyncio.CancelledError()
        return {"papers": []}

    arxiv_client = SimpleNamespace(search=academic_search)
    academic_identity = SimpleNamespace()
    academic_graph = SimpleNamespace(
        get_citing_papers=AsyncMock(),
        get_referenced_papers=AsyncMock(),
        get_recommendations=AsyncMock(),
    )
    academic_frontier = SimpleNamespace()
    arxiv_papers = SimpleNamespace()

    monkeypatch.setattr("refora_server.server.lifespan.create_repositories", Mock(return_value=repos))
    monkeypatch.setattr("refora_server.server.lifespan.create_event_bus", Mock(return_value=events))
    monkeypatch.setattr("refora_server.server.lifespan.create_connector_broker", Mock(return_value=connector))
    monkeypatch.setattr("refora_server.server.lifespan.createAiProvidersService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAiSummaryService", summary_factory)
    monkeypatch.setattr("refora_server.server.lifespan.createChatHistoryService", Mock(return_value={}))
    monkeypatch.setattr(
        "refora_server.server.lifespan.createThreadTitleService",
        title_factory,
    )
    monkeypatch.setattr("refora_server.server.lifespan.createWorkspacesService", Mock(return_value={}))
    monkeypatch.setattr("refora_server.server.lifespan.createAgentRuntime", runtime_factory)
    monkeypatch.setattr("refora_server.server.lifespan.create_agent_tools", tool_factory)
    monkeypatch.setattr("refora_server.server.lifespan.createSandboxService", sandbox_factory)
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_academic_cache", Mock()
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_arxiv_client",
        Mock(return_value=arxiv_client),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_semantic_scholar_client", Mock()
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_academic_identity_service",
        Mock(return_value=academic_identity),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_academic_graph_service",
        Mock(return_value=academic_graph),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_research_frontier_service",
        Mock(return_value=academic_frontier),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_arxiv_paper_service",
        Mock(return_value=arxiv_papers),
    )
    monkeypatch.setattr("refora_server.agent.providers.ChatOpenAI", model_factory)
    monkeypatch.setattr("refora_server.agent.providers.create_deep_agent", agent_factory)

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))
    async with app.router.lifespan_context(app):
        dependencies = runtime_factory.call_args.args[1]
        request = {
            "runId": "run-1",
            "threadId": "thread-1",
            "workspaceId": None,
            "sandboxRoot": "/tmp/library/.refora/sandboxes/default",
            "enabledToolNames": [
                "search_documents",
                "list_workspace_context",
                "web_search",
            ],
            "systemPrompt": "Use the library.",
        }

        assert dependencies["createTools"](request) == [tool_factory.return_value[0]]
        tool_factory.assert_called_once()
        context = tool_factory.call_args.args[0]
        assert context.run_id == "run-1"
        assert context.thread_id == "thread-1"
        tool_dependencies = tool_factory.call_args.args[1]
        assert tool_dependencies["repos"] is repos
        assert callable(tool_dependencies["open_paper"])
        assert callable(tool_dependencies["find_related_papers"])
        assert callable(tool_dependencies["workspace_changed"])
        assert callable(tool_dependencies["preview_workspace_asset"])
        assert callable(tool_dependencies["ai_summary"])
        search_academic = tool_dependencies["academic"]["arxiv"]["search"]
        assert await asyncio.to_thread(
            search_academic, SimpleNamespace(query="first")
        ) == {"papers": []}
        assert academic_loops == [asyncio.get_running_loop()]
        blocked = asyncio.create_task(
            asyncio.to_thread(
                search_academic, SimpleNamespace(query="block")
            )
        )
        await asyncio.wait_for(academic_started.wait(), 1)
        app.state.cancel_agent_network("run-1")
        with pytest.raises(asyncio.CancelledError):
            await blocked
        assert tool_dependencies["execute_sandbox"](
            "pwd",
            {"_sandboxRoot": "/tmp/untrusted", "_runId": "run-1"},
        ) == {"status": "ok"}
        execute_sandbox.assert_called_once_with(
            "pwd",
            {
                "_sandboxRoot": "/tmp/library/.refora/sandboxes/default",
                "_runId": "run-1",
                "_workspaceId": None,
            },
        )
        assert tool_dependencies["install_runtime_packages"](
            None,
            {"_sandboxRoot": "/tmp/untrusted", "_runId": "run-1"},
        ) == {"status": "ok"}
        install_runtime_packages.assert_called_once_with(
            None,
            {
                "_sandboxRoot": "/tmp/library/.refora/sandboxes/default",
                "_runId": "run-1",
            },
        )
        assert dependencies["cancelRun"]("run-1") is True
        cancel_sandbox.assert_called_once_with("run-1")
        assert callable(dependencies["finishRun"])

        summary_dependencies = summary_factory.call_args.args[1]
        assert callable(summary_dependencies["generate_summary"])
        assert callable(summary_dependencies["emit_delta"])
        assert callable(summary_dependencies["emit_error"])
        assert callable(title_factory.call_args.args[1]["generate_title"])

        provider = {
            "model": "test-model",
            "apiKey": "test-key",
            "baseUrl": "https://example.test/v1",
            "useResponsesApi": True,
            "modelKwargs": {"reasoning_effort": "high"},
            "reasoning": {"effort": "high", "summary": "auto"},
            "temperature": 0.2,
            "maxTokens": 123,
        }
        assert await summary_dependencies["generate_summary"](
            {"provider": provider, "text": "Paper body"}
        ) == "Generated title"
        assert title_factory.call_args.args[1]["generate_title"](
            {"provider": provider, "userMessage": "Discuss the paper"}
        ) == "Generated title"
        assert dependencies["createModel"](provider) is model
        assert model_factory.call_count == 3
        for invocation in model_factory.call_args_list:
            assert invocation.kwargs["http_client"] is not None
            assert invocation.kwargs["http_async_client"] is not None
        model_factory.assert_called_with(
            model="test-model",
            api_key="test-key",
            base_url="https://example.test/v1",
            streaming=True,
            use_responses_api=True,
            model_kwargs={"reasoning_effort": "high"},
            reasoning={"effort": "high", "summary": "auto"},
            temperature=0.2,
            max_completion_tokens=123,
            http_client=ANY,
            http_async_client=ANY,
        )

        runtime_tools = [
            SimpleNamespace(name="search_documents"),
            SimpleNamespace(name="prepare_paper_ocr"),
        ]
        assert dependencies["createAgent"]("model", runtime_tools, request) == "agent"
        agent_factory.assert_called_once()
        assert agent_factory.call_args.kwargs["model"] == "model"
        assert agent_factory.call_args.kwargs["tools"] == runtime_tools
        assert agent_factory.call_args.kwargs["system_prompt"].startswith(
            "Use the library."
        )
        assert "/memories/" in agent_factory.call_args.kwargs["system_prompt"]
        assert set(agent_factory.call_args.kwargs["interrupt_on"]) == {
            "search_documents",
            "prepare_paper_ocr",
        }
        assert agent_factory.call_args.kwargs["skills"] is None
        assert {
            subagent["name"]
            for subagent in agent_factory.call_args.kwargs["subagents"]
        } == {
            "general-purpose",
            "researcher",
            "analyst",
            "data-analyst",
        }

    runtime["destroy"].assert_awaited_once()
    destroy_summary.assert_awaited_once_with()


async def test_connector_cancels_pending_requests() -> None:
    events = Mock()
    events.broadcast = AsyncMock()
    connector = ConnectorBroker(events)
    request = asyncio.create_task(connector.open_path("/tmp/example"))
    await asyncio.sleep(0)

    await connector.cancel_pending()

    assert await request == {
        "ok": False,
        "error": {"code": "connector_shutdown", "message": "Server is shutting down"},
    }


async def test_lifespan_startup_failure_cleans_created_resources_without_name_error(
    monkeypatch,
    tmp_path,
) -> None:
    db = object()
    events = Mock(flush=AsyncMock(), broadcast=AsyncMock())
    connector = Mock(cancel_pending=AsyncMock())
    destroy_mineru = Mock()
    stop_worker = AsyncMock()
    destroy_ocr = AsyncMock()
    initialize_ocr = AsyncMock()
    ocr_service = {
        "initialize": initialize_ocr,
        "stopWorker": stop_worker,
        "destroy": destroy_ocr,
    }
    worker_script = tmp_path / "mineru_worker.py"
    worker_script.write_text("")

    def failing_summary_factory(*_args, **_kwargs):
        raise RuntimeError("summary service construction failed")

    monkeypatch.setattr(
        "refora_server.server.lifespan.create_repositories",
        Mock(
            return_value={
                "documents": object(),
                "documentOcr": object(),
                "agentRuns": {"listActive": Mock(return_value=[])},
            }
        ),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_event_bus",
        Mock(return_value=events),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_connector_broker",
        Mock(return_value=connector),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_mineru_engine_manager",
        Mock(return_value={"destroy": destroy_mineru}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.mineru_worker_path",
        lambda: str(worker_script),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_mineru_worker_process",
        Mock(return_value={}),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.create_ocr_service",
        Mock(return_value=ocr_service),
    )
    monkeypatch.setattr(
        "refora_server.server.lifespan.createAiSummaryService",
        failing_summary_factory,
    )

    app = FastAPI(lifespan=create_lifespan("/tmp/refora.db", "/tmp/library", db))

    with pytest.raises(RuntimeError, match="summary service construction failed"):
        async with app.router.lifespan_context(app):
            pass

    initialize_ocr.assert_awaited_once()
    stop_worker.assert_awaited_once()
    destroy_ocr.assert_awaited_once()
    destroy_mineru.assert_called_once_with()
    connector.cancel_pending.assert_awaited_once()
    events.flush.assert_awaited_once()
