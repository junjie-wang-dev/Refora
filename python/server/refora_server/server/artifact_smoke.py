from __future__ import annotations

import importlib
import sqlite3
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any, Final

from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.sqlite import SqliteSaver

from refora_server.agent.sandbox_backend import ReforaFilesystemBackend

REQUIRED_MODULES: Final[tuple[str, ...]] = (
    "deepagents",
    "deepagents.backends.filesystem",
    "deepagents.middleware.async_subagents",
    "deepagents.middleware.filesystem",
    "deepagents.middleware.subagents",
    "langchain",
    "langchain_openai",
    "langgraph",
    "langgraph.checkpoint.sqlite",
    "langgraph.checkpoint.sqlite.aio",
    "refora_server.academic.arxiv",
    "refora_server.academic.frontier",
    "refora_server.academic.graph",
    "refora_server.academic.semantic_scholar",
    "refora_server.agent.providers",
    "refora_server.agent.sandbox_backend",
    "refora_server.services.agent_runtime",
    "refora_server.services.mineru",
    "refora_server.services.ocr",
)

REQUIRED_DISTRIBUTIONS: Final[tuple[str, ...]] = (
    "deepagents",
    "langchain",
    "langchain-core",
    "langchain-openai",
    "langgraph",
    "langgraph-checkpoint-sqlite",
)


def verify_artifact() -> dict[str, Any]:
    for module in REQUIRED_MODULES:
        importlib.import_module(module)
    versions = {
        distribution: version(distribution)
        for distribution in REQUIRED_DISTRIBUTIONS
    }
    connection = sqlite3.connect(":memory:")
    try:
        checkpointer = SqliteSaver(connection)
        checkpointer.setup()
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        if not {"checkpoints", "writes"}.issubset(tables):
            raise RuntimeError("SQLite checkpointer did not initialize")
    finally:
        connection.close()
    with tempfile.TemporaryDirectory(prefix="refora-artifact-") as directory:
        backend = ReforaFilesystemBackend(Path(directory).resolve())
        written = backend.write("/tmp/artifact.txt", "ready")
        read = backend.read("/tmp/artifact.txt")
        if (
            written.error is not None
            or read.error is not None
            or read.file_data is None
            or read.file_data["content"] != "ready"
        ):
            raise RuntimeError("Filesystem backend smoke check failed")
        graph = create_deep_agent(
            model=FakeListChatModel(responses=["ready"]),
            tools=[],
            backend=backend,
            subagents=[
                {
                    "name": "artifact-check",
                    "description": "Verify packaged subagent support",
                    "system_prompt": "Return ready.",
                }
            ],
        )
        if graph is None:
            raise RuntimeError("Deep agent smoke check failed")
    return {
        "ok": True,
        "modules": list(REQUIRED_MODULES),
        "versions": versions,
    }
