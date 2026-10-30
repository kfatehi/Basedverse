---
name: visit
description: Integrate basedverse's Visit into a three.js workroom, or upgrade one (a 1.x room to 2.0 first), and offer the workroom's sign-in. Finds which Visit the room is on, lists Visit's features and which ones this workroom uses, answers questions about any of them, plans the work with the user (vanilla unless they say otherwise), does it, and keeps the workroom's VISIT.md log of their choices so that later upgrades keep them.
when_to_use: The user mentions basedverse, Visit, `visit`, visit-client, auth-client, visit-engine or the lobby. Or they want their room to have friends visiting, links, a world of plots, voice, chat, phones, avatars, interactions or landscapes, or a sign-in for their workroom's server. Or they ask what is new in Visit, or to upgrade their integration.
argument-hint: "[list | ask <question> | plan | go]"
---

# Visit, for a workroom

You help a user give their three.js workroom Visit (basedverse's rooms that visit each other), or bring an
integration up to date. Follow the flow: **look → list → ask (as long as they like) → plan → go**. Nothing changes in
their workroom until they say go.

## The facts are in basedverse's docs: read them, every time

Do not work from memory: Visit changes with every release. Read these from the basedverse checkout (Step 0):

- **`visit/INTEGRATING.md`**: what Visit is *now*, from scratch, step by step, each step with its check. Its section
  **"The vanilla experience"** is the default for everything. Its section **"Upgrading a 1.x room to 2.0"** is the
  one procedure for a room on visit-client, auth-client and the rest: follow it as written.
- **`CHANGELOG.md`**: every release, newest first, each with what an integration does about it (v2.0.0's points to
  the section above). These are the steps for an upgrade from one version to the next.
- **`visit/MODELS.md`**: where people are (their feet) and how a room hands over its user's body and things so that
  other rooms show them right. Follow it as written for `spawn`, `move`, `visit.avatar` and possessions, and run
  `Visit.checkModel` on every model.
- **`visit/SPEC.md`**: the contract (`visit` and how it runs: section 4; messages, limits, the library's API), for
  detailed questions.
- **`auth/INTEGRATING.md`** and **`auth/SPEC.md`**: the workroom's sign-in (accounts made in a terminal with
  `visit auth user add`, sessions, API keys, `visit`'s token for a signed-in session), inside `visit`.
- **`engine/INTEGRATING.md`** and **`engine/SPEC.md`**: the engine. The room's page runs in a headless Chrome inside
  `visit`, always; the person's page is one more client of it, through the workroom's own relay; the owner is the
  room's visitor. Every room that hosts is built this way: a new room from the guide's steps, a room that hosted in a
  tab before 1.0 by its "Upgrading: a room that hosts today", which lists what the split breaks and how each was
  fixed.

The feature list is whatever those docs say Visit has. The table under "Where to look" is only a hint for finding a
feature in a workroom's code. If the changelog has something newer than the table, it counts all the same.

## Rules

- **DON'T IMPLEMENT ANY INTERACTIONS OTHER THAN COSMETIC ONES UNLESS SPECIFICALLY AGREED UPON BY THE USER.** "Implement
  all interactions" still means the cosmetic ones only. List the others, say what each could reach, and wait for the
  user's yes to each one by name (then `agreed: true`, as INTEGRATING.md step 5 says).
- **Vanilla by default.** Take Visit's ready-made pieces (INTEGRATING.md, "The vanilla experience") unless the user
  asks otherwise. Every way the workroom differs from vanilla goes in its `VISIT.md`, in the user's own words, with
  the date.
- **A deviation replaces or turns off a Visit default**, and nothing else. Examples: the room's own phone
  (`model: false`), its own 🔊 (`speaking: false`), its own panel instead of `Visit.panel`, a feature switched off.
  A choice Visit leaves to every room is not a deviation: what its landscape is, where the phone stands, which
  interactions it has, its avatar, where the panel goes. The feature stays **vanilla**, and the choice goes in the
  "how" column.
- **An upgrade keeps their choices.** Re-apply each deviation in `VISIT.md` (for example `model: false` for a phone of
  their own). If a release changes something they deviated from, stop and ask: never silently revert to the default,
  and never silently keep something that no longer fits.
- **The workroom's own rules come first** (its CLAUDE.md, its README, how it builds and runs things).
- **No Docker for Visit, and none by default.** `visit` is one program that runs on the machine, its database, its
  sign-in and its engine inside it: never put it in a container. For a new room, put the room's own server on the
  machine beside it too, with no Docker anywhere. If the room already runs its server in a container (its choice),
  keep it, but on the host's network, bound to `127.0.0.1` (INTEGRATING.md step 2, "Where your sim's own server
  runs").
- **One `visit` per workroom.** Never open a second page on the user's own `visit` (it takes over theirs, close code
  4409), and never start a second `visit` on their data directory (it is refused). To test, run a second `visit`
  with its own name, port, token and data directory, as INTEGRATING.md step 8 says.
- **Its data is `VISIT_DATA_DIR`**: the database (chat, accounts, keys), the office's key, its landscapes. Never
  delete it, move it or edit what is in it by hand (its tables included); a backup is a copy taken while `visit` is
  stopped. There is nothing to migrate: `visit` brings its database up to date at every start.
- Don't commit, push or restart their running things unless they ask or the plan they agreed says so.
- **Sign-in: offer it** to every workroom whose server serves its page, and keep the user's answer in `VISIT.md` (yes
  or no, in their words, with the date). With it, **every page and route checks the session with the sign-in,
  unless the user says otherwise**: ask what, if anything, must work signed out (usually nothing), and keep that list
  in `VISIT.md` too. Never add a sign-up page; accounts are made in a terminal (`visit auth user add <name>`), by
  the user, who types the password: never type, choose or log one for them.
