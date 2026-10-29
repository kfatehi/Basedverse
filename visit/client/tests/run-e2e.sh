#!/usr/bin/env bash
# Builds visit (in Docker) and runs the end-to-end test (tests/e2e.py) in a container of its own: the lobby, the
# visits and their stand-in pages, on that container's private loopback, each visit with the Postgres inside it
# (V2.md 4: its own data directory, made at its first start). As this machine's user (tests/as-user.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$here/../cargo" build
docker run --rm -e AS_UID="$(id -u)" -e AS_GID="$(id -g)" \
  -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo python:3.13-slim-bookworm sh visit/client/tests/as-user.sh \
  sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/e2e.py /target/debug/visit'
