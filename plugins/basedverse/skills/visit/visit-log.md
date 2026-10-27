# Visit in this workroom

How this workroom uses basedverse's Visit, and every way it differs from Visit's vanilla experience (basedverse's
`visit/INTEGRATING.md`, "The vanilla experience"). An upgrade reads this first and keeps what it says.

**Integrated at:** Visit <version> (<date>)

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
| landscapes, offline plots | vanilla | (what is marked `visitStatic`, and how) |
| flying | vanilla | (vanilla: none, arrivals in the air float down; `fly` if visitors may fly here) |

State is one of:
- **vanilla**: Visit's default. This includes the room's own choices where Visit has none: what its landscape is,
  where the phone stands, which interactions it has, its avatar. Those go in "how", not under Deviations.
- **own**: the room replaces or turns off a Visit default (its own phone, `speaking: false`, its own panel). See
  Deviations.
- **off**: not used.

## Deviations from vanilla

Only what replaces or turns off a Visit default, each as the user asked for it. An upgrade re-applies it; if a
release changes it, ask the user.

- <date>: <what> (the user: "<their words>"). Done by: <how, e.g. `model: false` and our own phone in room.html>.

## Open requests for basedverse

What the user wants that Visit cannot do yet (it needs a change in Visit, not in this room).

- <date>: <what> (the user: "<their words>").

## History

- <date>: <from> → <to>: <what was done>.
