from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path


def create_db_snapshot(db_path: str | Path, dest_path: str | Path) -> Path:
    source_path = Path(db_path).expanduser().resolve()
    destination_path = Path(dest_path).expanduser().resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination_path.with_name(
        f"{destination_path.name}.tmp-{uuid.uuid4().hex}"
    )
    source_uri = f"{source_path.as_uri()}?mode=ro"
    try:
        with sqlite3.connect(source_uri, uri=True) as source:
            source.execute("PRAGMA query_only = ON")
            source.execute("PRAGMA busy_timeout = 5000")
            with sqlite3.connect(temporary_path) as destination:
                source.backup(destination)
        os.chmod(temporary_path, 0o400)
        os.replace(temporary_path, destination_path)
        os.chmod(destination_path, 0o400)
        return destination_path
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def cleanup_snapshot(dest_path: str | Path) -> None:
    Path(dest_path).unlink(missing_ok=True)
