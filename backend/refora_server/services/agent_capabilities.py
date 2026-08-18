from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def resolve_agent_capabilities(
    profile: Mapping[str, Any],
    tool_names: list[str],
    *,
    api_native_web_search: bool = False,
    runtime_native_web_search: bool = False,
) -> dict[str, Any]:
    policy = profile.get("webSearchPolicy") or "auto"
    native_available = (
        profile.get("nativeWebSearch") is True
        and (
            (profile.get("kind") == "api" and api_native_web_search)
            or (profile.get("kind") == "cli" and runtime_native_web_search)
        )
    )
    if policy == "native" and not native_available:
        raise ValueError("Native Web search is not available for this agent profile")
    use_native = policy == "native" or (policy == "auto" and native_available)
    use_refora = policy == "refora" or (policy == "auto" and not use_native)
    enabled = list(tool_names)
    if use_native:
        enabled = [name for name in enabled if name != "web_search"]
    elif not use_refora:
        enabled = [name for name in enabled if name not in {"web_search", "web_fetch"}]
    return {
        "enabledToolNames": enabled,
        "useNativeWebSearch": use_native,
        "useReforaWebSearch": use_refora,
    }
