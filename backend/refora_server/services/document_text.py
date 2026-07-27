from __future__ import annotations

import asyncio
from typing import Any, Callable

from refora_server.library.pdf_path import resolvePdfFilePath
from refora_server.repositories.errors import RepoError


def _classify_pdf_error(error: Exception) -> tuple[str, str]:
    name = type(error).__name__
    message = str(error) or name
    lower = message.lower()
    if (
        name in ("WrongPasswordError", "FileNotDecryptedError")
        or "password" in lower
        or "encrypted" in lower
        or "decrypt" in lower
    ):
        return "encrypted", message
    if name in ("PdfReadError", "PyPdfError", "EmptyFileError", "ParseError", "PdfStreamError"):
        return "corrupted", message
    return "corrupted", message


def _is_encrypted(reader: Any) -> bool:
    try:
        return bool(getattr(reader, "is_encrypted", False))
    except Exception:
        return False


def _open_reader(path: str, reader_factory: Any) -> tuple[Any, str | None]:
    try:
        reader = reader_factory(path)
    except Exception as error:
        code, message = _classify_pdf_error(error)
        raise RepoError(code, f"Failed to extract PDF text: {message}") from error
    if _is_encrypted(reader):
        raise RepoError("encrypted", "Failed to extract PDF text: PDF is encrypted")
    return reader, None


def createDocumentTextService(
    repos: dict[str, Any],
    deps: dict[str, Any] | None = None,
) -> dict[str, Any]:
    deps = deps or {}
    reader_factory: Callable[[str], Any] | None = deps.get("reader_factory")

    def extract_path(path: str) -> str:
        try:
            factory = reader_factory
            if factory is None:
                from pypdf import PdfReader

                factory = PdfReader
            reader, _ = _open_reader(path, factory)
            pages: list[str] = []
            for page in reader.pages:
                value = page.extract_text()
                if isinstance(value, str) and value.strip():
                    pages.append(value.strip())
            text = "\n\n".join(pages)
        except RepoError:
            raise
        except Exception as error:
            code, message = _classify_pdf_error(error)
            raise RepoError(code, f"Failed to extract PDF text: {message}") from error
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
