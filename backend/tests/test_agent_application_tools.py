from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest

from conftest import insert_doc, insert_run, insert_thread, open_migrated_db
from refora_server.agent.application_catalog import APPLICATION_ACTIONS, APPLICATION_OPERATIONS
from refora_server.agent.permissions import Mode, PermissionEngine
from refora_server.agent.risk import RiskClass, classify
from refora_server.agent.tools.application import ApplicationTools
from refora_server.repositories import RepositoryDeps, create_repositories
from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor, create_agent_tools
from refora_server.services.application_operations import trash_documents, update_document
from refora_server.services.workspaces import createWorkspacesService


@pytest.fixture
def app(tmp_path):
    seed = open_migrated_db()
    db = sqlite3.connect(":memory:", isolation_level=None, check_same_thread=False)
    seed.backup(db)
    seed.close()
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    library = tmp_path / 'library'
    library.mkdir()
    repos = create_repositories(db, RepositoryDeps(getLibraryFolder=lambda: str(library)))
    repos['settings'].set('libraryFolderPath', str(library))
    services = createWorkspacesService(repos)
    events = []
    def operation(name, *args):
        result = services[name](*args)
        return asyncio.run(result) if asyncio.iscoroutine(result) else result
    deps = {
        'repos': repos,
        'workspace_operation': operation,
        'inspect_workspace_asset': services['inspectAsset'],
        'preview_workspace_asset': services['previewAsset'],
        'workspace_changed': lambda *args: events.append(args),
        'library_changed': lambda: events.append(('library',)),
        'update_document': lambda identifier, patch: asyncio.run(update_document(repos['documents'], {}, identifier, patch)),
    }
    executor = AgentToolExecutor(AgentToolContext(run_id='run'), deps)
    def execute(name, args=None, call_id=None):
        if name in APPLICATION_OPERATIONS:
            name, action = APPLICATION_OPERATIONS[name]
            args = {'action': action, 'parameters': args or {}}
        return json.loads(executor.execute(name, args, call_id))
    yield db, repos, services, execute, events, tmp_path, deps
    db.close()


def create_board(app):
    db, repos, services, execute, events, tmp_path, deps = app
    ws = execute('create_workspace', {'name': 'Research'})
    assert 'error' not in ws, ws
    insert_doc(db, id='d1')
    insert_doc(db, id='d2')
    items = execute('add_workspace_items', {'workspaceId': ws['id'], 'kind': 'document', 'ids': ['d1', 'd2']})['items']
    return ws['id'], items


def test_global_agent_can_create_populate_inspect_and_layout_workspace(app):
    _, repos, _, execute, events, _, _ = app
    ws, items = create_board(app)
    assert execute('list_workspaces')['currentWorkspaceId'] is None
    result = execute('update_workspace_layout', {'workspaceId': ws, 'items': [
        {'itemId': items[0]['id'], 'x': -125.5, 'y': 400, 'width': 720, 'height': 440, 'zIndex': 10},
        {'itemId': items[1]['id'], 'x': 800},
    ]})
    assert 'error' not in result, result
    first = result['items'][0]
    assert [first[key] for key in ('x', 'y', 'width', 'height', 'zIndex')] == [-125.5, 400, 720, 440, 10]
    assert result['items'][1]['y'] == items[1]['y']
    context = execute('list_workspace_context', {'workspaceId': ws})
    assert context['items'][0]['width'] == 720
    assert context['canvas']['zoom'] == 1
    assert execute('set_workspace_canvas', {'workspaceId': ws, 'panX': 200, 'panY': -25, 'zoom': 1.5})['zoom'] == 1.5
    assert (ws, 'agent_canvas') in events
    assert repos['workspaceCanvas']['get'](ws)['panY'] == -25


