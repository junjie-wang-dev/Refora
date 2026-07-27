from __future__ import annotations

import os
import stat
from pathlib import Path, PurePosixPath
from typing import Final

from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.protocol import (
    EditResult,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)

SANDBOX_DIRECTORIES: Final[tuple[str, ...]] = (
    "work",
    "scripts",
    "outputs",
    "tmp",
    "env",
)


class ReforaFilesystemBackend(FilesystemBackend):
    def __init__(
        self,
        sandbox_root: str | Path,
        max_file_size_mb: int = 10,
    ) -> None:
        raw_root = Path(sandbox_root)
        if not raw_root.is_absolute():
            raise ValueError("Sandbox root must be an absolute path")
        root = raw_root.resolve()
        root.mkdir(parents=True, exist_ok=True)
        for directory in SANDBOX_DIRECTORIES:
            target = root / directory
            target.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(os.lstat(target).st_mode) or not target.is_dir():
                raise ValueError("Sandbox directories must be real directories")
        super().__init__(
            root_dir=root,
            virtual_mode=True,
            max_file_size_mb=max_file_size_mb,
        )

    def _virtual_parts(self, path: str) -> tuple[str, ...]:
        if not isinstance(path, str) or not path or "\x00" in path:
            raise ValueError("Sandbox path must be a non-empty virtual path")
        stripped = path.lstrip("/")
        if stripped.startswith("~"):
            raise ValueError("Sandbox home expansion is not allowed")
        parts = tuple(
            part for part in PurePosixPath(stripped).parts if part not in ("", ".")
        )
        if ".." in parts:
            raise ValueError("Sandbox path traversal is not allowed")
        if parts and parts[0] not in SANDBOX_DIRECTORIES:
            raise ValueError("Sandbox path must use an approved directory")
        return parts

    def _resolve_path(self, key: str) -> Path:
        parts = self._virtual_parts(key)
        candidate = self.cwd.joinpath(*parts)
        current = self.cwd
        for part in parts:
            current = current / part
            try:
                mode = os.lstat(current).st_mode
            except FileNotFoundError:
                break
            if stat.S_ISLNK(mode):
                raise ValueError("Sandbox symlinks are not allowed")
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self.cwd)
        except ValueError:
            raise ValueError("Sandbox path is outside the sandbox root") from None
        return resolved

    def ls(self, path: str) -> LsResult:
        try:
            self._resolve_path(path)
            return super().ls(path)
        except (OSError, RuntimeError, ValueError) as error:
            return LsResult(error=str(error))

    def read(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 2000,
    ) -> ReadResult:
        try:
            self._resolve_path(file_path)
            return super().read(file_path, offset, limit)
        except (OSError, RuntimeError, ValueError) as error:
            return ReadResult(error=str(error))

    def write(self, file_path: str, content: str) -> WriteResult:
        try:
            self._resolve_path(file_path)
            return super().write(file_path, content)
        except (OSError, RuntimeError, ValueError) as error:
            return WriteResult(error=str(error))

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        try:
            self._resolve_path(file_path)
            return super().edit(
                file_path,
                old_string,
                new_string,
                replace_all,
            )
        except (OSError, RuntimeError, ValueError) as error:
            return EditResult(error=str(error))

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            self._validate_search_pattern(pattern)
            if path is not None:
                self._resolve_path(path)
            return super().glob(pattern, path)
        except (OSError, RuntimeError, ValueError) as error:
            return GlobResult(error=str(error), matches=[])

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
    ) -> GrepResult:
        try:
            if path is not None:
                self._resolve_path(path)
            if glob is not None:
                self._validate_search_pattern(glob)
            return super().grep(pattern, path, glob)
        except (OSError, RuntimeError, ValueError) as error:
            return GrepResult(error=str(error), matches=[])

    def upload_files(
        self,
        files: list[tuple[str, bytes]],
    ) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for path, content in files:
            try:
                self._resolve_path(path)
            except (OSError, RuntimeError, ValueError):
                responses.append(
                    FileUploadResponse(path=path, error="invalid_path")
                )
                continue
            responses.extend(super().upload_files([(path, content)]))
        return responses

    def download_files(
        self,
        paths: list[str],
    ) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for path in paths:
            try:
                self._resolve_path(path)
            except (OSError, RuntimeError, ValueError):
                responses.append(
                    FileDownloadResponse(
                        path=path,
                        content=None,
                        error="invalid_path",
                    )
                )
                continue
            responses.extend(super().download_files([path]))
        return responses

    def _validate_search_pattern(self, pattern: str) -> None:
        if not isinstance(pattern, str) or "\x00" in pattern:
            raise ValueError("Sandbox search pattern is invalid")
        stripped = pattern.lstrip("/")
        if stripped.startswith("~") or ".." in PurePosixPath(stripped).parts:
            raise ValueError("Sandbox search traversal is not allowed")
        parts = PurePosixPath(stripped).parts
        if pattern.startswith("/") and parts and parts[0] not in SANDBOX_DIRECTORIES:
            raise ValueError("Sandbox search path must use an approved directory")


def create_refora_filesystem_backend(
    sandbox_root: str | Path,
) -> ReforaFilesystemBackend:
    return ReforaFilesystemBackend(sandbox_root)
