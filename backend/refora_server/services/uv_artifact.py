from __future__ import annotations

import platform


UV_VERSION = "0.11.16"
UV_RELEASES: dict[str, dict[str, str]] = {
    "arm64": {
        "archive": "uv-aarch64-apple-darwin.tar.gz",
        "sha256": "2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb",
    },
    "x64": {
        "archive": "uv-x86_64-apple-darwin.tar.gz",
        "sha256": "6b91ae3de155f51bd1f5b74814821c79f016a176561f252cd9ddfb976939af2e",
    },
}


def normalize_macos_architecture(machine: str | None = None) -> str:
    value = (machine or platform.machine()).lower()
    if value in {"arm64", "aarch64"}:
        return "arm64"
    if value in {"x64", "x86_64", "amd64"}:
        return "x64"
    raise ValueError(f"Unsupported macOS architecture: {value}")


def uv_download_url(release: dict[str, str]) -> str:
    return f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{release['archive']}"
