from __future__ import annotations

import os
from pathlib import Path


MANAGED_PDF_DIRECTORIES = frozenset({"refora-assets", ".refora-agent", ".refora"})


def find_pdf_files(
    directory: str,
    *,
    recursive: bool = True,
    skip_hidden: bool = True,
) -> list[str]:
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        return []

    found: list[str] = []

    def walk(current: Path) -> None:
        try:
            entries = sorted(os.scandir(current), key=lambda entry: entry.name.casefold())
        except OSError:
            return
        for entry in entries:
            if entry.name in MANAGED_PDF_DIRECTORIES:
                continue
            if skip_hidden and entry.name.startswith("."):
                continue
            try:
                if entry.is_symlink():
                    continue
                if entry.is_file(follow_symlinks=False) and entry.name.lower().endswith(".pdf"):
                    found.append(os.path.normpath(os.path.abspath(entry.path)))
                elif recursive and entry.is_dir(follow_symlinks=False):
                    walk(Path(entry.path))
            except OSError:
                continue

    walk(root)
    return found
