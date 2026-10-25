# basedverse — walk around each other's workrooms

Everyone builds their own workroom (an agent-office sim, in their own engine), and basedverse is what
they share: a lobby to meet in, and **Visit**, to walk around each other's rooms with WASD and the mouse.
Nothing about a room is shared but the video of it, so what everyone agrees on is a thin interface: three
hooks a host implements, and two pieces everyone drops in unchanged.

| | |
|---|---|
| [visit/](visit/) | Visit: **visit-client** (the local client, Rust: all the networking) and **visit.js** (the library for the workroom's page), [the spec](visit/SPEC.md), and [the integration guide](visit/INTEGRATING.md), written for the coding agent doing it |
| [lobby/](lobby/) | the lobby server everyone connects to (Python): presence, knocks, introductions. [Its protocol](lobby/PROTOCOL.md), its tests, and its deployment (Caddy for TLS, coturn) |
| [bin/setup](bin/setup) | sets up Visit for a workroom: the lobby (or deploys your own), your office, visit-client, your `.env` |
| [bin/deploy-lobby](bin/deploy-lobby) | puts the lobby on a server over ssh, and updates it |
| [CHANGELOG.md](CHANGELOG.md) | every release: what changed, and what an integration does about it (read it to upgrade) |
| [.env.example](.env.example) | every setting, with nothing real in it: the template for a workroom's visit-client settings, and for running the lobby |

## Adding Visit to a workroom

Paste this to your coding agent, in your workroom's project, with the lobby's address filled in (ask
whoever runs your lobby):

> Clone https://github.com/sarmiena/Basedverse beside this project, then integrate Visit into my
> workroom, following its visit/INTEGRATING.md. The lobby is wss://&lt;the lobby's address&gt;/.

The guide takes it from there. Early on, it has the agent ask you to run `bin/setup` in a terminal: it
asks you for the lobby (an address you have, or your own server, where it deploys one), your office's name
and your page's address, gets visit-client for your machine, and writes your workroom's `.env`. Then the
agent writes the launcher, the token handoff, the three hooks and the UI, and tests it on one machine.
By hand, that is:

1. **Get this repository** (`git clone https://github.com/sarmiena/Basedverse`) anywhere; beside your
   workroom's project is the usual place.
2. **Run `python3 Basedverse/bin/setup --env <your workroom>/.env`** (Windows: `py`). Or, for
   visit-client alone: download it from the
   [newest release](https://github.com/sarmiena/Basedverse/releases/latest) (Linux, macOS, Windows), or
   build it (step 1 of the guide says how).
3. **Follow [visit/INTEGRATING.md](visit/INTEGRATING.md)**, or hand it to your coding agent.

## Running the lobby

One small server for everyone: [lobby/README.md](lobby/README.md) says what to rent and which ports to
open, then `bin/deploy-lobby user@server` sets it up, and later updates it.

## Releasing visit-client

Set the new `version` in `visit/client/Cargo.toml` (and `VERSION` in `visit/client/web/visit.js`), and add
its entry at the top of [CHANGELOG.md](CHANGELOG.md): what changed, and **what an integration does**, step
by step, for the agent upgrading a workroom. Commit, then tag that commit `v<version>` and push the tag
(`git tag v0.3.0 && git push origin v0.3.0`). [The release workflow](.github/workflows/release.yml)
builds and tests visit-client on Linux (x86_64, ARM64), macOS (Apple silicon, Intel) and Windows (x86_64),
and publishes the files, with their checksums, as that tag's release, its notes the changelog's entry (a
tag the changelog has no entry for is not released).

## Tests

| | |
|---|---|
| `python3 lobby/server/test_lobby.py`, `python3 lobby/server/test_lobby2.py` | the lobby, versions 1 and 2 (they need `websockets`: `lobby/server/requirements.txt`) |
| `visit/client/cargo test` | visit-client's unit tests, in Docker |
| `visit/client/tests/run-e2e.sh` | the lobby, two visit-clients and two stand-in pages, in Docker |
| `visit/client/tests/run-browser.sh` | visit.js in two headless Chromes on this machine (it needs `google-chrome`) |

## License

MIT: see [LICENSE](LICENSE).
