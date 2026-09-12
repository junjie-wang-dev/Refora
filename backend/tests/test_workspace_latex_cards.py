import asyncio
import json
import sqlite3
from pathlib import Path

import pytest

from conftest import open_migrated_db
from refora_server.db import migrations
from refora_server.db.connection import _SqliteAdapter
from refora_server.repositories import create_repositories
from refora_server.repositories.errors import RepoError
from refora_server.services.workspaces import createWorkspacesService
from refora_server.services.latex import STARTER
from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor


@pytest.fixture
def board(tmp_path):
    seed = open_migrated_db()
    db = sqlite3.connect(':memory:', isolation_level=None, check_same_thread=False)
    seed.backup(db)
    seed.close()
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    repos = create_repositories(db)
    repos['settings'].set('libraryFolderPath', str(tmp_path))
    services = createWorkspacesService(repos, {'getSandboxPath': lambda identifier: str(tmp_path / identifier)})
    workspace = services['createWorkspace']('Writing')
    yield db, repos, services, workspace['id'], tmp_path
    db.close()


def test_create_project_pins_one_persistent_card_and_removal_keeps_sources(board):
    _, repos, services, ws, directory = board
    project = services['latexOperation'](ws, {'action': 'create', 'title': 'Paper', 'placement': {'x': 85, 'y': -30}})['project']
    items = repos['workspaceItems']['list'](ws)
    assert len(items) == 1
    assert (items[0]['kind'], items[0]['latexId'], items[0]['x'], items[0]['y']) == ('latex', project['id'], 85, -30)
    card = items[0]
    services['moveItem'](ws, card['id'], 400, 600, 3)
    services['resizeItem'](ws, card['id'], 420, 250)
    services['latexOperation'](ws, {'action': 'list'})
    current = repos['workspaceItems']['list'](ws)[0]
    assert (current['id'], current['x'], current['width']) == (card['id'], 400, 420)
    services['deleteItem'](ws, card['id'])
    assert len(services['latexOperation'](ws, {'action': 'list'})['projects']) == 1
    assert repos['workspaceItems']['list'](ws) == []
    assert (directory / ws / 'work/latex' / project['id'] / 'files/main.tex').is_file()
    services['addItems'](ws, 'latex', [project['id']], {'x': 10, 'y': 20})
    assert len(repos['workspaceItems']['list'](ws)) == 1


def test_existing_project_is_backfilled_once(board):
    _, repos, services, ws, directory = board
    identifier = 'a' * 32
    project_dir = directory / ws / 'work/latex' / identifier
    (project_dir / 'files').mkdir(parents=True)
    (project_dir / 'files/main.tex').write_text(STARTER)
    (project_dir / 'project.json').write_text(json.dumps({'id': identifier, 'title': 'Existing paper', 'rootFile': 'main.tex'}))
    services['latexOperation'](ws, {'action': 'list'})
    services['latexOperation'](ws, {'action': 'list'})
    assert len(repos['workspaceItems']['list'](ws)) == 1
    assert repos['workspaceItems']['getLatexProject'](identifier)['title'] == 'Existing paper'


def test_tex_import_creates_a_card_and_agent_can_read_it(board):
    _, repos, services, ws, directory = board
    source = directory / 'imported.tex'
    source.write_text(STARTER)
    result = asyncio.run(services['importWorkspaceFiles'](ws, [str(source)], {'x': 100, 'y': 120}))
    assert result['errors'] == []
    project = result['latexProjects'][0]
    item = repos['workspaceItems']['list'](ws)[0]
    assert item['latexId'] == project['id']
    deps = {'repos': repos, 'workspace_operation': lambda operation, *args: services[operation](*args)}
    agent = AgentToolExecutor(AgentToolContext(run_id='run', workspace_id=ws), deps)
    context = json.loads(agent.execute('list_workspace_context', {}))
    assert context['items'][0]['title'] == 'imported.tex'
    content = json.loads(agent.execute('read_workspace_item', {'itemId': item['id']}))
    assert content['data']['file']['content'] == STARTER
    other = services['createWorkspace']('Other')['id']
    with pytest.raises(RepoError):
        services['addItems'](other, 'latex', [project['id']])


def test_migration_preserves_cards_layout_and_connections(monkeypatch):
    all_migrations = migrations.load_migration_files()
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    with monkeypatch.context() as patch:
        patch.setattr(migrations, '_cached_migrations', [item for item in all_migrations if item.version < 47])
        migrations.run_migrations(_SqliteAdapter(db))
    repos = create_repositories(db)
    ws = repos['workspaces']['create']('Existing')['id']
    note = repos['workspaceNotes']['create'](ws, 'Note', 'Keep me', 'markdown')
    second = repos['workspaceNotes']['create'](ws, 'Second', '', 'markdown')
    for index, record in enumerate([note, second]):
        db.execute("INSERT INTO workspace_items(id, workspaceId, kind, noteId, sortOrder, x, y, addedAt) VALUES (?, ?, 'note', ?, ?, -75, 95, 1)", [f'card-{index}', ws, record['id'], index])
    cards = [dict(row) for row in db.execute('SELECT * FROM workspace_items ORDER BY sortOrder').fetchall()]
    edge = repos['workspaceConnections']['create'](ws, cards[0]['id'], cards[1]['id'], 'right', 'left')
    migrations.run_migrations(_SqliteAdapter(db))
    assert repos['workspaceItems']['list'](ws) == cards
    assert repos['workspaceConnections']['list'](ws) == [edge]
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    project = {'id': 'b' * 32, 'title': 'New paper', 'rootFile': 'main.tex'}
    assert repos['workspaceItems']['registerLatexProject'](ws, project)
    latex_card = repos['workspaceItems']['add'](ws, 'latex', [project['id']])[0]
    assert latex_card['kind'] == 'latex'
    db.execute('PRAGMA user_version = 46')
    migrations.run_migrations(_SqliteAdapter(db))
    assert repos['workspaceItems']['get'](latex_card['id']) == latex_card
    db.execute('DELETE FROM workspaces WHERE id = ?', [ws])
    assert db.execute('SELECT COUNT(*) FROM workspace_latex_projects').fetchone()[0] == 0
    assert db.execute('SELECT COUNT(*) FROM workspace_connections').fetchone()[0] == 0
    db.close()
