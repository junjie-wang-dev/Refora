from __future__ import annotations

from collections.abc import Mapping
from typing import TypedDict

from refora_server.repositories.errors import RepoError


class WorkspaceNotePatch(TypedDict, total=False):
    title: str | None
    contentMd: str | None
    color: str | None


WORKSPACE_NOTE_COLORS = frozenset(
    {"sand", "lemon", "coral", "rose", "mint", "sky", "lavender", "slate"}
)


def parse_workspace_note_patch(value: Mapping[str, object]) -> WorkspaceNotePatch:
    unknown = set(value) - {"title", "contentMd", "color"}
    if unknown:
        raise RepoError(
            "forbidden_field",
            f"Unsupported workspace note fields: {', '.join(sorted(unknown))}",
        )
    patch: WorkspaceNotePatch = {}
    if "title" in value:
        title = value["title"]
        if title is not None and not isinstance(title, str):
            raise RepoError("invalid_input", "title must be a string or null")
        if isinstance(title, str) and not title.strip():
            raise RepoError("invalid_title", "note title cannot be empty")
        patch["title"] = title
    if "contentMd" in value:
        content = value["contentMd"]
        if content is not None and not isinstance(content, str):
            raise RepoError("invalid_input", "contentMd must be a string or null")
        patch["contentMd"] = content
    if "color" in value:
        color = value["color"]
        if color is not None and (
            not isinstance(color, str) or color not in WORKSPACE_NOTE_COLORS
        ):
            raise RepoError("invalid_input", "color is not a supported workspace note color")
        patch["color"] = color
    return patch