def test_batch_layout_rolls_back_on_wrong_workspace_and_rejects_invalid_numbers(app):
    _, repos, _, execute, _, _, _ = app
    ws, items = create_board(app)
    other = execute('create_workspace', {'name': 'Other'})['id']
    foreign = execute('add_workspace_items', {'workspaceId': other, 'kind': 'document', 'ids': ['d1']})['items'][0]
    result = execute('update_workspace_layout', {'workspaceId': ws, 'items': [
        {'itemId': items[0]['id'], 'x': 999}, {'itemId': foreign['id'], 'x': 12},
    ]})
    assert 'error' in result
    assert repos['workspaceItems']['get'](items[0]['id'])['x'] == items[0]['x']
    for patch in [{'width': 0}, {'width': True}, {'x': float('nan')}, {'y': float('inf')}, {'width': '500'}, {'filePath': '/tmp/file.pdf'}]:
        assert 'error' in execute('update_workspace_layout', {'workspaceId': ws, 'items': [{'itemId': items[0]['id'], **patch}]})


def test_connection_edit_preserves_identity_and_rejects_duplicates_and_foreign_endpoints(app):
    _, repos, _, execute, _, _, _ = app
    ws, items = create_board(app)
    result = execute('create_workspace_connections', {'workspaceId': ws, 'connections': [{'sourceItemId': items[0]['id'], 'targetItemId': items[1]['id']}]})
    connection = result['created'][0]
    updated = execute('update_workspace_connection', {'workspaceId': ws, 'connectionId': connection['id'], 'sourceAnchor': 'top'})
    assert updated['id'] == connection['id'] and updated['sourceAnchor'] == 'top'
    reverse = repos['workspaceConnections']['create'](ws, items[1]['id'], items[0]['id'], 'top', 'bottom')
    assert 'error' in execute('update_workspace_connection', {'workspaceId': ws, 'connectionId': connection['id'], 'sourceItemId': items[1]['id'], 'targetItemId': items[0]['id']})
    assert 'error' in execute('update_workspace_connection', {'workspaceId': ws, 'connectionId': connection['id'], 'targetItemId': 'missing'})
    assert len(repos['workspaceConnections']['list'](ws)) == 2
    assert 'error' not in execute('delete_workspace_connections', {'workspaceId': ws, 'connectionIds': [connection['id'], reverse['id']]})
    assert repos['workspaceConnections']['list'](ws) == []


def test_notes_reports_and_unpinning_have_distinct_lifecycles(app):
    _, repos, _, execute, _, _, _ = app
    ws, items = create_board(app)
    note = execute('create_workspace_note', {'workspaceId': ws, 'title': 'Idea', 'contentMd': 'Old', 'noteType': 'plain'})
    assert 'error' not in note, note
    assert execute('update_workspace_note', {'workspaceId': ws, 'noteId': note['id'], 'patch': {'contentMd': 'New', 'color': 'coral'}})['contentMd'] == 'New'
    assert 'error' not in execute('remove_workspace_items', {'workspaceId': ws, 'itemIds': [items[0]['id']]})
    assert repos['documents']['get']('d1') is not None
    assert execute('list_workspace_contents', {'workspaceId': ws})['notes'][0]['id'] == note['id']
    assert 'error' not in execute('delete_workspace_note', {'workspaceId': ws, 'noteId': note['id']})
    assert repos['workspaceNotes']['get'](note['id']) is None
    report = execute('generate_report', {'workspaceId': ws, 'title': 'Report', 'contentMd': 'Body', 'sourceDocIds': ['d2']})
    assert 'error' not in execute('delete_workspace_report', {'workspaceId': ws, 'reportId': report['reportId']})
    assert all(item.get('reportId') != report['reportId'] for item in repos['workspaceItems']['list'](ws))


