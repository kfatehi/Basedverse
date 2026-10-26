# Integrating Visit into your workroom

**Written for the coding agent doing the integration.** Read it all before you change anything, then work
through the steps in order; each ends with how to check it. The contract behind it is
[SPEC.md](SPEC.md): look things up there, but you should not need to.

This guide lives in basedverse's `visit/` directory, beside `client/` (visit-client's source and
visit.js) and [SPEC.md](SPEC.md); basedverse's settings template, `.env.example`, is one level up. Paths
below are relative to `visit/`.

## What you are building

Your sim draws an office (a "workroom") in a browser page, with three.js. After this integration:

- it shows up in a lobby where other workrooms are, and can knock on theirs or let them in;
- **as a host**, it lets up to a few visitors walk around your room: Visit sends them your room's three.js
  scene, as data, and their browsers draw it; your page only decides where they may walk;
- **as a visitor**, it draws the room you are walking around itself, as quickly as your own, and sends your
  WASD and mouse to its host.

You get two shared pieces you do not modify:

- **visit-client**: a program that runs beside your sim on the same machine and does all the networking
  (the lobby, the connections to other workrooms). It listens on 127.0.0.1 only and needs a token.
- **visit.js**: the library your page loads from visit-client. It talks only to visit-client, sends your
  scene to your visitors and moves them with your hooks, draws the scene of the room you visit, captures input.

You write: a launcher step (start visit-client with a token), a way to hand the token to your page, your
scene and two host hooks, and a little UI (or use the ready-made panel). Your page never opens any connection to
another machine itself.

## Before you start

Check these about the sim you are integrating; if one is not true, stop and tell your user why.

1. **Its room is made with three.js, r125 to r186** (`THREE.REVISION`), in a browser page. Visit takes
   three.js rooms only: every room is drawn by its visitors' own browsers, from its scene. A room in another
   engine cannot take part (not even to visit) until it is three.js; tell your user so.
2. **It has something that starts it** (a script, a server, a desktop launcher) that can also start
   another program and keep it running while the sim runs.
3. **The browser has WebGL 2**: current Chrome, Edge, Safari and Firefox do.
4. **Its page is served from the same machine** (`http://localhost:…` or `http://127.0.0.1:…`). A page
   served from a public `https://` site can be stopped by some browsers from reaching 127.0.0.1.

Then the settings. **Have your user run basedverse's setup**, from your workroom's project, in a terminal
of their own (it asks them questions, so a shell that cannot answer prompts will not do):

```sh
python3 ../Basedverse/bin/setup --env .env      # basedverse beside your project; Windows: py ..\Basedverse\bin\setup --env .env
```

It asks them for the lobby (an address they have, or their own server, where it deploys one), the office's
name, the sim's name and version, and the page's address; gets visit-client for this machine (downloaded
from the newest release, or built); and writes `VISIT_LOBBY`, `VISIT_NAME`, `VISIT_SIM`, `VISIT_ORIGINS`,
`VISIT_PORT`, `VISIT_MAX_VISITORS`, `VISIT_STATE_FILE` and `VISIT_CLIENT_PATH` into the `.env`, keeping its other lines (and
adding it to `.gitignore` if they say so). Tell them what it will ask, wait until they say it is done, then
read the `.env`. Run again, it offers what the `.env` already says.

If they would rather answer you, ask them the same things and run it yourself with flags and `--yes`:
`--lobby wss://… --name "…" --sim my-workroom/1.0 --page http://localhost:3000` (`--help` lists the rest;
deploying a lobby, `--deploy user@host`, is best left to them, since ssh may ask them for a password).

Without setup, by hand: [`../.env.example`](../.env.example) is the template. Copy its first section (the
`VISIT_*` lines, with their comments) into your workroom's own settings, its `.env` if it has one (make one
from that section if not, and keep it out of version control), and fill in:

- `VISIT_LOBBY`: the **lobby URL** (`wss://…`), from whoever runs your lobby;
- `VISIT_NAME`: the **office name** your user wants (1–24 letters, digits, space, `_ . -`, starting and
  ending with a letter or digit; in quotes if it has a space, so a shell can read the file too);
