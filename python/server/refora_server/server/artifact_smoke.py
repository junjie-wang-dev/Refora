from __future__ import annotations

import asyncio
import importlib
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any, Final

import aiosqlite
from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

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
    "aiosqlite",
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

    async def verify_checkpointer() -> None:
        connection = await aiosqlite.connect(":memory:")
        try:
            checkpointer = AsyncSqliteSaver(connection)
            await checkpointer.setup()
            async with connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ) as cursor:
                tables = {row[0] for row in await cursor.fetchall()}
            if not {"checkpoints", "writes"}.issubset(tables):
                raise RuntimeError("SQLite checkpointer did not initialize")
        finally:
            await connection.close()

    asyncio.run(verify_checkpointer())
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
