# visit

The one program a workroom runs ([../SPEC.md](../SPEC.md) 4): one per workroom per machine. At its heart is
visit-client, Visit's local client: it holds the lobby session, the links to other workrooms (QUIC through
[iroh](https://iroh.computer)) and the visits, keeps them across page reloads, and serves the workroom's page on
127.0.0.1 only, behind a token. It also serves the library, `web/visit.js`, at `/visit.js`. Built into it: the
workroom's sign-in ([../../auth/client/](../../auth/client/), a library), its engine
([../../engine/](../../engine/), a library), and the Postgres and the headless Chrome of
[../../deps/](../../deps/), which it carries and runs as its own children.

Nothing to install: `./cargo` runs cargo in the official Rust image, with the crate registry and the build
output in Docker volumes. The crate is one of the workspace's (`../../Cargo.toml`), with `auth` and `engine`.

```sh
./build                        # a static binary to run or hand out: bin/visit (Linux)
./cargo build --release        # for working on it: the binary is target/release/visit in the visit-target volume
./cargo test                   # unit tests
tests/run-e2e.sh               # end to end: the real lobby, two visits, two stand-in pages, in a container
                               # (tests/e2e.py BIN OTHER_BIN runs B on another build: two versions together)
tests/run-browser.sh           # visit.js in two headless Chromes (google-chrome on this machine): knock, walk with
                               # WASD, reload, leave, in a three.js room; worlds; a room hosted by the engine
tests/perf/run-perf.sh         # performance under simulated networks (netem), in containers: a table against targets
```

Its build takes the Postgres and Chrome archives `../../deps/pinned.json` names for the platform it builds for
(`build.rs`: from `../../deps/dist/` when one there has the pinned sha256, else downloaded once into the build's
output), checks each against its sha256 and carries them inside. Releases are built for every platform by
`../../.github/workflows/release.yml`, on a tag (the top README, "Releasing visit").

Its database is the Postgres it carries (../SPEC.md 4.4), in the workroom's data directory. The test scripts run
each visit as this machine's user in a container (Postgres won't run as root; `/etc/passwd` lent, so `initdb`
knows the user), each with a data directory of its own.

`tests/room.html` is a small workroom to try it with: its room is a floor plan, each visitor an arrow.

| file | what |
|---|---|
| `src/main.rs` | flags, the commands (`visit auth`, `import`, `psql`, `status`), startup, the ready line, signals |
| `src/core.rs` | the one task that owns the state and routes everything (the page, the lobby, the links) |
| `src/page.rs` | HTTP on 127.0.0.1: `/visit.js`, `/health`, the page WebSocket, its roles and tokens, the relay's preface |
| `src/lobby.rs` | the lobby session (`basedverse-lobby/3`): reconnecting and resuming |
| `src/link.rs` | the links: dialling, admitting, a scene's deltas and edits, inputs, the grace period |
| `src/frames.rs` | framing for control messages, deltas and scene edits (and unpacking edits, with their limits) |
| `src/state.rs` | the state file: away or not, the office's key, its door, guests and world |
| `src/land.rs` | friends' landscapes, and the plots kept while their offices are away |
| `src/db.rs`, `migrations/` | the visit-client's database (../SPEC.md 8.12) and its schema's migrations |
| `src/media.rs` | pictures, voice messages and links' previews in chat |
| `src/pg.rs` | the Postgres it carries: made, started, its roles and schemas brought up to date, stopped; `visit import` |
| `src/runtime.rs` | what it carries, unpacked once per version into the user's runtime directory; the data directory's default |
| `build.rs` | the pinned Postgres and Chrome, built in |
| `web/visit.js` | the library: the lobby's state and actions, sending a room's scene and drawing a host's, the host hooks, input, `Visit.walk`, `Visit.panel`, `Visit.stage` |
