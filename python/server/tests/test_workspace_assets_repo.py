import os

import pytest

from conftest import make_workspace_assets_repo, make_workspaces_repo, open_migrated_db
from refora_server.repositories.errors import RepoError
from refora_server.repositories.workspace_assets import (
    AUDIO_TYPES,
    IMAGE_TYPES,
    TEXT_EXTENSIONS,
    VIDEO_TYPES,
    workspace_asset_media_type,
)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


def _make_workspace(db, name: str = "ws-1") -> str:
    ws = make_workspaces_repo(db)["create"](name)
    return ws["id"]


def _asset_input(
    *,
    workspace_id: str,
    id: str | None = None,
    file_name: str = "plot.png",
    file_path: str = "workspace-assets/asset-1/plot.png",
    source_path: str = "/orig/plot.png",
    mime_type: str = "image/png",
    preview_kind: str = "image",
    file_size: int = 1234,
    file_hash: str = "hash-1",
    file_missing: int = 0,
    created_at: int | None = None,
    updated_at: int | None = None,
) -> dict:
    return {
        "id": id,
        "workspaceId": workspace_id,
        "fileName": file_name,
        "filePath": file_path,
        "sourcePath": source_path,
        "mimeType": mime_type,
        "previewKind": preview_kind,
        "fileSize": file_size,
        "fileHash": file_hash,
        "fileMissing": file_missing,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def _repo(db):
    return make_workspace_assets_repo(db)


def test_create_and_get(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    created = repo["create"](_asset_input(workspace_id=ws_id))
    assert created["workspaceId"] == ws_id
    assert created["fileName"] == "plot.png"
    assert created["previewKind"] == "image"
    assert created["fileMissing"] == 0
    assert isinstance(created["createdAt"], int)
    assert created["createdAt"] == created["updatedAt"]
    fetched = repo["get"](created["id"])
    assert fetched is not None
    assert fetched == created


def test_list_orders_by_created_at(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    first = repo["create"](
        _asset_input(workspace_id=ws_id, file_path="a/1.png", file_name="1.png", created_at=1_000_000)
    )
    second = repo["create"](
        _asset_input(workspace_id=ws_id, file_path="a/2.png", file_name="2.png", created_at=2_000_000)
    )
    listed = repo["list"](ws_id)
    assert [a["id"] for a in listed] == [first["id"], second["id"]]


def test_list_raises_when_workspace_missing(db):
    repo = _repo(db)
    with pytest.raises(RepoError) as exc:
        repo["list"]("missing-ws")
    assert exc.value.code == "not_found"


def test_create_raises_when_workspace_missing(db):
    repo = _repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](_asset_input(workspace_id="missing-ws"))
    assert exc.value.code == "not_found"


def test_create_rejects_invalid_preview_kind(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    with pytest.raises(RepoError) as exc:
        repo["create"](_asset_input(workspace_id=ws_id, preview_kind="bogus"))
    assert exc.value.code == "invalid_input"


def test_get_returns_none_when_absent(db):
    assert _repo(db)["get"]("missing") is None


def test_update_changes_fields(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    asset = repo["create"](_asset_input(workspace_id=ws_id))
    before = asset["updatedAt"]
    updated = repo["update"](
        asset["id"],
        {"fileName": "renamed.png", "fileMissing": 1},
    )
    assert updated["fileName"] == "renamed.png"
    assert updated["fileMissing"] == 1
    assert updated["updatedAt"] >= before


def test_update_rejects_invalid_preview_kind(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    asset = repo["create"](_asset_input(workspace_id=ws_id))
    with pytest.raises(RepoError) as exc:
        repo["update"](asset["id"], {"previewKind": "bogus"})
    assert exc.value.code == "invalid_input"


def test_update_missing_raises(db):
    with pytest.raises(RepoError) as exc:
        _repo(db)["update"]("missing", {"fileName": "x"})
    assert exc.value.code == "not_found"


def test_update_noop_patch_returns_row(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    asset = repo["create"](_asset_input(workspace_id=ws_id))
    result = repo["update"](asset["id"], {})
    assert result["id"] == asset["id"]


def test_delete_removes_and_bumps_workspace_updated(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    ws_repo = make_workspaces_repo(db)
    ws_before = ws_repo["get"](ws_id)["updatedAt"]
    asset = repo["create"](_asset_input(workspace_id=ws_id))
    repo["delete"](asset["id"])
    assert repo["get"](asset["id"]) is None
    ws_after = ws_repo["get"](ws_id)["updatedAt"]
    assert ws_after >= ws_before


def test_delete_missing_raises(db):
    with pytest.raises(RepoError) as exc:
        _repo(db)["delete"]("missing")
    assert exc.value.code == "not_found"


def test_file_path_unique_constraint(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    repo["create"](
        _asset_input(workspace_id=ws_id, id="a1", file_path="shared/path.png")
    )
    with pytest.raises(RepoError) as exc:
        repo["create"](
            _asset_input(workspace_id=ws_id, id="a2", file_path="shared/path.png")
        )
    assert exc.value.code == "duplicate"


def test_update_file_path_unique_violation(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    repo["create"](
        _asset_input(workspace_id=ws_id, id="a1", file_path="p1.png")
    )
    a2 = repo["create"](
        _asset_input(workspace_id=ws_id, id="a2", file_path="p2.png")
    )
    with pytest.raises(RepoError) as exc:
        repo["update"](a2["id"], {"filePath": "p1.png"})
    assert exc.value.code == "duplicate"


def test_workspace_delete_cascades_to_assets(db):
    ws_id = _make_workspace(db)
    repo = _repo(db)
    asset = repo["create"](_asset_input(workspace_id=ws_id))
    make_workspaces_repo(db)["delete"](ws_id)
    assert repo["get"](asset["id"]) is None


def test_media_type_image():
    assert workspace_asset_media_type("photo.PNG") == {
        "mimeType": "image/png",
        "previewKind": "image",
    }
    assert workspace_asset_media_type("a.jpg")["previewKind"] == "image"


def test_media_type_audio():
    assert workspace_asset_media_type("song.mp3") == {
        "mimeType": "audio/mpeg",
        "previewKind": "audio",
    }


def test_media_type_video():
    assert workspace_asset_media_type("clip.mp4")["previewKind"] == "video"


def test_media_type_text_variants():
    assert workspace_asset_media_type("note.md") == {
        "mimeType": "text/markdown",
        "previewKind": "text",
    }
    assert workspace_asset_media_type("data.json")["mimeType"] == "application/json"
    assert workspace_asset_media_type("data.csv")["mimeType"] == "text/csv"
    assert workspace_asset_media_type("data.tsv")["mimeType"] == "text/tab-separated-values"
    assert workspace_asset_media_type("script.py")["mimeType"] == "text/plain"


def test_media_type_pdf_and_unknown():
    assert workspace_asset_media_type("paper.pdf") == {
        "mimeType": "application/pdf",
        "previewKind": "none",
    }
    assert workspace_asset_media_type("archive.zip") == {
        "mimeType": "application/octet-stream",
        "previewKind": "none",
    }


def test_media_type_constants_match_ts():
    assert IMAGE_TYPES[".webp"] == "image/webp"
    assert AUDIO_TYPES[".flac"] == "audio/flac"
    assert VIDEO_TYPES[".mov"] == "video/quicktime"
    assert ".tsx" in TEXT_EXTENSIONS
    assert ".bib" in TEXT_EXTENSIONS


def test_assets_isolated_per_workspace(db):
    ws1 = _make_workspace(db, "ws-1")
    ws2 = _make_workspace(db, "ws-2")
    repo = _repo(db)
    repo["create"](_asset_input(workspace_id=ws1, file_path="w1/a.png", file_name="a.png"))
    repo["create"](_asset_input(workspace_id=ws2, file_path="w2/b.png", file_name="b.png"))
    assert len(repo["list"](ws1)) == 1
    assert len(repo["list"](ws2)) == 1