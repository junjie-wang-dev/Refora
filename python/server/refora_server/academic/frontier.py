from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol

from refora_server.academic.arxiv import ArxivClient
from refora_server.academic.graph import AcademicGraphService
from refora_server.academic.identity import AcademicIdentityService
from refora_server.academic.types import (
    AcademicGraphCandidate,
    ArxivSearchPaper,
    CitationEvidence,
    FrontierBranch,
    FrontierCandidateView,
    FrontierCoverage,
    FrontierCoverageSet,
    FrontierGroups,
    FrontierNextAction,
    FrontierView,
    PaperIdentity,
    PaperLocator,
)

SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
MAX_SESSIONS = 20
MAX_NODES = 50
MAX_EXPANSIONS = 2
BRANCH_LIMIT = 15
MAX_SESSION_BYTES = 20 * 1024 * 1024
MAX_PERSISTED_SESSIONS = 200
MAX_PERSISTED_BYTES = 512 * 1024 * 1024

DEFAULT_BRANCHES: tuple[FrontierBranch, ...] = ("citations", "recommendations", "arxiv_recent")
SESSION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
TEMP_SESSION_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$",
    re.IGNORECASE,
)


def _now_ms() -> float:
    return time.time() * 1000.0


def _iso_now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class FrontierNode:
    paper: PaperIdentity
    discoveredBy: list[str]
    graphDistance: int
    citationContexts: list[str] = field(default_factory=list)
    citationIntents: list[str] = field(default_factory=list)
    isInfluential: bool = False


@dataclass
class MergeResult:
    node: Optional[FrontierNode]
    inserted: bool
    limitReached: bool


@dataclass
class ResumeRequest:
    type: FrontierBranch
    cursor: str
    locator: Optional[PaperLocator] = None
    query: Optional[str] = None


@dataclass
class FrontierSession:
    id: str
    workspaceId: str
    threadId: str
    objective: str
    seed: PaperIdentity
    round: int
    expansionsUsed: int
    visitedIds: set[str]
    nodes: dict[str, FrontierNode]
    resumes: dict[str, ResumeRequest]
    strictArxivOnly: bool
    createdAt: float
    expiresAt: float
    publishedAfter: Optional[str] = None


@dataclass
class StartFrontierInput:
    workspaceId: str
    threadId: str
    seed: PaperLocator
    objective: str
    branches: Optional[list[FrontierBranch]] = None
    searchQueries: Optional[list[str]] = None
    publishedAfter: Optional[str] = None
    strictArxivOnly: Optional[bool] = None


@dataclass
class ExpandFrontierInput:
    workspaceId: str
    threadId: str
    frontierId: str
    paperIds: list[str]


@dataclass
class ContinueFrontierInput:
    workspaceId: str
    threadId: str
    frontierId: str
    resumeToken: str


@dataclass
class FrontierSessionFile:
    id: Optional[str]
    path: str
    size: int
    modifiedAt: float
    temporary: bool


def _record_value(value: Any) -> Optional[dict[str, Any]]:
    if isinstance(value, dict):
        return value
    return None


def _valid_paper_identity(value: Any) -> bool:
    record = _record_value(value)
    if not record:
        return False
    if not isinstance(record.get("canonicalId"), str) or not isinstance(record.get("title"), str):
        return False
    authors = record.get("authors")
    if not isinstance(authors, list):
        return False
    return all(
        isinstance(a, dict) and isinstance(a.get("name"), str) for a in authors
    )


def _valid_frontier_node(value: Any) -> bool:
    record = _record_value(value)
    if not record:
        return False
    if not _valid_paper_identity(record.get("paper")):
        return False
    if not isinstance(record.get("discoveredBy"), list) or not all(isinstance(i, str) for i in record["discoveredBy"]):
        return False
    if not isinstance(record.get("graphDistance"), int):
        return False
    if not isinstance(record.get("citationContexts"), list) or not all(isinstance(i, str) for i in record["citationContexts"]):
        return False
    if not isinstance(record.get("citationIntents"), list) or not all(isinstance(i, str) for i in record["citationIntents"]):
        return False
    return isinstance(record.get("isInfluential"), bool)


def _valid_paper_locator(value: Any) -> bool:
    record = _record_value(value)
    if not record:
        return False
    if record.get("type") not in ("document_id", "arxiv_id", "doi", "s2_paper_id", "s2_corpus_id"):
        return False
    return isinstance(record.get("value"), str)


def _valid_resume_request(value: Any) -> bool:
    record = _record_value(value)
    if not record or not isinstance(record.get("cursor"), str):
        return False
    if record.get("type") == "citations":
        return _valid_paper_locator(record.get("locator"))
    return record.get("type") == "arxiv_search" and isinstance(record.get("query"), str)


