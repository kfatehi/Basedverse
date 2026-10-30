# Changelog

Every release of basedverse, newest first. It is written for whoever keeps a workroom's integration of
Visit working, person or coding agent: each release says what changed, and **what an integration does
about it**. To upgrade, read from the version you have (`visit --version`; before 2.0, `visit-client
--version`) up to the newest, and do each release's steps in order ([visit/INTEGRATING.md](visit/INTEGRATING.md),
"Upgrading").

A release that changes a protocol's name (`basedverse-lobby/2`, `basedverse-visit-local/1`,
`basedverse-visit/1`) says so at its top: then every workroom upgrades, and the lobby with them. Additions
keep the names, so offices on different versions still meet and visit each other.

## v2.1.0 — 2026-10-30 — the panel folds, and says its version

- **The panel folds** ([visit/SPEC.md](visit/SPEC.md), `Visit.panel`). A caret (▾) first in its first line folds it
  to that line, with what asks you for an answer (a knock, a call ringing) still shown under it; the browser
  remembers it folded or open. While it is folded, the element the page gave `Visit.panel` has the class
  `visit-folded`. **An integration** that puts rows of its own beside the panel, in the same element (a sign-out
  row, say), hides them under `.visit-folded` if they should fold with it; nothing else to do.
- **Visit's version** is at the panel's foot, and in every row of the ⏱ report (`visit`, in `v.perfReport()`) and
  on its corner of the page. Nothing to do.
- **The panel's "Enter to chat" line is gone**: the chat window says it when it opens. Nothing to do.

## v2.0.0 — 2026-10-29 — one program, `visit` ([#22](https://github.com/sarmiena/Basedverse/issues/22))

