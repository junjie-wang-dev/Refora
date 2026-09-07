from __future__ import annotations

from collections.abc import Mapping
from typing import Any


APPLICATION_ACTIONS = {
    'refora_library': {
        'list': 'list_documents',
        'search': 'search_documents',
        'context': 'get_paper_context',
        'read': 'read_paper',
        'open': 'open_paper',
        'related': 'find_related_papers',
        'import': 'import_pdfs',
        'update': 'update_document',
        'star': 'set_documents_starred',
        'delete': 'delete_documents',
        'refresh': 'refresh_document_metadata',
        'ocr': 'prepare_paper_ocr',
        'categories.list': 'list_categories',
        'categories.create': 'create_category',
        'categories.rename': 'rename_category',
        'categories.delete': 'delete_category',
        'categories.assign': 'set_document_categories',
    },
    'refora_workspace': {
        'list': 'list_workspaces',
        'create': 'create_workspace',
        'rename': 'rename_workspace',
        'delete': 'delete_workspace',
        'inspect': 'list_workspace_context',
        'read': 'read_workspace_item',
        'contents': 'list_workspace_contents',
        'cards.add': 'add_workspace_items',
        'cards.add_documents': 'add_docs_to_workspace',
        'cards.layout': 'update_workspace_layout',
        'cards.reorder': 'reorder_workspace_items',
        'cards.remove': 'remove_workspace_items',
        'canvas.set': 'set_workspace_canvas',
        'connections.create': 'create_workspace_connections',
        'connections.update': 'update_workspace_connection',
        'connections.delete': 'delete_workspace_connections',
        'notes.create': 'create_workspace_note',
        'notes.update': 'update_workspace_note',
        'notes.delete': 'delete_workspace_note',
        'reports.create': 'generate_report',
        'reports.update': 'update_report',
        'reports.delete': 'delete_workspace_report',
        'files.import': 'import_workspace_files',
        'assets.update': 'update_workspace_asset',
        'assets.delete': 'delete_workspace_asset',
    },
}

APPLICATION_OPERATIONS = {
    operation: (tool, action)
    for tool, actions in APPLICATION_ACTIONS.items()
    for action, operation in actions.items()
}

APPLICATION_GAPS = {
    'refora_library': [
        {'capability': 'pdf_annotations', 'status': 'unsupported', 'detail': 'PDF highlights, drawing, comments and annotation deletion have app APIs but no agent actions.'},
        {'capability': 'reader_state', 'status': 'unsupported', 'detail': 'Reader page, selection, zoom, rotation and bookmarks are not controlled by agent tools.'},
        {'capability': 'imports_and_exports', 'status': 'partial', 'detail': 'Local PDF import works. Folder, identifier, JSON, Zotero and Mendeley import, plus JSON/BibTeX/PDF export, have no direct agent actions.'},
        {'capability': 'file_recovery', 'status': 'unsupported', 'detail': 'Relocate, restore missing PDFs, and reveal in Finder are not exposed as agent actions.'},
        {'capability': 'watch_folders', 'status': 'unsupported', 'detail': 'Listing, adding, deleting and enabling watched folders have no agent actions.'},
        {'capability': 'preferences_and_library_switching', 'status': 'unsupported', 'detail': 'Theme, language, reader preferences, list columns and switching the active library are not exposed.'},
        {'capability': 'ocr_management', 'status': 'partial', 'detail': 'Balanced OCR and cached text are available. Other profiles, cancellation, job status and MinerU installation management are not exposed.'},
        {'capability': 'clipboard_and_ui', 'status': 'unsupported', 'detail': 'Clipboard, tab navigation, selections, panels and global search have no direct agent actions.'},
        {'capability': 'sync_account', 'status': 'unsupported', 'detail': 'Sign-in, synchronization, conflict resolution and account settings have no agent actions.'},
        {'capability': 'ai_self_management', 'status': 'excluded', 'detail': 'AI providers, API keys, profiles, model selection and the running agent are deliberately not exposed. Existing approved memory tools remain separate.'},
    ],
    'refora_workspace': [
        {'capability': 'workspace_content', 'status': 'supported', 'detail': 'Workspace, card, connection, note, report and attachment changes are supported, including layout and canvas view.'},
        {'capability': 'asset_native_actions', 'status': 'partial', 'detail': 'Import, edit and delete work. Opening, revealing and copying attachments have no direct agent actions. Unpinned attachments must be pinned before reading through the card reader.'},
        {'capability': 'workspace_ui', 'status': 'partial', 'detail': 'Persisted canvas pan and zoom work. Opening tabs, selecting cards, closing panels and fullscreen are not controlled by tools.'},
        {'capability': 'current_workspace_deletion', 'status': 'restricted', 'detail': 'Delete the workspace hosting the current run from a global chat or another workspace so the agent does not delete itself.'},
        {'capability': 'sandbox_folder', 'status': 'partial', 'detail': 'Sandbox file tools and artifact publishing remain available. Opening the sandbox in Finder has no agent action.'},
    ],
}


def resolve_application_call(name: str, arguments: Mapping[str, Any] | None) -> tuple[str, dict[str, Any]]:
    if not isinstance(arguments, Mapping) or set(arguments) - {'action', 'parameters'}:
        raise ValueError('Use only action and parameters. Call action=help to discover arguments.')
    action = arguments.get('action')
    parameters = arguments.get('parameters', {})
    if not isinstance(parameters, dict):
        raise ValueError('parameters must be a JSON object')
    if action == 'help':
        return '__application_help', parameters
    actions = APPLICATION_ACTIONS[name]
    if not isinstance(action, str) or action not in actions:
        raise ValueError(f'Unknown action for {name}. Call action=help for the available actions.')
    return actions[action], dict(parameters)


def public_tool_reference(operation: str) -> str:
    route = APPLICATION_OPERATIONS.get(operation)
    return f'{route[0]}(action="{route[1]}")' if route else operation
