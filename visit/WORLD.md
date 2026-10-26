# The world: plots instead of knocks (a design, being built)

**Status: a plan, being built** on the `world` branch: step 1 is built (0.7.0); the rest is how we mean to go on. When a step
is built, what it settles moves into [SPEC.md](SPEC.md), and this file keeps only what is still to come.

Today a visit is a context switch: you knock, you are let in, and you are in someone else's room, until you go
back to yours. What we want instead: **you are always yourself, in your own room, and your friends' rooms sit
around it as plots of land you can see and walk onto**, without knocking.

Two things we agreed on, and one we did not need to:

- **Every room stays its owner's.** Nobody's room becomes part of a shared codebase: each is its own three.js
  scene, made however its owner likes, as today. What is shared is where plots sit, never what is on them.
- **A friend walks in without knocking.** You keep a guest list, and an open or closed door: an open door lets
  your guests in at once. Everyone else knocks, as now.
- **Nobody has to agree on a map.** Where your friends' plots sit around yours is your choice, and theirs is
  theirs. Walking from one plot to another can look odd to someone whose layout differs (you leave one wall and
  come in by another): that is fine. Two friends who care can agree a shared edge (step 5), and then it is the
  same for both.

## Words

- **Key**: an office's lasting identity, its link endpoint's public key. Names are first come, first served
  and change; a key cannot be taken, because the link makes whoever dials prove they hold it.
- **Guest**: a key on your guest list. **Door**: open (your guests come in without knocking) or closed
  (everyone knocks).
- **Plot**: the piece of ground a room's scene stands on: a rectangle on its floor, in its own units.
- **Layout**: where each plot sits in your world, by key. Yours, only you see it.
- **Watching**: seeing a plot without being in it: its scene comes to you, nothing goes from you.
- **Being in** a plot: what a visit is today: its owner has you, moves you by its own walls, draws you for
  everyone else.

## The steps

### 1. Keys, guests, the door (built: 0.7.0)

An office has a lasting **key** (kept in its state file), the lobby lists keys, and a host's visit-client lets
a **guest** in at once while its **door** is open; a lobby that lies about whose knock it is gets nobody in.
Now in [SPEC.md](SPEC.md): sections 2, 3 (points 9 and 10), 4.1, 5, 6.3, 6.4 and 9.

### 2. Watching, and several at once

- A knock may say `watch: true`: let me see your plot. Only guests may watch, and only through an open door:
  the visit-client admits them itself, and refuses a watch from anyone else (no page to ask: there is nothing
  to decide). Watching never shows you to the host's room, and does not count toward `max_visitors` (a watch
  costs the host what a visitor does in bandwidth; a separate limit, 8).
- An office may watch several plots at once while being in at most one. The lobby keeps `visiting` for the
  one you are in, and watches apart; the link is the same as a visit's, with nothing coming from the watcher
  until it goes in.

### 3. Your world: plots drawn around your room

- A host says what its plot is: `visit.host({ ..., plot: { center: [x, z], size: [w, d] }, unit })` (the
  rectangle of its floor, in its scene's units, and how many metres a unit is).
- Your page draws your own room, then each watched plot where your layout puts it, with your three.js and
  your renderer: each plot is a scene of its own (its own lights light only it), drawn clipped to its rectangle,
  into the same depth buffer (so what is nearer hides what is behind, across plots). Only your sky and fog.
  This means reading a neighbour's scene with your three.js release rather than theirs: the scene format carries
  across releases, lights' strength changed in r155 (scaled across), and anything that does not carry is a
  neighbour's plot looking a little off in your world, never yours.
- **Layout**: yours at the origin; each other plot at `{ x, z, turn }` (quarter turns), kept by your
  visit-client, by key. A plot you have not placed goes in a ring around yours, by itself. `v.place(key, at)`.

### 4. Walking across

- You walk in your own world with your page's own walking, always yourself. Step onto a neighbour's plot and you
  go in: the watch becomes a visit (`enter`, with where you stepped on, in the plot's own terms), and from then
  the host has you, as today: its `move`, its walls; you go on seeing everything around you as before.
- When the host has you off its plot, you are out: you walk on in your own world from there.
- A host's `spawn` hears where you stepped in, and may put you elsewhere (a room with a wall where you came).

### 5. Agreed edges

- Two friends can agree that a side of each plot touches: "my east side to your west side, this far along".
  Either proposes; once both accept, each layout places the other there, and walking across that edge is
  seamless for the two of them. Each keeps the agreement (by key) in its state file.
- An agreed neighbour whose door is closed to you still shows where it is (its outline, its name), not what
  is on it.

## Versions

Steps 1 and 2 only add to the protocols, so offices that have them still meet older ones in the same lobby.
Steps 3 and 4 add to the library and the link (`enter`, `exit`). We will bump the protocol names only if
something older truly cannot follow.