**`visit` is everything a workroom runs.** visit-client, auth-client and the engine's driver are one Rust program,
`visit`, and a Postgres and a headless Chrome are inside it, each with every library it needs: one file per
platform, about 150 MB (Linux x86_64 and ARM64 with glibc 2.28 or newer, macOS 11 or later on Apple silicon and
Intel, Windows x86_64). Nothing is downloaded as it runs, nothing is installed, and Visit needs no Docker any more:
Docker is for building and testing basedverse, never for running Visit (a room's own server may keep its
container, on the host's network). A workroom that ran four services (visit-client, auth-client, a Postgres, the
engine's image) runs one program ([visit/SPEC.md](visit/SPEC.md) 4).

- **Its database is inside it** (visit/SPEC.md 4.4). `visit` runs its own Postgres as its child, on 127.0.0.1 at a
  port free at the moment, its data in the workroom's data directory, `VISIT_DATA_DIR` (by default
  `basedverse/<the office's name>` in the user's data folder: `~/.local/share` on Linux, `~/Library/Application
  Support` on macOS, `%LOCALAPPDATA%` on Windows). It makes the database at its first start and brings it up to
  date at every start, with its two roles as 0.21 made them (`visit` and `auth`, plain, each with its own schema):
  `visit-client migrate` and `auth-client migrate [--admin]` are gone. One `visit` a workroom: a second for the
  same data directory is refused. Stopping it (Ctrl-C, SIGTERM) stops its engine first and its Postgres last; one
  killed outright leaves its Postgres running, and its next start stops it first.
- **The sign-in is inside it** ([auth/SPEC.md](auth/SPEC.md)). `visit auth …` is what `auth-client …` was in a
  terminal (`user add`, `user list`, `user remove`, `passwd`, `sessions`, `revoke`, `key add|list|revoke`), on the
  workroom's database whether `visit` runs or not; `visit` serves the sign-in's API when given the service token's
  file, `AUTH_TOKEN_FILE`, and its `/v1/visit` reads `visit`'s own page token file.
- **The engine is inside it** ([engine/SPEC.md](engine/SPEC.md) 5). Given `ENGINE_ROOM_URL`, `visit` hosts the
  room's server page itself, in Chrome for Testing's headless shell at a pinned version (on Linux with its own
  libraries and fonts), spoken to over its devtools pipe (on Windows, a port on 127.0.0.1 that Chrome picks). The
  engine gets the host token and visit-client's port in-process, and its API key is made by `visit` at each start
  (labelled `engine`, the one before it gone): no key file, no `auth-client key add engine`, no image. Chrome's own
  sandbox where the machine allows one, else `--no-sandbox` with a warning, as before. All else the engine does is
  1.0's.
- **New commands** (visit/SPEC.md 4.5): `visit import <URL>` moves a 1.x workroom's database in (chat, the
  mailbox's marks, pictures and voice messages, links, whispers held, bans, accounts, sessions, keys), once, into a
  workroom with none yet; `visit psql`, a psql on the workroom's database as its superuser; `visit status`, where
  its data is, what it carries and whether it runs; `visit --version` names the Postgres and the Chrome it carries.
- **The lobby is optional.** Without `VISIT_LOBBY` the office keeps to itself: nobody visits, links or knocks, and
  its pages, its sign-in and its engine run all the same, so a room can have its sign-in before it has a lobby.
- **`ENGINE_DEBUG`** takes `1`, `yes`, `true` or `0`, `no`, `false`: a test aid, never left on in a workroom.
- **A state file always.** `VISIT_STATE_FILE` and `VISIT_CACHE_DIR` default to `state.json` and `landscapes/` in the
  data directory, so every office keeps its key, its door and its guests across restarts without being told where.
- **Settings.** The `VISIT_*`, `AUTH_*` and `ENGINE_*` variables keep their names (the sign-in's and the engine's
  flags are `visit`'s now, with their prefix: `--auth-port`, `--engine-room-url`). Gone: `VISIT_DATABASE_URL`,
  `AUTH_DATABASE_URL`, `VISIT_DATABASE_ADMIN_URL`, `VISIT_DATABASE_NEW_ADMIN_URL`, `AUTH_VISIT_PROBE`, `AUTH_LOG`
  (`RUST_LOG` filters the whole log), and the engine's `ENGINE_KEY_FILE`, `VISIT_HOST` and its `VISIT_TOKEN_FILE`.
  New: `VISIT_DATA_DIR`; and `VISIT_PATH`, the launcher's, in place of `VISIT_CLIENT_PATH` and `AUTH_CLIENT_PATH`.
  [.env.example](.env.example) has them all.
- **`bin/setup`** gets `visit` (downloaded from the newest release, or built), writes `VISIT_DATA_DIR` and
  `VISIT_PATH` into the `.env` and takes out what 2.0 has no use for, moves a 1.x database in (`visit import`) when
  the `.env` still names one, and offers to make the owner's account (`visit auth user add`). It asks nothing about
  a database or Docker.
- **`deps/`** ([deps/README.md](deps/README.md)): how the Postgres (18.6) and the Chrome (156) inside `visit` are
  built, tested on every platform, and pinned. Upgrading either is a release of its own, `deps-<n>`; a Visit release
  carries whatever `deps/pinned.json` says at its commit.
- **The release** is `visit-<target>` (`.tar.gz`, `.zip` on Windows) and `SHA256SUMS`, each started fresh on its
  platform before it goes out; auth-client's files and the engine's image are no more.

The protocols, the relay (engine/SPEC.md 6) and visit.js are 1.1's: an office on 2.0 and one on 1.x meet, visit and
are visited as before, and a room's pages change nothing.

### Upgrading (from 1.1)

**Follow [visit/INTEGRATING.md](visit/INTEGRATING.md), "Upgrading a 1.x room to 2.0"**, whole and first: what to
expect, a checklist with a check for each step, how to go back, and a worked example (a room whose board ran in
Docker). In short: the room's pages do not change; one `visit`, on the machine, replaces four services; with the
old Postgres still running and `VISIT_DATA_DIR` set, `visit import <its superuser URL>` brings everything across
before the first start; the state file keeps its path, so friends still know the office; the database, roles,
`migrate` and engine-key steps go; the room's server reaches `visit` on `127.0.0.1` (on the machine, or a container
on the host's network), and so does `ENGINE_ROOM_URL`. A workroom on an older release upgrades to 1.1 first.

## v1.1.0 — 2026-10-29

**A room's own figures say lines** ([#14](https://github.com/sarmiena/Basedverse/pull/14), Keyvan's, for
[#13](https://github.com/sarmiena/Basedverse/issues/13)'s say half). `v.sayAs(id, name, text)`: something of the
room's that talks (a receptionist, a guide; never a person) says a line in the room, to everyone who can see it,
over the object named `visit:npc:<id>`, and in everyone's chat under its own name, kept as its (`npc`), never as
the room's user, each figure on a limit of its own (5 lines every 10 s). Page → visit-client `say_as`; `said` and
`chat` carry `npc`. On the engine it is the server page's to say (engine/SPEC.md 3.3; the client page's is refused
`wrong_role`), and the owner has each line once.

**Fixed: a page left for another stayed connected** ([#21](https://github.com/sarmiena/Basedverse/pull/21)). Chrome (148 on) keeps a page that a tab leaves, its sockets
open, frozen, in its back/forward cache, and never closes them: visit-client went on having it, so a person who
went to another page in the tab was still in their room, their visit up, their mailbox not filling. visit.js now
says `bye` as the browser hides the page, and visit-client ends it as if it had closed (1001); back to it, it
connects again. The browser test's "the person's page gone" check failed on CI, whose Chrome is newer, for this.

**What an integration does about it:** nothing. A room with a figure that talks may name its object
`visit:npc:<id>` and say its lines with `v.sayAs` (visit/INTEGRATING.md step 5) instead of drawing a bubble into its
scene. `bye` is visit.js's and visit-client's; a relay passes it on as anything else.

## v1.0.1 — 2026-10-29

**The tests on every push, on a GPU** ([#19](https://github.com/sarmiena/Basedverse/pull/19), Keyvan's). A workflow
(`.github/workflows/ci.yml`) runs the README's tests (the lobby, both unit suites, both end-to-end suites, and the
browser test) on every push and pull request, on a self-hosted runner with a GPU, so the browser test's Chromes
draw on it and never in software; its screenshots and logs are kept with the run. A fork's pull request runs there
too, once a maintainer approves it.

**Fixed in the browser test:** the chat checks counted every bubble over a speaker, and a fake microphone's tone (a
beep every 500 ms) could put a 🔊 mark over someone at any moment, failing them now and then. They count the lines
said.

**Fixed: chat lines from before the page, in time order.** A line from before the page (one kept for you, one from
another day) went just above the chat window's first note, after any others from before the page, newer ones
included: a line from two days ago that came after one from a moment ago was drawn under it, and under the wrong
day. Each now goes where its time puts it, and the days over the log follow. The browser test's check for it failed
now and then for this reason (on CI first); it now makes that order on purpose.

**What an integration does about it:** nothing. The protocols are 1.0.0's; the fix is in visit.js's chat window,
which comes with visit-client.

## v1.0.0 — 2026-10-29 — the engine ([#17](https://github.com/sarmiena/Basedverse/issues/17))

**Your room runs in the engine, a headless Chromium beside visit-client, and your browser is one more client of it**
([engine/SPEC.md](engine/SPEC.md), [engine/INTEGRATING.md](engine/INTEGRATING.md)). The room's page (its scene, its
agents, its physics, its interactions) runs in the engine's container always, signed in with a key of its own; the
person's page, at the desk or on a laptop at a coffee shop, connects through your server's relay and draws what the
room sends, as a visitor does. The owner is the room's visitor (`who.owner`): the room spawns, walks and draws them.
No browser reaches `127.0.0.1` for anything any more: visit-client answers on the compose network only, and your
server relays the person to it. **Breaking for every room that hosts.** The lobby protocol did not change: an
office on 0.22 and one on this meet, visit and are visited as before, so nobody else moves when you do.

In visit-client: page roles (`hello.role` host or user; a page without a role is both, as today), the relay preface,
`--listen`, a second token (`--user-token-file`), the owner's visit as a pair of local visits. In visit.js:
`Visit.connect({ url, role })`, `v.home`, `v.owner`, `visitors[i].owner`, `v.world({ three, renderer, self })` for a
page with no scene of its own, `world.point(target)`, `world.atHome`, `world.room`, a host's `look(visitor)` hook, the
stage's first-person home view. Fixed for everyone: an `EdgesGeometry` or `WireframeGeometry` travels as its lines
(it arrived as a warning and a lost object); a user page's own room counted among the plots round it.

**What an integration does about it**, in this order; the Sweatshop did it in a day and then spent a day at the
desk on what the split breaks, and every one of those is written down so you need not:

1. **Read [engine/INTEGRATING.md](engine/INTEGRATING.md) whole**, then its "Upgrading: a room that hosts today"
   before touching anything. Tag your room as it is (`git tag before-engine`) so it can go back.
2. **Containers.** visit-client on the compose network (`VISIT_LISTEN=0.0.0.0`, no port published, your server by
   name in `VISIT_ORIGINS` with your proxy's addresses); two token files, the host's and the user's, written by your
   launcher each start; the `engine` service built from `engine/`, its key made with `auth-client key add engine`
   and given to it alone, `ENGINE_ROOM_URL=http://<your server>/room?role=host`. Never recreate the engine with a
   bare `docker compose up -d engine`: it recreates visit-client without your launcher's environment.
3. **Your server.** Serve `/visit/visit.js` from visit-client; relay `/visit/ws` to it with the preface and the user
   token (one a session, 1 MiB buffered then 4408); say what runs at `/visit/mode`; serve the room's page to the
   engine's key only; retire `/api/visit`. Add a settings route (the Sweatshop's `/api/room`) your pages post to and
   your snapshot carries: the environment, the person's theme, the owner's look.
4. **Split the page by role** (one file, `?role=host` for the engine, nothing for the person). The engine's page:
   `window.visit = await Visit.connect({ ...window.VISIT_ENGINE, role: "host" })`, your scene and hooks, nothing of the
   person's. The person's page: `Visit.connect({ url: "/visit/ws", role: "user" })`, no room of its own,
   `v.world({ three, renderer, self: "room" })`, your HUD, a sign-out.
5. **Move what the browser decided to your server.** Grep the page for `localStorage`, `matchMedia`,
   `prefers-color-scheme`, `location.search`, `devicePixelRatio`, `innerWidth`: the engine's page has none of the
   person's. The environment, dark mode (headless Chromium is light: white walls under a dark theme), the owner's
   look: through the settings route, every page following the snapshot.
6. **Marks by name, not `userData`** (it is stripped to `visitor`, `visitPoint`, `visitRider`): what is a floor, rock,
   a roof to lift, anything your page reads of its own scene. A deformed primitive travels as its recipe: copy it
   into a plain `BufferGeometry` first. Visibility you toggle for your own camera is done on the received scene.
