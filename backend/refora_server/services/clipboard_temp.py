from __future__ import annotations

import os
import shutil
import stat
import tempfile
import time
from pathlib import Path
from typing import Any


_PREFIX = "refora-clipboard-"
_RETENTION_SECONDS = 24 * 60 * 60


def create_clipboard_temp_service(
    root: str | None = None,
    *,
    retention_seconds: int = _RETENTION_SECONDS,
    clock: Any = time.time,
) -> dict[str, Any]:
    temp_root = Path(root or tempfile.gettempdir()).resolve()

    def cleanup_stale() -> int:
        removed = 0
        cutoff = float(clock()) - retention_seconds
        try:
            entries = list(temp_root.iterdir())
        except OSError:
            return 0
        for entry in entries:
            if not entry.name.startswith(_PREFIX):
                continue
            try:
                metadata = entry.lstat()
            except OSError:
                continue
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                continue
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                continue
            if metadata.st_mtime > cutoff:
                continue
            try:
                shutil.rmtree(entry)
                removed += 1
            except OSError:
                continue
        return removed

    def create_markdown(file_name: str, markdown: str) -> str:
        if Path(file_name).name != file_name or not file_name:
            raise ValueError("Clipboard file name is invalid")
        cleanup_stale()
        directory = Path(
            tempfile.mkdtemp(prefix=_PREFIX, dir=str(temp_root))
        )
        directory.chmod(0o700)
        path = directory / file_name
        try:
            descriptor = os.open(
                path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(markdown)
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        return str(path)

    def discard(path: str) -> None:
        candidate = Path(path)
        parent = candidate.parent
        if (
            parent.parent.resolve() != temp_root
            or not parent.name.startswith(_PREFIX)
        ):
            return
        try:
            metadata = parent.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                return
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                return
            shutil.rmtree(parent)
        except OSError:
            return

    return {
        "cleanupStale": cleanup_stale,
        "createMarkdown": create_markdown,
        "discard": discard,
    }


__all__ = ["create_clipboard_temp_service"]