- `VISIT_SIM`: your sim's **name and version**, e.g. `my-workroom/1.0`;
- `VISIT_ORIGINS`: your page's **origin**, e.g. `http://localhost:3000` (step 2 says why).

- `VISIT_STATE_FILE`: a file of the user's own (outside your repository, e.g.
  `~/.local/state/basedverse/<office>.json`) where visit-client keeps whether your user has gone offline, so
  a restart does not put them back in the lobby.

The rest can stay blank, meaning their defaults (port 7401, 3 visitors at once). `VISIT_TOKEN_FILE` is
for your launcher to set (step 2). Never put real values in `.env.example` itself: it is basedverse's
template, and it is committed.

## Step 1 — Get visit-client

If setup got it, it is at `VISIT_CLIENT_PATH`: go on to the check at the end of this step. Otherwise, put
the `visit-client` binary for your machine somewhere your launcher can run it (beside the launcher, say,
kept out of version control), and set `VISIT_CLIENT_PATH` to it. The quickest way is to download it: each
release of basedverse (https://github.com/sarmiena/Basedverse/releases; `latest/download/<file>` is always
the newest) has one file per machine:

| machine (`uname -sm`) | file |
|---|---|
| `Linux x86_64` | `visit-client-x86_64-unknown-linux-musl.tar.gz` (static: any distribution) |
| `Linux aarch64` | `visit-client-aarch64-unknown-linux-musl.tar.gz` (static) |
| `Darwin arm64` (Apple silicon) | `visit-client-aarch64-apple-darwin.tar.gz` |
| `Darwin x86_64` (Intel) | `visit-client-x86_64-apple-darwin.tar.gz` |
| Windows, x64 | `visit-client-x86_64-pc-windows-msvc.zip` |

```sh
# Linux or macOS: this machine's file from the newest release, into ./bin
mkdir -p bin && curl -fsSL https://github.com/sarmiena/Basedverse/releases/latest/download/visit-client-x86_64-unknown-linux-musl.tar.gz | tar -xz -C bin visit-client
```

```powershell
# Windows (PowerShell; curl.exe and tar.exe come with Windows 10 and later)
mkdir bin; curl.exe -fsSLo visit-client.zip https://github.com/sarmiena/Basedverse/releases/latest/download/visit-client-x86_64-pc-windows-msvc.zip; tar.exe -xf visit-client.zip -C bin visit-client.exe; del visit-client.zip
```

`SHA256SUMS`, in the same release, has every file's checksum. The macOS builds are not notarized: one
downloaded with a browser (not curl) needs `xattr -d com.apple.quarantine visit-client` before it runs.

Or build it, for a machine the releases do not cover or a checkout newer than the newest release:

- **Linux:** `client/build` makes a static `client/bin/visit-client` in Docker (nothing to install).
- **macOS or Windows:** with Rust installed (https://rustup.rs), `cargo build --release` in `client/` gives
  `client/target/release/visit-client`. It has to run natively there: a container cannot listen on the
  machine's own 127.0.0.1.

Check: `visit-client --version` prints the `version` of `client/Cargo.toml` in your checkout (the visit.js
it serves and the protocols it speaks are that version's), and `visit-client --help` prints its flags. You
do not need visit.js separately: visit-client serves it.

## Step 2 — Start visit-client from your launcher

Every time your sim starts:

1. **Make a new token**: 32 random bytes from a cryptographically secure source, as 64 hex characters.
   Never a fixed string, never reused between runs.
2. **Write it to a file only your user can read** (mode 0600), so it stays off the process list.
3. **Start visit-client** with your settings, and keep it running while your sim runs.
4. **Wait for its ready line** on stdout (`{"ready": true, …}`) before opening your page.
5. **Stop it** when your sim stops.

visit-client reads its settings from its environment, under the names in `.env.example`, so a launcher
loads your `.env` and passes its environment on, adding only the token file:

```sh
# a shell launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example)
set -a; . ./.env; set +a
umask 077
export VISIT_TOKEN_FILE="${XDG_RUNTIME_DIR:-/tmp}/my-workroom-visit.token"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$VISIT_TOKEN_FILE"
"${VISIT_CLIENT_PATH:-visit-client}" &
VISIT_PID=$!
trap 'kill $VISIT_PID' EXIT
```

```js
// a Node launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example)
require("dotenv").config();   // or your own .env reader
const { randomBytes } = require("crypto"), fs = require("fs"), { spawn } = require("child_process");
const tokenFile = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/my-workroom-visit.token`;
fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const visit = spawn(process.env.VISIT_CLIENT_PATH || "visit-client", [], { env: { ...process.env, VISIT_TOKEN_FILE: tokenFile },
                                          stdio: ["ignore", "pipe", "inherit"] });
process.on("exit", () => visit.kill());
```

```python
# a Python launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example)
import secrets, os, subprocess, atexit
from dotenv import load_dotenv; load_dotenv()   # or your own .env reader
token_file = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "my-workroom-visit.token")
fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, secrets.token_hex(32).encode()); os.close(fd)
visit = subprocess.Popen([os.environ.get("VISIT_CLIENT_PATH", "visit-client")], env=dict(os.environ, VISIT_TOKEN_FILE=token_file),
                         stdout=subprocess.PIPE)