- A variant the user wants (a cell phone instead of a desk phone, voice without panning) either fits today's API or
  needs Visit to change. Say which, from SPEC.md. If it needs a Visit change, record it in `VISIT.md` as an open request
  for basedverse. Do not work around the contract.

## Step 0: Look (every time, before anything else)

1. **basedverse's checkout**: the directory with `visit/INTEGRATING.md` and `CHANGELOG.md`. Look in `$BASEDVERSE`, a
   `BASEDVERSE=` line in the workroom's `.env`, then `../basedverse` and `../Basedverse`. If there is none, ask, or offer
   to clone `https://github.com/sarmiena/Basedverse` beside the workroom. Bring it up to date
   (`git -C <it> pull --ff-only`, and say so if that fails). The newest version is the first `## vX.Y.Z` in its
   `CHANGELOG.md`.
2. **Which Visit the room is on.** Read `VISIT.md`'s "Integrated at" line, if there is one. Then look for **1.x signs**
   in the room, whatever `VISIT.md` says:
   - in its `.env`: `VISIT_DATABASE_URL`, `AUTH_DATABASE_URL`, `VISIT_DATABASE_ADMIN_URL`, `VISIT_CLIENT_PATH` or
     `AUTH_CLIENT_PATH`;
   - in its launcher, scripts or compose file: `visit-client`, `auth-client`, a `visit-db` Postgres, a `visit-engine`
     image or `engine` service, `migrate`;
   - an engine key: `ENGINE_KEY`, `ENGINE_KEY_FILE`, an `engine-key` file, `auth-client key add engine`.

   Any of them: the room is on 1.x. **Then the plan starts with INTEGRATING.md's "Upgrading a 1.x room to 2.0", whole,
   before anything else** (no feature work until its checks pass). None, and no `VISIT.md` or `Visit.connect` either:
   a room without Visit, built from scratch.
3. **The workroom**: its three.js revision (`package.json`, import URLs, `THREE.REVISION`), how it starts (its
   launcher), where its server runs (on the machine, or in a container: on which network), how its page is served,
   its `.env`'s `VISIT_*`, `AUTH_*` and `ENGINE_*` lines, and its rules (CLAUDE.md).
4. **Its Visit, as it runs**:
   - 2.0 on: `"$VISIT_PATH" --version`, and, with the `.env` loaded, `visit status` (where its data is, whether it
     runs). Before 2.0: `"$VISIT_CLIENT_PATH" --version`. Either: `curl -s http://127.0.0.1:${VISIT_PORT:-7401}/health`,
     which answers `{"version": …}`. If they differ, say so.
   - Its sign-in: `AUTH_TOKEN_FILE` given to `visit` by the launcher, whether its server checks a session before every
     route, and where that server listens (`127.0.0.1`, or beyond).
   - Its engine: `ENGINE_ROOM_URL`, and `curl -s http://127.0.0.1:${ENGINE_PORT:-7405}/health`.
5. **What it uses**: `VISIT.md` says. Without one, search the page's code for each feature (the table below), tell
   the user what you found, and let them correct it.

## Where to look (hints, not the list)

