from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from refora_server.repositories.errors import RepoError

TEXT_EXTENSIONS = {'.tex', '.bib', '.bst', '.cls', '.sty', '.cfg', '.def', '.clo', '.txt', '.bbl', '.bbx', '.cbx', '.lbx', '.ist', '.fd'}
IMPORT_EXTENSIONS = TEXT_EXTENSIONS | {'.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.otf', '.ttf', '.enc', '.map', '.tfm', '.pfb'}
MAX_FILE = 32 * 1024 * 1024
MAX_PROJECT = 256 * 1024 * 1024
STARTER = r'''\documentclass{article}
\usepackage{graphicx}
\usepackage{amsmath}
\title{Untitled paper}
\author{}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
Write your abstract here.
\end{abstract}
\section{Introduction}
Start writing here. For example, $E = mc^2$.
\end{document}
'''


def safe_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_./ -]+', name) or len(name) > 400:
        raise RepoError('invalid_path', 'Use a relative project path with letters, numbers, spaces, dots, hyphens or underscores')
    parts = name.split('/')
    if name.startswith('/') or any(part in {'', '.', '..'} or part.startswith('.') for part in parts):
        raise RepoError('invalid_path', 'Invalid project path')
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise RepoError('invalid_path', 'Project symlinks are not allowed')
    if not target.resolve().is_relative_to(root.resolve()):
        raise RepoError('invalid_path', 'Path is outside the project')
    return target


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_source(root: Path, name: str) -> dict[str, str]:
    path = safe_path(root, name)
    if path.suffix.lower() not in TEXT_EXTENSIONS or not path.is_file():
        raise RepoError('invalid_path', 'Select an editable LaTeX source file')
    if path.stat().st_size > MAX_FILE:
        raise RepoError('file_too_large', 'Source file exceeds 32 MiB')
    data = path.read_bytes()
    try:
        content = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        content = data.decode('latin-1')
    return {'path': name, 'content': content, 'hash': hashlib.sha256(data).hexdigest()}


def import_sources(source: Path, target: Path) -> None:
    total = 0
    count = 0
    seen: set[str] = set()

    def put(name, size, reader):
        nonlocal total, count
        name = name.removeprefix('./')
        destination = safe_path(target, name)
        if destination.suffix.lower() not in IMPORT_EXTENSIONS:
            return
        count += 1
        total += size
        if size > MAX_FILE or total > MAX_PROJECT or count > 3000:
            raise RepoError('file_too_large', 'LaTeX archive exceeds project limits')
        if name.casefold() in seen:
            raise RepoError('invalid_archive', 'Duplicate archive filename')
        seen.add(name.casefold())
        data = reader(MAX_FILE + 1)
        if len(data) != size:
            raise RepoError('invalid_archive', 'Invalid archive entry size')
        atomic_write(destination, data)

    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_PROJECT:
        raise RepoError('invalid_path', 'Choose a regular .tex, .zip or .tar.gz source file under 256 MiB')
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            for entry in archive.infolist():
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise RepoError('invalid_archive', 'Archive links are not allowed')
                if entry.is_dir():
                    continue
                with archive.open(entry) as stream:
                    put(entry.filename, entry.file_size, stream.read)
    elif tarfile.is_tarfile(source):
        with tarfile.open(source) as archive:
            for entry in archive:
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise RepoError('invalid_archive', 'Archive links and special files are not allowed')
                with archive.extractfile(entry) as stream:
                    put(entry.name, entry.size, stream.read)
    elif source.suffix.lower() == '.tex':
        with source.open('rb') as stream:
            put(source.name, source.stat().st_size, stream.read)
    else:
        raise RepoError('invalid_archive', 'Choose a .tex, .zip or .tar.gz source file')


def tex_binary(configured: str = "") -> Path:
    candidates = [configured, os.environ.get('REFORA_TEX_BIN', ''), '/Library/TeX/texbin', str(Path.home() / 'Library/TinyTeX/bin/universal-darwin'), str(Path.home() / '.TinyTeX/bin/universal-darwin')]
    found = shutil.which('latexmk')
    if found:
        candidates.append(str(Path(found).parent))
    for candidate in candidates:
        if candidate and (Path(candidate) / 'latexmk').is_file():
            return Path(candidate).resolve()
    raise RepoError('latex_unavailable', 'Install MacTeX or TinyTeX with latexmk, then restart Refora')


