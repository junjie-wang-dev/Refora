from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

ACADEMIC_ARTIFACT_MARKER_KEY = "__refora_academic_artifact__"
ACADEMIC_ARTIFACT_MARKER_PREFIX = "refora-academic-artifact:v1:"
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_ARTIFACTS = 1024
DEFAULT_ORPHAN_AGE_SECONDS = 24 * 60 * 60

_ARTIFACT_ID_RE = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class AcademicArtifact:
    type: str
    data: bytes


@dataclass(frozen=True)
class ArtifactCleanupResult:
    deleted_files: int
    deleted_bytes: int
    remaining_bytes: int
    remaining_files: int


@dataclass(frozen=True)
class _ArtifactFile:
    id: str | None
    path: Path
    size: int
    modified_at: float
    temporary: bool


def academic_artifact_id_from_marker(value: object) -> str | None:
    if not isinstance(value, str) or not value.startswith(ACADEMIC_ARTIFACT_MARKER_PREFIX):
        return None
    artifact_id = value.removeprefix(ACADEMIC_ARTIFACT_MARKER_PREFIX)
    return artifact_id if _ARTIFACT_ID_RE.fullmatch(artifact_id) else None


class AcademicArtifactStore:
    def __init__(
        self,
        root: str | Path,
        *,
        max_artifact_bytes: int = MAX_ARTIFACT_BYTES,
    ) -> None:
        self.root = Path(root)
        self.max_artifact_bytes = max(0, max_artifact_bytes)

    def write(self, type_name: str, data: bytes) -> str:
        if len(data) > self.max_artifact_bytes:
            raise ValueError("Academic checkpoint artifact is too large")
        artifact_id = self._artifact_id(type_name, data)
        path = self._path_for(artifact_id)
        if path.is_file():
            return self._marker_for(artifact_id)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        encoded = json.dumps(
            {
                "version": 1,
                "type": type_name,
                "data": base64.b64encode(data).decode("ascii"),
                "createdAt": int(time.time() * 1000),
            },
            separators=(",", ":"),
        ).encode("utf-8")
        descriptor, temporary = tempfile.mkstemp(
            prefix=f"{artifact_id}.json.", suffix=".tmp", dir=path.parent
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                descriptor = -1
                file.write(encoded)
            os.replace(temporary, path)
        finally:
            if descriptor != -1:
                os.close(descriptor)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        return self._marker_for(artifact_id)

    def read(self, marker: str) -> AcademicArtifact | None:
        artifact_id = academic_artifact_id_from_marker(marker)
        if artifact_id is None:
            return None
        path = self._path_for(artifact_id)
        try:
            if path.stat().st_size > self.max_artifact_bytes * 2:
                return None
            stored = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(stored, dict)
                or stored.get("version") != 1
                or not isinstance(stored.get("type"), str)
                or not isinstance(stored.get("data"), str)
            ):
                return None
            data = base64.b64decode(stored["data"], validate=True)
            if (
                len(data) > self.max_artifact_bytes
                or self._artifact_id(stored["type"], data) != artifact_id
            ):
                return None
            os.utime(path, None)
            return AcademicArtifact(stored["type"], data)
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    def prune_artifacts(
        self,
        referenced_ids: set[str],
        *,
        max_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES,
        max_artifacts: int = DEFAULT_MAX_ARTIFACTS,
        orphan_age_seconds: int = DEFAULT_ORPHAN_AGE_SECONDS,
    ) -> ArtifactCleanupResult:
        files = self._files()
        remaining_bytes = sum(file.size for file in files)
        remaining_files = len(files)
        deleted_files = 0
        deleted_bytes = 0
        cutoff = time.time() - max(0, orphan_age_seconds)
        removable: list[_ArtifactFile] = []

        for file in files:
            if file.temporary or (
                file.id is not None
                and file.id not in referenced_ids
                and file.modified_at <= cutoff
            ):
                if self._delete(file.path):
                    deleted_files += 1
                    deleted_bytes += file.size
                    remaining_bytes -= file.size
                    remaining_files -= 1
                continue
            if file.id is not None and file.id not in referenced_ids:
                removable.append(file)

        for file in sorted(removable, key=lambda item: item.modified_at):
            if remaining_bytes <= max(0, max_bytes) and remaining_files <= max(0, max_artifacts):
                break
            if self._delete(file.path):
                deleted_files += 1
                deleted_bytes += file.size
                remaining_bytes -= file.size
                remaining_files -= 1

        return ArtifactCleanupResult(
            deleted_files, deleted_bytes, remaining_bytes, remaining_files
        )

    def delete_thread_artifacts(
        self, candidate_ids: set[str], referenced_ids: set[str]
    ) -> ArtifactCleanupResult:
        deleted_files = 0
        deleted_bytes = 0
        for artifact_id in candidate_ids - referenced_ids:
            if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
                continue
            path = self._path_for(artifact_id)
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if self._delete(path):
                deleted_files += 1
                deleted_bytes += size
        files = self._files()
        return ArtifactCleanupResult(
            deleted_files,
            deleted_bytes,
            sum(file.size for file in files),
            len(files),
        )

    def _artifact_id(self, type_name: str, data: bytes) -> str:
        digest = hashlib.sha256()
        digest.update(type_name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        return digest.hexdigest()

    def _marker_for(self, artifact_id: str) -> str:
        return f"{ACADEMIC_ARTIFACT_MARKER_PREFIX}{artifact_id}"

    def _path_for(self, artifact_id: str) -> Path:
        if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
            raise ValueError("Invalid academic artifact ID")
        return self.root / artifact_id[:2] / f"{artifact_id}.json"

    def _files(self) -> list[_ArtifactFile]:
        if not self.root.is_dir():
            return []
        files: list[_ArtifactFile] = []
        for path in self.root.rglob("*"):
            if not path.is_file():
                continue
            match = re.fullmatch(r"([a-f0-9]{64})\.json", path.name)
            temporary = re.fullmatch(r"[a-f0-9]{64}\.json\..+\.tmp", path.name) is not None
            if match is None and not temporary:
                continue
            try:
                details = path.stat()
            except OSError:
                continue
            files.append(
                _ArtifactFile(
                    match.group(1) if match else None,
                    path,
                    details.st_size,
                    details.st_mtime,
                    temporary,
                )
            )
        return files

    @staticmethod
    def _delete(path: Path) -> bool:
        try:
            path.unlink()
            return True
        except OSError:
            return False
