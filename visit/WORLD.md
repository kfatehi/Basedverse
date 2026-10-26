# The world: plots instead of knocks

**Status: built (Visit 0.7.0, the `world` branch), tested on one machine** (the end-to-end test, and two real
browsers on different three.js releases). What it settles is in [SPEC.md](SPEC.md): sections 2, 3 (points 9 to
12), 5, 6.4, 7.2, 8.1 and **8.4**; [INTEGRATING.md](INTEGRATING.md) has the optional step for a workroom. This
file keeps why it is the way it is, and what is still to come.

Before, a visit was a context switch: you knocked, were let in, and were in someone else's room until you went
back to yours. Now **you are always yourself, in your own room, and your friends' rooms sit round it as plots of
land you see and walk onto**, without knocking.

What we agreed on, and what we did not need to:

- **Every room stays its owner's.** Nobody's room becomes part of a shared codebase: each is its own three.js
  scene, made however its owner likes. What is shared is where plots sit, never what is on them.
- **A friend walks in without knocking.** You keep a guest list (a star by an office, in the panel) and a door:
  open, your guests come in at once, and see your plot from theirs; shut, everyone knocks, and nobody sees it.
- **Nobody has to agree on a map.** Where your friends' plots sit round yours is your choice (by yourself: a
  ring round yours; or where you put them), and theirs is theirs. Walking from one to another can look odd to
  someone whose layout differs: you leave by one wall and come in by another. That is fine.
- **Two friends who care agree an edge**: "my east side to your west side". Then it is the same for both, and
  walking across it is seamless; with their door shut, you still see where they are, as an outline.

## How it fits together

1. **Keys.** An office's lasting identity is its link endpoint's public key, kept in its state file. Names are
   first come, first served; keys cannot be taken, because every link proves them.
2. **Watching.** With its world on, a visit-client watches each guest's plot: a visit that sees the room from
   outside, sending nothing. The host's visit-client admits only its guests, through its open door, and never
   asks its page. Several at once, while being in at most one room.
3. **Drawing.** Your page draws your room, then each plot where your layout puts it, with *your* three.js (a
   neighbour's scene is data, read by your release; lights across r155 scaled to keep their look), each clipped
   to its rectangle and lit by its own lights, into one depth buffer.
4. **Walking.** At home your page walks you. Step onto a plot and its host has you, as a visitor (its `spawn`
   hears where you stepped in, its `move` and walls decide where you go, its scene draws you for others); your
   page draws you as yourself. Walk off it and you are home again.
5. **Edges** are proposed and agreed over the link the two already have, each keeping its own terms.

## Still to come

- **A friend's friends.** A world holds your own friends' plots. Drawing a plot beyond the next one (Cliff, who
  is your friend's friend) would need your friend to share its edges; nothing does yet.
- **The host's own user.** In a world your page draws you; a host's own user, at home in its room, is not drawn
  for its visitors unless its room does so itself.
- **Moving plots about.** `v.place` puts a plot where you say; there is no ready-made UI for dragging one.
- **Between machines.** Tested on one machine with real links; not yet between two over the internet.
