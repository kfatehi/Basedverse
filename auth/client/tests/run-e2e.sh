#!/usr/bin/env bash
# auth inside visit (V2.md 2), end to end: builds visit, and runs e2e.py in a container (the workroom's database is
# the Postgres inside visit; nothing listens outside the container). As this machine's user
# (visit/client/tests/as-user.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$repo/visit/client/cargo" build
docker run --rm -e AS_UID="$(id -u)" -e AS_GID="$(id -g)" \
  -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo python:3.13-slim-bookworm sh visit/client/tests/as-user.sh \
  sh -c 'pip install -q --user "psycopg[binary]==3.2.3" 2>/dev/null && python3 -u auth/client/tests/e2e.py /target/debug/visit'
