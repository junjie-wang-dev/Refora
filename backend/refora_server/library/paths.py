import os
import sys

_SEP = os.sep
_CASE_INSENSITIVE = sys.platform == "darwin" or sys.platform == "win32"


def _norm_end_sep(p: str) -> str:
    if p.endswith(_SEP):
        return p
    return p + _SEP


def _starts_with_dir(parent: str, child: str) -> bool:
    p = _norm_end_sep(parent)
    c = _norm_end_sep(child)
    if _CASE_INSENSITIVE:
        return c.lower().startswith(p.lower())
    return c.startswith(p)


def _same_path(a: str, b: str) -> bool:
    if _CASE_INSENSITIVE:
        return a.lower() == b.lower()
    return a == b


def _resolve(p: str) -> str:
    return os.path.realpath(os.path.normpath(os.path.abspath(p)))


def toLibraryRelative(absPath: str, libraryFolder: str) -> str:
    if not libraryFolder:
        return absPath
    if not os.path.isabs(absPath):
        return absPath
    normLib = _resolve(libraryFolder)
    rel = os.path.relpath(_resolve(absPath), normLib)
    if rel == "" or rel == ".." or rel.startswith(".." + _SEP):
        return absPath
    return rel


def resolveFromLibrary(relOrAbs: str, libraryFolder: str) -> str:
    if not relOrAbs:
        return relOrAbs
    if os.path.isabs(relOrAbs):
        return _resolve(relOrAbs)
    if not libraryFolder:
        return relOrAbs
    return _resolve(os.path.join(libraryFolder, relOrAbs))


def isInsideLibrary(absPath: str, libraryFolder: str) -> bool:
    if not absPath or not libraryFolder:
        return False
    normLib = _resolve(libraryFolder)
    normAbs = _resolve(absPath)
    return _same_path(normAbs, normLib) or _starts_with_dir(normLib, normAbs)


def isInLibraryRoot(absPath: str, libraryFolder: str) -> bool:
    if not absPath or not libraryFolder:
        return False
    normLib = _resolve(libraryFolder)
    normAbs = _resolve(absPath)
    return _same_path(os.path.dirname(normAbs), normLib)


def containsLibrary(parentPath: str, libraryFolder: str) -> bool:
    if not parentPath or not libraryFolder:
        return False
    normParent = _resolve(parentPath)
    normLib = _resolve(libraryFolder)
    if _same_path(normParent, normLib):
        return False
    return _starts_with_dir(normParent, normLib)