| feature | since | INTEGRATING.md | in a workroom's code |
|---|---|---|---|
| one program, `visit`: its database, sign-in and engine inside it; no Docker | 2.0 | steps 1–2; "Upgrading a 1.x room to 2.0" | `VISIT_PATH`, `VISIT_DATA_DIR` in the `.env`; the launcher starts `visit`, waits for its ready line |
| connect, host, visit | 0.5 | steps 2–6 | `Visit.connect`, `visit.host(` |
| panel, stage | 0.5 | steps 6–7 | `Visit.panel(`, `Visit.stage(` |
| links (link, corner, go there) | 0.8 | step 7 | `visit.link(`, or the panel |
| world (friends' plots round yours) | 0.7 | step 9 | `visit.world(`, `world.frame(`, `world.render(` |
| map | 0.9 | step 9 | `Visit.map(`, or the panel's Map |
| where friends put you | 0.10 | step 9 | `visit.seen`, the panel's notes |
| avatars | 0.9 | step 5 | `visit.avatar(`, `entry.avatar` |
| interactions | 0.9 | step 5 | `visit.interactions(`, `userData.visitPoint` |
| the wheel on interactions (something to scroll); interactions for the owner alone | 2.1.1 | step 5 | `wheel: true` or `who: "owner"` in `visit.interactions(`; `world.point(…, { wheel` |
| voice (same room, 45 m; across a plot's side, near in both worlds) | 0.9, 0.10, 0.20 | step 5 | `visit.setMic(`, `visit.listener(`, the panel's 🎙; a world (`visit.world(`) |
| 🔊 over who is speaking | 0.13 | vanilla | `visit.world(` (unless `speaking: false`) |
| phone | 0.9, 0.13 | step 5 | `visit.phone(` (`model: false`: their own) |
| chat bubbles | 0.11 | step 5 | `visit.say(`, `bubbles` |
| a room's own figures that talk (a receptionist, a guide: their lines over them, and in chat as theirs) | 1.1 | step 5 | `visit.sayAs(`, an object named `visit:npc:<id>` |
| your user's name, shown to others (chat, voice, panel) | 0.20.1 | step 5 | `visit.setName(` |
| chat window, scopes (say, whisper, a room's chat, the lobby); a room's voice (🎧), bans (panel) | 0.15, 0.16, 0.20 | vanilla | the panel's chat window (`chat: false`: their own), `visit.say(text, to)` |
| one panel row a person (their look, Kick, Unlink in it) | 0.16 | vanilla | the panel; visitors' own look by default (`visit.useAvatars(`) |
| landscapes, offline plots | 0.12 | step 5 | `userData.visitStatic`, `visit.landscapeChanged(` |
| mounts (possessions: the room's own; Visit carries them) | 0.18 | vanilla, step 5 | `visit.ride(`, `visit.possessions(`, `mounts:`, `eye:` in `visit.host(` |
| positions at the feet; bodies drawn by Visit; `body` reports (MODELS.md) | 0.19 | step 5, MODELS.md | `spawn(`, `move(` return feet; `look` in `visit.visitors`; `Visit.checkModel(` |
| physics: falling, flying, riders (the room's own) | 0.17, 0.19 | step 5 | `move(` (`input.up`, `who.riding`), `spawn(` (`at.air`), `eye:`, `walk: { speed, mounts }`; `air` in `world.frame(` |
| its database (chat history, pictures, links, bans): inside `visit` from 2.0 | 0.20, 2.0 | step 1 | `VISIT_DATA_DIR` in the `.env` (before 2.0: `VISIT_DATABASE_URL`) |
| pictures and links in chat (paste, previews, 🖼 shared), history up the log | 0.20 | vanilla | the panel's chat window; `visit.share(`, `visit.preview(`, `visit.history(`, `visit.shared(` |
| telemetry (⏱) | 0.14 | troubleshooting | the panel's ⏱, `visit.perf(`: nothing to integrate, a tool for when a room feels slow |
| the engine: the room's page in a headless Chrome inside `visit`, the person's page a client of it through the server's relay, the owner the room's visitor; settings, the theme and the owner's look through the server; the room draws its owner | 1.0, 2.0 | engine/INTEGRATING.md (steps 1–7; a room that hosted in a tab: "Upgrading") | `ENGINE_ROOM_URL`, `?role=host`, `window.VISIT_ENGINE`, `Visit.connect({ url: "/visit/ws", role: "user"`, `/visit/ws`, `visit.world({ three, renderer, self`, `look:` in `visit.host(`, `world.point(` |
| sign-in (accounts, sessions, API keys, `visit`'s token for a session), inside `visit` from 2.0 | 0.21, 2.0 | auth/INTEGRATING.md | `AUTH_TOKEN_FILE`, `/v1/check` in the server's middleware, `GET /login`, `/v1/visit`, `visit auth` |
| no lobby: the office keeps to itself, its sign-in and engine running | 2.0 | step 2 (`VISIT_LOBBY` blank) | no `VISIT_LOBBY` in the `.env` |

## List

For each feature give one line on what it gives the user, then its state in this workroom:
- **vanilla**: Visit's default, with the room's own choices where Visit has none, such as which objects are landscape
  or which interactions it has;
- **their own**: a Visit default replaced or turned off, as `VISIT.md`'s Deviations say;
- **off**;
- **not yet**: new since the version they have, with that version.

Say first which Visit the room is on (Step 0, point 2), and, on 1.x, that the upgrade to 2.0 comes before anything
else. End with what is new since their version, from the changelog.

## Ask

Answer from INTEGRATING.md and SPEC.md, and name the section. Say what it would take in their room, and whether it is
vanilla or a choice they'd make. Variants: does today's API do it (how), or does Visit need to change? Change
nothing.

## Plan

Write the plan in the conversation:

- **A 1.x room**: first INTEGRATING.md's "Upgrading a 1.x room to 2.0", its checklist item by item as written, each
  with its check: a tag of the room and the old database kept, for going back; `visit` got; `VISIT_DATA_DIR` set once;
  `visit import` with the old Postgres still running, before the first start; the old state file and landscapes kept;
  the old services and their settings deleted; `visit` reached on `127.0.0.1`; the launcher's new start and stop.
  Say what to expect: the room's pages do not change, and accounts, sessions, keys, chat and the office's key all
  come across. Then the versions after 2.0, as below.
- **From scratch**: INTEGRATING.md's steps in order, each with its check, the room's server on the machine beside
  `visit` (no Docker) unless the room already has it elsewhere.
- **Upgrade (2.0 on)**: each version after theirs up to the newest, each one's "What an integration does".
- Everything vanilla, except what the user asked for differently (quote them).
- **What has no default**, so ask or propose:
  - what their landscape is (what never changes: ground, walls, trees, furniture; not people, screens or signs);
  - where the phone stands;
  - which interactions (cosmetic only, per the rules);
  - their avatar;
  - where the panel goes.
- **Getting `visit`**: as INTEGRATING.md step 1 says (setup, a release's file, or a build), within their rules.
- **The launcher**: INTEGRATING.md step 2: the token files, new each run; `visit` started in the background, its pid
  and log in the workroom's own directory; its ready line awaited; SIGTERM to stop it.
- **Sign-in**, offered (the rules above): its steps from auth/INTEGRATING.md, each with its check; the public routes the
  user named (or none); the owner's account made by the user in a terminal (`visit auth user add`); the route test
  (its step 12) added to the workroom's tests.
- **From another device** (auth/INTEGRATING.md steps 9 and 10), once there is a sign-in: ask whether they want it, and
  which proxy (Tailscale if they have it; Caddy on the LAN; their own). Local services the page used directly (a
  console) connect out to the server instead. With the engine, Visit comes along through the server's relay.

Wait for "go" (or the user's own word for it).

## Go

1. Do the plan.
   - **A 1.x room**: follow INTEGRATING.md's "Upgrading a 1.x room to 2.0", in order, ticking each item off with its
     check. Stop and tell the user if a check fails; never go on past one.
   - **From scratch**: follow INTEGRATING.md.
   - **Upgrade**: follow each release's steps in order, re-applying `VISIT.md`'s deviations.
2. **Check it**: each step's check, then step 8 and step 9's checks, as far as this machine lets you (a second
   `visit` for step 8, never a second page on theirs). Say plainly what you could not check.
3. **Write `VISIT.md`** at the workroom's root, from `${CLAUDE_SKILL_DIR}/visit-log.md`, or bring it up to date:
   - the version it is now integrated at;
   - each feature's state;
   - each deviation, with the user's words and the date;
   - open requests for basedverse;
   - a line of history for this run (an upgrade to 2.0: from what, what was imported, what is kept for going back).
4. **Report**: what changed, what was checked (and the results), what differs from vanilla, what is still open. Don't
   commit unless asked.
