# Changelog

Every release of basedverse, newest first. It is written for whoever keeps a workroom's integration of
Visit working, person or coding agent: each release says what changed, and **what an integration does
about it**. To upgrade, read from the version you have (`visit-client --version`) up to the newest, and do
each release's steps in order ([visit/INTEGRATING.md](visit/INTEGRATING.md), "Upgrading").

A release that changes a protocol's name (`basedverse-lobby/2`, `basedverse-visit-local/1`,
`basedverse-visit/1`) says so at its top: then every workroom upgrades, and the lobby with them. Additions
keep the names, so offices on different versions still meet and visit each other.

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
