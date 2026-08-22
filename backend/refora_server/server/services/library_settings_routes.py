from __future__ import annotations

import asyncio
import inspect
import json
import os
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter

from refora_server.db.settings_seed import SETTING_KEYS
from refora_server.library.paths import resolveFromLibrary
from refora_server.services.proxy import is_valid_proxy_url, normalize_proxy_rules
from refora_server.web.types import WEB_SEARCH_PROVIDERS

from .library_route_support import (
    UnavailableError,
    apply_proxy_rules,
    base64_blob,
    body_dict,
    call,
    connector_call,
    ids,
    json_setting,
    markdown_file_name,
    method,
    provider_input,
    string,
    value,
)


def register_library_settings_routes(
    router: APIRouter,
    context: Mapping[str, Any],
) -> None:
    run = context["run"]
    settings = context["settings"]
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
                if key not in SETTING_KEYS:
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
            test_search = method(web_search, "test")
            return await asyncio.to_thread(test_search, query)
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
            await call(provider_repo, "delete", provider_id)
            return {"ack": True}
        return await run(action)

    @router.post("/ai/providers/{provider_id}/test")
    async def test_provider(provider_id: str):
        async def action():
            return await call(providers, "testProvider", provider_id, await provider_api_key(provider_id))
        return await run(action)

    @router.post("/ai/providers/models")
    async def list_provider_models(body: dict[str, Any]):
        async def action():
            parsed = body_dict(body)
            provider_id = parsed.get("providerId")
            if provider_id is not None:
                if not isinstance(provider_id, str) or not provider_id.strip():
                    raise ValueError("providerId must be a non-empty string")
                return await call(providers, "listModels", provider_id, await provider_api_key(provider_id))
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
            return await call(transient, "listModels", "__transient__", api_key)
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
        return await run(lambda: call(agent_profiles, "test", profile_id))

    @router.post("/ai/agent-profiles/{profile_id}/models")
    async def list_agent_profile_models(profile_id: str):
        return await run(lambda: call(agent_profiles, "listModels", profile_id))

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