atexit.register(visit.terminate)
```

Every setting is a flag too (`VISIT_LOBBY` is `--lobby`, `VISIT_ORIGINS` is `--origins`; `visit-client
--help` lists them), for a launcher that would rather pass them that way; a flag wins over the environment.

`VISIT_ORIGINS` is your page's origin (scheme, host and port, as the address bar shows them; list
`http://127.0.0.1:…` too if your page is ever opened that way). visit-client then refuses any other site's
page, even one that got hold of the token.

If your sim runs in a container, run visit-client on the host machine (or in the same network namespace
as the browser): it must be reachable at `127.0.0.1:<port>` **from the browser**, and must not be
published on any other address.

**Check:** `curl http://127.0.0.1:7401/health` answers `{"ok": true, …}`, and
`curl http://<your LAN address>:7401/health` does not connect.

## Step 3 — Hand the port and token to your page

Your page needs `{ port, token }`. Give it by a route **other websites cannot read**. Pick the one that
fits your sim:

- **Your sim has a server** (the page is served by it): add a route that answers a same-origin request,
  e.g. `GET /api/visit` → `{"port": 7401, "token": "…"}`, read from the token file. Send no CORS headers
  on it: that keeps other sites' pages from reading it. And answer it only when the request's `Host` header
  is `localhost` or `127.0.0.1` (any port): that turns away DNS-rebinding sites, and anyone on your network
  asking your server by its LAN address.
- **Your page is static files**: have the launcher write `visit.json` (`{"port", "token"}`) beside the
  page, mode 0600, and fetch it from the page. Do not commit it.
- **Your launcher opens the browser**: put it in the URL fragment,
  `http://localhost:3000/#visit=7401:<token>`. The fragment is never sent to any server. Read it, keep it
  in `sessionStorage` (it survives reloads of that tab, and no other site can read it), and remove it from
  the address bar with `history.replaceState`; on later loads, read it from `sessionStorage`.

Never put the token in a URL query, a log line, or any response another origin can read.

**Check:** from your page's console, your route returns the token; from a page on another origin (e.g.
`https://example.com`), `fetch("http://localhost:3000/api/visit")` fails.

## Step 4 — Load the library and connect

