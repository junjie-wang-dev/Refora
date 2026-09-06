from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import stat
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urljoin, urlsplit

import httpx

from refora_server.repositories.errors import RepoError
from refora_server.services.web_fetch import (
    _resolve_addresses,
    _normalize_url,
    _validate_public_url,
    assert_public_peer,
)

MAX_MEDIA_BYTES = 100 * 1024 * 1024
MAX_INLINE_BYTES = 20 * 1024 * 1024
MAX_CACHE_BYTES = 1024 * 1024 * 1024
_MEDIA_ID = re.compile(r"^[a-f0-9]{64}$")
_INLINE = re.compile(r"^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$")
_MIME_EXTENSIONS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/avif": ".avif",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav",
    "audio/ogg": ".ogg", "audio/webm": ".webm", "audio/mp4": ".m4a",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/ogg": ".ogv",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
    "text/tab-separated-values": ".tsv", "text/markdown": ".md",
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
}


def _canonical_mime(mime: str) -> str:
    value = mime.lower().split(";", 1)[0].strip()
    return {
        "image/jpg": "image/jpeg",
        "text/json": "application/json",
        "audio/x-wav": "audio/wav",
        "audio/wave": "audio/wav",
        "audio/vnd.wave": "audio/wav",
        "audio/mp4a-latm": "audio/mp4",
        "audio/x-m4a": "audio/mp4",
        "audio/x-mpeg": "audio/mpeg",
        "video/x-m4v": "video/mp4",
    }.get(value, value)


def _file_name(value: Any, mime: str) -> str:
    name = Path(value.replace("\\", "/")).name if isinstance(value, str) else ""
    name = re.sub(r"[\x00-\x1f\x7f/:]", "_", name).strip(" .")[:160] or "media"
    extension = _MIME_EXTENSIONS.get(mime)
    if extension and Path(name).suffix.lower() != extension:
        name = (Path(name).stem or "media") + extension
    if Path(name).suffix.lower() in {".app", ".command", ".sh", ".exe", ".html", ".htm", ".js", ".mjs"}:
        name += ".txt"
    if name == "resource.json":
        name = "resource-data.json"
    return name


def _kind(mime: str) -> str:
    if mime in _MIME_EXTENSIONS and mime.split("/", 1)[0] in {"image", "audio", "video"}:
        return mime.split("/", 1)[0]
    return "file"


def _check_magic(prefix: bytes, mime: str) -> None:
    valid = True
    if mime == "image/png":
        valid = prefix.startswith(b"\x89PNG\r\n\x1a\n")
    elif mime == "image/jpeg":
        valid = prefix.startswith(b"\xff\xd8\xff")
    elif mime == "image/gif":
        valid = prefix.startswith((b"GIF87a", b"GIF89a"))
    elif mime == "image/webp":
        valid = prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP"
    elif mime == "image/avif":
        valid = prefix[4:8] == b"ftyp" and b"avif" in prefix[8:32]
    elif mime in {"audio/wav", "audio/x-wav"}:
        valid = prefix.startswith(b"RIFF") and prefix[8:12] == b"WAVE"
    elif mime in {"audio/ogg", "video/ogg"}:
        valid = prefix.startswith(b"OggS")
    elif mime in {"audio/webm", "video/webm"}:
        valid = prefix.startswith(b"\x1a\x45\xdf\xa3")
    elif mime in {"audio/mp4", "video/mp4"}:
        valid = prefix[4:8] == b"ftyp"
    elif mime in {"audio/mpeg", "audio/mp3"}:
        valid = prefix.startswith(b"ID3") or (len(prefix) > 1 and prefix[0] == 255 and prefix[1] & 224 == 224)
    elif mime == "application/pdf":
        valid = prefix.startswith(b"%PDF-")
    if not valid:
        raise RepoError("invalid_media", "Media contents do not match the declared format")


