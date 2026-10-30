# Integrating Visit into your workroom

**Written for the coding agent doing the integration.** Read it all before you change anything, then work
through the steps in order; each ends with how to check it. The contract behind it is
[SPEC.md](SPEC.md): look things up there, but you should not need to.

This guide lives in basedverse's `visit/` directory, beside `client/` (the source of `visit`, and
visit.js) and [SPEC.md](SPEC.md); basedverse's settings template, `.env.example`, is one level up. Paths
below are relative to `visit/`.

## What you are building

Your sim draws an office (a "workroom") in a browser page, with three.js. After this integration:

- it shows up in a lobby where other workrooms are, and can link with theirs or let them link: a linked room
  shows in a corner, to go into, or to put in your world;
- **as a host**, it lets up to a few visitors walk around your room: Visit sends them your room's three.js
  scene, as data, and their browsers draw it; your page only decides where they may walk;
- **as a visitor**, it draws the room you are walking around itself, as quickly as your own, and sends your
  WASD and mouse to its host;
- **in a world** (step 9), your friends' rooms sit round yours as plots, drawn in your own picture with your
  own three.js: your user walks onto theirs, and they onto yours, without knocking.

You get two shared pieces you do not modify:

- **`visit`**: one program that runs beside your sim on the same machine and does all the networking (the
  lobby, the connections to other workrooms). It listens on 127.0.0.1 only and needs a token. Everything else
  Visit needs is inside it: its database (a Postgres it runs itself), and, when your workroom wants them, its
  sign-in ([../auth/INTEGRATING.md](../auth/INTEGRATING.md)) and its engine
  ([../engine/INTEGRATING.md](../engine/INTEGRATING.md)). Nothing to install, and no Docker.
- **visit.js**: the library your page loads from `visit`. It talks only to `visit`, sends your scene to your
  visitors and moves them with your hooks, draws the scene of the room you visit, captures input.

You write: a launcher step (start `visit` with a token), a way to hand the token to your page, your
scene and two host hooks, a little UI (or use the ready-made panel), and a few lines in your drawing loop for
the world. Your page never opens any connection to another machine itself.

## The vanilla experience

Every room that takes Visit's defaults looks and works the same for the people visiting it, and that is the point:
take them unless your user asks for something else. The defaults are Visit's own ready-made pieces:

- **the panel** (`Visit.panel`): one row a person (in the lobby, or linked with you: in your room, linked; open it
  for Go there, their look in your room, Kick, Unlink), knocks, your door and guests, your world's Map, the microphone and who is near, calls (📞 call, Pick up, speaker / handset, Hang up), notes (where
  a friend's world put your room), and ⏱ (how this page is doing);
- **the chat window** (the panel's, `Visit.chat`): bottom left, as in a game. Enter to type, and say a line to
  everyone who can see you, whisper to one person (`/w name`), say it in your room's chat (`/room`: everyone in it
  and linked with it) or a linked friend's (`/room name`), or to the lobby (`/1`); Tab finishes a name, else moves on to the next of those (Shift+Tab: back); 🎙 a voice
  message; 📬 what came for your user while nobody looked (whispers, your room's chat, mentions), kept until read;
  a whisper to someone away is kept by your `visit` until you are both in the lobby; 🎧 joins a
  room's voice (everyone in it hears everyone else), and a line over the box says who is in it; it fades when nobody has said anything for a while;
- **mounts** (`visit.ride`, M, the panel's "your mount"): Visit carries them and puts them under their rider in
  the room they ride into; what they are (models, names, paces) is your room's to say (`visit.possessions`), and the
  panel shows them once you give some;
- **the stage** (`Visit.stage`): the room you visit, full-window or in the corner;
- **the Map** (`Visit.map`, from the panel): your world from above;
- **in your world** (`visit.world`): chat bubbles over whoever said something, and a 🔊 over whoever you hear
  speaking, drawn by Visit (`bubbles`, `speaking`);
- **the phone** (`visit.phone(true, { at })`): Visit's own desk phone on a stand where you put it, ringing, its handset
  lifted on a call, its lamp lit on speaker;
- your user's **voice** on the panel's 🎙, heard by distance in the same room;
- **your physics**: Visit has none. Who flies, how one arriving in the air comes down, how riders go: your room's
  `spawn` and `move` decide (step 5 suggests some);

What has no default is your room's own: what your landscape is, where the phone stands, which interactions (cosmetic
only, step 5), your user's avatar. When your user asks for something else (their own panel, a phone of their own, no
🔊), it is theirs: switch that default off (`bubbles: false`, `speaking: false`, `model: false`, your own UI from
`visit.*`) and write it down in your workroom (a `VISIT.md`, say: what, why, in their words), so that an upgrade keeps
it rather than putting the default back. basedverse's `basedverse` plugin for Claude Code keeps that file for you.

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
5. **Which Visit it has, if any.** A room integrated before 2.0 (its `.env` names `VISIT_DATABASE_URL`,
   `AUTH_DATABASE_URL`, `VISIT_CLIENT_PATH` or `AUTH_CLIENT_PATH`; its launcher or compose runs `visit-client`,
   `auth-client`, a `visit-db` Postgres or a `visit-engine` service; it keeps an engine key): do "Upgrading a 1.x
   room to 2.0", below, first, and only then anything else here.

Then the settings. **Have your user run basedverse's setup**, from your workroom's project, in a terminal
of their own (it asks them questions, so a shell that cannot answer prompts will not do):

```sh
python3 ../Basedverse/bin/setup --env .env      # basedverse beside your project; Windows: py ..\Basedverse\bin\setup --env .env
```

It asks them for the lobby (an address they have, or their own server, where it deploys one), the office's
name, the sim's name and version, and the page's address; gets `visit` for this machine (downloaded from the
newest release, or built); offers to make the owner's account, for the sign-in (`visit auth user add`: they type
the password); and writes `VISIT_LOBBY`, `VISIT_NAME`, `VISIT_SIM`, `VISIT_ORIGINS`, `VISIT_PORT`,
`VISIT_MAX_VISITORS`, `VISIT_DATA_DIR` and `VISIT_PATH` into the `.env`, keeping its other lines (and adding it to
`.gitignore` if they say so). Tell them what it will ask, wait until they say it is done, then read the `.env`.
Run again, it offers what the `.env` already says. Python 3.8 or later is all it needs, unless it builds `visit`
(step 1).

If they would rather answer you, ask them the same things and run it yourself with flags and `--yes`:
`--lobby wss://… --name "…" --sim my-workroom/1.0 --page http://localhost:3000` (`--help` lists the rest;
deploying a lobby, `--deploy user@host`, is best left to them, since ssh may ask them for a password; with
`--yes` it makes no account: they make it later, in a terminal, with `visit auth user add <name>`).

Without setup, by hand: [`../.env.example`](../.env.example) is the template. Copy its first section (the
`VISIT_*` lines, with their comments) into your workroom's own settings, its `.env` if it has one (make one
from that section if not, and keep it out of version control), and fill in:

- `VISIT_LOBBY`: the **lobby URL** (`wss://…`), from whoever runs your lobby (left blank, `visit` runs without one:
  nobody visits, but your page, the sign-in and the engine work);
- `VISIT_NAME`: the **office name** your user wants (1–24 letters, digits, space, `_ . -`, starting and
  ending with a letter or digit; in quotes if it has a space, so a shell can read the file too);
