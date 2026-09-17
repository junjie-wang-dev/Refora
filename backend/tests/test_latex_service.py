from __future__ import annotations

import io
import tarfile
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest

from refora_server.services.latex import LatexService, compiler_binary, import_sources, safe_path, STARTER
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


def test_compiler_binary_accepts_the_executable_path(tmp_path):
    executable = tmp_path / 'tectonic'
    executable.write_text('compiler')
    executable.chmod(0o755)
    assert compiler_binary('tectonic', str(executable)) == tmp_path.resolve()


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


def test_tectonic_compilation_uses_untrusted_mode_and_persistent_cache(tmp_path, monkeypatch):
    from refora_server.services import latex
    source = tmp_path / 'work' / 'latex' / 'project' / 'files'
    source.mkdir(parents=True)
    (source / 'main.tex').write_text(STARTER)
    binary = tmp_path / 'bin'
    binary.mkdir()
    monkeypatch.setattr(latex, 'compiler_binary', lambda executable, configured='': binary)
    calls = []
    class Process:
        returncode = 0
        def __init__(self, command, **kwargs):
            calls.append((command, kwargs))
            (kwargs['cwd'] / 'main.pdf').write_bytes(b'%PDF-tectonic')
        def wait(self, **kwargs):
            return 0
    monkeypatch.setattr(latex.subprocess, 'Popen', Process)
    result = latex.compile_project(source, 'main.tex', 'pdflatex', 'tectonic')
    assert result['success'] is True
    command, kwargs = calls[0]
    assert command[command.index(str(binary / 'tectonic')):] == [
        str(binary / 'tectonic'), '-X', 'compile', '--untrusted', '--keep-logs', '--synctex', '--print', './main.tex'
    ]
    assert kwargs['env']['TECTONIC_UNTRUSTED_MODE'] == '1'
    assert kwargs['env']['TECTONIC_CACHE_DIR'] == str(tmp_path / 'work' / 'latex' / '.tectonic-cache')
    profile = command[command.index('-p') + 1]
    assert '(allow network*)' in profile
    assert str(tmp_path / 'work' / 'latex' / '.tectonic-cache') in profile


def test_compile_uses_the_configured_global_compiler(service, tmp_path, monkeypatch):
    from refora_server.services import latex
    class Settings(dict):
        def set(self, key, value):
            self[key] = value
    service.settings = Settings(latexCompiler='tectonic', tectonicBinPath=str(tmp_path / 'tectonic-bin'))
    project = create(service)
    called = {}
    def compile_stub(source, root_file, engine, compiler, configured):
        called.update(root_file=root_file, engine=engine, compiler=compiler, configured=configured)
        return {'success': True, 'log': ''}
    monkeypatch.setattr(latex, 'compile_project', compile_stub)
    service.operate('ws', {'action': 'compile', 'projectId': project['id'], 'engine': 'xelatex'})
    assert called == {
        'root_file': 'main.tex',
        'engine': 'xelatex',
        'compiler': 'tectonic',
        'configured': str(tmp_path / 'tectonic-bin')
    }


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


def test_import_folder_copies_complete_project_and_keeps_source_independent(service, tmp_path):
    folder = tmp_path / 'Conference Paper'
    (folder / 'sections').mkdir(parents=True)
    (folder / '.git').mkdir()
    (folder / '.git/config').write_text('private config')
    (folder / 'main.tex').write_text(r'\documentclass[conference]{IEEEtran}\input{sections/intro}')
    (folder / 'sections/intro.tex').write_text('Introduction')
    (folder / 'references.bib').write_text('@article{paper,title={Paper}}')
    (folder / 'IEEEtran.cls').write_text(r'\ProvidesClass{IEEEtran}')
    (folder / 'figure.png').write_bytes(b'figure')
    (folder / 'compile.sh').write_text('unused')
    project = service.operate('ws', {'action': 'import', 'importPath': str(folder)})['project']
    assert project['title'] == 'Conference Paper'
    assert project['rootFile'] == 'main.tex'
    assert project['template'] == 'IEEE Conference'
    assert project['files'] == ['IEEEtran.cls', 'figure.png', 'main.tex', 'references.bib', 'sections/intro.tex']
    (folder / 'sections/intro.tex').write_text('Original changed')
    assert service.operate('ws', {'action': 'read', 'projectId': project['id'], 'path': 'sections/intro.tex'})['file']['content'] == 'Introduction'
    assert service.operate('ws', {'action': 'list'})['projects'] == [project]


