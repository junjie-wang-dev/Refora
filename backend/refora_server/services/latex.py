from __future__ import annotations

import base64
import hashlib
import json
import unicodedata
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
from refora_server.services.latex_preview_cache import file_digest, fingerprint, project_fingerprint, save_preview, load_preview, preview_revision
from refora_server.services.latex_reviews import propose, read_review, resolve, review_files, with_review

TEXT_EXTENSIONS = {'.tex', '.bib', '.bst', '.cls', '.sty', '.cfg', '.def', '.clo', '.txt', '.bbl', '.bbx', '.cbx', '.lbx', '.ist', '.fd', '.csv', '.dat', '.tsv'}
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
    if not isinstance(name, str) or not name or len(name) > 400 or any(not (unicodedata.category(char)[0] in 'LNM' or char in '_./ -') for char in name):
        raise RepoError('invalid_path', 'Use a safe relative project path')
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
    encoding = 'utf-8-sig' if data.startswith(b'\xef\xbb\xbf') else 'utf-8'
    try:
        content = data.decode(encoding)
    except UnicodeDecodeError:
        encoding = 'gb18030'
        try:
            content = data.decode(encoding)
        except UnicodeDecodeError as exc:
            raise RepoError('unsupported_encoding', 'Convert this source to UTF-8 before editing; its encoding cannot be read safely.') from exc
    return {'path': name, 'content': content, 'encoding': encoding, 'hash': hashlib.sha256(data).hexdigest()}


def import_sources(source: Path, target: Path) -> dict[str, list[str]]:
    total = 0
    count = 0
    seen: set[str] = set()
    report: dict[str, list[str]] = {'imported': [], 'skipped': []}

    def put(name, size, reader):
        nonlocal total, count
        name = name.removeprefix('./')
        if any(part.startswith('.') or part == '__MACOSX' for part in name.split('/') if part not in {'.', '..'}):
            report['skipped'].append(name)
            return
        destination = safe_path(target, name)
        if destination.suffix.lower() not in IMPORT_EXTENSIONS:
            report['skipped'].append(name)
            return
        count += 1
        total += size
        if size > MAX_FILE or total > MAX_PROJECT or count > 3000:
            raise RepoError('file_too_large', 'LaTeX archive exceeds project limits')
        normalized = unicodedata.normalize('NFC', name).casefold()
        if normalized in seen:
            raise RepoError('invalid_archive', 'Duplicate archive filename')
        seen.add(normalized)
        data = reader(MAX_FILE + 1)
        if len(data) != size:
            raise RepoError('invalid_archive', 'Invalid archive entry size')
        atomic_write(destination, data)
        report['imported'].append(name)

    if source.is_symlink():
        raise RepoError('invalid_path', 'Project symlinks are not allowed')
    if source.is_dir():
        if target.resolve().is_relative_to(source.resolve()):
            raise RepoError('invalid_path', 'Choose a source folder outside workspace project storage')
        for directory, folders, files in os.walk(source, followlinks=False):
            report['skipped'].extend((Path(directory) / name).relative_to(source).as_posix() for name in folders if name.startswith('.') or name == '__MACOSX')
            folders[:] = sorted(name for name in folders if not name.startswith('.') and name != '__MACOSX')
            for name in folders + sorted(files):
                if name.startswith('.'):
                    report['skipped'].append((Path(directory) / name).relative_to(source).as_posix())
                    continue
                entry = Path(directory) / name
                if entry.is_symlink():
                    raise RepoError('invalid_path', 'Project symlinks are not allowed')
                if name in folders:
                    continue
                if not entry.is_file():
                    raise RepoError('invalid_path', 'Project special files are not allowed')
                with entry.open('rb') as stream:
                    put(entry.relative_to(source).as_posix(), entry.stat().st_size, stream.read)
        return report
    if not source.is_file() or source.stat().st_size > MAX_PROJECT:
        raise RepoError('invalid_path', 'Choose a project folder or source archive under 256 MiB')
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
    elif source.suffix.lower() in IMPORT_EXTENSIONS:
        with source.open('rb') as stream:
            put(source.name, source.stat().st_size, stream.read)
    else:
        raise RepoError('invalid_archive', 'Choose a supported source file, .zip or .tar.gz archive')
    return report


