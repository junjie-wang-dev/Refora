from __future__ import annotations

import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
from pathlib import Path

import uvicorn

from refora_server.db.connection import close_database, open_database

from .app import create_app, generate_token
from .lifespan import create_lifespan


def _database_has_user_content(path: str) -> bool:
    ignored_tables = {
        "legacy_author_repair_pending",
        "legacy_chat_terminal_cleanup",
        "legacy_document_id_repair_candidates",
        "legacy_path_repair_candidates",
        "sync_state",
        "web_search_config",
    }
    try:
        uri = f"{Path(path).resolve().as_uri()}?mode=ro"
        with sqlite3.connect(uri, uri=True) as database:
            tables = database.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
            for row in tables:
                name = row[0]
                if (
                    not isinstance(name, str)
                    or name in ignored_tables
                    or name.startswith("docs_fts")
                ):
                    continue
                quoted_name = name.replace('"', '""')
                if name == "settings":
                    found = database.execute(
                        f'SELECT 1 FROM "{quoted_name}" '
                        "WHERE key <> 'libraryFolderPath' LIMIT 1"
                    ).fetchone()
                else:
                    found = database.execute(
                        f'SELECT 1 FROM "{quoted_name}" LIMIT 1'
                    ).fetchone()
                if found is not None:
                    return True
        return False
    except (OSError, sqlite3.Error):
        return True


def _migrate_legacy_database(source_path: str, destination_path: str) -> None:
    destination_exists = os.path.isfile(destination_path)
    if destination_exists and (
        _database_has_user_content(destination_path)
        or not _database_has_user_content(source_path)
    ):
        return
    destination_directory = os.path.dirname(destination_path)
    fd, temporary_path = tempfile.mkstemp(
        prefix=f".{os.path.basename(destination_path)}.",
        suffix=".migration",
        dir=destination_directory,
    )
    os.close(fd)
    try:
        source_uri = f"{Path(source_path).resolve().as_uri()}?mode=ro"
        with sqlite3.connect(source_uri, uri=True) as source:
            with sqlite3.connect(temporary_path) as destination:
                source.backup(destination)
                check = destination.execute("PRAGMA quick_check").fetchone()
                if check is None or check[0] != "ok":
                    raise sqlite3.DatabaseError("legacy database backup failed integrity check")
        os.chmod(temporary_path, 0o600)
        if os.path.isfile(destination_path) and _database_has_user_content(
            destination_path
        ):
            return
        os.replace(temporary_path, destination_path)
    finally:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass


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
    return db_path, resolved


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


def _parent_process_alive(parent_pid: int) -> bool:
    try:
        os.kill(parent_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _watch_parent_process(
    parent_pid: int,
    request_shutdown,
    stop_event: threading.Event,
    interval_seconds: float = 1.0,
) -> None:
    while not stop_event.wait(interval_seconds):
        if not _parent_process_alive(parent_pid):
            request_shutdown()
            return


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
    parent_pid: int | None = None
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
        elif arg == "--parent-pid":
            parent_pid = int(args[i + 1]); i += 2
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
    if parent_pid is not None and (parent_pid <= 0 or parent_pid == os.getpid()):
        print("ERROR --parent-pid must identify another running process", file=sys.stderr)
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
    parent_watchdog_stop = threading.Event()
    parent_watchdog = None
    if parent_pid is not None:
        parent_watchdog = threading.Thread(
            target=_watch_parent_process,
            args=(parent_pid, app.state.request_shutdown, parent_watchdog_stop),
            name="refora-parent-watchdog",
            daemon=True,
        )
        parent_watchdog.start()
    try:
        server.run(sockets=[listener])
    finally:
        parent_watchdog_stop.set()
        if parent_watchdog is not None:
            parent_watchdog.join(timeout=2)
        listener.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