def _stored_session(value: Any) -> Optional[dict[str, Any]]:
    record = _record_value(value)
    if not record:
        return None
    if (
        record.get("version") != 1
        or not isinstance(record.get("id"), str)
        or not isinstance(record.get("workspaceId"), str)
        or not isinstance(record.get("threadId"), str)
        or not isinstance(record.get("objective"), str)
        or not _valid_paper_identity(record.get("seed"))
        or not isinstance(record.get("round"), int)
        or record.get("round") < 0
        or record.get("round") > MAX_EXPANSIONS
        or not isinstance(record.get("expansionsUsed"), int)
        or record.get("expansionsUsed") < 0
        or record.get("expansionsUsed") > MAX_EXPANSIONS
        or not isinstance(record.get("visitedIds"), list)
        or len(record["visitedIds"]) > MAX_NODES + MAX_EXPANSIONS * 3 + 1
        or not all(isinstance(i, str) for i in record["visitedIds"])
        or not isinstance(record.get("nodes"), list)
        or len(record["nodes"]) > MAX_NODES
        or not isinstance(record.get("resumes"), list)
        or len(record["resumes"]) > 100
        or not isinstance(record.get("strictArxivOnly"), bool)
        or not isinstance(record.get("createdAt"), (int, float))
        or not isinstance(record.get("expiresAt"), (int, float))
        or (record.get("publishedAfter") is not None and not isinstance(record.get("publishedAfter"), str))
    ):
        return None
    nodes = record["nodes"]
    if not all(
        isinstance(entry, list)
        and len(entry) == 2
        and isinstance(entry[0], str)
        and _valid_frontier_node(entry[1])
        for entry in nodes
    ):
        return None
    resumes = record["resumes"]
    if not all(
        isinstance(entry, list)
        and len(entry) == 2
        and isinstance(entry[0], str)
        and _valid_resume_request(entry[1])
        for entry in resumes
    ):
        return None
    return record


def _node_to_dict(node: FrontierNode) -> dict[str, Any]:
    from refora_server.academic.types import identity_to_dict

    return {
        "paper": identity_to_dict(node.paper),
        "discoveredBy": list(node.discoveredBy),
        "graphDistance": node.graphDistance,
        "citationContexts": list(node.citationContexts),
        "citationIntents": list(node.citationIntents),
        "isInfluential": node.isInfluential,
    }


def _node_from_dict(record: dict[str, Any]) -> FrontierNode:
    from refora_server.academic.types import AcademicAuthor, IdentityEvidence, PaperIdentity

    paper_record = record["paper"]
    authors = [
        AcademicAuthor(authorId=a.get("authorId"), name=a.get("name", ""))
        for a in paper_record.get("authors", [])
    ]
    evidence = [
        IdentityEvidence(
            provider=e.get("provider", "local"),
            identifier=e.get("identifier", ""),
            matchedBy=e.get("matchedBy", ""),
        )
        for e in paper_record.get("evidence", [])
    ]
    paper = PaperIdentity(
        canonicalId=paper_record.get("canonicalId", ""),
        title=paper_record.get("title", ""),
        authors=authors,
        matchStatus=paper_record.get("matchStatus", "exact"),
        evidence=evidence,
        arxivId=paper_record.get("arxivId"),
        doi=paper_record.get("doi"),
        semanticScholarPaperId=paper_record.get("semanticScholarPaperId"),
        semanticScholarCorpusId=paper_record.get("semanticScholarCorpusId"),
        year=paper_record.get("year"),
        publicationDate=paper_record.get("publicationDate"),
        abstract=paper_record.get("abstract"),
        venue=paper_record.get("venue"),
        citationCount=paper_record.get("citationCount"),
        referenceCount=paper_record.get("referenceCount"),
    )
    return FrontierNode(
        paper=paper,
        discoveredBy=list(record.get("discoveredBy", [])),
        graphDistance=record.get("graphDistance", 0),
        citationContexts=list(record.get("citationContexts", [])),
        citationIntents=list(record.get("citationIntents", [])),
        isInfluential=bool(record.get("isInfluential", False)),
    )


def _resume_from_dict(record: dict[str, Any]) -> ResumeRequest:
    locator = None
    if isinstance(record.get("locator"), dict):
        loc = record["locator"]
        locator = PaperLocator(type=loc.get("type"), value=loc.get("value", ""))
    return ResumeRequest(
        type=record.get("type"),
        cursor=record.get("cursor", ""),
        locator=locator,
        query=record.get("query"),
    )


def _resume_to_dict(request: ResumeRequest) -> dict[str, Any]:
    data: dict[str, Any] = {"type": request.type, "cursor": request.cursor}
    if request.locator is not None:
        data["locator"] = {"type": request.locator.type, "value": request.locator.value}
    if request.query is not None:
        data["query"] = request.query
    return data


def _seed_to_dict(seed: PaperIdentity) -> dict[str, Any]:
    from refora_server.academic.types import identity_to_dict

    return identity_to_dict(seed)


def _seed_from_dict(record: dict[str, Any]) -> PaperIdentity:
    from refora_server.academic.types import AcademicAuthor, IdentityEvidence, PaperIdentity

    authors = [
        AcademicAuthor(authorId=a.get("authorId"), name=a.get("name", ""))
        for a in record.get("authors", [])
    ]
    evidence = [
        IdentityEvidence(
            provider=e.get("provider", "local"),
            identifier=e.get("identifier", ""),
            matchedBy=e.get("matchedBy", ""),
        )
        for e in record.get("evidence", [])
    ]
    return PaperIdentity(
        canonicalId=record.get("canonicalId", ""),
        title=record.get("title", ""),
        authors=authors,
        matchStatus=record.get("matchStatus", "exact"),
        evidence=evidence,
        arxivId=record.get("arxivId"),
        doi=record.get("doi"),
        semanticScholarPaperId=record.get("semanticScholarPaperId"),
        semanticScholarCorpusId=record.get("semanticScholarCorpusId"),
        year=record.get("year"),
        publicationDate=record.get("publicationDate"),
        abstract=record.get("abstract"),
        venue=record.get("venue"),
        citationCount=record.get("citationCount"),
        referenceCount=record.get("referenceCount"),
    )


