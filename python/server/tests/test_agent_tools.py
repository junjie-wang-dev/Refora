from __future__ import annotations

import json
from typing import Any, Optional

from refora_server.academic.types import (
    AcademicGraphCandidate,
    AcademicGraphCoverage,
    AcademicGraphPage,
    ArxivPaperResult,
    ArxivPaperSection,
    ArxivSearchInput,
    ArxivSearchResult,
    FrontierCoverageSet,
    FrontierGroups,
    FrontierNextAction,
    FrontierView,
    PaperIdentity,
    PaperLocator,
    SemanticRecommendationResult,
)
from refora_server.agent.tools.academic import AcademicTools
from refora_server.agent.tools.registry import collect_registry
from langchain_core.runnables.config import RunnableConfig

from conftest import (
    insert_doc,
    insert_run,
    insert_thread,
    make_workspaces_repo,
    open_migrated_db,
)
from refora_server.repositories import create_repositories
from refora_server.agent.tools.web import WebTools, register as register_web
from refora_server.agent.tools.ocr_memory import register as register_ocr
from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor, create_agent_tools


class Functions(dict):
    def __getattr__(self, name):
        return self[name]


_SEED = PaperIdentity(canonicalId="s2:seed", title="Seed", authors=[], matchStatus="exact", evidence=[])


class _AcademicDeps:
    def __init__(self) -> None:
        self.arxiv_search: list[ArxivSearchInput] = []
        self.recommendation_locators: list[PaperLocator] = []
        self.citing_locators: list[PaperLocator] = []
        self.referenced_locators: list[PaperLocator] = []
        self.identity_locators: list[PaperLocator] = []
        self.frontier_calls: list[tuple[str, dict[str, Any]]] = []

    @property
    def academic(self) -> Any:
        return self

    async def search(self, inp: ArxivSearchInput, signal: Optional[Any] = None) -> ArxivSearchResult:
        self.arxiv_search.append(inp)
        return ArxivSearchResult(papers=[], total=0, fetchedAt="2026-01-01T00:00:00.000Z", cached=False)

    @property
    def arxiv(self) -> Any:
        return self

    async def get_paper(self, arxiv_id: str, section_id: Optional[str] = None, cursor: Optional[str] = None, max_chars: Optional[int] = None) -> ArxivPaperResult:
        return ArxivPaperResult(
            arxivId=arxiv_id,
            sourceUrl=f"https://arxiv.org/abs/{arxiv_id}",
            sourceFormat="arxiv-html",
            outputFormat="markdown",
            sections=[ArxivPaperSection(id="s1", title="Intro", level=1, start=0, end=5)],
            cursor=0,
            maxChars=max_chars or 8000,
            totalChars=5,
            contentMd="hello",
            conversionWarnings=[],
            cached=False,
        )

    @property
    def arxiv_papers(self) -> Any:
        return self

    @property
    def identity(self) -> Any:
        return self

    async def resolve(self, locator: PaperLocator, signal: Optional[Any] = None) -> PaperIdentity:
        self.identity_locators.append(locator)
        return _SEED

    @property
    def graph(self) -> Any:
        return self

    async def get_citing_papers(self, locator: PaperLocator, cursor: Optional[str] = None, limit: Optional[int] = None, signal: Optional[Any] = None, filters: Optional[dict[str, Any]] = None) -> AcademicGraphPage:
        self.citing_locators.append(locator)
        return AcademicGraphPage(seed=_SEED, direction="incoming", items=[], coverage=AcademicGraphCoverage(scanned=0, total=0, complete=True), fetchedAt="2026-01-01T00:00:00.000Z", cached=False)

    async def get_referenced_papers(self, locator: PaperLocator, cursor: Optional[str] = None, limit: Optional[int] = None, signal: Optional[Any] = None, filters: Optional[dict[str, Any]] = None) -> AcademicGraphPage:
        self.referenced_locators.append(locator)
        return AcademicGraphPage(seed=_SEED, direction="outgoing", items=[AcademicGraphCandidate(paper=_SEED)], coverage=AcademicGraphCoverage(scanned=1, total=1, complete=True), fetchedAt="2026-01-01T00:00:00.000Z", cached=False)

    async def get_recommendations(self, locator: PaperLocator, limit: Optional[int] = None, signal: Optional[Any] = None) -> SemanticRecommendationResult:
        self.recommendation_locators.append(locator)
        return SemanticRecommendationResult(seed=_SEED, items=[], fetchedAt="2026-01-01T00:00:00.000Z", cached=False)

    @property
    def frontier(self) -> Any:
        async def start(args: dict[str, Any]) -> FrontierView:
            self.frontier_calls.append(("start", args))
            return FrontierView(frontierId="f-1", round=0, seed=_SEED, expandedFrom=[], groups=FrontierGroups(), coverage=FrontierCoverageSet(), nextActions=[FrontierNextAction(type="expand", description="d")], warnings=[], fetchedAt="2026-01-01T00:00:00.000Z")

        async def expand(args: dict[str, Any]) -> FrontierView:
            self.frontier_calls.append(("expand", args))
            return FrontierView(frontierId="f-1", round=1, seed=_SEED, expandedFrom=["s2:seed"], groups=FrontierGroups(), coverage=FrontierCoverageSet(), nextActions=[FrontierNextAction(type="continue", description="d")], warnings=[], fetchedAt="2026-01-01T00:00:00.000Z")

        async def continue_(args: dict[str, Any]) -> FrontierView:
            self.frontier_calls.append(("continue", args))
            return FrontierView(frontierId="f-1", round=2, seed=_SEED, expandedFrom=["s2:seed"], groups=FrontierGroups(), coverage=FrontierCoverageSet(), nextActions=[], warnings=[], fetchedAt="2026-01-01T00:00:00.000Z")

        frontier = Functions()
        frontier["start"] = start
        frontier["expand"] = expand
        frontier["continue"] = continue_
        return frontier


