from __future__ import annotations

import asyncio
from typing import Any, Callable

from refora_server.library.pdf_path import resolvePdfFilePath
from refora_server.repositories.errors import RepoError


def createDocumentTextService(
    repos: dict[str, Any],
    deps: dict[str, Any] | None = None,
) -> dict[str, Any]:
    deps = deps or {}
    reader_factory: Callable[[str], Any] | None = deps.get("reader_factory")

    def extract_path(path: str) -> str:
        try:
            if reader_factory is None:
                from pypdf import PdfReader

                reader = PdfReader(path)
            else:
                reader = reader_factory(path)
            pages: list[str] = []
            for page in reader.pages:
                value = page.extract_text()
                if isinstance(value, str) and value.strip():
                    pages.append(value.strip())
            text = "\n\n".join(pages)
        except RepoError:
            raise
        except Exception as error:
            raise RepoError(
                "pdf_extract_failed",
                f"Failed to extract PDF text: {error}",
            ) from error
        return text

    def extract(document_id: str) -> str:
        document = repos["documents"]["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"document not found: {document_id}")
        path = resolvePdfFilePath(document.get("filePath") or "")
        text = extract_path(path)
        repos["aiSummaries"]["setFullText"](
            document_id,
            text,
            document.get("fileHash"),
        )
        return text

    async def getOrExtract(document_id: str) -> str:
        document = repos["documents"]["get"](document_id)
        if document is None:
            raise RepoError("not_found", f"document not found: {document_id}")
        cached = repos["aiSummaries"]["getFullText"](document_id)
        if (
            cached is not None
            and cached.get("hash") == document.get("fileHash")
            and isinstance(cached.get("text"), str)
        ):
            return cached["text"]
        path = resolvePdfFilePath(document.get("filePath") or "")
        text = await asyncio.to_thread(extract_path, path)
        repos["aiSummaries"]["setFullText"](
            document_id,
            text,
            document.get("fileHash"),
        )
        return text

    return {"getOrExtract": getOrExtract, "extract": extract}
