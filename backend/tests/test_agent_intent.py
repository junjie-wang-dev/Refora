import pytest

from refora_server.services import agent_intent
from refora_server.services.agent_intent import (
    MAX_RECURSION_LIMIT,
    SYSTEM_PROMPT,
    WORKSPACE_SYSTEM_PROMPT,
    _turn_messages,
)


def test_agent_tool_step_limit_is_500():
    assert MAX_RECURSION_LIMIT == 500


def test_system_prompt_restores_academic_web_frontier_report_and_memory_boundaries():
    assert "untrusted evidence" in SYSTEM_PROMPT
    assert "globally latest" in SYSTEM_PROMPT
    assert "Markdown links for external sources" in SYSTEM_PROMPT
    assert "/research.md limited to durable research summaries" in SYSTEM_PROMPT


def test_workspace_prompt_routes_structured_reports_directly_to_the_board():
    assert "call generate_report" in WORKSPACE_SYSTEM_PROMPT
    assert "directly on the Workspace board" in WORKSPACE_SYSTEM_PROMPT
    assert "do not substitute a sandbox Markdown file" in WORKSPACE_SYSTEM_PROMPT
    assert "call list_workspace_context" in WORKSPACE_SYSTEM_PROMPT
    assert "do not infer the complete workspace from the paper catalog" in WORKSPACE_SYSTEM_PROMPT
    assert "read_workspace_item" in WORKSPACE_SYSTEM_PROMPT
    assert "call update_report" in WORKSPACE_SYSTEM_PROMPT


def test_checkpoint_continuation_sends_only_the_new_user_message():
    history = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
    ]

    assert _turn_messages(history, "new question", "checkpoint-1") == [
        {"role": "user", "content": "new question"}
    ]
    assert _turn_messages(history, "new question", None) == [
        *history,
        {"role": "user", "content": "new question"},
    ]


def test_api_profile_native_search_follows_responses_api_support():
    profile = {
        "kind": "api",
        "nativeWebSearch": True,
        "webSearchPolicy": "auto",
    }

    native = agent_intent._agent_capabilities(
        profile,
        {"useResponsesApi": True},
        {},
    )
    fallback = agent_intent._agent_capabilities(
        profile,
        {"useResponsesApi": False},
        {},
    )

    assert native["useNativeWebSearch"] is True
    assert "web_search" not in native["enabledToolNames"]
    assert fallback["useNativeWebSearch"] is False
    assert "web_search" in fallback["enabledToolNames"]


@pytest.mark.asyncio
async def test_recovery_rebuilds_the_persisted_active_reader_context(
    monkeypatch,
    tmp_path,
):
    async def fake_provider_config(*args, **kwargs):
        return {"model": "model-1"}

    monkeypatch.setattr(agent_intent, "provider_config", fake_provider_config)
    monkeypatch.setattr(agent_intent, "ensure_memory_files", lambda repos, workspace_id: None)
    monkeypatch.setattr(agent_intent, "read_memories", lambda repos, workspace_id: {})
    repos = {
        "chat": {
            "getThread": lambda thread_id: {
                "id": thread_id,
                "workspaceId": None,
            },
            "listMessages": lambda thread_id: [],
        },
        "documents": {
            "get": lambda document_id: {
                "id": document_id,
                "title": "Reader paper",
                "authors": "Researcher",
                "year": "2026",
            },
        },
        "aiSummaries": {"getSummary": lambda document_id: None},
    }

    result = await agent_intent.assemble_recovery(
        {
            "id": "run-reader",
            "threadId": "thread-global",
            "providerId": "provider-1",
            "modelId": "model-1",
            "status": "running",
            "activeDocumentId": "doc-reader",
        },
        repos=repos,
        services={},
        connector=None,
        db_path=str(tmp_path / "library.sqlite"),
        library_folder=str(tmp_path),
    )

    assert result["activeDocumentId"] == "doc-reader"
    assert "A paper is open in the active reader tab" in result["systemPrompt"]
    assert "docId=doc-reader | Reader paper" in result["systemPrompt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("previous", "selected", "expected_checkpoint", "continue_cli"),
    [
        ("api-one", "cli-one", None, False),
        ("cli-one", "api-one", None, False),
        ("cli-one", "cli-two", None, False),
        ("cli-one", "cli-one", None, True),
        ("api-one", "api-one", "api-checkpoint", True),
        ("api-one", "api-two", "api-checkpoint", False),
        ("deleted-profile", "api-one", None, False),
    ],
)
async def test_turn_context_follows_execution_backend_compatibility(
    monkeypatch, tmp_path, previous, selected, expected_checkpoint, continue_cli
):
    async def provider_config(*_args, **_kwargs):
        return {"model": "test-model"}

    monkeypatch.setattr(agent_intent, "agent_profile_config", provider_config)
    monkeypatch.setattr(agent_intent, "ensure_memory_files", lambda *_args: None)
    monkeypatch.setattr(agent_intent, "read_memories", lambda *_args: {})
    profiles = {
        name: {
            "id": name,
            "kind": name.split("-")[0],
            "apiProviderId": name if name.startswith("api") else None,
            "cliRuntimeId": "codex" if name.startswith("cli") else None,
        }
        for name in ("api-one", "api-two", "cli-one", "cli-two")
    }
    thread = {
        "id": "thread-1",
        "workspaceId": None,
        "providerId": previous,
        "agentProfileId": previous,
        "agentStateVersion": agent_intent.AGENT_STATE_VERSION,
        "headCheckpointId": "api-checkpoint",
    }
    history = [
        {"role": "user", "content": "Research robust training"},
        {"role": "assistant", "content": "Compare distribution shifts"},
    ]
    repos = {
        "agentProfiles": {"get": profiles.get},
        "chat": {"getThread": lambda _id: thread, "listMessages": lambda _id: history},
    }

    result = await agent_intent.assemble_turn(
        {"runId": "run-1", "threadId": "thread-1", "agentProfileId": selected, "text": "Continue"},
        repos=repos,
        services={},
        connector=None,
        db_path=str(tmp_path / "library.sqlite"),
        library_folder=str(tmp_path),
    )

    assert result["checkpointBefore"] == expected_checkpoint
    assert result["cliContinueSession"] is continue_cli
    assert result["messages"] == (
        [{"role": "user", "content": "Continue"}]
        if expected_checkpoint
        else [*history, {"role": "user", "content": "Continue"}]
    )
