#!/usr/bin/env bash
# auth-client against real Postgres: builds it (and visit-client, whose tables it moves), starts two Postgres 17 in
# Docker on a network of their own, one made as 0.20's setup made Visit's database (visit-client on its superuser)
# and one fresh, and runs e2e.py in a container on that network. Nothing listens outside it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$repo/visit/client/cargo" build   # visit, with auth inside it (V2.md 2)
net="auth-e2e-$$" old="auth-e2e-old-$$" new="auth-e2e-new-$$"
docker network create "$net" >/dev/null
trap 'docker rm -f "$old" "$new" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$old" --network "$net" --network-alias old -e POSTGRES_USER=visit -e POSTGRES_PASSWORD=old-password-0.20-setup \
  -e POSTGRES_DB=visit postgres:17-alpine >/dev/null
docker run -d --rm --name "$new" --network "$net" --network-alias new -e POSTGRES_USER=basedverse -e POSTGRES_PASSWORD=admin-password-fresh \
  -e POSTGRES_DB=visit postgres:17-alpine >/dev/null
for db in "$old" "$new"; do
  for _ in $(seq 1 120); do docker exec "$db" pg_isready -q -h 127.0.0.1 && break; sleep 0.5; done
done
docker run --rm --network "$net" -u "$(id -u):$(id -g)" -e HOME=/tmp -v visit-target:/target:ro -v "$repo":/repo:ro -w /repo \
  python:3.13-slim-bookworm sh -c 'pip install -q --user "psycopg[binary]==3.2.3" 2>/dev/null && python3 -u auth/client/tests/e2e.py /target/debug/visit /target/debug/visit'
