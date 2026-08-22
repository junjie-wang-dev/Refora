from refora_server.services.agent_checkpoint import (
    ACADEMIC_PERSISTENCE_REDACTION as CHECKPOINT_REDACTION,
)
from refora_server.services.agent_checkpoint import (
    AcademicRedactingSerializer as CheckpointSerializer,
)
from refora_server.services.agent_events import (
    _event_delta,
    _streamed_tool_call_previews,
    _without_secrets,
)
from refora_server.services.agent_runtime import (
    ACADEMIC_PERSISTENCE_REDACTION,
    AcademicRedactingSerializer,
)


def test_agent_runtime_preserves_checkpoint_exports():
    assert AcademicRedactingSerializer is CheckpointSerializer
    assert ACADEMIC_PERSISTENCE_REDACTION == CHECKPOINT_REDACTION


def test_agent_event_helpers_preserve_stream_and_redaction_behavior():
    event = {
        "data": {
            "chunk": {
                "content": "answer",
                "additional_kwargs": {"reasoning_content": "analysis"},
            }
        }
    }

    assert _event_delta(event, False) == "answer"
    assert _event_delta(event, True) == "analysis"
    assert _without_secrets(
        {"apiKey": "secret", "nested": [{"authorization": "bearer"}]}
    ) == {
        "apiKey": "[redacted]",
        "nested": [{"authorization": "[redacted]"}],
    }


def test_agent_event_helpers_preserve_streamed_activity_slots():
    assert _streamed_tool_call_previews(
        {
            "tool_call_chunks": [
                {"name": "write_file", "index": 3},
                {"name": "search_documents", "index": 4},
                {"name": "write_todos", "index": True},
            ]
        }
    ) == [(3, "write_file"), (2, "write_todos")]
