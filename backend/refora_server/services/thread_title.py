from __future__ import annotations

import re
from typing import Any

from refora_server.services.provider_config import build_provider_config


def derive_thread_title(text: str) -> str:
    one_line = re.sub(r"\s+", " ", text).strip()
    if not one_line:
        return "New chat"
    if len(one_line) <= 50:
        return one_line

    first_50 = one_line[:50]
    sentence_match = re.search(r"[.!?。！？]", first_50)
    if sentence_match is not None and sentence_match.start() > 10:
        return one_line[: sentence_match.start() + 1].strip()

    last_space = first_50.rfind(" ")
    if last_space > 10:
        return one_line[:last_space].strip() + "…"

    return first_50 + "…"


def _clean_title(title: str) -> str:
    cleaned = re.sub(r"^[\'\"]+|[\'\"]+$", "", title.strip())
    cleaned = re.sub(r"\.$", "", cleaned).strip()
    return cleaned


def createThreadTitleService(repos: Any, deps: Any | None = None):
    deps = deps or {}
    logger = deps.get("logger")
    generate_title = deps.get("generate_title")

    def _warn(message: str) -> None:
        if logger is not None:
            try:
                logger.warning(message)
            except Exception:
                pass

    def generateThreadTitle(threadId: str, provider: dict[str, Any]) -> str | None:
        try:
            messages = repos["chat"]["listMessages"](threadId)
            user_message = ""
            for msg in messages:
                if msg.get("role") == "user":
                    user_message = msg.get("content") or ""
                    break
            if not user_message:
                return None
            model_id = (provider.get("model") or "").strip()
            provider_config = build_provider_config(provider, deep_thinking=False)
            provider_config["streaming"] = False
            is_reasoning_model = True
            max_tokens = 512 if is_reasoning_model else 30
            provider_config["maxTokens"] = max_tokens
            provider_config["temperature"] = 0.3
            if generate_title is None:
                raise RuntimeError("generate_title dependency is not configured")
            title = generate_title(
                {
                    "provider": provider_config,
                    "userMessage": user_message[:500],
                    "reasoningModel": is_reasoning_model,
                    "modelId": model_id,
                }
            )
            if not isinstance(title, str):
                return None
            cleaned = _clean_title(title)
            if not cleaned or len(cleaned) > 100:
                return None
            return cleaned
        except Exception as e:
            _warn(f"generateThreadTitle: {e}")
            return None

    return {"generateThreadTitle": generateThreadTitle}
