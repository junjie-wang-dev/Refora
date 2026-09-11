from __future__ import annotations

import os
from typing import Any

from refora_server.library.paths import isInsideLibrary
from refora_server.server.services.library_route_support import call, connector_call, value


async def trash_merged_pdfs(documents: Any, settings: Any, connector: Any, sources: list[dict[str, Any]], primary: dict[str, Any]) -> None:
    library = value(settings, "get")("libraryFolderPath", "")
    if not isinstance(library, str) or not library:
        return
    primary_path = primary.get("filePath")
    primary_path = os.path.realpath(primary_path) if isinstance(primary_path, str) and primary_path else None
    processed: set[str] = set()
    for source in sources:
        path = source.get("filePath")
        if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".pdf"):
            continue
        resolved = os.path.realpath(path)
        if resolved == primary_path or resolved in processed or os.path.islink(path) or not os.path.isfile(path) or not isInsideLibrary(resolved, library):
            continue
        processed.add(resolved)
        finder = value(documents, "findByPath")
        if not callable(finder) or await call(documents, "findByPath", resolved) is not None:
            continue
        try:
            await connector_call(connector, "trash", resolved)
        except Exception:
            pass