@pytest.mark.parametrize('kind', ['file', 'directory', 'limit', 'empty'])
def test_invalid_folder_import_rolls_back(service, tmp_path, monkeypatch, kind):
    from refora_server.services import latex
    folder = tmp_path / 'invalid'
    folder.mkdir()
    if kind != 'empty':
        (folder / 'main.tex').write_text(STARTER)
    if kind == 'file':
        (folder / 'linked.tex').symlink_to(folder / 'main.tex')
    elif kind == 'directory':
        (folder / 'linked').symlink_to(tmp_path, target_is_directory=True)
    elif kind == 'limit':
        monkeypatch.setattr(latex, 'MAX_PROJECT', 5)
    with pytest.raises(RepoError):
        service.operate('ws', {'action': 'import', 'importPath': str(folder)})
    assert service.operate('ws', {'action': 'list'}) == {'projects': []}


@pytest.mark.parametrize(('declaration', 'template'), [
    (r'\documentclass{elsarticle}', 'Elsevier'),
    (r'\documentclass{acmart}', 'ACM'),
    (r'\documentclass[aps]{revtex4-2}', 'APS / REVTeX'),
    (r'\documentclass{article}\usepackage{neurips_2025}', 'NeurIPS 2025'),
    (r'\documentclass{article}\usepackage{iclr2026_conference}', 'ICLR 2026'),
    (r'\documentclass{article}\usepackage[review]{cvpr}', 'CVPR'),
    (r'\documentclass{article}', None),
    ('% \\usepackage{cvpr}\n\\documentclass{article}', None),
])
def test_template_detected_from_active_source(service, declaration, template):
    project = create(service)
    source = service.operate('ws', {'action': 'read', 'projectId': project['id'], 'path': 'main.tex'})['file']
    saved = service.operate('ws', {'action': 'write', 'projectId': project['id'], 'path': 'main.tex', 'content': declaration, 'expectedHash': source['hash']})['project']
    assert saved['template'] == template


def test_template_follows_included_preamble_and_root_changes(service):
    project = create(service)
    identifier = project['id']
    for name, content in [('preamble.tex', r'\usepackage{neurips_2026}\input{preamble}'), ('conference.tex', r'\documentclass{article}\input{preamble}'), ('unused.sty', r'\usepackage{cvpr}')]:
        service.operate('ws', {'action': 'write', 'projectId': identifier, 'path': name, 'content': content, 'expectedHash': ''})
    assert service.operate('ws', {'action': 'project', 'projectId': identifier})['project']['template'] is None
    updated = service.operate('ws', {'action': 'root', 'projectId': identifier, 'path': 'conference.tex'})['project']
    assert updated['template'] == 'NeurIPS 2026'


