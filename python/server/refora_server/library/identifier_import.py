from __future__ import annotations

import asyncio
import hashlib
import inspect
import ipaddress
import os
import re
import shutil
import socket
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlparse

import httpx

from refora_server.academic.arxiv import base_arxiv_id, normalize_arxiv_id
from refora_server.academic.types import PaperLocator


MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
MAX_REDIRECTS = 5
PDF_MAGIC = b"%PDF"
DOI_PATTERN = re.compile(r"^10\.\d{4,9}/[-._;()/:a-zA-Z0-9+]+$")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return str(uuid.uuid4())


async def _await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def detectIdentifierType(value: str) -> str | None:
    input_value = value.strip()
    if not input_value:
        return None
    lower = input_value.lower()
    if lower.startswith(("http://", "https://")):
        if "arxiv.org" in lower:
            return "arxiv"
        if "doi.org" in lower:
            return "doi"
        return "url"
    if DOI_PATTERN.fullmatch(input_value):
        return "doi"
    if normalize_arxiv_id(input_value):
        return "arxiv"
    if re.fullmatch(r"[\d-]{9,17}[\dXx]", re.sub(r"\s", "", input_value)):
        return "isbn"
    return None


def extractArxivId(value: str) -> str | None:
    return normalize_arxiv_id(value)


def extractDoi(value: str) -> str | None:
    input_value = value.strip()
    lower = input_value.lower()
    if lower.startswith(("http://", "https://")):
        parsed = urlparse(input_value)
        if "doi.org" in (parsed.hostname or "").lower():
            doi = unquote(parsed.path.lstrip("/"))
            return doi or None
    if DOI_PATTERN.fullmatch(input_value):
        return input_value
    match = re.search(r"(10\.\d{4,9}/[-._;()/:a-zA-Z0-9+]+)", input_value)
    return match.group(1) if match else None


def sanitizeFileName(title: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "", title)
    cleaned = "".join(char for char in cleaned if ord(char) >= 32)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:180]
    return cleaned or "download"


def _is_public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


async def isSafeUrl(value: str) -> bool:
    try:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        normalized = hostname.rstrip(".").lower()
        if normalized == "localhost" or normalized.endswith(".localhost"):
            return False
        try:
            ipaddress.ip_address(normalized)
            return _is_public_ip(normalized)
        except ValueError:
            pass
        addresses = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: socket.getaddrinfo(normalized, None, type=socket.SOCK_STREAM),
        )
        return bool(addresses) and all(_is_public_ip(entry[4][0]) for entry in addresses)
    except (OSError, ValueError):
        return False


async def downloadPdf(url: str, destination_dir: str, file_name: str) -> str:
    current_url = url
    for _ in range(MAX_REDIRECTS + 1):
        if not await isSafeUrl(current_url):
            raise ValueError("The download URL is not allowed (must be a public http(s) address).")
        async with httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(60, connect=15)) as client:
            async with client.stream("GET", current_url, headers={"User-Agent": "Refora/0.1"}) as response:
                if 300 <= response.status_code < 400:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError(f"Redirect response {response.status_code} has no location")
                    current_url = urljoin(current_url, location)
                    continue
                if response.status_code < 200 or response.status_code >= 300:
                    raise ValueError(f"Download failed: HTTP {response.status_code}")
                length = response.headers.get("content-length")
                if length and length.isdigit() and int(length) > MAX_DOWNLOAD_BYTES:
                    raise ValueError("Download failed: PDF exceeds the 512 MB limit")
                folder = Path(destination_dir)
                folder.mkdir(parents=True, exist_ok=True)
                destination = folder / file_name
                if destination.exists():
                    raise ValueError("Download destination already exists")
                downloaded = 0
                try:
                    with destination.open("xb") as output:
                        async for chunk in response.aiter_bytes():
                            downloaded += len(chunk)
                            if downloaded > MAX_DOWNLOAD_BYTES:
                                raise ValueError("Download failed: PDF exceeds the 512 MB limit")
                            output.write(chunk)
                except Exception:
                    destination.unlink(missing_ok=True)
                    raise
                if downloaded < 100:
                    destination.unlink(missing_ok=True)
                    raise ValueError("Downloaded file is too small to be a valid PDF")
                return str(destination.resolve())
    raise ValueError("Too many redirects")


