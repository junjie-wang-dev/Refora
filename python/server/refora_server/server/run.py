from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

import uvicorn

from .app import create_app, generate_token


def _bind_port(host: str, port: int) -> int:
    if port and port > 0:
        return port
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((host, 0))
    chosen = sock.getsockname()[1]
    sock.close()
    return chosen


def _write_state_file(state_dir: Path, port: int, token: str) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    token_file = state_dir / "server.token"
    payload = json.dumps({"port": port, "token": token})
    fd = os.open(str(token_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(str(token_file), 0o600)
    return token_file


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    port = 0
    host = "127.0.0.1"
    state_dir: str | None = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--port":
            port = int(args[i + 1]); i += 2
        elif arg == "--host":
            host = args[i + 1]; i += 2
        elif arg == "--state-dir":
            state_dir = args[i + 1]; i += 2
        else:
            i += 1

    if host not in ("127.0.0.1", "::1", "localhost"):
        print(f"ERROR host must be loopback, got {host}", file=sys.stderr)
        return 2

    if state_dir is None:
        print("ERROR --state-dir is required", file=sys.stderr)
        return 2

    chosen_port = _bind_port(host, port)
    token = generate_token()
    _write_state_file(Path(state_dir), chosen_port, token)

    os.environ["REFORA_SERVER_TOKEN"] = token
    app = create_app()
    app.state.state_dir = state_dir
    app.state.host = host
    app.state.port = chosen_port

    sys.stdout.write(f"LISTENING {chosen_port}\n")
    sys.stdout.flush()

    uvicorn.run(app, host=host, port=chosen_port, log_config=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())