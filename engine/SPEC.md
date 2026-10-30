# The engine

A room's server half, run headless inside `visit`. An office becomes a game server; a browser, wherever it
is, becomes a client to it. [INTEGRATING.md](INTEGRATING.md) says how to build a room on it; this is the
contract behind it. Released in 1.0.0 ([#17](https://github.com/sarmiena/Basedverse/issues/17)) as an image beside
visit-client; from 2.0.0 ([#22](https://github.com/sarmiena/Basedverse/issues/22)) it is inside `visit`, the one
program a workroom runs (5).

[visit/SPEC.md](../visit/SPEC.md) is cited by section number throughout (8.1, 5.2, …); everything it says
holds unless a section here says otherwise.

## 1. What it is

Today a room is a page, and the owner's tab is two things at once: the room (its scene, its rules: the host,
8.1) and the person in it (their keys, their avatar, their voice, their chat: the user). That is why the room
exists only while that tab is open; why the tab must reach visit-client on `127.0.0.1`, so no other device can
be the owner; and why a visitor's every step is answered from wherever the owner's laptop happens to be.

With the engine, the room's page runs in a headless browser inside `visit`, always, and the owner's
browser is one more client of the office: it draws the room the way a visitor's page draws any room, from the
scene the host sends, and holds everything that is the person's. At the desk the two talk over loopback and
nothing is felt. From a coffee shop it feels like any online game played from a coffee shop. **There is no
mode**: an office with an engine runs this way whether or not anyone is looking, and a person never chooses.

```
 the office (a PC at home, or a server anywhere; no GPU)
 ┌───────────────────────────────────────────────────────────────────┐
 │  the engine, inside visit: a headless Chrome                      │
 │    the room's server page ── visit.js ───────┐                    │
 │        (scene, spawn, move, the room's logic)│ role "host"        │
 │                                              ▼                    │        the lobby, links
 │  workroom's server ──── /visit/ws relay ───▶ visit-client ◄═══════╪═══════ to other offices
 │  (sign-in, pages, its own API, its own gates)   ▲    │ role "user"│        (visit/SPEC.md 6, 7)
 └─────────────────────────────────────────────────┼────┼────────────┘
                   ▲ HTTPS, the session cookie     │    │
                   ▼                               │    ▼
 the owner's browser: the room's client page ── visit.js: draws the room, the world, the panel, the chat;
 (this machine, a laptop, a phone)                       sends keys, avatar, voice, lines; never a token
```

What it buys:

- **A room that is up whenever the office is.** Visitors, watchers and plots (8.4) no longer depend on a tab.
- **The owner from any device**, through the workroom's server, which it already signs in to. No browser ever
  reaches `127.0.0.1` again (6).
- **An office anywhere.** Rendering is a no-op in the engine, so the whole office (`visit`, with its Postgres,
  its sign-in and its engine, and the workroom's server) runs on a cheap machine with no GPU: a PC under a desk,
  or a server with a public address, where links need no hole punching and office to office is datacenter to
  datacenter.
- **Shorter round trips for everyone remote.** A visitor's step is answered by the office, not by the owner's
  laptop; and the owner's own trip is one network leg to the office and back.

What it costs:

- a headless browser per office: 150 to 300 MB of memory, a few percent of a core while the room ticks;
- at the desk, one loopback round trip on the owner's own moves, under a frame, hidden by prediction (8.2);
- rooms written in two halves, a server page and a client page (8). Visit's own pieces (the stage, panel, chat
  window, map, world) are the client half's by themselves.

What stays exactly as it is: the lobby, links, visits, watches, worlds, voice, chat, the database, every
check of visit/SPEC.md 3. Visitors, watchers and friends' worlds cannot tell an engine-hosted room from one
hosted in a tab, because they never saw anything but the bytes visit-client sends.

## 2. The pieces

| piece | what it is | who provides it |
|---|---|---|
| **visit-client** | as before (visit/SPEC.md 1): all networking, the checks, the memory. New: a page connection has a **role**, host or user (3); the owner is the host's visitor (4); it listens on a container's own network when told (6) | shared, identical for everyone |
| **the engine** | inside `visit` (5): the headless Chrome it carries, and a driver that loads the room's server page, keeps it running, and makes drawing free. On when the launcher gives `visit` `ENGINE_ROOM_URL` | shared, identical for everyone |
| **the room's server page** | the sim: its scene, its hooks (`spawn`, `move`, interactions: 8.1, 8.3) and its own logic. Runs only in the engine. Needs no screen, keyboard, mouse or microphone, and may have an empty DOM | each room |
| **the room's client page** | what a person loads: visit.js's stage, panel, chat window, map and world, and whatever HUD the room wants, which talks to the workroom's server as it likes. Runs in any browser, anywhere | each room |
| **the workroom's server** | serves both pages; signs the person in (the sign-in, inside `visit`: ../auth/SPEC.md); **relays** the person's connection to visit-client (6), so the browser never holds a Visit token; starts `visit` (its launcher) | each room |

The rule of visit/SPEC.md 1 still holds, in a new shape: **a page only ever talks to its own visit-client**.
Now two pages do, the room and the person, and the person's talks through the workroom's server.

## 3. Two connections: host and user

### 3.1 `hello` with a role

```json
{"type": "hello", "proto": "basedverse-visit-local/2", "token": "…", "role": "host", "sim": {"name": "my-sim", "version": "1.0"}}
```

| `role` | the connection is | its token (6.2) |
|---|---|---|
| `"host"` | the room: it sends the scene and its deltas, answers for everyone in it, holds the room's policy | the host token |
| `"user"` | the person: it sends what the person does and receives what the person sees and hears | the user token, put in by the relay (6.3); never the page's own |
| none | both at once: every page of Visit 0.22 and before. For rooms not yet split (8.4) and for tests. Not a mode a person picks: a room either has a server half or it has not | the host token |

`basedverse-visit-local/2` keeps its name: `role` is an addition (visit/SPEC.md 12). A visit-client of this
release takes a page without one exactly as today.

**One of each.** A new host replaces the old (close 4409, `replaced`), the user untouched; a new user replaces
the old user, the host untouched; a page without a role replaces both, and is replaced by either. A role whose
token is the other role's is refused (4401), as a wrong token is.

### 3.2 `ready`

As 5.1, plus `role` (what this connection is) and, by role:

- **to a user**: `home`: the owner's visit (4) as `{ "id", "channel", "paused" }` when the host is up, else
  `null`; `paused` true while the host page is away (a reload of the engine's page: 4.2).
- **to a host**: `owner`: `{ "id", "channel" }` when a user is connected, else `null`.
- **to a page without a role**: neither; `ready` as today.

### 3.3 Who sends what

Each message of 5.2 belongs to a role. Sent by the other, it is refused: `error` `wrong_role`, with the
message's type as `ref`, and nothing done; a binary frame of the wrong kind (5.4: the scene, its edits and the
landscape are the host's; the avatar, possessions, voice and pictures the user's) is dropped, and `wrong_role`
with `ref: "frame"` said at most once a second. A page without a role may send them all.

| the host sends (5.2) | the user sends (5.2) | either |
|---|---|---|
| `host`; its scene, edits and landscape as binary frames (5.4, bits 0, 1, 5); `pose` (its state for a visitor) | `input`, `point`, `keyframe`, `scene_resync` (for the rooms the person is in: home included, 4) | `max_visitors`, `door`, `guest_add`, `guest_remove` |
| `avatar_want`, `possession_want` (asking visitors for their models) | the avatar and possessions (5.4, bits 2, 6), `avatar_clear`, `possessions` | `avatars`, `avatar_use` |
| `voice_where` with `me`, `phone`, `visitors` (where the room has everyone in it, its owner among them), `at` (its own voices, `v.voiceAt`; their packets, visit/SPEC.md 5.4 bits 3 and 4) | `voice_where` with `world` (where the person's world has friends) | `ban`, `voice_kick` |
| `phone` (the room has one, or no longer); `say_as` (a line one of the room's own figures says: a receptionist, a guide; visit/SPEC.md 8.9); `room_chat` (the lines said in the room, to this page too: visit/SPEC.md 8.9) | the microphone (5.4, bit 3), `voice_join`, `call`, `speaker` | `end` (a visit ended by either: a kick, or leaving); `bye` (the page going, kept by the browser) |
| | `user` (the name), `say`, `attention`, `read`, `unhold`, `media_get`, pictures and voice messages (5.4, bit 7), `preview`, `history`, `shared` | `status`, `rename` |
| | `world`, `enter`, `exit`, `place`, `unplace`, `seen`, `plot_keep`, `plot_load`, `plot_forget`, `link_where` | |
| | `knock`, `answer`, `leave_lobby`, `join_lobby` | |

Knocks on the door are the person's to answer, as today: the panel shows them in the client page. Guests through
the open door are let in by visit-client without asking anyone, as today (visit/SPEC.md 3, point 9).

### 3.4 Who receives what

| the host receives (5.3) | the user receives (5.3) | both |
|---|---|---|
| `input`, `point` from everyone in its room, the owner included; `keyframe`, `scene_resync`, `shared_adds`, `landscapes` | its own visits, links and watches as today: `visit_started` / `visit_ended` (with `home: true` for the owner's visit, 4), `host_paused` / `host_resumed`, `link_stats`, `scene`, `scene_lost`, `landscape`, `enter_refused`, `body`, `avatar_none`; binary deltas, voice and media (5.4) | `ready`, `online` / `offline`, `lobby`, `guests`, `avatars`, `bans`, `error` |
| `enter` / `exit` (a watcher stepping in or out: spawn it) | `chat`, `chat_log`, `unseen`, `held`, `held_sent`, `media_ready`, `media_none`, `preview`, `history`, `shared`, `user` | the room's visits: `visit_started` / `visit_ended` for visitors, watchers and links of this room (the host to serve them; the user to show them: the panel's Kick, Unlink), with `owner: true` for the owner's visit (4) |
| `avatar`, `possessions`, `possession` (what visitors brought) | `voice_near`, `room_voice`, `voice_members`, `banned`, `call`, `phone`, `seen`, `layout`, `plot_forgotten`, `knock`, `knock_sent`, `knock_cancelled`, `answered` | |

### 3.5 Lifecycle (4.2), by role

- **Hosting** is the host connection being up: the office is in the lobby to be visited, and its link
  published, while it is; withdrawn when it goes. Visitors hear `host_paused` meanwhile, as on a reload today,
  and get the whole scene when it is back. With an engine the gap is a page reload's (5.4).
- **The user going** changes nothing for the room: it stays hosted and in the lobby. This is the point.
- **Away** (`leave_lobby`) is the user's to say, and holds across restarts as today (`--state-file`).
- **`--idle-exit`** counts from the last moment neither role is connected.
- **The mailbox** (8.9): `attention` is the user's; no user connected is nobody looking, as today without a
  page.

## 4. The owner is the host's visitor

When a user connects while a host is up (or a host comes up while a user is connected), visit-client makes the
owner's visit: a visit of the host's with no link, over the two local connections.

- **To the host** it is a visitor like any other, `visit_started` with `owner: true` and `peer` the office
  itself (`id`, `name`, `key`: its own). Its `spawn` runs with `who.owner` true and `at` null when the user
  connects, and with `at` when the person steps back home from a plot (8.4); its `move` walks them; its
  interactions run for them (`who.owner` in each `run`). The host draws their body for others (8.6: their own
  avatar, or its model, by the room's choice as for anyone: its `look(visitor)` hook, before the panel's
  setting) and reports where they are as `voice_where.me`. A room that poses bodies itself (a seat, a drink,
  a mount's wheel) says "mine" of `who.owner`: Visit's clips for an avatar are walk, idle and ride, and the
  room's poses happen to the room's own figure. They do not count toward `max_visitors`, nor as a watcher.
- **To the user** it is `home` (3.2): a visit whose `channel` carries the room's scene stream, exactly as a
  visit's link does (7.4): the whole scene, then deltas and edits; its inputs and points go up it (7.3). The
  user's page walks at once by the host's `walk` and takes its answers (8.1). Itself it shows one of two ways:
  its own body, drawn by the page, the host's copy of it hidden (`userData.visitor`; `v.world({ self: "mine" })`,
  the default, as a watcher's own body, 8.4), or the host's copy (`self: "room"`), for a room that poses its
  owner: then the host draws them (its `look` hook) and the page draws none of its own at home. The latter is
  what the owner of a room with things to sit on and eat wants: what the room does to them is what they see.
- **`yaw0` is 0** for the owner's visit, as for a watch: the person's look is in the room's own terms.
- **Rate limits** as a visitor's (visit/SPEC.md 3, point 7): inputs clamped, at most 120 a second, points 5.
- **Pictures, voice messages, the avatar, mounts** go from the user as they do from any page today (page to
  visit-client); the host asks for the owner's avatar and possessions as it does for a visitor's
  (`avatar_want`, `possession_want`), and gets them without a link.
- **Stepping onto a friend's plot** is a visit as today; the person's inputs then go there, and `home` stays
  (its scene goes on arriving: the room is drawn round them as any plot is). Stepping off brings them back
  onto the host's `spawn(who, { at })`.
- **The host away** (`home.paused`): the user's page goes on drawing the scene as it was, and walks nowhere
  the room would not have let it last (it keeps the last `walk`); back, the whole scene again.
- **No user**: no owner's visit. The host's `voice_where.me` is null, as today without a person.
- **A page without a role** makes no owner's visit: it moves its own user itself, as today.

A room may give its owner what it likes by `who.owner` (a door that opens, a faster pace, an edit mode): Visit
grants nothing itself.

## 5. The engine

Inside `visit` (the `engine` library, built from `engine/`): a driver that runs the headless Chrome `visit` carries
and speaks to it over the browser's devtools protocol (5.3), as the browser test drives Chrome
(visit/client/tests/browser_test.py). It runs when `visit` is given `ENGINE_ROOM_URL` (5.2), and stops with it,
before its database. Up to 1.x it was a container image of its own, `visit-engine` (Debian's Chromium and a driver
in Python), beside visit-client.

### 5.1 What it does

1. **Loads the room's server page** (`ENGINE_ROOM_URL`), with `Authorization: Bearer <key>` on every request
   the page makes **to that URL's origin** (the engine's key: an API key `visit` makes at each start, labelled
   `engine`, ../auth/SPEC.md 4; the workroom's server takes a key as the owner, as it does for agents), so the
   room's code is served to the engine and to nothing else without a session; a request elsewhere (a CDN's
   three.js, visit-client's library) carries nothing. The page's own origin is the server's
   (`http://<server>:<port>`): list it in `--origins` (6.4). The key and the host token are handed to the engine
   inside `visit`: there are no files to read. A server not answering yet is a failed load, tried again (point 6).
2. **Gives the page its visit-client**, before any of the page's own scripts run: `window.VISIT_ENGINE = {
   url: "ws://127.0.0.1:<VISIT_PORT>/ws", token: "<the host token>", role: "host", idle, frames, tickIdle }`.
   The page passes it to `Visit.connect` (7), and **keeps what that resolves to as `window.visit`**: it is how
   the engine sees the room is up (point 6) and who is in it (point 5). The token is in the engine's page and
   nowhere else.
3. **Makes drawing free.** The same script, run before the page's own: the WebGL context the page gets
   (`getContext("webgl")`, `"webgl2"`, `"experimental-webgl"`) is the real one with its draw calls made no-ops:
   `drawArrays`, `drawElements`, `drawArraysInstanced`, `drawElementsInstanced`, `drawRangeElements`, `clear`,
   `blitFramebuffer`, and the same under WebGL 1's `ANGLE_instanced_arrays` and `WEBGL_multi_draw` names.
   Everything else is real: three.js sees a context that works, compiles its programs,
   uploads geometry and textures once, and spends nothing on frames nobody sees. 2D canvases are untouched
   (a sign drawn on one, then a `CanvasTexture`, works). No release of three.js is special-cased.
   `readPixels` returns what the real context has, which is nothing drawn: a room must not read pixels back
   (8.1).
4. **Tells the page it is looked at**: `document.visibilityState` is `"visible"`, `document.hidden` false,
   `document.hasFocus()` true; `navigator.mediaDevices.getUserMedia` rejects (`NotFoundError`; defined even on
   an `http://` origin, which has no `mediaDevices` of its own); there is no pointer and no keyboard; the window
   is `ENGINE_WINDOW` exactly, as the page measures it.
5. **Keeps the room ticking.** The script runs the page's `requestAnimationFrame` callbacks from a loop of its
   own: at the browser's 60 a second while anyone is in the room, watching it, or connected as the user; at
   `ENGINE_TICK_IDLE` (10) a second otherwise, from a timer. The driver asks the page once a second
   (`window.visit`: `visitors.length + watchers.length`, and `owner`) and sets `window.VISIT_ENGINE.idle`;
   every frame delivered counts in `VISIT_ENGINE.frames`. A room's own `setInterval` logic is not slowed.
6. **Keeps it alive.** The page's console and uncaught errors go to the engine's log (`ENGINE_LOG`). A page that
   has crashed (`Inspector.targetCrashed`, its target gone), that has stalled (no frame counted, or no answer
   from its main thread, for 10 s), whose load failed (an HTTP error, no server yet), or whose `Visit.connect`
   has not reached `ready` (`window.visit`) within 60 s of loading, is loaded again: after 1 s, then 2, 4, … 30 s
   between tries, for ever; the wait starts over at 1 s once the room is hosting. A browser past
   `ENGINE_MEMORY_MAX` (on Linux, its processes' anonymous and shared memory, each page once: `Pss_Anon` +
   `Pss_Shmem` from `/proc`, as a cgroup counts it, where a sum of resident sizes would count Chrome's binary once
   a process; elsewhere, their resident sizes) is stopped and started again. visit-client meanwhile does what it
   does on a reload (3.5).
7. **Answers `/health`** on `ENGINE_PORT`, at `visit`'s `--listen` address (`127.0.0.1`; in a container, its own
   network, never published):
   `{"ok": true, "version": "…", "room": "hosting" | "loading" | "failed", "since": <ms epoch>, "reloads":
   <count>}`. `loading` from the start until `ready`, and during a memory restart; `hosting` from `ready`;
   `failed` from a failed load, a crash, a stall or the browser's exit until it hosts again (a retry does not
   put it back to `loading`); `ok` false while `failed`; `since`, when `room` last changed; `reloads`, every
   load after the first, failed tries and memory restarts among them.

### 5.2 Settings

`visit`'s (../visit/SPEC.md 4.1): a variable and a flag for each, the flag winning.

| variable | flag | default | |
|---|---|---|---|
| `ENGINE_ROOM_URL` | `--engine-room-url` | none: no engine | the room's server page, on the workroom's server: `http://127.0.0.1:3001/room/server` on one machine; in containers, by the server's name on their network (`http://board:3001/room/server`) |
| `ENGINE_PORT` | `--engine-port` | 7405 | `/health`, at `visit`'s `--listen` address |
| `ENGINE_TICK_IDLE` | `--engine-tick-idle` | 10 | frames a second with nobody there (1 to 60) |
| `ENGINE_MEMORY_MAX` | `--engine-memory-max` | 1024 | MiB, the browser's, past which it is restarted |
| `ENGINE_WINDOW` | `--engine-window` | `1280x720` | the page's window size: what the room's camera and canvas are told, nothing drawn |
| `ENGINE_LOG` | `--engine-log` | `info` | `error`, `warn`, `info`, `debug`: the engine's part of `visit`'s log (stderr) |

An impossible setting is exit 2, and an `ENGINE_ROOM_URL` that is not `http://` or `https://`, or an
`ENGINE_PORT` taken, exit 5, before `visit` is ready. The engine takes visit-client's port, the host token and its
key from `visit` itself (5.1): gone with the image are `ENGINE_KEY_FILE`, `VISIT_HOST` and its `VISIT_TOKEN_FILE`,
and its flags have the prefix now (`--room-url` is `--engine-room-url`). `ENGINE_DEBUG=1` (`--engine-debug`; `1`,
`yes` or `true` on, `0`, `no` or `false` off) turns on a test aid, never left on in a workroom: `POST /debug/eval`
(the body run in the page, its value as JSON) and `POST /debug/crash`, on `ENGINE_PORT`, for the tests, never part
of the contract, 404 without it.

### 5.3 What it is made of, and holds

**The browser** is Chrome for Testing's headless shell (`chrome-headless-shell`) at the version `visit` was built
with (`visit --version` names it), carried inside `visit` and unpacked once into the user's runtime directory
(../visit/SPEC.md 4.4): never the machine's own Chrome. How it is built, and started: ../deps/README.md. On Linux
it brings its own libraries and fonts (DejaVu), set for its process alone (`LD_LIBRARY_PATH`, `FONTCONFIG_FILE`),
so a bare machine draws the same text as any other; on macOS and Windows, the system's fonts. It is started with
`--disable-gpu --enable-unsafe-swiftshader --disable-dev-shm-usage --no-first-run --no-default-browser-check
--autoplay-policy=no-user-gesture-required --mute-audio --window-size=<ENGINE_WINDOW>` (the page's audio runs with no
click, for the room's own voices, ../visit/SPEC.md 8.7, and nothing of it reaches the machine's speakers) and a profile of its own (`engine/profile/` in the workroom's data directory, made
new at each start of the browser), the page's metrics set to `ENGINE_WINDOW` through the devtools protocol.

**The devtools protocol** goes over Chrome's pipe (`--remote-debugging-pipe`), which nothing else on the machine
can reach: on Linux and macOS its fds 3 and 4; on Windows two pipe handles it inherits, named to it by
`--remote-debugging-io-pipes=<in>,<out>`. On Linux the browser dies with `visit`, however `visit` ends; elsewhere
it shuts itself down once its pipe closes, which `visit` ending does.

**Its sandbox.** Chrome's own, where the machine allows one. Where it does not (a container; Ubuntu 23.10 and later,
which keep unprivileged user namespaces from it), Chrome dies at start saying so, and the engine starts it again
with `--no-sandbox`, logging a warning once, as it always has.

**What it holds**: the host token and its key, in `visit`'s memory, and nothing of the person's: no session, no
password, no microphone. It needs no GPU and asks for none: WebGL is SwiftShader's, which only uploads (point 3).
What it costs is section 1's: 150 to 300 MB of memory, a few percent of a core while the room ticks, plus what the
room's own logic costs (`ENGINE_LOG=debug` logs the browser's memory every 5 s).

### 5.4 A reload, as the room sees it

The engine loading the page again is a reload of the host page (4.2): visitors keep the scene as it was and
hear `host_paused`, then `host_resumed` and the whole scene; the user's `home.paused` goes true, then false;
the room's own state is whatever its page rebuilds. A room whose state must outlive a reload keeps it in its
own server, as it would for a tab closed by mistake.

## 6. Reaching visit-client: no browser on `127.0.0.1`

### 6.1 `--listen`

`--listen` (`VISIT_LISTEN`): `127.0.0.1`, the default, or `0.0.0.0`: in a container, its container's own
network, **its port never published**, as the sign-in's `AUTH_LISTEN` (../auth/SPEC.md 8). Nothing else is
accepted (exit 2). The workroom's server reaches it by its service name; the engine, inside `visit`, on 127.0.0.1
either way. Point 1 of visit/SPEC.md
3 reads, from this release: on `127.0.0.1`, or on a container's own network unpublished; a token on every
page connection either way, and `/visit.js` and `/health` the only things without one.

### 6.2 Two tokens

New each run, at least 32 hex characters, each in a file only its reader can read (visit/SPEC.md 3, point 2):

| token | flag | who holds it | which role it opens |
|---|---|---|---|
| host | `--token-file` (`VISIT_TOKEN_FILE`) | `visit` (its engine takes it there) | `host`, and a page without a role |
| user | `--user-token-file` (`VISIT_USER_TOKEN_FILE`; `--user-token`, `VISIT_USER_TOKEN`) | `visit`, the workroom's server | `user` |

Neither ever reaches a browser. A visit-client started without a user token takes no user connection (4401).

### 6.3 The relay

The person's browser never connects to visit-client. The workroom's server has a WebSocket route of its own
(`/visit/ws` in INTEGRATING.md; the name is the room's) which, for each connection:

1. **checks the session** with the sign-in (`/v1/check`, a session: every signed-in user is an owner), and
   refuses anything else (401; an API key is refused too: a script is not the person);
2. **opens a WebSocket to visit-client** (`ws://127.0.0.1:<VISIT_PORT>/ws`; in containers, by `visit`'s service
   name), sending the browser's own `Origin` header on its upgrade request (6.4), `TCP_NODELAY` on both sockets
   (5);
3. **sends the relay preface** as the first message on that connection, a text frame of its own:

   ```json
   {"type": "relay", "token": "<the user token>", "role": "user"}
   ```

   visit-client takes a connection that starts with `relay` for a user's: the token and role are the
   preface's, and the page's `hello`, which must follow within 5 s, is read for `proto` and `sim` only (its
   `token` and `role`, if any, ignored). A `relay` with the wrong token closes 4401; a `relay` after a `hello`,
   or a second one, closes 4400;
4. **pipes bytes both ways unread**, text and binary frames alike, pings, pongs and closes with them (close
   codes pass through: a 4409 from visit-client reaches the page as 4409). It never parses a frame after the
   preface. Toward the browser it buffers at most 1 MiB; past that (a slow link that cannot take the scene), it
   closes both ends with **4408** `slow`, and the page reconnects as after any drop, asking for the scene whole;
5. **holds one connection per session at a time**: a second from the same session replaces the first (the
   first closed 4409); visit-client's one user slot (3.1) does the same for different sessions.

The same route serves the desk (plain HTTP on `127.0.0.1`) and another device (the HTTPS proxy of
../auth/INTEGRATING.md step 10): one path. The server also serves **`/visit/visit.js`**, proxied from
visit-client's `GET /visit.js` (4.3) on each request, so the library always matches the binary; both pages load
it from there.

This retires `/api/visit` and the sign-in's `/v1/visit` for rooms on the engine (both stay for rooms not yet
split), the token in a browser (visit/INTEGRATING.md step 3), and the plan of ../auth/INTEGRATING.md step 9
for Visit ("visit-client connects out"): nothing connects out, because nothing in a browser needs to reach
visit-client any more.

### 6.4 Origins

`--origins` (visit/SPEC.md 3, point 4) sees the relay's upgrade request carrying the browser's `Origin`
(6.3, point 2), and the engine page's own origin. The list names the workroom's server's origins: the local one
(`http://localhost:3001`, `http://127.0.0.1:3001`), the HTTPS proxy's (`https://…`), and `ENGINE_ROOM_URL`'s,
which is what the engine's page has: on one machine, the local one already; in containers, the server's name on
their network (`http://board:3001`).

## 7. visit.js

```js
// The person, in any browser: through the workroom's server's relay (6.3); no token.
const v = await Visit.connect({ url: "/visit/ws", role: "user", sim: { name, version }, threeBase });
// The room, in the engine: what the engine put in the page (5.1, point 2).
const v = await Visit.connect({ ...window.VISIT_ENGINE, sim: { name, version } });   // url, token, role: "host"
// A room not yet split, in the owner's tab: as today (no role).
const v = await Visit.connect({ port, token, sim: { name, version } });
```

- `url`: `ws://`, `wss://`, or a path on the page's own origin (`/visit/ws`, which becomes `ws://` or `wss://`
  by the page's scheme). With `url`, `port` is not read, and `token` is optional (the engine gives one; a user
  gives none). The library is loaded from `/visit/visit.js` (6.3), or from visit-client as today.
