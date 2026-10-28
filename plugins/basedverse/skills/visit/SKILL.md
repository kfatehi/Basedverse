---
name: visit
description: Integrate basedverse's Visit into a three.js workroom, or upgrade one, and offer auth-client, the workroom's sign-in. Lists Visit's features and which ones this workroom uses, answers questions about any of them, plans the work with the user (vanilla unless they say otherwise), does it, and keeps the workroom's VISIT.md log of their choices so that later upgrades keep them.
when_to_use: The user mentions basedverse, Visit, visit-client, auth-client or the lobby. Or they want their room to have friends visiting, links, a world of plots, voice, chat, phones, avatars, interactions or landscapes, or a sign-in for their workroom's server. Or they ask what is new in Visit, or to upgrade their integration.
argument-hint: "[list | ask <question> | plan | go]"
---

# Visit, for a workroom

You help a user give their three.js workroom Visit (basedverse's rooms that visit each other), or bring an
integration up to date. Follow the flow: **look → list → ask (as long as they like) → plan → go**. Nothing changes in
their workroom until they say go.

## The facts are in basedverse's docs: read them, every time

Do not work from memory: Visit changes with every release. Read these from the basedverse checkout (Step 0):

- **`visit/INTEGRATING.md`**: what Visit is *now*, from scratch, step by step, each step with its check. Its section
  **"The vanilla experience"** is the default for everything.
- **`CHANGELOG.md`**: every release, newest first, each with **"What an integration does"**. These are the steps for an
  upgrade from one version to the next.
- **`visit/MODELS.md`**: where people are (their feet) and how a room hands over its user's body and things so that
  other rooms show them right. Follow it as written for `spawn`, `move`, `visit.avatar` and possessions, and run
  `Visit.checkModel` on every model.
- **`visit/SPEC.md`**: the contract (messages, limits, the library's API), for detailed questions.
- **`auth/INTEGRATING.md`** and **`auth/SPEC.md`** (0.21): auth-client, the workroom's sign-in (accounts made in a
  terminal, sessions, API keys, visit-client's token for a signed-in session), released with visit-client.

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
- **The workroom's own rules come first** (its CLAUDE.md, its README, how it builds and runs things, e.g. only in
  containers).
- **Never open a second page on the user's own visit-client.** A second page takes over theirs (close code 4409). To
  test, run a second visit-client, as INTEGRATING.md step 8 says.
- Don't commit, push or restart their running things unless they ask or the plan they agreed says so.
- **Its database** (Visit 0.20): visit-client needs Postgres. After installing or upgrading visit-client, always
  bring its database up to date with **that** visit-client before starting it: `"$VISIT_CLIENT_PATH" migrate`, with
  the workroom's `.env` loaded (it reads `VISIT_DATABASE_URL`), or `--database <url>`. `migrate --status` says where
  it is without changing anything: run it first, and tell the user what is pending. Only ever against the
  workroom's own database (its `.env`'s); if it holds anything they care about, offer a backup first
  (`pg_dump`). If migrate fails, stop and show the user why; never edit its tables by hand.
- **Sign-in (auth-client, 0.21): offer it** to every workroom whose server serves its page, and keep the user's answer
  in `VISIT.md` (yes or no, in their words, with the date). With it, **every page and route checks the session with
  auth-client, unless the user says otherwise**: ask what, if anything, must work signed out (usually nothing), and
  keep that list in `VISIT.md` too. Never add a sign-up page; accounts are made in a terminal (`auth-client user
  add`), by the user, who types the password: never type, choose or log one for them.
- **The database's roles (0.21)**: visit-client and auth-client each get a plain role, made with the database's
  superuser (`bin/setup`, or `auth-client migrate --admin`). The superuser's URL (`VISIT_DATABASE_ADMIN_URL`) is for
  that only: the launcher passes it to nothing. A database made by 0.20's setup (visit-client on the superuser) is
  moved over once: say what it does (auth/SPEC.md 5), offer a backup first, and do it only on the user's yes, with
  visit-client stopped.
