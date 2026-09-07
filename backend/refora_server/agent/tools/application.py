from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

from refora_server.agent.tools.common import call, repo, value, workspace
from refora_server.agent.tools.registry import ToolGroup
from refora_server.repositories.documents import EDITABLE_FIELDS
from refora_server.services.workspace_note_input import WORKSPACE_NOTE_COLORS

Text = Annotated[str, Field(min_length=1)]
Ids = Annotated[list[Text], Field(min_length=1, max_length=100)]
Number = Annotated[float, Field(allow_inf_nan=False)]
Anchor = Literal['top', 'right', 'bottom', 'left']


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class CardLayout(Input):
    itemId: Text
    x: Number | None = None
    y: Number | None = None
    width: Annotated[int, Field(gt=0)] | None = None
    height: Annotated[int, Field(gt=0)] | None = None
    zIndex: int | None = None


class Placement(Input):
    x: Number
    y: Number


DocumentPatch = create_model(
    'DocumentPatch', __base__=Input,
    **{name: (str, None) for name in EDITABLE_FIELDS},
)
NotePatch = create_model(
    'NotePatch', __base__=Input,
    title=(Text, None), contentMd=(str, None),
    color=(Literal[tuple(sorted(WORKSPACE_NOTE_COLORS))], None),
)


class ApplicationTools(ToolGroup):
    name = 'application'
    handlers = {}
    schemas = {}
    descriptions = {}


def tool(name: str, description: str, *, scoped: bool = False, **fields: Any):
    if scoped:
        fields = {'workspaceId': (Text | None, Field(default=None, description='Target workspace ID from list_workspaces. Omit to use the current workspace.')), **fields}
    model = create_model(name + '_input', __base__=Input, **fields)

    def decorate(handler):
        def invoke(executor, args):
            parsed = model.model_validate(args).model_dump(exclude_unset=True)
            if scoped:
                parsed['workspaceId'] = workspace(executor, parsed)
                if call(repo(executor.repos, 'workspaces'), 'get', parsed['workspaceId']) is None:
                    raise ValueError('Workspace not found. Use list_workspaces to find its ID.')
            return handler(executor, parsed)
        ApplicationTools.handlers[name] = invoke
        ApplicationTools.schemas[name] = model.model_json_schema()
        ApplicationTools.descriptions[name] = description
        return handler
    return decorate


def service(executor, name, *args):
    return call(executor.deps, 'workspace_operation', name, *args)


def changed(executor, ws=None):
    if ws is not None:
        call(executor.deps, 'workspace_changed', ws, 'other')
    else:
        call(executor.deps, 'library_changed')


def transaction(executor, operation):
    return call(executor.repos, 'transaction', operation)


def scoped_record(executor, repository, identifier, ws):
    record = call(repo(executor.repos, repository), 'get', identifier)
    if record is None or record.get('workspaceId') != ws:
        raise ValueError('Record does not belong to the target workspace')
    return record


@tool('list_workspaces', 'List all local workspaces with IDs and names. Use workspaceId to operate on any workspace, including from a global chat.')
def list_workspaces(executor, args):
    return {'workspaces': service(executor, 'listWorkspaces'), 'currentWorkspaceId': value(executor.context, 'workspace_id')}


@tool('create_workspace', 'Create a workspace and its sandbox. Returns the new workspace ID; pass it to other workspace tools.', name_=(Text, Field(alias='name')))
def create_workspace(executor, args):
    result = service(executor, 'createWorkspaceWithSandbox', args['name_'])
    changed(executor)
    return result


@tool('rename_workspace', 'Rename a workspace. Its ID and contents stay attached to it.', scoped=True, name_=(Text, Field(alias='name')))
def rename_workspace(executor, args):
    result = service(executor, 'updateWorkspace', args['workspaceId'], args['name_'])
    changed(executor)
    return result


@tool('delete_workspace', 'Delete a workspace, its cards, notes, attachments and chats; library PDFs remain. Requires user approval. Run this from a different workspace or global chat to avoid deleting the running agent itself.', scoped=True)
def delete_workspace(executor, args):
    if args['workspaceId'] == value(executor.context, 'workspace_id'):
        raise ValueError('Cannot delete the workspace hosting this running agent. Use a global chat or another workspace.')
    service(executor, 'deleteWorkspace', args['workspaceId'])
    changed(executor)
    return {'deletedWorkspaceId': args['workspaceId']}


