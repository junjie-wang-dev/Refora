from __future__ import annotations

import os
import shutil
from typing import Optional

from refora_server.db.errors import RepoError
from refora_server.library.pdf_path import resolvePdfFilePath

WORKSPACE_ASSET_DIRECTORY = "refora-assets"
AGENT_SANDBOX_DIRECTORY = ".refora-agent"


def fileExists(filePath: str) -> bool:
    return os.path.exists(filePath)


def fileStat(filePath: str) -> dict:
    resolved = resolvePdfFilePath(filePath)
    stat = os.stat(resolved)
    return {
        "size": stat.st_size,
        "isFile": os.path.isfile(resolved),
        "isDirectory": os.path.isdir(resolved),
        "mtime": stat.st_mtime,
    }


def moveFile(srcPath: str, destPath: str) -> str:
    src = resolvePdfFilePath(srcPath)
    destDir = os.path.dirname(os.path.normpath(os.path.abspath(destPath)))
    if destDir and not os.path.isdir(destDir):
        raise RepoError("invalid_path", f"Destination directory does not exist: {destDir}")
    dest = os.path.normpath(os.path.abspath(destPath))
    if not dest.lower().endswith(".pdf"):
        raise RepoError("invalid_path", "Destination file must be a PDF")
    shutil.move(src, dest)
    return dest


def copyFile(srcPath: str, destPath: str) -> str:
    src = resolvePdfFilePath(srcPath)
    destDir = os.path.dirname(os.path.normpath(os.path.abspath(destPath)))
    if destDir and not os.path.isdir(destDir):
        raise RepoError("invalid_path", f"Destination directory does not exist: {destDir}")
    dest = os.path.normpath(os.path.abspath(destPath))
    if not dest.lower().endswith(".pdf"):
        raise RepoError("invalid_path", "Destination file must be a PDF")
    shutil.copy2(src, dest)
    return dest


def findPdfsRecursively(
    directory: str,
    *,
    skipHidden: bool = True,
) -> list[str]:
    results: list[str] = []
    visited: set[str] = set()

    def walk(currentDir: str) -> None:
        try:
            canonical = os.path.realpath(currentDir)
        except OSError:
            return
        if canonical in visited:
            return
        visited.add(canonical)
        try:
            entries = list(os.scandir(currentDir))
        except OSError:
            return
        for entry in entries:
            name = entry.name
            if (
                name == WORKSPACE_ASSET_DIRECTORY
                or name == AGENT_SANDBOX_DIRECTORY
                or (skipHidden and (name == ".git" or name.startswith(".")))
            ):
                continue
            full = os.path.normpath(os.path.join(currentDir, name))
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    walk(full)
                elif entry.is_file(follow_symlinks=False) and full.lower().endswith(".pdf"):
                    results.append(full)
            except OSError:
                continue

    walk(os.path.normpath(os.path.abspath(directory)))
    return results
