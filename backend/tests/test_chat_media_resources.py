from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import httpx
import pytest

from refora_server.repositories.errors import RepoError
from refora_server.services import chat_media
from refora_server.services.chat_media import create_chat_media_service
from refora_server.services.workspaces import createWorkspacesService


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=")
PNG_URL = f"data:image/png;base64,{base64.b64encode(PNG).decode()}"


def service_for(tmp_path: Path, **kwargs: Any) -> dict[str, Any]:
    return create_chat_media_service(str(tmp_path), kwargs.pop("repos", {}), kwargs.pop("services", {}), **kwargs)


async def resolve_source(service: dict[str, Any], source: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return await service["resolve"]({"source": source, **kwargs})


def public_resolver(_hostname: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


def sandbox_repos(workspace_id: str | None = "workspace-a") -> dict[str, Any]:
    return {
        "agentRuns": {"get": lambda run_id: {"threadId": "thread-a"} if run_id == "run-a" else None},
        "chat": {"getThread": lambda thread_id: {"workspaceId": workspace_id} if thread_id == "thread-a" else None},
    }


def workspace_media_service(tmp_path: Path, asset: dict[str, Any]) -> dict[str, Any]:
    repos = {
        "settings": {"libraryFolderPath": str(tmp_path)},
        "workspaceAssets": {
            "get": lambda asset_id: asset if asset_id == asset["id"] else None,
            "update": lambda _asset_id, patch: asset.update(patch),
        },
    }
    return service_for(tmp_path, repos=repos, services={"workspaces": createWorkspacesService(repos)})


async def test_inline_png_roundtrip_survives_service_reopen_without_exposing_local_path(tmp_path: Path) -> None:
    service = service_for(tmp_path)
    resource = await resolve_source(service, {"type": "inline", "dataUrl": PNG_URL}, fileName="../paper figure.html")

    assert resource["kind"] == "image"
    assert resource["mimeType"] == "image/png"
    assert resource["byteLength"] == len(PNG)
    assert resource["fileName"] == "paper figure.png"
    assert resource["url"] == f"refora-asset://media/{resource['id']}"
    assert "path" not in resource
    file = service["getFile"](resource["id"])
    assert Path(file["path"]).read_bytes() == PNG
    assert Path(file["path"]).is_relative_to(tmp_path)

    reopened = service_for(tmp_path)
    assert await resolve_source(reopened, {"type": "cached", "mediaId": resource["id"]}) == resource
    assert Path(reopened["getFile"](resource["id"])["path"]).read_bytes() == PNG


@pytest.mark.parametrize("data_url", [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PGh0bWw+",
    "data:application/javascript;base64,YWxlcnQoMSk=",
    "data:image/png,not-base64",
    "data:image/png;base64,%%%%",
    "data:image/png;base64,A",
    "data:image/png;base64,====",
    "data:image/png;base64,",
])
async def test_inline_rejects_unsupported_and_malformed_data(tmp_path: Path, data_url: str) -> None:
    with pytest.raises(RepoError) as error:
        await resolve_source(service_for(tmp_path), {"type": "inline", "dataUrl": data_url})
    assert error.value.code == "invalid_media"


async def test_inline_rejects_mime_mismatch(tmp_path: Path) -> None:
    value = f"data:image/png;base64,{base64.b64encode(b'<script>not an image</script>').decode()}"
    with pytest.raises(RepoError) as error:
        await resolve_source(service_for(tmp_path), {"type": "inline", "dataUrl": value})
    assert error.value.code == "invalid_media"


async def test_inline_enforces_decoded_limit_and_removes_partial_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat_media, "MAX_INLINE_BYTES", 32)
    with pytest.raises(RepoError) as error:
        await resolve_source(service_for(tmp_path), {"type": "inline", "dataUrl": PNG_URL})
    assert error.value.code == "media_too_large"
    assert not list(tmp_path.rglob("resource.json"))


async def test_persist_replaces_inline_payloads_with_reopenable_resources_and_preserves_failures(tmp_path: Path) -> None:
    service = service_for(tmp_path)
    items = [
        {"id": "image", "kind": "image", "title": "Figure", "source": {"type": "inline", "dataUrl": PNG_URL}},
        {"id": "broken", "kind": "image", "source": {"type": "inline", "dataUrl": "invalid"}},
        {"id": "remote", "kind": "image", "source": {"type": "remote", "url": "https://example.test/figure.png"}},
    ]
    result = await service["persistMedia"](items, {})
    assert result[0]["source"]["type"] == "cached"
    assert Path(service["getFile"](result[0]["source"]["mediaId"])["path"]).read_bytes() == PNG
    assert result[1]["source"]["type"] == "unavailable"
    assert result[1]["source"]["reason"]
    assert result[2] == items[2]
    assert items[0]["source"]["type"] == "inline"


@pytest.mark.parametrize("media_id", ["../resource", "z" * 64, "", None])
def test_cached_reference_rejects_invalid_identifiers(tmp_path: Path, media_id: Any) -> None:
    with pytest.raises(RepoError) as error:
        service_for(tmp_path)["getFile"](media_id)
    assert error.value.code == "invalid_input"


async def test_cached_file_symlink_and_truncated_content_are_rejected(tmp_path: Path) -> None:
    service = service_for(tmp_path)
    resource = await resolve_source(service, {"type": "inline", "dataUrl": PNG_URL})
    cached_path = Path(service["getFile"](resource["id"])["path"])
    cached_path.write_bytes(PNG[:8])
    with pytest.raises(RepoError) as error:
        service["getFile"](resource["id"])
    assert error.value.code == "file_missing"
    cached_path.unlink()
    original = tmp_path / "original.png"
    original.write_bytes(PNG)
    cached_path.symlink_to(original)
    with pytest.raises(RepoError):
        await resolve_source(service_for(tmp_path), {"type": "cached", "mediaId": resource["id"]})


async def test_asset_source_reads_only_the_file_resolved_by_workspace_service(tmp_path: Path) -> None:
    original = tmp_path / "refora-assets" / "asset-a" / "figure.png"
    original.parent.mkdir(parents=True)
    original.write_bytes(PNG)
    service = workspace_media_service(tmp_path, {
        "id": "asset-a", "mimeType": "image/png", "fileName": "figure.png",
        "filePath": str(original.relative_to(tmp_path)), "fileMissing": 0,
    })
    resource = await resolve_source(service, {"type": "asset", "assetId": "asset-a"})
    assert resource["fileName"] == "figure.png"
    assert Path(service["getFile"](resource["id"])["path"]).read_bytes() == PNG
    assert original.read_bytes() == PNG
    with pytest.raises(RepoError) as error:
        await resolve_source(service, {"type": "asset", "assetId": "../outside.png"})
    assert error.value.code == "not_found"


@pytest.mark.parametrize("file_path", ["outside.png", "refora-assets/asset-b/figure.png", "refora-assets/asset-a/../../../outside.png"])
async def test_asset_source_rejects_repository_paths_outside_its_managed_directory(tmp_path: Path, file_path: str) -> None:
    service = workspace_media_service(tmp_path, {
        "id": "asset-a", "mimeType": "image/png", "fileName": "figure.png",
        "filePath": file_path, "fileMissing": 0,
    })
    with pytest.raises(RepoError) as error:
        await resolve_source(service, {"type": "asset", "assetId": "asset-a"})
    assert error.value.code == "invalid_path"


@pytest.mark.parametrize("link_directory", [False, True])
async def test_asset_source_rejects_symlink_files_and_parent_directories(tmp_path: Path, link_directory: bool) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    original = outside / "figure.png"
    original.write_bytes(PNG)
    directory = tmp_path / "refora-assets" / "asset-a"
    directory.parent.mkdir()
    if link_directory:
        directory.symlink_to(outside, target_is_directory=True)
    else:
        directory.mkdir()
        (directory / "figure.png").symlink_to(original)
    service = workspace_media_service(tmp_path, {
        "id": "asset-a", "mimeType": "image/png", "fileName": "figure.png",
        "filePath": "refora-assets/asset-a/figure.png", "fileMissing": 0,
    })
    with pytest.raises(RepoError) as error:
        await resolve_source(service, {"type": "asset", "assetId": "asset-a"})
    assert error.value.code in {"invalid_path", "file_missing"}


@pytest.mark.parametrize("workspace_id", ["workspace-a", None])
async def test_sandbox_outputs_are_scoped_to_the_runs_workspace(tmp_path: Path, workspace_id: str | None) -> None:
    output = tmp_path / ".refora" / "sandboxes" / (workspace_id or "global") / "outputs" / "chart.png"
    output.parent.mkdir(parents=True)
    output.write_bytes(PNG)
    service = service_for(tmp_path, repos=sandbox_repos(workspace_id))
    resource = await resolve_source(service, {"type": "sandbox", "runId": "run-a", "path": "outputs/chart.png"})
    assert Path(service["getFile"](resource["id"])["path"]).read_bytes() == PNG
    with pytest.raises(RepoError) as error:
        await resolve_source(service, {"type": "sandbox", "runId": "unknown", "path": "outputs/chart.png"})
    assert error.value.code == "not_found"


@pytest.mark.parametrize("path", ["../outside.png", "/outputs/chart.png", "outputs/../secret.png", "outputs/./chart.png", "outputs/a/../../secret.png", "outputs/../../workspace-b/outputs/chart.png", "outputs/dir\\secret.png", "inputs/secret.png"])
async def test_sandbox_rejects_paths_outside_its_outputs(tmp_path: Path, path: str) -> None:
    with pytest.raises(RepoError) as error:
        await resolve_source(service_for(tmp_path, repos=sandbox_repos()), {"type": "sandbox", "runId": "run-a", "path": path})
    assert error.value.code == "invalid_path"


@pytest.mark.parametrize("link_directory", [False, True])
async def test_sandbox_rejects_symlinks_in_files_and_parent_directories(tmp_path: Path, link_directory: bool) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "chart.png").write_bytes(PNG)
    outputs = tmp_path / ".refora" / "sandboxes" / "workspace-a" / "outputs"
    outputs.parent.mkdir(parents=True)
    if link_directory:
        outputs.symlink_to(outside, target_is_directory=True)
    else:
        outputs.mkdir()
        (outputs / "chart.png").symlink_to(outside / "chart.png")
    with pytest.raises(RepoError) as error:
        await resolve_source(service_for(tmp_path, repos=sandbox_repos()), {"type": "sandbox", "runId": "run-a", "path": "outputs/chart.png"})
    assert error.value.code == "invalid_path"


