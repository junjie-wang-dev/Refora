from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _load_config(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("Invalid Refora MCP configuration")
    return value


def _request(config: dict[str, Any], path: str, payload: dict[str, Any] | None = None) -> Any:
    body = json.dumps(payload or {}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"{config['baseUrl']}{path}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Refora-Token": config["serverToken"],
            "X-Refora-Run-Token": config["runToken"],
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=125) as response:
            envelope = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(detail or f"Refora MCP request failed: HTTP {error.code}") from error
    if not isinstance(envelope, dict) or envelope.get("ok") is not True:
        error = envelope.get("error") if isinstance(envelope, dict) else None
        message = error.get("message") if isinstance(error, dict) else "Refora MCP request failed"
        raise RuntimeError(message)
    return envelope.get("data")


def _result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, error: Exception) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": str(error)},
    }


def _handle(config: dict[str, Any], message: dict[str, Any]) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return _result(
            request_id,
            {
                "protocolVersion": params.get("protocolVersion") or "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "refora", "version": "1.0.0"},
                "instructions": (
                    "For questions about the selected workspace's current cards, counts, or "
                    "contents, call list_workspace_context before answering. Use "
                    "read_workspace_item with a returned itemId for report, note, document, "
                    "or asset contents. Do not infer "
                    "the complete workspace from the paper catalog alone."
                ),
            },
        )
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        tools = _request(config, f"/ai/cli-tools/{config['runId']}/list")
        return _result(request_id, {"tools": tools})
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments")
        if not isinstance(name, str) or not isinstance(arguments, dict):
            raise ValueError("MCP tool name and arguments are required")
        output = _request(
            config,
            f"/ai/cli-tools/{config['runId']}/call",
            {
                "name": name,
                "arguments": arguments,
                "toolCallId": str(request_id) if request_id is not None else None,
            },
        )
        text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        return _result(request_id, {"content": [{"type": "text", "text": text}], "isError": False})
    if method in {"resources/list", "prompts/list"}:
        key = "resources" if method == "resources/list" else "prompts"
        return _result(request_id, {key: []})
    raise ValueError(f"Unsupported MCP method: {method}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    config = _load_config(args.config)
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("MCP request must be an object")
            response = _handle(config, message)
        except Exception as error:
            request_id = message.get("id") if isinstance(locals().get("message"), dict) else None
            response = _error(request_id, error)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