def create_chat_media_service(
    local_data_folder: str,
    repos: dict[str, Any],
    services: dict[str, Any],
    *,
    proxy: Callable[[], str] | None = None,
    http_client: httpx.AsyncClient | None = None,
    resolver: Callable[[str, int], list[str]] | None = None,
) -> dict[str, Any]:
    data_root = Path(local_data_folder).absolute()
    root = data_root / ".refora-agent" / "media"
    lock = threading.RLock()
    remote_tasks: dict[str, asyncio.Task[Any]] = {}
    verified_files: dict[str, tuple[int, int, int, int, str]] = {}

    def layout() -> None:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink() or root.parent.is_symlink():
            raise RepoError("invalid_path", "Media cache must be a local managed directory")

    def get_file(media_id: str) -> dict[str, Any]:
        if not isinstance(media_id, str) or not _MEDIA_ID.fullmatch(media_id):
            raise RepoError("invalid_input", "Invalid media reference")
        directory = root / media_id
        metadata_path = directory / "resource.json"
        if root.is_symlink() or root.parent.is_symlink() or directory.is_symlink() or metadata_path.is_symlink():
            raise RepoError("invalid_path", "Media cache links are not allowed")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            filename = metadata["fileName"]
            if not isinstance(filename, str) or Path(filename).name != filename or filename in {".", ".."}:
                raise ValueError()
            path = directory / filename
            if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
                raise ValueError()
            file_stat = path.stat()
            size = file_stat.st_size
            if not 0 < size <= MAX_MEDIA_BYTES or size != metadata["byteLength"]:
                raise ValueError()
            identity = (size, file_stat.st_mtime_ns, file_stat.st_ctime_ns, file_stat.st_ino, metadata["mimeType"])
            if verified_files.get(media_id) != identity:
                digest = hashlib.sha256(metadata["mimeType"].encode())
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                if digest.hexdigest() != media_id:
                    raise ValueError()
                verified_files[media_id] = identity
            return {**metadata, "id": media_id, "path": str(path.resolve()), "url": f"refora-asset://media/{media_id}"}
        except (OSError, ValueError, KeyError, TypeError):
            raise RepoError("file_missing", "This media file is no longer available") from None

    def public_resource(value: dict[str, Any]) -> dict[str, Any]:
        return {key: value[key] for key in ("id", "url", "kind", "fileName", "mimeType", "byteLength", "sourceUrl") if key in value}

    def publish_file(path: Path, mime: str, filename: Any, source_url: str | None = None) -> dict[str, Any]:
        layout()
        mime = _canonical_mime(mime)
        if path.is_symlink() or not path.is_file():
            raise RepoError("invalid_path", "Media must reference a regular file")
        staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=root))
        try:
            name = _file_name(filename, mime)
            digest = hashlib.sha256(mime.encode())
            size = 0
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream, (staging / name).open("wb") as output:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise RepoError("invalid_path", "Media must reference a regular file")
                prefix = stream.read(512)
                _check_magic(prefix, mime)
                output.write(prefix)
                digest.update(prefix)
                size += len(prefix)
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    size += len(chunk)
                    if size > MAX_MEDIA_BYTES:
                        raise RepoError("media_too_large", "Media exceeds the 100 MB limit")
                    digest.update(chunk)
                    output.write(chunk)
            if not 0 < size <= MAX_MEDIA_BYTES:
                raise RepoError("media_too_large", "Media must be non-empty and no larger than 100 MB")
            os.chmod(staging / name, 0o600)
            media_id = digest.hexdigest()
            with lock:
                destination = root / media_id
                if destination.exists():
                    try:
                        return public_resource(get_file(media_id))
                    except RepoError:
                        if destination.is_symlink():
                            raise
                        damaged = root / f".damaged-{uuid.uuid4().hex}"
                        destination.rename(damaged)
                        shutil.rmtree(damaged)
                        verified_files.pop(media_id, None)
                total = sum(entry.stat().st_size for entry in root.glob("*/*") if entry.is_file() and not entry.is_symlink())
                if total > MAX_CACHE_BYTES:
                    raise RepoError("media_cache_full", "The local media cache is full")
                metadata = {
                    "id": media_id, "kind": _kind(mime), "fileName": name,
                    "mimeType": mime, "byteLength": size,
                    "url": f"refora-asset://media/{media_id}",
                    **({"sourceUrl": source_url} if source_url else {}),
                }
                (staging / "resource.json").write_text(json.dumps(metadata), encoding="utf-8")
                staging.rename(destination)
                return metadata
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def inline_media(data_url: str, filename: Any = None) -> dict[str, Any]:
        if not isinstance(data_url, str) or len(data_url) > MAX_INLINE_BYTES * 4 // 3 + 1024:
            raise RepoError("media_too_large", "Inline media exceeds the 20 MB limit")
        match = _INLINE.fullmatch(data_url)
        if match is None or _canonical_mime(match[1]) not in _MIME_EXTENSIONS:
            raise RepoError("invalid_media", "Unsupported inline media format")
        try:
            content = base64.b64decode(re.sub(r"\s", "", match[2]), validate=True)
        except ValueError:
            raise RepoError("invalid_media", "Media data is not valid base64") from None
        if len(content) > MAX_INLINE_BYTES:
            raise RepoError("media_too_large", "Inline media exceeds the 20 MB limit")
        layout()
        fd, name = tempfile.mkstemp(prefix=".inline-", dir=root)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(content)
            return publish_file(Path(name), _canonical_mime(match[1]), filename)
        finally:
            Path(name).unlink(missing_ok=True)

    async def download(url: str, filename: Any = None) -> dict[str, Any]:
        layout()
        lookup = resolver or _resolve_addresses
        current = _normalize_url(url)
        source_url = current
        cache_key = hashlib.sha256(current.encode()).hexdigest()
        reference = root / f"remote-{cache_key}.json"
        if reference.is_file() and not reference.is_symlink():
            try:
                return public_resource(get_file(json.loads(reference.read_text())["id"]))
            except (OSError, ValueError, KeyError, RepoError):
                pass
        proxy_url = proxy() if proxy else ""
        owns_client = http_client is None
        client = http_client or httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False, **({"proxy": proxy_url} if proxy_url else {}))
        temporary: Path | None = None
        try:
            for hop in range(6):
                current = await asyncio.to_thread(_validate_public_url, current, lookup)
                async with client.stream("GET", current, headers={"Accept": "image/*, audio/*, video/*, application/pdf", "Accept-Encoding": "identity", "User-Agent": "Refora/0.1 media"}) as response:
                    if not proxy_url:
                        assert_public_peer(response)
                    if response.status_code in {301, 302, 303, 307, 308}:
                        target = response.headers.get("location")
                        if hop == 5 or not target:
                            raise RepoError("media_fetch_failed", "Media redirect could not be followed")
                        current = urljoin(current, target)
                        continue
                    if response.is_error:
                        raise RepoError("media_fetch_failed", f"Media request failed with HTTP {response.status_code}")
                    mime = _canonical_mime(response.headers.get("content-type", ""))
                    if mime not in _MIME_EXTENSIONS:
                        raise RepoError("unsupported_media", "The response is not a supported media or document file")
                    declared = response.headers.get("content-length")
                    if declared and (not declared.isdecimal() or int(declared) > MAX_MEDIA_BYTES):
                        raise RepoError("media_too_large", "Media exceeds the 100 MB limit")
                    fd, name = tempfile.mkstemp(prefix=".download-", dir=root)
                    temporary = Path(name)
                    size = 0
                    with os.fdopen(fd, "wb") as output:
                        async for chunk in response.aiter_bytes(64 * 1024):
                            size += len(chunk)
                            if size > MAX_MEDIA_BYTES:
                                raise RepoError("media_too_large", "Media exceeds the 100 MB limit")
                            output.write(chunk)
                    result = await asyncio.to_thread(publish_file, temporary, mime, filename or unquote(Path(urlsplit(current).path).name), source_url)
                    with lock:
                        reference.write_text(json.dumps({"id": result["id"]}), encoding="utf-8")
                    return result
            raise RepoError("media_fetch_failed", "Media could not be downloaded")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if owns_client:
                await client.aclose()

    async def resolve(request: dict[str, Any]) -> dict[str, Any]:
        source = request.get("source")
        if not isinstance(source, dict):
            raise RepoError("invalid_input", "Media source is required")
        kind = source.get("type")
        filename = request.get("fileName")
        if kind == "unavailable":
            raise RepoError("unsupported_media", str(source.get("reason") or "Media unavailable")[:500])
        if kind == "cached":
            return public_resource(await asyncio.to_thread(get_file, source.get("mediaId")))
        if kind == "inline":
            return await asyncio.to_thread(inline_media, source.get("dataUrl"), filename)
        if kind == "remote":
            url = source.get("url")
            if not isinstance(url, str):
                raise RepoError("invalid_input", "Media URL is required")
            task = remote_tasks.get(url)
            if task is None:
                task = asyncio.create_task(download(url, filename))
                remote_tasks[url] = task
                def completed(value: asyncio.Task[Any]) -> None:
                    if remote_tasks.get(url) is value:
                        remote_tasks.pop(url, None)
                    if not value.cancelled():
                        value.exception()
                task.add_done_callback(completed)
            try:
                return await asyncio.shield(task)
            finally:
                if task.done() and remote_tasks.get(url) is task:
                    remote_tasks.pop(url, None)
        if kind == "asset":
            asset, path = services["workspaces"]["resolveAssetFile"](source.get("assetId"))
            mime = asset.get("mimeType") or mimetypes.guess_type(path)[0] or "application/octet-stream"
            return await asyncio.to_thread(publish_file, Path(path), mime, filename or asset.get("fileName"))
        if kind == "ocr":
            path = source.get("path")
            if isinstance(path, str) and path.startswith("images/"):
                path = "assets/" + path[len("images/"):]
            if not isinstance(path, str) or not path.startswith("assets/"):
                raise RepoError("invalid_path", "OCR image path is invalid")
            resolved = services["ocr"]["resolveAsset"](source.get("documentId"), source.get("resultKey"), path[len("assets/"):])
            mime = mimetypes.guess_type(resolved)[0] or "application/octet-stream"
            return await asyncio.to_thread(publish_file, Path(resolved), mime, filename or Path(resolved).name)
        if kind == "sandbox":
            run = repos["agentRuns"]["get"](source.get("runId"))
            thread = repos["chat"]["getThread"](run["threadId"]) if run else None
            if thread is None:
                raise RepoError("not_found", "The media's conversation no longer exists")
            value = source.get("path")
            if not isinstance(value, str) or not value.startswith("outputs/") or any(part in {"..", "."} for part in value.split("/")) or "\\" in value:
                raise RepoError("invalid_path", "Only files in this run's outputs folder can be displayed")
            sandbox = data_root / ".refora" / "sandboxes" / (thread.get("workspaceId") or "global")
            path = sandbox / value
            try:
                path.resolve().relative_to((sandbox / "outputs").resolve())
                for parent in [path, *path.parents]:
                    if parent == data_root:
                        break
                    if parent.is_symlink():
                        raise ValueError()
            except ValueError:
                raise RepoError("invalid_path", "Media path is outside the run's outputs folder") from None
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            return await asyncio.to_thread(publish_file, path, mime, filename or path.name)
        raise RepoError("invalid_input", "Unsupported media source")

    async def persist(media: list[dict[str, Any]], request: dict[str, Any]) -> list[dict[str, Any]]:
        result = []
        for item in media:
            source = item.get("source") or {}
            if source.get("type") == "inline":
                try:
                    cached = await resolve({"source": source, "fileName": item.get("title")})
                    item = {**item, "kind": cached["kind"], "mimeType": cached["mimeType"], "source": {"type": "cached", "mediaId": cached["id"]}}
                except (OSError, ValueError, RepoError) as error:
                    item = {**item, "source": {"type": "unavailable", "reason": str(error)[:500]}}
            result.append(item)
        return result

    def text_preview(media_id: str) -> dict[str, Any]:
        resource = get_file(media_id)
        if not (resource["mimeType"].startswith("text/") or resource["mimeType"] in {"application/json", "application/xml", "application/x-yaml", "application/yaml"}):
            raise RepoError("unsupported_media", "Text preview is not available for this file")
        with open(resource["path"], "rb") as stream:
            content = stream.read(128 * 1024 + 1)
        return {"content": content[:128 * 1024].decode("utf-8", errors="replace"), "truncated": len(content) > 128 * 1024}

    async def destroy() -> None:
        tasks = list(remote_tasks.values())
        remote_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    return {"resolve": resolve, "getFile": get_file, "textPreview": text_preview, "persistMedia": persist, "destroy": destroy}