def test_library_metadata_stars_and_categories_are_explicit_and_atomic(app):
    _, repos, _, execute, events, _, _ = app
    create_board(app)
    category = execute('create_category', {'name': 'Methods'})
    assert 'error' not in category, category
    assert 'error' not in execute('rename_category', {'categoryId': category['id'], 'name': 'Reading'})
    assert 'error' not in execute('set_document_categories', {'docIds': ['d1', 'd2'], 'categoryId': category['id'], 'action': 'assign'})
    assert len(repos['categories']['listForDocument']('d1')) == 1
    assert 'error' in execute('set_documents_starred', {'docIds': ['d1', 'missing'], 'starred': True})
    assert repos['documents']['get']('d1')['starred'] == 0
    assert 'error' not in execute('set_documents_starred', {'docIds': ['d1', 'd2'], 'starred': True})
    assert repos['documents']['get']('d1')['starred'] == 1
    assert execute('update_document', {'docId': 'd1', 'patch': {'title': 'Updated', 'note': 'Read next'}})['title'] == 'Updated'
    assert 'error' in execute('update_document', {'docId': 'd1', 'patch': {'filePath': '/private/data.pdf'}})
    assert 'error' not in execute('delete_category', {'categoryId': category['id']})
    assert repos['categories']['listForDocument']('d1') == []
    assert repos['documents']['get']('d1') is not None
    assert ('library',) in events


def test_attachment_edits_preserve_card_identity_validate_hash_and_keep_source(app):
    _, repos, service, execute, _, tmp_path, _ = app
    ws, _ = create_board(app)
    source = tmp_path / 'data.txt'
    source.write_text('Original')
    asset = service['importAssets'](ws, [str(source)])['imported'][0]
    card = next(item for item in repos['workspaceItems']['list'](ws) if item.get('assetId') == asset['id'])
    result = execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': asset['fileHash'], 'contentText': 'Edited', 'fileName': 'renamed.txt'})
    assert 'error' not in result, result
    assert service['previewAsset'](ws, asset['id'])['content'] == 'Edited'
    assert source.read_text() == 'Original'
    assert repos['workspaceItems']['get'](card['id']) == card
    assert 'error' in execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': asset['fileHash'], 'contentText': 'Stale'})
    assert 'error' in execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': result['fileHash'], 'fileName': '../escape.txt'})
    assert service['previewAsset'](ws, asset['id'])['content'] == 'Edited'


def test_attachment_restores_file_on_database_error(app, monkeypatch):
    _, repos, service, execute, _, tmp_path, _ = app
    ws, _ = create_board(app)
    source = tmp_path / 'data.txt'
    source.write_text('Original')
    asset = service['importAssets'](ws, [str(source)])['imported'][0]
    def fail(*args):
        raise RuntimeError('database failed')
    monkeypatch.setitem(repos['workspaceAssets'], 'update', fail)
    result = execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': asset['fileHash'], 'contentText': 'Edited', 'fileName': 'new.txt'})
    assert 'error' in result
    assert service['previewAsset'](ws, asset['id'])['content'] == 'Original'
    assert repos['workspaceAssets']['get'](asset['id'])['fileName'] == 'data.txt'


def test_attachment_detects_external_changes_and_replaces_binary_content(app):
    _, repos, service, execute, _, tmp_path, _ = app
    ws, _ = create_board(app)
    source = tmp_path / 'data.bin'
    source.write_bytes(b'old')
    replacement = tmp_path / 'replacement.bin'
    replacement.write_bytes(b'new\x00data')
    asset = service['importAssets'](ws, [str(source)])['imported'][0]
    result = execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': asset['fileHash'], 'sourcePath': str(replacement)})
    assert 'error' not in result, result
    _, managed = service['resolveAssetFile'](asset['id'])
    assert Path(managed).read_bytes() == replacement.read_bytes()
    Path(managed).write_bytes(b'external change')
    assert 'error' in execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': result['fileHash'], 'fileName': 'new.bin'})


def test_tool_effect_replay_creates_only_one_workspace(app):
    db, repos, _, execute, _, _, _ = app
    insert_thread(db, id='thread')
    insert_run(db, id='run', threadId='thread')
    first = execute('create_workspace', {'name': 'Once'}, 'call-1')
    second = execute('create_workspace', {'name': 'Once'}, 'call-1')
    assert first == second and 'error' not in first, first
    assert len(repos['workspaces']['list']()) == 1


