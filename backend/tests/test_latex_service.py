from __future__ import annotations

import io
import tarfile
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest

from refora_server.services.latex import LatexService, import_sources, safe_path, STARTER
from refora_server.repositories.errors import RepoError


@pytest.fixture
def service(tmp_path):
    image = tmp_path / 'figure.png'
    image.write_bytes(b'figure')
    def workspace(identifier):
        if identifier != 'ws':
            raise RepoError('not_found', 'Workspace not found')
    return LatexService(lambda _: str(tmp_path / 'sandbox'), workspace, lambda _: ({'id': 'image', 'workspaceId': 'ws'}, str(image)))


def create(service):
    return service.operate('ws', {'action': 'create', 'title': 'Paper'})['project']


def test_create_edit_reload_and_active_context(service):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'main.tex'}
    source = service.operate('ws', {'action': 'read', **args})['file']
    assert '\\documentclass' in source['content']
    service.operate('ws', {'action': 'activate', **args})
    assert service.operate('ws', {'action': 'active'})['file'] == source
    saved = service.operate('ws', {'action': 'write', **args, 'content': 'AI edit', 'expectedHash': source['hash']})['file']
    assert saved['hash'] != source['hash']
    assert service.operate('ws', {'action': 'active'})['file']['content'] == 'AI edit'
    with pytest.raises(RepoError, match='changed externally'):
        service.operate('ws', {'action': 'write', **args, 'content': 'stale', 'expectedHash': source['hash']})
    service.operate('ws', {'action': 'activate'})
    assert service.operate('ws', {'action': 'active'}) == {'active': None}
    assert service.operate('ws', {'action': 'list'})['projects'][0]['id'] == project['id']


def test_concurrent_edits_reject_stale_hash(service):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'main.tex'}
    source = service.operate('ws', {'action': 'read', **args})['file']
    def edit(content):
        try:
            service.operate('ws', {'action': 'write', **args, 'content': content, 'expectedHash': source['hash']})
            return True
        except RepoError:
            return False
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(edit, ['first', 'second'])) == [False, True]


def test_multifile_root_and_workspace_asset(service):
    project = create(service)
    identifier = project['id']
    service.operate('ws', {'action': 'write', 'projectId': identifier, 'path': 'chapters/paper.tex', 'content': STARTER, 'expectedHash': ''})
    root = service.operate('ws', {'action': 'root', 'projectId': identifier, 'path': 'chapters/paper.tex'})['project']
    assert root['rootFile'] == 'chapters/paper.tex'
    copied = service.operate('ws', {'action': 'asset', 'projectId': identifier, 'assetId': 'image'})
    assert copied['assetPath'].startswith('assets/')
    assert 'chapters/' + copied['assetPath'] in copied['project']['files']
    service.resolve_asset = lambda _: ({'id': 'x', 'workspaceId': 'other'}, 'figure.png')
    with pytest.raises(RepoError):
        service.operate('ws', {'action': 'asset', 'projectId': identifier, 'assetId': 'x'})


@pytest.mark.parametrize('name', ['../escape.tex', '/tmp/escape.tex', 'dir/../escape.tex', '.latexmkrc', 'a;touch.tex', 'a\\b.tex', 'a/./b.tex'])
def test_reject_unsafe_paths(tmp_path, name):
    with pytest.raises(RepoError):
        safe_path(tmp_path, name)


def test_symlink_cannot_escape(tmp_path):
    (tmp_path / 'link').symlink_to('/tmp')
    with pytest.raises(RepoError):
        safe_path(tmp_path, 'link/escape.tex')


def test_import_realistic_zip_preserves_sources_and_figures(service, tmp_path):
    archive = tmp_path / 'paper.zip'
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('paper/main.tex', STARTER)
        output.writestr('paper/parts/introduction.tex', 'Introduction')
        output.writestr('paper/refs.bib', '@article{one,title={Paper}}')
        output.writestr('paper/figures/plot.pdf', b'%PDF')
    project = service.operate('ws', {'action': 'import', 'importPath': str(archive)})['project']
    assert project['rootFile'] == 'paper/main.tex'
    assert len(project['files']) == 4