```js
async function startVisit() {
  const { port, token } = await (await fetch("/api/visit", { cache: "no-store" })).json();   // your step 3
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `http://127.0.0.1:${port}/visit.js`; s.onload = ok; s.onerror = () => fail(new Error("visit-client is not running"));
    document.head.appendChild(s);
  });
  // The token as a function: asked again whenever the library reconnects, so a visit-client restarted with a
  // new token (your launcher run again) is found again without reloading the page.
  const fresh = async () => (await (await fetch("/api/visit", { cache: "no-store" })).json()).token;
  const visit = await Visit.connect({ port, token: fresh, sim: { name: "my-workroom", version: "1.0" } });
  visit.on("error", e => console.warn("visit:", e.code, e.message));
  return visit;
}
```

If visit-client is not running, your sim must still work: catch the failure, log it, and carry on
without Visit. (Handing it the token as a plain string works too, but then a restarted visit-client means
reloading the page.)

**Check:** `visit.state` becomes `"online"`, `visit.office.name` is your office name, and `visit.offices`
lists you (and anyone else in the lobby).

## Step 5 — Be a host: your scene, `spawn`, `move`

Register your room once, right after `connect` (on every page load: Visit keeps visits across reloads and
asks the new page for them). **Until you do, your office is not in the lobby to be visited, and cannot
knock**: every room takes part with its scene.

```js
visit.host({
  // Your scene, the THREE you made it with, your renderer, and your visitors' camera's near and far.
  scene: { root: scene, three: THREE, renderer, near: 0.05, far: 500 },
  // Your visitors' camera's vertical field of view, in degrees (three.js: the PerspectiveCamera's first argument).
  fov: 70,
  // Where a new visitor appears: a pose of your choosing. Visit only stores it and hands it back.
  spawn(visitor) {
    return { x: 0, y: 1.6, z: 6, yaw: 0, pitch: 0 };   // standing at your room's entrance, eye height 1.6
  },
  // Where the visitor may go. Visit has already set pose.yaw and pose.pitch from where it is looking;
  // you move it with input.forward / input.strafe / input.run, against your own walls and furniture.
  // The fourth argument says whose pose it is ({ id: the visit's, visitor }), for a room that keeps
  // something of its own per visitor (one sat down, say, stays put).
  move(pose, input, dt, { id, visitor }) {
    return Visit.walk(pose, input, dt, { speed: 2.5, blocked: (x, z) => myRoom.isBlocked(x, z) });
  },
  // The speed your move() gives Visit.walk: a visitor's page walks at once, and your move() corrects it.
  walk: { speed: 2.5 },
});
```

- **`root`**: your `THREE.Scene` (its background and fog come along), or a `Group` holding the part to share.
  **Everything under it is sent to your visitors**, whether they look at it or not: keep anything your user
  would not show a guest outside it. Objects' `userData` stays with you (from 0.6): visitors get only
  `visitor` and `visitPoint` from it, below.
- **`three`**: the namespace your scene was made with (`THREE`, or what `import * as THREE` gave you). Its
  revision (`THREE.REVISION`) picks the three.js your visitors draw with: the very same release.
  `visit.host` throws for one the visit.js does not know.
- **`renderer`**: your own renderer, for its settings (shadows, tone mapping, colour space): your visitors'
  match them.
- **`walk`**, only if your `move` walks with `Visit.walk` at that speed (with `blocked` or not). Without it,
  visitors still look around at once, but walking waits for your answer.
- **Visitors' bodies**: if you draw your visitors in your room (`visit.visitors` has where each stands), mark
  each body `body.userData.visitor = entry.id` (the `id` of its entry), so a visitor's own eyes do not see it
  from inside. Your visitors then see each other.
- **Points**: a visitor looking around has a crosshair, and a click there points. You hear
  `visit.on("point", e => ...)` with `e.from` (the visitor's eyes, where you have it) and `e.dir` (where it
  looked): cast that ray into your scene and decide. **Take points through an allow list** of what your user
  would let a guest do: knock a ball, ring a bell, make the cat jump. Nothing on it may reach your user's tools,
  data or accounts, and each entry should do only what it says (no fetches, no messages to anyone). Keep the
  list's default "no", so something added later is a guest's only when you say so, and limit each visitor to a
  few a second. Mark what is on the list with `userData.visitPoint = true` (on the object, or a group it is in),
  and the visitor's crosshair shows hot over it.
- **What carries**: objects moving, appearing and going, materials' colours and opacity, canvas textures you
  redraw (`texture.needsUpdate = true`), the background and the fog. **What does not**: custom shaders (a
  `ShaderMaterial` is code: it arrives plain grey), HTML overlays, post-processing (an `EffectComposer`), and
  anything drawn outside the scene.
- **What it costs you**: under 1 ms of your page's time 30 times a second while you have visitors (Visit reads
  the scene for changes), and the whole scene once as each visitor starts (`toJSON`: some tens of ms for a
  room of a few hundred objects). You render nothing for them: their browsers do.

**`Visit.walk`** does first-person walking for you: speed in your world's units per second (Shift runs
at twice that), sliding along walls when `blocked(x, z)` says the way is shut. Its pose is
`{ x, y, z, yaw, pitch }`: y up, yaw 0 looking toward −z, positive yaw turning left, positive pitch looking
up (three.js's camera convention, Euler order `"YXZ"`). If your world's axes differ, write `move`
yourself (and leave `walk` out); the pose is yours.

**`blocked(x, z)`** is your room's floor plan: true where a visitor may not stand (walls, desks, outside
the room). Keep a margin of about 0.3 of your units so visitors do not stand inside furniture.

**Check:** `visit.offices` shows your office `ready`. From a second workroom (step 8), a visitor sees your
room from your spawn point; walking and turning are instant; it stops at your walls; your room's moving
things move in its view; it does not see its own body.

## Step 6 — Be a visitor: show the room you are in

The quickest way: the ready-made stage, once, right after `connect`:

```js
Visit.stage(visit);
```

While your user visits, the room they are in fills the window, with how the visit is going (the link's
path and round trip, input to screen, frames a second), **Back to my room** and **Leave**. Back to my room
shrinks it to the bottom-right corner, your own room full-window behind it; a click on the corner brings
it back. Full-window it takes WASD, Shift and the mouse (click it to look around; Esc gives the pointer
back); while your user looks around, a crosshair shows at the middle, and a click points at what is there
(the host decides what that does: step 5, Points); in the corner it takes nothing. It goes away when the visit ends, and comes back by itself after a
reload mid-visit. It sits at `z-index: 5`; `.visit-stage` is yours to restyle.

**If your room has keys of its own** (WASD for your user's avatar, say), they wait while
`visit.viewFocused` is true, and work while it is false (not visiting, or the visit in the corner):

```js
addEventListener("keydown", e => {
  if (window.visit && visit.viewFocused) return;   // the room your user is visiting has the keys
  // ... your own keys
});
```

Or your own view: `const view = visit.view(element)` draws the host's room in an element of yours and
captures the keyboard and mouse; `view.setActive(false)` stops it capturing (a picture-in-picture, say),
`view.release()` takes it away. Show it when `visit.visiting` becomes true (and at once after a reload, if
already visiting), give your user a way to leave (`visit.leave()`), and show `visit.stats` if you can:
it is what to look at when a visit feels slow.

The host's scene is drawn by your page itself, in that view: nothing for you to do. It fetches the host's
release of three.js from cdn.jsdelivr.net (checked against its hash) and runs it from a `blob:` URL, so a
Content-Security-Policy on your page needs `connect-src https://cdn.jsdelivr.net` and `script-src blob:`
(or pass `threeBase` to `connect`, to serve those same files yourself).