def compiler_binary(executable: str, configured: str = "") -> Path:
    environment_key = 'REFORA_TECTONIC_BIN' if executable == 'tectonic' else 'REFORA_TEX_BIN'
    configured_path = Path(configured).expanduser() if configured else None
    if configured_path and configured_path.is_file() and configured_path.name == executable:
        return configured_path.resolve().parent
    candidates = [configured if configured_path and configured_path.is_dir() else '', os.environ.get(environment_key, '')]
    if executable == 'latexmk':
        candidates.extend(['/Library/TeX/texbin', str(Path.home() / 'Library/TinyTeX/bin/universal-darwin'), str(Path.home() / '.TinyTeX/bin/universal-darwin')])
    candidates.extend(['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'])
    found = shutil.which(executable)
    if found:
        candidates.append(str(Path(found).parent))
    for candidate in candidates:
        if candidate and (Path(candidate) / executable).is_file():
            return Path(candidate).resolve()
    if executable == 'tectonic':
        raise RepoError('latex_unavailable', 'Install Tectonic, or choose its bin directory in Settings')
    raise RepoError('latex_unavailable', 'Install MacTeX or TinyTeX with latexmk, or choose its bin directory in Settings')


def tex_binary(configured: str = "") -> Path:
    return compiler_binary('latexmk', configured)


def tail_log(path: Path) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        stream.seek(max(0, os.fstat(stream.fileno()).st_size - 100000))
        return stream.read(100000).decode('utf-8', errors='replace')


_compile_context = threading.local()


