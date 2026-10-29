# visit-engine

A room's server half, run headless beside visit-client. An office becomes a game server; a browser, wherever it
is, becomes a client to it. **Experimental** (branch `engine`): nothing here is released, and nothing in it is
settled until the experiment in section 10 is done. [visit/SPEC.md](../visit/SPEC.md) is cited by section
number throughout (8.1, 5.2, …).

## 1. What it is

Today a room is a page, and the owner's tab is two things at once: the room (its scene, its rules, its door:
the host, 8.1) and the person in it (their keys, their avatar, their voice, their chat: the user). That is why
the room exists only while that tab is open, why the tab must reach visit-client on `127.0.0.1`, so no other
device can be the owner, and why a visitor's every step is answered from wherever the owner's laptop happens
to be.

With the engine, the room's page runs in a headless browser beside visit-client, always, and the owner's
browser is one more client of the office: it draws the room the way a visitor's page draws any room, from the
scene the host sends, and it holds everything that is the person's. At the desk the two talk over loopback and
nothing is felt. From a coffee shop it feels like any online game played from a coffee shop. **There is no
mode**: an office with an engine runs this way whether or not anyone is looking, and a person never chooses.

```
 the office (a PC at home, or a server anywhere; no GPU)
 ┌──────────────────────────────────────────────────────────────┐
 │  visit-engine: a headless browser                            │
 │    the room's server page ── visit.js ──┐                    │
 │                                         │ "host"             │
 │  workroom's server ─── relays ───┐      ▼                    │        the lobby, links
 │    (sign-in, pages, its own API) └───▶ visit-client ◄════════╪═══════ to other offices
 │                 ▲                       ▲    │  "user"       │        (7)
 └─────────────────┼───────────────────────┼────┼───────────────┘
                   │ HTTPS (the session)   │    │
                   ▼                       │    ▼
 the owner's browser: the room's client page ── visit.js: draws the room, the world, the panel, the chat;
 (this machine, a laptop, a phone)                       sends keys, avatar, voice, lines
```

What it buys:

- **A room that is up whenever the office is.** Visitors, watchers and plots (8.4) no longer depend on a tab.
- **The owner from any device**, through the workroom's server, which it already signs in to. No browser ever
  reaches `127.0.0.1` again (5).
- **An office anywhere.** Rendering is a no-op in the engine, so the whole office (visit-client, Postgres,
  auth-client, the workroom's server, the engine) runs on a cheap machine with no GPU: a PC under a desk, or a
  server with a public address, where links need no hole punching and office to office is datacenter to
  datacenter.
- **Shorter round trips for everyone remote.** A visitor's step is answered by the office, not by the owner's
  laptop; and the owner's own trip is one network leg to the office and back.

What it costs:

- a headless browser per office: some hundreds of MB of memory, a few percent of a core while the room ticks;
- at the desk, one loopback round trip on the owner's own moves, under a frame, hidden by prediction (8.2);
- rooms written in two halves, a server page and a client page (7). Visit's own pieces (the stage, panel, chat
  window, world) move to the client half by themselves.

## 2. The pieces

| piece | what it is | who provides it |
|---|---|---|
| **visit-client** | as before (visit/SPEC.md 1): all networking, the checks, the memory. It learns that a page connection has a **role**, host or user (3), and to listen on a container's network (5) | shared |
| **visit-engine** | a container image: a headless Chromium and a small driver that loads the room's server page, keeps it running, and makes drawing free (4). Started by the workroom's launcher beside visit-client, on the same network | shared |
| **the room's server page** | the sim's scene, its hooks (`spawn`, `move`, points, the door: 8.1, 8.3, 8.5) and its own logic. Runs only in the engine. Needs no screen, keyboard, mouse or microphone | each room |
| **the room's client page** | what a person loads: visit.js's stage, panel, chat window and world, and whatever HUD the room wants, talking to the workroom's server as it likes. Runs in any browser | each room |
| **the workroom's server** | serves both pages, signs the person in (auth-client), and **relays** the person's connection to visit-client (5), so the browser never holds a Visit token | each room |

The rule of visit/SPEC.md 1 still holds, in a new shape: **a page only ever talks to its own visit-client**, and
now there are two pages that do, the room and the person, and the person's talks through the server.

## 3. Two connections: host and user

`hello` (5.1) takes a `role`:

```json
{"type": "hello", "proto": "basedverse-visit-local/2", "token": "…", "role": "host", "sim": {"name": "my-sim", "version": "1.0"}}
```

- `"host"`: the room. It sends the scene and its deltas, answers for visitors, keeps the door.
- `"user"`: the person. It sends what the person does and receives what the person sees and hears.
- none: both at once, as every page is in Visit 0.22. For rooms not yet split, and for tests (7). Not a mode a
  person picks: a room either has a server half or it does not.