**Check:** with a host to visit (step 8), its room fills the window; WASD and the mouse move you in it,
and turning is instant; Back to my room shrinks it to the corner and gives your room its keys back.

## Step 7 — The lobby: knocking and letting in

The quickest way: the ready-made panel, in any element of yours (a corner of the page, say):

```js
Visit.panel(document.getElementById("visit-panel"), visit);
```

It lists the workrooms online (with whether each is available, how many visitors it has and takes), lets
your user knock with a message, shows knocks on your door with **Let in** / **Not now**, shows your
visitors (with **Kick**) and your visit (with **Leave**), sets your status and max visitors, and has
**Go offline** / **Go online**.

Or build your own from the state and actions: `visit.offices`, `visit.knocks`, `visit.visiting`,
`visit.visitors`, `visit.knock(id, message)`, `visit.answer(knockId, true | false)`, `visit.leave()`,
`visit.kick(visitId)`, `visit.setStatus("available" | "busy")`, `visit.setMaxVisitors(n)`,
`visit.leaveLobby()`, `visit.joinLobby()`; redraw on `"change"`. Rules your UI must follow:

- Offer **Knock** only for offices that are `ready`, `available`, not you, not full
  (`visitors < maxVisitors`), and not the one you are visiting.
- Show each knock on your door with who, their message and the seconds left, and both answers.
- Escape all names and messages before putting them in HTML: they come from strangers.
- Give your user a way to **go offline and back** (`leaveLobby()` / `joinLobby()`), and show when they
  are: `visit.state === "away"`. Away, nobody sees them or can knock, and their visits end; with
  `VISIT_STATE_FILE` they stay away until they come back, restarts included. Do not stop visit-client for
  this: it keeps your page connected while away, so the switch works.