@tool('update_workspace_layout', 'Move and resize cards atomically. Coordinates and sizes are canvas pixels; x/y may be negative. zIndex controls stacking. Omitted fields preserve existing values. Read itemIds and geometry using list_workspace_context first.', scoped=True, items=(Annotated[list[CardLayout], Field(min_length=1, max_length=100)], ...))
def update_workspace_layout(executor, args):
    ws = args['workspaceId']
    layouts = args['items']
    if len({item['itemId'] for item in layouts}) != len(layouts):
        raise ValueError('Each itemId must appear only once')
    def update():
        result = []
        for patch in layouts:
            item = scoped_record(executor, 'workspaceItems', patch['itemId'], ws)
            fields = {key: val for key, val in patch.items() if key != 'itemId' and val is not None}
            if not fields:
                raise ValueError('Each card needs at least one layout field')
            merged = {**item, **fields}
            if {'x', 'y', 'zIndex'} & fields.keys():
                service(executor, 'moveItem', ws, item['id'], merged['x'], merged['y'], merged['zIndex'])
            if {'width', 'height'} & fields.keys():
                service(executor, 'resizeItem', ws, item['id'], merged['width'], merged['height'])
            result.append(call(repo(executor.repos, 'workspaceItems'), 'get', item['id']))
        return result
    result = transaction(executor, update)
    changed(executor, ws)
    return {'workspaceId': ws, 'items': result}


@tool('reorder_workspace_items', 'Set card order using all itemIds in the workspace, once each. This changes list order; use update_workspace_layout for positions and stacking.', scoped=True, itemIds=(Ids, ...))
def reorder_workspace_items(executor, args):
    result = service(executor, 'reorderItems', args['workspaceId'], args['itemIds'])
    changed(executor, args['workspaceId'])
    return {'items': result}


@tool('remove_workspace_items', 'Remove cards and their incident connections from the board. Underlying library PDFs, notes, reports and attachments remain available. Requires user approval.', scoped=True, itemIds=(Ids, ...))
def remove_workspace_items(executor, args):
    def remove():
        for identifier in dict.fromkeys(args['itemIds']):
            service(executor, 'deleteItem', args['workspaceId'], identifier)
    transaction(executor, remove)
    changed(executor, args['workspaceId'])
    return {'removedItemIds': args['itemIds']}


@tool('add_workspace_items', 'Pin existing library PDFs or workspace notes, reports and attachments to a workspace. Pass kind and native JSON ids array. Returns complete cards, including itemIds and geometry. Optional placement sets the starting canvas position.', scoped=True, kind=(Literal['document', 'note', 'report', 'asset'], ...), ids=(Ids, ...), placement=(Placement | None, None))
def add_workspace_items(executor, args):
    result = service(executor, 'addItems', args['workspaceId'], args['kind'], args['ids'], args.get('placement'))
    changed(executor, args['workspaceId'])
    return {'items': result}


@tool('set_workspace_canvas', 'Set the visible canvas pan and zoom. zoom is between 0.25 and 2.5. Read the existing viewport with list_workspace_context.', scoped=True, panX=(Number, ...), panY=(Number, ...), zoom=(Annotated[float, Field(ge=0.25, le=2.5, allow_inf_nan=False)], ...))
def set_workspace_canvas(executor, args):
    result = service(executor, 'putCanvas', args['workspaceId'], args['panX'], args['panY'], args['zoom'])
    call(executor.deps, 'workspace_changed', args['workspaceId'], 'agent_canvas')
    return result


@tool('update_workspace_connection', 'Update a directed connection by connectionId, preserving its ID. Omitted endpoints and anchors stay unchanged. Endpoints must be different cards in the target workspace.', scoped=True, connectionId=(Text, ...), sourceItemId=(Text, None), targetItemId=(Text, None), sourceAnchor=(Anchor, None), targetAnchor=(Anchor, None))
def update_workspace_connection(executor, args):
    ws = args['workspaceId']
    scoped_record(executor, 'workspaceConnections', args['connectionId'], ws)
    patch = {key: val for key, val in args.items() if key not in {'workspaceId', 'connectionId'}}
    if not patch:
        raise ValueError('At least one connection field is required')
    result = call(repo(executor.repos, 'workspaceConnections'), 'update', args['connectionId'], patch)
    changed(executor, ws)
    return result


@tool('delete_workspace_connections', 'Delete directed connections by connectionId. Cards remain. Requires user approval.', scoped=True, connectionIds=(Ids, ...))
def delete_workspace_connections(executor, args):
    transaction(executor, lambda: [service(executor, 'deleteConnection', args['workspaceId'], identifier) for identifier in dict.fromkeys(args['connectionIds'])])
    changed(executor, args['workspaceId'])
    return {'deletedConnectionIds': args['connectionIds']}


