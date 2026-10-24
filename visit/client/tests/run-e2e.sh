#!/usr/bin/env bash
# Builds visit-client (in Docker) and runs the end-to-end test (tests/e2e.py) in a container of its own:
# the lobby, two visit-clients and two stand-in pages, on that container's private loopback.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$here/../cargo" build
exec docker run --rm -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo python:3.13-slim-bookworm \
  sh -c 'pip install -q --root-user-action=ignore websockets==15.0.1 >/dev/null && python3 -u visit/client/tests/e2e.py /target/debug/visit-client'
