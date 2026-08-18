from __future__ import annotations

from typing import Any

from refora_server.cli_runtime.definitions import (
    CliRuntimeAdapter,
    CodexCliAdapter,
    GeminiCliAdapter,
)


class CliRuntimeRegistry:
    def __init__(self, adapters: list[CliRuntimeAdapter]) -> None:
        self._adapters = {adapter.id: adapter for adapter in adapters}

    def get(self, runtime_id: str) -> CliRuntimeAdapter:
        adapter = self._adapters.get(runtime_id)
        if adapter is None:
            raise ValueError(f"Unsupported CLI runtime: {runtime_id}")
        return adapter

    def inspect(self, runtime_id: str, executable_path: str | None = None) -> dict[str, Any]:
        return self.get(runtime_id).inspect(executable_path).to_dict()

    def list_models(self, runtime_id: str, executable_path: str | None = None) -> dict[str, Any]:
        try:
            return {
                "ok": True,
                "models": [
                    model.to_dict()
                    for model in self.get(runtime_id).list_models(executable_path)
                ],
            }
        except (OSError, RuntimeError, ValueError) as error:
            return {"ok": False, "models": [], "error": str(error)}

    def scan(self) -> list[dict[str, Any]]:
        runtimes: list[dict[str, Any]] = []
        for adapter in self._adapters.values():
            inspection = adapter.inspect(None)
            model_error: str | None = None
            try:
                models = [model.to_dict() for model in adapter.list_models(None)]
            except (OSError, RuntimeError, ValueError) as error:
                models = []
                model_error = str(error)
            runtimes.append(
                {
                    **inspection.to_dict(),
                    "label": adapter.label,
                    "defaultExecutable": adapter.default_executable,
                    "available": inspection.executable_path is not None,
                    "reasoningMode": adapter.reasoning_mode,
                    "capabilities": adapter.capabilities.to_dict(),
                    "models": models,
                    "error": inspection.error or model_error,
                }
            )
        return runtimes


def create_cli_runtime_registry() -> CliRuntimeRegistry:
    return CliRuntimeRegistry([CodexCliAdapter(), GeminiCliAdapter()])
