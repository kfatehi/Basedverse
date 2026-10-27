---
name: visit
description: Integrate basedverse's Visit into a three.js workroom, or upgrade one. Lists Visit's features and which ones this workroom uses, answers questions about any of them, plans the work with the user (vanilla unless they say otherwise), does it, and keeps the workroom's VISIT.md log of their choices so that later upgrades keep them.
when_to_use: The user mentions basedverse, Visit, visit-client or the lobby. Or they want their room to have friends visiting, links, a world of plots, voice, chat, phones, avatars, interactions or landscapes. Or they ask what is new in Visit, or to upgrade their integration.
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
- **`visit/SPEC.md`**: the contract (messages, limits, the library's API), for detailed questions.

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
| voice (same room, 45 m) | 0.9, 0.10 | step 5 | `visit.setMic(`, `visit.listener(`, the panel's 🎙 |
| 🔊 over who is speaking | 0.13 | vanilla | `visit.world(` (unless `speaking: false`) |
| phone | 0.9, 0.13 | step 5 | `visit.phone(` (`model: false`: their own) |
| chat bubbles | 0.11 | step 5 | `visit.say(`, `bubbles` |
| chat window, scopes (say, whisper, a linked room, the lobby) | 0.15, 0.16 | vanilla | the panel's chat window (`chat: false`: their own), `visit.say(text, to)` |
| one panel row a person (their look, Kick, Unlink in it) | 0.16 | vanilla | the panel; visitors' own look by default (`visit.useAvatars(`) |
| landscapes, offline plots | 0.12 | step 5 | `userData.visitStatic`, `visit.landscapeChanged(` |
| mounts (possessions: Visit's horse and carpet, your own) | 0.18 | vanilla, step 5 | `visit.ride(`, `visit.possessions(`, `mounts:`, `eye:` in `visit.host(` |
| flying (the room's choice) | 0.17 | step 5 | `fly:` in `visit.host(`; `air` in `world.frame(` |
| telemetry (⏱) | 0.14 | troubleshooting | the panel's ⏱, `visit.perf(`: nothing to integrate, a tool for when a room feels slow |

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
