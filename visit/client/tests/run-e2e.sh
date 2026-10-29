#!/usr/bin/env bash
# Builds visit (in Docker) and runs the end-to-end test (tests/e2e.py) in a container of its own: the lobby, the
# visits and their stand-in pages, on that container's private loopback, each visit with the Postgres inside it
# (V2.md 4: its own data directory, made at its first start). As this machine's user (Postgres won't run as root;
# its /etc/passwd lent so initdb knows the user).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$here/../cargo" build
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo python:3.13-slim-bookworm \
  sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/e2e.py /target/debug/visit'
