from __future__ import annotations

import fnmatch
import os
from pathlib import Path
from typing import Any

MAX_TEXT_CHARS = 1_000_000
MAX_FILE_BYTES = 25 * 1024 * 1024


class AgentSandbox:
    def __init__(self, root: str | Path, identifier: str = "refora-sandbox") -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._identifier = identifier

    @property
    def id(self) -> str:
        return self._identifier

    def _path(self, path: str, *, create: bool = False) -> Path:
        if not isinstance(path, str) or not path:
            raise ValueError("Sandbox path must be non-empty")
        relative = path.lstrip("/")
        candidate = self._root / relative
        if ".." in Path(relative).parts:
            raise ValueError("Sandbox path traversal is not allowed")
        parent = candidate.parent
        if create:
            parent.mkdir(parents=True, exist_ok=True)
        for current in (self._root, *candidate.relative_to(self._root).parents):
            inspected = self._root if current == Path(".") else self._root / current
            if inspected.exists() and inspected.is_symlink():
                raise ValueError("Sandbox symlinks are not allowed")
        resolved_parent = parent.resolve(strict=False)
        resolved = candidate.resolve(strict=False)
        if not self._inside(resolved_parent) or not self._inside(resolved):
            raise ValueError("Sandbox path is outside the sandbox root")
        if candidate.exists() and candidate.is_symlink():
            raise ValueError("Sandbox symlinks are not allowed")
        return candidate

    def _inside(self, path: Path) -> bool:
        try:
            path.relative_to(self._root)
            return True
        except ValueError:
            return False

    def execute(self, command: str, *, timeout: int | None = None) -> dict[str, Any]:
        return {"output": "Arbitrary execution is disabled in the agent sandbox", "exit_code": 126, "truncated": False}

    def ls(self, path: str = "/") -> dict[str, Any]:
        try:
            target = self._path(path)
            if not target.exists() or not target.is_dir():
                return {"error": f"Directory not found: {path}"}
            return {"files": [{"path": f"/{entry.relative_to(self._root)}", "is_dir": entry.is_dir(), "size": entry.stat().st_size if entry.is_file() else 0} for entry in sorted(target.iterdir()) if not entry.is_symlink()]}
        except (OSError, ValueError) as error:
            return {"error": str(error)}

    def read(self, path: str, offset: int = 0, limit: int = 2000) -> dict[str, Any]:
        try:
            target = self._path(path)
            if not target.is_file() or target.stat().st_size > MAX_FILE_BYTES:
                return {"error": f"File not available: {path}"}
            content = target.read_text(encoding="utf-8")
            if len(content) > MAX_TEXT_CHARS:
                return {"error": "Sandbox text file is too large"}
            lines = content.split("\n")
            start, count = max(0, offset), max(1, limit)
            return {"content": "\n".join(f"{start + index + 1}: {line}" for index, line in enumerate(lines[start:start + count])), "mimeType": "text/plain"}
        except (OSError, UnicodeError, ValueError) as error:
            return {"error": str(error)}

    def write(self, path: str, content: str) -> dict[str, Any]:
        if not isinstance(content, str) or len(content) > MAX_TEXT_CHARS:
            return {"error": "Sandbox text content exceeds the size limit"}
        try:
            target = self._path(path, create=True)
            target.write_text(content, encoding="utf-8")
            return {"path": f"/{target.relative_to(self._root)}"}
        except (OSError, ValueError) as error:
            return {"error": str(error)}

    def edit(self, path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict[str, Any]:
        try:
            target = self._path(path)
            content = target.read_text(encoding="utf-8")
            count = content.count(old_string)
            if count == 0:
                return {"error": "Edit target was not found"}
            if count > 1 and not replace_all:
                return {"error": "Edit target is not unique"}
            updated = content.replace(old_string, new_string) if replace_all else content.replace(old_string, new_string, 1)
            return self.write(path, updated)
        except (OSError, UnicodeError, ValueError) as error:
            return {"error": str(error)}

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None) -> dict[str, Any]:
        try:
            root = self._path(path or "/")
            matches = []
            for target in root.rglob("*"):
                if target.is_symlink() or not target.is_file() or (glob and not fnmatch.fnmatch(target.name, glob)):
                    continue
                if target.stat().st_size > MAX_FILE_BYTES:
                    continue
                for index, line in enumerate(target.read_text(encoding="utf-8", errors="replace").split("\n")):
                    if pattern in line:
                        matches.append({"path": f"/{target.relative_to(self._root)}", "line": index + 1, "text": line})
            return {"matches": matches}
        except (OSError, ValueError) as error:
            return {"error": str(error)}

    def glob(self, pattern: str, path: str | None = None) -> dict[str, Any]:
        try:
            root = self._path(path or "/")
            return {"files": [{"path": f"/{target.relative_to(self._root)}", "is_dir": target.is_dir(), "size": target.stat().st_size if target.is_file() else 0} for target in root.rglob("*") if not target.is_symlink() and fnmatch.fnmatch(str(target.relative_to(root)), pattern)]}
        except (OSError, ValueError) as error:
            return {"error": str(error)}

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
        results = []
        for path, content in files:
            if len(content) > MAX_FILE_BYTES:
                results.append({"path": path, "error": "file_too_large"})
                continue
            try:
                target = self._path(path, create=True)
                target.write_bytes(content)
                results.append({"path": f"/{target.relative_to(self._root)}", "error": None})
            except (OSError, ValueError) as error:
                results.append({"path": path, "error": str(error)})
        return results

    def download_files(self, paths: list[str]) -> list[dict[str, Any]]:
        results = []
        for path in paths:
            try:
                target = self._path(path)
                if not target.is_file() or target.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError("file_not_found")
                results.append({"path": path, "content": target.read_bytes(), "error": None})
            except (OSError, ValueError):
                results.append({"path": path, "content": None, "error": "file_not_found"})
        return results


ReforaSandboxBackend = AgentSandbox
