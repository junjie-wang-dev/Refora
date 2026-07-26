from __future__ import annotations

import os

import pytest
from deepagents.backends.protocol import BackendProtocol

from refora_server.agent.sandbox_backend import (
    SANDBOX_DIRECTORIES,
    ReforaFilesystemBackend,
    create_refora_filesystem_backend,
)


def test_backend_implements_protocol_and_creates_virtual_root(tmp_path):
    root = tmp_path / "sandbox"
    backend = create_refora_filesystem_backend(root.resolve())

    assert isinstance(backend, BackendProtocol)
    assert backend.virtual_mode is True
    assert not hasattr(backend, "execute")
    assert {entry.name for entry in root.iterdir()} == set(SANDBOX_DIRECTORIES)
    listing = backend.ls("/")
    assert listing.error is None
    assert {entry["path"] for entry in listing.entries or []} == {
        f"/{directory}/" for directory in SANDBOX_DIRECTORIES
    }


def test_backend_persists_deepagents_file_operations(tmp_path):
    root = (tmp_path / "sandbox").resolve()
    first = ReforaFilesystemBackend(root)

    written = first.write("/outputs/report.md", "alpha\nbeta\n")
    assert written.error is None
    assert (root / "outputs" / "report.md").read_text() == "alpha\nbeta\n"

    read = first.read("/outputs/report.md")
    assert read.error is None
    assert read.file_data is not None
    assert read.file_data["content"] == "alpha\nbeta\n"

    edited = first.edit("/outputs/report.md", "beta", "gamma")
    assert edited.error is None
    assert edited.occurrences == 1

    globbed = first.glob("**/*.md", "/outputs")
    assert globbed.error is None
    assert [match["path"] for match in globbed.matches or []] == [
        "/outputs/report.md"
    ]

    grepped = first.grep("gamma", "/outputs", "**/*.md")
    assert grepped.error is None
    assert grepped.matches == [
        {"path": "/outputs/report.md", "line": 2, "text": "gamma"}
    ]

    second = ReforaFilesystemBackend(root)
    persisted = second.read("/outputs/report.md")
    assert persisted.error is None
    assert persisted.file_data is not None
    assert persisted.file_data["content"] == "alpha\ngamma\n"


@pytest.mark.parametrize(
    "path",
    [
        "../outside.txt",
        "/work/../../outside.txt",
        "~/.ssh/config",
        "/Users/example/.ssh/config",
        "/etc/passwd",
        "/private/tmp/escape.txt",
        "/root-file.txt",
    ],
)
def test_backend_rejects_traversal_home_and_host_paths(tmp_path, path):
    root = (tmp_path / "sandbox").resolve()
    backend = ReforaFilesystemBackend(root)

    result = backend.write(path, "blocked")

    assert result.error
    assert not (tmp_path / "outside.txt").exists()
    assert {entry.name for entry in root.iterdir()} == set(SANDBOX_DIRECTORIES)


def test_backend_rejects_symlink_escape_for_all_file_operations(tmp_path):
    root = (tmp_path / "sandbox").resolve()
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_text("secret marker")
    backend = ReforaFilesystemBackend(root)
    os.symlink(outside, root / "work" / "escape")

    assert backend.ls("/work/escape").error
    assert backend.read("/work/escape/secret.txt").error
    assert backend.write("/work/escape/new.txt", "blocked").error
    assert backend.edit("/work/escape/secret.txt", "secret", "leaked").error
    assert backend.glob("**/*.txt", "/work/escape").error
    assert backend.grep("secret marker", "/work/escape").error
    assert backend.upload_files(
        [("/work/escape/upload.txt", b"blocked")]
    )[0].error == "invalid_path"
    assert backend.download_files(
        ["/work/escape/secret.txt"]
    )[0].error == "invalid_path"
    assert secret.read_text() == "secret marker"
    assert not (outside / "new.txt").exists()
    assert not (outside / "upload.txt").exists()


def test_backend_limits_new_files_to_persistent_directories(tmp_path):
    root = (tmp_path / "sandbox").resolve()
    backend = ReforaFilesystemBackend(root)

    for directory in SANDBOX_DIRECTORIES:
        result = backend.write(f"/{directory}/{directory}.txt", directory)
        assert result.error is None
        assert (root / directory / f"{directory}.txt").read_text() == directory

    assert backend.write("/unapproved/file.txt", "blocked").error
    assert backend.write("/file.txt", "blocked").error
    assert backend.glob("/etc/**").error
