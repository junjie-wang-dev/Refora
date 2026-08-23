from __future__ import annotations

import hashlib
import json
import tomllib
from pathlib import Path

import pytest

from refora_server.mineru_runtime.model_installer import install_models


RUNTIME = Path(__file__).resolve().parents[1] / "refora_server" / "mineru_runtime"


def _file_entry(path: str, content: bytes) -> dict:
    return {
        "path": path,
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def test_runtime_lock_pins_mineru_and_hashes_registry_artifacts():
    project = tomllib.loads((RUNTIME / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((RUNTIME / "uv.lock").read_text(encoding="utf-8"))
    assert project["project"]["requires-python"] == "==3.12.13"
    assert project["project"]["optional-dependencies"] == {
        "arm64": ["mineru[all]==3.4.4"],
        "x64": ["mineru[core]==3.4.4"],
    }
    mineru = next(package for package in lock["package"] if package["name"] == "mineru")
    assert mineru["version"] == "3.4.4"
    for package in lock["package"]:
        if "registry" not in package.get("source", {}):
            continue
        artifacts = ([package["sdist"]] if "sdist" in package else []) + package.get(
            "wheels", []
        )
        assert artifacts
        assert all(artifact["hash"].startswith("sha256:") for artifact in artifacts)


def test_model_manifest_pins_complete_huggingface_snapshots():
    manifest = json.loads(
        (RUNTIME / "model-manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["formatVersion"] == 1
    assert manifest["mineruVersion"] == "3.4.4"
    assert {repository["kind"] for repository in manifest["repositories"]} == {
        "pipeline",
        "vlm",
    }
    for repository in manifest["repositories"]:
        assert len(repository["revision"]) == 40
        assert repository["files"]
        assert len({entry["path"] for entry in repository["files"]}) == len(
            repository["files"]
        )
        assert all(entry["size"] > 0 for entry in repository["files"])
        assert all(len(entry["sha256"]) == 64 for entry in repository["files"])


def test_model_installer_verifies_files_and_writes_local_config(tmp_path):
    pipeline_content = b"pipeline-model"
    vlm_content = b"vlm-model"
    pipeline = tmp_path / "pipeline"
    vlm = tmp_path / "vlm"
    (pipeline / "models").mkdir(parents=True)
    vlm.mkdir()
    (pipeline / "models" / "model.bin").write_bytes(pipeline_content)
    (vlm / "model.bin").write_bytes(vlm_content)
    manifest = {
        "formatVersion": 1,
        "mineruVersion": "3.4.4",
        "repositories": [
            {
                "kind": "pipeline",
                "repoId": "pipeline/repo",
                "revision": "a" * 40,
                "allowPatterns": ["models/*"],
                "files": [_file_entry("models/model.bin", pipeline_content)],
            },
            {
                "kind": "vlm",
                "repoId": "vlm/repo",
                "revision": "b" * 40,
                "allowPatterns": ["*"],
                "files": [_file_entry("model.bin", vlm_content)],
            },
        ],
    }
    manifest_path = tmp_path / "manifest.json"
    config_path = tmp_path / "mineru.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    calls = []

    def snapshot_download(repo_id, **kwargs):
        calls.append((repo_id, kwargs))
        return str(pipeline if repo_id == "pipeline/repo" else vlm)

    roots = install_models(manifest_path, config_path, snapshot_download)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    assert roots == {"pipeline": str(pipeline), "vlm": str(vlm)}
    assert config["models-dir"] == roots
    assert config["model-source"] == "huggingface"
    assert calls[0][1]["revision"] == "a" * 40
    assert calls[1][1]["revision"] == "b" * 40


def test_model_installer_rejects_hash_mismatch(tmp_path):
    root = tmp_path / "model"
    root.mkdir()
    (root / "model.bin").write_bytes(b"tampered")
    manifest = {
        "formatVersion": 1,
        "mineruVersion": "3.4.4",
        "repositories": [
            {
                "kind": "pipeline",
                "repoId": "repo",
                "revision": "a" * 40,
                "allowPatterns": ["*"],
                "files": [_file_entry("model.bin", b"expected")],
            }
        ],
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(RuntimeError, match="failed verification"):
        install_models(
            manifest_path,
            tmp_path / "mineru.json",
            lambda *_args, **_kwargs: str(root),
        )
