from __future__ import annotations

import json
from typing import Any, Literal

DEFAULT_LIBRARY_FOLDER = ""

Language = Literal["zh", "en"]

SETTING_KEYS: tuple[str, ...] = (
    "libraryFolderPath",
    "crossrefMailto",
    "theme",
    "sidebarCollapsed",
    "lastWatchScanAt",
    "language",
    "proxyUrl",
    "windowBounds",
    "listColumnState",
    "activeProviderId",
    "activeAgentProfileId",
    "chatRecentModels",
    "chatSelectedProviderId",
    "chatSelectedAgentProfileId",
    "chatSelectedModel",
    "chatSelectedVariant",
    "chatReasoningEffort",
    "chatDeepThinking",
    "workspaceChatHeight",
    "workspaceChatWidth",
    "sidebarWidth",
    "detailWidth",
    "workspaceWidth",
    "documentListCompactWidth",
    "pdfOpenMode",
)


def default_settings(language: Language) -> list[tuple[str, Any]]:
    return [
        ("libraryFolderPath", ""),
        ("crossrefMailto", ""),
        ("theme", "dark"),
        ("sidebarCollapsed", "0"),
        ("lastWatchScanAt", 0),
        ("language", language),
        ("proxyUrl", ""),
        ("windowBounds", None),
        ("listColumnState", None),
        ("activeProviderId", ""),
        ("activeAgentProfileId", ""),
        ("chatRecentModels", "[]"),
        ("chatSelectedProviderId", ""),
        ("chatSelectedAgentProfileId", ""),
        ("chatSelectedModel", ""),
        ("chatSelectedVariant", ""),
        ("chatReasoningEffort", ""),
        ("chatDeepThinking", False),
        ("workspaceChatHeight", 280),
        ("workspaceChatWidth", 380),
        ("sidebarWidth", 224),
        ("detailWidth", 384),
        ("workspaceWidth", 480),
        ("documentListCompactWidth", 320),
        ("pdfOpenMode", "system"),
    ]


def seed_default_settings(db: Any, language: Language) -> None:
    for key, value in default_settings(language):
        encoded = json.dumps(value)
        db.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            (key, encoded),
        )