def test_ai_review_stages_and_resolves_individual_hunks(service):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'main.tex'}
    original = service.operate('ws', {'action': 'read', **args})['file']
    before = 'Alpha is wrong.\nUnchanged separator.\nBeta is wrong.\n'
    file = service.operate('ws', {'action': 'write', **args, 'content': before, 'expectedHash': original['hash']})['file']
    proposed = service.operate('ws', {'action': 'propose', **args, 'content': 'Alpha is right.\nUnchanged separator.\nBeta is right.\n', 'expectedHash': file['hash']})['file']
    assert proposed['content'] == before
    review = proposed['review']
    assert len(review['edits']) == 2
    assert service.operate('ws', {'action': 'project', 'projectId': project['id']})['project']['reviewFiles'] == ['main.tex']
    restarted = LatexService(service.root_for_workspace, service.require_workspace, service.resolve_asset)
    assert restarted.operate('ws', {'action': 'read', **args})['file']['review'] == review
    with pytest.raises(RepoError, match='pending AI changes'):
        service.operate('ws', {'action': 'write', **args, 'content': 'overwrite', 'expectedHash': file['hash']})
    resolved = service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': 'accept', 'editId': review['edits'][1]['id']})['file']
    assert resolved['content'] == 'Alpha is wrong.\nUnchanged separator.\nBeta is right.\n'
    with pytest.raises(RepoError, match='already been reviewed'):
        service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': 'reject', 'editId': review['edits'][1]['id']})
    result = service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': 'reject'})
    assert result['file']['content'] == resolved['content']
    assert 'review' not in result['file']
    assert result['project']['reviewFiles'] == []


@pytest.mark.parametrize('decision', ['accept', 'reject'])
def test_ai_review_all_handles_unicode_insertions_deletions_and_eof(service, decision):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'main.tex'}
    original = service.operate('ws', {'action': 'read', **args})['file']
    before, after = '旧文字\nStable\nDelete me\nLast', '新文字\nStable\nLast\nAdded\n'
    file = service.operate('ws', {'action': 'write', **args, 'content': before, 'expectedHash': original['hash']})['file']
    review = service.operate('ws', {'action': 'propose', **args, 'content': after, 'expectedHash': file['hash']})['file']['review']
    result = service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': decision})['file']
    assert result['content'] == (after if decision == 'accept' else before)
    assert 'review' not in result


def test_ai_review_never_overwrites_external_edits(service):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'main.tex'}
    file = service.operate('ws', {'action': 'read', **args})['file']
    review = service.operate('ws', {'action': 'propose', **args, 'content': 'Suggestion', 'expectedHash': file['hash']})['file']['review']
    _, source = service.project(service.directory('ws'), project['id'])
    (source / 'main.tex').write_text('External edit')
    with pytest.raises(RepoError, match='changed externally'):
        service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': 'accept'})
    result = service.operate('ws', {'action': 'review', **args, 'reviewId': review['id'], 'decision': 'reject'})['file']
    assert result['content'] == 'External edit'
    assert 'review' not in result


@pytest.mark.parametrize('decision', ['accept', 'reject'])
def test_ai_new_files_are_staged_before_creation(service, decision):
    project = create(service)
    args = {'projectId': project['id'], 'path': 'parts/new.tex'}
    proposed = service.operate('ws', {'action': 'propose', **args, 'content': 'New section\n', 'expectedHash': ''})
    assert 'parts/new.tex' in proposed['project']['files']
    _, source = service.project(service.directory('ws'), project['id'])
    assert not (source / 'parts/new.tex').exists()
    pending = service.operate('ws', {'action': 'read', **args})['file']
    assert pending['content'] == ''
    result = service.operate('ws', {'action': 'review', **args, 'reviewId': pending['review']['id'], 'decision': decision})
    assert (source / 'parts/new.tex').exists() == (decision == 'accept')
    assert ('parts/new.tex' in result['project']['files']) == (decision == 'accept')


