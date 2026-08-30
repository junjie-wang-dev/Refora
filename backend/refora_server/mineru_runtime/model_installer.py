from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable


_DOWNLOAD_ATTEMPTS = 8
_DOWNLOAD_WORKERS = 4


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _discard_invalid_file(root: Path, path: Path) -> None:
    try:
        target = path.resolve(strict=True)
    except OSError:
        target = None
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    cache_root = root.parent.parent
    if target is not None and target != path and target.is_relative_to(cache_root):
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass


def _verify_repository(root: Path, repository: dict[str, Any]) -> None:
    expected = {entry["path"]: entry for entry in repository["files"]}
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }
    if actual != set(expected):
        missing = sorted(set(expected) - actual)
        unexpected = sorted(actual - set(expected))
        for relative in unexpected:
            try:
                (root / relative).unlink(missing_ok=True)
            except OSError:
                pass
        raise RuntimeError(
            f"Model snapshot file set mismatch: missing={missing}, unexpected={unexpected}"
        )
    for relative, entry in expected.items():
        path = root / relative
        if path.stat().st_size != entry["size"] or _sha256(path) != entry["sha256"]:
            _discard_invalid_file(root, path)
            raise RuntimeError(f"Model file failed verification: {relative}")


def _download_repository(
    repository: dict[str, Any],
    snapshot_download: Callable[..., str],
) -> Path:
    last_error: Exception | None = None
    for _attempt in range(_DOWNLOAD_ATTEMPTS):
        try:
            root = Path(
                snapshot_download(
                    repository["repoId"],
                    revision=repository["revision"],
                    allow_patterns=repository["allowPatterns"],
                    max_workers=_DOWNLOAD_WORKERS,
                )
            ).resolve()
            _verify_repository(root, repository)
            return root
        except Exception as error:
            last_error = error
    raise RuntimeError(
        f"Model snapshot {repository['repoId']} failed after "
        f"{_DOWNLOAD_ATTEMPTS} attempts: {last_error}"
    ) from last_error


def install_models(
    manifest_path: Path,
    config_path: Path,
    snapshot_download: Callable[..., str] | None = None,
) -> dict[str, str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("formatVersion") != 1 or manifest.get("mineruVersion") != "3.4.4":
        raise RuntimeError("MinerU model manifest is incompatible")
    if snapshot_download is None:
        from huggingface_hub import snapshot_download as huggingface_snapshot_download

        snapshot_download = huggingface_snapshot_download
    roots: dict[str, str] = {}
    for repository in manifest["repositories"]:
        root = _download_repository(repository, snapshot_download)
        roots[repository["kind"]] = str(root)
    if set(roots) != {"pipeline", "vlm"}:
        raise RuntimeError("MinerU model manifest is incomplete")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config_path.with_name(f"{config_path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(
            {
                "bucket_info": {"[default]": [None, None, None]},
                "latex-delimiter-config": {
                    "display": {"left": "$$", "right": "$$"},
                    "inline": {"left": "$", "right": "$"},
                },
                "models-dir": roots,
                "model-source": "huggingface",
                "config_version": "1.3.2",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, config_path)
    return roots


def main() -> None:
    if len(sys.argv) != 3:
        raise RuntimeError("Usage: model_installer.py <manifest> <config>")
    install_models(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    main()
