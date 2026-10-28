#!/usr/bin/env bash
# visit.js in real browsers: builds visit-client, starts two headless Chromes on this machine, and runs
# browser_test.py in a container on the host's network (the lobby, two visit-clients and the test room's
# file server, all on 127.0.0.1). Screenshots and the visit-clients' logs go to $OUT (default: a temp dir).
# The Chromes draw on this machine's GPU, as a visitor's browser does, never in software: SwiftShader takes every
# core the machine has (11 of them for the two Chromes, against 1 on a GPU) and its frame times are the processor's.
# browser_test.py reads the renderer each one got and stops on a software one.
set -euo pipefail
render=(--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --ignore-gpu-blocklist)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"; mkdir -p "$out"
"$here/../cargo" build
# Postgres for the two visit-clients (a database each), on this machine's loopback only, gone with the test.
db="visit-browser-db-$$"
docker run -d --rm --name "$db" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:15432:5432 postgres:17-alpine >/dev/null
pids=()
for p in 9351 9352; do
  google-chrome --headless=new --remote-debugging-port=$p --user-data-dir="$(mktemp -d)" --window-size=1280,720 \
    "${render[@]}" --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
    --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
  pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null || true; docker rm -f "$db" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 120); do docker exec "$db" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 0.5; done
for d in a b; do docker exec "$db" createdb -h 127.0.0.1 -U postgres "$d"; done
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e VISIT_TEST_DB=postgres://postgres@127.0.0.1:15432 -v visit-target:/target:ro -v "$repo":/repo:ro -v "$out":/out -w /repo \
  python:3.13-slim-bookworm sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/browser_test.py /target/debug/visit-client 9351 9352 /out'
echo "screenshots and logs: $out"
