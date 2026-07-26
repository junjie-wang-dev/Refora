from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from refora_server.server.artifact_smoke import (
    REQUIRED_DISTRIBUTIONS,
    REQUIRED_MODULES,
    verify_artifact,
)


def test_artifact_smoke_imports_runtime_modules_and_initializes_components():
    result = verify_artifact()

    assert result["ok"] is True
    assert result["modules"] == list(REQUIRED_MODULES)
    assert set(result["versions"]) == set(REQUIRED_DISTRIBUTIONS)


def test_sidecar_entry_exposes_offline_artifact_check():
    entrypoint = Path(__file__).parents[1] / "sidecar_entry.py"

    completed = subprocess.run(
        [sys.executable, str(entrypoint), "--verify-artifact"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    result = json.loads(completed.stdout.strip().splitlines()[-1])

    assert result["ok"] is True
    assert set(result["versions"]) == set(REQUIRED_DISTRIBUTIONS)