- A variant the user wants (a cell phone instead of a desk phone, voice without panning) either fits today's API or
  needs Visit to change. Say which, from SPEC.md. If it needs a Visit change, record it in `VISIT.md` as an open request
  for basedverse. Do not work around the contract.

## Step 0: Look (every time, before anything else)

1. **basedverse's checkout**: the directory with `visit/INTEGRATING.md` and `CHANGELOG.md`. Look in `$BASEDVERSE`, a
   `BASEDVERSE=` line in the workroom's `.env`, then `../basedverse` and `../Basedverse`. If there is none, ask, or offer
   to clone `https://github.com/sarmiena/Basedverse` beside the workroom. Bring it up to date
   (`git -C <it> pull --ff-only`, and say so if that fails). The newest version is the first `## vX.Y.Z` in its
   `CHANGELOG.md`.
2. **The workroom**: its three.js revision (`package.json`, import URLs, `THREE.REVISION`), how it starts (its
   launcher), how its page is served, its `.env`'s `VISIT_*` lines, and its rules (CLAUDE.md).
3. **Its Visit**:
   - `VISIT.md` at the workroom's root, if there is one: the version it was integrated at, and its decisions.
   - The visit-client it runs: `"$VISIT_CLIENT_PATH" --version`, or `curl -s http://127.0.0.1:${VISIT_PORT:-7401}/health`,
     which answers `{"version": …}`. If they differ, say so.
   - Its database: `VISIT_DATABASE_URL` in the `.env`, and `"$VISIT_CLIENT_PATH" migrate --status` (where it is, what is
     pending). None (before 0.20): the plan gives it one (bin/setup can start Postgres in Docker). Its role: the
     superuser (before 0.21), or `visit` with `VISIT_DATABASE_ADMIN_URL` beside it.
   - Its sign-in: `AUTH_*` lines in the `.env`, `"$AUTH_CLIENT_PATH" --version`, `"$AUTH_CLIENT_PATH" migrate --status`,
     and whether its server checks a session before every route (and where it listens: `127.0.0.1`, or beyond).
4. **What it uses**: `VISIT.md` says. Without one, search the page's code for each feature (the table below), tell
   the user what you found, and let them correct it.

## Where to look (hints, not the list)

