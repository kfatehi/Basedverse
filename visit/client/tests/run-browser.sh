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
# visit-engine (../../../engine), for the third office's room (engine/SPEC.md 11, step 2): its image built, the
# container on this machine's network (so it reaches the test's web server and visit-client C on 127.0.0.1), its
# tokens made here and given to the test; it retries until both are there. ENGINE=0 skips it: the test then hosts
# C's room in a window of its own instead.
engine=""
if [ "${ENGINE:-1}" != 0 ]; then
  docker build -q -t visit-engine "$repo/engine" >/dev/null
  (umask 077; printf 'test-key' > "$out/c.key"; od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$out/c.token"; od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$out/c.user-token")
  engine="visit-engine-$$"
  docker run -d --rm --name "$engine" --network host -u "$(id -u):$(id -g)" -v "$out":/out:ro \
    -e ENGINE_ROOM_URL="http://127.0.0.1:18771/room.html?role=host&three=160&world=1" -e ENGINE_KEY_FILE=/out/c.key \
    -e VISIT_HOST=127.0.0.1 -e VISIT_PORT=7423 -e VISIT_TOKEN_FILE=/out/c.token -e ENGINE_PORT=7425 -e ENGINE_DEBUG=1 visit-engine >/dev/null
  trap 'kill "${pids[@]}" 2>/dev/null || true; docker logs "'"$engine"'" > "'"$out"'/engine.log" 2>&1 || true; docker rm -f "'"$engine"'" >/dev/null 2>&1 || true' EXIT
fi
# Each visit's database is the Postgres inside it (V2.md 4), run as this machine's user: its /etc/passwd lent, so
# initdb knows the user.
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  ${engine:+-e ENGINE_PORT=7425 -e VISIT_C_TOKEN="$(cat "$out/c.token")" -e VISIT_C_USER_TOKEN="$(cat "$out/c.user-token")"} \
  -v visit-target:/target:ro -v "$repo":/repo:ro -v "$out":/out -w /repo \
  python:3.13-slim-bookworm sh -c 'pip install -q --user websockets==15.0.1 2>/dev/null && python3 -u visit/client/tests/browser_test.py /target/debug/visit 9351 9352 /out'
echo "screenshots and logs: $out"
