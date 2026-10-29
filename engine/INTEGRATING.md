# Building a room on visit-engine

**Written for the coding agent doing the integration.** Read it all before you change anything, then work
through the steps in order; each ends with how to check it. The contract behind it is [SPEC.md](SPEC.md)
(cited as "SPEC n" below; visit's as "visit/SPEC.md n"): look things up there, but you should not need to.

**Experimental** ([#17](https://github.com/sarmiena/Basedverse/issues/17), branch `engine`): the pieces this
guide names are being built in the order of SPEC 11. Until a release says otherwise, nothing here is in a
visit-client you can download. A room built by this guide before then is built against the contract, and runs
when the pieces land.

This guide lives in basedverse's `engine/` directory, beside [`../visit/`](../visit/) and [`../auth/`](../auth/).
It assumes the Visit integration ([../visit/INTEGRATING.md](../visit/INTEGRATING.md), through step 9) and the
auth integration ([../auth/INTEGRATING.md](../auth/INTEGRATING.md), all of it) are done and checked. A greenfield
room does those first, in that order, then this.

## What you are building

Today your room is one page in the owner's tab: the room itself (its scene, its rules) and the person in it. After
this integration it is two pages, and a third program runs beside visit-client:

- **the server page**: your scene, `spawn`, `move`, your interactions, your room's own logic. It runs in
  **visit-engine**, a headless browser in a container beside visit-client, always, whether or not anyone is
  looking. It is the room.
- **the client page**: what a person loads, with a session: Visit's stage, panel and chat window, and your own
  HUD. It draws your room the way a visitor's page draws any room, from the scene the server page sends. It
  runs in any browser: at the desk, a laptop at a coffee shop, a phone.
- **your server** relays the person's connection to visit-client (a WebSocket route behind your session check),
  serves visit.js, and starts the engine with the rest.

Nothing in a browser reaches visit-client on `127.0.0.1` any more, so the exception the auth guide made for Visit
(step 9: "visit-client is the exception") is gone: Visit works from another device like everything else of yours.

Visitors, watchers and friends' worlds see no difference: they only ever saw the bytes visit-client sends.

## The vanilla experience

Everything of [../visit/INTEGRATING.md](../visit/INTEGRATING.md)'s "The vanilla experience" holds: the panel, the
chat window, the stage, the map, mounts, voice, the phone, your physics. All of it is the **client page's**, and
Visit makes it there as before. What the engine adds, for the people using your room:

- **the room is up whenever the office is.** Friends visit, watch and walk onto your plot while your tab is
  closed; your owner's mailbox fills; whispers held for them go when they are back;
- **the owner from any device**, through your server's sign-in, with the same room, the same chat, the same
  world;
- **nothing felt at the desk**: the two halves talk over loopback, under a frame, and the client page walks at
  once as a visitor's does.

For what a vanilla room looks like, basedverse's [README](../README.md) has pictures: a workroom
([office.png](../.github/assets/office.png)), one with a friend over
([friend-over.png](../.github/assets/friend-over.png)), the chat window ([chat.png](../.github/assets/chat.png)).
The reference room is Visit's own test room, [../visit/client/tests/room.html](../visit/client/tests/room.html),
which SPEC 11 step 2 splits into a server page and a client page beside it: copy that split for a greenfield room.

## Before you start

Check these about the room you are integrating; if one is not true, stop and tell your user why.

1. **Visit and auth are integrated and checked** (their checklists pass), and the workroom runs in Docker
   compose, or can: visit-client, auth-client, your server and the engine share one compose network. Without
   compose, every piece can still run on one machine's network on `127.0.0.1` (SPEC 6.1 allows both); this guide
   shows compose.
2. **Your room's code can run with nobody at the keyboard.** Read the page and list what it does with the
   owner's keyboard, mouse, microphone and screen. Each goes to the client page or becomes a visitor's input
   (`move`, `v.interactions`) with `who.owner`:
   - keys that move the owner's own avatar at home → gone from the server page: the owner is walked by `move`;
   - clicks that do things in the room → `v.interactions` marked `visitPoint`, or your own server's API;
   - the owner's name, avatar, mic, chat → the client page (`v.setName`, `v.avatar`, `v.setMic`, the chat window);
   - GPU picking, `readPixels`, `toDataURL` of a WebGL canvas → rewrite as raycasts (nothing is drawn in the
     engine: SPEC 5.1, point 3);
   - anything that needs `document.hasFocus()` or visibility to run → fine (the engine says visible and
     focused).
3. **The room's own state has a home other than the page**, if it must outlive a reload: a reload of the
   engine's page is a reload of the host (SPEC 5.4), as a tab closed by mistake is today.
4. **Your HUD talks to your server**, not to the scene. The boards, consoles and forms of your room will live in
   the client page, where the scene is a copy they must not change.

Then the settings, in your workroom's `.env` (started from [`../.env.example`](../.env.example)'s new `ENGINE_*`
lines): `ENGINE_ROOM_URL` (your server page, by your server's name on the compose network, with `?role=host`
if one page serves both roles: step 2), and the rest at their defaults.

## Step 1 — Get visit-engine

The image, from the same release as visit-client: `bin/setup` pulls `ghcr.io/sarmiena/basedverse/visit-engine:<version>`
(or builds `engine/` with Docker: `docker build -t visit-engine <basedverse>/engine`). Use the same version for
visit-client, auth-client and the engine: the release job checks they match, and so should your launcher.

**Check:** `docker run --rm visit-engine --version` prints the version.

## Step 2 — Split your room

Two pages, or one page that looks at `role`. The split is a cut, not a rewrite: everything under `v.host` stays
in the server page as it is; everything a person touches goes to the client page.

### The server page

```html
<!-- room/server.html: the room. Served to the engine's key only (step 5). No UI; a 1-by-1 canvas is enough. -->
<!doctype html><meta charset="utf-8"><title>my-workroom: the room</title>
<canvas id="c" width="1" height="1"></canvas>
<script src="/visit/visit.js"></script>
<script type="module">
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// Your scene and your floor plan, exactly as visit/INTEGRATING.md step 5 had them in the owner's tab.
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c") });   // its settings travel; it draws nothing here
const blocked = (x, z) => myRoom.isBlocked(x, z);
buildRoom(scene);   // walls, desks, lights; what never changes marked userData.visitStatic = true

// The engine put visit-client's url, the host token and role: "host" into the page (SPEC 5.1, point 2), and reads
// window.visit to see the room is up and who is in it: keep the connection there.
const v = window.visit = await Visit.connect({ ...window.VISIT_ENGINE, sim: { name: "my-workroom", version: "2.0" } });

v.host({
  scene: { root: scene, three: THREE, renderer, near: 0.05, far: 500 },
  fov: 70,
  // The owner arrives like anyone (SPEC 4): who.owner is true for them. at: where they stepped in from a world.
  spawn(who, { at } = {}) {
    if (at) return { x: at.x, y: Number(at.air) || 0, z: at.z, yaw: at.yaw, pitch: 0 };
    return who.owner ? { x: 5, y: 0, z: 3, yaw: 0, pitch: 0 } : { x: 2, y: 0, z: 6, yaw: 0, pitch: 0 };   // the owner at their desk, a guest at the door
  },
  // Your physics (visit/SPEC.md 8.2). The owner is walked here too, by the same rules, or by better ones.
  move(pose, input, dt, who) {
    return Visit.walk(pose, input, dt, { speed: who.owner ? 3.5 : 2.5, blocked });
  },
  walk: { speed: 2.5 },   // what a visitor's page walks at, before your answer; the owner's page uses it too
  plot: { center: [5, 4], size: [10, 8] }, unit: 1,
  preview: { x: 5, y: 6, z: 12, yaw: 0, pitch: -0.4 },
});

// What a click may do (visit/INTEGRATING.md step 5). The owner's clicks arrive here too, with who.owner.
v.interactions({
  spin: { cosmetic: true, label: "spin it", run: ({ object }) => { object.rotation.y += 1; } },
  // Not cosmetic: only with your user's agreement, by name, and then usually for the owner alone.
  // lamp: { cosmetic: false, agreed: true, label: "lights", run: ({ who, object }) => { if (who.owner) toggle(object); } },
});

// Bodies: Visit draws visitors' own models at their feet (visit/SPEC.md 8.6); draw yours only where look is "mine".
// The owner's body is drawn here for OTHERS; their own page draws itself (SPEC 4).
(function frame() {
  requestAnimationFrame(frame);          // 60 a second while anyone is here; the engine slows it when nobody is
  stepAgents();                          // your room's own life
  for (const x of v.visitors) if (x.pose && x.look === "mine") placeMyModelFor(x);   // x.owner: the owner
  renderer.render(scene, camera);        // harmless: the engine makes it a no-op
})();
</script>
```

Rules the server page keeps (SPEC 8.1):

- no keyboard, mouse, microphone or screen; the owner's keys are a visitor's input;
- no pixels read back; raycasts for picking (`v.on("point")` gives `from` and `dir`);
- nothing of the person's: no chat window, panel, name or avatar;
- its own state, if it must outlive a reload, in your server;
- served to the engine's key only (step 5); the key comes with every request to your server's origin, with
  none to a CDN or to visit-client;
- it keeps its connection as `window.visit` (the engine reads it); and, a nicety, your server answers
  `/favicon.ico` with 204, or the engine logs a 404 at each load.

### The client page

```html
<!-- room/index.html: the person. Served to a session (your sign-in). -->
<!doctype html><meta charset="utf-8"><title>my-workroom</title>
<div id="hud"><!-- your boards, consoles, forms: they talk to YOUR server, with the session -->
  <form method="post" action="/logout"><button>sign out</button></form>   <!-- the person's page is signed in: a way out (auth step 6) -->
</div>
<div id="panel"></div>
<script src="/visit/visit.js"></script>
<script>
(async () => {
  // Through your server's relay (step 4): a path on this origin, no token, role "user".
  const v = window.visit = await Visit.connect({ url: "/visit/ws", role: "user", sim: { name: "my-workroom", version: "2.0" } });
  v.on("error", e => console.warn("visit:", e.code, e.message));
  Visit.stage(v);                                         // home, full-window, first person; a visit or a link as before
  Visit.panel(document.getElementById("panel"), v);       // the lobby, the chat window, the map, voice, calls, ⏱
  v.setName(await whoAmI());                              // the name your server has for this session, if it does
})().catch(e => showNoVisit(e));                          // your room's HUD still works without Visit
</script>
```

That is the whole vanilla client page. A room with a camera of its own (third person, from above, your own
avatar for the owner) draws home through the world instead of the stage, with its own three.js:

```js
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }), camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const world = v.world({ three: THREE, renderer });   // no scene: home comes from the host (SPEC 7); friends' plots round it
let me = { x: 5, y: 0, z: 3, yaw: 0, pitch: 0 };
(function frame(t) {
  requestAnimationFrame(frame);
  const input = readMyKeys();                           // { forward, strafe, up, run }; your keys ignore text boxes
  me.yaw += turnFromKeys() * dt;
  const at = world.frame(dt, me, input);                 // sent up: at home to your own room's move, in a plot to its host's
  Object.assign(me, { x: at.x, y: at.y, z: at.z });      // where the host has you (home or a plot), predicted at once
  myAvatar.position.set(me.x, me.y, me.z); myAvatar.rotation.y = me.yaw;   // your own body: you draw it (SPEC 4)
  camera.position.set(me.x + Math.sin(me.yaw) * 7, me.y + 6, me.z + Math.cos(me.yaw) * 7); camera.lookAt(me.x, me.y + 0.8, me.z);
  world.render(camera);
})(0);
```

`world.room` is the home scene's root, for a camera to follow something in it; never change it (the host owns it,
and the next delta would put it back).

**Settings.** Anything a person may change about the room (its look, a door, what is open) is a room setting,
and lives on your server: the client page posts it to a route of yours (with the session), your server keeps it
and tells the server page the way it tells it everything else (its poll, its feed), and the server page rebuilds.
The Sweatshop's environment dropdown works like that (`POST /api/room {env}`; `room.env` in its board's
snapshot). A setting kept in `localStorage` or in the address (`?env=`) changes one browser's idea of a room that
is drawn elsewhere: the engine's page never sees it.

