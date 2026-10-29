#!/usr/bin/env bash
# visit-engine's test: builds the image, starts the test's workroom's server (server.py: page.html to the engine's
# key only) and the engine against it on a network of their own, runs test.py in a third container on that network
# (hosting, nothing drawn, visible and focused, no microphone, the key where it belongs, 60 and ENGINE_TICK_IDLE
# frames a second, a crash reloaded), then samples the engine's memory and CPU. Nothing on the host but Docker.
# Prints ok/FAIL lines; exits non-zero on a failure. The engine's log is printed last.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${IMAGE:-visit-engine}"
net="visit-engine-test-$$"
dir="$(mktemp -d)"
cleanup() { docker rm -f "$net-engine" "$net-room" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
docker build -q -t "$image" "$here/.." >/dev/null
echo "image $image: $(docker images --format '{{.Size}}' "$image")"
printf 'test-key' >"$dir/key"
token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
printf '%s' "$token" >"$dir/token"
chmod 600 "$dir/key" "$dir/token"
docker network create "$net" >/dev/null
docker run -d --rm --name "$net-room" --network "$net" --network-alias room --network-alias visit -v "$here":/tests:ro \
  --entrypoint python3 "$image" -u /tests/server.py >/dev/null
docker run -d --rm --name "$net-engine" --network "$net" --network-alias engine -u "$(id -u):$(id -g)" -v "$dir":/visit:ro \
  -e ENGINE_ROOM_URL=http://room:3001/room/server -e ENGINE_KEY_FILE=/visit/key -e VISIT_TOKEN_FILE=/visit/token -e ENGINE_DEBUG=1 \
  "$image" >/dev/null
fails=0
docker run --rm --network "$net" -e TOKEN="$token" -v "$here":/tests:ro --entrypoint python3 "$image" -u /tests/test.py || fails=1
stats="$(docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' "$net-engine")"
mem="${stats%% *}"
if [[ "$mem" == *MiB && "${mem%MiB}" != "" ]] && awk -v m="${mem%MiB}" 'BEGIN { exit !(m < 1024) }'; then
  echo "ok    the engine's memory within ENGINE_MEMORY_MAX, 1024 MiB ($stats)"
else
  echo "FAIL  the engine's memory within ENGINE_MEMORY_MAX, 1024 MiB ($stats)"; fails=1
fi
echo "--- the engine's log"
docker logs "$net-engine" 2>&1 | grep -v ' debug ' | tail -n 25
exit $fails