def test_preview_cache_survives_restarts_and_failed_compiles(service, monkeypatch):
    from refora_server.services import latex
    import base64
    project = create(service)
    request = {'projectId': project['id']}
    assert service.operate('ws', {'action': 'preview', **request}) == {}
    file = service.operate('ws', {'action': 'read', **request, 'path': 'main.tex'})['file']
    pdf = base64.b64encode(b'%PDF-1.7\nSuccessful preview').decode()
    mapping = {'boxes': [], 'sourceHashes': {'main.tex': file['hash']}}
    monkeypatch.setattr(latex, 'compile_project', lambda *args: {'success': True, 'log': 'Success', 'pdfBase64': pdf, 'synctex': mapping})
    built = service.operate('ws', {'action': 'compile', **request, 'engine': 'xelatex'})['compilation']
    assert built['stale'] is False
    revision = service.operate('ws', {'action': 'project', **request})['project']['previewRevision']
    assert revision
    restarted = LatexService(service.root_for_workspace, service.require_workspace, service.resolve_asset)
    preview = restarted.operate('ws', {'action': 'preview', **request})['compilation']
    assert preview['pdfBase64'] == pdf
    assert preview['builtAt'] == built['builtAt']
    assert preview['synctex'] == mapping
    assert preview['engine'] == 'xelatex'
    assert preview['stale'] is False
    service.operate('ws', {'action': 'write', **request, 'path': 'main.tex', 'content': 'Invalid source', 'expectedHash': file['hash']})
    monkeypatch.setattr(latex, 'compile_project', lambda *args: {'success': False, 'log': 'Syntax error'})
    assert not restarted.operate('ws', {'action': 'compile', **request})['compilation']['success']
    preview = restarted.operate('ws', {'action': 'preview', **request})['compilation']
    assert preview['pdfBase64'] == pdf
    assert preview['stale'] is True
    assert restarted.operate('ws', {'action': 'project', **request})['project']['previewRevision'] == revision
    other = create(service)
    assert service.operate('ws', {'action': 'preview', 'projectId': other['id']}) == {}


def test_preview_cache_detects_figures_dependencies_settings_and_corruption(service, monkeypatch):
    from refora_server.services import latex
    import base64
    project = create(service)
    request = {'projectId': project['id']}
    _, source = service.project(service.directory('ws'), project['id'])
    (source / 'figure.png').write_bytes(b'original image')
    pdf = base64.b64encode(b'%PDF-1.7\nPreview').decode()
    monkeypatch.setattr(latex, 'compile_project', lambda *args: {'success': True, 'log': '', 'pdfBase64': pdf})
    service.operate('ws', {'action': 'compile', **request})
    (source / 'figure.png').write_bytes(b'changed image')
    assert service.operate('ws', {'action': 'preview', **request})['compilation']['stale']
    (source / 'figure.png').write_bytes(b'original image')
    assert not service.operate('ws', {'action': 'preview', **request})['compilation']['stale']
    (source / 'refs.bib').write_text('@article{new}')
    assert service.operate('ws', {'action': 'preview', **request})['compilation']['stale']
    (source / 'refs.bib').unlink()
    service.settings = {'latexCompiler': 'tectonic'}
    assert service.operate('ws', {'action': 'preview', **request})['compilation']['stale']
    (source.parent / 'preview-cache.json').write_text('not json')
    assert service.operate('ws', {'action': 'preview', **request}) == {}
    assert service.operate('ws', {'action': 'read', **request, 'path': 'main.tex'})['file']['content'] == STARTER


def test_preview_keeps_snapshot_fingerprint_when_source_changes_during_compile(service, monkeypatch):
    from refora_server.services import latex
    from refora_server.services.latex_preview_cache import project_fingerprint
    import base64
    project = create(service)
    def compile_changed(source, root, *_):
        inputs = project_fingerprint(source, root)
        (source / root).write_text('Changed during compilation')
        return {'success': True, 'log': '', 'pdfBase64': base64.b64encode(b'%PDF-1.7\nOld snapshot').decode(), '_inputs': inputs}
    monkeypatch.setattr(latex, 'compile_project', compile_changed)
    built = service.operate('ws', {'action': 'compile', 'projectId': project['id']})['compilation']
    assert built['stale'] is True
    assert '_inputs' not in built
    assert service.operate('ws', {'action': 'preview', 'projectId': project['id']})['compilation']['stale'] is True