- `v.role`: `"host"`, `"user"`, or `null` (a page without one).
- **As the host**: `v.host(...)` and its hooks as today; `v.sayAs(id, name, text)` for the room's own figures; `v.visitors[i].owner` true for the owner's visit (4);
  `v.owner` (`{ id, channel }` or null) and `"change"` as the person comes and goes; `voice_where.me` from where
  the room has the owner (nothing for the page to do). What is the user's refuses with `wrong_role`: `v.say`,
  `v.setMic`, `v.avatar`, `v.possessions`, `v.world`, `v.knock`, `v.link`, … The stage, panel, map and chat
  window are not made (`Visit.panel` and the others throw `wrong_role`): nobody would see them. `v.listener`
  is a no-op.
- **As the user**: `v.host(...)` throws `wrong_role`. `v.home` is the owner's visit (`{ id, channel, paused }`
  or null, `"change"` as it changes). Everything personal works as today. Two ways to draw home:
  - **`Visit.stage(v)`** draws home full-window as it draws a visited room, first person, the room's
    `walk` at once: the vanilla client page is `connect`, `stage`, `panel`.
  - **`v.world({ three, renderer, ground, gap, bubbles, speaking, self })`**, for a room with a camera of its
    own (third person, from above): no `scene`, since the page has none. Visit reads home from the host's stream
    with the page's `three` (or fetches the host's revision, as a stage does), makes it the office's own plot,
    and draws friends' plots round it as today. `world.frame(dt, pose, input)` sends `input` up the home
    channel (or the plot's, when inside one) and returns where its host has the person; the page draws its own
    body there (`self: "mine"`, the default) or shows the host's copy of it (`self: "room"`, section 4; settable
    as the page goes, for first person), and `world.render(camera)` draws it all. `world.point(target)` sends a
    click as a point aimed from the person's eyes at `target`, a point in the page's world (what its own ray
    met in the received scene): a camera behind the body does not look along the body's line; without `target`,
    where the page looks. `world.point(target, { wheel })` sends a turn of the wheel there the same way
    (`wheel`: the notches the page counted, positive down; visit/SPEC.md 8.3), added up while a point waits its
    turn. `world.atHome` says whether the person is in their own room. `world.room` is the home
    scene's root, read-only: for a camera to follow something, never to change (the host owns it); `world.plots`
    lists home too (`home: true`).
