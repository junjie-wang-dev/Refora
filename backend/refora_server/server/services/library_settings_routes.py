from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter

from refora_server.db.settings_seed import SETTING_KEYS
from refora_server.library.document_ids import is_safe_document_id
from refora_server.library.paths import resolveFromLibrary
from refora_server.services.proxy import is_valid_proxy_url, normalize_proxy_rules
from refora_server.web.types import WEB_SEARCH_PROVIDERS

from .library_route_support import (
    UnavailableError,
    apply_proxy_rules,
    base64_blob,
    body_dict,
    call,
    call_in_thread,
    connector_call,
    ids,
    json_setting,
    markdown_file_name,
    method,
    provider_input,
    string,
    value,
)


PDF_READING_STATE_PREFIX = "pdfReader.document."
PDF_READING_STATE_MAX_BYTES = 2 * 1024 * 1024
PDF_READING_STATE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")


def _pdf_reading_state(candidate: Any) -> dict[str, Any]:
    if not isinstance(candidate, dict) or set(candidate) != {"view", "bookmarks"}:
        raise ValueError("PDF reading state must contain view and bookmarks")

    def position(payload: Any, fields: set[str]) -> None:
        if not isinstance(payload, dict) or set(payload) != fields:
            raise ValueError("PDF reading position has invalid fields")
        page = payload["page"]
        if type(page) is not int or not 1 <= page <= 1_000_000:
            raise ValueError("PDF reading page must be an integer between 1 and 1000000")
        for axis in ("x", "y"):
            coordinate = payload[axis]
            if type(coordinate) not in (int, float) or not -2 <= coordinate <= 2:
                raise ValueError("PDF reading coordinates must be finite and between -2 and 2")

    view = candidate["view"]
    position(view, {"page", "x", "y", "scale", "rotation", "zoomMode"})
    zoom_mode = view["zoomMode"]
    if zoom_mode not in ("custom", "width"):
        raise ValueError("PDF reading zoomMode must be custom or width")
    scale = view["scale"]
    minimum_scale = 0.01 if zoom_mode == "width" else 0.25
    if type(scale) not in (int, float) or not minimum_scale <= scale <= 5:
        raise ValueError("PDF reading scale is outside the supported range")
    if type(view["rotation"]) is not int or view["rotation"] not in (0, 90, 180, 270):
        raise ValueError("PDF reading rotation must be 0, 90, 180, or 270")

    bookmarks = candidate["bookmarks"]
    if not isinstance(bookmarks, list) or len(bookmarks) > 10_000:
        raise ValueError("PDF reading state supports at most 10000 bookmarks")
    bookmark_ids: set[str] = set()
    for bookmark in bookmarks:
        position(bookmark, {"id", "title", "page", "x", "y"})
        bookmark_id = bookmark["id"]
        if not isinstance(bookmark_id, str) or not PDF_READING_STATE_ID.fullmatch(bookmark_id):
            raise ValueError("PDF bookmark id is invalid")
        if bookmark_id in bookmark_ids:
            raise ValueError("PDF bookmark ids must be unique")
        bookmark_ids.add(bookmark_id)
        title = bookmark["title"]
        if not isinstance(title, str) or not title.strip() or len(title) > 500:
            raise ValueError("PDF bookmark title must contain between 1 and 500 characters")
    encoded = json.dumps(candidate, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > PDF_READING_STATE_MAX_BYTES:
        raise ValueError("PDF reading state must not exceed 2 MiB")
    return candidate


def register_library_settings_routes(
    router: APIRouter,
    context: Mapping[str, Any],
) -> None:
    run = context["run"]
    settings = context["settings"]
    documents = context["documents"]
    connector = context["connector"]
    transaction = context["transaction"]
    web_search = context["web_search"]
    web_search_config = context["web_search_config"]
    providers = context["providers"]
    provider_repo = context["provider_repo"]
    agent_profiles = context["agent_profiles"]
    get_proxy = context["get_proxy"]
    exporter = context["exporter"]
    clipboard_temp = context["clipboard_temp"]
    workspace_assets = context["workspace_assets"]
    create_ai_providers = context["create_ai_providers"]

    async def provider_api_key(provider_id: str) -> str:
        encrypted_getter = value(providers, "getEncryptedApiKey")
        raw_getter = value(provider_repo, "getRaw")
        if callable(encrypted_getter):
            encrypted = await call(providers, "getEncryptedApiKey", provider_id)
        elif callable(raw_getter):
            raw = await call(provider_repo, "getRaw", provider_id)
            if not isinstance(raw, Mapping):
                raise ValueError(f"Provider not found: {provider_id}")
            encrypted = raw.get("apiKeyEnc")
        else:
            raise UnavailableError("Provider key repository is unavailable")
        if encrypted is None:
            return ""
        data = await connector_call(connector, "decrypt_api_key", encrypted)
        if not isinstance(data, Mapping) or not isinstance(data.get("apiKey"), str):
            raise UnavailableError("Native key storage returned an invalid payload")
        return data["apiKey"]

    async def encrypted_provider_input(body: dict[str, Any]) -> dict[str, Any]:
        parsed = body_dict(body)
        output = provider_input(parsed)
        if "apiKey" not in parsed:
            return output
        api_key = parsed.get("apiKey")
        if not isinstance(api_key, str):
            raise ValueError("apiKey must be a string")
        data = await connector_call(connector, "encrypt_api_key", api_key)
        if not isinstance(data, Mapping) or "apiKeyEnc" not in data:
            raise UnavailableError("Native key storage returned an invalid payload")
        output["apiKeyEnc"] = base64_blob(data.get("apiKeyEnc"))
        return output

    async def encrypted_search_key(api_key: str) -> bytes | None:
        data = await connector_call(connector, "encrypt_api_key", api_key)
        if not isinstance(data, Mapping):
            raise UnavailableError("Native key storage returned an invalid payload")
        return base64_blob(data.get("apiKeyEnc"))

    def workspace_asset_file(asset_id: str) -> str:
        asset = method(workspace_assets, "get")(asset_id)
        if asset is None:
            error = RuntimeError(f"workspace asset not found: {asset_id}")
            error.code = "not_found"
            raise error
        library_folder = json_setting(settings, "libraryFolderPath", "")
        if not isinstance(library_folder, str) or not os.path.isabs(library_folder):
            raise ValueError("Library folder is not configured")
        file_path = asset.get("filePath")
        file_name = asset.get("fileName")
        if not isinstance(file_path, str) or not isinstance(file_name, str):
            raise ValueError("Workspace asset has an invalid path")
        resolved = os.path.abspath(resolveFromLibrary(file_path, library_folder))
        asset_directory = os.path.abspath(
            os.path.join(library_folder, "refora-assets", asset_id)
        )
        try:
            inside = os.path.commonpath([asset_directory, resolved]) == asset_directory
        except ValueError:
            inside = False
        if (
            not inside
            or os.path.dirname(resolved) != asset_directory
            or os.path.basename(resolved) != file_name
            or os.path.islink(resolved)
            or not os.path.isfile(resolved)
        ):
            raise ValueError("Workspace asset path is invalid or missing")
        return resolved

    @router.get("/settings")
    async def get_settings():
        async def action():
            values = await call(settings, "list")
            return dict(values)
        return await run(action)

    @router.patch("/settings")
    async def patch_settings(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            changes: dict[str, Any] = {}
            for key, candidate in parsed.items():
                if not isinstance(key, str) or not key:
                    raise ValueError("Settings keys must be non-empty strings")
                if key.startswith(PDF_READING_STATE_PREFIX):
                    document_id = key[len(PDF_READING_STATE_PREFIX):]
                    if not is_safe_document_id(document_id):
                        raise ValueError("PDF reading state document id is invalid")
                    candidate = _pdf_reading_state(candidate)
                    if await call(documents, "get", document_id) is None:
                        error = RuntimeError(f"document not found: {document_id}")
                        error.code = "not_found"
                        raise error
                elif key not in SETTING_KEYS:
                    error = RuntimeError(f"Unknown setting key: {key}")
                    error.code = "forbidden_field"
                    raise error
                if key == "libraryFolderPath" and isinstance(candidate, str) and candidate:
                    error = RuntimeError("Use library.switch to change the library folder")
                    error.code = "use_library_switch"
                    raise error
                try:
                    json.dumps(candidate, allow_nan=False)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"Setting {key} is not JSON serializable") from exc
                if key == "proxyUrl":
                    candidate = normalize_proxy_rules(candidate)
                changes[key] = candidate

            proxy_changed = "proxyUrl" in changes
            previous_proxy = ""
            if proxy_changed:
                stored_proxy = json_setting(settings, "proxyUrl", "")
                if isinstance(stored_proxy, str) and is_valid_proxy_url(stored_proxy.strip()):
                    previous_proxy = stored_proxy.strip()
                await apply_proxy_rules(connector, changes["proxyUrl"])

            def persist() -> None:
                for key, candidate in changes.items():
                    if key == "proxyUrl":
                        continue
                    method(settings, "set")(key, candidate)
                if proxy_changed:
                    method(settings, "set")("proxyUrl", changes["proxyUrl"])

            try:
                if callable(transaction):
                    result = transaction(persist)
                    if inspect.isawaitable(result):
                        await result
                else:
                    persist()
            except Exception:
                if proxy_changed:
                    await apply_proxy_rules(connector, previous_proxy)
                raise
            values = await call(settings, "list")
            return dict(values)
        return await run(action)

    @router.get("/settings/web-search")
    async def get_web_search_settings():
        return await run(lambda: call(web_search, "getConfig"))

    @router.patch("/settings/web-search")
    async def patch_web_search_settings(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            allowed = {
                "provider",
                "tavilyApiKey",
                "braveApiKey",
                "clearTavilyApiKey",
                "clearBraveApiKey",
            }
            unknown = set(parsed) - allowed
            if unknown:
                raise ValueError(f"Unknown web search setting: {sorted(unknown)[0]}")
            current = await call(web_search_config, "get")
            provider = parsed.get("provider", current.get("provider"))
            if provider not in WEB_SEARCH_PROVIDERS:
                raise ValueError("Unknown web search provider")
            tavily_key = parsed.get("tavilyApiKey")
            brave_key = parsed.get("braveApiKey")
            clear_tavily = parsed.get("clearTavilyApiKey", False)
            clear_brave = parsed.get("clearBraveApiKey", False)
            if not isinstance(clear_tavily, bool) or not isinstance(clear_brave, bool):
                raise ValueError("Web search clear flags must be booleans")
            if tavily_key is not None and not isinstance(tavily_key, str):
                raise ValueError("tavilyApiKey must be a string")
            if brave_key is not None and not isinstance(brave_key, str):
                raise ValueError("braveApiKey must be a string")
            tavily_key = tavily_key.strip() if isinstance(tavily_key, str) else ""
            brave_key = brave_key.strip() if isinstance(brave_key, str) else ""
            if clear_tavily and tavily_key:
                raise ValueError("Tavily API key cannot be set and cleared together")
            if clear_brave and brave_key:
                raise ValueError("Brave API key cannot be set and cleared together")
            patch: dict[str, Any] = {"provider": provider}
            if clear_tavily:
                patch["tavilyApiKeyEnc"] = None
            elif tavily_key:
                patch["tavilyApiKeyEnc"] = await encrypted_search_key(tavily_key)
            if clear_brave:
                patch["braveApiKeyEnc"] = None
            elif brave_key:
                patch["braveApiKeyEnc"] = await encrypted_search_key(brave_key)
            has_tavily = patch.get("tavilyApiKeyEnc", current.get("tavilyApiKeyEnc")) is not None
            has_brave = patch.get("braveApiKeyEnc", current.get("braveApiKeyEnc")) is not None
            if provider == "tavily" and not has_tavily:
                raise ValueError("Configure a Tavily API key before selecting Tavily")
            if provider == "brave" and not has_brave:
                raise ValueError("Configure a Brave API key before selecting Brave")
            await call(web_search_config, "update", patch)
            return await call(web_search, "getConfig")
        return await run(action)

    @router.post("/settings/web-search/test")
    async def test_web_search_settings(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            query = parsed.get("query", "")
            if not isinstance(query, str):
                raise ValueError("query must be a string")
            return await call(web_search, "test", query)
        return await run(action)

    @router.get("/ai/providers")
    async def list_providers():
        return await run(lambda: call(providers, "list"))

    @router.post("/ai/providers")
    async def create_provider(body: dict[str, Any]):
        async def action():
            provider = await call(provider_repo, "create", await encrypted_provider_input(body))
            if agent_profiles is not None:
                await call(agent_profiles, "ensureApiProfile", provider)
            return provider
        return await run(action)

    @router.patch("/ai/providers/{provider_id}")
    async def patch_provider(provider_id: str, body: dict[str, Any]):
        async def action():
            provider = await call(provider_repo, "update", provider_id, await encrypted_provider_input(body))
            if agent_profiles is not None:
                profile = await call(agent_profiles, "ensureApiProfile", provider)
                await call(
                    agent_profiles,
                    "update",
                    profile["id"],
                    {
                        "name": provider["name"],
                        "model": provider.get("model") or "",
                        "reasoningEffort": provider.get("reasoningEffort") or "medium",
                    },
                )
            return provider
        return await run(action)

    @router.delete("/ai/providers/{provider_id}")
    async def delete_provider(provider_id: str):
        async def action():
            def persist() -> None:
                profile = next(
                    (
                        candidate
                        for candidate in method(agent_profiles, "list")()
                        if isinstance(candidate, Mapping)
                        and candidate.get("kind") == "api"
                        and candidate.get("apiProviderId") == provider_id
                    ),
                    None,
                )
                profile_id = profile.get("id") if isinstance(profile, Mapping) else None
                provider_selected = method(settings, "get")(
                    "activeProviderId", ""
                ) == provider_id
                chat_provider_selected = method(settings, "get")(
                    "chatSelectedProviderId", ""
                ) == provider_id
                profile_selected = isinstance(profile_id, str) and method(
                    settings, "get"
                )("activeAgentProfileId", "") == profile_id
                chat_profile_selected = isinstance(profile_id, str) and method(
                    settings, "get"
                )("chatSelectedAgentProfileId", "") == profile_id
                if provider_selected:
                    method(settings, "set")("activeProviderId", "")
                if chat_provider_selected:
                    method(settings, "set")("chatSelectedProviderId", "")
                if profile_selected:
                    method(settings, "set")("activeAgentProfileId", "")
                if chat_profile_selected:
                    method(settings, "set")("chatSelectedAgentProfileId", "")
                if chat_provider_selected or chat_profile_selected:
                    method(settings, "set")("chatSelectedModel", "")
                    method(settings, "set")("chatSelectedVariant", "")
                method(provider_repo, "delete")(provider_id)

            if callable(transaction):
                result = transaction(persist)
                if inspect.isawaitable(result):
                    await result
            else:
                persist()
            return {"ack": True}
        return await run(action)

    @router.post("/ai/providers/{provider_id}/test")
    async def test_provider(provider_id: str):
        async def action():
            api_key = await provider_api_key(provider_id)
            return await call_in_thread(providers, "testProvider", provider_id, api_key)
        return await run(action)

    @router.post("/ai/providers/models")
    async def list_provider_models(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            provider_id = parsed.get("providerId")
            if provider_id is not None:
                if not isinstance(provider_id, str) or not provider_id.strip():
                    raise ValueError("providerId must be a non-empty string")
                api_key = await provider_api_key(provider_id)
                return await call_in_thread(providers, "listModels", provider_id, api_key)
            base_url = parsed.get("baseUrl")
            api_key = parsed.get("apiKey", "")
            if not isinstance(base_url, str) or not base_url.strip():
                return {"ok": False, "models": [], "error": "Base URL is required"}
            if not isinstance(api_key, str):
                raise ValueError("apiKey must be a string")
            transient_raw = {
                "id": "__transient__",
                "presetId": parsed.get("presetId") or "custom",
                "name": "Unsaved provider",
                "baseUrl": base_url,
                "model": "",
            }
            transient = create_ai_providers(
                {"aiProviders": {"getRaw": lambda provider: transient_raw if provider == "__transient__" else None}},
                {"get_proxy": get_proxy},
            )
            return await call_in_thread(transient, "listModels", "__transient__", api_key)
        return await run(action)

    @router.get("/ai/agent-profiles")
    async def list_agent_profiles():
        return await run(lambda: call(agent_profiles, "list"))

    @router.get("/ai/cli-runtimes")
    async def scan_cli_runtimes():
        async def action():
            scan = method(agent_profiles, "scanRuntimes")
            return await asyncio.to_thread(scan)
        return await run(action)

    @router.post("/ai/agent-profiles")
    async def create_agent_profile(body: dict[str, Any]):
        return await run(lambda: call(agent_profiles, "create", body_dict(body)))

    @router.patch("/ai/agent-profiles/{profile_id}")
    async def patch_agent_profile(profile_id: str, body: dict[str, Any]):
        return await run(lambda: call(agent_profiles, "update", profile_id, body_dict(body)))

    @router.delete("/ai/agent-profiles/{profile_id}")
    async def delete_agent_profile(profile_id: str):
        async def action():
            await call(agent_profiles, "delete", profile_id)
            return {"ack": True}
        return await run(action)

    @router.post("/ai/agent-profiles/{profile_id}/test")
    async def test_agent_profile(profile_id: str):
        return await run(lambda: call_in_thread(agent_profiles, "test", profile_id))

    @router.post("/ai/agent-profiles/{profile_id}/models")
    async def list_agent_profile_models(profile_id: str):
        return await run(lambda: call_in_thread(agent_profiles, "listModels", profile_id))

    @router.post("/export/json")
    async def export_json(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            return await call(exporter, "exportJson", parsed.get("documentIds"), parsed.get("workspaceId"))
        return await run(action)

    @router.post("/export/bibtex")
    async def export_bibtex(body: dict[str, Any]):
        return await run(lambda: call(exporter, "exportBibtex", ids(body_dict(body), "documentIds")))

    @router.get("/export/bibtex-string")
    async def export_bibtex_string(documentIds: str = ""):
        async def action():
            values = [candidate for candidate in documentIds.split(",") if candidate]
            if not values:
                raise ValueError("documentIds is required")
            return await call(exporter, "getBibtexString", values)
        return await run(action)

    async def copy_text(body: dict[str, Any], field: str):
        await connector_call(connector, "clipboard", string(body_dict(body), field))
        return {"ack": True}

    @router.post("/clipboard/write-text")
    async def write_clipboard_text(body: dict[str, Any]):
        return await run(lambda: copy_text(body, "text"))

    @router.post("/clipboard/copy-markdown")
    async def copy_clipboard_markdown(body: dict[str, Any]):
        async def action():
            payload = body_dict(body)
            title = string(payload, "title")
            markdown = string(payload, "markdown")
            path = await call(clipboard_temp, "createMarkdown", markdown_file_name(title), markdown)
            try:
                await connector_call(connector, "clipboard_file", path)
            except Exception:
                await call(clipboard_temp, "discard", path)
                raise
            return {"ack": True}
        return await run(action)

    @router.post("/clipboard/copy-workspace-asset")
    async def copy_workspace_asset(body: dict[str, Any]):
        async def action():
            asset_id = string(body_dict(body), "assetId")
            await connector_call(connector, "clipboard_file", workspace_asset_file(asset_id))
            return {"ack": True}
        return await run(action)