async def test_ocr_source_passes_document_result_and_asset_relative_path_to_resolver(tmp_path: Path) -> None:
    figure = tmp_path / "ocr-figure.png"
    figure.write_bytes(PNG)
    calls = []

    def resolve_asset(document_id: str, result_key: str, path: str) -> str:
        calls.append((document_id, result_key, path))
        return str(figure)

    service = service_for(tmp_path, services={"ocr": {"resolveAsset": resolve_asset}})
    resource = await resolve_source(service, {"type": "ocr", "documentId": "paper-a", "resultKey": "result-a", "path": "assets/figures/figure.png"})
    assert calls == [("paper-a", "result-a", "figures/figure.png")]
    assert Path(service["getFile"](resource["id"])["path"]).read_bytes() == PNG
    await resolve_source(service, {"type": "ocr", "documentId": "paper-a", "resultKey": "result-a", "path": "images/figure.png"})
    assert calls[-1] == ("paper-a", "result-a", "figure.png")
    assert len(calls) == 2


async def test_remote_public_image_follows_public_redirect_and_reuses_persistent_cache(tmp_path: Path) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/figure.png"})
        return httpx.Response(200, headers={"content-type": "image/png; charset=binary"}, content=PNG)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = service_for(tmp_path, http_client=client, resolver=public_resolver)
        source = {"type": "remote", "url": "https://example.test/start#figure"}
        resource = await resolve_source(service, source)
        assert resource["sourceUrl"] == "https://example.test/start"
        assert resource["mimeType"] == "image/png"
        assert Path(service["getFile"](resource["id"])["path"]).read_bytes() == PNG
        assert await resolve_source(service, source) == resource
        reopened = service_for(tmp_path, http_client=client, resolver=public_resolver)
        assert await resolve_source(reopened, source) == resource
    assert calls == ["https://example.test/start", "https://example.test/figure.png"]