- `v.visitors` is informational for a user (the panel's Kick, Unlink): `pose` and `look` as the host reports
  them; no inputs.
- **A page without a role** has every method, as today.

## 8. Rooms: a server half and a client half

### 8.1 The server page

The sim, as visit/INTEGRATING.md step 5 has it, with these rules:

- It needs **no screen, keyboard, mouse or microphone**, and gets nothing from them: the owner's keys arrive
  as a visitor's input, through `move` and `v.interactions` with `who.owner`.
- It **does not read pixels back**: no GPU picking, no `readPixels`, no `toDataURL` of a WebGL canvas (5.1,
  point 3). Visit's points are raycasts (8.3), and a 2D canvas is real.
- Its renderer may draw to any canvas (one of 1 by 1 is enough): `v.host` needs it for its settings only.
- It **owns the truth of the room** and nothing of the person: no chat window, no panel, no name, no avatar.
  A room that wants its owner's say on something (an edit, a door) takes it through its own server.
- It is served **to the engine's key only** (5.1, point 1), never without a session: it is the room's code.
- Its **settings are the room's**, not a browser's: the look of the room, what is open, whatever a person may
  change about it lives on the workroom's server, set from the client page through that server's own routes
  (with the session) and read by this page the way it reads the rest of its data (its poll, its feed). Nothing
  of them in a browser: this page's `localStorage` is the engine's, which no person reaches, and a `?setting=`
  on the person's address changes only that browser's idea of a room drawn elsewhere.

### 8.2 The client page

What a person loads, with a session:

- `Visit.connect({ url: "/visit/ws", role: "user" })`, then the vanilla pieces (`Visit.stage`, `Visit.panel`,
  which has the chat window, map and more), or a camera of its own with `v.world` (7).
- The room's own HUD round it, talking to the workroom's server as it likes (the gates are the server's:
  sessions, keys, ../auth/INTEGRATING.md step 5). It never holds the scene's truth: what it draws came from the
  host.
- Its own keys ignore text boxes and wait while `v.viewFocused` (visit/INTEGRATING.md step 6), as today.
- A setting it offers (a dropdown, a switch) goes to the server (8.1), never into its own scene: what it draws
  came from the host, and changes when the host's does.

### 8.3 One page, two roles

A room may ship one page that looks at `role`: the engine's URL says `?role=host` (the launcher sets it on
`ENGINE_ROOM_URL`), the person's page says nothing (user). The page then builds either the sim or the HUD. Two
pages are just as good.

