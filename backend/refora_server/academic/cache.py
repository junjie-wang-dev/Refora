from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
DEFAULT_MAX_BYTES = 512 * 1024 * 1024


def cache_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _now_ms() -> float:
    return time.time() * 1000.0


def _mtime_ms(path: Path) -> float:
    return path.stat().st_mtime * 1000.0


@dataclass
class CacheFile:
    path: str
    size: int
    modifiedAt: float


@dataclass
class CacheHit:
    value: Any
    fetchedAt: float


def _write_atomic_sync(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _list_files_sync(directory: Path) -> list[CacheFile]:
    files: list[CacheFile] = []
    try:
        entries = list(directory.iterdir())
    except FileNotFoundError:
        return files
    except OSError:
        return files
    for entry in entries:
        try:
            if entry.is_dir() and not entry.is_symlink():
                files.extend(_list_files_sync(entry))
            elif entry.is_file():
                details = entry.stat()
                files.append(
                    CacheFile(
                        path=str(entry),
                        size=details.st_size,
                        modifiedAt=details.st_mtime * 1000.0,
                    )
                )
        except OSError:
            continue
    return files


class AcademicCache:
    def __init__(self, root: str) -> None:
        self.root = root

    def path(self, *parts: str) -> str:
        return str(Path(self.root, *parts))

    async def get_json(self, namespace: str, key: str) -> Optional[CacheHit]:
        safe_namespace = re.sub(r"[^a-z0-9-]", "-", namespace, flags=re.IGNORECASE)
        path = Path(self.root, safe_namespace, f"{cache_hash(key)}.json")

        def _read() -> Optional[CacheHit]:
            try:
                envelope = json.loads(path.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, json.JSONDecodeError):
                _unlink_quiet(path)
                return None
            if not isinstance(envelope, dict):
                _unlink_quiet(path)
                return None
            if envelope.get("schemaVersion") != 1:
                _unlink_quiet(path)
                return None
            expires_at = envelope.get("expiresAt")
            if not isinstance(expires_at, (int, float)) or expires_at <= _now_ms():
                _unlink_quiet(path)
                return None
            return CacheHit(value=envelope.get("value"), fetchedAt=float(envelope.get("fetchedAt", 0)))

        return await asyncio.to_thread(_read)

    async def set_json(self, namespace: str, key: str, value: Any, ttl_ms: int) -> None:
        safe_namespace = re.sub(r"[^a-z0-9-]", "-", namespace, flags=re.IGNORECASE)
        path = Path(self.root, safe_namespace, f"{cache_hash(key)}.json")
        fetched_at = _now_ms()
        envelope = {
            "schemaVersion": 1,
            "fetchedAt": fetched_at,
            "expiresAt": fetched_at + ttl_ms,
            "value": value,
        }
        await asyncio.to_thread(_write_atomic_sync, path, json.dumps(envelope))

    async def prune(
        self,
        max_age_ms: Optional[int] = None,
        max_bytes: Optional[int] = None,
    ) -> dict[str, int]:
        max_age = max(0, DEFAULT_MAX_AGE_MS if max_age_ms is None else max_age_ms)
        max_bytes_value = max(0, DEFAULT_MAX_BYTES if max_bytes is None else max_bytes)
        cutoff = _now_ms() - max_age

        def _prune_sync() -> dict[str, int]:
            files = _list_files_sync(Path(self.root))
            deleted_files = 0
            deleted_bytes = 0
            remaining: list[CacheFile] = []
            for file in files:
                if file.modifiedAt <= cutoff or file.path.endswith(".tmp"):
                    target = Path(file.path)
                    try:
                        target.unlink()
                        deleted_files += 1
                        deleted_bytes += file.size
                        continue
                    except OSError:
                        remaining.append(file)
                else:
                    remaining.append(file)
            remaining_bytes = sum(f.size for f in remaining)
            remaining.sort(key=lambda f: f.modifiedAt)
            for file in remaining:
                if remaining_bytes <= max_bytes_value:
                    break
                try:
                    Path(file.path).unlink()
                    deleted_files += 1
                    deleted_bytes += file.size
                    remaining_bytes -= file.size
                except OSError:
                    continue
            return {
                "deletedFiles": deleted_files,
                "deletedBytes": deleted_bytes,
                "remainingBytes": remaining_bytes,
            }

        return await asyncio.to_thread(_prune_sync)

    async def read_text(self, path: str) -> str:
        def _read() -> str:
            return Path(path).read_text(encoding="utf-8")

        return await asyncio.to_thread(_read)

    async def write_text(self, path: str, content: str) -> None:
        await asyncio.to_thread(_write_atomic_sync, Path(path), content)


def create_academic_cache(root: str) -> AcademicCache:
    return AcademicCache(root)