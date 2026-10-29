#!/usr/bin/env bash
# Builds visit-client (in Docker) and runs the end-to-end test (tests/e2e.py) in a container of its own:
# the lobby, the visit-clients and their stand-in pages, on that container's private loopback, with Postgres
# beside them (a container of its own, sharing that loopback: a database each, gone with it).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$here/../cargo" build
db="visit-e2e-db-$$"
docker run -d --rm --name "$db" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
trap 'docker rm -f "$db" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 120); do docker exec "$db" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 0.5; done
for d in a b c d; do docker exec "$db" createdb -h 127.0.0.1 -U postgres "$d"; done
docker run --rm --network "container:$db" -e VISIT_TEST_DB=postgres://postgres@127.0.0.1:5432 -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo \
  python:3.13-slim-bookworm \
  sh -c 'pip install -q --root-user-action=ignore websockets==15.0.1 >/dev/null && python3 -u visit/client/tests/e2e.py /target/debug/visit-client'
