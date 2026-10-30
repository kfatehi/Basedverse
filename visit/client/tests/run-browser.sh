#!/usr/bin/env bash
# visit.js in real browsers: builds visit-client, starts two headless Chromes on this machine, and runs
# browser_test.py in a container on the host's network (the lobby, two visit-clients and the test room's
# file server, all on 127.0.0.1). Screenshots and the visit-clients' and Chromes' logs go to $OUT (default: a temp dir).
# The Chromes draw on this machine's GPU, as a visitor's browser does, never in software: SwiftShader takes every
# core the machine has (11 of them for the two Chromes, against 1 on a GPU) and its frame times are the processor's.
# browser_test.py reads the renderer each one got and stops on a software one. On Linux, ANGLE on OpenGL: on
# Vulkan (NVIDIA's driver, at least), Chrome's GPU process crashes (SIGSEGV) as soon as a page makes or drops a
# second WebGL context, as Visit's view of a room it visits does, and every context goes with it. Elsewhere,
# Chrome's own backend for the platform.
set -euo pipefail
render=(--enable-gpu --ignore-gpu-blocklist)
if [ "$(uname -s)" = Linux ]; then render+=(--use-angle=gl); fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"; mkdir -p "$out"
"$here/../cargo" build
pids=()
for p in 9351 9352; do
  google-chrome --headless=new --remote-debugging-port=$p --user-data-dir="$(mktemp -d)" --window-size=1280,720 \
    "${render[@]}" --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
    --no-first-run --no-default-browser-check about:blank >"$out/chrome-$p.log" 2>&1 &
  pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
# The engine (V2.md 5) hosts the third office's room inside C's own visit, in the headless Chrome visit carries:
# the test starts C with it (its /health and test aid on a port free then). ENGINE=0 skips it: the test then hosts
# C's room in a window of its own instead.
# Each visit's database is the Postgres inside it (V2.md 4), run as this machine's user (tests/as-user.sh).
docker run --rm --network host -e AS_UID="$(id -u)" -e AS_GID="$(id -g)" \
  -e ENGINE="${ENGINE:-1}" \
  -v visit-target:/target:ro -v "$repo":/repo:ro -v "$out":/out -w /repo \
  python:3.13-slim-bookworm sh visit/client/tests/as-user.sh sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/browser_test.py /target/debug/visit 9351 9352 /out'
echo "screenshots and logs: $out"
