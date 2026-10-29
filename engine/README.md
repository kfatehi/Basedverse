# visit-engine

A room's server page, run in a headless Chromium beside visit-client so the room is up whenever the office is,
and the owner's browser is one more client of it. [SPEC.md](SPEC.md) is the contract (section 5 is this
container); [INTEGRATING.md](INTEGRATING.md) says how a room is built on it. Experimental: branch `engine`.

**Build:** `docker build -t visit-engine engine` (from the repository's root). The image is Debian's Chromium and
`driver/engine.py`, Python's standard library only; `docker run --rm visit-engine --version` prints the version
(`VERSION`, baked in).

**Run:** on the workroom's compose network, beside visit-client and the workroom's server, never with a port
published (INTEGRATING.md step 5 has the service):

    docker run --rm --network <net> -v <dir with the key and the host token>:/visit:ro \
      -e ENGINE_ROOM_URL=http://board:3001/room/server -e ENGINE_KEY_FILE=/visit/engine-key \
      -e VISIT_HOST=visit -e VISIT_TOKEN_FILE=/visit/token visit-engine

Every setting, its variable, flag and default: SPEC.md 5.2 (`engine.py --help` lists the flags). `/health` on
`ENGINE_PORT` (7405) answers `{"ok", "version", "room": "hosting" | "loading" | "failed", "since", "reloads"}`.
The driver's shim (`driver/shim.js`) is what the page gets before its own scripts: `window.VISIT_ENGINE`, draw
calls made no-ops, visible and focused, no microphone, frames at 60 or `ENGINE_TICK_IDLE` a second.

**Test:** `engine/tests/run-engine.sh` builds the image and runs it against a test room in Docker (minutes
the first time, for the image; 20 s after; nothing on the host but Docker). `--debug` (`ENGINE_DEBUG=1`) turns on the test's aid, `POST
/debug/eval` and `/debug/crash`; it is not part of the contract and is off otherwise.