class ResearchFrontierSessionStore:
    def __init__(self, root: str) -> None:
        self._root = Path(root)

    def _session_path(self, session_id: str) -> Path:
        if not SESSION_ID_RE.match(session_id):
            raise ValueError("Invalid frontier session ID")
        return self._root / f"{session_id}.json"

    async def save(self, session: FrontierSession) -> None:
        from refora_server.academic.types import identity_to_dict

        stored = {
            "version": 1,
            "id": session.id,
            "workspaceId": session.workspaceId,
            "threadId": session.threadId,
            "objective": session.objective,
            "seed": identity_to_dict(session.seed),
            "round": session.round,
            "expansionsUsed": session.expansionsUsed,
            "visitedIds": list(session.visitedIds),
            "nodes": [[key, _node_to_dict(node)] for key, node in session.nodes.items()],
            "resumes": [[key, _resume_to_dict(req)] for key, req in session.resumes.items()],
            "publishedAfter": session.publishedAfter,
            "strictArxivOnly": session.strictArxivOnly,
            "createdAt": session.createdAt,
            "expiresAt": session.expiresAt,
        }
        content = json.dumps(stored)
        if len(content.encode("utf-8")) > MAX_SESSION_BYTES:
            raise ValueError("Frontier session is too large to persist")

        def _save_sync() -> None:
            self._root.mkdir(parents=True, exist_ok=True)
            os.chmod(self._root, 0o700)
            path = self._session_path(session.id)
            temporary = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
            try:
                temporary.write_text(content, encoding="utf-8")
                os.chmod(temporary, 0o600)
                os.replace(temporary, path)
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass

        await asyncio.to_thread(_save_sync)

    async def load(self, session_id: str) -> Optional[FrontierSession]:
        def _load_sync() -> Optional[FrontierSession]:
            try:
                path = self._session_path(session_id)
                details = path.stat()
                if details.st_size > MAX_SESSION_BYTES:
                    return None
                value = _stored_session(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                return None
            if not value or value.get("id") != session_id:
                return None
            nodes: dict[str, FrontierNode] = {}
            for key, node_record in value.get("nodes", []):
                nodes[key] = _node_from_dict(node_record)
            resumes: dict[str, ResumeRequest] = {}
            for key, resume_record in value.get("resumes", []):
                resumes[key] = _resume_from_dict(resume_record)
            return FrontierSession(
                id=value["id"],
                workspaceId=value["workspaceId"],
                threadId=value["threadId"],
                objective=value["objective"],
                seed=_seed_from_dict(value["seed"]),
                round=value["round"],
                expansionsUsed=value["expansionsUsed"],
                visitedIds=set(value.get("visitedIds", [])),
                nodes=nodes,
                resumes=resumes,
                publishedAfter=value.get("publishedAfter"),
                strictArxivOnly=value["strictArxivOnly"],
                createdAt=float(value["createdAt"]),
                expiresAt=float(value["expiresAt"]),
            )

        return await asyncio.to_thread(_load_sync)

    async def files(self) -> list[FrontierSessionFile]:
        def _files_sync() -> list[FrontierSessionFile]:
            result: list[FrontierSessionFile] = []
            try:
                entries = list(self._root.iterdir())
            except (FileNotFoundError, OSError):
                return result
            for entry in entries:
                try:
                    if not entry.is_file():
                        continue
                except OSError:
                    continue
                match = re.match(
                    r"^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$",
                    entry.name,
                    re.IGNORECASE,
                )
                temporary = bool(TEMP_SESSION_RE.match(entry.name))
                if not match and not temporary:
                    continue
                try:
                    details = entry.stat()
                except OSError:
                    continue
                result.append(
                    FrontierSessionFile(
                        id=match.group(1) if match else None,
                        path=str(entry),
                        size=details.st_size,
                        modifiedAt=details.st_mtime * 1000.0,
                        temporary=temporary,
                    )
                )
            return result

        return await asyncio.to_thread(_files_sync)

    async def delete_thread(self, thread_id: str) -> None:
        for file in await self.files():
            if not file.id or file.temporary:
                continue
            session = await self.load(file.id)
            if session and session.threadId == thread_id:
                try:
                    Path(file.path).unlink()
                except OSError:
                    pass

    async def delete_session(self, session_id: str) -> None:
        try:
            self._session_path(session_id).unlink()
        except OSError:
            pass

    async def prune(
        self,
        now: Optional[float] = None,
        max_bytes: Optional[int] = None,
        max_sessions: Optional[int] = None,
        protected_ids: Optional[set[str]] = None,
    ) -> dict[str, int]:
        now_ms = _now_ms() if now is None else now
        max_bytes_value = max(0, MAX_PERSISTED_BYTES if max_bytes is None else max_bytes)
        max_sessions_value = max(0, MAX_PERSISTED_SESSIONS if max_sessions is None else max_sessions)
        protected = protected_ids or set()
        stored_files = await self.files()
        retained: list[FrontierSessionFile] = []
        deleted_files = 0
        deleted_bytes = 0
        remaining_files = sum(1 for f in stored_files if not f.temporary)
        remaining_bytes = sum(f.size for f in stored_files)

        async def _remove(file: FrontierSessionFile) -> bool:
            nonlocal deleted_files, deleted_bytes, remaining_bytes, remaining_files
            try:
                Path(file.path).unlink()
            except OSError:
                return False
            deleted_files += 1
            deleted_bytes += file.size
            remaining_bytes -= file.size
            if not file.temporary:
                remaining_files -= 1
            return True

        for file in stored_files:
            if file.temporary:
                await _remove(file)
                continue
            if not file.id:
                continue
            session = await self.load(file.id)
            if session is None or session.expiresAt <= now_ms:
                if not await _remove(file):
                    retained.append(file)
            else:
                retained.append(file)

        removable = sorted(
            (f for f in retained if f.id and f.id not in protected),
            key=lambda f: f.modifiedAt,
        )
        for file in removable:
            if remaining_files <= max_sessions_value and remaining_bytes <= max_bytes_value:
                break
            await _remove(file)

        return {
            "deletedFiles": deleted_files,
            "deletedBytes": deleted_bytes,
            "remainingFiles": remaining_files,
            "remainingBytes": remaining_bytes,
        }


def create_research_frontier_session_store(root: str) -> ResearchFrontierSessionStore:
    return ResearchFrontierSessionStore(root)


def _publication_timestamp(candidate: FrontierCandidateView) -> float:
    value = candidate.publicationDate or (f"{candidate.year}-01-01" if candidate.year else "")
    try:
        import datetime

        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except (ValueError, TypeError):
        parsed = None
    if parsed is None:
        return 0.0
    return parsed.timestamp() * 1000.0


class ResearchFrontierService:
    def __init__(
        self,
        identity_service: AcademicIdentityService,
        graph_service: AcademicGraphService,
        arxiv_client: ArxivClient,
        session_root: Optional[str] = None,
    ) -> None:
        self._identity = identity_service
        self._graph = graph_service
        self._arxiv = arxiv_client
        self._sessions: dict[str, FrontierSession] = {}
        self._session_operations: dict[str, asyncio.Future] = {}
        self._session_store = (
            create_research_frontier_session_store(session_root) if session_root else None
        )
        self._session_store_ready: Optional[asyncio.Future] = None
        if self._session_store is not None:
            ready: asyncio.Future = asyncio.Future()

            async def _init() -> None:
                try:
                    await self._session_store.prune()
                except Exception:
                    pass
                ready.set_result(None)

            self._session_store_ready = ready
            asyncio.ensure_future(_init())

    async def _persist_session(self, session: FrontierSession) -> None:
        if self._session_store is None:
            return
        if self._session_store_ready is not None:
            await self._session_store_ready
        await self._session_store.save(session)
        await self._session_store.prune(_now_ms(), protected_ids=set(self._sessions.keys()))

    async def _with_session_lock(self, frontier_id: str, operation: Any) -> Any:
        previous = self._session_operations.get(frontier_id)
        if previous is None:
            previous = asyncio.Future()
            previous.set_result(None)
        current: asyncio.Future = asyncio.Future()
        self._session_operations[frontier_id] = current
        try:
            await previous
        except Exception:
            pass
        try:
            return await operation()
        finally:
            current.set_result(None)
            if self._session_operations.get(frontier_id) is current:
                self._session_operations.pop(frontier_id, None)

    def _cleanup(self) -> None:
        now = _now_ms()
        for session_id in list(self._sessions.keys()):
            if self._sessions[session_id].expiresAt <= now:
                self._sessions.pop(session_id, None)
        while len(self._sessions) > MAX_SESSIONS:
            oldest = min(self._sessions.values(), key=lambda s: s.createdAt)
            self._sessions.pop(oldest.id, None)

    async def _session_for(
        self,
        frontier_id: str,
        workspace_id: str,
        thread_id: str,
    ) -> FrontierSession:
        self._cleanup()
        session = self._sessions.get(frontier_id)
        if session is None and self._session_store is not None:
            if self._session_store_ready is not None:
                await self._session_store_ready
            session = await self._session_store.load(frontier_id)
            if session is not None:
                self._sessions[frontier_id] = session
        if (
            session is None
            or session.workspaceId != workspace_id
            or session.threadId != thread_id
            or session.expiresAt <= _now_ms()
        ):
            if session is not None and session.expiresAt <= _now_ms():
                self._sessions.pop(frontier_id, None)
                if self._session_store is not None:
                    await self._session_store.delete_session(frontier_id)
            raise RuntimeError("Frontier session was not found or has expired")
        session.expiresAt = _now_ms() + SESSION_TTL_MS
        return session

    def _passes_filters(self, session: FrontierSession, paper: PaperIdentity) -> bool:
        if session.strictArxivOnly and not paper.arxivId:
            return False
        if not session.publishedAfter:
            return True
        published = paper.publicationDate or (f"{paper.year}-01-01" if paper.year else "")
        return bool(published) and published >= session.publishedAfter

    def _merge_node(
        self,
        session: FrontierSession,
        paper: PaperIdentity,
        discovered_by: str,
        graph_distance: int,
        evidence: Optional[CitationEvidence] = None,
    ) -> MergeResult:
        if paper.canonicalId in session.visitedIds or not self._passes_filters(session, paper):
            return MergeResult(node=None, inserted=False, limitReached=False)
        existing = session.nodes.get(paper.canonicalId)
        if existing is not None:
            if discovered_by not in existing.discoveredBy:
                existing.discoveredBy.append(discovered_by)
            existing.graphDistance = min(existing.graphDistance, graph_distance)
            existing.citationContexts = list(
                dict.fromkeys([*existing.citationContexts, *(evidence.contexts if evidence else [])])
            )[:5]
            existing.citationIntents = list(
                dict.fromkeys([*existing.citationIntents, *(evidence.intents if evidence else [])])
            )[:10]
            existing.isInfluential = existing.isInfluential or (evidence.isInfluential if evidence else False)
            return MergeResult(node=existing, inserted=False, limitReached=False)
        if len(session.nodes) >= MAX_NODES:
            return MergeResult(node=None, inserted=False, limitReached=True)
        node = FrontierNode(
            paper=paper,
            discoveredBy=[discovered_by],
            graphDistance=graph_distance,
            citationContexts=list((evidence.contexts if evidence else [])[:5]),
            citationIntents=list((evidence.intents if evidence else [])[:10]),
            isInfluential=bool(evidence.isInfluential if evidence else False),
        )
        session.nodes[paper.canonicalId] = node
        return MergeResult(node=node, inserted=True, limitReached=False)

    def _views(self, session: FrontierSession, ids: list[str]) -> list[FrontierCandidateView]:
        result = []
        for node_id in ids:
            node = session.nodes.get(node_id)
            if node is None:
                continue
            result.append(self._view(node))
        return result

    def _has_expandable_nodes(self, session: FrontierSession) -> bool:
        return any(node_id not in session.visitedIds for node_id in session.nodes.keys())

    def _arxiv_identity(self, paper: ArxivSearchPaper) -> PaperIdentity:
        from refora_server.academic.types import AcademicAuthor, IdentityEvidence

        year = int(paper.publishedAt[:4]) if paper.publishedAt else None
        return PaperIdentity(
            canonicalId=f"arxiv:{re.sub(r'v\d+$', '', paper.arxivId, flags=re.IGNORECASE).lower()}",
            arxivId=paper.arxivId,
            doi=paper.doi,
            title=paper.title,
            authors=[AcademicAuthor(name=name) for name in paper.authors],
            year=year,
            publicationDate=paper.publishedAt[:10] if paper.publishedAt else None,
            abstract=paper.abstract,
            matchStatus="exact",
            evidence=[IdentityEvidence(provider="arxiv", identifier=paper.arxivId, matchedBy="arxiv_search")],
        )

    def _view(self, node: FrontierNode) -> FrontierCandidateView:
        local_document_id = self._identity.local_document_id(node.paper)
        evidence_gaps: list[str] = []
        if not node.paper.abstract:
            evidence_gaps.append("abstract_unavailable")
        if not node.paper.arxivId:
            evidence_gaps.append("arxiv_id_unavailable")
        if not node.paper.publicationDate and not node.paper.year:
            evidence_gaps.append("publication_date_unavailable")
        return FrontierCandidateView(
            canonicalId=node.paper.canonicalId,
            arxivId=node.paper.arxivId,
            doi=node.paper.doi,
            semanticScholarPaperId=node.paper.semanticScholarPaperId,
            title=node.paper.title,
            authors=[author.name for author in node.paper.authors],
            publicationDate=node.paper.publicationDate,
            year=node.paper.year,
            abstract=node.paper.abstract,
            discoveredBy=list(node.discoveredBy),
            citationContexts=list(node.citationContexts) if node.citationContexts else None,
            citationIntents=list(node.citationIntents) if node.citationIntents else None,
            isInfluential=node.isInfluential or None,
            graphDistance=node.graphDistance,
            inLocalLibrary=local_document_id is not None,
            arxivHtmlAvailable=None if node.paper.arxivId else False,
            evidenceGaps=evidence_gaps,
        )

    def _resume_action(
        self,
        session: FrontierSession,
        request: ResumeRequest,
        description: str,
    ) -> FrontierNextAction:
        token = str(uuid.uuid4())
        session.resumes[token] = request
        return FrontierNextAction(type="continue", description=description, resumeToken=token)

    def _result(
        self,
        session: FrontierSession,
        expanded_from: list[str],
        groups: FrontierGroups,
        coverage: FrontierCoverageSet,
        next_actions: list[FrontierNextAction],
        warnings: list[str],
    ) -> FrontierView:
        return FrontierView(
            frontierId=session.id,
            round=session.round,
            seed=session.seed,
            expandedFrom=expanded_from,
            groups=groups,
            coverage=coverage,
            nextActions=next_actions,
            warnings=warnings,
            fetchedAt=_iso_now(),
        )

    async def start(self, input: StartFrontierInput, signal: Optional[asyncio.Event] = None) -> FrontierView:
        self._cleanup()
        seed = await self._identity.resolve(input.seed, signal)
        now = _now_ms()
        session = FrontierSession(
            id=str(uuid.uuid4()),
            workspaceId=input.workspaceId,
            threadId=input.threadId,
            objective=input.objective.strip(),
            seed=seed,
            round=0,
            expansionsUsed=0,
            visitedIds={seed.canonicalId},
            nodes={},
            resumes={},
            publishedAfter=input.publishedAfter,
            strictArxivOnly=bool(input.strictArxivOnly),
            createdAt=now,
            expiresAt=now + SESSION_TTL_MS,
        )
        self._sessions[session.id] = session
        self._cleanup()

        branches = list(dict.fromkeys(input.branches)) if input.branches else list(DEFAULT_BRANCHES)
        citing_paper_ids: list[str] = []
        recommendation_ids: list[str] = []
        recent_arxiv_paper_ids: list[str] = []
        coverage = FrontierCoverageSet()
        next_actions: list[FrontierNextAction] = []
        warnings: list[str] = []
        node_limit_reached = False

        queries: list[str] = []
        if "arxiv_recent" in branches:
            queries = [q.strip() for q in (input.searchQueries or []) if q.strip()][:3]
        if "arxiv_recent" in branches and not queries:
            queries.append(session.objective or seed.title)

        citation_fetch: Optional[Any] = None
        recommendation_fetch: Optional[Any] = None

        async def _fetch_citations() -> Any:
            try:
                page = await self._graph.get_citing_papers(
                    input.seed,
                    None,
                    BRANCH_LIMIT,
                    signal,
                    {"publishedAfter": session.publishedAfter} if session.publishedAfter else None,
                )
                return {"page": page}
            except Exception as error:
                return {"error": error}

        async def _fetch_recommendations() -> Any:
            try:
                page = await self._graph.get_recommendations(input.seed, BRANCH_LIMIT, signal)
                return {"page": page}
            except Exception as error:
                return {"error": error}

        async def _fetch_arxiv(query: str) -> Any:
            try:
                page = await self._arxiv.search(
                    __import__("refora_server.academic.types", fromlist=["ArxivSearchInput"]).ArxivSearchInput(
                        query=query,
                        pageSize=BRANCH_LIMIT,
                        sort="submitted_date",
                    ),
                    signal,
                )
                return {"query": query, "page": page}
            except Exception as error:
                return {"query": query, "error": error}

        tasks: list[Any] = []
        if "citations" in branches:
            tasks.append(_fetch_citations())
        else:
            tasks.append(_none())
        if "recommendations" in branches:
            tasks.append(_fetch_recommendations())
        else:
            tasks.append(_none())
        tasks.extend(_fetch_arxiv(q) for q in queries)
        results = await asyncio.gather(*tasks)
        citation_fetch = results[0]
        recommendation_fetch = results[1]
        arxiv_fetches = results[2:]

        if isinstance(citation_fetch, dict) and "page" in citation_fetch:
            page = citation_fetch["page"]
            for candidate in page.items:
                merged = self._merge_node(
                    session,
                    candidate.paper,
                    f"citation:{seed.canonicalId}",
                    1,
                    candidate.citationEvidence,
                )
                node_limit_reached = node_limit_reached or merged.limitReached
                if merged.inserted and merged.node is not None:
                    citing_paper_ids.append(merged.node.paper.canonicalId)
            coverage.citations = page.coverage
            if page.nextCursor:
                next_actions.append(
                    self._resume_action(
                        session,
                        ResumeRequest(type="citations", locator=input.seed, cursor=page.nextCursor),
                        "Continue scanning papers that cite the seed paper",
                    )
                )
        elif isinstance(citation_fetch, dict) and "error" in citation_fetch:
            warnings.append(f"citations: {str(citation_fetch['error'])}")

        if isinstance(recommendation_fetch, dict) and "page" in recommendation_fetch:
            page = recommendation_fetch["page"]
            for paper in page.items:
                merged = self._merge_node(session, paper, f"recommendation:{seed.canonicalId}", 1)
                node_limit_reached = node_limit_reached or merged.limitReached
                if merged.inserted and merged.node is not None:
                    recommendation_ids.append(merged.node.paper.canonicalId)
            coverage.recommendations = FrontierCoverage(
                scanned=len(page.items),
                total=len(page.items),
                complete=True,
            )
        elif isinstance(recommendation_fetch, dict) and "error" in recommendation_fetch:
            warnings.append(f"recommendations: {str(recommendation_fetch['error'])}")

        for fetch_result in arxiv_fetches:
            if not isinstance(fetch_result, dict):
                continue
            if "page" in fetch_result:
                page = fetch_result["page"]
                query = fetch_result["query"]
                for paper in page.papers:
                    merged = self._merge_node(
                        session,
                        self._arxiv_identity(paper),
                        f"arxiv_search:{query}",
                        1,
                    )
                    node_limit_reached = node_limit_reached or merged.limitReached
                    if merged.inserted and merged.node is not None:
                        recent_arxiv_paper_ids.append(merged.node.paper.canonicalId)
                existing = coverage.arxivSearch
                coverage.arxivSearch = FrontierCoverage(
                    scanned=(existing.scanned if existing else 0) + len(page.papers),
                    total=(existing.total if existing else 0) + page.total,
                    complete=(not page.nextCursor) and (existing.complete if existing else True),
                    description=(
                        "Recent arXiv results are paginated and not fully scanned."
                        if page.nextCursor
                        else (existing.description if existing else None)
                    ),
                )
                if page.nextCursor:
                    next_actions.append(
                        self._resume_action(
                            session,
                            ResumeRequest(type="arxiv_search", cursor=page.nextCursor, query=query),
                            f'Continue recent arXiv search for "{query}"',
                        )
                    )
            else:
                warnings.append(f'arxiv_recent "{fetch_result.get("query")}": {str(fetch_result.get("error"))}')

        citing_papers = self._views(session, citing_paper_ids)
        recommendations = self._views(session, recommendation_ids)
        recent_arxiv_papers = self._views(session, recent_arxiv_paper_ids)
        citing_papers.sort(key=lambda c: -_publication_timestamp(c))
        recent_arxiv_papers.sort(key=lambda c: -_publication_timestamp(c))
        if node_limit_reached:
            warnings.append(
                f"candidate_limit_reached: retained the first {MAX_NODES} unique candidates in deterministic branch order"
            )
        if self._has_expandable_nodes(session):
            next_actions.insert(
                0,
                FrontierNextAction(
                    type="expand",
                    description="Select up to three candidate paper IDs for the next exploration round",
                ),
            )
        output = self._result(
            session,
            [seed.canonicalId],
            FrontierGroups(citingPapers=citing_papers, recommendations=recommendations, recentArxivPapers=recent_arxiv_papers),
            coverage,
            next_actions,
            warnings,
        )
        await self._persist_session(session)
        return output

    async def _expand_unlocked(self, input: ExpandFrontierInput, signal: Optional[asyncio.Event] = None) -> FrontierView:
        session = await self._session_for(input.frontierId, input.workspaceId, input.threadId)
        if session.expansionsUsed >= MAX_EXPANSIONS:
            raise RuntimeError("Frontier expansion limit reached")
        selected_ids = list(dict.fromkeys(input.paperIds))[:3]
        selected: list[FrontierNode] = []
        for node_id in selected_ids:
            node = session.nodes.get(node_id)
            if node is not None and node.paper.canonicalId not in session.visitedIds:
                selected.append(node)
        if not selected:
            raise RuntimeError("No selected paper exists in this frontier session")

        session.round += 1
        session.expansionsUsed += 1
        citing_paper_ids: list[str] = []
        recommendation_ids: list[str] = []
        coverage = FrontierCoverageSet()
        next_actions: list[FrontierNextAction] = []
        warnings: list[str] = []
        node_limit_reached = False

        async def _expand_node(node: FrontierNode) -> dict[str, Any]:
            session.visitedIds.add(node.paper.canonicalId)
            try:
                locator = self._identity.to_semantic_scholar_locator(node.paper)
            except Exception as error:
                return {"node": node, "error": error}
            filters = {"publishedAfter": session.publishedAfter} if session.publishedAfter else None
            citations_task = asyncio.ensure_future(
                self._graph.get_citing_papers(locator, None, 10, signal, filters)
            )
            related_task = asyncio.ensure_future(self._graph.get_recommendations(locator, 10, signal))
            citations: Any = None
            related: Any = None
            try:
                citations = await citations_task
                citations_status = "fulfilled"
                citations_value = citations
            except Exception as error:
                citations_status = "rejected"
                citations_value = error
            try:
                related = await related_task
                related_status = "fulfilled"
                related_value = related
            except Exception as error:
                related_status = "rejected"
                related_value = error
            return {
                "node": node,
                "locator": locator,
                "citations": (citations_status, citations_value),
                "related": (related_status, related_value),
            }

        fetched = await asyncio.gather(*[_expand_node(node) for node in selected])

        for fetch_result in fetched:
            if "error" in fetch_result:
                warnings.append(f"{fetch_result['node'].paper.title}: {str(fetch_result['error'])}")
                continue
            node = fetch_result["node"]
            locator = fetch_result["locator"]
            citations_status, citations_value = fetch_result["citations"]
            related_status, related_value = fetch_result["related"]
            if citations_status == "fulfilled":
                for candidate in citations_value.items:
                    merged = self._merge_node(
                        session,
                        candidate.paper,
                        f"citation:{node.paper.canonicalId}",
                        node.graphDistance + 1,
                        candidate.citationEvidence,
                    )
                    node_limit_reached = node_limit_reached or merged.limitReached
                    if merged.inserted and merged.node is not None:
                        citing_paper_ids.append(merged.node.paper.canonicalId)
                existing = coverage.citations
                coverage.citations = FrontierCoverage(
                    scanned=(existing.scanned if existing else 0) + citations_value.coverage.scanned,
                    total=(
                        (existing.total if existing else 0) + citations_value.coverage.total
                        if (existing is not None and existing.total is not None) and citations_value.coverage.total is not None
                        else None
                    ),
                    complete=(existing.complete if existing else True) and citations_value.coverage.complete,
                )
                if citations_value.nextCursor:
                    next_actions.append(
                        self._resume_action(
                            session,
                            ResumeRequest(type="citations", locator=locator, cursor=citations_value.nextCursor),
                            f'Continue citations for "{node.paper.title}"',
                        )
                    )
            else:
                warnings.append(f"{node.paper.title} citations: {str(citations_value)}")
            if related_status == "fulfilled":
                for paper in related_value.items:
                    merged = self._merge_node(
                        session,
                        paper,
                        f"recommendation:{node.paper.canonicalId}",
                        node.graphDistance + 1,
                    )
                    node_limit_reached = node_limit_reached or merged.limitReached
                    if merged.inserted and merged.node is not None:
                        recommendation_ids.append(merged.node.paper.canonicalId)
                existing = coverage.recommendations
                coverage.recommendations = FrontierCoverage(
                    scanned=(existing.scanned if existing else 0) + len(related_value.items),
                    total=(existing.total if existing else 0) + len(related_value.items),
                    complete=True,
                )
            else:
                warnings.append(f"{node.paper.title} recommendations: {str(related_value)}")

        citing_papers = self._views(session, citing_paper_ids)
        recommendations = self._views(session, recommendation_ids)
        citing_papers.sort(key=lambda c: -_publication_timestamp(c))
        if node_limit_reached:
            warnings.append(
                f"candidate_limit_reached: retained the first {MAX_NODES} unique candidates in deterministic expansion order"
            )
        if session.expansionsUsed < MAX_EXPANSIONS and self._has_expandable_nodes(session):
            next_actions.insert(
                0,
                FrontierNextAction(
                    type="expand",
                    description="Select up to three candidate paper IDs for another exploration round",
                ),
            )
        output = self._result(
            session,
            [node.paper.canonicalId for node in selected],
            FrontierGroups(citingPapers=citing_papers, recommendations=recommendations, recentArxivPapers=[]),
            coverage,
            next_actions,
            warnings,
        )
        await self._persist_session(session)
        return output

    async def _continue_page_unlocked(self, input: ContinueFrontierInput, signal: Optional[asyncio.Event] = None) -> FrontierView:
        session = await self._session_for(input.frontierId, input.workspaceId, input.threadId)
        request = session.resumes.get(input.resumeToken)
        if request is None:
            raise RuntimeError("Resume token was not found or has already been used")

        citing_paper_ids: list[str] = []
        recent_arxiv_paper_ids: list[str] = []
        coverage = FrontierCoverageSet()
        next_actions: list[FrontierNextAction] = []
        warnings: list[str] = []
        node_limit_reached = False

        if request.type == "citations" and request.locator is not None:
            filters = {"publishedAfter": session.publishedAfter} if session.publishedAfter else None
            page = await self._graph.get_citing_papers(
                request.locator,
                request.cursor,
                BRANCH_LIMIT,
                signal,
                filters,
            )
            for candidate in page.items:
                merged = self._merge_node(
                    session,
                    candidate.paper,
                    f"citation:{page.seed.canonicalId}",
                    1,
                    candidate.citationEvidence,
                )
                node_limit_reached = node_limit_reached or merged.limitReached
                if merged.inserted and merged.node is not None:
                    citing_paper_ids.append(merged.node.paper.canonicalId)
            coverage.citations = page.coverage
            if page.nextCursor:
                next_actions.append(
                    self._resume_action(
                        session,
                        ResumeRequest(type="citations", locator=request.locator, cursor=page.nextCursor),
                        "Continue scanning citation results",
                    )
                )
        elif request.type == "arxiv_search" and request.query is not None:
            from refora_server.academic.types import ArxivSearchInput

            page = await self._arxiv.search(
                ArxivSearchInput(
                    query=request.query,
                    cursor=request.cursor,
                    pageSize=BRANCH_LIMIT,
                    sort="submitted_date",
                ),
                signal,
            )
            for paper in page.papers:
                merged = self._merge_node(
                    session,
                    self._arxiv_identity(paper),
                    f"arxiv_search:{request.query}",
                    1,
                )
                node_limit_reached = node_limit_reached or merged.limitReached
                if merged.inserted and merged.node is not None:
                    recent_arxiv_paper_ids.append(merged.node.paper.canonicalId)
            coverage.arxivSearch = FrontierCoverage(
                scanned=len(page.papers),
                total=page.total,
                complete=not page.nextCursor,
            )
            if page.nextCursor:
                next_actions.append(
                    self._resume_action(
                        session,
                        ResumeRequest(type="arxiv_search", cursor=page.nextCursor, query=request.query),
                        f'Continue recent arXiv search for "{request.query}"',
                    )
                )

        session.resumes.pop(input.resumeToken, None)
        citing_papers = self._views(session, citing_paper_ids)
        recent_arxiv_papers = self._views(session, recent_arxiv_paper_ids)
        citing_papers.sort(key=lambda c: -_publication_timestamp(c))
        recent_arxiv_papers.sort(key=lambda c: -_publication_timestamp(c))
        if node_limit_reached:
            warnings.append(f"candidate_limit_reached: retained at most {MAX_NODES} unique candidates")
        output = self._result(
            session,
            [],
            FrontierGroups(citingPapers=citing_papers, recommendations=[], recentArxivPapers=recent_arxiv_papers),
            coverage,
            next_actions,
            warnings,
        )
        await self._persist_session(session)
        return output

    async def expand(self, input: ExpandFrontierInput, signal: Optional[asyncio.Event] = None) -> FrontierView:
        return await self._with_session_lock(
            input.frontierId,
            lambda: self._expand_unlocked(input, signal),
        )

    async def continue_page(self, input: ContinueFrontierInput, signal: Optional[asyncio.Event] = None) -> FrontierView:
        return await self._with_session_lock(
            input.frontierId,
            lambda: self._continue_page_unlocked(input, signal),
        )

    async def delete_thread(self, thread_id: str) -> None:
        for session_id in list(self._sessions.keys()):
            if self._sessions[session_id].threadId == thread_id:
                self._sessions.pop(session_id, None)
        if self._session_store is not None:
            if self._session_store_ready is not None:
                await self._session_store_ready
            await self._session_store.delete_thread(thread_id)


async def _none() -> None:
    return None


def create_research_frontier_service(
    identity_service: AcademicIdentityService,
    graph_service: AcademicGraphService,
    arxiv_client: ArxivClient,
    session_root: Optional[str] = None,
) -> ResearchFrontierService:
    return ResearchFrontierService(identity_service, graph_service, arxiv_client, session_root)