@tool('list_workspace_contents', 'List stored notes, reports and attachments, including objects whose cards were removed. Pin them again with add_workspace_items. For board cards and geometry use list_workspace_context.', scoped=True)
def list_workspace_contents(executor, args):
    ws = args['workspaceId']
    return {name: call(repo(executor.repos, repository), 'list', ws) for name, repository in [('notes', 'workspaceNotes'), ('reports', 'aiReports'), ('assets', 'workspaceAssets')]}


@tool('create_workspace_note', 'Create and pin a Markdown note (markdown) or sticky note (plain). Returns the note ID. Use list_workspace_context for its card itemId.', scoped=True, title=(Text, ...), contentMd=(str, ...), noteType=(Literal['markdown', 'plain'], 'markdown'), placement=(Placement | None, None))
def create_workspace_note(executor, args):
    result = service(executor, 'createNote', args['workspaceId'], args['title'], args['contentMd'], args.get('noteType', 'markdown'), args.get('placement'))
    changed(executor, args['workspaceId'])
    return result


@tool('update_workspace_note', 'Edit a note title, Markdown content or sticky-note color. Only fields in patch change. Read existing content before editing.', scoped=True, noteId=(Text, ...), patch=(NotePatch, ...))
def update_workspace_note(executor, args):
    if not args['patch']:
        raise ValueError('patch must contain at least one field')
    result = service(executor, 'updateNote', args['workspaceId'], args['noteId'], args['patch'])
    changed(executor, args['workspaceId'])
    return result


@tool('delete_workspace_note', 'Delete a note and its cards and connections permanently. Requires user approval.', scoped=True, noteId=(Text, ...))
def delete_workspace_note(executor, args):
    service(executor, 'deleteNote', args['workspaceId'], args['noteId'])
    changed(executor, args['workspaceId'])
    return {'deletedNoteId': args['noteId']}


@tool('delete_workspace_report', 'Delete a report and its cards and connections permanently. Requires user approval.', scoped=True, reportId=(Text, ...))
def delete_workspace_report(executor, args):
    scoped_record(executor, 'aiReports', args['reportId'], args['workspaceId'])
    call(repo(executor.repos, 'aiReports'), 'delete', args['reportId'])
    changed(executor, args['workspaceId'])
    return {'deletedReportId': args['reportId']}


@tool('import_workspace_files', 'Import local files into a workspace and pin cards: PDFs enter the library, Markdown becomes notes, other files become managed attachments. paths is a JSON array of absolute paths.', scoped=True, paths=(Ids, ...), placement=(Placement | None, None))
def import_workspace_files(executor, args):
    result = service(executor, 'importWorkspaceFiles', args['workspaceId'], args['paths'], args.get('placement'))
    changed(executor, args['workspaceId'])
    changed(executor)
    return result


@tool('update_workspace_asset', 'Rename a managed attachment or replace its content from a local sourcePath. Keeps asset ID and card positions. For text edits, supply contentText. Read the asset first and supply its expectedHash to reject stale edits. Source files are never modified.', scoped=True, assetId=(Text, ...), expectedHash=(Text, ...), fileName=(Text, None), contentText=(str, None), sourcePath=(Text, None))
def update_workspace_asset(executor, args):
    patch = {key: val for key, val in args.items() if key not in {'workspaceId', 'assetId'}}
    result = service(executor, 'updateAsset', args['workspaceId'], args['assetId'], patch)
    changed(executor, args['workspaceId'])
    return result


@tool('delete_workspace_asset', 'Delete a managed attachment and all of its cards. Moves the managed file to system Trash on a best-effort basis; the original imported file remains. Requires user approval.', scoped=True, assetId=(Text, ...))
def delete_workspace_asset(executor, args):
    service(executor, 'deleteAsset', args['workspaceId'], args['assetId'])
    changed(executor, args['workspaceId'])
    return {'deletedAssetId': args['assetId']}


@tool('list_categories', 'List all library categories, their IDs and document counts.')
def list_categories(executor, args):
    return {'categories': call(repo(executor.repos, 'categories'), 'list')}


@tool('create_category', 'Create a library category and return its ID. Use set_document_categories to classify papers.', name_=(Text, Field(alias='name')))
def create_category(executor, args):
    result = call(repo(executor.repos, 'categories'), 'create', args['name_'])
    changed(executor)
    return result


