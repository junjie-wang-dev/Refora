#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT_DIR="$ROOT_DIR/backend"
OUTPUT_DIR="$ROOT_DIR/build/python-server"
WORK_DIR="$ROOT_DIR/build/python-server-work"
ENTRYPOINT="$PROJECT_DIR/sidecar_entry.py"
PYTHON_VERSION=3.12.13

case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARGET_ARCH=${REFORA_TARGET_ARCH:-$HOST_ARCH}
if [ "$TARGET_ARCH" != "$HOST_ARCH" ]; then
  echo "Python sidecar must be built natively: host=$HOST_ARCH target=$TARGET_ARCH" >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR" "$WORK_DIR"
mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

UV_PROJECT_ENVIRONMENT="$WORK_DIR/venv" \
UV_CACHE_DIR=${UV_CACHE_DIR:-"${TMPDIR:-/tmp}/refora-uv-cache"} uv run \
  --project "$PROJECT_DIR" \
  --locked \
  --no-dev \
  --group sidecar \
  --python "$PYTHON_VERSION" \
  pyinstaller \
  --noconfirm \
  --clean \
  --onedir \
  --name refora-server \
  --distpath "$WORK_DIR/dist" \
  --workpath "$WORK_DIR/build" \
  --specpath "$WORK_DIR" \
  --paths "$PROJECT_DIR" \
  --collect-all refora_server \
  --collect-all deepagents \
  --collect-all langchain \
  --collect-all langchain_core \
  --collect-all langchain_openai \
  --collect-all langgraph \
  --collect-all langgraph.checkpoint.sqlite \
  --collect-all watchdog \
  --copy-metadata aiosqlite \
  --copy-metadata deepagents \
  --copy-metadata langchain \
  --copy-metadata langchain-core \
  --copy-metadata langchain-openai \
  --copy-metadata langgraph \
  --copy-metadata langgraph-checkpoint-sqlite \
  "$ENTRYPOINT"

mv "$WORK_DIR/dist/refora-server/refora-server" "$OUTPUT_DIR/refora-server"
mv "$WORK_DIR/dist/refora-server/_internal" "$OUTPUT_DIR/_internal"
chmod 755 "$OUTPUT_DIR/refora-server"
rm -rf "$WORK_DIR/venv"

node "$ROOT_DIR/scripts/write-server-sidecar-manifest.mjs" "$OUTPUT_DIR" "$TARGET_ARCH" "$PYTHON_VERSION"
node "$ROOT_DIR/scripts/verify-server-sidecar.mjs" "$OUTPUT_DIR" "$TARGET_ARCH"
