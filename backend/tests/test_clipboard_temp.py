from __future__ import annotations

import os
from pathlib import Path

import pytest

from refora_server.services.clipboard_temp import create_clipboard_temp_service


def test_clipboard_temp_service_preserves_fresh_files_and_removes_stale_dirs(
    tmp_path,
) -> None:
    stale = tmp_path / "refora-clipboard-stale"
    stale.mkdir()
    (stale / "old.md").write_text("old", encoding="utf-8")
    fresh = tmp_path / "refora-clipboard-fresh"
    fresh.mkdir()
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    now = 200_000.0
    os.utime(stale, (now - 90_000, now - 90_000))
    os.utime(fresh, (now, now))
    service = create_clipboard_temp_service(
        str(tmp_path),
        retention_seconds=86_400,
        clock=lambda: now,
    )

    assert service["cleanupStale"]() == 1
    assert not stale.exists()
    assert fresh.is_dir()
    assert unrelated.is_dir()


def test_clipboard_temp_service_creates_private_file_and_discards_on_failure(
    tmp_path,
) -> None:
    service = create_clipboard_temp_service(str(tmp_path))

    path = Path(service["createMarkdown"]("Paper.md", "# Paper"))

    assert path.read_text(encoding="utf-8") == "# Paper"
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    service["discard"](str(path))
    assert not path.parent.exists()


def test_clipboard_temp_service_rejects_nested_file_names(tmp_path) -> None:
    service = create_clipboard_temp_service(str(tmp_path))

    with pytest.raises(ValueError, match="invalid"):
        service["createMarkdown"]("../Paper.md", "# Paper")