### One page, two roles

One file can serve both: the engine loads it with `?role=host` (your `ENGINE_ROOM_URL` says so), a person loads
it without. The page reads `new URLSearchParams(location.search).get("role")` and builds either the sim or the
HUD. Two files are just as good, and easier to read.

**Check:** the server page, opened in a normal browser with `window.VISIT_ENGINE = { url: "ws://127.0.0.1:7401/ws",
token: "<the host token>", role: "host" }` set in its console first, hosts: your office shows `ready` in another
office's panel. The client page, opened with a session, shows your room in the stage and the panel beside it; its
HUD works; nothing of your room's own UI is left in the server page.

## Step 3 — visit-client on your network

visit-client moves off the host's network and onto compose's, like auth-client did in 0.21.2:

1. `VISIT_LISTEN=0.0.0.0`, **no `ports:`**, no `network_mode: host`. Your server and the engine reach it as
   `visit:7401` (its service name).
2. **Two tokens**, new each run, 32 random bytes as hex, each in a 0600 file under your `.visit/`: `token` (the
   host's: visit-client and the engine) and `user-token` (the user's: visit-client and your server). The old
   `visit.json` that handed `/api/visit` its token goes away.
3. `VISIT_ORIGINS` lists your server's origins: the local ones, the HTTPS proxy's, and your server's name on the
   network, which is what the engine's page has (`http://board:3001`).
