import hashlib
import os

import pytest

from refora_server.library.file_hash import CHUNK_SIZE, streamHash


def _write_pdf(path: str, content: bytes) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return path


def test_streamHash_known_content(tmp_path):
    pdf = _write_pdf(str(tmp_path / "a.pdf"), b"hello world")
    expected = hashlib.sha256(b"hello world").hexdigest()
    assert streamHash(pdf) == expected


def test_streamHash_empty_file(tmp_path):
    pdf = _write_pdf(str(tmp_path / "empty.pdf"), b"")
    expected = hashlib.sha256(b"").hexdigest()
    assert streamHash(pdf) == expected


def test_streamHash_large_file_matches_full_hash(tmp_path):
    payload = os.urandom(256 * 1024)
    pdf = _write_pdf(str(tmp_path / "big.pdf"), payload)
    expected = hashlib.sha256(payload).hexdigest()
    assert streamHash(pdf) == expected


def test_streamHash_chunk_size_is_64kb():
    assert CHUNK_SIZE == 64 * 1024


def test_streamHash_missing_file_returns_none(tmp_path):
    assert streamHash(str(tmp_path / "nope.pdf")) is None


def test_streamHash_directory_returns_none(tmp_path):
    assert streamHash(str(tmp_path)) is None


def test_streamHash_two_different_files_differ(tmp_path):
    a = _write_pdf(str(tmp_path / "a.pdf"), b"content a")
    b = _write_pdf(str(tmp_path / "b.pdf"), b"content b")
    assert streamHash(a) != streamHash(b)


def test_streamHash_uses_chunked_read(tmp_path, monkeypatch):
    import builtins

    calls = {"count": 0}
    real_open = builtins.open

    class CountingFile:
        def __init__(self, fileobj):
            self._f = fileobj

        def read(self, size=-1):
            calls["count"] += 1
            return self._f.read(size)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self._f.close()

        def __getattr__(self, name):
            return getattr(self._f, name)

    def patched_open(path, mode="r", *a, **k):
        return CountingFile(real_open(path, mode, *a, **k))

    monkeypatch.setattr(builtins, "open", patched_open)
    payload = os.urandom(200 * 1024)
    pdf = _write_pdf(str(tmp_path / "chunked.pdf"), payload)
    result = streamHash(pdf)
    assert result == hashlib.sha256(payload).hexdigest()
    assert calls["count"] > 1
