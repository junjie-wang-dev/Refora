#!/bin/sh
set -eu
exec node scripts/ci-local.mjs "$@"
