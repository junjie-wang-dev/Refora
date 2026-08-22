from __future__ import annotations

import json
import os
import socket
import sqlite3
import sys
from pathlib import Path

import uvicorn

from refora_server.db.connection import close_database, open_database

from .app import create_app, generate_token
from .lifespan import create_lifespan


def resolve_startup_paths(db_path: str, library_folder: str) -> tuple[str, str]:
    configured = os.path.realpath(os.path.abspath(library_folder)) if library_folder else ""
    if configured:
        return db_path, configured
    if not os.path.isfile(db_path):
        return db_path, ""
    try:
        uri = f"{Path(db_path).resolve().as_uri()}?mode=ro"
        with sqlite3.connect(uri, uri=True) as database:
            row = database.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("libraryFolderPath",),
            ).fetchone()
        value = json.loads(row[0]) if row and isinstance(row[0], str) else ""
    except (OSError, sqlite3.Error, TypeError, ValueError):
        return db_path, ""
    if not isinstance(value, str) or not value:
        return db_path, ""
    resolved = os.path.realpath(os.path.abspath(value))
    if not os.path.isdir(resolved):
        return db_path, ""
    return os.path.join(resolved, os.path.basename(db_path)), resolved


def _bind_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port if port and port > 0 else 0))
        sock.listen(2048)
        sock.setblocking(False)
        return sock
    except Exception:
        sock.close()
        raise


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
    user_data_dir: str | None = None
    db_path: str | None = None
    library_folder = ""
    language = "en"
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--port":
            port = int(args[i + 1]); i += 2
        elif arg == "--host":
            host = args[i + 1]; i += 2
        elif arg == "--state-dir":
            state_dir = args[i + 1]; i += 2
        elif arg == "--user-data-dir":
            user_data_dir = args[i + 1]; i += 2
        elif arg == "--db-path":
            db_path = args[i + 1]; i += 2
        elif arg == "--library-folder":
            library_folder = args[i + 1]; i += 2
        elif arg == "--language":
            language = args[i + 1]; i += 2
        else:
            i += 1

    if host not in ("127.0.0.1", "::1", "localhost"):
        print(f"ERROR host must be loopback, got {host}", file=sys.stderr)
        return 2

    if state_dir is None:
        print("ERROR --state-dir is required", file=sys.stderr)
        return 2
    if db_path is None:
        print("ERROR --db-path is required", file=sys.stderr)
        return 2
    if user_data_dir is None:
        print("ERROR --user-data-dir is required", file=sys.stderr)
        return 2

    db_path, library_folder = resolve_startup_paths(db_path, library_folder)

    listener = _bind_socket(host, port)
    chosen_port = listener.getsockname()[1]
    token = generate_token()
    _write_state_file(Path(state_dir), chosen_port, token)

    os.environ["REFORA_SERVER_TOKEN"] = token
    db, _ = open_database(db_path)
    try:
        app = create_app(db=db, library_folder=library_folder)
    except Exception:
        close_database(db)
        raise
    app.router.lifespan_context = create_lifespan(
        db_path,
        library_folder,
        db,
        state_dir=state_dir,
        user_data_dir=user_data_dir,
        language=language,
    )
    app.state.state_dir = state_dir
    app.state.host = host
    app.state.port = chosen_port

    sys.stdout.write(f"LISTENING {chosen_port}\n")
    sys.stdout.flush()

    config = uvicorn.Config(app, host=host, port=chosen_port, log_config=None)
    server = uvicorn.Server(config)
    app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
