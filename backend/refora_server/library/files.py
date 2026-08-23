from __future__ import annotations

import os
import shutil

from refora_server.db.errors import RepoError
from refora_server.library.pdf_discovery import find_pdf_files
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
    return find_pdf_files(directory, skip_hidden=skipHidden)