def tail_log(path: Path) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        stream.seek(max(0, os.fstat(stream.fileno()).st_size - 100000))
        return stream.read(100000).decode('utf-8', errors='replace')


def compile_project(source: Path, root_file: str, engine: str, configured: str = "") -> dict[str, Any]:
    if engine not in {'pdflatex', 'xelatex', 'lualatex'}:
        raise RepoError('validation', 'Unknown LaTeX engine')
    root = safe_path(source, root_file)
    if root.suffix.lower() != '.tex' or not root.is_file():
        raise RepoError('invalid_path', 'Select a .tex root document')
    binary = tex_binary(configured)
    if not Path('/usr/bin/sandbox-exec').is_file():
        raise RepoError('sandbox_unavailable', 'Local LaTeX compilation requires the macOS sandbox')
    with tempfile.TemporaryDirectory(prefix='refora-latex-') as temporary:
        build = Path(temporary).resolve()
        total = 0
        for file in source.rglob('*'):
            if file.is_symlink():
                raise RepoError('invalid_path', 'Project symlinks are not allowed')
            if not file.is_file():
                continue
            if file == root.with_suffix('.pdf'):
                continue
            relative = file.relative_to(source).as_posix()
            safe_path(source, relative)
            if file.suffix.lower() not in IMPORT_EXTENSIONS:
                continue
            total += file.stat().st_size
            if file.stat().st_size > MAX_FILE or total > MAX_PROJECT:
                raise RepoError('file_too_large', 'Project exceeds compilation limits')
            destination = build / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)
        quoted = lambda path: json.dumps(str(path))
        ghostscript = shutil.which('gs') or next((name for name in ('/usr/local/bin/gs', '/opt/homebrew/bin/gs') if Path(name).is_file()), None)
        readable = ['/System', '/usr', '/bin', '/sbin', '/Library/Fonts', '/Library/Apple', '/private/etc', '/dev', str(binary.parent.parent), str(build)]
        if ghostscript:
            readable.append(str(Path(ghostscript).resolve().parent.parent))
        profile = '\n'.join([
            '(version 1)', '(deny default)', '(allow process*)', '(allow sysctl-read)', '(allow mach-lookup)',
            '(allow file-read-metadata)', '(allow file-read* (literal "/"))',
            *[f'(allow file-read* (subpath {quoted(path)}))' for path in readable],
            f'(allow file-write* (subpath {quoted(build)}))', '(allow file-write* (literal "/dev/null"))',
        ])
        env = {'PATH': f'{binary}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(build), 'TMPDIR': str(build), 'TEXMFHOME': str(build / 'texmf'), 'TEXMFVAR': str(build / 'texmf-var'), 'TEXMFCONFIG': str(build / 'texmf-config'), 'openin_any': 'p', 'openout_any': 'p', 'shell_escape': 'f', 'LANG': 'en_US.UTF-8', 'USER': 'refora', 'LOGNAME': 'refora'}
        mode = {'pdflatex': '-pdf', 'xelatex': '-xelatex', 'lualatex': '-lualatex'}[engine]
        command = ['/usr/bin/sandbox-exec', '-p', profile, str(binary / 'latexmk'), '-norc', mode, '-no-shell-escape', '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', './' + root.name]
        cwd = build / root.relative_to(source).parent
        log_path = build / 'refora-build.log'
        deadline = time.monotonic() + 120
        with log_path.open('wb') as log:
            def run(command_args, working_directory):
                process = subprocess.Popen(['/bin/sh', '-c', 'ulimit -f 131072; exec "$@"', 'refora-latex', *command_args], cwd=working_directory, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    process.wait(timeout=max(0.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise RepoError('compile_timeout', 'Compilation timed out after 120 seconds')
                return process.returncode

            eps_files = [file for file in build.rglob('*') if file.suffix.lower() == '.eps']
            if eps_files and (not ghostscript or not (binary / 'epstopdf').is_file()):
                return {'success': False, 'log': 'EPS figures require Ghostscript (gs) and epstopdf in the local TeX installation.'}
            if eps_files:
                for eps in eps_files:
                    converted = eps.with_name(eps.stem + '-eps-converted-to.pdf')
                    if converted.exists():
                        continue
                    status = run(['/usr/bin/sandbox-exec', '-p', profile, str(binary / 'epstopdf'), '--restricted', f'--outfile={converted.name}', './' + eps.name], eps.parent)
                    if status != 0:
                        return {'success': False, 'log': 'EPS conversion failed.\n' + tail_log(log_path)}
            status = run(command, cwd)
        output = tail_log(log_path)
        pdf = cwd / root.with_suffix('.pdf').name
        if status != 0 or not pdf.is_file():
            return {'success': False, 'log': output or f'LaTeX process exited with code {status}'}
        safe_path(build, pdf.relative_to(build).as_posix())
        fd = os.open(pdf, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            data = stream.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise RepoError('file_too_large', 'Compiled PDF exceeds 32 MiB')
        if not data.startswith(b'%PDF-'):
            raise RepoError('invalid_pdf', 'Compiler did not produce a PDF document')
        return {'success': True, 'log': output, 'pdfBase64': base64.b64encode(data).decode('ascii')}


class LatexService:
    def __init__(self, root_for_workspace, require_workspace, resolve_asset, settings=None, on_project=None):
        self.root_for_workspace = root_for_workspace
        self.require_workspace = require_workspace
        self.resolve_asset = resolve_asset
        self.settings = settings
        self.on_project = on_project
        self.active: dict[str, Any] = {}
        self.lock = threading.RLock()

    def directory(self, workspace_id):
        self.require_workspace(workspace_id)
        sandbox = self.root_for_workspace(workspace_id)
        if not sandbox:
            raise RepoError('not_ready', 'Workspace storage is unavailable')
        directory = safe_path(Path(sandbox), 'work/latex')
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def project(self, directory, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{32}', project_id):
            raise RepoError('invalid_path', 'Invalid LaTeX project ID')
        folder = safe_path(directory, project_id)
        metadata = safe_path(folder, 'project.json')
        if not metadata.is_file():
            raise RepoError('not_found', 'LaTeX project not found')
        if metadata.stat().st_size > 10000:
            raise RepoError('invalid_project', 'Invalid project metadata')
        data = json.loads(metadata.read_text())
        if not isinstance(data, dict) or data.get('id') != project_id or not isinstance(data.get('title'), str):
            raise RepoError('invalid_project', 'Invalid project metadata')
        source = safe_path(folder, 'files')
        safe_path(source, data.get('rootFile'))
        files = sorted(p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file() and not p.is_symlink())
        return {**data, 'files': files}, source

    def save_metadata(self, directory, project):
        metadata = {key: project[key] for key in ('id', 'title', 'rootFile')}
        atomic_write(directory / project['id'] / 'project.json', json.dumps(metadata).encode())

    def operate(self, workspace_id, request):
        if not isinstance(request, dict):
            raise RepoError('validation', 'LaTeX request must be an object')
        with self.lock:
            return self._operate(workspace_id, request)

    def _operate(self, workspace_id, request):
        directory = self.directory(workspace_id)
        action = request.get('action')
        if action == 'configure':
            path = request.get('runtimePath')
            if not isinstance(path, str) or not Path(path).is_absolute() or not (Path(path) / 'latexmk').is_file():
                raise RepoError('invalid_path', 'Choose the TeX bin directory containing latexmk')
            if self.settings is None:
                raise RepoError('not_ready', 'Compiler settings are unavailable')
            self.settings.set('latexBinPath', str(Path(path).resolve()))
            return {}
        if action == 'list':
            projects = [self.project(directory, p.name)[0] for p in sorted(directory.iterdir()) if re.fullmatch(r'[a-f0-9]{32}', p.name) and (p / 'project.json').is_file()]
            if self.on_project:
                for project in projects:
                    self.on_project(workspace_id, project, None)
            return {'projects': projects}
        if action == 'active':
            active = self.active.get(workspace_id)
            if not active:
                return {'active': None}
            project, source = self.project(directory, active['projectId'])
            return {'active': active, 'project': project, 'file': read_source(source, active['path'])}
        if action == 'activate' and not request.get('projectId'):
            self.active.pop(workspace_id, None)
            return {'active': None}
        if action in {'create', 'import'}:
            identifier = uuid.uuid4().hex
            folder = directory / identifier
            source = folder / 'files'
            source.mkdir(parents=True)
            try:
                title = request.get('title', 'LaTeX')
                if action == 'import':
                    if request.get('assetId'):
                        asset, path = self.resolve_asset(request['assetId'])
                        if asset['workspaceId'] != workspace_id:
                            raise RepoError('not_found', 'Asset does not belong to this workspace')
                    else:
                        path = request.get('importPath')
                    if not isinstance(path, str) or not Path(path).is_absolute():
                        raise RepoError('invalid_path', 'Choose a LaTeX source archive')
                    import_sources(Path(path), source)
                    title = Path(path).name
                else:
                    if not isinstance(title, str) or not title.strip() or len(title) > 200:
                        raise RepoError('validation', 'Project title must be 1–200 characters')
                    atomic_write(source / 'main.tex', STARTER.encode())
                tex = sorted(p.relative_to(source).as_posix() for p in source.rglob('*.tex'))
                if not tex:
                    raise RepoError('invalid_archive', 'No .tex files found in the archive')
                roots = [name for name in tex if re.search(r'\\documentclass\b', read_source(source, name)['content'])]
                project = {'id': identifier, 'title': title, 'rootFile': (roots or tex)[0]}
                self.save_metadata(directory, project)
                if self.on_project:
                    self.on_project(workspace_id, project, request.get('placement'))
                return {'project': self.project(directory, identifier)[0]}
            except Exception:
                shutil.rmtree(folder)
                raise
        project, source = self.project(directory, request.get('projectId'))
        if action == 'project':
            return {'project': project}
        if action == 'read':
            return {'file': read_source(source, request.get('path'))}
        if action == 'write':
            name = request.get('path')
            path = safe_path(source, name)
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                raise RepoError('invalid_path', 'Only LaTeX text sources can be edited')
            current = read_source(source, name)['hash'] if path.exists() else ''
            if request.get('expectedHash') != current:
                raise RepoError('conflict', 'The file changed externally. Reload it or save your draft as a new file.')
            content = request.get('content')
            if not isinstance(content, str) or len(content.encode()) > MAX_FILE:
                raise RepoError('validation', 'Source must be text under 32 MiB')
            atomic_write(path, content.encode())
            return {'file': read_source(source, name), 'project': self.project(directory, project['id'])[0]}
        if action in {'activate', 'root'}:
            file = read_source(source, request.get('path'))
            if action == 'activate':
                self.active[workspace_id] = {'projectId': project['id'], 'path': file['path']}
                return {'active': self.active[workspace_id]}
            if not file['path'].endswith('.tex'):
                raise RepoError('invalid_path', 'Root document must be a .tex file')
            project['rootFile'] = file['path']
            self.save_metadata(directory, project)
            if self.on_project:
                self.on_project(workspace_id, project, None)
            return {'project': project}
        if action == 'asset':
            asset, path = self.resolve_asset(request.get('assetId'))
            extension = Path(path).suffix.lower()
            if asset['workspaceId'] != workspace_id or extension not in {'.png', '.jpg', '.jpeg', '.pdf', '.eps'}:
                raise RepoError('invalid_path', 'Select a PNG, JPEG, PDF or EPS asset from this workspace')
            name = (Path(project['rootFile']).parent / f"assets/{hashlib.sha256(asset['id'].encode()).hexdigest()[:16]}{extension}").as_posix()
            destination = safe_path(source, name)
            if Path(path).stat().st_size > MAX_FILE:
                raise RepoError('file_too_large', 'Image exceeds 32 MiB')
            atomic_write(destination, Path(path).read_bytes())
            relative = os.path.relpath(destination, (source / project['rootFile']).parent)
            return {'assetPath': relative, 'project': self.project(directory, project['id'])[0]}
        if action == 'compile':
            return {'compilation': compile_project(source, project['rootFile'], request.get('engine', 'pdflatex'), self.settings.get('latexBinPath', '') if self.settings is not None else '')}
        raise RepoError('validation', 'Unknown LaTeX operation')