7. **The owner is a visitor.** Physics your page did to its owner (a jump) goes into `move`, for everyone. The room
   draws its owner itself (`look: who => who.owner ? "mine" : undefined` in `visit.host`), with the look from your
   server, since Visit's clips for an avatar are walk, idle and ride, not your seat or your drink; the person's page
   shows that copy (`self: "room"`) and hides its own dude at home. Clicks: the person's page casts its own ray into
   the received scene and calls `world.point(hit.point)`; the hand by `userData.visitPoint` there; your division of
   clicks kept (`visitor.owner` is you; screen-only entries never from a point); the reach rule said on the page.
8. **Prove it before you trust it.** The engine's `/health` says `hosting`; its log is your only screen
   (`console.info` in the room's page lands there: log each point and each `tell` while proving; `ENGINE_DEBUG=1`
   gives `/debug/eval` on the compose network, for the proving alone); the person's console; the ⏱ report before and
   after. Reload the person's page after every deploy before judging anything. Then from another device.

Each thing that went wrong at the Sweatshop's desk is a row in INTEGRATING.md's troubleshooting table, symptom to
cause, and an item in its checklist.

## v0.22.0 — 2026-10-28

**auth-client in a container of its own** ([auth/INTEGRATING.md](auth/INTEGRATING.md), step 4). auth-client
answered on `127.0.0.1` only, so a server in a container could reach it only by sharing its network namespace
(compose's `network_mode: "service:<your server>"`), and each restart of the server left auth-client in a network
that was gone: every route refused until auth-client restarted too, and restarting both at once can leave it down.
Now `AUTH_LISTEN=0.0.0.0` (`--listen`) has it answer on its container's own network, where your server reaches it by
the service's name, with no port published: either restarts on its own. The default is still `127.0.0.1`.

**The mailbox, voice messages, and whispers left for someone away** (visit/SPEC.md 8.9, 8.12).

- **📬 The mailbox.** A line meant for you (a whisper, a line in your room's chat, an @mention) that comes while
  nobody is looking at your chat stays unseen until you read it. Your visit-client keeps the mark in its database, so
  a reload or a restart keeps it. The chat window shows 📬 and how many, even when it has faded; a click lists them,
  and a click on one answers there. Looking means the page is shown and focused, with a key, a click or the pointer
  used in the last 2 minutes (`v.attention`, said by the chat window). For a room's own UI: `v.unseen`, `v.read()`,
  the `unseen` event.
- **🎙 Voice messages.** Recorded by the box (a minute at most), kept and passed on as a picture is: in a room, a
  room's chat, or a whisper to someone you are linked with; never through the lobby. A line plays it from ▶. 🖼 has a
  Voice tab. `v.share(blob)` takes a recording (WebM, Ogg or MP4, at most 2 MB), and the line gives its `secs`.
- **⏳ Whispers left for someone away.** `/w <name>` for someone not in the lobby (whom you have whispered with, or a
  guest) is kept by your own visit-client and passed on through the lobby once you are both in it. The lobby still
  keeps nothing. Text only. The 📬 list shows them, each to take back. `v.awayTargets`, `v.held`, `v.unhold()`.

**When a line came.** Each line in the chat window has its time before it, dim, as WoW's chat timestamps do (the
time as your browser writes one), and when the log holds more than today, each day's first line has its day over
it: the chat now keeps lines across reloads and days, and the mailbox brings back old ones.

**Tab in the chat window** ([#15](https://github.com/sarmiena/Basedverse/issues/15); visit/SPEC.md 8.9). With no
name to finish, Tab moves the box on to the next place a line can go (Say, Tell whoever you last whispered with,
your room, each linked room, Lobby, and round again; Shift+Tab: back), keeping what is typed. Before, it took the
focus out of the box. A name over the box still comes first, and a command in the box (`/w …`) says where itself.

### What an integration does

1. Nothing, if auth-client runs on the host's network beside your server, or you keep `network_mode`.
2. With your server in a container: auth-client as a service of its own on that network, `AUTH_LISTEN=0.0.0.0`,
   no `ports:`, no `network_mode`; your server asks it at the service's name (`AUTH_HOST` in step 5's sketch).
3. **visit-client's database: `visit-client migrate`** before starting it (schema 2: the mailbox's marks, whispers
   left for someone away). A visit-client of this release refuses a database at schema 1 and says so.
4. Nothing for the chat window: `Visit.chat` does the mailbox, voice messages, whispers left, times and Tab. A page that
   draws its own chat: `v.unseen` and the `unseen` event, `v.read()`, and `v.attention(on)` while someone looks at it
   (else every line meant for its user counts as unseen); a voice message is a line's `media` item with `secs`. A page
   that relied on Tab leaving the chat box gets the box's own Tab.

## v0.21.1 — 2026-10-28

**Your workroom from another device, and local services relayed** ([auth/INTEGRATING.md](auth/INTEGRATING.md),
steps 9 and 10). A workroom's server in a container cannot reach this machine's `127.0.0.1` (on Linux and in WSL,
`host.docker.internal` does not lead there), so a local service it relays (an agent's console, say) now **connects
out to the server**, at the port the server publishes, with an API key of its own, and asks it for work: it listens on
nothing, and the server, which checks the session first, is its only way in. And another device reaches the
workroom through an **HTTPS proxy** of the user's choice (Tailscale's `tailscale serve`, Caddy with its own
certificate on the LAN, their own), on a listener of the server's own, where every request is another device's:
the `__Host-session` cookie, the page's origin from `Host`, the proxy's word for the address, and no Visit (its page
connects to visit-client directly, so it stays on this machine). Nothing in visit-client or auth-client changed.

### What an integration does

1. Nothing, to stay as it is (visit-client and auth-client 0.21.1 are 0.21.0's, renumbered).
2. To use the workroom from another device: offer it (the `/basedverse:visit` skill asks), then steps 9 and 10.

## v0.21.0 — 2026-10-28

**auth-client: a sign-in for your workroom** ([auth/INTEGRATING.md](auth/INTEGRATING.md)). A workroom's server took
whoever could reach it for its owner, and the `Host` check Visit's guide asked for (step 3) stops DNS rebinding,
not a program on the network, which can write any `Host` it likes. auth-client is a small program beside
visit-client, on `127.0.0.1`, that only the workroom's server talks to: the owner's account is made in a terminal
(there is no sign-up page, ever); passwords are Argon2id; sessions (kept by their hash only) last 7 days unused or
30 in all; guesses slow down; scripts and agents get API keys; and visit-client's token goes only to a signed-in
session (`/v1/visit`). The rule that comes with it: **every page and route checks the session, unless the user
says otherwise.** It is in this release beside visit-client, for every platform, with a sign-in page to start from
([auth/web/login.html](auth/web/login.html)).

**Each program its own database role.** visit-client used the database's superuser, so it could read anything in
it. Now it has a plain role, `visit`, and auth-client one of its own, `auth`, each owning its own schema, neither
able to read the other's tables (a fault in visit-client, which talks to the internet, cannot reach a password
hash). The superuser is for setup only: `auth-client migrate --admin` makes the roles, and moves a database made
by 0.20's setup over (its superuser renamed `basedverse` with a new password, visit-client's tables, with all they
hold, into its schema).