- `VISIT_SIM`: your sim's **name and version**, e.g. `my-workroom/1.0`;
- `VISIT_ORIGINS`: your page's **origin**, e.g. `http://localhost:3000` (step 2 says why);
- `VISIT_DATA_DIR`: where your workroom **keeps everything**: its database (your user's chat, the pictures shared
  in it, whom your room keeps out, the sign-in's accounts), its state file (whether your user has gone offline, so
  a restart does not put them back in the lobby; the office's key, door and guests, so friends stay friends across
  restarts) and friends' landscapes (step 5). A directory of the user's own, outside your repository, written out
  in full: `/home/<them>/.local/share/basedverse/<office>` on Linux, say (`~/Library/Application
  Support/basedverse/<office>` on macOS, `%LOCALAPPDATA%\basedverse\<office>` on Windows). Blank, `visit` uses that
  very place, made from the office's name; set it, and a renamed office keeps its data. It holds secrets (the
  office's key, the database's passwords): never commit it, never copy it elsewhere. A copy taken while `visit`
  is stopped is a backup of the workroom;
- `VISIT_PATH`: where `visit` is (step 1).

The rest can stay blank, meaning their defaults (port 7401, 3 visitors at once). `VISIT_TOKEN_FILE` is
for your launcher to set (step 2). Never put real values in `.env.example` itself: it is basedverse's
template, and it is committed.

## Step 1 — Get `visit`

