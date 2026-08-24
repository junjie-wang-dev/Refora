import asyncio
import threading
import time

import pytest

from refora_server.server.services.academic_runtime import create_academic_runtime
from refora_server.server.services.library_route_support import (
    call_in_thread,
    list_column_state,
    markdown_file_name,
)


def test_academic_runtime_is_unavailable_without_document_repository():
    assert create_academic_runtime({}, "/tmp/library", lambda: "") == {
        "services": {}
    }


def test_library_route_support_normalizes_user_facing_state():
    assert markdown_file_name('A/B: Paper.md') == "A-B- Paper.md"
    assert list_column_state({"columns": [], "sort": {}}) is None


@pytest.mark.asyncio
async def test_library_route_support_runs_blocking_calls_off_event_loop():
    release = threading.Event()
    started = threading.Event()

    def blocking() -> str:
        started.set()
        release.wait(1)
        return "done"

    task = asyncio.create_task(call_in_thread({"blocking": blocking}, "blocking"))
    assert await asyncio.to_thread(started.wait, 1)
    before = time.monotonic()
    await asyncio.sleep(0.02)
    elapsed = time.monotonic() - before
    release.set()

    assert elapsed < 0.2
    assert await task == "done"
