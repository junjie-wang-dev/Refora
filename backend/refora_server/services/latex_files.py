from __future__ import annotations

import base64
import hashlib
import io
import json
import mimetypes
import os
import tempfile
import uuid
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from refora_server.repositories.errors import RepoError


def history_directory(source, name):
    from refora_server.services.latex import safe_path
    safe_path(source, name)
    return safe_path(source.parent, f'history/{hashlib.sha256(name.encode()).hexdigest()}')


def save_source(source, name, content):
    from refora_server.services.latex import atomic_write, read_source, safe_path
    path = safe_path(source, name)
    current = read_source(source, name) if path.exists() else None
    encoding = current.get('encoding', 'utf-8') if current else 'utf-8'
    try:
        data = content.encode(encoding)
    except UnicodeEncodeError as exc:
        raise RepoError('unsupported_encoding', f'This edit cannot be represented in {encoding}; save it as a new UTF-8 file.') from exc
    if current and current['content'] != content:
        folder = history_directory(source, name)
        entry = {'id': uuid.uuid4().hex, 'content': current['content'], 'createdAt': datetime.now(timezone.utc).isoformat()}
        atomic_write(folder / f"{entry['id']}.json", json.dumps(entry, ensure_ascii=False).encode())
        histories = sorted(folder.glob('*.json'), key=lambda file: file.stat().st_mtime_ns, reverse=True)
        total = 0
        for index, old in enumerate(histories):
            total += old.stat().st_size
            if index >= 30 or (index > 0 and total > 64 * 1024 * 1024):
                old.unlink()
    atomic_write(path, data)