### 8.4 Rooms not yet split

One page, no role, in the owner's tab, `/api/visit` and visit-client on `127.0.0.1`: Visit 0.22 exactly. A
room moves when its author splits it; nothing forces the day, and a visit-client of this release serves
both kinds.

## 9. Security

The MUSTs of visit/SPEC.md 3 hold. These are added.

| who | holds | may |
|---|---|---|
| the engine | the host token and its API key, in `visit`'s memory | be the room: send the scene, answer for visitors; fetch the server page. Nothing of the person's |
| the workroom's server | the user token, the service token (auth) | relay a signed-in owner to visit-client as the user; nothing as the host |
| the person's browser | a session cookie | through the relay: everything the person may do. No Visit token, ever |
| `visit` | both tokens, the engine's key, the database | as today |

1. **Roles are enforced by visit-client**, not by pages: a message from the wrong role is refused (`wrong_role`),
   a role's token opens that role alone (6.2), and the owner's visit is made by visit-client (4): a user cannot
   send scene frames, and a host cannot speak as the person.
2. **The relay forces the role.** The preface says `user` whatever the page's `hello` says (6.3, point 3); the
   page's `token`, if any, is ignored. The relay never forwards a token from a browser.
3. **The relay is behind the session check**, in the one place every request passes (../auth/INTEGRATING.md
   step 5), and refuses API keys. A stolen session can do what the person can (walk, talk, whisper), and
   nothing the room's host can; today it could do both.
