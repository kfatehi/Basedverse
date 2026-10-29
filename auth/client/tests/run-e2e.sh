#!/usr/bin/env bash
# auth inside visit (V2.md 2), end to end: builds visit, and runs e2e.py in a container (the workroom's database is
# the Postgres inside visit; nothing listens outside the container). As this machine's user (Postgres won't run as
# root; its /etc/passwd lent so initdb knows the user).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$repo/visit/client/cargo" build
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo python:3.13-slim-bookworm \
  sh -c 'pip install -q --user "psycopg[binary]==3.2.3" 2>/dev/null && python3 -u auth/client/tests/e2e.py /target/debug/visit'