@pytest.mark.parametrize("url", ["http://127.0.0.1/image.png", "http://[::1]/image.png", "http://169.254.169.254/image.png", "https://localhost/image.png", "https://printer.local/image.png", "https://example.test:8443/image.png"])
async def test_remote_rejects_private_and_nonstandard_destinations_without_connecting(tmp_path: Path, url: str) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(RepoError) as error:
            await resolve_source(service_for(tmp_path, http_client=client, resolver=public_resolver), {"type": "remote", "url": url})
    assert error.value.code == "unsafe_url"
    assert calls == []


async def test_remote_rejects_private_dns_and_redirect_targets(tmp_path: Path) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private.png"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(RepoError) as dns_error:
            await resolve_source(service_for(tmp_path, http_client=client, resolver=lambda _host, _port: ["10.0.0.1"]), {"type": "remote", "url": "https://public-looking.test/image.png"})
        assert dns_error.value.code == "unsafe_url"
        assert calls == []
        with pytest.raises(RepoError) as redirect_error:
            await resolve_source(service_for(tmp_path, http_client=client, resolver=public_resolver), {"type": "remote", "url": "https://example.test/start"})
        assert redirect_error.value.code == "unsafe_url"
    assert calls == ["https://example.test/start"]


@pytest.mark.parametrize(("mime", "content", "code"), [("image/png", b"<html>not an image</html>", "invalid_media"), ("text/html", b"<html>not an image</html>", "unsupported_media"), ("image/svg+xml", b"<svg></svg>", "unsupported_media")])
async def test_remote_rejects_unsupported_and_mismatched_content(tmp_path: Path, mime: str, content: bytes, code: str) -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, headers={"content-type": mime}, content=content))) as client:
        with pytest.raises(RepoError) as error:
            await resolve_source(service_for(tmp_path, http_client=client, resolver=public_resolver), {"type": "remote", "url": "https://example.test/image"})
    assert error.value.code == code
    assert not list(tmp_path.rglob("resource.json"))
    assert not list(tmp_path.rglob(".download-*"))