def _academic_executor() -> tuple[AgentToolExecutor, _AcademicDeps]:
    deps = _AcademicDeps()
    return AgentToolExecutor(AgentToolContext(run_id="run"), {"repos": {}, "academic": deps}), deps


def test_academic_tools_registered_in_group_registry():
    registry = collect_registry(AcademicTools)
    assert set(AcademicTools.handlers) <= set(registry)
    for name in AcademicTools.handlers:
        handler, schema, description = registry[name]
        assert handler is AcademicTools.handlers[name]
        assert schema["type"] == "object"
        assert description


def test_tool_factory_covers_read_web_academic_workspace_memory_and_todo_tools():
    tools = create_agent_tools(AgentToolContext(run_id="run"), {})
    names = {tool.name for tool in tools}

    assert {"search_library", "read_paper_fulltext", "web_search", "web_fetch", "search_arxiv", "get_semantic_recommendations", "list_workspace_context", "list_workspace_assets", "list_workspace_notes", "generate_report", "propose_workspace_memory_update", "write_todos"} <= names


def test_library_tools_registered_with_document_and_summary_schemas():
    tools = {tool.name: tool for tool in create_agent_tools(AgentToolContext(run_id="run"), {})}

    assert set({"search_library", "get_paper_metadata", "read_paper_fulltext", "read_paper_ocr_fulltext", "get_paper_summary", "request_summary", "open_paper", "find_related_papers"}) <= set(tools)

    search = tools["search_library"].args_schema
    assert search["required"] == ["query"]
    assert search["additionalProperties"] is False
    assert search["properties"]["query"] == {"type": "string"}

    fulltext = tools["read_paper_fulltext"].args_schema
    assert fulltext["required"] == ["docId"]
    assert fulltext["properties"]["offset"] == {"type": "integer", "minimum": 0, "default": 0}
    assert fulltext["properties"]["limit"] == {"type": "integer", "minimum": 500, "maximum": 12000, "default": 8000}

    related = tools["find_related_papers"].args_schema
    assert related["required"] == ["docId"]
    assert related["properties"]["limit"] == {"type": "integer", "minimum": 1, "maximum": 20, "default": 8}


def _library_executor(repos, deps_extra=None):
    deps = {"repos": repos}
    if deps_extra:
        deps.update(deps_extra)
    return AgentToolExecutor(AgentToolContext(run_id="run"), deps)


