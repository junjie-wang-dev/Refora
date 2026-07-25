from __future__ import annotations

import asyncio
from typing import Any, Optional

from refora_server.academic.identity import AcademicIdentityService
from refora_server.academic.semantic_scholar import SemanticScholarClient
from refora_server.academic.types import (
    AcademicGraphPage,
    PaperLocator,
    SemanticRecommendationResult,
)


class AcademicGraphService:
    def __init__(
        self,
        identity_service: AcademicIdentityService,
        semantic_scholar_client: SemanticScholarClient,
    ) -> None:
        self._identity = identity_service
        self._s2 = semantic_scholar_client

    async def get_citing_papers(
        self,
        locator: PaperLocator,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
        filters: Optional[dict[str, Any]] = None,
    ) -> AcademicGraphPage:
        identity = await self._identity.resolve(locator, signal)
        return await self._s2.get_citing_papers(
            self._identity.to_semantic_scholar_locator(identity),
            cursor,
            limit,
            signal,
            filters,
        )

    async def get_referenced_papers(
        self,
        locator: PaperLocator,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
        filters: Optional[dict[str, Any]] = None,
    ) -> AcademicGraphPage:
        identity = await self._identity.resolve(locator, signal)
        return await self._s2.get_referenced_papers(
            self._identity.to_semantic_scholar_locator(identity),
            cursor,
            limit,
            signal,
            filters,
        )

    async def get_recommendations(
        self,
        locator: PaperLocator,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
    ) -> SemanticRecommendationResult:
        identity = await self._identity.resolve(locator, signal)
        return await self._s2.get_recommendations(
            self._identity.to_semantic_scholar_locator(identity),
            limit,
            signal,
        )


def create_academic_graph_service(
    identity_service: AcademicIdentityService,
    semantic_scholar_client: SemanticScholarClient,
) -> AcademicGraphService:
    return AcademicGraphService(identity_service, semantic_scholar_client)