@pytest.mark.parametrize('name', list(ApplicationTools.handlers))
def test_application_tool_policy_and_schemas(name):
    engine = PermissionEngine()
    risk = classify(name)
    assert risk in {RiskClass.READ, RiskClass.WRITE_LOCAL, RiskClass.DESTRUCTIVE}
    engine.allow_tool_for_session(name)
    decision = engine.evaluate(name, {})
    assert decision.needs_user is (risk is RiskClass.DESTRUCTIVE)
    assert decision.allowed is (risk is not RiskClass.DESTRUCTIVE)
    if risk is not RiskClass.READ:
        assert not PermissionEngine(mode=Mode.PLAN).evaluate(name, {}).allowed
    schema = ApplicationTools.schemas[name]
    assert schema['additionalProperties'] is False


def test_structured_tool_native_arrays_and_aliases_are_callable(app):
    _, repos, _, _, _, _, deps = app
    tools = {item.name: item for item in create_agent_tools(AgentToolContext(run_id='run'), deps)}
    created = json.loads(tools['refora_workspace'].invoke({'action': 'create', 'parameters': {'name': 'Tool API'}}))
    assert created['name'] == 'Tool API'
    assert repos['workspaces']['get'](created['id']) is not None
    assert json.loads(tools['refora_workspace'].invoke({'action': 'list'}))['workspaces'][0]['id'] == created['id']


def test_trash_deletion_uses_native_connector_even_on_failure_and_cascades(app):
    db, repos, _, execute, _, tmp_path, _ = app
    ws, items = create_board(app)
    pdf = tmp_path / 'library' / 'paper.pdf'
    pdf.write_bytes(b'%PDF-1.4')
    repos['documents']['updateFilePath']('d1', str(pdf), 'paper.pdf')
    trashed = []
    async def trash(path):
        trashed.append(path)
        raise RuntimeError('Native Trash unavailable')
    result = asyncio.run(trash_documents(repos['documents'], repos['settings'], {'trash_item': trash}, repos['transaction'], ['d1']))
    assert result == {'ack': True}
    assert trashed == [str(pdf)]
    assert pdf.exists()
    assert repos['documents']['get']('d1') is None
    assert repos['workspaceItems']['get'](items[0]['id']) is None


def test_cannot_delete_current_running_workspace(app):
    _, repos, _, execute, _, _, deps = app
    ws, _ = create_board(app)
    executor = AgentToolExecutor(AgentToolContext(run_id='run', workspace_id=ws), deps)
    assert 'error' in json.loads(executor.execute('delete_workspace', {}))
    assert repos['workspaces']['get'](ws) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize('decision', ['approve', 'reject'])
