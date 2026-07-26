#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARGET_ARCH=${REFORA_TARGET_ARCH:-$HOST_ARCH}
if [ "$TARGET_ARCH" != "$HOST_ARCH" ]; then
  echo "macOS package must be built natively: host=$HOST_ARCH target=$TARGET_ARCH" >&2
  exit 1
fi

REFORA_TARGET_ARCH="$TARGET_ARCH" npm run build:server-sidecar
npm run build
npx electron-builder --mac "--$TARGET_ARCH" "$@"

if [ "$TARGET_ARCH" = "arm64" ]; then
  APPLICATION_PATH="$ROOT_DIR/dist/mac-arm64/Refora.app"
else
  APPLICATION_PATH="$ROOT_DIR/dist/mac/Refora.app"
fi
node "$ROOT_DIR/scripts/verify-packaged-sidecar.mjs" "$APPLICATION_PATH" "$TARGET_ARCH"
