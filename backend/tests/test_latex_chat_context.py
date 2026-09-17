import json

import pytest

from conftest import open_migrated_db
from refora_server.db.connection import _SqliteAdapter
from refora_server.db.migrations import run_migrations
from refora_server.repositories import create_repositories
from refora_server.services import agent_intent
from refora_server.services.agent_tools import AgentToolContext, AgentToolExecutor, create_agent_tools
from refora_server.services.latex_chat import validate_latex_context


def test_latex_context_migration_preserves_runs_and_restores_history():
    db = open_migrated_db()
    repos = create_repositories(db)
    thread = repos['chat']['createThread'](None, 'provider')
    old = repos['agentRuns']['create']({'threadId': thread['id'], 'providerId': 'provider', 'modelId': 'model'})
    db.execute('ALTER TABLE agent_runs DROP COLUMN latexContext')
    db.execute('PRAGMA user_version = 48')
    result = run_migrations(_SqliteAdapter(db))
    assert result.to_version == 49
    assert repos['agentRuns']['get'](old['id']) == old
    context = {'projectId': 'project', 'path': 'main.tex', 'selection': {'startLine': 2, 'endLine': 4}, 'intent': 'proofread'}
    message = repos['chat']['addMessage'](thread['id'], 'user', 'Proofread\nmain.tex:2-4')
    run = repos['agentRuns']['create']({'threadId': thread['id'], 'providerId': 'provider', 'modelId': 'model', 'userMessageId': message['id'], 'latexContext': context})
    assert repos['agentRuns']['get'](run['id'])['latexContext'] == context
    assert repos['chat']['listMessages'](thread['id'])[0]['latexContext'] == context
    assert repos['chat']['listMessagesPage'](thread['id'])['messages'][0]['latexContext'] == context
    run_migrations(_SqliteAdapter(db))
    assert repos['agentRuns']['get'](run['id'])['latexContext'] == context
    db.close()


@pytest.mark.asyncio
async def test_latex_turn_excludes_workspace_history_memory_attachments_and_checkpoints(monkeypatch, tmp_path):
    async def provider_config(*args, **kwargs):
        return {'model': 'test'}
    monkeypatch.setattr(agent_intent, 'agent_profile_config', provider_config)
    monkeypatch.setattr(agent_intent, 'ensure_memory_files', lambda *_: pytest.fail('No memory should be loaded'))
    monkeypatch.setattr(agent_intent, 'read_memories', lambda *_: pytest.fail('No memory should be loaded'))
    context = {'projectId': 'paper', 'path': 'main.tex', 'intent': 'proofread', 'selection': {'startLine': 3, 'endLine': 5}}
    profile = {'id': 'api', 'kind': 'api', 'apiProviderId': 'api'}
    thread = {'id': 'thread', 'workspaceId': 'ws', 'providerId': 'api', 'agentStateVersion': agent_intent.AGENT_STATE_VERSION, 'headCheckpointId': 'workspace-checkpoint'}
    history = [
        {'role': 'user', 'content': 'PRIVATE WORKSPACE OPERATION'},
        {'role': 'assistant', 'content': 'PRIVATE WORKSPACE INVENTORY'},
        {'role': 'user', 'content': 'Other paper', 'latexContext': {'projectId': 'other'}},
        {'role': 'user', 'content': 'Earlier LaTeX question', 'latexContext': context},
        {'role': 'assistant', 'content': 'Earlier LaTeX answer', 'latexContext': context},
    ]
    repos = {'workspaces': {'list': lambda: [{'id': 'ws'}]}, 'agentProfiles': {'get': lambda _: profile}, 'chat': {'getThread': lambda _: thread, 'listMessages': lambda _: history}}
    calls = []
    services = {'workspaces': {'latexOperation': lambda ws, request: calls.append((ws, request)) or {'file': {'content': 'source'}}}}
    result = await agent_intent.assemble_turn({'runId': 'r', 'threadId': 'thread', 'workspaceId': 'ws', 'providerId': 'api', 'latexContext': context, 'text': 'Proofread\nmain.tex:3-5', 'attachments': [{'type': 'asset', 'assetId': 'private'}]}, repos=repos, services=services, connector=None, db_path=str(tmp_path / 'db'), library_folder=str(tmp_path))
    assert calls == [('ws', {'action': 'read', 'projectId': 'paper', 'path': 'main.tex'})]
    assert result['userText'] == 'Proofread\nmain.tex:3-5'
    assert result['messages'] == [{'role': 'user', 'content': 'Earlier LaTeX question'}, {'role': 'assistant', 'content': 'Earlier LaTeX answer'}, {'role': 'user', 'content': result['userText']}]
    assert 'Correct grammar' in result['systemPrompt']
    assert 'paper catalog' not in result['systemPrompt']
    assert result['checkpointBefore'] is None
    assert result['cliContinueSession'] is False
    assert result['enabledToolNames'] == ['edit_latex_project']
    assert result['memories'] == {}
    assert result['attachments'] == []
    run = {'id': 'r', 'threadId': 'thread', 'providerId': 'api', 'modelId': 'test', 'latexContext': context, 'status': 'running'}
    repos['agentRuns'] = {'get': lambda _: run}
    for build, request in [(agent_intent.assemble_resume, {'runId': 'r', 'threadId': 'thread'}), (agent_intent.assemble_recovery, run)]:
        resumed = await build(request, repos=repos, services=services, connector=None, db_path=str(tmp_path / 'db'), library_folder=str(tmp_path))
        assert resumed['latexContext'] == context
        assert resumed['systemPrompt'] == result['systemPrompt']
        assert resumed['enabledToolNames'] == ['edit_latex_project']
        assert resumed['memories'] == {}


@pytest.mark.parametrize('context', [True, {}, {'projectId': 'p', 'path': 'x', 'systemPrompt': 'injected'}, {'projectId': 'p', 'path': 'x', 'selection': {'startLine': 5, 'endLine': 2}}, {'projectId': 'p', 'path': 'x', 'selection': {'startLine': True, 'endLine': 2}}])
def test_invalid_latex_context_is_rejected(context):
    with pytest.raises(ValueError):
        validate_latex_context(context, 'ws', {})


def test_latex_tool_scope_cannot_escape_to_other_projects_or_workspace_operations():
    context = AgentToolContext(run_id='run', workspace_id='ws', latex_context={'projectId': 'paper', 'path': 'main.tex'})
    tools = create_agent_tools(context, {})
    assert [tool.name for tool in tools] == ['edit_latex_project']
    assert 'cards' not in tools[0].description
    executor = AgentToolExecutor(context, {})
    for name, args in [('refora_workspace', {'action': 'cards.layout'}), ('edit_latex_project', {'operation': 'read', 'projectId': 'other'}), ('edit_latex_project', {'operation': 'read', 'workspaceId': 'other'}), ('edit_latex_project', {'operation': 'asset'})]:
        assert 'error' in json.loads(executor.execute(name, args))
