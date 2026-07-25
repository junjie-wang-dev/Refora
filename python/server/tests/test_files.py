import os

import pytest

from refora_server.db.errors import RepoError
from refora_server.library.files import (
    WORKSPACE_ASSET_DIRECTORY,
    AGENT_SANDBOX_DIRECTORY,
    copyFile,
    fileExists,
    fileStat,
    findPdfsRecursively,
    moveFile,
)
from refora_server.library.pdf_path import resolvePdfFilePath


def _write(path: str, content: bytes = b"%PDF-1.4 fake") -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return path


def test_fileExists_present_and_absent(tmp_path):
    pdf = _write(str(tmp_path / "a.pdf"))
    assert fileExists(pdf) is True
    assert fileExists(str(tmp_path / "nope.pdf")) is False


def test_resolvePdfFilePath_absolute_pdf(tmp_path):
    pdf = _write(str(tmp_path / "a.pdf"))
    resolved = resolvePdfFilePath(pdf)
    assert resolved.lower().endswith(".pdf")
    assert os.path.isabs(resolved)


def test_resolvePdfFilePath_rejects_relative():
    with pytest.raises(RepoError) as exc:
        resolvePdfFilePath("relative.pdf")
    assert exc.value.code == "invalid_path"


def test_resolvePdfFilePath_rejects_non_pdf(tmp_path):
    txt = _write(str(tmp_path / "a.txt"))
    with pytest.raises(RepoError) as exc:
        resolvePdfFilePath(txt)
    assert exc.value.code == "invalid_path"


def test_resolvePdfFilePath_missing_file(tmp_path):
    with pytest.raises(RepoError) as exc:
        resolvePdfFilePath(str(tmp_path / "missing.pdf"))
    assert exc.value.code == "file_missing"


def test_resolvePdfFilePath_rejects_empty():
    with pytest.raises(RepoError):
        resolvePdfFilePath("")


def test_fileStat_returns_size(tmp_path):
    pdf = _write(str(tmp_path / "a.pdf"), b"x" * 100)
    stat = fileStat(pdf)
    assert stat["size"] == 100
    assert stat["isFile"] is True
    assert stat["isDirectory"] is False


def test_fileStat_rejects_non_pdf(tmp_path):
    txt = _write(str(tmp_path / "a.txt"))
    with pytest.raises(RepoError):
        fileStat(txt)


def test_moveFile_moves_content(tmp_path):
    src = _write(str(tmp_path / "src.pdf"), b"payload")
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir()
    dest = str(dest_dir / "moved.pdf")
    result = moveFile(src, dest)
    assert os.path.isfile(result)
    assert not os.path.exists(src)
    with open(result, "rb") as f:
        assert f.read() == b"payload"


def test_moveFile_rejects_non_pdf_source(tmp_path):
    src = _write(str(tmp_path / "src.txt"))
    with pytest.raises(RepoError):
        moveFile(src, str(tmp_path / "out.pdf"))


def test_moveFile_rejects_non_pdf_dest(tmp_path):
    src = _write(str(tmp_path / "src.pdf"))
    with pytest.raises(RepoError):
        moveFile(src, str(tmp_path / "out.txt"))


def test_copyFile_copies_content(tmp_path):
    src = _write(str(tmp_path / "src.pdf"), b"copy-payload")
    dest = str(tmp_path / "copied.pdf")
    result = copyFile(src, dest)
    assert os.path.isfile(result)
    assert os.path.exists(src)
    with open(result, "rb") as f:
        assert f.read() == b"copy-payload"


def test_copyFile_rejects_missing_dest_dir(tmp_path):
    src = _write(str(tmp_path / "src.pdf"))
    with pytest.raises(RepoError):
        copyFile(src, str(tmp_path / "nonexistent_dir" / "out.pdf"))


def test_findPdfsRecursively_finds_pdfs(tmp_path):
    _write(str(tmp_path / "a.pdf"))
    _write(str(tmp_path / "sub" / "b.pdf"))
    _write(str(tmp_path / "sub" / "deep" / "c.pdf"))
    _write(str(tmp_path / "note.txt"))
    results = findPdfsRecursively(str(tmp_path))
    names = sorted(os.path.basename(r) for r in results)
    assert names == ["a.pdf", "b.pdf", "c.pdf"]


def test_findPdfsRecursively_case_insensitive_extension(tmp_path):
    _write(str(tmp_path / "upper.PDF"))
    results = findPdfsRecursively(str(tmp_path))
    assert len(results) == 1
    assert results[0].lower().endswith(".pdf")


def test_findPdfsRecursively_skips_hidden_by_default(tmp_path):
    _write(str(tmp_path / ".hidden" / "a.pdf"))
    _write(str(tmp_path / "visible.pdf"))
    results = findPdfsRecursively(str(tmp_path))
    assert len(results) == 1
    assert os.path.basename(results[0]) == "visible.pdf"


def test_findPdfsRecursively_includes_hidden_when_disabled(tmp_path):
    _write(str(tmp_path / ".hidden" / "a.pdf"))
    results = findPdfsRecursively(str(tmp_path), skipHidden=False)
    assert len(results) == 1


def test_findPdfsRecursively_skips_asset_and_sandbox_dirs(tmp_path):
    _write(str(tmp_path / WORKSPACE_ASSET_DIRECTORY / "a.pdf"))
    _write(str(tmp_path / AGENT_SANDBOX_DIRECTORY / "b.pdf"))
    _write(str(tmp_path / "real.pdf"))
    results = findPdfsRecursively(str(tmp_path))
    assert len(results) == 1
    assert os.path.basename(results[0]) == "real.pdf"


def test_findPdfsRecursively_skips_symlinks(tmp_path):
    real = _write(str(tmp_path / "real.pdf"))
    link = str(tmp_path / "link.pdf")
    os.symlink(real, link)
    results = findPdfsRecursively(str(tmp_path))
    names = sorted(os.path.basename(r) for r in results)
    assert names == ["real.pdf"]


def test_findPdfsRecursively_empty_dir(tmp_path):
    assert findPdfsRecursively(str(tmp_path)) == []


def test_findPdfsRecursively_avoids_symlink_loops(tmp_path):
    sub = tmp_path / "sub"
    sub.mkdir()
    _write(str(sub / "a.pdf"))
    os.symlink(tmp_path, str(sub / "loop"))
    results = findPdfsRecursively(str(tmp_path))
    names = sorted(os.path.basename(r) for r in results)
    assert names == ["a.pdf"]
