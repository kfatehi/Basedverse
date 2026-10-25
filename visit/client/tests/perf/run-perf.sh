#!/usr/bin/env bash
# Visit under the networks people have, on this machine: a lobby, a host and its visitors, each in a
# container of its own with the network a scenario gives it (Linux's netem: delay, jitter, loss, a rate cap),
# real visit-clients (a release build), and fake pages in place of browsers (node.py). Each scenario's
# visitors time every frame from the input it shows; report.py turns that into a table against targets.
#
#   tests/perf/run-perf.sh                 every scenario (about 4 minutes)
#   tests/perf/run-perf.sh metro wifi      just these
#   SECONDS_EACH=30 OUT=/some/dir ...      longer measurements; where the results go (default: a temp dir)
#
# What it measures is visit-client and the network: input to frame, frames a second, stalls, bitrate. Not a
# browser's own encode, decode and paint (see run-browser.sh for those, on one machine).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"; mkdir -p "$out"
secs="${SECONDS_EACH:-20}"
net=visit-perf

# name | visitors | the host's way out | each visitor's way out   (a round trip is the two delays together; a rate
# cap's buffer, `limit` packets, is a home router's: some 200 ms of it)
SCENARIOS="
lan|1||
metro|1|delay 4ms 1ms|delay 4ms 1ms
cross-country|1|delay 35ms 2ms|delay 35ms 2ms
wifi|1|delay 15ms 4ms loss 1.5%|delay 15ms 4ms loss 1.5%
relayed|1|delay 40ms 2ms rate 5mbit limit 80|delay 40ms 2ms
tight|1|delay 10ms 1ms rate 2mbit limit 40|delay 10ms 1ms
busy|6|delay 4ms 1ms|delay 4ms 1ms
"
want=" $* "

echo "building visit-client (release) and the perf image"
"$here/../../cargo" build --release >/dev/null 2>&1 || "$here/../../cargo" build --release
docker run --rm -v visit-target:/target:ro -v "$out":/o alpine sh -c 'cp /target/release/visit-client /o/visit-client && chmod 755 /o/visit-client'
docker build -q -t visit-perf "$here" >/dev/null
docker network create "$net" >/dev/null 2>&1 || true

cleanup() { docker rm -f $(docker ps -aq --filter name='^vp-') >/dev/null 2>&1 || true; }
# The containers run as root (tc needs it): what they wrote is handed back to you at the end.
finish() { cleanup; docker run --rm -v "$out":/o alpine chown -R "$(id -u):$(id -g)" /o >/dev/null 2>&1 || true; }
trap finish EXIT

node() {   # node NAME DIR ROLE ARGS...
  local name="$1" dir="$2"; shift 2
  docker run -d --name "vp-$name" --network "$net" --cap-add NET_ADMIN -u 0 \
    -v "$out/visit-client":/bin/visit-client:ro -v "$here/node.py":/node.py:ro -v "$dir":/out \
    visit-perf python3 -u /node.py "$@" >/dev/null
}

echo "$SCENARIOS" | while IFS='|' read -r name visitors hostnet visnet; do
  [ -n "$name" ] || continue
  [ "$want" = "  " ] || [[ "$want" == *" $name "* ]] || continue
  cleanup
  dir="$out/$name"; rm -rf "$dir"; mkdir -p "$dir"
  printf '%-14s %s visitor(s), host out: %-28s visitor out: %s\n' "$name" "$visitors" "${hostnet:-as is}" "${visnet:-as is}"
  printf '%s\n%s\n%s\n' "$visitors" "$hostnet" "$visnet" > "$dir/scenario"
  docker run -d --name vp-lobby --network "$net" -v "$repo/lobby/server":/lobby:ro -e STUN_URLS= visit-perf \
    sh -c 'cd /lobby && python3 -u lobby.py' >/dev/null
  for _ in $(seq 50); do docker exec vp-lobby python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8765/health")' 2>/dev/null && break; sleep 0.2; done
  node host "$dir" host Host --lobby ws://vp-lobby:8765 --net "$hostnet"
  for i in $(seq "$visitors"); do node "v$i" "$dir" visitor "V$i" --lobby ws://vp-lobby:8765 --host Host --seconds "$secs" --net "$visnet"; done
  for i in $(seq "$visitors"); do timeout $((secs + 60)) docker wait "vp-v$i" >/dev/null || echo "  ⚠ V$i did not finish"; done
  for c in $(docker ps -aq --filter name='^vp-v'); do docker logs "$c" 2>&1 | { grep -v '^$' || true; } | sed 's/^/  /' | tail -3; done
done

docker run --rm -v "$out":/out:ro -v "$here/report.py":/report.py:ro visit-perf python3 /report.py /out | tee "$out/report.md"
echo "results: $out"
