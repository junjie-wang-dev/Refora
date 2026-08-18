from __future__ import annotations

from typing import Any

from refora_server.repositories.errors import RepoError


def createAgentProfilesService(repos: Any, deps: Any | None = None):
    deps = deps or {}
    cli_runtime = deps.get("cliRuntime") if isinstance(deps, dict) else None
    profiles = repos["agentProfiles"]

    def list_() -> list[dict[str, Any]]:
        return profiles["list"]()

    def get(profile_id: str) -> dict[str, Any]:
        profile = profiles["get"](profile_id)
        if profile is None:
            profile = profiles["getByApiProvider"](profile_id)
        if profile is None:
            raise RepoError("not_found", f"agent profile not found: {profile_id}")
        return profile

    def create(input: dict[str, Any]) -> dict[str, Any]:
        if input.get("kind") != "cli":
            raise RepoError("invalid_input", "Only CLI agent profiles can be created directly")
        runtime_id = input.get("cliRuntimeId")
        if cli_runtime is None or not isinstance(runtime_id, str):
            raise RepoError("invalid_input", "CLI runtime is unavailable")
        try:
            cli_runtime.registry.get(runtime_id)
        except ValueError as error:
            raise RepoError("invalid_input", str(error)) from error
        return profiles["create"](input)

    def update(profile_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return profiles["update"](profile_id, patch)

    def remove(profile_id: str) -> None:
        profile = get(profile_id)
        if profile["kind"] != "cli":
            raise RepoError("conflict", "API agent profiles are managed with their API provider")
        profiles["delete"](profile["id"])

    def ensureApiProfile(provider: dict[str, Any]) -> dict[str, Any]:
        existing = profiles["getByApiProvider"](provider["id"])
        if existing is not None:
            return existing
        return profiles["create"](
            {
                "id": f"api-{provider['id']}",
                "name": provider["name"],
                "kind": "api",
                "apiProviderId": provider["id"],
                "model": provider.get("model") or "",
                "reasoningEffort": provider.get("reasoningEffort") or "medium",
                "nativeWebSearch": False,
                "webSearchPolicy": "auto",
            }
        )

    def test(profile_id: str) -> dict[str, Any]:
        profile = get(profile_id)
        if profile["kind"] != "cli":
            return {"ok": True, "runtimeId": None}
        if cli_runtime is None:
            return {"ok": False, "error": "CLI runtime is unavailable"}
        return cli_runtime.inspect(
            profile["cliRuntimeId"], profile.get("executablePath")
        )

    def listModels(profile_id: str) -> dict[str, Any]:
        profile = get(profile_id)
        if profile["kind"] != "cli":
            return {"ok": True, "models": []}
        if cli_runtime is None:
            return {"ok": False, "models": [], "error": "CLI runtime is unavailable"}
        return cli_runtime.list_models(
            profile["cliRuntimeId"], profile.get("executablePath")
        )

    def scanRuntimes() -> list[dict[str, Any]]:
        if cli_runtime is None:
            return []
        return cli_runtime.registry.scan()

    return {
        "list": list_,
        "get": get,
        "create": create,
        "update": update,
        "delete": remove,
        "ensureApiProfile": ensureApiProfile,
        "test": test,
        "listModels": listModels,
        "scanRuntimes": scanRuntimes,
    }
