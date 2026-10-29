# Visit in this workroom

How this workroom uses basedverse's Visit, and every way it differs from Visit's vanilla experience (basedverse's
`visit/INTEGRATING.md`, "The vanilla experience"). An upgrade reads this first and keeps what it says.

**Integrated at:** Visit <version> (<date>)

**How it runs:** `visit` on the machine, started by <the launcher>; the room's server <on the machine beside it | in a
container on the host's network, bound to 127.0.0.1>; its data in `VISIT_DATA_DIR` (<the path>).

## Features

| feature | state | how, in this room |
|---|---|---|
| connect, host, visit | vanilla | |
| panel, stage | vanilla | |
| links | vanilla | |
| world | vanilla | |
| map | vanilla | |
| where friends put you | vanilla | |
| avatars | vanilla | |
| interactions | vanilla | (which ones: cosmetic only, each listed; any other only as the user agreed to it, by name) |
| voice | vanilla | |
| 🔊 over who is speaking | vanilla | |
| phone | vanilla | (where it stands) |
| chat bubbles | vanilla | |
| chat window (say, whisper, a linked room, the lobby) | vanilla | |
| landscapes, offline plots | vanilla | (what is marked `visitStatic`, and how) |
| mounts | vanilla | (what they are is the room's: its possessions; riders drawn at their pose's height) |
| physics (falling, flying, riders) | own | (the room's `spawn` and `move`: Visit has none; say what they do) |
| the engine (the room's page inside `visit`, the person's page through the server's relay) | vanilla | (the server page's address, `ENGINE_ROOM_URL`) |

State is one of:
- **vanilla**: Visit's default. This includes the room's own choices where Visit has none: what its landscape is,
  where the phone stands, which interactions it has, its avatar. Those go in "how", not under Deviations.
- **own**: the room replaces or turns off a Visit default (its own phone, `speaking: false`, its own panel). See
  Deviations.
- **off**: not used.

## Sign-in

- Offered <date>; the user: "<their words>" (yes / no / later).
- Public routes (work signed out): none (or each, as the user named it, with the date and their words).
- Where the server listens: 127.0.0.1 (or HTTPS / WireGuard / Tailscale, and how).

## Deviations from vanilla

Only what replaces or turns off a Visit default, each as the user asked for it. An upgrade re-applies it; if a
release changes it, ask the user.

- <date>: <what> (the user: "<their words>"). Done by: <how, e.g. `model: false` and our own phone in room.html>.

## Open requests for basedverse

What the user wants that Visit cannot do yet (it needs a change in Visit, not in this room).

- <date>: <what> (the user: "<their words>").

## History

- <date>: <from> → <to>: <what was done>. (An upgrade to 2.0: what was imported with `visit import`, the state file
  kept, and what is kept for going back: the tag, the old database's volume.)