def compile_project(source: Path, root_file: str, engine: str, compiler: str = 'latexmk', configured: str = "") -> dict[str, Any]:
    if engine not in {'pdflatex', 'xelatex', 'lualatex'}:
        raise RepoError('validation', 'Unknown LaTeX engine')
    if compiler not in {'latexmk', 'tectonic'}:
        raise RepoError('validation', 'Unknown LaTeX compiler')
    root = safe_path(source, root_file)
    if root.suffix.lower() != '.tex' or not root.is_file():
        raise RepoError('invalid_path', 'Select a .tex root document')
    binary = tex_binary(configured) if compiler == 'latexmk' else compiler_binary('tectonic', configured)
    if not Path('/usr/bin/sandbox-exec').is_file():
        raise RepoError('sandbox_unavailable', 'Local LaTeX compilation requires the macOS sandbox')
    with tempfile.TemporaryDirectory(prefix='refora-latex-') as temporary:
        build = Path(temporary).resolve()
        total = 0
        source_hashes = {}
        input_hashes = {}
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
            input_hashes[relative] = file_digest(destination)
            if file.suffix.lower() in TEXT_EXTENSIONS:
                source_hashes[relative] = input_hashes[relative]
        quoted = lambda path: json.dumps(str(path))
        ghostscript = shutil.which('gs') or next((name for name in ('/usr/local/bin/gs', '/opt/homebrew/bin/gs') if Path(name).is_file()), None)
        readable = ['/System', '/usr', '/bin', '/sbin', '/Library/Fonts', '/Library/Apple', '/private/etc', '/dev', str(build)]
        readable_literals = []
        if compiler == 'tectonic':
            compiler_root = next((Path(prefix) for prefix in ('/opt/homebrew', '/usr/local', '/opt/local') if binary.is_relative_to(prefix)), None)
            if compiler_root:
                readable.append(str(compiler_root))
            else:
                readable_literals.append(str((binary / 'tectonic').resolve()))
        else:
            readable.append(str(binary.parent.parent))
        writable = [str(build)]
        tectonic_cache = None
        if compiler == 'tectonic':
            tectonic_cache = (getattr(_compile_context, 'original_source', source).parent.parent / '.tectonic-cache').resolve()
            tectonic_cache.mkdir(mode=0o700, parents=True, exist_ok=True)
            tectonic_config = Path.home() / 'Library/Application Support/Tectonic'
            tectonic_config.mkdir(mode=0o700, parents=True, exist_ok=True)
            readable.extend([str(tectonic_cache), str(tectonic_config)])
            writable.extend([str(tectonic_cache), str(tectonic_config)])
        if ghostscript:
            readable.append(str(Path(ghostscript).resolve().parent.parent))
        profile = '\n'.join([
            '(version 1)', '(deny default)', '(allow process*)', '(allow sysctl-read)', '(allow mach-lookup)',
            '(allow file-read-metadata)', '(allow file-read* (literal "/"))',
            *[f'(allow file-read* (subpath {quoted(path)}))' for path in readable],
            *[f'(allow file-read* (literal {quoted(path)}))' for path in readable_literals],
            *[f'(allow file-write* (subpath {quoted(path)}))' for path in writable],
            *(['(allow network*)'] if compiler == 'tectonic' else []),
            '(allow file-write* (literal "/dev/null"))',
        ])
        env = {'PATH': f'{binary}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(build), 'TMPDIR': str(build), 'TEXMFHOME': str(build / 'texmf'), 'TEXMFVAR': str(build / 'texmf-var'), 'TEXMFCONFIG': str(build / 'texmf-config'), 'openin_any': 'p', 'openout_any': 'p', 'shell_escape': 'f', 'LANG': 'en_US.UTF-8', 'USER': 'refora', 'LOGNAME': 'refora'}
        if compiler == 'tectonic':
            env.update({'TECTONIC_CACHE_DIR': str(tectonic_cache), 'TECTONIC_UNTRUSTED_MODE': '1'})
            command = ['/usr/bin/sandbox-exec', '-p', profile, str(binary / 'tectonic'), '-X', 'compile', '--untrusted', '--keep-logs', '--synctex', '--print', './' + root.name]
        else:
            mode = {'pdflatex': '-pdf', 'xelatex': '-xelatex', 'lualatex': '-lualatex'}[engine]
            command = ['/usr/bin/sandbox-exec', '-p', profile, str(binary / 'latexmk'), '-norc', mode, '-no-shell-escape', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', './' + root.name]
        cwd = build / root.relative_to(source).parent
        log_path = build / 'refora-build.log'
        deadline = time.monotonic() + 120
        with log_path.open('wb') as log:
            def run(command_args, working_directory):
                process = subprocess.Popen(['/bin/sh', '-c', 'ulimit -f 131072; exec "$@"', 'refora-latex', *command_args], cwd=working_directory, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    while True:
                        cancel = getattr(_compile_context, 'cancel', None)
                        if cancel is not None and cancel.is_set():
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                            raise RepoError('compile_cancelled', 'Compilation cancelled')
                        try:
                            process.wait(timeout=min(0.2, max(0.01, deadline - time.monotonic())))
                            break
                        except subprocess.TimeoutExpired:
                            if time.monotonic() >= deadline:
                                raise
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
        from refora_server.services.latex_synctex import read_synctex
        synctex = read_synctex(pdf.with_suffix('.synctex.gz'), build, cwd, source_hashes)
        return {'success': True, 'log': output, 'pdfBase64': base64.b64encode(data).decode('ascii'), 'synctex': synctex, '_inputs': fingerprint(input_hashes)}


class LatexService:
    def __init__(self, root_for_workspace, require_workspace, resolve_asset, settings=None, on_project=None):
        self.root_for_workspace = root_for_workspace
        self.require_workspace = require_workspace
        self.resolve_asset = resolve_asset
        self.settings = settings
        self.on_project = on_project
        self.active: dict[str, Any] = {}
        self.lock = threading.RLock()
        self.compilations: dict[tuple[str, str], tuple[threading.Event, str | None]] = {}
        self.cancelled_compilations: dict[tuple[str, str, str], float] = {}

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
        pending = review_files(source)
        files = sorted({p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file() and not p.is_symlink() and not any(part.startswith('.') or part == '__MACOSX' for part in p.relative_to(source).parts)} | set(pending))
        from refora_server.services.latex_templates import detect_template
        return {**data, 'files': files, 'template': detect_template(source, data['rootFile']), 'reviewFiles': pending, 'previewRevision': preview_revision(source), 'inputRevision': project_fingerprint(source, data['rootFile'])}, source

    def save_metadata(self, directory, project):
        metadata = {key: project[key] for key in ('id', 'title', 'rootFile')}
        atomic_write(directory / project['id'] / 'project.json', json.dumps(metadata).encode())

    def operate(self, workspace_id, request):
        if not isinstance(request, dict):
            raise RepoError('validation', 'LaTeX request must be an object')
        if request.get('action') in {'compile', 'cancelCompile'} and 'compileId' in request:
            token = request['compileId']
            if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', token):
                raise RepoError('validation', 'Invalid compilation ID')
        if request.get('action') == 'compile':
            return self._compile(workspace_id, request)
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
            return {'active': active, 'project': project, 'file': with_review(source, active['path'])}
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
                    report = import_sources(Path(path), source)
                    title = Path(path).name if Path(path).is_dir() else re.sub(r'\.(?:tar\.gz|tar|tgz|zip|tex)$', '', Path(path).name, flags=re.IGNORECASE)
                else:
                    if not isinstance(title, str) or not title.strip() or len(title) > 200:
                        raise RepoError('validation', 'Project title must be 1–200 characters')
                    atomic_write(source / 'main.tex', STARTER.encode())
                tex = sorted(p.relative_to(source).as_posix() for p in source.rglob('*.tex'))
                if not tex:
                    raise RepoError('invalid_archive', 'No .tex files found in the archive')
                roots = [name for name in tex if re.search(r'\\documentclass\b', re.sub(r'(?<!\\)%[^\n]*', '', read_source(source, name)['content']))]
                roots.sort(key=lambda name: (Path(name).name.lower() != 'main.tex', len(Path(name).parts), name))
                project = {'id': identifier, 'title': title, 'rootFile': (roots or tex)[0]}
                self.save_metadata(directory, project)
                if self.on_project:
                    self.on_project(workspace_id, project, request.get('placement'))
                return {'project': self.project(directory, identifier)[0], **({'importReport': report} if action == 'import' else {})}
            except Exception:
                shutil.rmtree(folder)
                raise
        project, source = self.project(directory, request.get('projectId'))
        if action == 'cancelCompile':
            key = (workspace_id, project['id'])
            token = request.get('compileId')
            active = self.compilations.get(key)
            if active and (token is None or active[1] == token):
                active[0].set()
            elif token is not None:
                self._prune_cancelled_compilations()
                self.cancelled_compilations[(*key, token)] = time.monotonic()
                while len(self.cancelled_compilations) > 256:
                    self.cancelled_compilations.pop(next(iter(self.cancelled_compilations)))
            return {}
        from refora_server.services.latex_files import file_operation
        result = file_operation(self, workspace_id, directory, project, source, request)
        if result is not None:
            return result
        if action == 'project':
            return {'project': project}
        if action == 'read':
            return {'file': with_review(source, request.get('path'))}
        if action == 'review':
            return {'file': resolve(source, request), 'project': self.project(directory, project['id'])[0]}
        if action in {'write', 'propose'}:
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
            if action == 'propose':
                before = read_source(source, name) if path.exists() else {'path': name, 'content': '', 'hash': ''}
                file = propose(source, name, content, before)
                return {'file': file, 'project': self.project(directory, project['id'])[0]}
            if read_review(source, name):
                raise RepoError('review_pending', 'Review the pending AI changes before editing this file.')
            from refora_server.services.latex_files import save_source
            save_source(source, name, content)
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
            project = self.project(directory, project['id'])[0]
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
        if action == 'preview':
            compiler = self.settings.get('latexCompiler', 'latexmk') if self.settings is not None else 'latexmk'
            path_key = 'tectonicBinPath' if compiler == 'tectonic' else 'latexBinPath'
            configured = self.settings.get(path_key, '') if self.settings is not None else ''
            cached = load_preview(source, project['rootFile'], compiler, configured)
            return {'compilation': cached} if cached else {}
        raise RepoError('validation', 'Unknown LaTeX operation')

    def _prune_cancelled_compilations(self):
        cutoff = time.monotonic() - 300
        self.cancelled_compilations = {key: created for key, created in self.cancelled_compilations.items() if created > cutoff}

    def _compile(self, workspace_id, request):
        token = request.get('compileId')
        key = (workspace_id, request.get('projectId'))
        with tempfile.TemporaryDirectory(prefix='refora-latex-snapshot-') as temporary:
            snapshot = Path(temporary) / 'files'
            with self.lock:
                project, source = self.project(self.directory(workspace_id), request.get('projectId'))
                self._prune_cancelled_compilations()
                if token is not None and self.cancelled_compilations.pop((*key, token), None) is not None:
                    raise RepoError('compile_cancelled', 'Compilation cancelled')
                if key in self.compilations:
                    raise RepoError('compile_busy', 'This project is already compiling')
                cancel = threading.Event()
                self.compilations[key] = (cancel, token)
                compiler = self.settings.get('latexCompiler', 'latexmk') if self.settings is not None else 'latexmk'
                path_key = 'tectonicBinPath' if compiler == 'tectonic' else 'latexBinPath'
                configured = self.settings.get(path_key, '') if self.settings is not None else ''
                try:
                    import_sources(source, snapshot)
                except Exception:
                    self.compilations.pop(key, None)
                    raise
            try:
                engine = request.get('engine', 'pdflatex')
                _compile_context.cancel = cancel
                _compile_context.original_source = source
                if cancel.is_set():
                    raise RepoError('compile_cancelled', 'Compilation cancelled')
                compilation = compile_project(snapshot, project['rootFile'], engine, compiler, configured)
                if cancel.is_set():
                    raise RepoError('compile_cancelled', 'Compilation cancelled')
                inputs = compilation.pop('_inputs', None) or project_fingerprint(snapshot, project['rootFile'])
                with self.lock:
                    if compilation.get('success') and compilation.get('pdfBase64'):
                        try:
                            compilation['builtAt'] = save_preview(source, project['rootFile'], compiler, configured, engine, inputs, compilation)
                        except (OSError, ValueError, RepoError):
                            compilation['cacheSaved'] = False
                        current, _ = self.project(self.directory(workspace_id), project['id'])
                        compilation['stale'] = current['rootFile'] != project['rootFile'] or inputs != current['inputRevision']
                return {'compilation': compilation}
            finally:
                _compile_context.cancel = None
                if hasattr(_compile_context, 'original_source'):
                    del _compile_context.original_source
                with self.lock:
                    self.compilations.pop(key, None)