def test_search_library_queries_documents_repository_and_maps_doc_fields():
    docs = Functions(search=lambda query, limit: [{"id": "d1", "title": "Quantum", "authors": ["A"], "year": 2021}, {"id": "d2", "fileName": "notes.pdf"}])
    executor = _library_executor({"documents": docs})

    result = json.loads(executor.execute("search_library", {"query": "quantum"}))

    assert result == [{"docId": "d1", "title": "Quantum", "authors": ["A"], "year": 2021}, {"docId": "d2", "title": "notes.pdf", "authors": None, "year": None}]
    docs["search"].called_with = None
    assert docs["search"]("quantum", 20) is not None


def test_search_library_caps_results_at_twenty():
    docs = Functions(search=lambda query, limit: [{"id": f"d{i}"} for i in range(limit)])
    executor = _library_executor({"documents": docs})

    result = json.loads(executor.execute("search_library", {"query": "x"}))

    assert len(result) == 20


def test_get_paper_metadata_returns_document_or_not_found():
    docs = Functions(get=lambda doc_id: {"id": doc_id, "title": "T"} if doc_id == "d1" else None)
    executor = _library_executor({"documents": docs})

    assert json.loads(executor.execute("get_paper_metadata", {"docId": "d1"}))["id"] == "d1"
    assert json.loads(executor.execute("get_paper_metadata", {"docId": "missing"})) == {"error": "Document not found."}


def test_read_paper_fulltext_paginates_extracted_text():
    docs = Functions(get=lambda doc_id: {"id": doc_id, "title": "Paper"})
    summaries = Functions(getFullText=lambda doc_id: {"text": "a" * 100})
    executor = _library_executor({"documents": docs, "aiSummaries": summaries})

    first = json.loads(executor.execute("read_paper_fulltext", {"docId": "d1", "limit": 50}))
    assert first["offset"] == 0
    assert first["limit"] == 500
    assert first["totalChars"] == 100
    assert first["nextOffset"] is None
    assert first["text"] == "a" * 100

    large = Functions(getFullText=lambda doc_id: {"text": "b" * 2000})
    executor = _library_executor({"documents": docs, "aiSummaries": large})
    page = json.loads(executor.execute("read_paper_fulltext", {"docId": "d1", "offset": 0, "limit": 100}))
    assert page["limit"] == 500
    assert page["nextOffset"] == 500
    assert page["text"] == "b" * 500


def test_read_paper_fulltext_returns_error_when_document_missing():
    docs = Functions(get=lambda doc_id: None)
    executor = _library_executor({"documents": docs, "aiSummaries": Functions()})

    result = json.loads(executor.execute("read_paper_fulltext", {"docId": "ghost"}))

    assert result == {"error": "Document not found."}


def test_read_paper_ocr_fulltext_uses_ocr_dependency():
    docs = Functions(get=lambda doc_id: {"id": doc_id, "fileName": "f.pdf"})
    executor = _library_executor({"documents": docs}, {"read_ocr_fulltext": lambda doc_id: "OCR" * 100})

    result = json.loads(executor.execute("read_paper_ocr_fulltext", {"docId": "d1", "limit": 50}))

    assert result["title"] == "f.pdf"
    assert result["text"] == ("OCR" * 100)[:500]
    assert result["limit"] == 500


def test_read_paper_ocr_fulltext_reports_missing_document():
    docs = Functions(get=lambda doc_id: None)
    executor = _library_executor({"documents": docs}, {"read_ocr_fulltext": lambda doc_id: "x"})

    assert json.loads(executor.execute("read_paper_ocr_fulltext", {"docId": "ghost"})) == {"error": "Document not found."}


def test_get_paper_summary_returns_content_or_unavailable_notice():
    summaries = Functions(getSummary=lambda doc_id: {"content": "the summary"} if doc_id == "d1" else ({"content": None} if doc_id == "d2" else None))
    executor = _library_executor({"aiSummaries": summaries})

    assert json.loads(executor.execute("get_paper_summary", {"docId": "d1"})) == "the summary"
    assert json.loads(executor.execute("get_paper_summary", {"docId": "d2"})) == {"error": "No summary is available."}
    assert json.loads(executor.execute("get_paper_summary", {"docId": "d3"})) == {"error": "No summary is available."}


