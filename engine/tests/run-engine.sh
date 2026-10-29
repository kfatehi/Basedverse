#!/usr/bin/env bash
# The engine's test (V2.md 5): builds visit, and runs, in one bare container (python:3.13-slim: nothing of Chrome's
# installed, as on a fresh machine), the test's workroom's server (server.py: page.html to a key the sign-in API
# takes, and nothing else), visit with the sign-in API and the engine hosting that page, and test.py (hosting,
# nothing drawn, visible and focused, no microphone, the key where it belongs, 60 and ENGINE_TICK_IDLE frames a
# second, a crash reloaded, memory). As this machine's user (Postgres won't run as root). Prints ok/FAIL lines;
# exits non-zero on a failure. visit's log is printed last.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
"$repo/visit/client/cargo" build
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  -v visit-target:/target:ro -v "$here":/tests:ro python:3.13-slim-bookworm bash -c '
    set -u
    d=$(mktemp -d); export XDG_DATA_HOME=$d/xdg AUTH_PORT=7403 AUTH_TOKEN_FILE=$d/auth-token ENGINE_PORT=7405 VISIT_PORT=7401
    (umask 077; od -An -tx1 -N32 /dev/urandom | tr -d " \n" > $d/visit-token; od -An -tx1 -N32 /dev/urandom | tr -d " \n" > $AUTH_TOKEN_FILE)
    python3 -u /tests/server.py > $d/server.log 2>&1 &
    /target/debug/visit --lobby ws://127.0.0.1:9/ --name "Engine Test" --port $VISIT_PORT --token-file $d/visit-token --data-dir $d/office \
      --engine-room-url http://127.0.0.1:3001/room/server --engine-debug > $d/visit.out 2> $d/visit.log &
    visit=$!
    TOKEN=$(cat $d/visit-token) python3 -u /tests/test.py; fails=$?
    kill -TERM $visit; wait $visit
    echo "--- visit'"'"'s log"; grep -v " DEBUG " $d/visit.log | tail -n 30
    exit $fails'
