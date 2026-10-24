# Visit — walk around each other's workrooms

**Status: draft spec. Not built yet.**

Everyone builds their own workroom, in their own engine, and Visit lets you walk around each other's
with WASD and the mouse. Your inputs go to the host's sim; the host's sim renders its room from where you
stand and streams it back as video. Nothing about a room is shared but that, so the only thing everyone
agrees on is a thin interface: three hooks a host implements (`spawn`, `move`, `render`), and two shared
pieces everyone drops in unchanged.

| doc | for |
|---|---|
| [INTEGRATING.md](INTEGRATING.md) | adding Visit to a workroom. Written for the coding agent doing it: hand it this file and say "integrate this into my workroom". |
| [SPEC.md](SPEC.md) | the contract: the local client, the page connection, the lobby (`basedverse-lobby/2`), the link between machines, video and input, security, limits, errors, versions. For whoever builds or changes the shared pieces. |

## The pieces

- **visit-client** (Rust): the local client. One per workroom per machine, started by the workroom's
  launcher. It owns all networking: the lobby session, the links to other visit-clients (QUIC through
  [iroh](https://iroh.computer): direct when the two machines can reach each other, through a relay when
  they cannot), and the visits. It survives page reloads, listens on 127.0.0.1 only, and takes a token.
- **visit.js**: the library in the workroom's page, served by its own visit-client (so the two always
  match). It talks only to that visit-client: it calls the host hooks, encodes and decodes the video
  (WebCodecs), and captures the visitor's input. Optionally, a ready-made lobby panel.
- **The lobby** ([../lobby/](../lobby/)): presence, knocks, and introducing visit-clients to each other.
  It speaks version 1 (browser sims streaming their own view to a group, as today) and version 2
  (visit-clients) side by side.
- **The relay**: for links that cannot go direct; it runs beside the lobby and cannot read what it carries.

## Plan

1. This spec. ← here
2. visit-client: the page connection and its token, the lobby session (version 2, with resume), the link
   between two visit-clients, visits that survive reloads.
3. The lobby's version 2, and the relay beside it.
4. visit.js: the hooks, video through WebCodecs, input, the panel.
5. A first workroom: its launcher starts visit-client, its server hands the page its port and token,
   its page implements the hooks. Tested on one machine with two visit-clients and
   two rooms, as INTEGRATING.md step 8 describes.
6. Hand INTEGRATING.md to the next workroom.