def test_request_summary_queues_when_service_available_and_reports_unavailable_otherwise():
    queued = []

    def queue(doc_id):
        queued.append(doc_id)

    executor = _library_executor({}, {"ai_summary": queue})
    assert json.loads(executor.execute("request_summary", {"docId": "d1"})) == {"status": "queued", "docId": "d1"}
    assert queued == ["d1"]

    executor = _library_executor({}, {"ai_summary": None})
    assert json.loads(executor.execute("request_summary", {"docId": "d1"})) == {"status": "unavailable", "docId": "d1"}


def test_open_paper_delegates_to_dependency():
    opened = []
    executor = _library_executor({}, {"open_paper": lambda doc_id: opened.append(doc_id) or {"docId": doc_id, "opened": True}})

    result = json.loads(executor.execute("open_paper", {"docId": "d1"}))

    assert result == {"docId": "d1", "opened": True}
    assert opened == ["d1"]


def test_find_related_papers_passes_doc_id_and_default_limit():
    calls = []

    def find(doc_id, limit):
        calls.append((doc_id, limit))
        return [{"docId": "r1"}]

    executor = _library_executor({}, {"find_related_papers": find})

    result = json.loads(executor.execute("find_related_papers", {"docId": "d1"}))

    assert result == [{"docId": "r1"}]
    assert calls == [("d1", 8)]

    executor.execute("find_related_papers", {"docId": "d2", "limit": 5})
    assert calls[-1] == ("d2", 5)


def test_library_tools_route_through_repos_helper_not_direct_attribute_access():
    docs = {"search": lambda q, limit: [{"id": "d1"}], "get": lambda doc_id: {"id": doc_id}}
    repos = {"documents": docs, "aiSummaries": {"getSummary": lambda doc_id: {"content": "s"}}}
    executor = _library_executor(repos)

    assert json.loads(executor.execute("search_library", {"query": "x"})) == [{"docId": "d1", "title": None, "authors": None, "year": None}]
    assert json.loads(executor.execute("get_paper_metadata", {"docId": "d1"}))["id"] == "d1"
    assert json.loads(executor.execute("get_paper_summary", {"docId": "d1"})) == "s"





def test_web_group_registers_handlers_and_delegates_to_dependencies():
    calls = []
    deps = {
        "web_search": lambda args: calls.append(("web_search", args)) or [{"url": "https://example.com", "title": "Example"}],
        "web_fetch": lambda args: calls.append(("web_fetch", args)) or {"url": args["url"], "content": "Example content"},
    }
    context = AgentToolContext(run_id="run")

    assert register_web(context, deps) is WebTools
    assert set(WebTools.handlers) == {"web_search", "web_fetch"}

    executor = AgentToolExecutor(context, deps)
    search = json.loads(executor.execute("web_search", {"query": "example"}))
    fetched = json.loads(executor.execute("web_fetch", {"url": "https://example.com", "maxChars": 20000}))

    assert search == [{"url": "https://example.com", "title": "Example"}]
    assert fetched == {"url": "https://example.com", "content": "Example content"}
    assert calls == [
        ("web_search", {"query": "example"}),
        ("web_fetch", {"url": "https://example.com", "maxChars": 20000}),
    ]





def test_write_tool_uses_effects_and_replays_finished_result():
    calls = []
    state = {"effect": None}

    def get(run_id, tool_call_id):
        return state["effect"]

    def begin(value):
        calls.append(("begin", value))
        state["effect"] = {"status": "running"}
        return state["effect"]

    def finish(run_id, tool_call_id, status, result):
        calls.append(("finish", status))
        state["effect"] = {"status": status, "result": result}
        return state["effect"]

    items = Functions(list=lambda workspace_id: [], add=lambda workspace_id, kind, ids: [{"docId": doc_id} for doc_id in ids])
    docs = Functions(get=lambda doc_id: {"id": doc_id})
    repos = {"documents": docs, "workspaceItems": items, "agentToolEffects": Functions(get=get, begin=begin, finish=finish)}
    executor = AgentToolExecutor(AgentToolContext(run_id="run", workspace_id="workspace"), {"repos": repos})

    result = executor.execute("add_docs_to_workspace", {"docIds": "doc-1"}, "call-1")
    replay = executor.execute("add_docs_to_workspace", {"docIds": "doc-1"}, "call-1")

    assert json.loads(result)["added"] == ["doc-1"]
    assert replay == result
    assert [call[0] for call in calls] == ["begin", "finish"]