**Visit's guide, step 3, corrected**: listening on `127.0.0.1` is what keeps the network out (the `Host` check
stops DNS rebinding only), and `VISIT_ORIGINS` is to be set always.

### What an integration does

1. Get visit-client and auth-client 0.21.0. `bin/setup` gets both (`VISIT_CLIENT_PATH`, `AUTH_CLIENT_PATH`).
2. **The database's roles, once.** Stop visit-client, and back the database up if it holds anything you would
   miss. Then run `bin/setup` again: it moves a 0.20 database over (it asks first) and writes `VISIT_DATABASE_URL`
   (now role `visit`), `AUTH_DATABASE_URL` and `VISIT_DATABASE_ADMIN_URL` into your `.env`. A database it did not
   start (one in your own compose file, say): `auth-client migrate --admin <its superuser's URL>`, with
   `VISIT_DATABASE_URL` and `AUTH_DATABASE_URL` set to the URLs as they will be (roles `visit` and `auth`, new
   passwords), and, when visit-client's role is that superuser, `--new-admin <the superuser's URL under a new name
   and password>` (auth/SPEC.md 5). Your launcher passes `VISIT_DATABASE_ADMIN_URL` to nothing.
3. `visit-client migrate` (nothing new to migrate), then start visit-client with its new `VISIT_DATABASE_URL`.
4. **Sign-in, offered** (the `/basedverse:visit` skill asks, and keeps the answer in `VISIT.md`): with a yes,
   follow [auth/INTEGRATING.md](auth/INTEGRATING.md): the owner's account (`auth-client user add`, typed by the
   user), auth-client started by the launcher with a new service token each run, one check before every route,
   `/login` from the template, `/v1/visit` in place of your own `/api/visit`, and the route test. Without it (for
   now): keep your server on `127.0.0.1`, and set `VISIT_ORIGINS`.


(v0.20.2 was tagged but never released: this is it, with visit.js saying its version.)

**Chat you can read, as WoW has it.** In the chat window, whoever said a line is in their own colour: one of seven,
by their key, so the same on everyone's screen, as WoW colours a name by its class. A line too long for one row goes
on indented under its first, and lines have a little room between them. Your own lines show the name you go by
(`setName`), as everyone else has them; until now they showed your office's until a reload.

**A mount switched to at once now shows.** A room you visit takes one of your mounts' models every half second, and
dropped one that came sooner; it asks for each only once, so getting on one mount and straight onto another left
you riding nothing it could draw, for the rest of the visit. Now a sooner one waits its turn.

**The browser test draws on the GPU** (#9). Its two Chromes drew in software (SwiftShader), which took every core
the machine had; on a GPU, a run takes about 2½ minutes and hardly any of the processor. On Linux they use ANGLE on
OpenGL: on Vulkan (NVIDIA's driver, at least), Chrome's GPU process crashes as soon as a page makes or drops a second
WebGL context, as Visit does for the room you visit, and every context goes with it. The test stops at once if a
Chrome would draw in software, and keeps each Chrome's own log (`chrome-<port>.log`) with the visit-clients'.

### What an integration does

1. Get visit-client 0.20.3 (then `visit-client migrate`, as after every upgrade: nothing new to migrate this time).

## v0.20.1 — 2026-10-27

**People go by their own names.** What you say showed as your office's name ("[Duckroom] says: …"), never yours.
Now a room tells Visit its user's name, and everyone linked with you sees it: with your lines and whispers, over your
voice, in a room's voice, and in their panel ("thinger burgoon (Duckroom)"). A room is still named by its office
("Gooshy's room"). A lobby line shows your name to those linked with you, your office's to the rest (the lobby knows
offices only). An older Visit shows your office's name, as before.

**@ mentions.** Type `@` in the chat box and pick whom you mean from the names over it (up and down, Tab or Enter,
or a click); the same list now shows after `/w` and `/room`. A line that mentions you (`@` and your name) stands
out in your chat window and chimes, whatever its scope; the `chat` event's line says so (`mention`).

### What an integration does

1. Get visit-client 0.20.1 (then `visit-client migrate`, as after every upgrade: nothing new to migrate this time).
2. If your room knows its user's name: `visit.setName(name)`, once connected and whenever it changes.

## v0.20.0 — 2026-10-27

**visit-client needs a database now: Postgres, beside it.** It keeps your chat there (every line, yours too: a
restart or a reload keeps it, and the chat window's log scrolls back through all of it), the pictures and links
shared in it, and whom your room keeps out. Its schema comes with each visit-client: `visit-client migrate` makes the
database ready, and brings it up to date after every upgrade. A start checks it, and says what to run if it is not.

**Pictures and links in chat**, as messaging apps have them:

- **Paste a screenshot** (or drop a picture) into the chat box: it goes with your line, to a room, a room's chat,
  or a whisper to someone you are linked with (never through the lobby: it carries text only). Each visit-client
  keeps every picture it gets, once, and asks for one it lacks from whoever passed the line on. Click one: full size.
- **Links get previews**: as you type a link, your visit-client fetches its page once, and your line carries what it
  is (title, description, site, picture). Those you send it to never contact the site.
- **🖼 by the box**: the pictures and the links shared in the conversation the box talks to, newest first.
- From code: `visit.share(blob)`, `visit.say(text, to, { media, links })`, `visit.preview(url)`, `visit.media(id)`,
  `visit.history()`, `visit.shared(conversation, kind)`.

**Fixed: a visitor's body and mount twice.** A host page that lost its visit-client a moment (a restart, a blip)
forgot its visitors but left their bodies and mounts in its scene; they came back with their visits, made again:
two of each (an empty mount beside the rider). Now they go with them.

**Voice across a plot's side, a room's voice, no echo, and keeping people out.**

- **Across a plot's side.** You and a friend, each at home in your own room, hear each other when your worlds put
  you near: both of them, each its own (45 m, the nearer the louder, from where your world has them). Stepping
  over the line no longer cuts a conversation off. Rooms with a world (`visit.world`) need do nothing.
- **A room's voice**, as a game's voice chat: 🎧 by the chat box joins the voice of the room it talks to (else your
  own), and everyone in it hears everyone else, wherever they are, while their microphones are on. One at a time;
  a line over the box says whose and who is in it (🔊: speaking), and stays while the rest fades.
  `visit.joinVoice(key)`, `visit.roomVoice`.
- **No more echo.** Standing near someone and on the phone with them (or in a room voice with them), you heard
  them twice. Now you hear each person one way only: in person first, then the call, then the room voice. The call
  goes quiet while they are near, and comes back as they walk off.
- **Keeping people out of your room.** In the panel's row for someone: ban voice, ban chat, and Kick from voice
  (while they are in your room's voice). A ban is kept in your state file until you lift it: out of your room's
  voice, they are not heard in it and hear none of it; out of its chat, their lines are not said in it and they
  get none of its lines. They are told. Calls are apart. `visit.ban(key, { voice, chat })`, `visit.bans`.

**A room's chat is a party.** Talking into a friend's room went one way: you could say a line into Gooshy's room,
but Gooshy could not answer in it, only into yours, so a conversation split across two rooms and nobody saw all
of it. Now every room has one chat, like a party in a game:

- **Everyone in a room, and everyone linked with it, either way, has every line said in it**, wherever they are:
  its owner's, a visitor's, a linked friend's from their own room.
- **Its owner says a line in it**: "To your room" among the chat window's choices (while anyone is linked with
  you), or `/room` alone; `visit.say(text, "room")` from code.
- **Shown as channels**: `[Gooshy's room] [Gooshy]: sup`, `[Your room] [Gooshy]: sup`, as the lobby's are, your
  own lines too.
- **Names finish themselves**: after `/w` or `/room`, the names it could be show over the box, and Tab finishes
  one (again: the next). A name is taken once a space follows it, or on Enter (all of it, or the one name it
  starts), no longer as soon as it is typed (a longer name could follow).
- **`/r`** with nobody having whispered to you yet goes to whom you last whispered.
- **A reload keeps the chat.** Your visit-client keeps the last 100 lines you have had, yours too, in memory
  (never on disk), and gives them back to the page when it comes back, with any that came while it reloaded. The
  window keeps where your lines go, too.

An older Visit has a room's lines only while in that room, and its owner's never; it hears nobody across a plot's
side, and joins no room's voice.

### What an integration does

1. **Give visit-client a database.** `bin/setup` (run it again: it keeps your `.env`'s answers) starts Postgres in
   Docker for it, or takes the URL of one you have, and writes `VISIT_DATABASE_URL` into the `.env`. By hand:
   INTEGRATING.md step 1. Your launcher passes it on with the other `VISIT_*` settings (`--database` as a flag).
2. Get visit-client 0.20.0, and **make its database ready**: `visit-client migrate` (setup does it). From now on, run
   it after every upgrade, before starting the new visit-client. Bans in your state file move into the database by
   themselves.
3. Nothing else for the chat window, the panel, and voice: they are Visit's.
4. If your room draws chat itself from the `chat` event: a line may carry pictures (`media`) and links (`links`),
   with its `conversation`; and a `scope: "sim"` line may now come for a room you are
   only linked with (its `to`, the room), and `visit.say(text, "room")` says one in yours. After a reload, the
   lines from before come first, marked `old`: no bubble or sound for those.
5. **Leave Visit's things out of your physics** (MODELS.md, "Your physics"): your floor, walls and raycasts skip
   anything marked `userData.visitor` or `userData.visitRider` (visitors' bodies, their mounts). A floor check that
   hits a rider's own mount stands them on top of it.
6. A room that draws its own 🔊 marks from `visit.voices` at home: a friend across your plot's side may be in it
   now (by their key; their room's `visit:me` in your world). A room without the panel offers `visit.joinVoice` and
   `visit.ban` where it likes.

## v0.19.0 — 2026-10-27

**One way of placing people, and bodies that show.** A friend's body didn't show in your room, or showed buried,
because positions meant "eyes" in one place and "feet" in another, and every room had to draw visitors' models
itself. Now:

- **Positions are feet**, everywhere: your `spawn` and `move` return where a visitor's feet are (0 on a floor at 0),
  as `world.frame` takes your own user. Eyes are above that, and only the camera is there: their own model's
  `eyes` point, else your room's `eye` (1.6 m).
- **Visit draws your visitors' own models**, at their feet, facing their way, playing `idle`, `walk` and `ride`.
  Your room draws its own figure for a visitor only where `visit.visitors[i].look` is "mine".
- **A model that can't be shown is said, both ways.** If your visitor gives none (`avatar_none`) or it doesn't
  read, they show as your model, and both panels say why (`visit.visitors[i].problem`; their `body` event).
- **`Visit.checkModel`**: your model, checked as other rooms will read it (feet, centre, size, its own place, what
  its clips move, shaders, size, reading back). `visit.avatar` and `visit.possessions` run it as you give them.
- **[MODELS.md](visit/MODELS.md)**: how to place people and make bodies and things, for whoever implements a room.
- **The chat window**: half as big again, and a soft sound with each line that comes (a whisper rises; 🔔 by the
  box turns it off).

**Physics are your room's.** Visit has none of its own any more. It carries what your room needs to decide, and your
`spawn` and `move` say where a visitor is, their height included.

- **Gone from Visit:**
  - floating arrivals down at 1.5 m a second;
  - flying at 4 m a second, and the `fly` option in `visit.host`;
  - lifting riders onto their mounts;
  - moving riders at their mount's pace.
- **What your room gets instead:**
  - `input.up` (Space or Page Up, X or Page Down) in `move`;
  - `at.air` in `spawn`: how high above their own floor one stepping in from a world was;
  - `who.riding` in `move`: { id, name, fly, speed, lift }.
  - What happens is yours. INTEGRATING suggests the old behaviour: arrivals come down gently, riders sit their
    mount's `lift` higher at its pace, and flying mounts fly.
- **Rooms say a little more:**
  - `move` may return `air` (how high above the floor) for a mount's fly clip;
  - `walk: { speed, mounts: true }` tells a rider's page it walks at its mount's pace.
- **Visit still does the plumbing:** `mounts: false` keeps mounts out; a mount stands under its rider's feet (`eye`
  below their eyes, then `lift`); flying keys and `air` reach the room.
- **A visitor's own world has them as high as the room does:** its pose's height, less the room's `eye`. That
  replaces "where I stepped in, plus how far the room has moved me since", which could leave their screen up in the
  air when a room brought them down at once.

### What an integration does

1. Get visit-client 0.19.0. Read [MODELS.md](visit/MODELS.md).
2. **Return feet from `spawn` and `move`**, not eyes: where you returned 1.6 (or your eye height) on the floor,
   return 0. Say `eye` if your visitors' eyes are not 1.6 m over their feet as your model.
3. **Stop drawing visitors' own models yourself**: Visit does. Draw your own figure only where `look` is "mine",
   at `pose` (their feet). `visitors[i].avatar` is null from now on.
4. Check your user's body: `Visit.checkModel(body, { three: THREE })`, and fix what it says.
5. If your room relied on Visit for flying or falling, do it in `move` (INTEGRATING step 5 has a sketch): honour
   `at.air` in `spawn`, bring visitors down or fly them, lift and pace riders. Without it, nobody flies in your room,
   one arriving in the air stays there until your `move` says otherwise, and riders go at walking pace.
6. `fly` in `visit.host` is gone: drop it (it does nothing).

## v0.18.1 — 2026-10-26

**Mounts are your room's, not Visit's.** Visit is the plumbing: it carries what your room makes and puts it under its
rider wherever they go. What there is to ride is your room's call. So Visit's own horse and flying carpet are gone
(`visit:horse`, `visit:carpet`). `v.mounts` lists only what your room gives with `v.possessions`, and the panel's
"your mount" row and M appear only then. The Sweatshop's horse and carpet are now its own.

**Worlds: rooms drawn farthest first.** At a plot's edge, something see-through in a nearer room (a name over a
head, a window) could disappear under the farther room's ground, drawn after it. Now the sky is drawn first, then
the ground between plots, then each room from the farthest to the nearest.

### What an integration does

1. Get visit-client 0.18.1.
2. If your room used Visit's horse or carpet (`v.ride("visit:horse")`), give your own (`v.possessions([...])`): a
   model each, with `idle`, `walk` and `fly` clips if you like.

## v0.18.0 — 2026-10-26

**Mounts: possessions you bring along.** What an office's user owns now goes with them to the rooms they visit.
For now that is mounts, on the ground or in the air.

- **Visit's own, for everyone:** a horse (twice walking pace) and a flying carpet (it flies, twice walking pace).
  Every Visit draws them itself, so nothing is sent.
- **Your own:** `v.possessions([{ id, name, object, mount, fly, speed, lift }])`. Your visit-client keeps them,
  tells every room you visit what you own, and sends a model only when a room asks.
- **Riding:** M, or the panel's "your mount" row (`v.ride(id)`; `v.riding`). Wherever you are, the room you are in
  draws your mount under you, lifts you onto it, moves you at its pace, and animates it: walking, running, flying,
  still. A flying mount flies with Space and X, as in WoW.
- **The room decides:** `mounts: false` keeps mounts out (a rider gets off at the door). `fly: false` keeps anyone
  from flying, flying mounts too. A room that says nothing lets its visitors ride, and fly a mount that flies.
- **At home:** your world draws your mount under your feet, so your visitors see it. Your room lifts you onto it
  and walks you at its pace (`v.rideLift`, `v.rideSpeed`, `v.rideFly`).
- **Animation by clip names:** a mount's `idle`, `walk`, `run` and `fly`; a rider's avatar's `ride` (or `sit`).

Also: an end-to-end check of 0.17's `air` on the `enter` pose, which the PR left as it was.

### What an integration does

1. Get visit-client 0.18.0 (`bin/setup` again, download; or this release).
2. Draw your visitors at their pose's height (`pose.y`, less their eyes), so riders sit on their mounts (and flyers
   fly). If your visitor pose is not 1.6 m above your floor, say where it is (`eye` in `visit.host`).
3. With a world: lift your own user onto their mount at home (`visit.rideLift`) and walk them at its pace
   (`visit.rideSpeed`); pass `facing` to `world.frame` if they face another way than they look.
4. To keep mounts out of your room, `mounts: false` (a deviation from vanilla: note it in VISIT.md).

## v0.17.0 — 2026-10-26

**Flying, a room's choice** (Keyvan's, #7). A room lets its visitors fly with `fly: true` in `visit.host` (or
`{ speed, max }`, in metres a second and above the floor); it is off unless the room says so, and read at every move.