| feature | since | INTEGRATING.md | in a workroom's code |
|---|---|---|---|
| connect, host, visit | 0.5 | steps 2–6 | `Visit.connect`, `visit.host(` |
| panel, stage | 0.5 | steps 6–7 | `Visit.panel(`, `Visit.stage(` |
| links (link, corner, go there) | 0.8 | step 7 | `visit.link(`, or the panel |
| world (friends' plots round yours) | 0.7 | step 9 | `visit.world(`, `world.frame(`, `world.render(` |
| map | 0.9 | step 9 | `Visit.map(`, or the panel's Map |
| where friends put you | 0.10 | step 9 | `visit.seen`, the panel's notes |
| avatars | 0.9 | step 5 | `visit.avatar(`, `entry.avatar` |
| interactions | 0.9 | step 5 | `visit.interactions(`, `userData.visitPoint` |
| voice (same room, 45 m; across a plot's side, near in both worlds) | 0.9, 0.10, 0.20 | step 5 | `visit.setMic(`, `visit.listener(`, the panel's 🎙; a world (`visit.world(`) |
| 🔊 over who is speaking | 0.13 | vanilla | `visit.world(` (unless `speaking: false`) |
| phone | 0.9, 0.13 | step 5 | `visit.phone(` (`model: false`: their own) |
| chat bubbles | 0.11 | step 5 | `visit.say(`, `bubbles` |
| your user's name, shown to others (chat, voice, panel) | 0.20.1 | step 5 | `visit.setName(` |
| chat window, scopes (say, whisper, a room's chat, the lobby); a room's voice (🎧), bans (panel) | 0.15, 0.16, 0.20 | vanilla | the panel's chat window (`chat: false`: their own), `visit.say(text, to)` |
| one panel row a person (their look, Kick, Unlink in it) | 0.16 | vanilla | the panel; visitors' own look by default (`visit.useAvatars(`) |
| landscapes, offline plots | 0.12 | step 5 | `userData.visitStatic`, `visit.landscapeChanged(` |
| mounts (possessions: the room's own; Visit carries them) | 0.18 | vanilla, step 5 | `visit.ride(`, `visit.possessions(`, `mounts:`, `eye:` in `visit.host(` |
| positions at the feet; bodies drawn by Visit; `body` reports (MODELS.md) | 0.19 | step 5, MODELS.md | `spawn(`, `move(` return feet; `look` in `visit.visitors`; `Visit.checkModel(` |
| physics: falling, flying, riders (the room's own) | 0.17, 0.19 | step 5 | `move(` (`input.up`, `who.riding`), `spawn(` (`at.air`), `eye:`, `walk: { speed, mounts }`; `air` in `world.frame(` |
| its database (chat history, pictures, links, bans), `visit-client migrate` | 0.20 | step 1 | `VISIT_DATABASE_URL` in the `.env`; the launcher passes it on |
| pictures and links in chat (paste, previews, 🖼 shared), history up the log | 0.20 | vanilla | the panel's chat window; `visit.share(`, `visit.preview(`, `visit.history(`, `visit.shared(` |
| telemetry (⏱) | 0.14 | troubleshooting | the panel's ⏱, `visit.perf(`: nothing to integrate, a tool for when a room feels slow |
| sign-in: auth-client (accounts, sessions, API keys, visit-client's token for a session), the database's plain roles | 0.21 | auth/INTEGRATING.md | `AUTH_TOKEN_FILE`, `/v1/check` in the server's middleware, `GET /login`, `/v1/visit` |

## List

For each feature give one line on what it gives the user, then its state in this workroom:
- **vanilla**: Visit's default, with the room's own choices where Visit has none, such as which objects are landscape
  or which interactions it has;
- **their own**: a Visit default replaced or turned off, as `VISIT.md`'s Deviations say;
- **off**;
- **not yet**: new since the version they have, with that version.

End with what is new since their version, from the changelog.

## Ask

Answer from INTEGRATING.md and SPEC.md, and name the section. Say what it would take in their room, and whether it is
vanilla or a choice they'd make. Variants: does today's API do it (how), or does Visit need to change? Change
nothing.

## Plan

Write the plan in the conversation:

- **From scratch**: INTEGRATING.md's steps in order, each with its check.
- **Upgrade**: each version after theirs up to the newest, each one's "What an integration does".
- Everything vanilla, except what the user asked for differently (quote them).
- **What has no default**, so ask or propose:
  - what their landscape is (what never changes: ground, walls, trees, furniture; not people, screens or signs);
  - where the phone stands;
  - which interactions (cosmetic only, per the rules);
  - their avatar;
  - where the panel goes.
- **Getting visit-client**: as INTEGRATING.md step 1 says (setup, or the release's download), within their rules.
- **Its database**: as step 1 says (setup starts Postgres in Docker, or uses theirs), within their rules (a
  containerised workroom runs Postgres as one of its own services); then `visit-client migrate`, every install and
  every upgrade.
- **Sign-in (auth-client)**, offered (the rules above): its steps from auth/INTEGRATING.md, each with its check; the
  public routes the user named (or none); the owner's account made by the user in a terminal; the route test (its
  step 12) added to the workroom's tests.

Wait for "go" (or the user's own word for it).

## Go

1. Do the plan.
   - **From scratch**: follow INTEGRATING.md.
   - **Upgrade**: follow each release's steps in order, re-applying `VISIT.md`'s deviations.
2. **Check it**: each step's check, then step 8 and step 9's checks, as far as this machine lets you (a second
   visit-client for step 8, never a second page on theirs). Say plainly what you could not check.
3. **Write `VISIT.md`** at the workroom's root, from `${CLAUDE_SKILL_DIR}/visit-log.md`, or bring it up to date:
   - the version it is now integrated at;
   - each feature's state;
   - each deviation, with the user's words and the date;
   - open requests for basedverse;
   - a line of history for this run.
4. **Report**: what changed, what was checked (and the results), what differs from vanilla, what is still open. Don't
   commit unless asked.