**Check:** your user can see other workrooms, knock, answer a knock, and go offline and back.

## Step 8 — Test it on one machine

You need two workrooms. Run a second visit-client beside the first, with its own name, port and token,
and open a second copy of your page pointed at it (add a development-only way to choose, such as
`?visit=2` selecting port 7402 and its token in your step 3 route):

```sh
visit-client --lobby "$LOBBY" --name "Test A" --sim my-workroom/1.0 --port 7401 --token-file a.token &
visit-client --lobby "$LOBBY" --name "Test B" --sim my-workroom/1.0 --port 7402 --token-file b.token &
```

Then, in order:

1. Both pages show both offices in the lobby.
2. From B, knock on A; in A, let B in. B's page shows A's room; A's `visit.visitors` lists B.
3. In B, walk with WASD and look with the mouse: the view moves, and stops at A's walls.
4. **Reload A's page.** B's view holds, says the host is reloading, then carries on by itself.
5. **Reload B's page.** It comes back still visiting A, without knocking again.
6. In B, leave. B's view goes; A's visitors list empties.
7. Set A's max visitors to 0 (or status busy): B's knock is refused.
8. Stop B's visit-client: B disappears from A's lobby.

## Checklist

- [ ] Your settings live in your workroom's own `.env` (or config), written by setup or started from
      `../.env.example`; that `.env` is not committed, and `.env.example` keeps no real values.
- [ ] visit-client starts with your launcher, with a new token each run, and stops with your sim.
- [ ] It listens on 127.0.0.1 only; the token is in a 0600 file, not on the command line or in `.env`;
      `VISIT_ORIGINS` names your page's origin.
- [ ] Your page gets the token by a same-origin route (answering only `Host: localhost` or `127.0.0.1`), a
      fragment kept in `sessionStorage`, or a local file; no other origin can read it, and it never appears
      in a URL query or a log.
- [ ] Your sim works as before when visit-client is not running.
- [ ] `visit.host` gets your `scene` (`root`, `three`, `renderer`, `near`, `far`) and `fov`, on every page
      load; nothing private is under `root`.
- [ ] `spawn` puts visitors somewhere sensible; `move` keeps them out of walls and furniture; `walk` is
      given if `move` is `Visit.walk`, at its speed.
- [ ] Your visitors' bodies, if you draw them, are marked `userData.visitor`.
- [ ] Points, if you take them: through an allow list whose default is no, a few a second per visitor, and
      nothing on it reaches your user's tools, data or accounts; what is on it is marked `userData.visitPoint`.
- [ ] Visiting: the host's room fills the window (`Visit.stage`, or your own view); WASD, Shift and the
      mouse work; Esc frees the pointer; there is a way to leave, and back to your room; your own keys wait
      while `visit.viewFocused`.
- [ ] The lobby: offices, knocks, answers, visitors (kick), your visit (leave), status and max visitors
      all work, with the knock rules of step 7; names and messages are escaped.
- [ ] Your user can go offline and back (the panel, or `leaveLobby()` / `joinLobby()`), and stays offline
      across a restart (`VISIT_STATE_FILE`).
- [ ] Step 8 passes, reloads included.

## Troubleshooting