def test_import_arxiv_tar_and_reject_traversal(tmp_path):
    archive = tmp_path / 'source.tar.gz'
    with tarfile.open(archive, 'w:gz') as output:
        data = STARTER.encode()
        info = tarfile.TarInfo('./main.tex')
        info.size = len(data)
        output.addfile(info, io.BytesIO(data))
    target = tmp_path / 'project'
    target.mkdir()
    import_sources(archive, target)
    assert (target / 'main.tex').read_text() == STARTER
    with tarfile.open(archive, 'w:gz') as output:
        info = tarfile.TarInfo('../outside.tex')
        info.size = 1
        output.addfile(info, io.BytesIO(b'x'))
    with pytest.raises(RepoError):
        import_sources(archive, target)
    assert not (tmp_path / 'outside.tex').exists()


def test_failed_import_does_not_leave_project(service, tmp_path):
    archive = tmp_path / 'empty.zip'
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('readme.txt', 'no sources')
    with pytest.raises(RepoError):
        service.operate('ws', {'action': 'import', 'importPath': str(archive)})
    assert service.operate('ws', {'action': 'list'}) == {'projects': []}


def test_workspace_and_project_scope(service):
    project = create(service)
    with pytest.raises(RepoError):
        service.operate('other', {'action': 'project', 'projectId': project['id']})
    with pytest.raises(RepoError):
        service.operate('ws', {'action': 'project', 'projectId': '../escape'})


def test_tampered_project_metadata_cannot_redirect_writes(service):
    import json
    project = create(service)
    folder = service.directory('ws') / project['id']
    (folder / 'project.json').write_text(json.dumps({**project, 'id': '../escape'}))
    with pytest.raises(RepoError, match='metadata'):
        service.operate('ws', {'action': 'root', 'projectId': project['id'], 'path': 'main.tex'})


def test_configured_tex_directory_requires_a_real_compiler(service, tmp_path):
    class Settings(dict):
        def set(self, key, value):
            self[key] = value
    settings = Settings()
    service.settings = settings
    with pytest.raises(RepoError):
        service.operate('ws', {'action': 'configure', 'runtimePath': str(tmp_path)})
    (tmp_path / 'latexmk').write_text('compiler')
    service.operate('ws', {'action': 'configure', 'runtimePath': str(tmp_path)})
    assert settings['latexBinPath'] == str(tmp_path)


def test_compilation_never_returns_an_imported_stale_pdf(tmp_path, monkeypatch):
    from refora_server.services import latex
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'main.tex').write_text(STARTER)
    (source / 'main.pdf').write_bytes(b'%PDF-old source artifact')
    binary = tmp_path / 'tex' / 'bin'
    binary.mkdir(parents=True)
    monkeypatch.setattr(latex, 'tex_binary', lambda _: binary)
    calls = []
    class Process:
        returncode = 0
        def __init__(self, command, **kwargs):
            calls.append((command, kwargs))
        def wait(self, **kwargs):
            return 0
    monkeypatch.setattr(latex.subprocess, 'Popen', Process)
    result = latex.compile_project(source, 'main.tex', 'pdflatex')
    assert result['success'] is False
    assert 'pdfBase64' not in result
    command, kwargs = calls[0]
    assert '-no-shell-escape' in command and '-norc' in command
    profile = command[command.index('-p') + 1]
    assert '(deny default)' in profile
    assert '(allow network' not in profile
    assert kwargs['env']['openin_any'] == 'p'
    assert (source / 'main.pdf').read_bytes() == b'%PDF-old source artifact'


def test_compiler_output_symlinks_cannot_read_outside_build(tmp_path, monkeypatch):
    from refora_server.services import latex
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'main.tex').write_text(STARTER)
    sentinel = tmp_path / 'private.txt'
    sentinel.write_text('private sentinel')
    binary = tmp_path / 'tex' / 'bin'
    binary.mkdir(parents=True)
    monkeypatch.setattr(latex, 'tex_binary', lambda _: binary)
    class Process:
        returncode = 0
        def __init__(self, command, **kwargs):
            (kwargs['cwd'] / 'main.pdf').symlink_to(sentinel)
        def wait(self, **kwargs):
            return 0
    monkeypatch.setattr(latex.subprocess, 'Popen', Process)
    with pytest.raises(RepoError):
        latex.compile_project(source, 'main.tex', 'pdflatex')
    assert sentinel.read_text() == 'private sentinel'
