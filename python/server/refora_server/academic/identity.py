from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Literal, Optional, Protocol

from refora_server.academic.arxiv import base_arxiv_id, normalize_arxiv_id
from refora_server.academic.semantic_scholar import (
    SemanticScholarClient,
    SemanticScholarError,
    normalize_doi,
)
from refora_server.academic.types import (
    AcademicAuthor,
    IdentityEvidence,
    PaperIdentity,
    PaperLocator,
)

AcademicIdentityErrorCode = Literal[
    "document_not_found",
    "identity_unresolvable",
    "identity_conflict",
    "invalid_locator",
]


class AcademicIdentityError(Exception):
    def __init__(self, code: AcademicIdentityErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "AcademicIdentityError"


@dataclass
class LocalDocument:
    id: str
    title: Optional[str] = None
    fileName: Optional[str] = None
    authors: Optional[str] = None
    year: Optional[str] = None
    abstract: Optional[str] = None
    venue: Optional[str] = None
    arxivId: Optional[str] = None
    doi: Optional[str] = None


class DocumentRepository(Protocol):
    def get(self, document_id: str) -> Optional[LocalDocument]: ...
    def list(self, mode: str = "all") -> list[LocalDocument]: ...


def _normalize_doi_opt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    normalized = normalize_doi(value)
    return normalized or None


def split_authors(value: Optional[str]) -> list[AcademicAuthor]:
    if not value:
        return []
    parts = [author.strip() for author in value.split(";")]
    return [AcademicAuthor(name=name) for name in parts if name]


class AcademicIdentityService:
    def __init__(
        self,
        repos: DocumentRepository,
        semantic_scholar_client: SemanticScholarClient,
    ) -> None:
        self._repos = repos
        self._s2 = semantic_scholar_client

    async def resolve(self, locator: PaperLocator, signal: Optional[asyncio.Event] = None) -> PaperIdentity:
        if locator.type != "document_id":
            return await self._s2.get_paper(locator, signal)

        document_id = locator.value.strip()
        document = self._repos.get(document_id)
        if document is None:
            raise AcademicIdentityError("document_not_found", "Document was not found")
        arxiv_id = normalize_arxiv_id(document.arxivId) if document.arxivId else None
        doi = _normalize_doi_opt(document.doi)
        provider_locator: Optional[PaperLocator] = (
            PaperLocator(type="arxiv_id", value=arxiv_id)
            if arxiv_id
            else PaperLocator(type="doi", value=doi)
            if doi
            else None
        )

        if provider_locator is None:
            title = document.title or document.fileName
            year = _parse_year(document.year)
            return PaperIdentity(
                canonicalId=f"document:{document_id}",
                title=title or "",
                authors=split_authors(document.authors),
                year=year,
                abstract=document.abstract or None,
                venue=document.venue or None,
                matchStatus="exact",
                evidence=[IdentityEvidence(provider="local", identifier=document_id, matchedBy="document_id")],
            )

        try:
            resolved = await self._s2.get_paper(provider_locator, signal)
        except SemanticScholarError as error:
            if error.code != "paper_not_found":
                raise
            title = document.title or document.fileName
            canonical = f"arxiv:{base_arxiv_id(arxiv_id).lower()}" if arxiv_id else f"doi:{doi}"
            year = _parse_year(document.year)
            return PaperIdentity(
                canonicalId=canonical,
                arxivId=arxiv_id or None,
                doi=doi or None,
                title=title or "",
                authors=split_authors(document.authors),
                year=year,
                abstract=document.abstract or None,
                venue=document.venue or None,
                matchStatus="verified",
                evidence=[IdentityEvidence(provider="local", identifier=document_id, matchedBy=provider_locator.type)],
            )

        if (
            arxiv_id
            and resolved.arxivId
            and base_arxiv_id(arxiv_id).lower() != base_arxiv_id(resolved.arxivId).lower()
        ):
            raise AcademicIdentityError("identity_conflict", "Resolved arXiv ID conflicts with document")
        if doi and resolved.doi and doi != normalize_doi(resolved.doi):
            raise AcademicIdentityError("identity_conflict", "Resolved DOI conflicts with document")
        return PaperIdentity(
            canonicalId=resolved.canonicalId,
            arxivId=resolved.arxivId,
            doi=resolved.doi,
            semanticScholarPaperId=resolved.semanticScholarPaperId,
            semanticScholarCorpusId=resolved.semanticScholarCorpusId,
            title=resolved.title,
            authors=resolved.authors,
            year=resolved.year,
            publicationDate=resolved.publicationDate,
            abstract=resolved.abstract,
            venue=resolved.venue,
            citationCount=resolved.citationCount,
            referenceCount=resolved.referenceCount,
            matchStatus="verified",
            evidence=[
                *resolved.evidence,
                IdentityEvidence(provider="local", identifier=document_id, matchedBy=provider_locator.type),
            ],
        )

    def to_semantic_scholar_locator(self, identity: PaperIdentity) -> PaperLocator:
        if identity.semanticScholarPaperId:
            return PaperLocator(type="s2_paper_id", value=identity.semanticScholarPaperId)
        if identity.arxivId:
            return PaperLocator(type="arxiv_id", value=identity.arxivId)
        if identity.doi:
            return PaperLocator(type="doi", value=identity.doi)
        if identity.semanticScholarCorpusId is not None:
            return PaperLocator(type="s2_corpus_id", value=str(identity.semanticScholarCorpusId))
        raise AcademicIdentityError(
            "identity_unresolvable",
            "Paper has no Semantic Scholar-compatible identifier",
        )

    def local_document_id(self, identity: PaperIdentity) -> Optional[str]:
        arxiv_id = base_arxiv_id(identity.arxivId).lower() if identity.arxivId else None
        doi = _normalize_doi_opt(identity.doi)
        for document in self._repos.list("all"):
            document_arxiv = normalize_arxiv_id(document.arxivId) if document.arxivId else None
            if arxiv_id and document_arxiv and base_arxiv_id(document_arxiv).lower() == arxiv_id:
                return document.id
            if doi is not None and _normalize_doi_opt(document.doi) == doi:
                return document.id
        return None


def _parse_year(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        parsed = int(value[:4])
    except (TypeError, ValueError):
        return None
    return parsed


def create_academic_identity_service(
    repos: DocumentRepository,
    semantic_scholar_client: SemanticScholarClient,
) -> AcademicIdentityService:
    return AcademicIdentityService(repos, semantic_scholar_client)