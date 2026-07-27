from __future__ import annotations

import os

from refora_server.db.errors import RepoError


def resolvePdfFilePath(rawPath: str) -> str:
    if not rawPath or not os.path.isabs(rawPath):
        raise RepoError("invalid_path", "PDF path must be absolute")
    resolved = os.path.normpath(os.path.abspath(rawPath))
    if not resolved.lower().endswith(".pdf"):
        raise RepoError("invalid_path", "Selected file must be a PDF")
    if not os.path.exists(resolved):
        raise RepoError("file_missing", f"File not found: {resolved}")
    try:
        if os.path.islink(resolved) or not os.path.isfile(resolved):
            raise RepoError("invalid_path", "Selected path must be a regular PDF file")
    except RepoError:
        raise
    except Exception:
        raise RepoError("invalid_path", f"Unable to inspect PDF file: {resolved}")
    return resolved