**One of each.** A new host replaces the old (4409, `replaced`), the user untouched; a new user replaces the old
user, the host untouched. A page without a role replaces both. A role's token must match its own (5).

**Who sends what.** Each message of 5.2 belongs to one role; the rest of 5.3 follows the same line.

| the host sends (5.2) | the user sends (5.2) | both |
|---|---|---|
| `host`, the scene and its edits (5.4: bits 0, 1, 5: key deltas, edits, the landscape) | input (8.2), points (8.3), `enter` / `exit` (a plot, 8.4) | `leave_lobby`, `join_lobby` |
| the answers of its hooks: `spawn`, `move`, a point's outcome, a knock's answer (the door) | the avatar and possessions (5.4 bits 2, 6: 8.6, 8.11), `user` (the name) | |
| `voice_where` (8.7): where it has everyone in its room, **its owner among them** (`me`) | the microphone (5.4 bit 3), `voice_join`, `speaker`, `call` | |
| `phone` (the room has one), `ban`, `voice_kick` (the room's policy) | `say`, `attention`, `read`, `unhold`, `media_get`, `preview`, `history`, `shared` (8.9, 8.12) | |
| `plot`, `unit` (its own plot's size) | `world`, `seen`, `plot_keep` / `plot_load` / `plot_forget`, `knock` (to others), `link_where` (8.4, 8.5) | |

| the host receives (5.3) | the user receives (5.3) | both |
|---|---|---|
| visitors' inputs and points; `visit_started` / `visit_ended` for its room; knocks to answer; `watchers` | the room's scene and deltas (as a visitor's page gets them, 7.4), where the room has them; `chat`, `chat_log`, `unseen`, `held`, `held_sent`; voice to play (5.4 bit 3), `voice_near`, `room_voice`, `voice_members`; `call`, `seen`, `layout`, `landscape`, `plot_forgotten`; `body`, `avatar_none`; `media_ready` / `media_none`, `preview`, `history`, `shared`; `banned` | `ready`, `lobby`, `online` / `offline`, `error` |

A message sent by the wrong role is refused (`error`, code `wrong_role`, with its `ref`).

**The owner is the host's visitor.** When a user connects, visit-client gives the host a visit of its own for them
(a channel of its own, no link): the host's `spawn` hook runs for them (`who.owner` true) when they first arrive,
and when they step back home from a plot; their inputs reach the host as any visitor's (7.3); the host's `move`
walks them; the host draws their body for others (8.6) and reports where they are in `voice_where.me`; they do
not count toward `max_visitors`. A room may give its owner what it likes by `who.owner` (a door that opens, a
faster pace, an edit mode): Visit grants nothing itself.

**The user's page draws its own room as a visit.** visit-client copies the host's scene stream to the user over
the local connection, as it sends it to each visitor over a link (7.4): the whole scene first, then deltas; the
user's page reads it with its own three.js (8.1), walks at once and takes the host's answers (8.2), draws its own
body itself (8.4, "the watcher's own body"), and draws the world round it exactly as today. Stepping onto a plot
is a visit as today; stepping off puts them back on the host's.

**The mailbox** (8.9): `attention` is the user's; no user connected is nobody looking, as it is today without a page.

**Lifecycle** (4.2), by role:

- **Hosting** is the host being connected: the link is published while it is, withdrawn when it goes, and the
  room's visitors hear `host_paused` meanwhile, as on a reload today.
- **The user going** changes nothing for the room: it stays hosted and in the lobby. This is the point.
- `--idle-exit` counts from the last moment neither role is connected.
- **Away** (`leave_lobby`) is the user's to say, and holds as today.

## 4. The engine

A container, `visit-engine`, built from `engine/`: a headless Chromium and a driver that speaks the browser's
devtools protocol, as the browser test does (visit/client/tests/browser_test.py). It:

1. **loads the room's server page** (`ENGINE_ROOM_URL`) with an API key of auth-client's on every request
   (`ENGINE_KEY_FILE`; the workroom's server takes a key as the owner, as it does for agents), so the room's
   code is served to the engine and to nobody else without a session;
2. **makes drawing free.** A script runs before the page's own: the WebGL context the page gets is the real one
   with its draw calls (`drawArrays`, `drawElements`, their instanced forms, `clear`) made no-ops. three.js
   sees a context that works, uploads geometry and textures once, and spends nothing on frames nobody sees;
   no version of three.js is special-cased. The page is told it is visible and focused, has no microphone, and
   no pointer or keyboard;
3. **keeps the room ticking.** `requestAnimationFrame` runs at 60 a second while anyone is in the room,
   watching it, or connected as the user; `ENGINE_TICK_IDLE` (10) a second otherwise. The driver asks visit.js
   which it is, through the devtools protocol, once a second;
4. **keeps it alive.** The page's errors and console go to the engine's log; a crashed or stalled page (no
   frame for 10 s) is loaded again (1 s, 2 s, 4 s, … up to 30 s between tries); a browser over
   `ENGINE_MEMORY_MAX` is restarted. visit-client meanwhile does what it does on a reload: visitors keep the
   scene as it was, and get it whole when the host is back;
5. **answers `/health`** on its port, on its container's network only: `{"ok": true, "room": "hosting" |
   "loading" | "failed", "version": "…", "since": …}`.

| variable | default | |
|---|---|---|
| `ENGINE_ROOM_URL` | (required) | the room's server page, on the workroom's server, by its name on the network |
| `ENGINE_KEY_FILE` | (required) | an API key of auth-client's (`auth-client key add engine`), readable by the engine only |
| `VISIT_HOST`, `VISIT_PORT` | `visit`, 7401 | visit-client, by its name on the network (5). The page is given them as its `Visit.connect` |
| `VISIT_TOKEN_FILE` | (required) | the **host** token (5) |
| `ENGINE_TICK_IDLE` | 10 | frames a second with nobody there |
| `ENGINE_MEMORY_MAX` | 1024 | MiB, the browser's, past which it is restarted |
| `ENGINE_LOG` | `info` | |

It needs no GPU and asks for none. It expects 150 to 300 MB of memory and, while the room ticks, what the
room's own logic costs. It holds no secret but its two files, and nothing of the person's.

## 5. Reaching visit-client: no browser on `127.0.0.1`

- **`--listen` (`VISIT_LISTEN`)**, as auth-client's: `127.0.0.1` (the default), or in a container `0.0.0.0`,
  its container's own network, **its port never published**. The engine and the workroom's server reach it by
  its service name. Point 1 of visit/SPEC.md 3 reads, from then: on `127.0.0.1`, or on a container's network
  unpublished; a token on every connection either way.
- **Two tokens**, new each run, each in a file only its reader can read: the host's (`--token-file`, the
  engine's) and the user's (`--user-token-file`, the workroom's server's). A page without a role (3) uses the
  host's. Neither ever reaches a browser.
- **The person's connection is relayed.** The workroom's server has a route of its own (`/visit/ws`, say): it
  checks the session with auth-client (every signed-in user is an owner), opens a WebSocket to visit-client,
  reads the page's `hello`, puts the user token in it and `role: "user"` on it whatever the page said, sends it
  on, and from then pipes frames both ways unread, text and binary alike, with Nagle's algorithm off at both
  ends (5). The same route serves the desk (plain HTTP on `127.0.0.1`) and another device (the HTTPS proxy of
  auth/INTEGRATING.md step 10): one path.
- **`/api/visit` is retired**, and with it the token in a browser (visit/INTEGRATING.md step 3). visit.js's
  `Visit.connect({ url })` takes the relay's URL (`ws://` or `wss://`, from the page's own origin) in place of
  `port` and `token`. The server serves `/visit/visit.js` fetched from visit-client (`GET /visit.js`, 4.3)
  once at start, so the library always matches the binary.
- **Origins** (`--origins`): the relay passes the browser's `Origin` through; the list names the workroom's
  server's origins, the local one and the proxy's.

This replaces the plan of auth/INTEGRATING.md step 9 for Visit ("visit-client connects out"): nothing connects
out, because nothing in a browser needs to reach visit-client any more.

## 6. visit.js

- `Visit.connect({ url, role, sim, threeBase })`. `role` "host" or "user"; none: both, as today. `url` as in 5;
  `port` + `token` still work for a page without a role, so today's rooms and tests run unchanged.
- **As the host**: `v.host(...)` and the hooks as today; input, avatar, microphone, chat and world calls refuse
  (`wrong_role`); the stage, panel and chat window are not made (nobody sees them).
- **As the user**: `v.host(...)` refuses; the stage draws the office's own room as a visited room, from the
  host's stream (3), and marks it home (`v.home`: its key is the office's); everything personal works as
  today. A room's client page adds its HUD round the stage, talking to its own server.
- `v.role`, and in `ready`: `role`, and `host: true | false` for a user (whether the room is up).

## 7. Rooms: a server half and a client half

A room that runs with the engine is two pages, or one page that looks at `role`:

- **The server page**: the scene, the hooks, the room's logic. It must not need a screen, a keyboard or a mouse,
  must not read pixels back (no GPU picking; Visit's points are raycasts, 8.3), and gets what it wants from
  its owner through `who.owner` in its hooks, or through its own server. Its DOM may be empty.
- **The client page**: `Visit.connect({ url, role: "user" })`, `Visit.stage`, the panel and the chat window if
  wanted, and the room's own UI. It never holds the scene's truth: what it draws came from the host.

**Rooms not yet split** keep working: one page, no role, in the owner's tab, with no engine. That is Visit 0.22
exactly. A room moves when its author splits it; nothing forces the day.

**The Sweatshop**, as a sketch: `room.html` becomes `room-server.html` (the office, the agents at their desks,
`spawn` and `move`, the door) and `room.html` (the boards, the Agent Room console, the who-are-you form, and the
stage). The boards already talk to the board's server, not to the scene, so the split is mostly a cut. Its
compose file loses `network_mode: host` on `visit` (`VISIT_LISTEN=0.0.0.0`, no `ports:`) and gains `engine`;
`bin/start` writes two tokens and an engine key. **Not before the user says so**, and `git tag before-engine`
marks where to go back to.

## 8. What changes, by piece

| piece | change |
|---|---|
| visit-client | `role` on `hello`; two page slots and the routing of 3; the owner as a visit of the host's with no link; the host's stream copied to the user; `--listen`; `--user-token-file`; `wrong_role`; `--idle-exit` by both slots. `basedverse-visit-local/2` keeps its name: `role` is an addition (CHANGELOG, "a release that changes a protocol's name") |
| visit.js | `url`, `role`, `v.home`, `v.role`; the user's stage drawing home as a visit; host-only and user-only refusals |
| visit-engine | new: `engine/` (the image, the driver, the script of 4), `engine/INTEGRATING.md` |
| the workroom's server | the relay route (5); `/visit/visit.js`; serving the server page to a key; starting the engine; `/api/visit` gone |
| auth-client | nothing. `/v1/visit` stays for rooms not yet split |
| the lobby | nothing |
| tests | e2e: a host and a user on one visit-client, the owner walked by the host, a user replaced, a host away and back; browser: the test room split, the engine image hosting its server half, the owner's tab as the user, screenshots as today |

## 9. Limits

| | |
|---|---|
| page slots | one host, one user; a newer one of a role replaces it (4409) |
| the owner's visit | counts in nothing (`max_visitors`, watchers); its inputs rate-limited as a visitor's (8.2) |
| engine | ticks 60 a second busy, `ENGINE_TICK_IDLE` idle; reloads a dead page after 1, 2, 4, … 30 s; restarts the browser past `ENGINE_MEMORY_MAX`; the server page's load waits 60 s before counting as failed |
| relay | frames as the local protocol allows (10); one user connection per session; a relay with no session is 401 as any route |

## 10. Proving it: the experiment's exit

In order, each before the next; the branch merges to `main` after step 4, and not before.

1. **visit-client and visit.js**: the roles (3, 6), with the cargo tests and e2e green, today's page (no role)
   still passing every existing check.
2. **The engine image**, hosting the test room's server half; the browser test with the owner's tab as the
   user, on the GPU as today, in about the same time.
3. **The Sweatshop at the desk**, split (7), through the board's relay (5): nothing felt. Measured, before and
   after, by the ⏱ report (visit/SPEC.md 9): key to correction on the owner's moves, scan time, frame time;
   and the engine's memory and CPU over an hour.
4. **From a laptop** through the board's HTTPS proxy on the LAN, then from outside it (Tailscale, or a café):
   signed in, in the room, visiting a friend, talking.
5. **The office on a server** with no GPU (Postgres, visit-client, auth-client, the board, the engine), the home
   machine a plain client. The stretch goal, and the real test of 1's second bullet.

If 3 is felt at the desk, or the engine cannot be made cheap, the branch stays experimental, and this file says
why.

## 11. Open questions

- **Several devices at once.** One user slot in v1: a phone opened at the desk replaces the desk. Two users of
  one office would need two visits of the owner's, and one body for them both, or two.
- **Editing the room** from the client page: a room's own affair (its server's API), or a Visit edit stream
  from the user to the host, like a visitor's points but richer. Not in v1.
- **The door.** Knocks are answered by the host's hooks, as today; a room whose owner wants to be asked relays
  the question through its own server to the client page. Visit could carry it (`knock` to the user, the
  answer back to the host) if every room wants that.
- **Phones (8.8).** The phone is the room's object (host); ringing, answering, the speaker are the person's
  (user). The table in 3 says so; whether a call's audio needs anything else is found in step 1.
- **One page, two roles**, for rooms that would rather not have two files: `role` from a query parameter, which
  the launcher sets on `ENGINE_ROOM_URL`. Likely yes.
- **The engine as a visit-client subcommand** (`visit-client engine`, driving a Chromium beside it) instead of
  an image of its own. No: visit-client stays one thin binary that knows nothing of browsers.

## Not in v1

- Pixel streaming: the engine never renders for anyone, and never will on this design.
- Running a room's logic outside a browser (Node, Deno, a JS runtime in Rust): rooms are written for the
  browser, and the engine is one, so they run unchanged.
- Touch and gamepads on the client page: visit/SPEC.md 13, as before.
