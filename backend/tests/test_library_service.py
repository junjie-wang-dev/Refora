import os

import pytest

from conftest import open_migrated_db
from refora_server.repositories.errors import RepoError
from refora_server.repositories.settings import create_settings_repository


def _make_repos(db):
    return {"settings": create_settings_repository(db), "documents": None}


def _make_service(repos, emitted=None):
    from refora_server.services.library import createLibraryService

    def emit(event, payload):
        if emitted is not None:
            emitted.append((event, payload))

    return createLibraryService(repos, {"emit": emit})


def test_switchLibrary_updates_settings(tmp_path):
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        svc = _make_service(repos)
        folder = str(tmp_path)
        ack = svc["switchLibrary"](folder)
        assert ack == {"ack": True}
        assert repos["settings"].get("libraryFolderPath", "") == os.path.normpath(folder)
    finally:
        db.close()


def test_switchLibrary_emits_event(tmp_path):
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        emitted = []
        svc = _make_service(repos, emitted)
        svc["switchLibrary"](str(tmp_path))
        assert len(emitted) == 1
        assert emitted[0][0] == "library.switched"
        assert emitted[0][1] == {"path": os.path.normpath(str(tmp_path))}
    finally:
        db.close()


def test_switchLibrary_invalid_folder_raises():
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        svc = _make_service(repos)
        with pytest.raises(RepoError) as exc:
            svc["switchLibrary"]("/nonexistent/path/xyz")
        assert exc.value.code == "invalid_argument"
    finally:
        db.close()


def test_switchLibrary_empty_string_raises():
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        svc = _make_service(repos)
        with pytest.raises(RepoError):
            svc["switchLibrary"]("")
    finally:
        db.close()


def test_switchLibrary_file_not_directory_raises(tmp_path):
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        svc = _make_service(repos)
        f = tmp_path / "file.txt"
        f.write_text("x")
        with pytest.raises(RepoError):
            svc["switchLibrary"](str(f))
    finally:
        db.close()


def test_getLibraryFolder_returns_current():
    db = open_migrated_db()
    try:
        repos = _make_repos(db)
        svc = _make_service(repos)
        repos["settings"].set("libraryFolderPath", "/my/lib")
        assert svc["getLibraryFolder"]() == "/my/lib"
    finally:
        db.close()