| symptom | cause |
|---|---|
| `visit.js` fails to load | visit-client is not running, or on another port; check `curl http://127.0.0.1:<port>/health` |
| connect fails before it opens (HTTP 403) | your page's origin is not in `VISIT_ORIGINS` (`--origins`): compare the address bar's scheme, host and port with it |
| visit-client exits at once (exit code 2) | a setting it cannot use; its stderr names it. Check your `.env` against `.env.example` (and a value with a space needs quotes for a shell to load it) |
| connect closes with 4401 | the token your page sent is not the one visit-client was started with: a stale `visit.json`, two launchers, or visit-client restarted while the page kept its old token (hand `connect` a token function, step 4) |
| connect closes with 4409 | another page of yours connected after this one; only the newest page is live |
| visit-client exits at once with code 4, its log saying `proto_unsupported` | the lobby is older than this visit-client (Visit 0.5 needs the lobby's version 3): update the lobby (`bin/deploy-lobby`) |
| your office never shows `ready`, and knocking says `not_hosting` | your page has not called `visit.host` (with a scene) since it loaded |
| `state` stays `"offline"` | visit-client cannot reach the lobby: a wrong `VISIT_LOBBY`, or no network; its stderr says why |
| you never become `ready` in the lobby | visit-client could not start its connection endpoint; its stderr says why |
| actions refused `away` | your user went offline (`visit.state` is `"away"`): `joinLobby()` brings them back |
| knocks refused `not_ready` | you or the door have not published a link yet; wait a few seconds |
| a visit ends `link_failed` | the two machines could not connect, even through the relay; check the relay is up |
| the visitor's view says "walking into …'s room" and stays | the host's page is not sending its scene (its console says why), or the visitor's page could not load three.js: see the next row |
| the visitor's view says "cannot draw …'s room" | its page could not load the host's three.js (a Content-Security-Policy blocking cdn.jsdelivr.net or `blob:` scripts, step 6; or no network to the CDN), or its browser has no WebGL 2 |
| visitors walk through walls | your `blocked` does not cover them, or your `move` ignores it |
| a visit feels laggy | read the stage's numbers (`visit.stats`): input to screen is the visitor's own drawing (a frame's time, or its machine is busy drawing); frames a second low means the host's room is heavy for the visitor's machine. Walking that lags behind the keys means the host gave no `walk`; things in the room moving late, a high link round trip, or `relay` (a relay is slower and rate-limited) are the network |
| visitors see their own body from inside | mark each body `userData.visitor = entry.id` (step 5) |
| visitors drift back as they walk | your `walk.speed` is not the speed your `move` gives `Visit.walk`, or your `move` is not `Visit.walk` (leave `walk` out) |
| something in your room is missing from a visitor's view of it | it is drawn outside `root`, with a custom shader, as HTML, or in post-processing (step 5) |
| your visitors stop moving while your tab is in the background | your page's Content-Security-Policy forbids `blob:` workers, so the library's timer is the page's own (slowed in the background): allow `worker-src blob:` |

## Upgrading

basedverse's [../CHANGELOG.md](../CHANGELOG.md) lists every release: what changed, and **what an
integration does about it**. To upgrade a workroom that works, read it from the version you have
(`visit-client --version`) up to the newest, then:

1. Pull basedverse (`git pull` in its checkout).
2. Get the new visit-client: run setup again (it keeps the `.env`'s answers; choose download), or step 1.
3. Do each "what an integration does" of the versions you skipped, in order, and add any new setting it
   names to the `.env` (setup adds its own).
4. Run step 8 again.

## Don't

- Don't open your own WebSocket, WebRTC or any other connection to the lobby or to other workrooms: Visit
  does all of it, through visit-client.
- Don't bind visit-client to anything but 127.0.0.1, or expose its port from a container.
- Don't reuse or hard-code the token, and don't put it anywhere another origin can read.
- Don't keep anything under your scene's `root` that your user would not show a guest: visitors get all of it.
- Don't trust names, messages or inputs from other workrooms: escape names and messages; Visit already
  clamps inputs and points.
- Don't let a point do anything your user would not let a guest do, and don't decide it by a deny list: an
  allow list, whose default is no.
