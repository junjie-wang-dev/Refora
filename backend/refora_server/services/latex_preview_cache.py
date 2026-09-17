from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone

MAX_CACHE_BYTES = 128 * 1024 * 1024


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fingerprint(hashes):
    return hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def project_fingerprint(source, root_file):
    from refora_server.services.latex import IMPORT_EXTENSIONS, MAX_FILE, MAX_PROJECT, safe_path
    hashes = {}
    total = 0
    root_pdf = safe_path(source, root_file).with_suffix('.pdf')
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Project symlink')
        if not path.is_file() or path == root_pdf or path.suffix.lower() not in IMPORT_EXTENSIONS:
            continue
        relative = path.relative_to(source).as_posix()
        safe_path(source, relative)
        size = path.stat().st_size
        total += size
        if size > MAX_FILE or total > MAX_PROJECT:
            raise ValueError('Project exceeds compilation limits')
        hashes[relative] = file_digest(path)
    return fingerprint(hashes)


def save_preview(source, root_file, compiler, configured, engine, inputs, compilation):
    from refora_server.services.latex import atomic_write, safe_path
    built_at = datetime.now(timezone.utc).isoformat()
    entry = {'version': 1, 'rootFile': root_file, 'compiler': compiler, 'configured': configured, 'engine': engine, 'inputs': inputs, 'builtAt': built_at, 'compilation': compilation}
    data = json.dumps(entry, separators=(',', ':')).encode()
    if len(data) > MAX_CACHE_BYTES:
        raise ValueError('Preview cache exceeds size limit')
    atomic_write(safe_path(source.parent, 'preview-cache.json'), data)
    return built_at


def preview_revision(source):
    from refora_server.services.latex import safe_path
    from refora_server.repositories.errors import RepoError
    try:
        path = safe_path(source.parent, 'preview-cache.json')
        return str(path.stat().st_mtime_ns) if path.is_file() else None
    except (OSError, RepoError):
        return None


def load_preview(source, root_file, compiler, configured):
    from refora_server.services.latex import MAX_FILE, safe_path
    from refora_server.repositories.errors import RepoError
    try:
        path = safe_path(source.parent, 'preview-cache.json')
        if not path.is_file() or path.stat().st_size > MAX_CACHE_BYTES:
            return None
        entry = json.loads(path.read_text())
        if not isinstance(entry, dict) or entry.get('version') != 1 or entry.get('engine') not in {'pdflatex', 'xelatex', 'lualatex'}:
            return None
        compilation = entry['compilation']
        if not isinstance(compilation, dict) or compilation.get('success') is not True or not isinstance(compilation.get('pdfBase64'), str) or not isinstance(compilation.get('log'), str):
            return None
        data = base64.b64decode(compilation['pdfBase64'], validate=True)
        if len(data) > MAX_FILE or not data.startswith(b'%PDF-'):
            return None
        datetime.fromisoformat(entry['builtAt'])
    except (OSError, ValueError, TypeError, KeyError, RepoError):
        return None
    try:
        stale = entry.get('rootFile') != root_file or entry.get('compiler') != compiler or entry.get('configured') != configured or entry.get('inputs') != project_fingerprint(source, root_file)
    except (OSError, ValueError, RepoError):
        stale = True
    return {**compilation, 'builtAt': entry['builtAt'], 'engine': entry['engine'], 'stale': stale}
