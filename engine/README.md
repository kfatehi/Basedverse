# The engine

A room's server page, run headless inside `visit`, so the room is up whenever the office is, and the owner's
browser is one more client of it. [SPEC.md](SPEC.md) is the contract (section 5 is this crate);
[INTEGRATING.md](INTEGRATING.md) says how a room is built on it. In 1.x it was an image of its own, `visit-engine`;
from 2.0 it is a library built into `visit` ([../visit/client/](../visit/client/)).

**What it is:** `src/lib.rs` loads the room's server page in the headless Chrome `visit` carries and keeps it
hosting (its key on the room's own requests, reloads with backoff, the memory ceiling, `/health`); `src/cdp.rs`
speaks the devtools protocol to that Chrome (over its pipe); `src/shim.js` is what
the page gets before its own scripts: `window.VISIT_ENGINE`, draw calls made no-ops, visible and focused, no
microphone, frames at 60 or `ENGINE_TICK_IDLE` a second. The Chrome is Chrome for Testing's headless shell, built
and pinned in [../deps/](../deps/) (its README says how `visit` starts it).

**Run:** `visit` runs it when given `ENGINE_ROOM_URL` (INTEGRATING.md step 5), and makes its API key itself at each
start: nothing else to start, no image, no key file. Every setting, its variable, flag and default: SPEC.md 5.2
(`visit --help` lists the flags). `/health` on `ENGINE_PORT` (7405), at `visit`'s `--listen` address, answers
`{"ok", "version", "room": "hosting" | "loading" | "failed", "since", "reloads"}`.

**Test:** `engine/tests/run-engine.sh` builds `visit` and runs it, with the sign-in and the engine, in one bare
container (nothing of Chrome's installed, as on a fresh machine), beside a test workroom's server (`server.py`:
`page.html` to the engine's key, and nothing else) and the checks (`test.py`: hosting, nothing drawn, visible and
focused, no microphone, the key where it belongs, 60 and `ENGINE_TICK_IDLE` frames a second, a crash reloaded,
memory). Minutes the first time, for the build; Docker only to build and test. `--engine-debug` (`ENGINE_DEBUG=1`)
turns on the test's aid, `POST /debug/eval` and `/debug/crash`; it is not part of the contract and is off
otherwise.