- **Keys, as WoW flies:** Space or Page Up up, X or Page Down down: a visitor's input gains `up` (−1, 0, 1).
- **Your `move` needs no change:** it still sees each visitor on your floor, stairs and lifts included; Visit keeps
  how high above it they are (4 m a second by default, never below the floor, never above `max`).
- **No flying here:** a visitor that is in the air (one stepping in from a world while flying: `air` on the `enter`
  pose) floats gently down to your floor, at 1.5 m a second.
- **Arriving in the air:** a page flying at home passes its user's height above its floor to `world.frame` (`air`),
  and a plot it steps into has it that high.

Known: on a slow machine, a visitor floated down in someone's plot can see itself a little above the floor on its
own screen (everyone else sees it on the floor); its world measures its height in a plot from the first update it
reads. Left as is until it shows up in use.

### What an integration does

1. Get visit-client 0.17.0 (`bin/setup` again, download; or this release).
2. Nothing more: without `fly`, nobody flies in your room, and anyone arriving in the air floats down. To let them
   fly, `fly: true` in `visit.host`. To fly into friends' plots from your own world, pass your user's `air` (and
   `up`) to `world.frame` while they fly.

## v0.16.0 — 2026-10-26

**Whispers, and one row a person.**

- **`/w name` whispers** to one person: them alone, wherever they are, linked or not, as in WoW. The lobby passes
  it on and keeps nothing. `/r` answers whoever last whispered to you. Saying into a friend's linked room, which
  `/w` did in 0.15, is now `/room name`. Colours: a whisper pink, a room blue (WoW's party), the lobby gold. In
  code: `v.say(text, { whisper: id })`, `v.whisperTargets`, `chat` events with `scope: "whisper"`.
- **The panel: one row a person.** Everyone in the lobby and everyone you are linked with, either way, appears once,
  linked first: "Gooshy · linked", "· in your room", "· you are in their room". Click the row for the rest: where
  each of you sees the other, Go there, Put in my world, how they look in your room (their model / our model),
  Kick, and Unlink (every link between you two, both ways, and no longer a guest, since their world would only come
  back). No more separate rows for your links, your visitors, who watches you, and the lobby.
- **Visitors look like their own model by default** ("visitors look like: their model"). A room's state from before
  0.16 said "your models" whether its user chose it or not: it reads as their model now. Choose "our model" in the
  panel to have it back (for everyone, or for one person in their row).
- `/` opens the chat window with the `/` typed, as WoW's slash key does, for a command.

**The lobby**: whispers are new in it (`whisper`; the lobby view says who takes them). Update it
(`bin/deploy-lobby`).

### What an integration does

1. Get visit-client 0.16.0 (`bin/setup` again, download; or this release).
2. With the panel and its chat window, nothing more.
3. If your room's VISIT.md wants visitors as your models, set it once (`visit.useAvatars("mine")`, or the panel's
   "visitors look like"): a state from before 0.16 now reads as their own.