@tool('rename_category', 'Rename a category while preserving its paper assignments.', categoryId=(Text, ...), name_=(Text, Field(alias='name')))
def rename_category(executor, args):
    call(repo(executor.repos, 'categories'), 'rename', args['categoryId'], args['name_'])
    changed(executor)
    return {'categoryId': args['categoryId'], 'name': args['name_']}


@tool('delete_category', 'Delete a category and its assignments. Papers remain in the library. Requires user approval.', categoryId=(Text, ...))
def delete_category(executor, args):
    call(repo(executor.repos, 'categories'), 'delete', args['categoryId'])
    changed(executor)
    return {'deletedCategoryId': args['categoryId']}


@tool('set_document_categories', 'Assign or unassign one category for a batch of papers atomically; other categories remain. Use explicit action instead of toggling. This edits classification only.', docIds=(Ids, ...), categoryId=(Text, ...), action=(Literal['assign', 'unassign'], ...))
def set_document_categories(executor, args):
    categories = repo(executor.repos, 'categories')
    def update():
        if not any(item['id'] == args['categoryId'] for item in call(categories, 'list')):
            raise ValueError('Category not found')
        for identifier in dict.fromkeys(args['docIds']):
            if call(repo(executor.repos, 'documents'), 'get', identifier) is None:
                raise ValueError(f'Document not found: {identifier}')
            call(categories, args['action'], identifier, args['categoryId'])
    transaction(executor, update)
    changed(executor)
    return {'docIds': args['docIds'], 'categoryId': args['categoryId'], 'action': args['action']}


@tool('set_documents_starred', 'Set or clear stars for papers atomically. starred is an explicit boolean, making retries safe.', docIds=(Ids, ...), starred=(bool, ...))
def set_documents_starred(executor, args):
    def update():
        for identifier in dict.fromkeys(args['docIds']):
            if call(repo(executor.repos, 'documents'), 'get', identifier) is None:
                raise ValueError(f'Document not found: {identifier}')
            call(repo(executor.repos, 'documents'), 'setStarred', identifier, args['starred'])
    transaction(executor, update)
    changed(executor)
    return {'docIds': args['docIds'], 'starred': args['starred']}


@tool('update_document', 'Edit paper metadata and library notes. Only patch fields change; use get_paper_context first. Authors are a semicolon-separated string. File identity and AI settings are not editable.', docId=(Text, ...), patch=(DocumentPatch, ...))
def update_document(executor, args):
    if not args['patch']:
        raise ValueError('patch must contain at least one field')
    result = call(executor.deps, 'update_document', args['docId'], args['patch'])
    changed(executor)
    return result


@tool('import_pdfs', 'Import local PDF files into the library using the existing deduplicating importer. paths must be a JSON array of absolute .pdf paths. Returns imported documents, skipped files and errors.', paths=(Ids, ...))
def import_pdfs(executor, args):
    result = call(executor.deps, 'import_pdfs', args['paths'])
    changed(executor)
    return result


@tool('delete_documents', 'Delete papers from the library and every workspace. Moves existing library PDFs to system Trash on a best-effort basis and removes database records. Requires user approval; pass exact docIds from search_documents.', docIds=(Ids, ...))
def delete_documents(executor, args):
    result = call(executor.deps, 'delete_documents', args['docIds'])
    changed(executor)
    return result


@tool('refresh_document_metadata', 'Refresh a paper metadata using configured scholarly metadata services. Preserves fields manually edited in the application.', docId=(Text, ...))
def refresh_document_metadata(executor, args):
    result = call(executor.deps, 'refresh_document_metadata', args['docId'])
    changed(executor)
    return result


@tool('list_documents', 'List local papers with metadata, stars and categories. Optional categoryId, starred and workspaceId filters combine. Returns pagination; use nextOffset while hasMore. Use search_documents for text search.', categoryId=(Text, None), starred=(bool, None), workspaceId=(Text, None), limit=(Annotated[int, Field(ge=1, le=100)], 50), offset=(Annotated[int, Field(ge=0)], 0))
def list_documents(executor, args):
    limit, offset = args.get('limit', 50), args.get('offset', 0)
    filters = {**args, 'mode': 'category' if args.get('categoryId') else 'all', 'limit': limit + 1, 'offset': offset}
    documents = call(repo(executor.repos, 'documents'), 'list', filters)
    rows = [{**item, 'docId': item['id'], 'categories': call(repo(executor.repos, 'categories'), 'listForDocument', item['id'])} for item in documents[:limit]]
    return {'documents': rows, 'offset': offset, 'limit': limit, 'hasMore': len(documents) > limit, 'nextOffset': offset + limit if len(documents) > limit else None}