class MediaChunks(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield PNG[:32]
        yield PNG[32:]


@pytest.mark.parametrize("declared_length", [None, "9999", "not-a-number"])
async def test_remote_limits_declared_and_streamed_content_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, declared_length: str | None) -> None:
    monkeypatch.setattr(chat_media, "MAX_MEDIA_BYTES", 32)
    headers = {"content-type": "image/png"}
    if declared_length:
        headers["content-length"] = declared_length
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, headers=headers, stream=MediaChunks()))) as client:
        with pytest.raises(RepoError) as error:
            await resolve_source(service_for(tmp_path, http_client=client, resolver=public_resolver), {"type": "remote", "url": "https://example.test/image.png"})
    assert error.value.code == "media_too_large"
    assert not list(tmp_path.rglob("resource.json"))
    assert not list(tmp_path.rglob(".download-*"))


async def test_cache_limit_reports_actionable_error_without_destroying_existing_media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service = service_for(tmp_path)
    first = await resolve_source(service, {"type": "inline", "dataUrl": PNG_URL})
    monkeypatch.setattr(chat_media, "MAX_CACHE_BYTES", len(PNG))
    another = f"data:image/png;base64,{base64.b64encode(PNG + b'other').decode()}"
    with pytest.raises(RepoError) as error:
        await resolve_source(service, {"type": "inline", "dataUrl": another})
    assert error.value.code == "media_cache_full"
    assert Path(service["getFile"](first["id"])["path"]).read_bytes() == PNG


@pytest.mark.parametrize('mime,filename,payload,expected', [
    ('audio/x-wav', 'recording.wav', b'RIFF1234WAVEdata', 'audio/wav'),
    ('audio/mp4a-latm', 'recording.m4a', b'1234ftypM4A payload', 'audio/mp4'),
])
async def test_audio_aliases_resolve_as_playable_audio(tmp_path, mime, filename, payload, expected):
    source_file = tmp_path / filename
    source_file.write_bytes(payload)
    service = service_for(tmp_path, services={'workspaces': {'resolveAssetFile': lambda asset_id: ({'mimeType': mime, 'fileName': filename}, str(source_file))}})
    resource = await resolve_source(service, {'type': 'asset', 'assetId': 'audio'})
    assert resource['kind'] == 'audio'
    assert resource['mimeType'] == expected
    inline = await resolve_source(service, {'type': 'inline', 'dataUrl': f'data:{mime};base64,' + base64.b64encode(payload).decode()})
    assert inline['id'] == resource['id']


async def test_retry_rebuilds_a_corrupted_cached_copy_from_original_content(tmp_path):
    service = service_for(tmp_path)
    source = {'type': 'inline', 'dataUrl': PNG_URL}
    original = await resolve_source(service, source)
    path = Path(service['getFile'](original['id'])['path'])
    path.write_bytes(PNG[:-1] + b'!')
    with pytest.raises(RepoError):
        service['getFile'](original['id'])
    restored = await resolve_source(service, source)
    assert restored['id'] == original['id']
    assert Path(service['getFile'](restored['id'])['path']).read_bytes() == PNG
