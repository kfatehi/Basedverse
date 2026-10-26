#!/usr/bin/env bash
# visit.js in real browsers: builds visit-client, starts two headless Chromes on this machine, and runs
# browser_test.py in a container on the host's network (the lobby, two visit-clients and the test room's
# file server, all on 127.0.0.1). Screenshots and the visit-clients' logs go to $OUT (default: a temp dir).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"; mkdir -p "$out"
"$here/../cargo" build
pids=()
for p in 9351 9352; do
  google-chrome --headless=new --remote-debugging-port=$p --user-data-dir="$(mktemp -d)" --window-size=1280,720 \
    --use-angle=swiftshader --enable-unsafe-swiftshader --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
    --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
  pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
sleep 2
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v visit-target:/target:ro -v "$repo":/repo:ro -v "$out":/out -w /repo \
  python:3.13-slim-bookworm sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/browser_test.py /target/debug/visit-client 9351 9352 /out'
echo "screenshots and logs: $out"
