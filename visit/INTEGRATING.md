# Integrating Visit into your workroom

**Written for the coding agent doing the integration.** Read it all before you change anything, then work
through the steps in order; each ends with how to check it. The contract behind it is
[SPEC.md](SPEC.md): look things up there, but you should not need to.

This guide lives in the `visit/` directory, beside `client/` (visit-client's source and visit.js) and
[SPEC.md](SPEC.md). Paths below are relative to it.

## What you are building

Your sim draws an office (a "workroom") in a browser page. After this integration:

- it shows up in a lobby where other workrooms are, and can knock on theirs or let them in;
- **as a host**, it lets up to a few visitors walk around your room: for each one, your page renders your
  room from where that visitor stands, and Visit streams it to them;
- **as a visitor**, it shows the room you are walking around, and sends your WASD and mouse to its host.

You get two shared pieces you do not modify:

- **visit-client**: a program that runs beside your sim on the same machine and does all the networking
  (the lobby, the connections to other workrooms). It listens on 127.0.0.1 only and needs a token.
- **visit.js**: the library your page loads from visit-client. It talks only to visit-client, calls your
  hooks, encodes and decodes the video, captures input.

You write: a launcher step (start visit-client with a token), a way to hand the token to your page, three
host hooks, and a little UI (or use the ready-made panel). Your page never opens any connection to
another machine itself.

## Before you start

Check these about the sim you are integrating; if one is not true, stop and tell your user why.

1. **It renders its room in a browser page**, into a canvas (WebGL, WebGPU or 2D).
2. **It can draw its room from an arbitrary camera**, a second time, without disturbing what its own
   window shows. In three.js that is a second camera and a second renderer on the same scene (step 5). In
   other engines, look for "render to texture", "offscreen canvas" or "second viewport".
3. **It has something that starts it** (a script, a server, a desktop launcher) that can also start
   another program and keep it running while the sim runs.
4. **The browser has WebCodecs** (`'VideoEncoder' in window`): current Chrome, Edge, Safari and Firefox
   do.
5. **Its page is served from the same machine** (`http://localhost:…` or `http://127.0.0.1:…`). A page
   served from a public `https://` site can be stopped by some browsers from reaching 127.0.0.1.

Then gather:

- the **lobby URL** (`wss://…`), from whoever runs your lobby;
- the **office name** your user wants (1–24 letters, digits, space, `_ . -`, starting and ending with a
  letter or digit);
- your sim's **name and version**, e.g. `my-workroom/1.0`.

## Step 1 — Get visit-client

Put the `visit-client` binary for your machine somewhere your launcher can run it:

- **Linux:** `client/build` makes a static `client/bin/visit-client` in Docker (nothing to install); a
  binary someone built that way on the same CPU architecture works too.
- **macOS or Windows:** with Rust installed (https://rustup.rs), `cargo build --release` in `client/` gives
  `client/target/release/visit-client`. It has to run natively there: a container cannot listen on the
  machine's own 127.0.0.1.

Check: `visit-client --help` prints its flags. You do not need visit.js separately: visit-client serves it.

## Step 2 — Start visit-client from your launcher

Every time your sim starts:

1. **Make a new token**: 32 random bytes from a cryptographically secure source, as 64 hex characters.
   Never a fixed string, never reused between runs.
2. **Write it to a file only your user can read** (mode 0600), so it stays off the process list.
3. **Start visit-client** with your settings, and keep it running while your sim runs.
4. **Wait for its ready line** on stdout (`{"ready": true, …}`) before opening your page.
5. **Stop it** when your sim stops.

```sh
# a shell launcher
umask 077
TOKEN_FILE="${XDG_RUNTIME_DIR:-/tmp}/my-workroom-visit.token"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
visit-client --lobby "wss://lobby.example/" --name "Magic Room" --sim my-workroom/1.0 \
             --port 7401 --token-file "$TOKEN_FILE" --origins "http://localhost:3000" &
VISIT_PID=$!
trap 'kill $VISIT_PID' EXIT
```

```js
// a Node launcher
const { randomBytes } = require("crypto"), fs = require("fs"), { spawn } = require("child_process");
const token = randomBytes(32).toString("hex"), tokenFile = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/my-workroom-visit.token`;
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const visit = spawn("visit-client", ["--lobby", LOBBY_URL, "--name", OFFICE_NAME, "--sim", "my-workroom/1.0",
                                     "--port", "7401", "--token-file", tokenFile, "--origins", "http://localhost:3000"],
                    { stdio: ["ignore", "pipe", "inherit"] });
process.on("exit", () => visit.kill());
```

```python
# a Python launcher
import secrets, os, subprocess, atexit
token = secrets.token_hex(32)
token_file = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "my-workroom-visit.token")
fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, token.encode()); os.close(fd)
visit = subprocess.Popen(["visit-client", "--lobby", LOBBY_URL, "--name", OFFICE_NAME, "--sim", "my-workroom/1.0",
                          "--port", "7401", "--token-file", token_file, "--origins", "http://localhost:3000"],
                         stdout=subprocess.PIPE)