4. A room with its own chat: `/w` is a whisper now (`v.say(text, { whisper })`); `chat` events can have
   `scope: "whisper"`.

## v0.15.0 — 2026-10-26

**Chat, as in a game.** A chat window, bottom left: Enter to type a line, Enter to say it, Esc to stop. It fades
when nobody has said anything for 20 s, and comes back with the next line, or Enter. A line goes one of three ways:

- **Say** (the default, `/s`): everyone who can see you. That is the room you are in, as before, and now also
  everyone who sees it from outside (in their world, in a corner): over your head, and in their chat.
- **Into a linked room** (`/w name`): everyone in the room of a friend you are linked with, either way, wherever
  you are. It shows in their chat. `/r` answers whoever last said a line into a room of yours.
- **Lobby** (`/1`): everyone in the lobby, in their chat.

Where a line goes is shown before the box, and can be picked there; it stays for the next line. Each scope has its
own colour in the window: say white, a room's pink, the lobby's gold. In code: `v.say(text, to)` (`to`: nothing,
`{ key }`, or `"lobby"`), `v.chatTargets`, `v.lobbyChat`, `v.chatLog`, and every line in the `chat` event with its
`scope`. Bubbles now also show over people on every plot in your world, and in a room seen in a corner.

The panel's Say box is gone: the chat window replaces it (`Visit.panel(element, v, { chat: false })` leaves it out,
for a room with its own; `Visit.chat(v)` makes one on its own).

**The lobby**: lobby chat is new in it (`chat`, `lobby_chat`; `welcome` says `chat: true`). Until a lobby is
updated (`bin/deploy-lobby`), Say and the linked rooms work, and the lobby's line in the window does not show.

### What an integration does

1. Get visit-client 0.15.0 (`bin/setup` again, download; or this release).
2. With the panel, nothing more: the chat window comes with it. If your room calls `panel.say()` (a key of yours to
   start a line), it opens the chat window now; you can drop that key, since Enter does it.
3. Make sure nothing of yours sits bottom left over the window; if something does, move the window
   (`--visit-chat-left`, `--visit-chat-bottom`) or yours. Your room's keys leave Enter and `/` alone.
4. A room that draws its own bubbles (no world): `chat` events now also come for lines in a linked room and the lobby
   (`scope`); draw over heads only those without one (or `v.chats`, as before).

## v0.14.1 — 2026-10-26

