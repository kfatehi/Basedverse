# visit-client

Visit's local client ([../SPEC.md](../SPEC.md)): one per workroom per machine. It holds the lobby session,
the links to other visit-clients (QUIC through [iroh](https://iroh.computer)) and the visits, keeps them
across page reloads, and serves the workroom's page on 127.0.0.1 only, behind a token. It also serves the
library, `web/visit.js`, at `/visit.js`.

Nothing to install: `./cargo` runs cargo in the official Rust image, with the crate registry and the build
output in Docker volumes.

```sh
./build                        # a static binary to run or hand out: bin/visit-client (Linux)
./cargo build --release        # for working on it: the binary is target/release/visit-client in the visit-target volume
./cargo test                   # unit tests
tests/run-e2e.sh               # end to end: the real lobby, two visit-clients, two stand-in pages, in a container
                               # (tests/e2e.py BIN OTHER_BIN runs B on another build: two versions together)
tests/run-browser.sh           # visit.js in two headless Chromes: knock, walk with WASD, reload, leave
```

Releases are built for every platform by `../../.github/workflows/release.yml`, on a tag (the top README,
"Releasing visit-client").

`tests/room.html` is a small workroom to try it with: its room is a floor plan, each visitor an arrow.

| file | what |
|---|---|
| `src/main.rs` | flags, startup, the ready line, signals |
| `src/core.rs` | the one task that owns the state and routes everything (the page, the lobby, the links) |
| `src/page.rs` | HTTP on 127.0.0.1: `/visit.js`, `/health`, the page WebSocket and its token |
| `src/lobby.rs` | the lobby session (`basedverse-lobby/2`): reconnecting and resuming |
| `src/link.rs` | the links: dialling, admitting, video, inputs, bitrate, the grace period |
| `src/frames.rs` | framing for control messages and video |
| `web/visit.js` | the library: the lobby's state and actions, the host hooks, WebCodecs, input, `Visit.walk`, `Visit.panel` |
