from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from refora_server.library.paths import isInsideLibrary
from refora_server.library.pdf_path import resolvePdfFilePath
from refora_server.repositories.documents import validatePatch
from refora_server.server.services.library_route_support import call, connector_call, value
from refora_server.server.services.run_blocking import run_blocking


async def trash_documents(documents, settings, connector, transaction, document_ids):
    library_folder = value(settings, 'get')('libraryFolderPath', '')
    prepare = value(documents, 'prepareDeletion')
    prepared = await run_blocking(prepare, document_ids) if callable(prepare) else None
    items = [await call(documents, 'get', identifier) for identifier in document_ids]
    def cleanup():
        if prepared is not None:
            value(documents, 'archiveDeletion')(document_ids, prepared)
        bulk_delete = value(documents, 'bulkDelete')
        if callable(bulk_delete):
            bulk_delete(document_ids)
        else:
            for identifier in document_ids:
                value(documents, 'delete')(identifier)
    transaction(cleanup) if callable(transaction) else cleanup()
    for item in items:
        if isinstance(item, Mapping) and item.get('fileMissing') != 1:
            path = item.get('filePath')
            if (
                isinstance(path, str) and os.path.isabs(path)
                and path.lower().endswith('.pdf') and not os.path.islink(path)
                and os.path.isfile(path) and isinstance(library_folder, str)
                and bool(library_folder) and isInsideLibrary(path, library_folder)
            ):
                try:
                    await connector_call(connector, 'trash', path)
                except Exception:
                    pass
    return {'ack': True}


async def update_document(documents, metadata, identifier: str, patch: dict[str, Any]):
    validatePatch(patch)
    patch = dict(patch)
    if 'arxivId' in patch:
        patch['arxivId'] = await call(metadata, 'verifyArxivId', identifier, patch['arxivId'])
    return await call(documents, 'update', identifier, patch)


async def import_pdfs(importer, paths: list[str]):
    return await call(importer, 'importFiles', [resolvePdfFilePath(path) for path in paths])