**Telemetry that says what is Visit's.** In a world, `world.render` draws your whole room (it is your room's own
drawing, in place of `renderer.render`), and the ⏱ counted it, and pictures encoded in the background, as Visit's
work. Now the corner adds up only Visit's own (scan, send, whole, landscape, world, voice), shows drawing on a line
of its own ("drawing your room and its plots: … ms a second, … a frame"), and pictures as how many were sent and how
long the background took. In `v.perfReport()`, drawing is the part `draw`.

### What an integration does

1. Nothing, beyond getting visit-client 0.14.1 (`bin/setup` again, download; or this release).

## v0.14.0 — 2026-10-26

**Telemetry, and no more stutter from redrawn canvases.** A room that redrew a canvas texture (a board, a screen)
while it had visitors or watchers stopped its page to encode that picture each time it went out: some 200 ms, every
second, for three boards. Now:

- **A canvas redrawn is encoded in the background** (by the browser, as WebP, off the page's main thread) and sent
  once it is ready, at most once a second. Mark a texture changed only when its picture did: every change still costs
  your visitors a download.
- **Telemetry, toggled from the panel's ⏱** (or `v.perf(true)`, remembered in the browser, or `?visit-perf=1`): a
  corner of the page shows, each second, its frames (how many, the slowest), its stalls (long tasks: 50 ms or
  more), and Visit's own work by part in ms (scan, send, whole, landscape, world, voice; pictures encoded in the
  background), with how much it had to do (visitors, watchers, plots, objects, landscape). "copy report" (or
  `v.perfReport()`) gives the last two minutes, a row a second, to share. Nothing leaves the page.

### What an integration does

1. Get visit-client 0.14.0 (`bin/setup` again, download; or this release).
2. If your room redraws a canvas texture on a timer, set `needsUpdate` only when the picture changed (compare its
   pixels, or what you drew): it is sent to every visitor each time.

## v0.13.0 — 2026-10-26

**The vanilla experience: what every room got by hand, Visit now gives.** Rooms that take the defaults look and work
the same for their visitors; INTEGRATING.md's new "The vanilla experience" lists them. New defaults:

- **A 🔊 over whoever you hear speaking**, drawn by Visit in your world and in a room you visit (`v.world({ speaking:
  false })` to draw your own from `v.voices`).
- **A phone in your room**: `v.phone(true, { at })` puts Visit's own desk phone there, in your scene, so everyone sees
  it: it shakes with RING RING while it rings, its handset is off its cradle while you have it to your ear, its lamp
  lit on speaker (`model: false` to draw your own). The panel gets **📞 call**, a button for each of `v.phones`.
- **Notes in the panel**: where a friend's world put your room (once it settles: not at every step of their dragging,
  nor twice for the same place), and a call that ended other than hung up.
- Chat bubbles now sit a little higher, so a 🔊 fits under them.

And basedverse is a **Claude Code plugin** (`/plugin marketplace add sarmiena/Basedverse`, then `/plugin install
basedverse@basedverse`): its `/basedverse:visit` skill lists Visit's features and what a workroom uses, answers
questions about them, plans an integration or an upgrade with you (vanilla unless you say otherwise), does it, and
keeps the workroom's `VISIT.md`: what it uses and every way it differs from vanilla, in your words, so that an upgrade
keeps your choices.

### What an integration does

1. Get visit-client 0.13.0 (`bin/setup` again, download; or this release).
2. If your room draws its own phone, pass `model: false` to `visit.phone` (or drop yours for Visit's: the vanilla
   one). If it draws its own 🔊 marks, pass `speaking: false` to `visit.world` (or drop yours). If it shows its own
   notes of where a friend's world put your room, drop them (the panel shows them now) or keep them: both is double.
3. Write down what you kept as your own (a `VISIT.md`): the `/basedverse:visit` skill does it for you.

## v0.12.0 — 2026-10-26

**Landscapes: what never changes in a room is sent once, and kept.** A room marks its ground, walls, trees and
furniture as landscape (`userData.visitStatic = true`, SPEC 8.10). Visit sends the landscape to each visitor once:
their visit-client keeps it on disk, by its hash, so a visit, a world's watch, a reload or a reconnect needs only
the rest. The host's page also stops looking at it 30 times a second. And **a friend's plot stays when they go
offline**: your world keeps drawing their last landscape where it was, marked offline, and you walk into it (its
walls stop you; nobody is there to walk you). It goes live again when they come back, and is forgotten if they
shut their door to you or un-star you.

- visit.js: `userData.visitStatic`, `v.landscapeChanged()`; `world.plots`' `offline`; kept plots drawn and walled in
  your world (`Visit.map` and the panel say which are offline). Every uuid in a landscape is renamed in order, so
  the same landscape is the same JSON, and the same hash, at every load.
- visit-client: the page frame flag bit 5 (this room's landscape); the page messages `plot_keep`, `plot_load`,
  `plot_forget`; to the page `landscape`, `landscapes`, `plot_forgotten`, and `ready`'s `kept`; the link control
  messages `landscape`, `landscape_want`, `landscapes`, and stream 3 (a landscape); `--cache-dir` /
  `VISIT_CACHE_DIR` (default: `landscapes/` beside the state file). A visitor on 0.11 or older gets the whole room,
  landscape and all, as before.

### What an integration does

1. Get visit-client 0.12.0 (`bin/setup` again, download; or this release).
2. Mark your landscape: `obj.userData.visitStatic = true` on what never changes (not people, screens, signs or
   anything a visitor clicks to change). Nothing breaks without it: your room is sent whole, as before.
3. If your page keeps its own state file setting (`VISIT_STATE_FILE`), landscapes go beside it; else set
   `VISIT_CACHE_DIR`, or they last for the run only.

## v0.11.0 — 2026-10-26

**Chat: type a line, and it shows over your head.** Everyone in the room you are in sees it (SPEC 8.9), and
nobody else. Nothing to join. visit-client carries it, room to room, and checks it the same for every room:
plain text, at most 200 characters, at most 5 lines every 10 s.

- visit.js: `v.say(text)`, `v.chats` and the `chat` event; bubbles drawn over speakers in your world (`v.world`,
  `bubbles: false` to draw your own) and in another's room; `Visit.bubble(THREE, text, unit)` for a room drawing its
  own; the panel's say box (last in it), and `panel.say()` to focus it from a key of yours.
- visit-client: the page message `say`, to the page `chat`; the link control messages `{"say": …}` (visitor to host)
  and `{"said": …}` (host to visitors). A 0.10 office in the same room neither sends nor shows lines (it ignores
  them).

### What an integration does

1. Get visit-client 0.11.0 (`bin/setup` again, download; or this release).
2. With a world, bubbles show by themselves; without one, draw them from `visit.chats`. If your page has keys of
   its own (WASD, say), have them ignore key presses in a text box, as the panel's say box is one. Optionally, a key
   to start a line: `panel.say()`.

## v0.10.0 — 2026-10-26

**Your world is yours alone: no more edges; see where a friend has put you instead.** Where your friends' rooms
sit round yours was always your own layout, but two offices could also agree an edge, a side shared by both.
That is gone: nobody proposes, agrees or waits for anything. Instead each world tells each friend in it where their
own room sits (SPEC 8.4, `seen`), and nothing else of it: not its other friends, nor where they are. On the Map,
pick a friend to see their view of the two of you; put each other flush on your own maps, if you like, and walking
across is as seamless as an edge was.

- visit.js: `v.seen` ([{ key, name, at: { dx, dz, turn, size } }]) and the `seen` event; a world (`v.world`) tells
  its friends by itself. Gone: `v.edges`, `v.edgeProposals`, `proposeEdge`, `acceptEdge`, `declineEdge`,
  `removeEdge`, `world.plots`' `seen` and `edge`, the outlines of agreed neighbours, and the panel's edge
  proposals (Agree / No).
- visit-client: the page message `seen` (`key`, `at` or null), to the page `seen` and `ready`'s `seen`; the link
  control message `{"seen": …}`. Gone: `edge_propose`, `edge_accept`, `edge_decline`, `edge_remove`, `edges`,
  `edge_proposed`, `edge_declined`, `ready`'s `edges`, the link's `edge`, `edge_ok`, `edge_no`, `edge_off`, and
  the error `no_link`. A state file with edges still loads; they are dropped. An older office's edge proposal
  goes unanswered, and it never hears where it is in yours.

**Voice: decided by visit-client, heard three times as far.** Who hears whom in a room was each page's choice (and
its relaying of one visitor's voice to another); now the room's visit-client decides, the same for every room. A
page sends its user's voice once, to its own visit-client, and tells it where everyone in its room stands (its user,
its phone, its visitors: `voice_where`, which visit.js sends by itself); the room's visit-client sends each voice to
whoever is near the speaker, passes visitors' voices on, and does the phone's speaker. A visitor's position is the
room's word (it moves them), not the visitor's. Voices carry 45 m (was 15), sent 15 m farther to fade in (was 5).