def test_approval_sensitive_memory_tool_interrupts_before_writing():
    interrupted = []
    writes = []
    executor = AgentToolExecutor(
        AgentToolContext(run_id="run"),
        {
            "repos": {
                "agentMemories": {
                    "list": lambda scope, scope_id: [],
                    "upsert": lambda entry: writes.append(entry) or entry,
                },
            },
            "interrupt": lambda name, args: interrupted.append((name, args)) or {"status": "interrupted"},
        },
    )

    result = json.loads(executor.execute("propose_workspace_memory_update", {"path": "/brief.md", "content": "x", "rationale": "stable"}, "call"))

    assert result == {"status": "interrupted"}
    assert interrupted[0][0] == "propose_workspace_memory_update"
    assert writes == []



def test_ocr_memory_registers_its_tools():
    tools = register_ocr(None, None)

    assert set(tools) == {"prepare_paper_ocr", "propose_workspace_memory_update"}


def test_search_arxiv_dispatches_to_academic_arxiv_search():
    executor, deps = _academic_executor()

    result = json.loads(executor.execute("search_arxiv", {"query": "graph neural networks"}))

    assert result["total"] == 0
    assert result["papers"] == []
    assert len(deps.arxiv_search) == 1
    assert deps.arxiv_search[0].query == "graph neural networks"


def test_get_arxiv_paper_returns_markdown_chunk_structure():
    executor, _deps = _academic_executor()

    result = json.loads(executor.execute("get_arxiv_paper", {"arxivId": "2401.00001"}))

    assert result["arxivId"] == "2401.00001"
    assert result["outputFormat"] == "markdown"
    assert result["contentMd"] == "hello"
    assert result["sections"][0]["title"] == "Intro"


def test_resolve_academic_identity_passes_paper_locator():
    executor, deps = _academic_executor()

    result = json.loads(executor.execute("resolve_academic_identity", {"paper": {"type": "arxiv_id", "value": "2401.00001"}}))

    assert result["canonicalId"] == _SEED.canonicalId
    assert len(deps.identity_locators) == 1
    assert deps.identity_locators[0] == PaperLocator(type="arxiv_id", value="2401.00001")


def test_get_citing_papers_returns_incoming_page():
    executor, deps = _academic_executor()

    result = json.loads(executor.execute("get_citing_papers", {"paper": {"type": "arxiv_id", "value": "2401.00001"}}))

    assert result["direction"] == "incoming"
    assert result["items"] == []
    assert len(deps.citing_locators) == 1


def test_get_referenced_papers_returns_outgoing_page_with_candidates():
    executor, deps = _academic_executor()

    result = json.loads(executor.execute("get_referenced_papers", {"paper": {"type": "arxiv_id", "value": "2401.00001"}}))

    assert result["direction"] == "outgoing"
    assert len(result["items"]) == 1
    assert result["items"][0]["paper"]["canonicalId"] == _SEED.canonicalId
    assert len(deps.referenced_locators) == 1


def test_get_semantic_recommendations_returns_seed_and_items():
    executor, deps = _academic_executor()

    result = json.loads(executor.execute("get_semantic_recommendations", {"paper": {"type": "arxiv_id", "value": "2401.00001"}}))

    assert result["seed"]["canonicalId"] == _SEED.canonicalId
    assert result["items"] == []
    assert len(deps.recommendation_locators) == 1
    assert deps.recommendation_locators[0].value == "2401.00001"