atexit.register(visit.terminate)
```

`--origins` is your page's origin (scheme, host and port, as the address bar shows them; list
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

## Step 5 — Be a host: `spawn`, `move`, `render`

Register your hooks once, right after `connect` (on every page load: Visit keeps visits across reloads and
asks the new page to render them).

```js
visit.host({
  // Where a new visitor appears: a pose of your choosing. Visit only stores it and hands it back.
  spawn(visitor) {
    return { x: 0, y: 1.6, z: 6, yaw: 0, pitch: 0 };   // standing at your room's entrance, eye height 1.6
  },
  // Where the visitor may go. Visit has already set pose.yaw and pose.pitch from where it is looking;
  // you move it with input.forward / input.strafe / input.run, against your own walls and furniture.
  move(pose, input, dt) {
    return Visit.walk(pose, input, dt, { speed: 2.5, blocked: (x, z) => myRoom.isBlocked(x, z) });
  },
  // Your room seen from pose, into a canvas of width x height. Return the canvas.
  render(pose, width, height) {
    return renderVisitorView(pose, width, height);
  },
});
```

**`Visit.walk`** does first-person walking for you: speed in your world's units per second (Shift runs
at twice that), sliding along walls when `blocked(x, z)` says the way is shut. Its pose is
`{ x, y, z, yaw, pitch }`: y up, yaw 0 looking toward −z, positive yaw turning left, positive pitch looking
up (three.js's camera convention, Euler order `"YXZ"`). If your world's axes differ, write `move`
yourself; the pose is yours.

**`blocked(x, z)`** is your room's floor plan: true where a visitor may not stand (walls, desks, outside
the room). Keep a margin of about 0.3 of your units so visitors do not stand inside furniture.

### `render` in three.js

One extra renderer and camera, on your existing scene, reused for every visitor:

```js
const visitRenderer = new THREE.WebGLRenderer({ antialias: true });   // its own canvas, never added to the page
const visitCamera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 500);
visitCamera.rotation.order = "YXZ";
function renderVisitorView(pose, width, height) {
  visitRenderer.setSize(width, height, false);
  visitCamera.aspect = width / height; visitCamera.updateProjectionMatrix();
  visitCamera.position.set(pose.x, pose.y, pose.z);
  visitCamera.rotation.set(pose.pitch, pose.yaw, 0);
  visitRenderer.render(scene, visitCamera);
  return visitRenderer.domElement;
}
```

### `render` in other engines

Render your scene from a camera at the pose into an offscreen target of `width` x `height`, and return a
canvas (an `HTMLCanvasElement` or `OffscreenCanvas`) holding that image. Do not draw into your page's
visible canvas.

### Rules for `render`

- It is called up to 30 times a second **per visitor** (pass `fps: 15` to `visit.host` to ask for less),
  one visitor at a time. Visit captures the canvas right
  after each call, so you may reuse one canvas for all of them.
- It must not change what your own window shows, or your own camera.
- Keep it fast: aim for under 5 ms at 1280×720. Visit lowers a visitor's frame rate (to no less than 10)
  when rendering for visitors takes more than a quarter of your page's time, so a slow `render` makes
  choppy visits rather than a frozen room. If your room is heavy, render visitors with fewer effects
  (no shadows, lower detail) than your own view.
- Everything it draws is seen by the visitor. If your room shows things your user would not show a guest,
  leave them out of `render`.

**Check (once step 6 works, from a second workroom):** a visitor sees your room from your spawn point,
walks with WASD, stops at your walls, and looks around with the mouse.

## Step 6 — Be a visitor: show the room you are in

When you are visiting, show the host's room in an element of your page; Visit draws it there and captures
the keyboard and mouse while it is shown:

```js
let view = null;
function showVisit() {
  if (visit.visiting && !view) { stage.hidden = false; view = visit.view(stage); }       // stage: a full-window element
  if (!visit.visiting && view) { view.release(); view = null; stage.hidden = true; }
}
visit.on("change", showVisit);
showVisit();   // now too: after a reload mid-visit, you are already visiting
```

Inside the element Visit creates a canvas that fills it. Click it to look around (it takes the pointer);
Esc gives the pointer back; WASD/arrows walk, Shift runs. While the host's page is reloading, the view
holds its last frame and says so. Give your user a way to leave: a button calling `visit.leave()`.

**Check:** with a host to visit (step 8), its room fills your element, and WASD and the mouse move you
in it.

## Step 7 — The lobby: knocking and letting in

The quickest way: the ready-made panel, in any element of yours (a corner of the page, say):

```js
Visit.panel(document.getElementById("visit-panel"), visit);
```

It lists the workrooms online (with whether each is available, how many visitors it has and takes), lets
your user knock with a message, shows knocks on your door with **Let in** / **Not now**, shows your
visitors (with **Kick**) and your visit (with **Leave**), and sets your status and max visitors.

Or build your own from the state and actions: `visit.offices`, `visit.knocks`, `visit.visiting`,
`visit.visitors`, `visit.knock(id, message)`, `visit.answer(knockId, true | false)`, `visit.leave()`,
`visit.kick(visitId)`, `visit.setStatus("available" | "busy")`, `visit.setMaxVisitors(n)`; redraw on
`"change"`. Rules your UI must follow:

- Offer **Knock** only for offices that are `ready`, `available`, not you, not full
  (`visitors < maxVisitors`), and not the one you are visiting.
- Show each knock on your door with who, their message and the seconds left, and both answers.
- Escape all names and messages before putting them in HTML: they come from strangers.

**Check:** your user can see other workrooms, knock, and answer a knock.

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

- [ ] visit-client starts with your launcher, with a new token each run, and stops with your sim.
- [ ] It listens on 127.0.0.1 only; the token is in a 0600 file, not on the command line; `--origins` names
      your page's origin.
- [ ] Your page gets the token by a same-origin route (answering only `Host: localhost` or `127.0.0.1`), a
      fragment kept in `sessionStorage`, or a local file; no other origin can read it, and it never appears
      in a URL query or a log.
- [ ] Your sim works as before when visit-client is not running.
- [ ] `spawn` puts visitors somewhere sensible; `move` keeps them out of walls and furniture.
- [ ] `render` draws your room from the pose without touching your own view, fast enough for 30 fps per
      visitor, and leaves out anything your user would not show a guest.
- [ ] Your hooks are registered on every page load.
- [ ] Visiting: the host's room fills your element; WASD, Shift and the mouse work; Esc frees the pointer;
      there is a way to leave.
- [ ] The lobby: offices, knocks, answers, visitors (kick), your visit (leave), status and max visitors
      all work, with the knock rules of step 7; names and messages are escaped.
- [ ] Step 8 passes, reloads included.

## Troubleshooting

| symptom | cause |
|---|---|
| `visit.js` fails to load | visit-client is not running, or on another port; check `curl http://127.0.0.1:<port>/health` |
| connect fails before it opens (HTTP 403) | your page's origin is not in `--origins`: compare the address bar's scheme, host and port with it |
| connect closes with 4401 | the token your page sent is not the one visit-client was started with: a stale `visit.json`, two launchers, or visit-client restarted while the page kept its old token (hand `connect` a token function, step 4) |
| connect closes with 4409 | another page of yours connected after this one; only the newest page is live |
| `state` stays `"offline"` | visit-client cannot reach the lobby: wrong `--lobby` URL, or no network; its stderr says why |
| you never become `ready` in the lobby | visit-client could not start its connection endpoint; its stderr says why |
| knocks refused `not_ready` | you or the door have not published a link yet; wait a few seconds |
| a visit ends `link_failed` | the two machines could not connect, even through the relay; check the relay is up |
| the visitor sees a black or frozen view | `render` returned a canvas that was not drawn (cleared, or a different canvas), or threw (see the console) |
| visitors walk through walls | your `blocked` does not cover them, or your `move` ignores it |
| visitors' view slows to a crawl while your tab is in the background | your page's Content-Security-Policy forbids `blob:` workers, so the library's timer is the page's own (slowed in the background): allow `worker-src blob:` |

## Don't

- Don't open your own WebSocket, WebRTC or any other connection to the lobby or to other workrooms: Visit
  does all of it, through visit-client.
- Don't bind visit-client to anything but 127.0.0.1, or expose its port from a container.
- Don't reuse or hard-code the token, and don't put it anywhere another origin can read.
- Don't render visitors' views into your own visible canvas.
- Don't trust names, messages or inputs from other workrooms: escape names and messages; Visit already
  clamps inputs.