If setup got it, it is at `VISIT_PATH`: go on to the check at the end of this step. Otherwise, put the `visit`
binary for your machine somewhere your launcher can run it (beside the launcher, say, kept out of version
control), and set `VISIT_PATH` to it. The quickest way is to download it: each release of basedverse
(https://github.com/sarmiena/Basedverse/releases; `latest/download/<file>` is always the newest) has one file per
machine, about 150 MB (the Postgres and the Chrome it carries are most of it):

| machine (`uname -sm`) | file |
|---|---|
| `Linux x86_64` | `visit-x86_64-unknown-linux-musl.tar.gz` (any distribution with glibc 2.28 or newer: Debian 10+, Ubuntu 20.04+, RHEL 8+) |
| `Linux aarch64` | `visit-aarch64-unknown-linux-musl.tar.gz` (the same) |
| `Darwin arm64` (Apple silicon) | `visit-aarch64-apple-darwin.tar.gz` (macOS 11 or later) |
| `Darwin x86_64` (Intel) | `visit-x86_64-apple-darwin.tar.gz` (macOS 11 or later) |
| Windows, x64 | `visit-x86_64-pc-windows-msvc.zip` |

```sh
# Linux or macOS: this machine's file from the newest release, into ./bin
mkdir -p bin && curl -fsSL https://github.com/sarmiena/Basedverse/releases/latest/download/visit-x86_64-unknown-linux-musl.tar.gz | tar -xz -C bin visit
```

```powershell
# Windows (PowerShell; curl.exe and tar.exe come with Windows 10 and later)
mkdir bin; curl.exe -fsSLo visit.zip https://github.com/sarmiena/Basedverse/releases/latest/download/visit-x86_64-pc-windows-msvc.zip; tar.exe -xf visit.zip -C bin visit.exe; del visit.zip
```

`SHA256SUMS`, in the same release, has every file's checksum. The macOS builds are not notarized: one
downloaded with a browser (not curl) needs `xattr -d com.apple.quarantine visit` before it runs.

Or build it, for a machine the releases do not cover or a checkout newer than the newest release:

- **Linux:** `client/build` makes a static `client/bin/visit` in Docker (nothing to install).
- **macOS or Windows:** with Rust installed (https://rustup.rs), `cargo build --release -p visit` at basedverse's
  root gives `target/release/visit`. It has to run natively there: a container cannot listen on the machine's own
  127.0.0.1.

A build carries the Postgres and the Chrome basedverse has pinned for that machine (`../deps/pinned.json`), each
checked by its sha256 ([../deps/README.md](../deps/README.md)).

**Its database is inside it.** `visit` keeps its user's chat, the pictures and links shared in it, and whom its
room keeps out in a Postgres it carries and runs itself, its data in `VISIT_DATA_DIR`: made at its first start,
brought up to date by every start after an upgrade (SPEC.md 4.4). There is nothing to install, start or migrate,
and no database address to give it. Other programs of your workroom can share that cluster: set `VISIT_PG_PORT`,
and it listens on 127.0.0.1 at that port at every start (on a new free port each start without it); a start with
the port taken is refused. They use roles and databases of their own (SPEC.md 4.4).

**Check:** `visit --version` prints the `version` of `client/Cargo.toml` in your checkout (the visit.js it serves
and the protocols it speaks are that version's), and the Postgres and Chrome it carries; with your `.env` loaded,
`visit status` says where your workroom's data is; `visit --help` prints its flags. You do not need visit.js
separately: `visit` serves it.

## Step 2 — Start `visit` from your launcher

`visit` runs on the machine itself, beside your sim: it needs no container. Every time your sim starts:

1. **Make a new token**: 32 random bytes from a cryptographically secure source, as 64 hex characters.
   Never a fixed string, never reused between runs.
2. **Write it to a file only your user can read** (mode 0600), so it stays off the process list.
3. **Start `visit`** in the background with your settings, and keep it running while your sim runs. Keep its pid
   and its log (its stderr) in a directory of your workroom's own, kept out of version control.
4. **Wait for its ready line**, its first line on stdout (`{"ready": true, …}`), before starting what talks to it
   or opening your page. If it exits first, its log says why. The first start takes longer than the rest: it
   unpacks the Postgres and the Chrome it carries (once for every workroom of the user) and makes your
   workroom's database.
5. **Stop it** when your sim stops: SIGTERM (or Ctrl-C), and wait for it to exit. It leaves the lobby, stops its
   engine, and stops its Postgres last. One killed outright (SIGKILL; on Windows, a kill from another program)
   leaves its Postgres running, until its next start stops it first.

`visit` reads its settings from its environment, under the names in `.env.example`, so a launcher loads your
`.env` and passes its environment on, adding only the token file:

```sh
# a shell launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example);
# .visit/ is the workroom's own directory for visit's run (git-ignored)
set -a; . ./.env; set +a
umask 077; mkdir -p .visit
export VISIT_TOKEN_FILE="$PWD/.visit/token"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$VISIT_TOKEN_FILE"
"${VISIT_PATH:-visit}" > .visit/visit.out 2>> .visit/visit.log &
echo $! > .visit/visit.pid
until grep -q '"ready"' .visit/visit.out; do                     # its first line: ready
  kill -0 "$(cat .visit/visit.pid)" 2>/dev/null || { tail .visit/visit.log >&2; exit 1; }   # it exited: why
  sleep 0.5
done
stop_visit() { kill -TERM "$(cat .visit/visit.pid)"; while kill -0 "$(cat .visit/visit.pid)" 2>/dev/null; do sleep 0.2; done; }
trap stop_visit EXIT
# ... then start your sim
```

```js
// a Node launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example)
require("dotenv").config();   // or your own .env reader
const { randomBytes } = require("crypto"), fs = require("fs"), { spawn } = require("child_process");
fs.mkdirSync(".visit", { recursive: true });
const tokenFile = `${process.cwd()}/.visit/token`;
fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const visit = spawn(process.env.VISIT_PATH || "visit", [], { env: { ...process.env, VISIT_TOKEN_FILE: tokenFile },
                    stdio: ["ignore", "pipe", fs.openSync(".visit/visit.log", "a")] });
process.on("exit", () => visit.kill());   // SIGTERM: it stops by itself, its Postgres last
new Promise((ready, failed) => {          // its first line: ready
  require("readline").createInterface({ input: visit.stdout }).once("line", ready);
  visit.once("exit", code => failed(new Error(`visit exited (${code}): see .visit/visit.log`)));
}).then(startMySim, e => { console.error(e.message); process.exit(1); });
```

```python
# a Python launcher; its settings in the workroom's .env (the VISIT_* lines of ../.env.example)
import atexit, json, os, secrets, subprocess
from dotenv import load_dotenv; load_dotenv()   # or your own .env reader
os.makedirs(".visit", exist_ok=True)
token_file = os.path.abspath(".visit/token")
fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, secrets.token_hex(32).encode()); os.close(fd)
visit = subprocess.Popen([os.environ.get("VISIT_PATH", "visit")], env=dict(os.environ, VISIT_TOKEN_FILE=token_file),
                         stdout=subprocess.PIPE, stderr=open(".visit/visit.log", "a"), text=True)
if not json.loads(visit.stdout.readline() or "{}").get("ready"):   # its first line: ready
    raise SystemExit("visit did not start: see .visit/visit.log")
atexit.register(lambda: (visit.terminate(), visit.wait(30)))
```

Every setting is a flag too (`VISIT_LOBBY` is `--lobby`, `VISIT_ORIGINS` is `--origins`; `visit --help` lists
them), for a launcher that would rather pass them that way; a flag wins over the environment.

`VISIT_ORIGINS` is your page's origin (scheme, host and port, as the address bar shows them; list
`http://127.0.0.1:…` too if your page is ever opened that way). `visit` then refuses any other site's
page, even one that got hold of the token. **Always set it**: blank lets any page with the token in.

**The sign-in and the engine are this same `visit`**, given more settings by the same launcher: `AUTH_TOKEN_FILE`
turns on the sign-in API ([../auth/INTEGRATING.md](../auth/INTEGRATING.md) step 4), `VISIT_USER_TOKEN_FILE` and
`ENGINE_ROOM_URL` the engine ([../engine/INTEGRATING.md](../engine/INTEGRATING.md) steps 3 and 5). Never a second
program. Each token is a file your launcher makes, new each run, before it starts `visit` and before it starts
anything that reads one at its own start (your server).

**Where your sim's own server runs.** `visit` listens on the machine's `127.0.0.1`, and what talks to it (your
page, and later your server: the sign-in, the relay) must reach it there. The default, for a new room: **your
server on the machine too, beside `visit`, and no Docker anywhere.** A room that keeps its server in a container
(its choice) has to know that a container cannot reach the machine's `127.0.0.1` (`host.docker.internal` does not
lead there on Linux or in WSL): give that container the host's network (`network_mode: host`) and bind the server
to `127.0.0.1` itself, never `0.0.0.0`; a reverse proxy in a container (Caddy, say) likewise, with
`reverse_proxy 127.0.0.1:<your server's port>`. The browser, too, must reach `visit` at `127.0.0.1:<port>`, and
nothing may reach it on any other address.

**Check:** `curl http://127.0.0.1:7401/health` answers `{"ok": true, …}`, and
`curl http://<your LAN address>:7401/health` does not connect. With your `.env` loaded, `visit status` says it
runs.

## Step 3 — Hand the port and token to your page

Your page needs `{ port, token }`. Give it by a route **other websites cannot read**. Pick the one that
fits your sim:

- **Your sim has a server** (the page is served by it): give the token only to the signed-in owner. With the
  sign-in ([../auth/INTEGRATING.md](../auth/INTEGRATING.md): a real sign-in for your server, served by `visit`), a
  route behind its session check returns `POST /v1/visit`'s `{"port": 7401, "token": "…"}`. Without it, add a
  route that answers a same-origin request, e.g. `GET /api/visit` → `{"port": 7401, "token": "…"}`, read from
  the token file; send no CORS headers on it (that keeps other sites' pages from reading it), and answer it only
  when the request's `Host` header is `localhost` or `127.0.0.1` (any port). That `Host` check turns away
  DNS-rebinding sites, and nothing else: a program on your network can send any `Host` it likes. **What keeps
  the network out is your server listening on `127.0.0.1`**, until it has a sign-in.
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
    s.src = `http://127.0.0.1:${port}/visit.js`; s.onload = ok; s.onerror = () => fail(new Error("visit is not running"));
    document.head.appendChild(s);
  });
  // The token as a function: asked again whenever the library reconnects, so a visit restarted with a
  // new token (your launcher run again) is found again without reloading the page.
  const fresh = async () => (await (await fetch("/api/visit", { cache: "no-store" })).json()).token;
  const visit = await Visit.connect({ port, token: fresh, sim: { name: "my-workroom", version: "1.0" } });
  visit.on("error", e => console.warn("visit:", e.code, e.message));
  return visit;
}
```

If `visit` is not running, your sim must still work: catch the failure, log it, and carry on
without Visit. (Handing it the token as a plain string works too, but then a restarted `visit` means
reloading the page.)

**Check:** `visit.state` becomes `"online"`, `visit.office.name` is your office name, and `visit.offices`
lists you (and anyone else in the lobby).

## Step 5 — Be a host: your scene, `spawn`, `move`

Register your room once, right after `connect` (on every page load: Visit keeps visits across reloads and
asks the new page for them). **Until you do, your office is not in the lobby to be visited, and cannot
link**: every room takes part with its scene.

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
  // Optional: where someone linked with you sees your room from, before going in (step 7). Without it,
  // from above your plot, going round.
  preview: { x: 0, y: 6, z: 10, yaw: 0, pitch: -0.4 },
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
  from inside. Your visitors then see each other. When `entry.avatar` is set (below: your user chose to show
  that visitor's own look), draw it instead of your model: it is already marked, scaled to your units, its feet at
  its origin, facing −z, and walks and stands by itself; put it at the visitor's `x`, `z` (its feet on your
  floor) and turn it by `yaw`.
- **Interactions**: a visitor looking around has a crosshair, and a click there points. What a click may do is
  yours to list, by type, and nothing else happens:

  ```js
  visit.interactions({
    spin: { cosmetic: true, label: "spin it", run: ({ object }) => { object.rotation.y += 1; } },
  });
  ball.userData.visitPoint = "spin";   // on the object, or a group it is part of
  ```

  Visit casts the ray from where you have the visitor, finds what it hit, and runs that type's `run` with
  `{ id, visitor, type, object, point, distance, wheel }`; the visitor's crosshair shows hot over it, with the label.
  Options: `who: "guests"` (only your guests) or `who: "owner"` (your user alone, at home: never shown to a
  visitor), `reach` (how far, in your units), `wheel: true` (the mouse wheel runs it too: `wheel` is the notches
  turned, positive down, and 0 for a click; without it the wheel never runs the type). A type not listed does
  nothing. Something to scroll (a list, a deck of cards) takes the wheel; a click on it can still do something
  else, or nothing (`if (!wheel) return`).

  **DON'T IMPLEMENT ANY INTERACTIONS OTHER THAN COSMETIC ONES UNLESS SPECIFICALLY AGREED UPON BY THE USER.**
  Cosmetic means it only changes how the room looks or sounds to the people in it: something moves, lights up,
  plays, spins. Anything that reaches further (an agent's work, a tool, a file, an account, a message to anyone,
  state that outlasts the moment) is not cosmetic. If you are a coding agent and your user says "implement all
  interactions", that still means the cosmetic ones only: list the others you would add, what each could reach,
  and wait until your user agrees to each, by name. Visit enforces it: `visit.interactions` throws for an entry
  that is not `cosmetic: true` unless it says `agreed: true`, which you set only after that agreement.

  (Every point also reaches you raw, `visit.on("point", e => ...)`, with `e.from` and `e.dir`: for what is not
  a click on a thing, and for older visitors' marks, `userData.visitPoint = true`.)
- **Your own avatar** (optional): how rooms that show their visitors' own looks show your user:
  `visit.avatar(body)`, a three.js object of yours (its origin at its feet, facing −z, in your scene's units; with
  clips named `idle` and `walk` in `body.animations` if you have them; at most 4 MiB gzipped, 300 000 vertices).
  It goes only to a room that asks for it. Whose look your own visitors have is your user's to choose: the panel's
  "visitors look like", and "their look" / "your model" by each visitor (or `visit.useAvatars`, `useAvatar`).
- **Voice**: in a room, people hear each other by distance, from where each stands, within 45 m; nothing to join,
  and nobody hears into another room. Your user turns their microphone on (the panel's 🎙, or `visit.setMic(true)`
  from a click: browsers ask for the microphone only then); it stays on across reloads. Who hears whom is decided by
  each room's visit-client, the same for every room: your page only says where everyone in your room stands, which
  Visit does for you. It needs to know where your user stands: with a world (step 9) it knows; without one, call
  `visit.listener({ x, y, z, yaw })` each frame. Your visitors it takes from where your room has them. A
  page's Content-Security-Policy needs `blob:` for worklets too (as for the ticker's Worker), and the browser
  WebCodecs (Chrome, Edge, Safari, recent Firefox). Headphones keep your user's speakers out of their microphone.
  Something of your room's own that speaks (a receptionist, a radio; not a person): `visit.voiceAt(id, at, source)`,
  from the room's page (on the engine, the server page). `at` is where it speaks from (your units, `{ x, y, z }`,
  or the object that speaks, followed as it moves: her head), `source` a MediaStream or an AudioNode of any
  AudioContext (a buffer of speech your server made, played into it), and `visit.voiceAt(id, at, null)` ends it.
  Everyone in your room near it hears it from there, your own user included, as they hear each other: don't also
  play it yourself on your user's page, or they hear it twice. Visit plays it nowhere on the page that makes it.
  Give it the same `id` as its figure's lines (`sayAs`), so its voice and its words are one.
- **Your landscape** (recommended, the bigger your room the more): mark what never changes, its ground, walls,
  trees and furniture, with `obj.userData.visitStatic = true` (everything under it goes with it). Visit then sends
  it to each visitor once, who keeps it (by its hash: the same landscape is never sent twice, across visits and
  reloads), and stops looking at it 30 times a second. While you are away, your guests' worlds keep drawing it
  where your plot was, and walk them into its walls. Leave out what moves or changes (people, screens, signs,
  agents): those go as before. If something marked does change in itself, call `visit.landscapeChanged()`.
- **Chat**: the panel's chat window, bottom left: your user presses Enter, types a line, and Enter says it. Said
  (the default), everyone who can see them has it over their head for a few seconds, and in their chat; `/w name`
  whispers it to one person, `/room` says it in your room's chat (everyone in your room and linked with it, as a
  game's party), `/room name` in a linked friend's, `/1` to the whole lobby
  (`visit.say(text, to)` from code). Something of your room's own that talks (a receptionist, a guide; not a
  person): name its object `visit:npc:<id>` and say its lines with `visit.sayAs(id, name, text)`: in your room, over
  it, in everyone's chat under its own name, never as your user (on the engine, from the server page). With a world (step
  9) Visit draws the bubbles in your room too; without one, draw them yourself from `visit.chats`
  (`Visit.bubble(THREE, text, unit)` makes one). Make sure your room's keys ignore a text box (WASD there is typing,
  not walking), and leave Enter and `/` to the chat window. Something of yours bottom left: move the window
  (`--visit-chat-left`, `--visit-chat-bottom` in your CSS).
- **Your user's name** (if your room knows it): `visit.setName(name)`, now and whenever it changes. Others then see
  it with what your user says, over their voice, and in their panel ("Ann (Duckroom)"); without it, your office's
  name.
- **Positions and bodies** ([MODELS.md](MODELS.md): read it first, and follow it). Where someone is, is where
  their **feet** are: your `spawn` and `move` return that, never their eyes. Give your user's body with
  `visit.avatar(model)`: a model of its own, its feet at its origin, facing −z, in metres, with an `eyes` point and
  `idle`, `walk`, `ride` clips; check it with `Visit.checkModel`. Visit draws your visitors' own models at their
  feet: draw your own figure for a visitor only where `visit.visitors[i].look` is "mine". To decide that yourself for
  some of them, give `visit.host` a `look(visitor)` hook that returns "mine" or "theirs" (anything else: as the
  panel says); a room that poses its owner itself (engine/SPEC.md 4: a seat, a drink) says "mine" of `who.owner`.
- **Mounts**: one riding into your room has its mount in your scene, under its feet. Your `move` hears what it
  rides (`who.riding`: { id, name, fly, speed, lift }) and does as your room's physics would: we suggest lifting the
  rider onto it (their eyes `lift` higher), walking them at its pace (`speed` times yours; say `walk: { speed,
  mounts: true }` so their page walks with you), and flying one that flies on their `up`. Draw your visitors at
  their pose's height (`pose.y`, less their eyes), and say where your pose is (`eye`, metres above their feet) if not
  1.6. To keep mounts out, `mounts: false`. For your own user at home, with a
  world: Visit draws their mount under their feet (pass `facing` to `world.frame` if they face another way than they
  look); lift them onto it (`visit.rideLift`) and walk them at its pace (`visit.rideSpeed`). Your user's own mounts:
  `visit.possessions([{ id, name, object, mount: true, fly, speed, lift }])`, with `idle`, `walk`, `run`, `fly`
  clips if you have them, and a `ride` (or `sit`) clip in their avatar.
- **A phone** (optional): for your user to talk with a friend in another room, wherever each stands.
  `visit.phone(true, { at: { x, y, z } })` puts it in your room: Visit's own phone, its handset at `at` (or
  `model: false`, and draw your own there); `visit.phones` lists
  those linked to your user whose rooms have phones, to call (`visit.call(key)`); `visit.on("call", e => ...)`
  says when it rings (ring your phone), and `visit.pickUp(key)`, `visit.hangUp(key)`. The handset is private;
  `visit.speaker(key, true)` puts the call on speaker: everyone near your phone, your visitors too, hears it and
  is heard in it. How it looks and works in your room (lifting the handset, a button for speaker) is yours.
- **Falling and flying** (your physics: Visit does none): a visitor's `up` (Space or Page Up up, X or Page Down
  down, as in WoW) reaches your `move` in `input.up`; one stepping in from a world in the air comes with how high it
  was (`at.air` in `spawn`). What happens is yours. We suggest: `spawn` it that high, and in `move` bring it down
  gently (some 1.5 m a second) to your floor, unless your room lets it fly (then `up` lifts or lowers it, some 4 m a
  second); say how high above the floor (`air` in the pose you return), so a mount that flies plays its fly clip.
  To fly into friends' plots from your own world, pass your user's height above your floor as `air` to
  `world.frame`, and `up`.
- **What carries**: objects moving, appearing and going, materials' colours and opacity, canvas textures you
  redraw (`texture.needsUpdate = true`: encoded again in the background and sent at most once a second, so mark one
  changed only when its picture did), the background and the fog. **What does not**: custom shaders (a
  `ShaderMaterial` is code: it arrives plain grey), HTML overlays, post-processing (an `EffectComposer`), and
  anything drawn outside the scene. **A primitive travels as its parameters**: a `BoxGeometry`, an
  `IcosahedronGeometry` and the rest go as what made them (`toJSON`), so corners you pulled on one arrive as
  the primitive, unpulled. A geometry whose vertices you edit must be a plain one: `new
  THREE.BufferGeometry().copy(new THREE.IcosahedronGeometry(1, 1))`, then edit. (An `EdgesGeometry` or a
  `WireframeGeometry`, lines along another's edges, travels as its lines: Visit sees to it.)
- **What it costs you**: under 1 ms of your page's time 30 times a second while you have visitors (Visit reads
  the scene for changes, your landscape aside), and the whole scene once as each visitor starts (`toJSON`: some
  tens of ms for a room of a few hundred objects; your landscape apart, once, to visitors who do not have it).
  You render nothing for them: their browsers do.

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
(the host decides what that does: step 5, Interactions); in the corner it takes nothing. It goes away when the visit ends, and comes back by itself after a
reload mid-visit. It sits at `z-index: 5`; `.visit-stage` is yours to restyle.

A **link** (step 7) starts in the corner: the other room seen from outside, from above it, going round. A click
on it offers **Go there** (the room fills the window, as a visit; Back to my room puts it in the corner again),
**Put in my world** (with a world, step 9: their room becomes a plot beside yours) and **Unlink**.

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
it is what to look at when a visit feels slow. A link's room (`visit.visiting.link`) is drawn there too, from
outside, until `visit.stepIn()`; keep it small until `visit.visiting.inside`, and offer `visit.stepIn()`,
`visit.stepOut()`, `visit.toWorld()` and `visit.unlink()`.

The host's scene is drawn by your page itself, in that view: nothing for you to do. It fetches the host's
release of three.js from cdn.jsdelivr.net (checked against its hash) and runs it from a `blob:` URL, so a
Content-Security-Policy on your page needs `connect-src https://cdn.jsdelivr.net` and `script-src blob:`
(or pass `threeBase` to `connect`, to serve those same files yourself).

