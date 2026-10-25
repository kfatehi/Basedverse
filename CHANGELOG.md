# Changelog

Every release of basedverse, newest first. It is written for whoever keeps a workroom's integration of
Visit working, person or coding agent: each release says what changed, and **what an integration does
about it**. To upgrade, read from the version you have (`visit-client --version`) up to the newest, and do
each release's steps in order ([visit/INTEGRATING.md](visit/INTEGRATING.md), "Upgrading").

A release that changes a protocol's name (`basedverse-lobby/2`, `basedverse-visit-local/1`,
`basedverse-visit/1`) says so at its top: then every workroom upgrades, and the lobby with them. Additions
keep the names, so offices on different versions still meet and visit each other.

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
