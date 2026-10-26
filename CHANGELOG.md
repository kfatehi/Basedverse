# Changelog

Every release of basedverse, newest first. It is written for whoever keeps a workroom's integration of
Visit working, person or coding agent: each release says what changed, and **what an integration does
about it**. To upgrade, read from the version you have (`visit-client --version`) up to the newest, and do
each release's steps in order ([visit/INTEGRATING.md](visit/INTEGRATING.md), "Upgrading").

A release that changes a protocol's name (`basedverse-lobby/2`, `basedverse-visit-local/1`,
`basedverse-visit/1`) says so at its top: then every workroom upgrades, and the lobby with them. Additions
keep the names, so offices on different versions still meet and visit each other.

## v0.9.0 — unreleased (the `v0.9` branch)

**A map of your world, avatars, interactions by type, and a huddle.**

- **The map** (the panel's **Map**, `Visit.map`): your world from above. Drag a friend's room where you want it,
  turn it, or type where its middle goes; it snaps to half units and flush against what is near. Flush against a
  side of yours, it offers to propose an edge. Kept by visit-client, across reloads and restarts. A link you put
  in your world (0.8) now stays there across a reload too.
- **Avatars** ([visit/SPEC.md](visit/SPEC.md) 8.6): your page can give Visit your own body (`v.avatar`), and a
  room you visit can show you as it. Whose look visitors have in your room is your user's choice: their own
  avatars, or your models, by default (the panel's "visitors look like") and per friend ("their look" / "your
  model" by each visitor). A body goes only to a room that asks for it, is read as data (as a scene is), and walks
  and stands with its own `walk` and `idle` clips.
- **Interactions** (SPEC 8.3): what a visitor's click may do, by type (`v.interactions`), on things marked
  `userData.visitPoint = "<type>"`; a type not listed does nothing, and is not shown hot. Each is cosmetic or
  not, and one that is not is refused unless the room says its user agreed to it (`agreed: true`). The guide
  says, for whoever integrates: **don't implement any interactions other than cosmetic ones unless specifically
  agreed upon by the user.**
- **The huddle** (SPEC 8.7, the panel's **Join huddle**): voice with everyone you are linked to (a visit, a link,
  a plot in your world or yours in theirs) who joins too. Your microphone, echo cancelled, Opus at about 24 kbps,
  straight over the link between your visit-clients (no server in between); you hear an office only while both of
  you are in. **Mute**, **Leave**; the panel shows who is in and who is speaking. Headphones are best.
- A link with someone who is your guest goes into your world, not the corner (#5, kfatehi): their plot was there
  already, as a guest's.

Protocol names are unchanged: an older Visit never asks for an avatar nor sends one, and an older visitor sees
`userData.visitPoint` types as plain marks (its host decides each point, as before).

### What changed

- visit-client: page messages `link_where`, `avatar_clear`, `avatar_want`, `avatars`, `avatar_use`, `huddle`; to
  the page `avatars` (also in `ready`), `avatar`, `huddle`, `huddle_peer`, and `where` and `huddle` in
  `visit_started`; page frame flags for its own avatar (5.4, bit 2) and voice (bit 3, both ways); link control
  messages `avatar_want` and `huddle`, a stream of the visitor's avatar (7.4, kind 2), and voice datagrams. The
  state file keeps whose look visitors have (`avatars`).
- visit.js: `v.interactions`, the `interaction` event; `v.avatar`, `v.useAvatars`, `v.useAvatar`, `v.avatarUse`,
  `v.avatars`, `avatar` on `v.visitors`; `Visit.map`; `v.huddle`, `v.mute`, `v.huddling`, `v.muted`,
  `v.huddlers`. The panel: Map, visitors look like, their look / your model, Join huddle / Mute / Leave. The
  visitor's crosshair shows an interaction's label.
- The test room: an interaction (`spin`), a box marked with a type it does not take, its own avatar, visitors
  drawn as theirs. The tests: the browser test's interactions, map, avatars, huddle (two Chromes' fake
  microphones) and reloads; the end-to-end test's avatars and huddle. The browser test's Chromes have a fake
  microphone (`run-browser.sh`).
- [visit/SPEC.md](visit/SPEC.md): sections 4.1, 5.2 to 5.4, 7.2, 7.4, 8.3, 8.5, 8.6 and 8.7 (new), 9, 13.
  [visit/INTEGRATING.md](visit/INTEGRATING.md): step 5 (interactions, avatars, the huddle), steps 6, 7 and 9
  (the map), the checklist.

### What an integration does

1. Get visit-client 0.9.0. The lobby is unchanged: nothing to deploy.
2. If your room took points (`visit.on("point")` with an allow list): move them to `visit.interactions`, one
   type each, and mark what may be clicked `userData.visitPoint = "<type>"` (INTEGRATING.md step 5). Cosmetic
   ones only, unless your user agreed to another, by name. Points still reach you raw meanwhile.
3. Draw a visitor's `avatar` when its entry has one, your model otherwise (step 5). Optional: give your own,
   `visit.avatar(body)`.
4. If your page has its own lobby UI (not `Visit.panel`), offer the huddle: `visit.huddle(true)` from a click.
   A Content-Security-Policy needs `blob:` for worklets as for workers.
5. Run step 8 again, and step 9's check (the Map now).

## v0.8.0 — 2026-10-26

**Links: a room you link with shows in a corner first** ([visit/SPEC.md](visit/SPEC.md) 8.5). The panel's
**Knock** is now **Link**: once the other office says yes, its room shows in your stage's corner, seen from
outside (from above it, going round, or from where its host's `preview` says), and you choose: **Go there**
(its room fills the window, as a visit; **Back to my room** puts it in the corner again), **Put in my world**
(with a world: their room becomes a plot round yours while the link lasts), or **Unlink**. Saying yes, the
other office may tick **★ always**, making you a guest from then on. Its panel lists who is linked to it, seeing
its room from outside, with **Unlink**. A link is a watch (8.4) its host let in itself: the door shutting, the
guest list and the world going off do not end it. One link is in the corner at a time; a newer one, or a visit,
takes the corner, and the one it moves waits in the panel (**Show**). Protocol names are unchanged: to an
office on an older Visit (or through an older lobby) a link is a knock, and you walk straight in, as before.

### What changed

- The lobby: hello's `links`, each office's `links` in `lobby`; a knock with `link: true` (to a door that
  takes them): answered as a knock (busy stops it, 6 a minute), let in as a watch counted as one (`full` at
  its door's `max_watchers`, `too_many` at the knocker's `max_watching`, `already_watching`), with `link` on its
  `knock`, `knock_sent`, `answered` and `visit`.
- visit-client: hello says `links`; a page's `knock` keeps `link`; `visit_started` says `link`. A link is not
  ended by `door` shut, `guest_remove` or `world` off. `enter` without a `pose` goes in where the host puts
  newcomers (control `{"enter": null}`; the host's page hears `enter` without `pose`).
- visit.js: `v.link(officeId, message)`, `v.stepIn(id)`, `v.stepOut(id)`, `v.toWorld(id)`, `v.unlink(id)`,
  `v.watching(officeId)`, `v.links`; `link` on `v.knocks`, `v.knocking`, `v.visiting` (with `inside`),
  `v.visitors`, `v.watchers`, `v.offices`, and the `knock`, `answered` and `visit_started` events; `host({
  preview })`. `v.knock` is as before: let in, you are in the room. The panel and the stage do the above.
- The test room's own keys wait while `v.viewFocused`. The tests: the lobby's `t_link`, the end-to-end test's
  links, the browser test's links (A sees B's room in its corner, goes there, comes back, waits aside while
  visiting, puts it in its world, unlinks).
- [visit/SPEC.md](visit/SPEC.md): sections 2, 5.2, 5.3, 6.2 to 6.4, 7.2, 8.5 (new), 9, 13.
  [visit/INTEGRATING.md](visit/INTEGRATING.md): steps 5 (`preview`), 6, 7 (linking), 8, the checklist.

### What an integration does

1. **The lobby first** (whoever runs it): `bin/deploy-lobby`. With an older lobby a link is a knock.
2. Get visit-client 0.8.0.
3. With `Visit.panel` and `Visit.stage`, nothing else: they link, show the corner, and list who is linked to you.
   With a UI of your own (INTEGRATING.md steps 6 and 7): offer `visit.link` to offices whose `links` is true
   (`visit.knock` to the others); when `visit.visiting.link`, show its room small until `visit.visiting.inside`,
   with `stepIn`, `stepOut`, `toWorld` (if you have a world) and `unlink`; show `visit.watchers` with `link`,
   with a way to end each (`visit.kick`). Your own keys still wait while `visit.viewFocused`.
4. Optional: `preview` in `visit.host`, where a link sees your room from.
5. Run step 8 again (it links now), and step 9's check.

## v0.7.2 — 2026-10-26

**In a friend's plot, up and down with their room** (#4, kfatehi). A room with floors (stairs, a lift) moves a
visitor's `pose.y` in its `move`; in a world, `world.frame`'s `y` now follows it, from where your user stepped on,
so your page draws them upstairs when that room has them there. Before, they stayed at street level in your
picture, whatever floor the room had them on. However they leave the plot (walking off, its door shut, its page
gone), they are back at the height they came with. A flat room never moves `pose.y`: nothing changes for it.
Only visit.js changes: a visitor on 0.7.1 still meets a 0.7.2 room, and stays at street level in it, as before.

### What an integration does

1. Get visit-client 0.7.2 (`bin/setup` again, download; or this release).
2. Draw your user at the `y` that `world.frame` returns (INTEGRATING.md step 9). If your room has floors, let
   `move` set a visitor's `pose.y`, and they go up with it.

## v0.7.1 — 2026-10-26

**The world is a step of the guide, not an option.** [visit/INTEGRATING.md](visit/INTEGRATING.md)'s world
section, "Optional — your world" in 0.7.0, is now **step 9** ("Your world: friends' plots round your room"),
after the test on one machine, and on the checklist: every workroom does it. Without it a room still knocks
and visits, but its user sees no friends' rooms round theirs, and a friend who walks onto its plot from their
world may have no way back out. The code is 0.7.0's; only its version number changes.

### What an integration does

1. Get visit-client 0.7.1 (`bin/setup` again, download; or this release). Nothing else in it changes.
2. If you have not yet, do INTEGRATING.md step 9, and run its check.

## v0.7.0 — 2026-10-26

**Worlds: your friends' rooms round yours, walked onto without knocking** ([visit/WORLD.md](visit/WORLD.md),
SPEC 8.4). You stay in your own room, as yourself; each friend's room sits round it as a plot of land your page
draws, with its own lights, and you walk onto it: its owner's room has you (its `spawn`, `move`, walls) until
you walk off, home again. Where friends' plots sit is each office's own choice (by itself, a ring round yours);
two friends can agree an edge ("my east side to your west"), the same for both, walked across seamlessly. A
friend is a **guest** both ways: an office now has a lasting **key** (its link endpoint's, kept in its state
file), a guest list of keys and a **door**; through an open door a guest's knock is let in at once, and a guest
sees your plot. Protocol names are unchanged: a 0.7 office and a 0.6 one still meet and visit (a 0.6 office is
never watched: its lobby entry does not say `world`).

**Lighter scene edits** (#3, kfatehi): an object added to a room's scene no longer carries the geometries and
materials its visitors already have, only their uuids. A room whose figures share one rig used to send the
whole rig for each figure that appeared (2.9 MB of JSON for one figure in kfatehi's room); in a test with a 5.3 MB
figure, each one after the first now costs about 1.4 KB. A visitor's page that lacks one asks for the whole scene. A 0.7 visitor's visit-client
says its page reads such adds (`shared_adds`); while any visitor on 0.6 or older is in a room, its adds go whole,
as before.

### What changed

- visit-client: the state file keeps the office's secret key (written readable by its owner only), its door,
  guests, layout and edges, as well as whether it is away. Page messages `door`, `guest_add`, `guest_remove`,
  `world`, `enter`, `exit`, `place`, `unplace`, `edge_propose`, `edge_accept`, `edge_decline`, `edge_remove`;
  and to the page `guests`, `layout`, `edges`, `edge_proposed`, `edge_declined`, `enter` / `exit` (host side),
  `enter_refused`. `ready` has `key`, `door`, `guests`, `layout`, `edges`; `visit_started` has the other's
  `peer.key` (as the link proved it), `guest`, and `watch` / `inside`. With the world on, it watches its guests'
  plots by itself; a knock to watch never reaches a page. Shutting the door, or taking a guest off, ends their
  watches. Link control messages `enter`, `exit`, `enter_refused`, `edge`, `edge_ok`, `edge_no`, `edge_off`,
  `shared_adds` (passed to the host's page as `shared_adds`, and in `visit_started`).
- visit.js: `v.world({ scene, renderer })` with `frame` and `render`; `host({ plot, unit })`;
  `spawn(visitor, { at })`; `v.key`, `v.door`, `v.guests`, `v.layout`, `v.edges`, `v.edgeProposals`,
  `v.watchers`; `setDoor`, `addGuest`, `removeGuest`, `place`, `unplace`, `proposeEdge`, `acceptEdge`,
  `declineEdge`, `removeEdge`. A neighbour's scene is read with your three.js release. Deltas to a watcher not
  in the room are version 2 (no pose of its). The panel: "your door", a star by each office to make it a guest,
  and edges proposed to you (Agree / No). Scene edits' `add` names what every visitor has by uuid only (8.3), and
  a plot you watch frees what its room no longer uses, as a room you visit does.
- The lobby: each office's `key`, `watchers` and `world` in `lobby`; `from.key` on a knock; knocks to watch
  (`watch: true`: counted apart, at most 8 watchers of a plot and 8 plots watched, 30 a minute, not stopped by
  busy, never moving the watcher out of the room it is in); hello's `world`.
- The test room: `?world=1` (doorways, you as a block walking with WASD) and `?three=<r>`.
- [visit/SPEC.md](visit/SPEC.md): sections 2, 3 (points 9 to 12), 4.1, 5, 6.2 to 6.6, 7.2, 8.1, 8.3, 8.4 (new), 9,
  10, 11, 13. [visit/INTEGRATING.md](visit/INTEGRATING.md): step 9 (new: your world), step 7, the checklist.

### What an integration does

1. **The lobby first** (whoever runs it): `bin/deploy-lobby`, for keys and watches. With an older lobby
   everything works as in 0.6: guests just knock, and there are no worlds.
2. Get visit-client 0.7.0.
3. Make sure your launcher gives visit-client a `VISIT_STATE_FILE` (`bin/setup` does): without one, the office's
   key is new every run, and its friends no longer know it. The file now holds a secret key: outside your
   repository, never copied anywhere.
4. Add your world: INTEGRATING.md step 9. Say your `plot` and `unit`, let visitors walk off it, give `spawn`
   its `at`, give your user a body, and draw with `visit.world`'s `frame` and `render`. Until you do, a 0.6 page
   still knocks and visits as before (with `Visit.panel` your user gets the door and the stars), but sees no
   friends' rooms round its own.

## v0.6.0 — 2026-10-26

**Visitors can point, and objects' userData stays home.** A visitor looking around has a crosshair, and a
click there **points**: its visit-client sends only where it looked (yaw and pitch), and the host's page hears
`point`, a ray from where the host has that visitor toward where it looked, and decides what that does
(SPEC 8.3). The host chooses what a guest may reach; INTEGRATING.md step 5 says how (an allow list whose
default is no). And the scene a host sends no longer carries its objects' `userData`: three.js's `toJSON`
put it all in (a sim's state about its figures, references to other objects, sometimes whole copies of
them), and visitors now get only what Visit reads, `visitor` and the new `visitPoint`. Protocol names are
unchanged: a 0.6 office and a 0.5 one still meet (a 0.5 host ignores points; a 0.5 visitor sends none).

### What changed

- visit.js: `v.on("point", e)` while hosting: `{ id, visitor, from, dir, yaw, pitch }`. `move` is told whose
  pose it moves: `move(pose, input, dt, { id, visitor })` (a visitor sat down somewhere, say, stays put). The visitor's view
  shows a crosshair while the pointer is locked to it, and a click points (one every 200 ms at most); the
  crosshair shows hot over what the host marked `userData.visitPoint`. A scene's JSON keeps, of `userData`,
  only `visitor` and `visitPoint` (strings, numbers or booleans); the host's objects keep theirs.
- visit-client: the page message `point` (visitor side), the link's control message `{"point": {yaw,
  pitch}}`, and the page message `point` (host side): clamped, at most 5 a second from a visitor.
- [visit/SPEC.md](visit/SPEC.md): section 3 rule 7, 5.2, 5.3, 7.2, 8.1 (userData), 8.3 (new: points), 9, 10.
  [visit/INTEGRATING.md](visit/INTEGRATING.md): step 5 (`root`, Points), step 6, the checklist, "Don't".
- Tests: e2e checks points pass clamped and bare, and five a second at most; the browser test checks a
  visitor's copy has no host userData, the crosshair is hot over a marked object, and a point's ray hits it.
  The e2e reload check no longer depends on the lobby's message coming after the link's.

### What an integration does

1. Get visit-client 0.6.0 (`bin/setup` again, download; or this release). The lobby is unchanged: nothing to
   deploy.
2. If your page relied on `userData` reaching visitors (only Visit's visitor's page reads a scene, so nothing
   should): keep that data elsewhere. `userData.visitor` on visitors' bodies still goes.
3. To let visitors point (optional): `visit.on("point", ...)`, through an allow list of what a guest may do,
   with a few a second per visitor at most; mark what is on it `userData.visitPoint = true`
   (INTEGRATING.md step 5, Points). Without a handler, points do nothing.
4. Run step 8 again: a visitor's crosshair shows while it looks around, and clicks reach your handler.

## v0.5.0 — 2026-10-25

**Every room is three.js, and video is gone.** A room takes part with its scene: the host sends it, and
every visitor's browser draws it, as 0.4 did for three.js rooms. A room that is not three.js can no longer
take part, visiting included: an office is in the lobby to be visited, and can knock, only once its page
hosts its scene. Visit loses its video encoding, decoding, codecs and bitrate control: less code, and a
smaller attack surface (no browser decodes video from a stranger). **Protocol names changed**
(`basedverse-visit-local/2`, `basedverse-lobby/3`, `basedverse-visit/2`): every workroom upgrades, and the
lobby too. A 0.5 office and an older one are in separate lobbies (the lobby speaks both), and never meet.

Measured (`tests/perf/run-perf.sh`): a visitor walks and looks at once, drawn by its own browser; what the
network shapes is the host's answer (where the host has the visitor, and where its room's moving things are):

| network | the host's answer, median / worst 5% | bandwidth (50 moving things) |
|---|---|---|
| no delay | 3 / 8 ms | 0.41 Mbit/s |
| down the street (8 ms round trip) | 12 / 17 ms | |
| across the country (70 ms) | 75 / 80 ms | |
| bad Wi-Fi (30 ms, jitter, 1.5% loss) | 35 / 45 ms | |
| relayed, capped at 5 Mbit/s (80 ms) | 88 / 93 ms (video: 96 / 141 ms, stalls) | |
| capped at 2 Mbit/s (22 ms) | 32 / 37 ms (video: 41 / 55 ms) | |
| six visitors on one host (8 ms) | 12 / 17 ms | |

In real (headless, processor-drawn) browsers: input to screen 14 ms median, 21–24 ms worst 5%, 57–58 frames
a second; the host spends 0.4 ms per update on its scene, 30 a second.

### What changed

- visit.js: `v.host` takes `scene` (required), `spawn`, `move`, `fov` and `walk`; `render` and `fps` are
  gone, and `Visit.connect`'s `scenes`; a page sends `host` when it registers, and its office is not in the
  lobby to be visited, nor knocks, until it has. `v.stats` loses `mode`. A visitor's page that has no scene 3 s
  into a visit asks for it again.
- visit-client: the page message `host`; `knock` refused `not_hosting` before it; the office's link published
  only while a page hosts (withdrawn when it goes); no `decoders`, `viewport`, `video_config`, `bitrate`,
  `scenes`, frame meta or `limits`; links carry only a scene's deltas and edits; a visitor's request for the
  whole scene sooner than every 2 s waits, and goes (it was dropped).
- The lobby: version 3 (version 2 with a link that can be withdrawn), its own lobby beside versions 1 and 2.
- [visit/SPEC.md](visit/SPEC.md) throughout (sections 7 and 8 rewritten); [visit/INTEGRATING.md](visit/INTEGRATING.md)
  "Before you start", step 5 (rewritten), step 6, the checklist, troubleshooting.
- `bin/setup`: piped or redirected on Windows, it no longer stops at a ⚠ or ✓ the console cannot write (#1).

### What an integration does

1. **If your room is not made with three.js (r125 to r186), stop**: from 0.5 it cannot take part. Tell your
   user (staying on 0.4 keeps it working, by video, with other 0.4 rooms only).
2. **The lobby first** (whoever runs it): update it, `bin/deploy-lobby`. It speaks versions 1, 2 and 3 side by
   side, so rooms still on 0.4 keep meeting each other until they upgrade. A 0.5 visit-client facing an older
   lobby exits at once (code 4, `proto_unsupported` in its log).
3. Get visit-client 0.5.0 (`bin/setup` again, download; or this release).
4. In `visit.host({ ... })`: `scene: { root, three, renderer, near, far }` is required (0.4's step 2: if you
   did it, you have it); give `fov`; `walk: { speed }` if your `move` is `Visit.walk` at that speed. **Remove
   `render` and `fps`**, and the second renderer and camera you kept for `render`: nothing calls them. Mark
   your visitors' bodies `userData.visitor = entry.id`, if you draw them (0.4's step 2).
5. If you passed `scenes` to `Visit.connect`, remove it.
6. Call `visit.host` right after `connect`, on every page load, as before: until it is called, your office is
   not in the lobby to be visited, and cannot knock.
7. If your page has a Content-Security-Policy: `connect-src https://cdn.jsdelivr.net` and `script-src blob:`
   (0.4's step 3), now for every visit.
8. Check ([visit/INTEGRATING.md](visit/INTEGRATING.md), step 8): both offices `ready`; a visit draws the
   host's room, walking and turning are instant, its moving things move, the visitor does not see its own
   body; reload the host's page and the visitor's, mid-visit.

## v0.4.0 — 2026-10-25

**A three.js room sends its scene, not video, and the visitor's browser draws it.** Video asks the host's
browser to render and encode every visitor's view, and a real visit showed what that costs: a host whose
Chrome is busy (its GPU process overloaded, as on a 4K screen) passed frames to the encoder hundreds of ms
late. Now a room made with three.js gives Visit its scene: the visitor's page fetches that very three.js
release (checked against its hash), draws the room itself, and walks and looks around at once, corrected by
the host. The host sends the scene once, then only what changes; it renders and encodes nothing for that
visitor. Rooms in other engines, and visitors on older versions, keep video. Protocol names: unchanged
(additions only); 0.3 and 0.4 rooms still visit each other, by video.

Measured on one machine, a busy three.js room (466 objects) visited this way:

| | video (0.3) | scene (0.4) |
|---|---|---|
| visitor's input to screen | the round trip, plus the host's render and encode | one frame of its own (5 ms) |
| what crosses the link while walking | 1–6 Mbit/s | 0.13 Mbit/s |
| the host's work per visitor | a render and an encode, up to 60 a second | reading its scene for changes: 0.35 ms, 30 a second |
| from knock to the room on screen | a keyframe | 1.2 s (the whole scene, and three.js the first time) |

### What changed

- visit.js: `v.host({ ..., scene: { root, three, renderer, near, far }, walk: { speed } })`; scenes drawn in
  the visitor's view (the stage says **drawn here**); `v.stats.mode`; `Visit.connect({ scenes, threeBase })`;
  a host's scene checked before three.js reads it (no shaders, images only as data URLs of a sane size,
  bounded geometry); a visitor's body marked `userData.visitor` left out of its own eyes.
- visit-client: the page messages `scenes` and `scene_resync`, and `scene`, `scene_lost`, `scene_resync` to
  the page; scene edits (gzipped JSON) on a link stream of their own, unpacked with a limit (a zip bomb stops
  at 64 MiB) and checked before the page sees them; scene deltas on the video path; typed link streams
  (`streams: 2` in the handshake).
- [visit/SPEC.md](visit/SPEC.md) sections 5, 7.1, 7.2, 7.4, 8.3 (new), 9, 10; [visit/INTEGRATING.md](visit/INTEGRATING.md)
  step 5 ("three.js rooms"), step 6, the checklist, troubleshooting.

### What an integration does

1. Get visit-client 0.4.0 (`bin/setup` again, download; or this release).
2. If your room is made with three.js: in `visit.host({ ... })`, add `scene: { root: scene, three: THREE,
   renderer, near, far }` (your scene, the THREE it was made with, your renderer, your visitor camera's
   near and far), and `walk: { speed }` if your `move` is `Visit.walk` at that speed. If you draw your
   visitors in your room, mark each body `userData.visitor = entry.id` (its entry in `visit.visitors`). Keep
   `render`: visitors on older versions still get video. Anything under `root` is shared: keep what your
   user would not show a guest outside it. ([visit/INTEGRATING.md](visit/INTEGRATING.md), step 5, "three.js
   rooms".)
3. If your page has a Content-Security-Policy: allow `connect-src https://cdn.jsdelivr.net` and
   `script-src blob:`, so it can draw three.js hosts' scenes when visiting (step 6).
4. Check: visit your room from a second workroom: the stage says **drawn here**, walking is instant, your
   room's moving things move, and the visitor does not see its own body. A room not made with three.js does
   only step 1 (and 3): it sends video as before, and draws three.js hosts' scenes when it visits them.

## v0.3.2 — 2026-10-25

**A busy encoder counts as a busy host.** A host steps its visitors' picture down (then their frame rate)
when its encoder falls behind too, not only when its `render` is slow: a software encoder at full size no
longer just skips frames. The perf test now also runs real browsers (`BROWSERS=1 tests/perf/run-perf.sh`:
a headless Chromium beside each visit-client, the test room's busy scene), measuring input to screen with
encoding and decoding: 18 ms on a LAN, 31 ms down the street (median, on processor-only browsers).

Found there, not yet fixed: Chromium's software H.264 encoder (OpenH264, what a machine without a video
encoder of its own gets: Chrome on Linux, often) starts a new keyframe whenever the picture changes a lot,
as when a visitor turns quickly: 5 to 8 times a frame's size, about once a second, which a slow or lossy link
feels as a stall. Hardware encoders do not. VP8 does not either, but was slower elsewhere.

### What an integration does

1. Get visit-client 0.3.2 (`bin/setup` again, download; or this release). Nothing else changes.

## v0.3.1 — 2026-10-25

**Faster, measured.** A new test, `visit/client/tests/perf/run-perf.sh`, runs visits through simulated
networks (a LAN, down the street, across the country, bad Wi-Fi, a relayed and a capped link, six visitors
on one host) and times every frame from the input it shows. It found what 0.3.0 still had wrong, now fixed:

- Nagle's algorithm on the page's connection to visit-client held small messages back: some 20 ms on
  every input and every frame, even with no network at all. Off now (`TCP_NODELAY`), as browsers have it.
- A host's frames drifted later each time (the next was timed from when the last went, not when it was
  due): about 50 frames a second, not 60 (39 in a real browser). Now on an even beat.
- The bitrate fell to its floor (0.3 Mbit/s) on lossy Wi-Fi, and reacted to a filling buffer too late:
  now WebRTC's congestion control (GCC): held through Wi-Fi's 2–10% loss, cut the moment queueing builds,
  from 1 Mbit/s, every 500 ms.
- Up to 256 KiB could sit unacknowledged: most of a second of video behind a slow link. Now 64 KiB.
- A keyframe every 2 s was a burst a capped link felt every 2 s: now every 10 s (and when asked), the link
  being reliable.

Input to frame, median / worst 5% (everything but the browsers' own encode, decode and paint):

| network | 0.3.0 | 0.3.1 |
|---|---|---|
| no delay | 26 / 29 ms, 49 fps | 5 / 9 ms, 60 fps |
| down the street (8 ms round trip) | 34 / 38 ms | 13 / 18 ms |
| across the country (70 ms) | 96 / 101 ms | 75 / 81 ms |
| bad Wi-Fi (30 ms, jitter, 1.5% loss) | 56 / 68 ms, stalls, 0.3 Mbit/s | 36 / 48 ms, 1 Mbit/s |
| relayed, capped at 5 Mbit/s (83 ms) | 122 / 194 ms, stalls | 96 / 105–141 ms |
| capped at 2 Mbit/s (26 ms) | 64 / 166 ms, stalls | 41 / 55 ms |
| six visitors on one host (8 ms) | 32 / 37 ms | 13 / 18 ms |

In two real (headless) browsers on one machine: input to screen 42 → 35 ms, 39 → 60 frames a second.

### What an integration does

1. Get visit-client 0.3.1: run `bin/setup` again and choose download, or download it from this release.
   Nothing else changes.

## v0.3.0 — 2026-10-25

**Latency, the cloud-gaming way, and a picture-in-picture.** Visits were laggy: input waited for ticks, a
busy host dropped to 10 frames a second, video queued when a link was slow, and turning waited for the
whole round trip. Now input goes the moment it changes and the host renders it at once (up to 60 frames a
second); a busy host renders smaller before it renders fewer; video is newest-wins all the way; and the
visitor's view turns with the mouse at once. A ready-made stage shows the visit full-window or in a corner.
Protocol names: unchanged (additions only); 0.2 and 0.3 rooms still visit each other.

### What changed

- visit.js: input sent on every change (at most every 8 ms) and every 33 ms, with its time (`t`); the host
  moves and renders a visitor the moment its input arrives, ticking at 60 Hz; `fps` 10–60, default 60; a
  busy host renders at three-quarters, then half size before it lowers the frame rate; the hardware
  encoder where there is one; frames carry meta (the input they reflect, the look they were drawn at);
  the visitor shifts the last frame by how far it has turned since (with the host's `fov`).
- visit.js: `v.stats` and the `"stats"` event (input to screen, the link's round trip and path, frames a
  second); `v.viewFocused`; `view.setActive()`; `Visit.stage(v)`; `fov` in `v.host()`.
- visit-client: frames' meta, negotiated (`frame_meta` in the link handshake); a newer group of pictures
  resets the older stream; frames more than 100 ms behind dropped to the next keyframe; at most 256 KiB
  unacknowledged; `link_stats` (path and round trip) to both pages, and the path in the log; 2–6 Mbit/s;
  up to 120 inputs a second; a visitor's keyframe requests passed on at most every 500 ms.
- [visit/SPEC.md](visit/SPEC.md) sections 5.2–5.4, 7.1–7.5, 8, 9, 10; [visit/INTEGRATING.md](visit/INTEGRATING.md)
  steps 5 and 6, the checklist, troubleshooting.

### What an integration does

1. Get visit-client 0.3.0: run `bin/setup` again and choose download (it keeps the `.env`'s answers), or
   download it from this release.
2. In `visit.host({ ... })`, add `fov`: the vertical field of view, in degrees, of the camera `render`
   draws with (three.js: the `PerspectiveCamera`'s first argument). If `render` is heavy, `fps: 30`.
3. Replace your own visit view (whatever calls `visit.view(...)`, shows and hides its element on
   `"change"`, and has a Leave button) with one call after `connect`: `Visit.stage(visit);`. Remove that
   element, its CSS and its handlers. (Keeping your own view instead: show `visit.stats`, and use
   `view.setActive(false)` for any picture-in-picture.)
4. If your room has keys of its own (an avatar on WASD, say) that step aside while `visit.visiting`, make
   them step aside while `visit.viewFocused` instead, so they work again while the visit is in the corner.
5. Check: visit another room. The stage shows the path (`direct`, ideally), the link's round trip and input
   to screen; turning is instant; **Back to my room** shrinks the visit to the corner and your own keys
   work; a click on the corner brings it back. Then step 8 of the guide.

## v0.2.0 — 2026-10-25

**Going offline.** A workroom's user can leave the lobby on purpose and come back, while visit-client goes
on running: away, nobody sees their office or can knock, and their visits end. With a state file,
visit-client remembers it across restarts. Protocol names: unchanged (additions only).

### What changed

- visit-client: the page messages `leave_lobby` and `join_lobby`; `away` in `ready`, and in `offline`;
  the error code `away`; the setting `--state-file` / `VISIT_STATE_FILE`
  ([visit/SPEC.md](visit/SPEC.md) sections 4.1, 4.2, 5.2, 5.3, 11).
- visit.js: `v.state` can be `"away"`; `v.leaveLobby()` and `v.joinLobby()`; the ready-made panel has
  **Go offline** / **Go online** (section 9).
- `bin/setup` writes `VISIT_STATE_FILE` (a file in the user's own state directory, outside any repository).
- `INTEGRATING.md`: a UI rule (let the user go offline and back), a checklist line, a troubleshooting row,
  and "Upgrading".

### What an integration does

1. Get visit-client 0.2.0: run `bin/setup` again and choose download (it keeps the `.env`'s answers and
   adds `VISIT_STATE_FILE`), or download it from this release.
2. Without setup: set `VISIT_STATE_FILE` in the workroom's `.env` to a file of the user's own, outside the
   repository, written out in full. A launcher that passes its environment on to visit-client (as the
   guide's do) needs no other change.
3. Using `Visit.panel`: nothing more; it has the switch. With a lobby UI of your own: add a switch calling
   `visit.leaveLobby()` / `visit.joinLobby()`, and show when `visit.state === "away"`.
4. Anything that stops visit-client to take the user off the lobby: call `leaveLobby()` instead, and leave
   visit-client running (the page needs it to come back).
5. Check: step 8 of the guide, then go offline (the other room loses you), restart the workroom (still
   offline), and come back.

## v0.1.0 — 2026-10-24

The first release: the lobby (versions 1 and 2) and its deployment (`bin/deploy-lobby`); visit-client for
Linux, macOS and Windows; visit.js with the ready-made panel; the spec; the integration guide; `bin/setup`.

### What an integration does

All of [visit/INTEGRATING.md](visit/INTEGRATING.md).