def _hash_pdf(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _is_pdf_file(path: str) -> bool:
    try:
        with open(path, "rb") as source:
            return source.read(4) == PDF_MAGIC
    except OSError:
        return False


def _copy_to_library(source: str, library_folder: str) -> str:
    folder = Path(library_folder)
    folder.mkdir(parents=True, exist_ok=True)
    source_path = Path(source)
    destination = folder / source_path.name
    number = 1
    while destination.exists():
        destination = folder / f"{source_path.stem} ({number}){source_path.suffix}"
        number += 1
    shutil.copy2(source_path, destination)
    return str(destination.resolve())


def _library_folder(repos: dict[str, Any], deps: dict[str, Any]) -> str:
    getter = deps.get("getLibraryFolder")
    if callable(getter):
        value = getter()
        return value if isinstance(value, str) else ""
    settings = repos.get("settings")
    if settings is not None:
        value = settings.get("libraryFolderPath", "")
        return value if isinstance(value, str) else ""
    return ""


def _metadata_from_identity(identity: Any) -> dict[str, Any]:
    authors = getattr(identity, "authors", [])
    return {
        "title": getattr(identity, "title", None),
        "authors": "; ".join(author.name for author in authors if getattr(author, "name", "")) or None,
        "year": str(identity.year) if getattr(identity, "year", None) is not None else None,
        "venue": getattr(identity, "venue", None),
        "abstract": getattr(identity, "abstract", None),
        "doi": getattr(identity, "doi", None),
        "arxivId": getattr(identity, "arxivId", None),
        "metadataSource": "semantic_scholar",
    }


async def _fetch_arxiv_metadata(arxiv_id: str, deps: dict[str, Any]) -> dict[str, Any] | None:
    fetcher = deps.get("fetchArxivMetadata")
    if callable(fetcher):
        return await _await(fetcher(arxiv_id))
    client = deps.get("arxivClient")
    if client is None:
        return None
    from refora_server.academic.arxiv import ArxivSearchInput

    result = await client.search(ArxivSearchInput(query=arxiv_id, pageSize=20))
    matched = next(
        (paper for paper in result.papers if base_arxiv_id(paper.arxivId).lower() == base_arxiv_id(arxiv_id).lower()),
        None,
    )
    if matched is None:
        return None
    return {
        "title": matched.title,
        "authors": "; ".join(matched.authors) or None,
        "year": matched.publishedAt[:4] if matched.publishedAt else None,
        "abstract": matched.abstract,
        "url": matched.absUrl,
        "doi": matched.doi,
        "arxivId": matched.arxivId,
        "metadataSource": "arxiv",
        "pdfUrl": matched.pdfUrl,
    }


async def _fetch_doi_metadata(doi: str, deps: dict[str, Any]) -> dict[str, Any] | None:
    fetcher = deps.get("fetchDoiMetadata")
    if callable(fetcher):
        return await _await(fetcher(doi))
    identity_service = deps.get("academicIdentityService")
    if identity_service is not None:
        identity = await identity_service.resolve(PaperLocator(type="doi", value=doi))
        return _metadata_from_identity(identity)
    client = deps.get("semanticScholarClient")
    if client is None:
        return None
    identity = await client.get_paper(PaperLocator(type="doi", value=doi))
    return _metadata_from_identity(identity)


async def importByIdentifier(
    repos: dict[str, Any], identifier: str, deps: dict[str, Any] | None = None
) -> str:
    options = deps or {}
    input_value = identifier.strip()
    kind = detectIdentifierType(input_value)
    if not input_value:
        raise ValueError("Identifier is empty")
    if kind is None:
        raise ValueError(f'Could not recognize identifier: "{input_value}"')
    if kind == "isbn":
        raise ValueError("ISBN import is not supported yet. Please use a DOI or arXiv ID.")
    library_folder = _library_folder(repos, options)
    if not library_folder or not Path(library_folder).is_absolute():
        raise ValueError("Library folder is not configured. Please set it in Settings first.")
    Path(library_folder).mkdir(parents=True, exist_ok=True)
    metadata: dict[str, Any] = {}
    pdf_url: str | None = None
    if kind == "arxiv":
        arxiv_id = extractArxivId(input_value)
        if not arxiv_id:
            raise ValueError(f'Could not extract arXiv ID from: "{input_value}"')
        fetched = await _fetch_arxiv_metadata(arxiv_id, options)
        if fetched is None:
            raise ValueError(f"Could not fetch arXiv metadata for: {arxiv_id}")
        metadata = fetched
        pdf_url = fetched.get("pdfUrl") or f"https://arxiv.org/pdf/{arxiv_id}.pdf"
        file_name = f"{sanitizeFileName(str(fetched.get('title') or arxiv_id))}.pdf"
    elif kind == "doi":
        doi = extractDoi(input_value)
        if not doi:
            raise ValueError(f'Could not extract DOI from: "{input_value}"')
        fetched = await _fetch_doi_metadata(doi, options)
        if fetched is None:
            raise ValueError(f"Could not fetch metadata for DOI: {doi}")
        metadata = fetched
        pdf_url = fetched.get("pdfUrl") or f"https://doi.org/{quote(doi, safe='/')}"
        file_name = f"{sanitizeFileName(str(fetched.get('title') or doi.replace('/', '_')))}.pdf"
    else:
        pdf_url = input_value
        parsed_name = Path(urlparse(input_value).path).name
        file_name = parsed_name if parsed_name.lower().endswith(".pdf") else "download.pdf"
    safe_url = options.get("isSafeUrl", isSafeUrl)
    if not await _await(safe_url(pdf_url)):
        raise ValueError("The download URL is not allowed (must be a public http(s) address).")
    temporary_dir = tempfile.mkdtemp(prefix="identifier-", dir=str(Path(library_folder)))
    try:
        downloader = options.get("downloadPdf", downloadPdf)
        temporary_path = await _await(downloader(pdf_url, temporary_dir, file_name))
        if not isinstance(temporary_path, str) or not Path(temporary_path).is_absolute() or not _is_pdf_file(temporary_path):
            raise ValueError("Downloaded file is not a valid PDF.")
        file_hash = options.get("hashPdf", _hash_pdf)(temporary_path)
        if repos["documents"]["findByHash"](file_hash) is not None:
            raise ValueError("This file is already in your library.")
        stat = os.stat(temporary_path)
        now = options.get("nowMs", _now_ms)()
        document = repos["documents"]["insert"](
            {
                "id": options.get("newId", _new_id)(),
                "filePath": temporary_path,
                "originalFolderPath": str(Path(library_folder).resolve()),
                "fileName": Path(temporary_path).name,
                "fileSize": stat.st_size,
                "fileHash": file_hash,
                "title": metadata.get("title"),
                "authors": metadata.get("authors"),
                "year": metadata.get("year"),
                "venue": metadata.get("venue"),
                "volume": metadata.get("volume"),
                "issue": metadata.get("issue"),
                "pages": metadata.get("pages"),
                "abstract": metadata.get("abstract"),
                "keywords": metadata.get("keywords"),
                "url": metadata.get("url"),
                "doi": metadata.get("doi"),
                "arxivId": metadata.get("arxivId"),
                "note": None,
                "affiliations": None,
                "starred": 0,
                "addedAt": now,
                "lastReadAt": None,
                "updatedAt": now,
                "metadataSource": metadata.get("metadataSource"),
                "metadataStatus": "done",
                "metadataAttempts": 0,
                "editedFields": [],
                "remoteValues": None,
                "fileMissing": 0,
            }
        )
        try:
            copied_path = options.get("copyToLibrary", _copy_to_library)(temporary_path, library_folder)
            repos["documents"]["updateFilePath"](document["id"], copied_path, Path(copied_path).name)
        except Exception:
            repos["documents"]["delete"](document["id"])
            raise ValueError("Failed to copy the downloaded PDF to the library folder.")
        return document["id"]
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)