async def test_cli_deletion_requires_exact_approval_and_never_grants_session_access(app, decision):
    from refora_server.cli_runtime.tool_broker import CliToolBroker
    _, repos, _, execute, _, tmp_path, deps = app
    ws, items = await asyncio.to_thread(create_board, app)
    tools = create_agent_tools(AgentToolContext(run_id='run'), deps)
    broker = CliToolBroker(str(tmp_path), 'http://127.0.0.1:1', 'token')
    broker.open_run('run', tools)
    token = broker._runs['run']['token']
    args = {'action': 'cards.remove', 'parameters': {'workspaceId': ws, 'itemIds': [items[0]['id']]}}
    task = asyncio.create_task(broker.call_tool('run', token, 'refora_workspace', args))
    try:
        actions = await asyncio.wait_for(broker.next_approvals('run'), 2)
        assert actions[0]['args'] == args
        assert repos['workspaceItems']['get'](items[0]['id']) is not None
        assert not task.done()
        broker.resolve_approvals('run', [{'type': decision}])
        if decision == 'reject':
            with pytest.raises(PermissionError):
                await task
            assert repos['workspaceItems']['get'](items[0]['id']) is not None
        else:
            assert 'error' not in json.loads(await task)
            assert repos['workspaceItems']['get'](items[0]['id']) is None
            assert repos['documents']['get']('d1') is not None
        assert broker._runs['run']['permissions'].evaluate('refora_workspace', args).needs_user
    finally:
        broker.close_run('run')
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def test_filtered_document_inventory_exposes_stars_categories_and_pagination(app):
    _, repos, _, execute, _, _, _ = app
    ws, _ = create_board(app)
    category = execute('create_category', {'name': 'Reading'})
    execute('set_document_categories', {'docIds': ['d1', 'd2'], 'categoryId': category['id'], 'action': 'assign'})
    execute('set_documents_starred', {'docIds': ['d1'], 'starred': True})
    first = execute('list_documents', {'categoryId': category['id'], 'limit': 1})
    assert first['hasMore'] is True and first['nextOffset'] == 1
    filtered = execute('list_documents', {'categoryId': category['id'], 'starred': True, 'workspaceId': ws})
    assert [doc['docId'] for doc in filtered['documents']] == ['d1']
    assert filtered['documents'][0]['categories'][0]['id'] == category['id']


def test_reading_attachment_after_external_edit_provides_a_fresh_edit_hash(app):
    _, repos, service, execute, _, tmp_path, _ = app
    ws, _ = create_board(app)
    source = tmp_path / 'data.txt'
    source.write_text('Original')
    asset = service['importAssets'](ws, [str(source)])['imported'][0]
    _, managed = service['resolveAssetFile'](asset['id'])
    Path(managed).write_text('External edit')
    card = next(item for item in repos['workspaceItems']['list'](ws) if item.get('assetId') == asset['id'])
    current = execute('read_workspace_item', {'workspaceId': ws, 'itemId': card['id']})['data']
    assert current['fileHash'] != asset['fileHash']
    assert current['preview']['content'] == 'External edit'
    result = execute('update_workspace_asset', {'workspaceId': ws, 'assetId': asset['id'], 'expectedHash': current['fileHash'], 'contentText': 'Merged edit'})
    assert 'error' not in result
    assert Path(managed).read_text() == 'Merged edit'


def test_compact_tools_preserve_every_existing_application_operation(app):
    from refora_server.agent.tools.library import LibraryTools
    from refora_server.agent.tools.workspace import WorkspaceTools
    from refora_server.services.agent_tools import agent_tool_names
    expected = set(ApplicationTools.handlers) | set(LibraryTools.handlers) | set(WorkspaceTools.handlers) | {'prepare_paper_ocr'}
    assert set(APPLICATION_OPERATIONS) == expected
    assert len(agent_tool_names()) == 12
    assert not expected.intersection(agent_tool_names())
    _, _, _, execute, _, _, deps = app
    for name, actions in APPLICATION_ACTIONS.items():
        catalog = execute(name, {'action': 'help'})
        assert {entry['action'] for entry in catalog['actions']} == set(actions)
        for action in actions:
            help_ = execute(name, {'action': 'help', 'parameters': {'action': action}})
            assert len(help_['actions']) == 1
            assert help_['actions'][0]['parametersSchema']['type'] == 'object'
    tools = create_agent_tools(AgentToolContext(run_id='run'), deps, legacy_names=('delete_documents',))
    assert len(tools) == 13 and tools[-1].name == 'delete_documents'
    assert PermissionEngine().evaluate(tools[-1].name, {'docIds': ['d1']}).needs_user