**Check:** with a host to visit (step 8), its room fills the window; WASD and the mouse move you in it,
and turning is instant; Back to my room shrinks it to the corner and gives your room its keys back.

## Step 7 — The lobby: linking and letting in

The quickest way: the ready-made panel, in any element of yours (a corner of the page, say):

```js
Visit.panel(document.getElementById("visit-panel"), visit);
```

It lists the workrooms online (with whether each is available, how many visitors it has and takes), lets
your user **link** with one (with a message): once they say yes, their room shows in the stage's corner (step 6),
and your user chooses to go there, put it in their world, or unlink. Each person is one row: linked, it says where
you two stand (in your room, in theirs, linked), and opened, the rest (**Go there**, **Put in my world**, **their
model** / **our model** for how they look in your room, **Kick**, **Unlink**). It shows links asked of you with
**Link** / **Not now** and **★ always** (make them a guest as you say yes), whose look your visitors have by
default (their model),
**Map** (your world, from above: step 9), the microphone (🎙) and who is near, calls, the chat window (Enter), sets your
status and max visitors, and has **Go offline** / **Go online**. A
star (☆) by each office makes it a **guest**: while your door is open (the panel's "your door"), a guest's link
is let in at once, without asking your user. An office on an older Visit gets **Knock** instead: let in, your
user walks straight into its room, as before.

Or build your own from the state and actions: `visit.offices`, `visit.knocks`, `visit.visiting`,
`visit.visitors`, `visit.links`, `visit.watchers`, `visit.link(id, message)` (or `visit.knock`, for an office
whose `links` is false), `visit.answer(knockId, true | false)`, `visit.stepIn()`, `visit.stepOut()`,
`visit.toWorld()`, `visit.unlink(id)`, `visit.leave()`,
`visit.kick(visitId)`, `visit.setStatus("available" | "busy")`, `visit.setMaxVisitors(n)`,
`visit.leaveLobby()`, `visit.joinLobby()`, and the door and guests: `visit.door`, `visit.guests`,
`visit.setDoor(open)`, `visit.addGuest(office.key, office.name)`, `visit.removeGuest(key)`; redraw on
`"change"`. Rules your UI must follow:

- Offer **Link** only for offices that are `ready`, `available`, not you, and not already linked or visited
  (and **Knock**, for one whose `links` is false, only when it is not full: `visitors < maxVisitors`).
- Show each link and knock on your door (`knock.link` says which) with who, their message and the seconds
  left, and both answers.
- Show your user who is linked to them, seeing their room from outside it: `visit.watchers` with `link`
  (and `inside` once they come in), with a way to end it (`visit.kick(id)`).
- Escape all names and messages before putting them in HTML: they come from strangers.
- Give your user a way to **go offline and back** (`leaveLobby()` / `joinLobby()`), and show when they
  are: `visit.state === "away"`. Away, nobody sees them or can link, and their visits end; they stay away
  until they come back, restarts included (its state file keeps it). Do not stop `visit` for this: it keeps
  your page connected while away, so the switch works.
- If you offer guests, show which offices are guests, and whether the door is open; say plainly that a
  guest walks in without asking. A visitor let in that way has `guest: true` in `visit.visitors`.

**Check:** your user can see other workrooms, link with one (its room in the corner; go there and back), answer
a link, and go offline and back.

## Step 8 — Test it on one machine

You need two workrooms. Run a second `visit` beside the first, with its own name, port, token and data
directory, and open a second copy of your page pointed at it (add a development-only way to choose, such as
`?visit=2` selecting port 7402 and its token in your step 3 route):

```sh
# each with a token file of its own, made as step 2 makes one; a flag wins over your .env's settings
visit --lobby "$LOBBY" --name "Test A" --sim my-workroom/1.0 --port 7401 --token-file a.token --data-dir /tmp/visit-a &
visit --lobby "$LOBBY" --name "Test B" --sim my-workroom/1.0 --port 7402 --token-file b.token --data-dir /tmp/visit-b &
```

Each makes a database of its own in its data directory at its first start; two cannot run on one data directory
(the second is refused, exit 5). With the sign-in or the engine on (`AUTH_TOKEN_FILE`, `ENGINE_ROOM_URL` in the
environment), the second needs ports of its own for them too (`--auth-port`, `--engine-port`).

Then, in order:

1. Both pages show both offices in the lobby.
2. From B, link with A; in A, say yes. B's page shows A's room in the corner, from above; A's
   `visit.watchers` lists B, linked. Click the corner, **Go there**: A's room fills B's window, and A's
   `visit.visitors` lists B.
3. In B, walk with WASD and look with the mouse: the view moves, and stops at A's walls.
4. **Reload A's page.** B's view holds, says the host is reloading, then carries on by itself.
5. **Reload B's page.** It comes back still linked with A, without asking again (in the corner: Go there).
6. In B, **Back to my room**: A's room in the corner again, A's visitors list empty. Then **Unlink**: B's corner
   goes, and A's watchers list empties.
7. Turn both microphones on (🎙) with B in A's room: each hears the other (headphones on one, or the other
   page's speakers echo). Type a line in B's **Say** box: it shows over B's head in A's room, and in B's view.
8. With your landscape marked (step 5), reload B's page while it is in A's room: A's walls and floor are there
   again at once (B's `visit` kept them).
9. Set A's status to busy: B's link is refused.
10. Stop B's `visit`: B disappears from A's lobby.

## Step 9 — Your world: friends' plots round your room

With a world ([WORLD.md](WORLD.md), SPEC 8.4) your user stays in their own room, as themselves, and their
friends' rooms sit round it as plots they walk onto, without knocking. A friend is a guest both ways (the star
in the panel), with their doors open. Do it once step 8 passes: it is a few lines in your page, and without it
your room still knocks and visits as before, but your user sees no friends' rooms round theirs, and a friend who
walks onto your plot from their world may have no way back out.

1. **Say your plot** in `visit.host`: `plot: { center: [x, z], size: [w, d] }`, the rectangle of your floor
   that is your land (in your scene's units), and `unit`, how many metres one of them is. Without it, your plot is
   what your scene covers, which a big ground plane makes too big.
2. **Let people walk out.** Your `move` must let a visitor walk off your plot somewhere (a doorway is enough):
   walking off it is how they go home. And let `spawn(visitor, { at })` put someone who walked in where they
   stepped (`at`, in your terms), unless that is inside a wall.
3. **Your user is a body of yours, walking.** If your room has no avatar for your own user, give it one (and a
   camera that follows it): in a world, your page draws your user wherever they are, in your room or another's.
4. **Every frame**, after your own walking (only while `!world.inside`: in someone else's plot, their room moves
   your user), ask the world where your user is, and draw with it:

   ```js
   const world = visit.world({ scene, renderer });   // your whole scene, and its renderer
   // each frame:
   if (!world.inside) walkMyAvatar(dt, input);                       // your own walking, your own walls
   const at = world.frame(dt, { x, y, z, yaw, pitch }, input);      // input: { forward, strafe, run }
   avatar.position.set(at.x, at.y, at.z);                            // at home as you said, or as their room has you
   world.render(camera);                                             // in place of renderer.render(scene, camera)
   ```

   In a plot, `at.y` follows its host up and down from where you stepped on: a room with stairs or a lift moves a
   visitor's `pose.y` in its `move`, and your user rises with it. A flat room never moves it, so `at.y` stays the y
   you gave. Likewise, if your room has floors, let `move` change `pose.y` and a visitor goes up with it.

   `world.render` draws your room clipped to your plot: anything of yours outside it (a sky dome, a huge ground)
   is cut there; use `scene.background` for a sky. A post-processing chain (`EffectComposer`) does not fit it.
5. **Where they sit.** The panel's **Map** (`Visit.map(visit).open()`) shows your world from above: drag a
   friend's room where you want it, turn it, or type where its middle goes; kept by `visit`, across reloads.
   Your layout is yours alone, nobody agrees to it: each friend is told only where their own room sits in it, and
   picking a friend on the Map shows their view of the two of you (where their world has your room). Nothing to
   do for that beyond `visit.world`. (In code: `visit.place`, `visit.seen`, `visit.on("seen", …)`.)

**Check:** with step 8's two rooms, each starring the other in the panel, each sees the other's plot; walking
onto it puts you in its room (its `visit.visitors` lists you), walking off brings you home; put flush against yours
on the Map, walking out of your door goes straight into theirs; and picking the other on the Map shows where
they have put you. With your landscapes marked: stop one `visit`, and the other's world keeps its plot,
marked offline, walked into but not through its walls; start it again, and the plot is live.

## Checklist

- [ ] Your settings live in your workroom's own `.env` (or config), written by setup or started from
      `../.env.example`; that `.env` is not committed, and `.env.example` keeps no real values.
- [ ] `visit` starts with your launcher, on the machine, in the background, with a new token each run; the
      launcher waits for its ready line, and stops it with your sim (SIGTERM, waited for).
- [ ] Whatever talks to `visit` reaches it on `127.0.0.1`: your server on the machine too (no Docker), or its
      container on the host's network, bound to `127.0.0.1`.
- [ ] It listens on 127.0.0.1 only; the token is in a 0600 file, not on the command line or in `.env`;
      `VISIT_ORIGINS` names your page's origin.
- [ ] Your page gets the token by a same-origin route (answering only `Host: localhost` or `127.0.0.1`), a
      fragment kept in `sessionStorage`, or a local file; no other origin can read it, and it never appears
      in a URL query or a log.
- [ ] Your sim works as before when `visit` is not running.
- [ ] `visit.host` gets your `scene` (`root`, `three`, `renderer`, `near`, `far`) and `fov`, on every page
      load; nothing private is under `root`.
- [ ] `spawn` puts visitors somewhere sensible; `move` keeps them out of walls and furniture; `walk` is
      given if `move` is `Visit.walk`, at its speed.
- [ ] Your visitors' bodies, if you draw them, are marked `userData.visitor`.
- [ ] Interactions: only through `visit.interactions`, each marked `userData.visitPoint = "<type>"`; **cosmetic ones
      only, unless your user agreed to another, by name** (`agreed: true`); nothing reaches your user's tools,
      data or accounts without that.
- [ ] Visitors drawn as their own avatars (`entry.avatar`) when set, as your models otherwise; your own avatar given
      (`visit.avatar`), if you like.
- [ ] Voice: with the microphone on, a visitor near your user hears them, and they the visitor; farther, neither.
- [ ] A phone, if you have one: a call rings, is picked up, heard on the handset; on speaker, by those near it.
- [ ] Your physics: one stepping in from a world in the air comes down as your room has it (or flies, if it lets
      them); their own world shows them where your room has them.
- [ ] Mounts: a visitor pressing M rides into your room on theirs, under them; your `move` lifts them, paces them and
      flies them as your room has it; your user's own (if you give any), at home, under their feet.
- [ ] Its data: `VISIT_DATA_DIR` set (setup writes it), outside your repository; a restart keeps the chat (its last
      lines are there again), and older lines come as the chat window's log is scrolled to its top.
- [ ] Pictures and links: a screenshot pasted into the chat box goes with the line, to a friend's room, and shows
      there; a link typed gets its preview; 🖼 lists what was shared.
- [ ] Chat: Enter opens the chat window, bottom left; a line said shows over its speaker's head for everyone who
      can see them, and in their chat; `/w name` whispers, `/room` your room's chat, `/room name` a linked friend's, `/1` the lobby; your own keys
      ignore a text box (typing "w" there does not walk), and nothing of yours hides the window.
- [ ] Your landscape (what never changes) marked `userData.visitStatic`; nothing that moves or changes under it,
      or `visit.landscapeChanged()` when it does.
- [ ] Visiting: the host's room fills the window (`Visit.stage`, or your own view); WASD, Shift and the
      mouse work; Esc frees the pointer; there is a way to leave, and back to your room; your own keys wait
      while `visit.viewFocused`.
- [ ] The lobby: offices, links and knocks, answers, links into a corner (go there, back, unlink), visitors and
      who is linked to you (kick, unlink), status and max visitors all work, with the rules of step 7; names
      and messages are escaped.
- [ ] Your user can go offline and back (the panel, or `leaveLobby()` / `joinLobby()`), and stays offline
      across a restart (its state file).
- [ ] Step 8 passes, reloads included.
- [ ] Your world (step 9): your `plot` and `unit` are said, visitors can walk off your plot, `spawn` takes
      `at`, your user has a body of yours, you draw with `world.frame` and `world.render`, and step 9's check
      passes.

## Troubleshooting

| symptom | cause |
|---|---|
| `visit.js` fails to load | `visit` is not running, or on another port; check `curl http://127.0.0.1:<port>/health` |
| connect fails before it opens (HTTP 403) | your page's origin is not in `VISIT_ORIGINS` (`--origins`): compare the address bar's scheme, host and port with it |
| `visit` exits at once (exit code 2) | a setting it cannot use; its stderr names it. Check your `.env` against `.env.example` (and a value with a space needs quotes for a shell to load it) |
| `visit` exits at once with code 5 | its stderr says why: `this workroom's visit is running already` (another launcher, or one left running: `visit status`); `Postgres did not start` (its log is `postgres/data/start.log` in the data directory: run as root, which Postgres refuses, or a full disk); the sign-in API or the engine (a token file, a port taken, `ENGINE_ROOM_URL`) |
| the first start takes a while | it unpacks the Postgres and the Chrome it carries (once for every workroom of the user), and makes your workroom's database (once) |
| `visit` says what is inside it "is not the one it was built with" | the file is damaged: download it again, and check it against `SHA256SUMS` |
| connect closes with 4401 | the token your page sent is not the one `visit` was started with: a stale `visit.json`, two launchers, or `visit` restarted while the page kept its old token (hand `connect` a token function, step 4) |
| connect closes with 4409 | another page of yours connected after this one; only the newest page is live |
| `visit` exits at once with code 4, its log saying `proto_unsupported` | the lobby is older than this `visit` (Visit 0.5 needs the lobby's version 3): update the lobby (`bin/deploy-lobby`) |
| your office never shows `ready`, and knocking says `not_hosting` | your page has not called `visit.host` (with a scene) since it loaded |
| `state` stays `"offline"` | `visit` cannot reach the lobby: a wrong `VISIT_LOBBY`, or no network; its stderr says why |
| you never become `ready` in the lobby | `visit` could not start its connection endpoint; its stderr says why |
| actions refused `away` | your user went offline (`visit.state` is `"away"`): `joinLobby()` brings them back |
| knocks refused `not_ready` | you or the door have not published a link yet; wait a few seconds |
| a visit ends `link_failed` | the two machines could not connect, even through the relay; check the relay is up |
| the visitor's view says "walking into …'s room" and stays | the host's page is not sending its scene (its console says why), or the visitor's page could not load three.js: see the next row |
| the visitor's view says "cannot draw …'s room" | its page could not load the host's three.js (a Content-Security-Policy blocking cdn.jsdelivr.net or `blob:` scripts, step 6; or no network to the CDN), or its browser has no WebGL 2 |
| visitors walk through walls | your `blocked` does not cover them, or your `move` ignores it |
| your room or a visit feels slow, or stutters | turn on the panel's ⏱ (`visit.perf(true)`): each second it shows frames, stalls (long tasks), Visit's own work by part, and your room's drawing apart; "copy report" gives the last two minutes. A stall with "send" or "whole" in it is your scene's size; slow frames with Visit idle are your room's own drawing (or the machine: a video call takes its share); "pictures sent" every second is a canvas you mark changed every second |
| a visit feels laggy | read the stage's numbers (`visit.stats`): input to screen is the visitor's own drawing (a frame's time, or its machine is busy drawing); frames a second low means the host's room is heavy for the visitor's machine. Walking that lags behind the keys means the host gave no `walk`; things in the room moving late, a high link round trip, or `relay` (a relay is slower and rate-limited) are the network |
| visitors see their own body from inside | mark each body `userData.visitor = entry.id` (step 5) |
| visitors drift back as they walk | your `walk.speed` is not the speed your `move` gives `Visit.walk`, or your `move` is not `Visit.walk` (leave `walk` out) |
| something in your room is missing from a visitor's view of it | it is drawn outside `root`, with a custom shader, as HTML, or in post-processing (step 5) |
| typing in the chat window walks your user | your room's own keys do not ignore a text box: skip keys whose target is an `INPUT`, `TEXTAREA` or editable element |
| a visitor does not see a change to something you marked static | the landscape is not looked at for changes: call `visit.landscapeChanged()` after changing it, or do not mark what changes |
| a friend's room vanishes from your world when they go offline | their room marks no landscape (`userData.visitStatic`), or they shut their door to you or un-starred you (then it is forgotten on purpose) |
| your visitors stop moving while your tab is in the background | your page's Content-Security-Policy forbids `blob:` workers, so the library's timer is the page's own (slowed in the background): allow `worker-src blob:` |

## Upgrading

basedverse's [../CHANGELOG.md](../CHANGELOG.md) lists every release: what changed, and **what an
integration does about it**. To upgrade a workroom that works, read it from the version you have
(`visit --version`; before 2.0, `visit-client --version`) up to the newest, then:

1. Pull basedverse (`git pull` in its checkout).
2. Get the new `visit`: run setup again (it keeps the `.env`'s answers; choose download), or step 1. Stop the
   old one and start the new one: its first start brings its database up to date by itself, with nothing to run.
   **From 1.x** (visit-client, auth-client and the rest), do "Upgrading a 1.x room to 2.0", below, instead of this
   list, then come back for the versions after 2.0.
3. Do each "what an integration does" of the versions you skipped, in order, and add any new setting it
   names to the `.env` (setup adds its own).
4. Run step 8 again, and step 9's check.

## Upgrading a 1.x room to 2.0

For a room integrated before 2.0 ("Before you start", point 5): do this first, whole, in this order, and only then
anything else. This is the one full copy of these steps: the changelog's v2.0.0 and the plugin's skill point here.

### What to expect

- **The room's pages do not change.** Its HTML and JavaScript, how it calls visit.js, its server's relay
  (`/visit/ws`, `/visit/visit.js`), its sign-in routes and key checks, the protocols: all as they were. Only how
  Visit is run changes.
- **One `visit` replaces four**: visit-client, auth-client, the engine's image and the Postgres beside them. It runs
  on the machine, started by your launcher. Visit needs no Docker any more.
- **Everything comes across**: accounts, sessions (people stay signed in), API keys (agents' and scripts' keys keep
  working), the chat and its history, pictures and voice messages, links, whispers held for someone away, bans, and
  the office's identity (its key, door and guests, in its state file), so friends still know it.
- **Nothing to migrate, ever again**: `visit` brings its database up to date at every start.

### What to do

Tick these off in order; each says how to check it.

1. **Make a way back.** Tag the room's repository as it is (`git tag before-visit-2`), and keep the old database
   and its volume until step 12 says otherwise. Leave the old Postgres running: step 4 reads it.
2. **Stop the old Visit**: visit-client, auth-client and the engine (the launcher's, or their compose services).
   Not the old Postgres.
3. **Get `visit`**: `bin/setup` again (it keeps the `.env`'s answers; choose download), a release's file (step 1),
   or a build. Setup writes `VISIT_DATA_DIR` and `VISIT_PATH` into the `.env`, and takes the 1.x database and
   program settings out of it: copy `VISIT_DATABASE_ADMIN_URL`'s value first, for step 4. By hand: set
   `VISIT_DATA_DIR` in the `.env` once, a directory of the user's own outside the repository, and `VISIT_PATH`.
   **Check:** `visit --version` says 2.
4. **Move the database in**, with the old Postgres still running, before `visit` first starts, and with the `.env`
   loaded (so `VISIT_DATA_DIR` is set): `visit import <the old database's superuser URL>` (1.x's
   `VISIT_DATABASE_ADMIN_URL`). Setup offers to do it when the `.env` names a 1.x database. The old Postgres must be
   reachable from the machine: one in a container with no port published gets one on `127.0.0.1` for the import.
   It imports only into a workroom with nothing in it yet. **Check:** it prints what came, a count of each
   (accounts, API keys, chat lines, pictures and voice messages, whispers held, bans), and `visit auth user list`
   lists the accounts.
5. **Keep the office's identity**: `VISIT_STATE_FILE` at the old state file, as a path on the machine (one a
   container saw as `/visit/state.json` is in the directory mounted there), and `VISIT_CACHE_DIR` at the old
   `landscapes/` beside it. Without them the office comes up with a new key, and friends who made it their guest
   have to again.
6. **Delete the old services and their settings**: the visit-client, auth-client, engine and Postgres services (in
   compose, or the launcher's lines for them); `VISIT_DATABASE_URL`, `AUTH_DATABASE_URL`,
   `VISIT_DATABASE_ADMIN_URL` and any database password; `VISIT_CLIENT_PATH`, `AUTH_CLIENT_PATH`, `AUTH_VISIT_PROBE`,
   `AUTH_LOG`; the `migrate` and database-roles steps; the engine's key (an `ENGINE_KEY` or key file, its
   `auth-client key add engine`) and the engine's `VISIT_HOST`. In scripts, `auth-client …` is now `visit auth …`.
   **Check:** a search of the launcher, the compose file and the `.env` for `visit-client`, `auth-client`,
   `visit-db`, `visit-engine`, `DATABASE_URL`, `ENGINE_KEY` and `migrate` finds nothing of Visit's.
7. **Reach `visit` on `127.0.0.1`** (step 2, "Where your sim's own server runs"). Best: the room's server on the
   machine too. Else its container on the host's network (`network_mode: host`), the server bound to `127.0.0.1`,
   and whatever told it where Visit was (its own `VISIT_HOST`, `AUTH_HOST`, or a service name in its settings) now
   `127.0.0.1`. A reverse proxy in a container likewise: the host's network, `reverse_proxy 127.0.0.1:<port>`.
8. **The engine's page on `127.0.0.1`**: `ENGINE_ROOM_URL=http://127.0.0.1:<your server's port>/<its page>?role=host`,
   and its origin, `http://127.0.0.1:<port>`, in `VISIT_ORIGINS` (where a container's name was). Your server goes on
   checking the engine's key with `/v1/check` as it checks any key: `visit` makes it, fresh, at each start.
9. **Tokens stay launcher-made files, new each run**: `VISIT_TOKEN_FILE` (the host's: `visit`'s alone),
   `VISIT_USER_TOKEN_FILE` (`visit`'s and your server's, for the relay) and `AUTH_TOKEN_FILE` (`visit`'s and your
   server's), each written before `visit` starts, and before your server starts if it reads them at its start.
10. **Start `visit` from the launcher** (step 2): in the background, its settings in its environment, its pid and
    log in the workroom's own directory; wait for its ready line; SIGTERM to stop it, and wait.
11. **Check it**: `visit status` says it runs; the engine's `/health` (`curl http://127.0.0.1:7405/health`) says
    `"room": "hosting"`; signing in works with an account from before, and a session from before still holds; the
    agents' or scripts' API keys still work; the room loads, its chat history in the chat window. Then step 8, and
    step 9's check.
12. **Write it down**: a line in `VISIT.md`'s History (from what, to 2.0, what was imported, what is kept for going
    back). Keep the old database's volume until your user says it can go.

**Going back**: stop `visit`, check out the tag, and start the old services: their database was only read
(`visit import` changes nothing in it). What happened meanwhile (new chat, new sign-ins) stays in the 2.0 data
directory.

### Worked example: a room whose board ran in Docker

A 1.0 room ran everything in one compose file: its own server (a Python board), a Caddy proxy for the LAN, and
Visit's four services: visit-client on the compose network, auth-client, the engine's image, and Postgres in
`visit-db`, with its state file and landscapes in `.visit/`. Its upgrade:

- **Docker kept for its own server only, on the host's network.** The board's and Caddy's services got
  `network_mode: host`; the board binds `127.0.0.1` (`BOARD_HOST=127.0.0.1`) and finds Visit there (its own
  `VISIT_HOST` and `AUTH_HOST` set to `127.0.0.1`); Caddy proxies to `127.0.0.1:<the board's port>`.
- **Everything of Visit's gone from Docker.** The `visit`, `auth`, `engine` and `visit-db` services were deleted,
  with the database passwords, the roles and `migrate` steps, and the engine's key. The launcher writes the three
  token files, starts `visit` on the machine in the background (its pid file and log in the room's own directory),
  waits for its ready line, and stops it with SIGTERM.
- **What was imported.** With `visit-db` still running and `VISIT_DATA_DIR` set, `visit import` brought its
  accounts, sessions, API keys, chat and the rest of its `visit` and `auth` schemas. `VISIT_STATE_FILE` and
  `VISIT_CACHE_DIR` point at `.visit/state.json` and `.visit/landscapes/`, so its friends still know it.
  `ENGINE_ROOM_URL` is `http://127.0.0.1:<the board's port>/room?role=host`, its origin in `VISIT_ORIGINS`. The old
  `visit-db` volume stays, for going back.
- **Its pages did not change.**

## Don't

- Don't open your own WebSocket, WebRTC or any other connection to the lobby or to other workrooms: Visit
  does all of it, through `visit`.
- Don't bind `visit` to anything but 127.0.0.1, or expose its port from a container.
- Don't change what is in `VISIT_DATA_DIR` by hand, its database's tables included: `visit` keeps it. Back it up
  by copying it while `visit` is stopped.
- Don't reuse or hard-code the token, and don't put it anywhere another origin can read.
- Don't keep anything under your scene's `root` that your user would not show a guest: visitors get all of it.
- Don't trust names, messages or inputs from other workrooms: escape names and messages; Visit already
  clamps inputs and points.
- Don't let a point do anything your user would not let a guest do, and don't decide it by a deny list: an
  allow list, whose default is no.
