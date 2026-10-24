# basedverse — walk around each other's workrooms

Everyone builds their own workroom (an agent-office sim, in their own engine), and basedverse is what
they share: a lobby to meet in, and **Visit**, to walk around each other's rooms with WASD and the mouse.
Nothing about a room is shared but the video of it, so what everyone agrees on is a thin interface: three
hooks a host implements, and two pieces everyone drops in unchanged.

| | |
|---|---|
| [visit/](visit/) | Visit: **visit-client** (the local client, Rust: all the networking) and **visit.js** (the library for the workroom's page), [the spec](visit/SPEC.md), and [the integration guide](visit/INTEGRATING.md), written for the coding agent doing it |
| [lobby/](lobby/) | the lobby server everyone connects to (Python): presence, knocks, introductions. [Its protocol](lobby/PROTOCOL.md), its tests, and its deployment (Caddy for TLS, coturn) |
| [bin/deploy-lobby](bin/deploy-lobby) | puts the lobby on a server over ssh, and updates it |
| [.env.example](.env.example) | every setting, with nothing real in it: the template for a workroom's visit-client settings, and for running the lobby |

## Adding Visit to a workroom

1. **Get this repository** (clone it, or unzip a copy) anywhere; beside your workroom's project is the
   usual place.
2. **Get visit-client for your machine.** On Linux, `visit/client/build` makes a static
   `visit/client/bin/visit-client` in Docker; one built that way on the same CPU architecture works too.
   On macOS or Windows, `cargo build --release` in `visit/client/`, with Rust from https://rustup.rs (a
   container cannot listen on the machine's own 127.0.0.1 there).
3. **Tell your coding agent:** *"Integrate Visit into my workroom, following
   &lt;where basedverse is&gt;/visit/INTEGRATING.md. The lobby is wss://&lt;the lobby's address&gt;/."* The guide
   takes it through the settings (from `.env.example`), the launcher, the token, the three hooks, the UI,
   and a test on one machine.

## Running the lobby

One small server for everyone: [lobby/README.md](lobby/README.md) says what to rent and which ports to
open, then `bin/deploy-lobby user@server` sets it up, and later updates it.

## Tests

| | |
|---|---|
| `python3 lobby/server/test_lobby.py`, `python3 lobby/server/test_lobby2.py` | the lobby, versions 1 and 2 (they need `websockets`: `lobby/server/requirements.txt`) |
| `visit/client/cargo test` | visit-client's unit tests, in Docker |
| `visit/client/tests/run-e2e.sh` | the lobby, two visit-clients and two stand-in pages, in Docker |
| `visit/client/tests/run-browser.sh` | visit.js in two headless Chromes on this machine (it needs `google-chrome`) |

## License

MIT: see [LICENSE](LICENSE).
