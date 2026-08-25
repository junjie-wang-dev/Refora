#!/bin/sh
set -eu

expected_node_version="$(tr -d '[:space:]' < .nvmrc)"
actual_node_version="$(node -p 'process.versions.node')"
expected_npm_version="$(node -p "require('./package.json').engines.npm")"
actual_npm_version="$(npm --version)"

if [ "$actual_node_version" != "$expected_node_version" ]; then
  printf 'Expected Node.js %s, found %s\n' "$expected_node_version" "$actual_node_version" >&2
  exit 1
fi

if [ "$actual_npm_version" != "$expected_npm_version" ]; then
  printf 'Expected npm %s, found %s\n' "$expected_npm_version" "$actual_npm_version" >&2
  exit 1
fi

requirements_file="$(mktemp "${TMPDIR:-/tmp}/refora-requirements.XXXXXX")"
trap 'rm -f "$requirements_file"' EXIT HUP INT TERM

npm ci
npm audit --audit-level=moderate
npm run verify
uv export --project backend --locked --no-dev --no-emit-project --format requirements-txt --output-file "$requirements_file"
uvx --from pip-audit==2.10.1 pip-audit -r "$requirements_file" --disable-pip --progress-spinner off
uv run --project backend --locked python -c "import fastapi, uvicorn, websockets"
npm run test:e2e:ci
npm run package -- --publish never
