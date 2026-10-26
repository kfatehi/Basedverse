# Visit — walk around each other's workrooms

**Status: built and tested on one machine (visit-client, visit.js, the lobby's version 3). Visit 0.4 has gone between two machines over the internet; 0.5 not yet.**

Everyone builds their own workroom, with three.js, and Visit lets you walk around each other's with WASD
and the mouse. The host sends its room's scene, as data; your browser draws it, with the host's very three.js
release, as quickly as your own room, and walks you in it at once while the host decides where you may go.
What everyone agrees on is a thin interface: a host's scene and two hooks (`spawn`, `move`), and two shared
pieces everyone drops in unchanged.

| doc | for |
|---|---|
| [INTEGRATING.md](INTEGRATING.md) | adding Visit to a workroom. Written for the coding agent doing it: hand it this file and say "integrate this into my workroom". |
| [SPEC.md](SPEC.md) | the contract: the local client, the page connection, the lobby (`basedverse-lobby/3`), the link between machines, scenes and input, security, limits, errors, versions. For whoever builds or changes the shared pieces. |

## Giving it to someone

Visit travels with the rest of basedverse: [../README.md](../README.md) says how to add it to a workroom
(get the repository, get visit-client, hand the guide to a coding agent). The settings a workroom gives
visit-client are in [../.env.example](../.env.example).

```
visit/
  README.md          this
  INTEGRATING.md     the guide to hand an agent
  SPEC.md            the contract behind it
  client/            visit-client (Rust) and visit.js, which it serves
    build            a static binary into client/bin/ (Linux, in Docker)
    cargo            cargo in Docker, for working on visit-client
    web/visit.js     the library
    tests/           the end-to-end and browser tests (with ../lobby/'s server), perf/ (visits through
                     simulated networks), and room.html, a small workroom to try it with
```

## The pieces

- **visit-client** (Rust): the local client. One per workroom per machine, started by the workroom's
  launcher. It owns all networking: the lobby session, the links to other visit-clients (QUIC through
  [iroh](https://iroh.computer): direct when the two machines can reach each other, through a relay when
  they cannot), and the visits. It survives page reloads, listens on 127.0.0.1 only, and takes a token.
- **visit.js**: the library in the workroom's page, served by its own visit-client (so the two always
  match). It talks only to that visit-client: it sends the room's scene to its visitors and moves them with the
  host hooks, draws the scene of the room it visits (with that room's three.js, checked against its hash), and
  captures the visitor's input. Optionally, a ready-made lobby panel and stage.
- **The lobby** ([../lobby/](../lobby/)): presence, knocks, and introducing visit-clients to each other.
  It speaks version 1 (browser sims streaming their own view to a group, as today) and version 2
  (visit-clients) side by side.
- **The relay**: for links that cannot go direct; it cannot read what it carries. Ours will run beside the
  lobby; until it does, iroh's public relays stand in.

## Where it stands

- [x] The spec, and the guide for integrators.
- [x] visit-client, tested end to end with the real lobby and two clients (`client/tests/run-e2e.sh`).
- [x] visit.js, tested in two real browsers: knocking, walking, reloads (`client/tests/run-browser.sh`).
- [x] The lobby's version 2 (`../lobby/server/`, `test_lobby2.py`), live (`../bin/deploy-lobby`).
- [x] A first workroom running it.
- [ ] A relay of our own beside the lobby. Until there is one, links that cannot go direct use iroh's public
      relays (still encrypted end to end).
- [x] A visit between two machines over the internet.
- [x] A second workroom.