4. **`--listen 0.0.0.0` is for a container's own network with no port published**; visit-client cannot tell
   whether its port is published, so the launcher checks (`ss -ltnp` on the host: nothing on 7401).
5. **The server page is the room's code**: served to the engine's key, never to a session-less request, never
   with a token in it (the engine puts the token into the page itself, 5.1, point 2).
6. **The engine holds no secret of the person's** (5.3) and answers nothing but `/health`, at `visit`'s `--listen`
   address, unpublished.
7. **Origins** still apply (6.4): a page on another site, with a stolen session, is refused by visit-client
   before `hello`.

## 10. Limits

| | |
|---|---|
| page slots | one host, one user; a newer one of a role replaces it (4409); a page without a role takes both |
| the owner's visit | counts in nothing (`max_visitors`, watchers); its inputs and points rate-limited as a visitor's (visit/SPEC.md 3, point 7) |
| engine | frames 60 a second busy, `ENGINE_TICK_IDLE` (1 to 60) idle; a page loaded again after 1, 2, 4, … 30 s; the server page 60 s to reach `ready`; 10 s without a frame is a stall; `ENGINE_MEMORY_MAX` 1024 MiB |
| relay | one connection per session (a second replaces); 1 MiB buffered toward the browser, then 4408 `slow`; frames as the local protocol allows (visit/SPEC.md 10): a 16 MiB frame limit either way is safe (the largest a user sends is a picture, 8 MiB) |
| tokens | at least 32 hex characters each, new each run, constant-time compared |