def file_operation(service, workspace_id, directory, project, source, request):
    from refora_server.services.latex import IMPORT_EXTENSIONS, MAX_FILE, MAX_PROJECT, TEXT_EXTENSIONS, atomic_write, import_sources, read_source, safe_path
    from refora_server.services.latex_preview_cache import file_digest
    from refora_server.services.latex_reviews import read_review, with_review
    action = request.get('action')
    if action not in {'rename', 'delete', 'importFiles', 'resource', 'exportProject', 'sources', 'history', 'restore', '_rollbackDelete'}:
        return None
    def result():
        return {'project': service.project(directory, project['id'])[0]}
    if action == '_rollbackDelete':
        name = request.get('path')
        destination = safe_path(source, name)
        identifier = request.get('deletionId')
        if not isinstance(identifier, str) or len(identifier) != 32 or any(char not in '0123456789abcdef' for char in identifier):
            raise RepoError('invalid_path', 'Invalid deleted file identifier')
        staged = safe_path(source.parent, f'deleted/{identifier}/{destination.name}')
        if destination.exists() or not staged.is_file():
            raise RepoError('conflict', 'The file remains recoverable in the project deleted folder; its original path is occupied or unavailable.')
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, destination)
        if request.get('restoreActive') and not service.active.get(workspace_id):
            service.active[workspace_id] = {'projectId': project['id'], 'path': name}
        return result()
    if action == 'sources':
        files = []
        errors = []
        total = 0
        for name in project['files']:
            if Path(name).suffix.lower() not in TEXT_EXTENSIONS or not safe_path(source, name).is_file():
                continue
            try:
                file = read_source(source, name)
                total += len(file['content'].encode())
                if total > MAX_PROJECT:
                    raise RepoError('file_too_large', 'Project source exceeds 256 MiB')
                files.append(file)
            except RepoError as exc:
                errors.append({'path': name, 'message': str(exc)})
        return {'sources': files, 'sourceErrors': errors}
    if action == 'exportProject':
        output = io.BytesIO()
        total = 0
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in project['files']:
                path = safe_path(source, name)
                if not path.is_file():
                    continue
                size = path.stat().st_size
                total += size
                if size > MAX_FILE or total > MAX_PROJECT:
                    raise RepoError('file_too_large', 'Project exceeds export limits')
                archive.write(path, arcname=name)
        return {'archiveBase64': base64.b64encode(output.getvalue()).decode('ascii')}
    if action == 'importFiles':
        path = request.get('importPath')
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise RepoError('invalid_path', 'Choose sources with the native picker')
        with tempfile.TemporaryDirectory(prefix='refora-latex-import-') as temporary:
            staging = Path(temporary)
            report = import_sources(Path(path), staging)
            existing = {unicodedata.normalize('NFC', name).casefold() for name in project['files']}
            for name in report['imported']:
                destination = safe_path(source, name)
                if unicodedata.normalize('NFC', name).casefold() in existing or destination.exists():
                    raise RepoError('conflict', f'Import would overwrite {name}; rename it first.')
                if any(parent.exists() and not parent.is_dir() for parent in destination.parents if parent != source and parent.is_relative_to(source)):
                    raise RepoError('conflict', f'Import path conflicts with an existing file: {name}')
            total = sum(p.stat().st_size for p in source.rglob('*') if p.is_file()) + sum(p.stat().st_size for p in staging.rglob('*') if p.is_file())
            if total > MAX_PROJECT or len(existing) + len(report['imported']) > 3000:
                raise RepoError('file_too_large', 'Project exceeds import limits')
            for name in report['imported']:
                atomic_write(safe_path(source, name), (staging / name).read_bytes())
        return {**result(), 'importReport': report}
    name = request.get('path')
    path = safe_path(source, name)
    if action == 'history':
        folder = history_directory(source, name)
        return {'history': sorted([json.loads(file.read_text()) for file in folder.glob('*.json') if not file.is_symlink()], key=lambda entry: entry['createdAt'], reverse=True)}
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise RepoError('invalid_path', 'Choose a project file under 32 MiB')
    digest = file_digest(path)
    if action == 'resource':
        mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        return {'resource': {'path': name, 'hash': digest, 'mimeType': mime, 'base64': base64.b64encode(path.read_bytes()).decode('ascii')}}
    if request.get('expectedHash') != digest:
        raise RepoError('conflict', 'The file changed externally. Reload before changing it.')
    if read_review(source, name):
        raise RepoError('review_pending', 'Finish reviewing AI changes before changing this file.')
    if action == 'restore':
        identifier = request.get('historyId')
        if not isinstance(identifier, str) or len(identifier) != 32 or any(char not in '0123456789abcdef' for char in identifier):
            raise RepoError('invalid_path', 'Invalid history version')
        version = safe_path(history_directory(source, name), f'{identifier}.json')
        if not version.is_file():
            raise RepoError('not_found', 'This history version is no longer available')
        save_source(source, name, json.loads(version.read_text())['content'])
        return {**result(), 'file': with_review(source, name)}
    if action == 'delete':
        if name == project['rootFile']:
            raise RepoError('validation', 'Choose another root document before deleting this file')
        staging = safe_path(source.parent, f'deleted/{uuid.uuid4().hex}')
        staging.mkdir(parents=True)
        os.replace(path, staging / path.name)
        was_active = service.active.get(workspace_id) == {'projectId': project['id'], 'path': name}
        if was_active:
            service.active.pop(workspace_id, None)
        return {**result(), '_trashPath': str(staging), '_deletion': {'deletionId': staging.name, 'path': name, 'restoreActive': was_active}}
    new_name = request.get('newPath')
    destination = safe_path(source, new_name)
    if name == project['rootFile'] and destination.suffix.lower() != '.tex':
        raise RepoError('invalid_path', 'Root document must keep the .tex extension')
    if destination.suffix.lower() not in IMPORT_EXTENSIONS:
        raise RepoError('invalid_path', 'Choose a supported project file extension')
    if destination.exists() or any(unicodedata.normalize('NFC', entry).casefold() == unicodedata.normalize('NFC', new_name).casefold() for entry in project['files']):
        raise RepoError('conflict', 'A file already exists at this path')
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(path, destination)
    old_history = history_directory(source, name)
    if old_history.exists():
        new_history = history_directory(source, new_name)
        new_history.mkdir(parents=True, exist_ok=True)
        for version in old_history.glob('*.json'):
            if not version.is_symlink():
                os.replace(version, new_history / version.name)
    if name == project['rootFile']:
        project['rootFile'] = new_name
        service.save_metadata(directory, project)
        if service.on_project:
            service.on_project(workspace_id, project, None)
    if service.active.get(workspace_id) == {'projectId': project['id'], 'path': name}:
        service.active[workspace_id]['path'] = new_name
    return result()