4. Its database as before (`visit-db`, by name).

```yaml
  visit:
    build: ${BASEDVERSE:-../../basedverse}/visit/client
    restart: unless-stopped
    user: "${VISIT_UID:-1000}:${VISIT_GID:-1000}"
    environment:
      VISIT_LISTEN: 0.0.0.0                     # this container's network only: no `ports:`
      VISIT_LOBBY: ${LOBBY_URL:-}
      VISIT_NAME: ${LOBBY_NAME:-}
      VISIT_SIM: my-workroom/2.0
      VISIT_TOKEN_FILE: /visit/token            # the host's
      VISIT_USER_TOKEN_FILE: /visit/user-token  # the user's
      VISIT_STATE_FILE: /visit/state.json
      VISIT_DATABASE_URL: postgres://visit:${VISIT_DB_PASSWORD:-}@visit-db:5432/visit
      VISIT_ORIGINS: http://localhost:3001,http://127.0.0.1:3001,https://${REMOTE_HOST:-}:3443,http://board:3001
    volumes:
      - ../.visit:/visit
    depends_on:
      visit-db:
        condition: service_healthy
```

```sh
# the launcher, each start: two tokens, 0600, before `up`
(umask 077
 head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > .visit/token
 head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > .visit/user-token)
```

**Check:** on the host, `ss -ltnp` shows nothing on 7401 and `curl http://127.0.0.1:7401/health` does not
connect; from your server's container, `curl http://visit:7401/health` answers `{"ok": true, …}`.

