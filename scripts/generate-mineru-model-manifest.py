from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path


REPOSITORIES = (
    {
        "kind": "pipeline",
        "repoId": "opendatalab/PDF-Extract-Kit-1.0",
        "allowPatterns": [
            "models/Layout/PP-DocLayoutV2/*",
            "models/MFR/unimernet_hf_small_2503/*",
            "models/MFR/pp_formulanet_plus_m/*",
            "models/OCR/paddleocr_torch/*",
            "models/TabRec/SlanetPlus/slanet-plus.onnx",
            "models/TabRec/UnetStructure/unet.onnx",
            "models/TabCls/paddle_table_cls/PP-LCNet_x1_0_table_cls.onnx",
        ],
    },
    {
        "kind": "vlm",
        "repoId": "opendatalab/MinerU2.5-Pro-2605-1.2B",
        "allowPatterns": ["*"],
    },
)


def _request_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "Refora-MinerU-Manifest/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def _download_sha256(url: str) -> str:
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={"User-Agent": "Refora-MinerU-Manifest/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _matches(path: str, patterns: list[str]) -> bool:
    from fnmatch import fnmatchcase

    return any(fnmatchcase(path, pattern) for pattern in patterns)


def _repository_manifest(spec: dict) -> dict:
    encoded_repo = urllib.parse.quote(spec["repoId"], safe="/")
    metadata = _request_json(
        f"https://huggingface.co/api/models/{encoded_repo}/revision/main?blobs=true"
    )
    revision = metadata["sha"]
    files = []
    for sibling in metadata["siblings"]:
        path = sibling["rfilename"]
        if not _matches(path, spec["allowPatterns"]):
            continue
        lfs = sibling.get("lfs")
        sha256 = lfs.get("sha256") if isinstance(lfs, dict) else None
        if not sha256:
            encoded_path = urllib.parse.quote(path, safe="/")
            sha256 = _download_sha256(
                f"https://huggingface.co/{encoded_repo}/resolve/{revision}/{encoded_path}"
            )
        files.append(
            {"path": path, "size": sibling["size"], "sha256": sha256}
        )
    if not files:
        raise RuntimeError(f"No model files matched for {spec['repoId']}")
    return {
        **spec,
        "revision": revision,
        "files": sorted(files, key=lambda item: item["path"]),
    }


def main() -> None:
    destination = Path(
        sys.argv[1]
        if len(sys.argv) > 1
        else "backend/refora_server/mineru_runtime/model-manifest.json"
    )
    manifest = {
        "formatVersion": 1,
        "mineruVersion": "3.4.4",
        "repositories": [_repository_manifest(spec) for spec in REPOSITORIES],
    }
    destination.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
