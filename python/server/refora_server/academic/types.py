from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any, Literal, Optional


PaperLocatorType = Literal[
    "document_id",
    "arxiv_id",
    "doi",
    "s2_paper_id",
    "s2_corpus_id",
]


ACADEMIC_RESEARCH_TOOL_NAMES = (
    "search_arxiv",
    "get_arxiv_paper",
    "resolve_academic_identity",
    "get_citing_papers",
    "get_referenced_papers",
    "get_semantic_recommendations",
    "explore_research_frontier",
)


@dataclass
class PaperLocator:
    type: PaperLocatorType
    value: str


@dataclass
class AcademicAuthor:
    authorId: Optional[str] = None
    name: str = ""


@dataclass
class IdentityEvidence:
    provider: Literal["local", "arxiv", "semantic_scholar"]
    identifier: str
    matchedBy: str


@dataclass
class PaperIdentity:
    canonicalId: str
    title: str
    authors: list[AcademicAuthor]
    matchStatus: Literal["exact", "verified", "ambiguous"]
    evidence: list[IdentityEvidence]
    arxivId: Optional[str] = None
    doi: Optional[str] = None
    semanticScholarPaperId: Optional[str] = None
    semanticScholarCorpusId: Optional[int] = None
    year: Optional[int] = None
    publicationDate: Optional[str] = None
    abstract: Optional[str] = None
    venue: Optional[str] = None
    citationCount: Optional[int] = None
    referenceCount: Optional[int] = None


@dataclass
class ArxivSearchInput:
    query: str
    cursor: Optional[str] = None
    pageSize: Optional[int] = None
    sort: Optional[Literal["relevance", "submitted_date"]] = None
    categories: Optional[list[str]] = None


@dataclass
class ArxivSearchPaper:
    arxivId: str
    title: str
    authors: list[str]
    categories: list[str]
    absUrl: str
    htmlUrl: str
    pdfUrl: str
    abstract: Optional[str] = None
    publishedAt: Optional[str] = None
    updatedAt: Optional[str] = None
    doi: Optional[str] = None


@dataclass
class ArxivSearchResult:
    papers: list[ArxivSearchPaper]
    total: int
    fetchedAt: str
    cached: bool
    nextCursor: Optional[str] = None


@dataclass
class ArxivPaperSection:
    id: str
    title: str
    level: int
    start: int
    end: int


@dataclass
class ArxivPaperResult:
    arxivId: str
    sourceUrl: str
    sourceFormat: Literal["arxiv-html"]
    outputFormat: Literal["markdown"]
    sections: list[ArxivPaperSection]
    cursor: int
    maxChars: int
    totalChars: int
    contentMd: str
    conversionWarnings: list[str]
    cached: bool
    title: Optional[str] = None
    sectionId: Optional[str] = None
    nextCursor: Optional[str] = None


@dataclass
class CitationEvidence:
    contexts: list[str]
    intents: list[str]
    isInfluential: bool


@dataclass
class AcademicGraphCandidate:
    paper: PaperIdentity
    citationEvidence: Optional[CitationEvidence] = None


@dataclass
class AcademicGraphCoverage:
    scanned: int
    total: Optional[int] = None
    complete: bool = False


@dataclass
class AcademicGraphPage:
    seed: PaperIdentity
    direction: Literal["incoming", "outgoing"]
    items: list[AcademicGraphCandidate]
    coverage: AcademicGraphCoverage
    fetchedAt: str
    cached: bool
    total: Optional[int] = None
    nextCursor: Optional[str] = None


@dataclass
class SemanticRecommendationResult:
    seed: PaperIdentity
    items: list[PaperIdentity]
    fetchedAt: str
    cached: bool


FrontierBranch = Literal["citations", "recommendations", "arxiv_recent"]


@dataclass
class FrontierCoverage:
    scanned: int
    total: Optional[int] = None
    complete: bool = False
    description: Optional[str] = None


@dataclass
class FrontierNextAction:
    type: Literal["expand", "continue"]
    description: str
    resumeToken: Optional[str] = None


@dataclass
class FrontierCandidateView:
    canonicalId: str
    title: str
    authors: list[str]
    graphDistance: int
    inLocalLibrary: bool
    arxivHtmlAvailable: Optional[bool]
    evidenceGaps: list[str]
    discoveredBy: list[str]
    arxivId: Optional[str] = None
    doi: Optional[str] = None
    semanticScholarPaperId: Optional[str] = None
    publicationDate: Optional[str] = None
    year: Optional[int] = None
    abstract: Optional[str] = None
    citationContexts: Optional[list[str]] = None
    citationIntents: Optional[list[str]] = None
    isInfluential: Optional[bool] = None


@dataclass
class FrontierGroups:
    citingPapers: list[FrontierCandidateView] = field(default_factory=list)
    recommendations: list[FrontierCandidateView] = field(default_factory=list)
    recentArxivPapers: list[FrontierCandidateView] = field(default_factory=list)


@dataclass
class FrontierCoverageSet:
    citations: Optional[FrontierCoverage] = None
    recommendations: Optional[FrontierCoverage] = None
    arxivSearch: Optional[FrontierCoverage] = None


@dataclass
class FrontierView:
    frontierId: str
    round: int
    seed: PaperIdentity
    expandedFrom: list[str]
    groups: FrontierGroups
    coverage: FrontierCoverageSet
    nextActions: list[FrontierNextAction]
    warnings: list[str]
    fetchedAt: str


def identity_to_dict(identity: PaperIdentity) -> dict[str, Any]:
    data = asdict(identity)
    authors = []
    for author in data["authors"]:
        if author.get("authorId") is None:
            author.pop("authorId", None)
        authors.append(author)
    data["authors"] = authors
    return data


def to_json(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, list):
        return [to_json(item) for item in value]
    if isinstance(value, dict):
        return {key: to_json(item) for key, item in value.items()}
    return value