## Step 4 — Serve the library, and relay the person

Two routes on your server. Both sit behind your session check (auth step 5), like every route.

- **`GET /visit/visit.js`**: proxied from `http://visit:7401/visit.js` on each request (no caching beyond what
  visit-client's headers say), so both pages always run the library their visit-client speaks.
- **`GET /visit/ws`**, a WebSocket upgrade: the relay (SPEC 6.3). A session, never an API key. It opens a
  WebSocket to `ws://visit:7401/ws` with the browser's `Origin`, sends the **relay preface** as the first
  message, then pipes bytes both ways unread. It never parses a frame after the preface, never forwards a token
  from the browser, buffers at most 1 MiB toward the browser (then closes both ends 4408), and holds one
  connection per session (a second replaces the first, 4409).

A sketch in Python's standard library (the shape, not a library; your server's own HTTP handling goes round it):

```python
import base64, hashlib, json, os, selectors, socket, threading

VISIT = (os.environ.get("VISIT_HOST", "visit"), int(os.environ.get("VISIT_PORT", "7401")))
USER_TOKEN = open(os.environ["VISIT_USER_TOKEN_FILE"]).read().strip()
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
live = {}   # session hash -> the browser's socket, to replace a second connection's first

def masked_text(obj):
    """One client-to-server text frame (RFC 6455: masked), for the preface. Under 126 bytes of payload."""
    data, key = json.dumps(obj).encode(), os.urandom(4)
    return bytes([0x81, 0x80 | len(data)]) + key + bytes(b ^ key[i % 4] for i, b in enumerate(data))

def relay(handler):
    """handler: your server's request handler, after the session check passed (a session, not a key)."""
    h = handler.headers
    if h.get("Upgrade", "").lower() != "websocket" or not h.get("Sec-WebSocket-Key"):
        return handler.send_error(400)
    up = socket.create_connection(VISIT, timeout=10)
    up.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    up.sendall(("GET /ws HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\n\r\n"
                % (VISIT[0], VISIT[1], base64.b64encode(os.urandom(16)).decode(), h.get("Origin", ""))).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = up.recv(4096)
        if not chunk:
            return handler.send_error(502)
        head += chunk
    if not head.startswith(b"HTTP/1.1 101"):
        return handler.send_error(403 if b" 403" in head[:20] else 502)   # 403: the browser's Origin is not in VISIT_ORIGINS
    up.sendall(masked_text({"type": "relay", "token": USER_TOKEN, "role": "user"}))
    accept = base64.b64encode(hashlib.sha1((h["Sec-WebSocket-Key"] + GUID).encode()).digest()).decode()
    handler.send_response(101); handler.send_header("Upgrade", "websocket"); handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept); handler.end_headers(); handler.wfile.flush()
    down = handler.connection
    down.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    old = live.get(handler.session); live[handler.session] = down
    if old:
        try: old.sendall(b"\x88\x02" + (4409).to_bytes(2, "big")); old.close()   # the first connection: replaced
        except OSError: pass
    pump(down, up, head[head.index(b"\r\n\r\n") + 4:])

def pump(down, up, leftover):
    """Bytes both ways, unread, until either side closes. At most 1 MiB waiting for the browser, else 4408."""
    sel = selectors.DefaultSelector(); sel.register(down, selectors.EVENT_READ); sel.register(up, selectors.EVENT_READ)
    for s in (down, up): s.setblocking(False)
    to_browser = bytearray(leftover)
    try:
        while True:
            for key, _ in sel.select(timeout=30):
                data = key.fileobj.recv(65536)
                if not data:
                    return
                if key.fileobj is up:
                    to_browser += data
                    if len(to_browser) > 1 << 20:
                        down.sendall(b"\x88\x06" + (4408).to_bytes(2, "big") + b"slow"); return
                    try: sent = down.send(to_browser); del to_browser[:sent]
                    except BlockingIOError: pass
                else:
                    up.sendall(data)   # the browser's frames, masked already, as they are
    except OSError:
        return
    finally:
        for s in (down, up):
            try: s.close()
            except OSError: pass

# in your handler, for GET /visit/ws, after the session check: threading.Thread(target=relay, args=(self,), daemon=True).start()
```