def test_explore_research_frontier_routes_start_expand_continue_actions():
    executor, deps = _academic_executor()
    seed = {"type": "arxiv_id", "value": "2401.00001"}

    start = json.loads(executor.execute("explore_research_frontier", {"action": "start", "seed": seed, "objective": "survey"}))
    assert start["frontierId"] == "f-1"
    assert start["nextActions"][0]["type"] == "expand"

    expand = json.loads(executor.execute("explore_research_frontier", {"action": "expand", "frontierId": "f-1", "paperIds": ["s2:seed"]}))
    assert expand["round"] == 1
    assert expand["expandedFrom"] == ["s2:seed"]

    cont = json.loads(executor.execute("explore_research_frontier", {"action": "continue", "frontierId": "f-1", "resumeToken": "token"}))
    assert cont["round"] == 2
    assert cont["nextActions"] == []

    assert [call[0] for call in deps.frontier_calls] == ["start", "expand", "continue"]


def test_tool_invoke_persists_tool_effect_from_tool_call_id():
    db = open_migrated_db()
    try:
        insert_thread(db)
        insert_doc(db, id="doc-1")
        insert_run(db, id="run-1", threadId="thread-1", status="running")
        ws = make_workspaces_repo(db)["create"]("Research")
        repos = create_repositories(db)
        tools = create_agent_tools(AgentToolContext(run_id="run-1", workspace_id=ws["id"]), {"repos": repos})
        tool = next(t for t in tools if t.name == "add_docs_to_workspace")

        call = {
            "type": "tool_call",
            "name": "add_docs_to_workspace",
            "id": "call-xyz",
            "args": {"docIds": "doc-1"},
        }
        config: RunnableConfig = {}
        result = tool.invoke(call, config)

        assert json.loads(result.content)["added"] == ["doc-1"]
        effect = repos["agentToolEffects"]["get"]("run-1", "call-xyz")
        assert effect is not None
        assert effect["status"] == "done"
        assert json.loads(effect["result"])["added"] == ["doc-1"]
    finally:
        db.close()


def test_tool_invoke_replays_persisted_effect_on_same_tool_call_id():
    db = open_migrated_db()
    try:
        insert_thread(db)
        insert_doc(db, id="doc-1")
        insert_run(db, id="run-1", threadId="thread-1", status="running")
        ws = make_workspaces_repo(db)["create"]("Research")
        repos = create_repositories(db)
        items_repo = repos["workspaceItems"]
        tools = create_agent_tools(AgentToolContext(run_id="run-1", workspace_id=ws["id"]), {"repos": repos})
        tool = next(t for t in tools if t.name == "add_docs_to_workspace")

        call = {
            "type": "tool_call",
            "name": "add_docs_to_workspace",
            "id": "call-xyz",
            "args": {"docIds": "doc-1"},
        }
        config: RunnableConfig = {}
        first = tool.invoke(call, config)
        first_effect = repos["agentToolEffects"]["get"]("run-1", "call-xyz")
        added_before = items_repo["list"](ws["id"])

        replay = tool.invoke(call, config)
        replay_effect = repos["agentToolEffects"]["get"]("run-1", "call-xyz")

        assert replay.content == first.content
        assert replay_effect == first_effect
        assert items_repo["list"](ws["id"]) == added_before
    finally:
        db.close()


def test_tool_invoke_without_tool_call_id_skips_effect_recording():
    db = open_migrated_db()
    try:
        insert_thread(db)
        insert_doc(db, id="doc-1")
        insert_run(db, id="run-1", threadId="thread-1", status="running")
        ws = make_workspaces_repo(db)["create"]("Research")
        repos = create_repositories(db)
        tools = create_agent_tools(AgentToolContext(run_id="run-1", workspace_id=ws["id"]), {"repos": repos})
        tool = next(t for t in tools if t.name == "add_docs_to_workspace")

        result = tool.invoke({"docIds": "doc-1"}, {})
        content = result.content if hasattr(result, "content") else result

        assert json.loads(content)["added"] == ["doc-1"]
        rows = db.execute("SELECT COUNT(*) FROM agent_tool_effects WHERE runId = ?", ["run-1"]).fetchone()
        assert rows[0] == 0
    finally:
        db.close()