**Errors** added to visit/SPEC.md 11: `wrong_role` (`ref`: the message's type); close codes 4408 `slow` (the
relay's), 4401 for a `relay` preface with the wrong token or a role without its token, 4400 for a preface out
of place.

## 11. Proving it: the experiment's exit

In order, each before the next; the branch merges to `main` after step 4, and not before.

1. **visit-client and visit.js**: the roles (3), the owner's visit (4), `--listen`, two tokens, the relay
   preface (6.3), `url` and `role` in `connect` (7); the cargo tests and e2e green; today's page (no role)
   passing every existing check unchanged. e2e adds: a host and a user on one visit-client; the owner walked
   by the host's `move`; a user replaced; a host away and back (`home.paused`); `wrong_role` each way; a
   `relay` preface, right and wrong.
2. **The engine** (an image in 1.0, inside `visit` from 2.0), hosting the test room's server half
   (visit/client/tests/room.html split: its scene and hooks headless, its panel and stage in a client page); the
   browser test with the owner's tab as the user, on the GPU as today, in about the same time; a reload of the
   engine's page mid-visit.
3. **The Sweatshop at the desk**, split (8), through the board's relay (6.3): nothing felt. Measured before and
   after by the ⏱ report (visit/SPEC.md 9): key to correction on the owner's moves, scan time, frame time; and
   the engine's memory and CPU over an hour, busy and idle.
4. **From a laptop** through the board's HTTPS proxy on the LAN, then from outside it (Tailscale, or a café):
   signed in, at home, visiting a friend, talking, a whisper, a picture.
5. **The office on a server** with no GPU (`visit`, its Postgres and engine inside it, and the board), the home
   machine a plain client. The stretch, and the real test of section 1's third bullet.

**Where it stands (2026-10-29, released as 1.0.0).** 1 and 2 hold (e2e, cargo, the browser test with the engine
hosting an office). 3 took a day at the desk: everything felt is fixed and written down (INTEGRATING.md,
"Upgrading: a room that hosts today"), and the owner called it good; the ⏱ reports show 60 frames, no stalls, Visit
under 3 ms a second, the engine at a third of a core busy. 4 and 5 are the next things to do, not done by this
release: a laptop through the proxy is the first. From 2.0 the engine is inside `visit`, and the same proofs run
there: `engine/tests/run-engine.sh` (the engine in a bare container, nothing of Chrome's installed) and the browser
test (an office's room hosted by the engine inside its `visit`).

## 12. Open questions

- **Several devices at once.** One user slot in v1: a phone opened at the desk replaces the desk (4409 there).
  Two users of one office would need two visits of the owner's, and one body for them both, or two.
- **Editing the room** from the client page: a room's own affair (its server's API), or a Visit edit stream
  from the user to the host, like a visitor's points but richer. Not in v1.
- **Phones (8.8).** The phone is the room's object (host: `phone`); ringing, answering, the speaker are the
  person's (user: `call`, `speaker`); where a call's audio is played is the user's page. Step 1 of section 11
  finds whether anything else is needed.
- **The owner's camera in the stage.** `Visit.stage` is first person. A vanilla third-person view of home
  (behind the person's own avatar) may be wanted for the client page; `v.world` with a camera of the room's
  does it today.

## Not in v1

- Pixel streaming: the engine never renders for anyone, and never will on this design.
- Running a room's logic outside a browser (Node, Deno, a JS runtime in Rust): rooms are written for the
  browser, and the engine is one, so they run unchanged.
- A runtime switch between a tab hosting and the engine hosting: a handover of live state, for nothing felt.
- Touch and gamepads on the client page: visit/SPEC.md 13, as before.
