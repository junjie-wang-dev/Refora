from __future__ import annotations

import os
import time

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from refora_server.agent.academic_artifacts import (
    ACADEMIC_ARTIFACT_MARKER_PREFIX,
    AcademicArtifactStore,
    academic_artifact_id_from_marker,
)
from refora_server.services.agent_runtime import AcademicRedactingSerializer


def test_serializer_externalizes_and_hydrates_academic_messages(tmp_path) -> None:
    store = AcademicArtifactStore(tmp_path / "academic-artifacts")
    serializer = AcademicRedactingSerializer(store)
    value = {
        "messages": [
            AIMessage(
                content="Calling the academic service",
                tool_calls=[
                    {
                        "id": "academic-call",
                        "name": "search_arxiv",
                        "args": {"query": "recoverable research"},
                    }
                ],
            ),
            ToolMessage(
                content="full paper data",
                artifact={"papers": [{"abstract": "long abstract"}]},
                name="search_arxiv",
                tool_call_id="academic-call",
            ),
        ]
    }

    stored = serializer._delegate.loads_typed(serializer.dumps_typed(value))
    marker = stored["messages"][1].response_metadata["__refora_academic_artifact__"]

    assert academic_artifact_id_from_marker(marker) is not None
    assert stored["messages"][1].content != "full paper data"
    assert serializer.loads_typed(serializer.dumps_typed(value)) == value


def test_markers_are_content_addressed_and_validated(tmp_path) -> None:
    store = AcademicArtifactStore(tmp_path)

    marker = store.write("json", b'{"paper":"recovered"}')

    assert marker.startswith(ACADEMIC_ARTIFACT_MARKER_PREFIX)
    assert len(academic_artifact_id_from_marker(marker) or "") == 64
    assert store.write("json", b'{"paper":"recovered"}') == marker
    assert academic_artifact_id_from_marker("refora-academic-artifact:v1:invalid") is None


def test_prune_removes_orphans_and_enforces_artifact_limit(tmp_path) -> None:
    store = AcademicArtifactStore(tmp_path)
    first = store.write("json", b"first")
    time.sleep(0.01)
    second = store.write("json", b"second")
    for path in tmp_path.rglob("*.json"):
        os.utime(path, (time.time() - 60, time.time() - 60))

    result = store.prune_artifacts(
        {academic_artifact_id_from_marker(second)},
        max_artifacts=0,
        orphan_age_seconds=24 * 60 * 60,
    )

    assert result.deleted_files == 1
    assert store.read(first) is None
    assert store.read(second) is not None


def test_delete_thread_artifacts_preserves_other_thread_references(tmp_path) -> None:
    store = AcademicArtifactStore(tmp_path)
    thread_marker = store.write("json", b"thread artifact")
    shared_marker = store.write("json", b"shared artifact")
    thread_id = academic_artifact_id_from_marker(thread_marker)
    shared_id = academic_artifact_id_from_marker(shared_marker)

    result = store.delete_thread_artifacts({thread_id, shared_id}, {shared_id})

    assert result.deleted_files == 1
    assert store.read(thread_marker) is None
    assert store.read(shared_marker) is not None


def test_write_rejects_artifacts_over_the_size_limit(tmp_path) -> None:
    store = AcademicArtifactStore(tmp_path, max_artifact_bytes=3)

    with pytest.raises(ValueError, match="too large"):
        store.write("json", b"four")