@pytest.mark.parametrize('tool,action,operation', [(tool, action, operation) for tool, actions in APPLICATION_ACTIONS.items() for action, operation in actions.items()])
def test_compact_permissions_classify_the_action_not_the_container(tool, action, operation):
    engine = PermissionEngine()
    args = {'action': action, 'parameters': {}}
    engine.allow_tool_for_session(tool)
    engine.allow_tool_for_session(operation)
    risk = classify(operation)
    assert classify(tool, arguments=args) is risk
    actual = engine.evaluate(tool, args)
    assert actual.allowed is (risk in {RiskClass.READ, RiskClass.WRITE_LOCAL})
    assert actual.needs_user is (risk is RiskClass.DESTRUCTIVE)
    for mode in (Mode.PLAN, Mode.DISCUSS):
        actual = PermissionEngine(mode=mode).evaluate(tool, args)
        assert actual.allowed is (risk is RiskClass.READ)


def test_invalid_compact_calls_return_corrective_schema_and_cannot_dispatch(app):
    _, repos, _, execute, _, _, _ = app
    for args in [
        {'action': 'delete_everything'},
        {'action': 'create', 'parameters': []},
        {'action': 'create', 'parameters': {'name': 'Unsafe', 'sql': 'DELETE FROM documents'}},
        {'action': 'create', 'parameters': {}},
        {'action': 'list', 'operation': 'delete'},
    ]:
        result = execute('refora_workspace', args)
        assert result['error']['code'] == 'invalid_tool_arguments'
        assert result['error']['details']['nextCall']['action'] == 'help'
    result = execute('refora_workspace', {'action': 'create', 'parameters': {}})
    assert result['error']['details']['parametersSchema']['required'] == ['name']
    assert repos['workspaces']['list']() == []
    for args in [{'action': 'delete_everything'}, {'action': 'list', 'operation': 'delete'}]:
        decision = PermissionEngine().evaluate('refora_workspace', args)
        assert not decision.allowed and not decision.needs_user


def test_readonly_tools_keep_discovery_and_reads_but_reject_forged_mutations(app):
    from refora_server.services.agent_tools import readonly_agent_tools, select_agent_tools
    _, repos, _, _, _, _, deps = app
    tools = create_agent_tools(AgentToolContext(run_id='run'), deps)
    readers = {tool.name: tool for tool in readonly_agent_tools(tools)}
    for name in APPLICATION_ACTIONS:
        reader = readers[name]
        catalog = json.loads(reader.invoke({'action': 'help'}))
        assert all(entry['readOnly'] for entry in catalog['actions'])
        assert 'delete' not in reader.args_schema['properties']['action']['enum']
        assert 'error' in json.loads(reader.invoke({'action': 'delete', 'parameters': {}}))
        assert 'error' in json.loads(reader.invoke({'action': 'help', 'parameters': {'action': 'delete'}}))
        assert 'error' not in json.loads(reader.invoke({'action': 'list'}))
    narrowed = select_agent_tools(tools, {'search_documents', 'list_workspace_context'})
    assert {tool.name for tool in narrowed} == set(APPLICATION_ACTIONS)
    for tool in narrowed:
        assert 'error' in json.loads(tool.invoke({'action': 'create', 'parameters': {'name': 'No'}}))
    assert repos['workspaces']['list']() == []


def test_ocr_missing_result_points_to_the_compact_action(app):
    _, _, _, execute, _, _, deps = app
    create_board(app)
    deps['read_ocr_fulltext'] = lambda identifier: None
    result = execute('refora_library', {'action': 'read', 'parameters': {'docId': 'd1', 'source': 'ocr'}})
    assert result['nextTool'] == 'refora_library' and result['nextAction'] == 'ocr'
    assert 'prepare_paper_ocr' not in result['instruction']
    assert 'refora_library(action="ocr")' in result['instruction']


def test_capability_audit_is_available_to_the_agent_without_writes(app):
    _, repos, _, execute, _, _, _ = app
    library = execute('refora_library', {'action': 'help', 'parameters': {'coverage': True}})
    statuses = {entry['capability']: entry['status'] for entry in library['coverage']}
    assert statuses['pdf_annotations'] == 'unsupported'
    assert statuses['reader_state'] == 'unsupported'
    assert statuses['ai_self_management'] == 'excluded'
    assert repos['workspaces']['list']() == []