`/api/visit` and the `/v1/visit` call behind it go away for this room (keep neither: a token in a browser was the
thing to remove). Your client page needs nothing but its session.

**Check:** with a session, `GET /visit/visit.js` is the library; without one, 401. From the client page's console,
`new WebSocket("/visit/ws")` opens and, after the page's `hello`, gets `ready` with `"role": "user"`; from another
origin, or without a session, it does not open. `ss -ltnp` on the host: no 7401.

## Step 5 — The engine from your launcher

1. **An API key for the engine**, once: `auth-client key add engine` (your `bin/auth`), its value written to
   `.visit/engine-key` (0600) when first made; revoke and make a new one if it ever leaks.
2. **Serve the server page to that key only**: `GET /room/server` (and every file it loads) answers a request
   whose `Authorization: Bearer` is a key auth-client accepts (`/v1/check {key}`, as for agents, auth step 11),
   and nothing else: not a session (a person never needs the room's code), never without one.
3. **The engine service**, on the compose network, after visit-client and your server (it retries until both
   answer, but a clean start is quieter):

```yaml
  engine:
    image: ghcr.io/sarmiena/basedverse/visit-engine:${BASEDVERSE_VERSION}   # or build: ${BASEDVERSE}/engine
    restart: unless-stopped
    user: "${VISIT_UID:-1000}:${VISIT_GID:-1000}"
    environment:
      ENGINE_ROOM_URL: http://board:3001/room/server    # ?role=host if one page serves both
      ENGINE_KEY_FILE: /visit/engine-key
      VISIT_HOST: visit
      VISIT_PORT: "7401"
      VISIT_TOKEN_FILE: /visit/token                    # the host's: the engine's alone, beside visit-client
    volumes:
      - ../.visit:/visit:ro
    depends_on:
      - visit
      - board
```

Your server gets `VISIT_HOST=visit`, `VISIT_PORT=7401` and `VISIT_USER_TOKEN_FILE=/visit/user-token`; it must
not have the host token. Start order: `visit-db` (healthy), `visit migrate`, `auth`, `visit`, `board`, `engine`.
Stop the engine with the rest.

**Check:** `docker compose logs engine` ends with the room hosting (`room: hosting`); from your server's
container, `curl http://engine:7405/health` says `"room": "hosting"`; on the host nothing answers on 7405.
Another office's panel shows yours `ready` **with your tab closed**. Restart `board` alone: the engine loads the
page again and the room is back within its backoff; restart `engine` alone: visitors see `host_paused`, then the
room again. `docker stats engine`: memory in the hundreds of MB, CPU a few percent with the room idle.

## Step 6 — At the desk: nothing felt

Open the client page at `http://localhost:3001`, signed in.

1. **It is your room.** The stage shows home from your `spawn(who.owner)`; the panel lists you `ready`; the
   chat window has your log; your friends' plots are round your room on the map.
2. **Walking feels as it did.** WASD moves at once (the host's `walk`), turning is instant, you stop at your
   walls; your `move` gives the owner whatever it gives them.
3. **Nothing of the old page is missed**: every button and board of your HUD is in the client page and works,
   through your server.
4. **Measure it.** ⏱ in the panel (`v.perf(true)`), two minutes walking, "copy report": frame time and stalls as
   before the split, and "key to correction" (the `home` channel's) under a frame or two on loopback. Keep the
   before and after; SPEC 11 step 3 wants them.
5. **Close the tab.** From another office: your room is still there, still visitable; a whisper to you lands in
   your mailbox. Open the tab again: 📬 says so.
6. **Reload the engine's page** (`docker compose restart engine`): the stage says the room is paused, then shows
   it again, where it was.

**Check:** all six, and the ⏱ reports kept.

## Step 7 — From another device

Through the HTTPS proxy of auth step 10, on your LAN first, then from outside it (Tailscale, or a café):

1. sign in; the client page loads; the stage shows your room; the panel and chat work;
2. walk, turn, step onto a friend's plot and back; talk (the mic); whisper; share a picture;
3. close the laptop: the room stays up; open it: you are where you were, or at `spawn` after a while;
4. the desk's tab and the laptop's at once: the newer replaces the older (4409), the room unmoved.

**Check:** all four, from outside your LAN too; `ss -ltnp` on the office machine still shows no 7401 and no 7405.

## Checklist

- [ ] Visit's and auth's checklists still pass.
- [ ] Two pages (or one with `role`): the server page has the scene, the hooks and the room's logic, nothing of the
      person's, no keyboard, mouse, mic or pixels read back; the client page has the stage (or your camera through
      `v.world`), the panel, the chat window, and your HUD, which talks to your server.
- [ ] The owner is spawned and walked by your hooks (`who.owner`); their clicks reach your interactions as a
      visitor's do; cosmetic interactions only, unless agreed by name.
- [ ] visit-client on the compose network: `VISIT_LISTEN=0.0.0.0`, no `ports:`, no `network_mode: host`; nothing
      on the host's 7401.
- [ ] Two tokens each start, 0600: the host's to visit-client and the engine; the user's to visit-client and your
      server; neither in a page, a response, a URL or a log; `visit.json` and `/api/visit` gone.
- [ ] `VISIT_ORIGINS` names the local origins, the proxy's, and your server's name on the network.
- [ ] `/visit/visit.js` proxied; `/visit/ws` relayed behind the session check (a key refused): the preface, bytes
      unread after it, 1 MiB then 4408, one connection per session.
- [ ] The engine's key made with `auth-client key add engine`, kept 0600; the server page served to that key only.
- [ ] The engine on the compose network, `/health` unpublished, `room: hosting`; the room `ready` with every tab
      closed; a restart of your server alone, and of the engine alone, each recovers by itself.
- [ ] At the desk: walking feels as before; the ⏱ reports, before and after, kept.
- [ ] From another device: step 7 passes; nothing on the office machine's host ports but the proxy's.
- [ ] `visit-client`, `auth-client` and `visit-engine` from one release; `migrate --status` up to date.
- [ ] Nothing the browser decided decides the room: no `localStorage`, `matchMedia` or `?query` behind the server
      page's look; the environment, the theme, the owner's look through your server.
- [ ] Every mark the person's page reads is a name, not `userData`; every geometry you deform is a plain one.
- [ ] The room draws its owner (`look` hook) and the person's page shows that copy (`self: "room"`); poses the
      old page gave `me` are given the owner's body.
- [ ] Clicks aimed at what the person's ray met; the hand by `visitPoint`; your click division kept, `visitor.owner`
      yours; the reach rule said on the person's page.
- [ ] The jump, and any physics the page did to its owner, in `move`.

## Troubleshooting

| symptom | cause |
|---|---|
| the engine logs `failed`, `could not load` | `ENGINE_ROOM_URL` wrong, or the server page refuses the engine's key (check `/v1/check` with it); from the engine's container, `curl -H "Authorization: Bearer $(cat /visit/engine-key)" $ENGINE_ROOM_URL` |
| the engine logs `ready` never came | the server page's `Visit.connect` fails: `window.VISIT_ENGINE` not passed through, `/visit/visit.js` not served, or the host token wrong (4401: the engine's token file is not visit-client's) |
| visit-client closes the engine's page 4409 at once, again and again | something else connects as the host with the host token: an old `room.html` still open in a tab with no role (it takes both slots), or two engines |
| the client page connects, then 4401 | the relay's user token is not visit-client's `--user-token-file` (a stale file; two launchers) |
| the client page's `new WebSocket("/visit/ws")` fails with 403 | the browser's `Origin` is not in `VISIT_ORIGINS` (the relay passes it through): add the origin the address bar shows |
| the client page connects, but `v.home` stays null | no host: the engine is down or still loading (`/health`), or its page hosts nothing (`v.host` not called: its console, in the engine's log) |
| `wrong_role` in the client page's console | your client page calls a host-only method (`v.host`, `v.interactions`, `v.listener`): move it to the server page |
| `wrong_role` in the engine's log | the server page calls a person's method (`v.say`, `v.setMic`, `v.avatar`, `v.setName`, `v.world`, `Visit.panel`): move it to the client page |
| the owner walks through walls, or faster than guests do | your `move` treats `who.owner` differently than you meant; or the client page gives its own position to `world.frame` instead of taking `at` back |
| the stage shows the room, but the owner's own model is missing | the user's page draws itself (SPEC 4): in a stage there is nothing to draw (first person); with `v.world`, put your avatar at `at` |
| a sign or a screen in the room never updates | its canvas is a WebGL canvas read back (`toDataURL`): draw it on a 2D canvas, which is real in the engine |
| the room stops moving when nobody is there | that is `ENGINE_TICK_IDLE`: 10 frames a second with nobody in it, watching it, or connected. Raise it if your room's logic needs more, or use a timer |
| the engine's memory climbs until it restarts | the room's page leaks (geometries or textures made each frame and never disposed); profile it in a normal browser |
| a slow laptop's page keeps closing 4408 | the scene is too big for its link (the relay's 1 MiB): a landscape marked `visitStatic` is sent once and cached; mark more of the room static |
| walking from the laptop lags behind the keys | the room gives no `walk` (`v.host`): then walking waits for the round trip; give the speed your `move` uses |
| `/api/visit` is still asked for | an old client page: it must connect through `/visit/ws` with no token |
| the room's colours are wrong for the person: white walls, day under a dark theme, the wrong environment | the engine's page decided from its own browser (light, an empty `localStorage`): the setting, the theme, the look go through your server (Upgrading, below) |
| two rooms over each other, a striped floor | the person's page still builds scenery of its own (an environment from the address or `localStorage`) |
| a deformed primitive arrives as the primitive (round boulders) | a primitive travels as its recipe: a plain `BufferGeometry` |
| walls, slopes or the ground ghost or fade wrongly on the person's page | your fade reads `userData` marks, which do not travel: names |
| clicks do nothing, no hand over a seat | the page points where the body faces, not where the mouse was: `world.point(hit.point)`; the hover looks for `visitPoint` in the received scene |
| the engine's log says the owner ate, sat or threw (`-> thing`, `-> throw`) and the person saw nothing | Visit drew the avatar over the room's posed dude: `look` hook "mine" for `who.owner`, `v.world({ self: "room" })` |
| the owner cannot jump | the page's own physics: a jump in `move` |
| `Unsupported geometry type "EdgesGeometry"`, `Undefined geometry` in the person's console | a plot from an older host: its outlines arrive empty, harmless |

## Upgrading

[../CHANGELOG.md](../CHANGELOG.md), as for Visit: the engine's image, visit-client and auth-client move together,
one version; `visit-client migrate` after each.

### A room that hosts today: what the first one taught

The Sweatshop made the split in a day, then spent a day at the desk finding what the split breaks. Every item
below cost an hour of looking at a wrong room. Read them before you start; go down them after. The lobby did not
change: a room on an older Visit visits you and is visited as before, so nobody else has to move when you do.

**Everything your page took from the browser is now the engine's, not the person's.**

- The environment picked in a dropdown and kept in `localStorage` or `?env=`: the engine's page drew its own
  (the default) under the person's, two rooms over each other, a striped floor. A setting goes to your server;
  every page follows the snapshot ("Settings", above).
- Dark mode: headless Chromium is light. The room drew its day palette, white walls and floor, under a dark
  theme. The person's page tells your server its theme; the engine's page sets `data-theme` from it, so its CSS
  colours, palettes and lights follow.
- The owner's look, picked at random and kept in the browser: the room's page had no idea of it. Through your
  server too.
- The rule: grep your page for `localStorage`, `matchMedia`, `prefers-color-scheme`, `location.search`,
  `devicePixelRatio`, `innerWidth`. Each is a decision that moves to your server, or is made per page on purpose.

**What travels, and what does not.**

- `userData` is stripped to `visitor`, `visitPoint` and `visitRider`. Every mark your page read to decide things
  (what is a floor, what is rock, what may fade, what is a roof to lift) is gone on the person's page: the
  mountain's slopes ghosted, the ground you walked on faded. Names travel: suffix them (`#floor`, `#rock`,
  `lid:`) where you build, and read them on the person's page.
- A primitive geometry travels as its recipe: corners you pulled arrive unpulled (round boulders). Copy it into a
  plain `BufferGeometry` first (visit/INTEGRATING.md).
- An `EdgesGeometry` or `WireframeGeometry` travels as its lines from this release on; from an older host it
  arrives empty.
- Visibility you toggle at draw time for your own camera (a cave's roof lifted for the overview) reaches nobody:
  the person's page does the same to the received scene, by name.

**The owner is a visitor now, and your page is two.**

- Physics your page did to its owner locally (a jump, falling, a mount's lift) is gone: the room walks them.
  Move it into `move`, for everyone (a jump on `up`, once a press).
- Clicks: a visitor's point is a direction from their eyes, and a third-person camera's mouse ray is not. The
  person's page casts its own ray into the received scene and calls `world.point(hit.point)`, which aims from the
  eyes at it; the hand shows for `userData.visitPoint` there, with some slack for small things (a mosquito).
- Your division of clicks (yours against a guest's): the owner's clicks arrive as a visitor's point. Keep the
  table: `visitor.owner` marks them yours, entries that open things on your screen never run from a point, and
  the typed path (Visit's interactions) passes `visitor` too.
- The room's word to a visitor ("you are too far away") does not reach a screen: say the rule on the person's
  page as well.

**Who draws the owner.**

- With the panel on "visitors look like their model", Visit draws the owner's avatar with its own clips (walk,
  idle, ride). The room's poses (a seat, a drink, the peel in a hand) happen to the room's own dude, hidden under
  it. The owner clicked bananas and saw nothing; the engine's log said `-> throw`. The room draws its owner:
  `look: who => who.owner ? "mine" : undefined` in `visit.host`, with the look from your server; the person's
  page shows the room's copy, `v.world({ self: "room" })`, and hides its own dude at home. Your old page's poses
  for `me` (sat at a wheel) become poses for the owner's body in your visitor code.
- Shadows and lights travel whole (checked pixel by pixel). The owner's own dude had no shadow because it lived in
  the page's scene, apart from the floor; the room's copy has one.

**Operating it.**

- The engine's log is your only screen: `console.info` in the server page lands there. Log each point and each
  `tell` while proving; `ENGINE_DEBUG=1` gives `/debug/eval` on the compose network, for the proving alone.
- Never `docker compose up -d engine`: it recreates visit-client without the launcher's environment, a crash
  loop and the room gone. Use the launcher; `docker compose restart engine` reloads the page alone. Every engine
  restart reloads the page, and whatever you poked into it.
- The person's page reconnects by itself when visit-client restarts, but a page loaded before a deploy keeps the
  old code: reload before judging anything.
- Tests that grep your page (a click table's gate) break on the refactor: move them with it.

## Don't

- Don't give the browser a Visit token, host or user, by any route: the relay puts the user token in, and the
  engine puts the host token into its own page.
- Don't serve the server page to a session, or without the engine's key: it is your room's code.
- Don't publish visit-client's or the engine's port, or put visit-client back on the host's network for a
  container to reach it: your server relays, on the compose network.
- Don't keep anything of the person's in the server page (chat, name, avatar, mic), or anything of the room's
  truth in the client page (a client page that moves furniture is overwritten by the next delta).
- Don't read pixels back in the server page: nothing is drawn there.
- Don't let the owner's clicks do more than a guest's without `who.owner` checked in the hook, and don't let a
  non-cosmetic interaction in without your user's agreement, by name.
- Don't add a switch between "the tab hosts" and "the engine hosts": a room has a server half or it has not.
