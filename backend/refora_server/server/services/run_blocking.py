from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any


async def run_blocking(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(fn, *args, **kwargs)


__all__ = ["run_blocking"]