- visit-client: the page messages `voice_where` and `speaker`; to the page `voice_near` (who is near, as the room's
  visit-client says) and `ready`'s `voice_range`; the link control message `{"near": …}`; the error `no_call`. A
  page's voice frame (bit 3) now says where it may go (1 the room, 2 calls) instead of naming a visit; pages no
  longer send voice passed on (bit 4), visit-clients do. The datagrams are the same, so 0.9 offices still talk with
  0.10 ones (a 0.9 room still decides by 15 m).
- visit.js: `v.voices` and `v.voiceRange` (45, read-only now) come from visit-client.

### What an integration does

1. Get visit-client 0.10.0 (`bin/setup` again, download; or this release).
2. Nothing for voice, unless your room set `visit.voiceRange` (it no longer changes anything) or has no world and
   never calls `visit.listener` (then your user is in nobody's hearing, as before).
3. If your room calls `proposeEdge`, `acceptEdge`, `declineEdge` or `removeEdge`, or reads `v.edges`,
   `v.edgeProposals` or `world.plots[i].seen` / `.edge`, take that out. To show where a friend has put you, read
   `v.seen` (the ready-made Map already does).

## v0.9.1 — 2026-10-26

**A visitor's click in a room with sprites runs its interaction.** Following a click into the room (SPEC 8.3),
visit.js met a sprite (a name tag, a label, a burst) without the camera three.js needs for one, and the click's
interaction never ran. It now looks from the visitor's eyes, where it clicked. The test room has a sprite, and its
own spawn puts one who steps in at the nearest free spot to where they stepped (a desk may be there), as a real
room does.

### What an integration does

1. Get visit-client 0.9.1 (`bin/setup` again, download; or this release). If your room follows a visitor's point
   into its scene itself (`visit.on("point")`) and has sprites, give its raycaster a camera (`ray.camera`).

## v0.9.0 — 2026-10-26

**A map of your world, avatars, interactions by type, voice by who is near, and phones.**

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
- **Voice** (SPEC 8.7): in a room, people hear each other by where they stand, the nearer the louder, from
  their direction; nobody beyond 15 m, and nobody in another room. Nothing to join: your microphone on or off
  (the panel's 🎙, remembered). A room passes its visitors' voices to each other, so they need no link of their
  own. Opus at about 24 kbps, straight between visit-clients (no server in between). Headphones are best.
- **Phones** (SPEC 8.8): a room may have one (`v.phone`), to call a friend's room wherever each user stands.
  The handset is private; on speaker, everyone near the phone hears the call and is heard in it, your visitors
  too. The room draws the phone and decides how it works; Visit carries the call.
- A link with someone who is your guest goes into your world, not the corner (#5, kfatehi): their plot was there
  already, as a guest's.

Protocol names are unchanged: an older Visit never asks for an avatar nor sends one, and an older visitor sees
`userData.visitPoint` types as plain marks (its host decides each point, as before).

### What changed

- visit-client: page messages `link_where`, `avatar_clear`, `avatar_want`, `avatars`, `avatar_use`, `phone`,
  `call`; to the page `avatars` (also in `ready`), `avatar`, `phone`, `call`, and `where` and `phone` in
  `visit_started`; page frame flags for its own avatar (5.4, bit 2), voice (bit 3) and voice passed on (bit 4),
  both ways; link control messages `avatar_want`, `phone` and `call`, a stream of the visitor's avatar (7.4,
  kind 2), and voice datagrams. The state file keeps whose look visitors have (`avatars`).
- visit.js: `v.interactions`, the `interaction` event; `v.avatar`, `v.useAvatars`, `v.useAvatar`, `v.avatarUse`,
  `v.avatars`, `avatar` on `v.visitors`; `Visit.map`; `v.setMic`, `v.mic`, `v.voices`, `v.voiceRange`,
  `v.listener`; `v.phone`, `v.phones`, `v.calls`, `v.call`, `v.pickUp`, `v.hangUp`, `v.speaker`, the `call`
  event. The scene of a room has `visit:me` and `visit:phone` (empty objects: where its user and its phone are).
  The panel: Map, visitors look like, their look / your model, 🎙 and who is near, calls. The visitor's
  crosshair shows an interaction's label.
- The test room: an interaction (`spin`), a box marked with a type it does not take, its own avatar, visitors
  drawn as theirs, a phone. The tests: the browser test's interactions, map, avatars, voice and a call on
  handset and speaker (two Chromes' fake microphones), and reloads; the end-to-end test's avatars, voice, voice
  passed on, and phones. The browser test's Chromes have a fake microphone (`run-browser.sh`).
- [visit/SPEC.md](visit/SPEC.md): sections 4.1, 5.2 to 5.4, 7.2, 7.4, 8.3, 8.5, 8.6 and 8.7 (new), 9, 13.
  [visit/INTEGRATING.md](visit/INTEGRATING.md): step 5 (interactions, avatars, voice, a phone), steps 6, 7 and 9
  (the map), the checklist.

### What an integration does

1. Get visit-client 0.9.0. The lobby is unchanged: nothing to deploy.
2. If your room took points (`visit.on("point")` with an allow list): move them to `visit.interactions`, one
   type each, and mark what may be clicked `userData.visitPoint = "<type>"` (INTEGRATING.md step 5). Cosmetic
   ones only, unless your user agreed to another, by name. Points still reach you raw meanwhile.
3. Draw a visitor's `avatar` when its entry has one, your model otherwise (step 5). Optional: give your own,
   `visit.avatar(body)`.
4. Voice: if your page draws no world, call `visit.listener({ x, y, z, yaw })` each frame (where your user
   stands). With your own lobby UI (not `Visit.panel`), offer the microphone: `visit.setMic(true)` from a click.
   A Content-Security-Policy needs `blob:` for worklets as for workers. Optional: a phone (step 5).
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
