# Visit — the specification

**Status: built** (visit-client and visit.js in `client/`, the lobby's version 3 in `../lobby/server/`) and
tested on one machine (Visit 0.4 went between two machines over the internet; 0.5 not yet). This is the
contract they are built to. Where it says MUST, SHOULD or MAY, those words mean what RFC 2119 says they mean.

Visit lets the people running agent-office sims ("workrooms") walk around each other's rooms. Every room
is made with three.js. A visitor moves with WASD and the mouse; the host sends its room's scene, as data,
and the visitor's browser draws it, with the host's very three.js release, as quickly as it draws its own
room. The host decides where the visitor may stand; what moves in its room reaches the visitor as it moves.

If you are integrating Visit into a sim, read [INTEGRATING.md](INTEGRATING.md) instead: it is the
how-to. This file is the contract behind it, for whoever builds or changes the shared pieces.

## 1. The pieces

```
           ┌──────────────── lobby server (wss) ─────────────────┐
           │ presence, knocks, visits, link addresses            │
           ▼                                                     ▼
 your machine                                       their machine
 ┌──────────────────────────────┐                   ┌──────────────────────────────┐
 │ your sim's page              │                   │ their sim's page             │
 │   visit.js  ◄─ localhost ─►  │                   │  ◄─ localhost ─►  visit.js   │
 │             visit-client ◄═══╪═══ the link ══════╪═══► visit-client             │
 └──────────────────────────────┘  (QUIC, iroh;     └──────────────────────────────┘
                                    via the relay if
                                    no direct path)
```

| piece | what it is | who provides it |
|---|---|---|
| **visit-client** | the local client: a Rust binary, one per sim per machine. Owns **all** networking: the lobby session, the links to other visit-clients, visit state. Listens on 127.0.0.1 only. | shared, identical for everyone |
| **visit.js** | the library, in the sim's page. Talks only to its own visit-client. Sends the room's three.js scene to its visitors and moves them with the sim's hooks; draws the scene of the room it visits; captures input. Served by the visit-client itself, so the two always match. | shared, identical for everyone |
| **lobby server** | presence, knocks, and introducing visit-clients to each other (`basedverse-lobby/3`, section 6). | shared, one server |
| **relay** | an [iroh](https://iroh.computer) relay, for links between machines that cannot reach each other directly. Encrypted end to end; it cannot read what it carries. | shared: the ones the lobby names (`relays` in its welcome); until one runs beside the lobby, iroh's public relays |
| **the sim** | its own room, made with three.js (r125 to r186); a launcher step; its scene and two host hooks (`spawn`, `move`); its UI (or the library's default panel). | each sim |

The rule that holds it together: **a page only ever talks to its own visit-client**, and **only
visit-clients talk to each other**. A page reload breaks nothing but the localhost hop.

## 2. Words

- **Office**: one sim's presence in the lobby, under a name. One visit-client is one office.
- **Host**: an office whose room is being visited. **Visitor**: an office walking around someone else's room.
- **Visit**: one visitor in one host's room. Directed: A visiting B is not B visiting A (both can happen at
  once, as two visits). A visitor is in at most one room at a time; a host has at most `max_visitors`
  visitors.
- **Link**: the QUIC connection between the visitor's and the host's visit-clients for one visit.
- **Channel**: a small number (1–65535) a visit-client gives each of its visits on its localhost
  connection, to label binary frames. Not shared between machines.
- **Pose**: where a visitor stands and looks in the host's room. Only the host's sim interprets it.
- **Scene**: a room's three.js scene (or the part of it the room shares), as its visitors draw it (section 8.1).
- **Hosting**: an office's page has given Visit its scene (`host`, 5.2). Only then is the office in the lobby
  to be visited, and only then can it knock: every office takes part with its room.
- **Input**: what the visitor is pressing and where it is looking (section 8.2).
- **Key**: an office's lasting identity: its link endpoint's public key, the same every run when the
  visit-client has a state file (4.1). Names are first come, first served, and change; a key cannot be taken,
  because a link makes whoever dials prove they hold it (7.1).
- **Guest**: a key on an office's guest list. **Door**: open (its guests come in without knocking: the
  visit-client answers their knocks yes itself, 6.4) or closed (everyone knocks).
- **World** (8.4): an office's own room with its friends' rooms round it, each on its **plot** (the rectangle
  of its floor that is its land), drawn by the office's own page. **Watch**: a visit that sees a plot from
  outside it, sending nothing, until the watcher **steps in** (`enter`) and is in the room as a visitor is,
  and **steps out** (`exit`). **Layout**: where an office has put each friend's plot in its world, by key: its
  own, agreed with nobody. **Seen**: where a friend's layout has put this office's plot, as that friend said.
- **Linking** (8.5): what the panel offers on an office that takes it: a knock that, let in, starts a watch its
  knocker sees in a corner, from outside, and goes into, puts in its world, or ends. That watch is "a link" to
  people (`link: true` in messages); every visit, linked or not, also has a link in the sense above, its QUIC
  connection.

## 3. Security

These are MUSTs for the visit-client. They exist because any web page a person opens can try to reach a
program listening on their machine.

1. **127.0.0.1 only.** The visit-client binds its HTTP/WebSocket listener to 127.0.0.1 and nothing else
   (not 0.0.0.0, not ::, not a LAN address). It refuses to start if asked to bind elsewhere.
2. **A token on the page connection.** The visit-client is started with a token (at least 32 hex
   characters, from a cryptographically secure source, new for every run). A page connection MUST send it
   in its first message (`hello`, section 5.1) within 5 s; the visit-client compares it in constant time
   and closes the connection with code **4401** if it is missing or wrong (after a quarter of a second:
   guessing is hopeless anyway, at 256 bits). There is no lockout: any website could trigger one.
3. **The token reaches only the sim's own page.** The launcher hands it to the sim's page by a route other
   sites cannot read: the sim's own server answering a same-origin request, a file served beside the page,
   or the page's URL fragment (INTEGRATING.md step 3). It is never written into a URL query, a log, or
   anything served to another origin. A server that hands it over SHOULD answer only requests naming this
   machine (`Host: localhost` or `127.0.0.1`): that turns away DNS-rebinding sites, and requests to this
   machine's LAN address.
4. **The page's origin, too (SHOULD).** Given `--origins` (the sim's own page origins), the visit-client
   refuses (HTTP 403) a page connection from any other. Browsers always send a WebSocket's origin and a page
   cannot change it, so a token that leaked anyway is no use to another site's page.
5. **Public, harmless endpoints only.** Without the token, the visit-client serves only `/visit.js` (the
   library, public code) and `/health` (a version string). Nothing else.
6. **Links are authenticated twice.** A visitor's visit-client dials the host's with the visit's
   **ticket** (a secret the lobby gives both sides, section 6.4), and the host's checks that the dialling
   endpoint's public key is the one the visitor published to the lobby (section 6.2). A link that fails
   either check is closed before anything else is read.
7. **A host controls its room.** Visitors only send input, and points: where they looked as they clicked
   (8.3), never what they claim to have clicked. The host's sim decides where a visitor can go (`move`), what
   it sees (its scene), and what, if anything, a point does. The host visit-client clamps every input field
   and every point to its range, drops inputs beyond 120 a second and points beyond 5, and control messages
   beyond 20 a second from either side of a link.
8. **A host's scene is data, never code** (section 8.1). The visitor's page runs only the three.js release
   its hash table names, checked as it is fetched; it reads what a host sends only as data, made safe first
   (no shaders, images only as data URLs of a sane size, bounded geometry); its visit-client unpacks each
   edit with a limit and checks it before the page sees it.

9. **Guests by key, proved by the link.** A host's visit-client lets a knocker in without asking its page
   only when its door is open and the key the lobby gives for the knocker is on its guest list; when the lobby
   then agrees the visit, the visitor's link endpoint MUST be that very key, or the visit ends at once
   (`kicked`), before any link is made. A lobby that lies about whose knock it is gets nobody in who is not a
   guest. Adding a guest by a key the lobby lists trusts the lobby once, for whose key is whose; a key taken
   from a visit (its `peer.key`, 5.3) the link has proved.
10. **The state file is a secret.** It holds the office's secret key: the visit-client writes it readable by
    its owner only. Whoever has it can be that office to its friends.
11. **A watch is a visit's exposure, decided the same way.** A watcher gets the host's whole scene, as a visitor
    does. A host's visit-client admits a watch only from a guest, through an open door (point 9), and never asks
    its page; anyone else's is declined. Shutting the door ends every watch of the plot; taking a guest off
    ends theirs. A watcher's input and points count only while it has stepped in, and stepping in counts toward
    `max_visitors`.
12. **A layout is told to nobody whole.** Each friend in it hears where its own plot sits, over a link between
    the two offices (which proves who it is), and nothing of anyone else's.

Visitors get the host's whole scene: a sim that shows issue titles or agent activity in its room shows them
to its visitors, wherever they stand and whether they look or not. Letting someone in is the host's
decision, one knock at a time, or once and for all for its guests (point 9).

## 4. The visit-client

### 4.1 Running it

```
visit-client --lobby wss://lobby.example/ --name "Magic Room" --sim my-sim/1.0 \
             --port 7401 --token-file /run/user/1000/visit.token [--max-visitors 3] [--idle-exit 0]
```

| flag | env | default | meaning |
|---|---|---|---|
| `--lobby` | `VISIT_LOBBY` | — (required) | the lobby's `wss://` (or, for a local test, `ws://127.0.0.1:…`) URL |
| `--name` | `VISIT_NAME` | — (required) | the office's name: 1–24 letters, digits, space, `_ . -`, starting and ending with a letter or digit |
| `--sim` | `VISIT_SIM` | `unknown/0` | `name/version` of the sim, shown to others |
| `--port` | `VISIT_PORT` | 7401 | the 127.0.0.1 port for the page |
| `--token` / `--token-file` | `VISIT_TOKEN` / `VISIT_TOKEN_FILE` | — (required) | the page token (section 3). `--token-file` keeps it off the process list and SHOULD be preferred |
| `--max-visitors` | `VISIT_MAX_VISITORS` | 3 | 0–8; 0 takes no visitors |
| `--idle-exit` | `VISIT_IDLE_EXIT` | 0 | exit after this many seconds with no page connected (0: never) |
| `--origins` | `VISIT_ORIGINS` | none | the page origins allowed to connect (`http://localhost:3000`, comma-separated); none: any page with the token (section 3, point 4) |
| `--relays` | `VISIT_RELAYS` | the lobby's | the relays for links: `none`, `default` (iroh's own), or URLs, comma-separated |
| `--state-file` | `VISIT_STATE_FILE` | none | a file where it keeps what outlasts a run: whether the office is away (`leave_lobby`, 5.2), so a restart stays away; its key (section 2), so it is the same office to its guests' hosts; its door and its guests; its world's layout (8.4); whose look its visitors have (8.6). Readable by its owner only (section 3, point 10). None: every start joins the lobby, with a new key and no guests. A launcher SHOULD give one |
| `--cache-dir` | `VISIT_CACHE_DIR` | beside the state file (`landscapes/`); none without one | where it keeps friends' landscapes (8.10), each by its office's key and hash, at most 256 MiB (the oldest go first), and the plots it keeps to draw while their offices are away; without a directory, for the run only |

A flag wins over its environment variable, and a variable set but blank counts as unset (its default), as a
`.env` file has it. [`../.env.example`](../.env.example) is the template of them all.

On start it prints **one JSON line** to stdout once it listens, then logs to stderr:

```json
{"ready": true, "port": 7401, "version": "0.7.0", "proto": "basedverse-visit-local/2"}
```

Exit codes: 0 asked to stop (SIGINT/SIGTERM, or idle-exit); 2 bad flags; 3 the port is taken; 4 the
lobby refused it for good (`proto_unsupported`, `name_invalid`).

### 4.2 Lifecycle

- **Hosting.** The office is in the lobby to be visited, and can knock, only while a page hosts its scene
  (`host`, 5.2): the visit-client publishes its link to the lobby then (6.1), and withdraws it when the page
  goes; visits under way carry on.
- **A page reload** closes the localhost connection only. The lobby session, the office's knocks and every
  visit and link carry on. While a host's page is gone its visitors are told `host_paused` (they go on
  drawing its scene as it was); when a page connects again it gets `ready` with every active visit, hosts
  again, and sends each visitor its whole scene.
- **One page at a time.** A new authenticated page connection takes over from the old one, which is
  closed with code **4409** (`replaced`). This is what a reload looks like from the visit-client.
- **The lobby connection** is given up when the lobby has been silent for a minute (it pings every 20 s:
  silence means a connection that died without a word, after a laptop's sleep, say). It reconnects by
  itself (1 s, 2 s, 4 s, … up to 30 s) and resumes its session
  (section 6.1): within 30 s the office comes back with the same id, knocks and visits, and visits whose
  links stayed up never notice. Later than that, the lobby has ended the session and its visits, and the
  visit-client starts a new one (a new office id) and ends those visits' links.
- **Away.** The page can take the office out of the lobby on purpose (`leave_lobby`) while the visit-client
  goes on running: its visits end (`"gone"`), its knocks go, it says `bye` (no resume window) and stays out,
  reconnecting to nothing, until the page sends `join_lobby`, which starts a new session (a new office
  id). With `--state-file` it stays away across restarts too: a visit-client started away joins nothing.
- **Stopping** the visit-client takes the office out of the lobby, which ends all its visits.
- **`--idle-exit`** is for sims whose launcher starts the visit-client again whenever the page loads. It
  counts from the last page disconnect.

### 4.3 HTTP on 127.0.0.1

| request | auth | answer |
|---|---|---|
| `GET /visit.js` | none | the library (JavaScript), the version built into this binary. `Access-Control-Allow-Origin: *` |
| `GET /health` | none | `{"ok": true, "version": "0.7.0"}` |
| `GET /ws` (WebSocket upgrade) | `hello.token` (5.1) | the page connection |
| anything else | — | 404 |

## 5. Page ↔ visit-client: `basedverse-visit-local/2`

One WebSocket, `ws://127.0.0.1:<port>/ws`, with Nagle's algorithm off at both ends (a visit-client sets
`TCP_NODELAY`, as browsers do: without it a small message waits for the last one's acknowledgement, some
20 ms). Text frames are JSON objects with a string `type`; binary frames carry a scene's deltas and (from
the host's page) its edits (5.4). The library implements all of this; a sim never sees it unless it writes its own
library (for a native sim, say).

### 5.1 Handshake

The page sends, within 5 s:

```json
{"type": "hello", "proto": "basedverse-visit-local/2", "token": "…", "sim": {"name": "my-sim", "version": "1.0"}}
```

The visit-client answers `ready` (or closes: 4401 bad token, 4400 bad `proto`):

```json
{"type": "ready", "version": "0.7.0", "office": {"id": "o1a2b3c4", "name": "Magic Room"},
 "online": true, "away": false, "status": "available", "max_visitors": 3,
 "key": "7f3a…", "door": "open", "guests": [{"key": "c41e…", "name": "Ada"}],
 "layout": [{"key": "c41e…", "x": 22, "z": 4, "turn": 0}], "seen": [],
 "visits": [{"id": "v…", "channel": 1, "role": "host", "peer": {"id": "o…", "name": "Ada", "sim": {…}, "key": "c41e…"}, "guest": true}]}
```

followed by a `lobby` snapshot and any pending `knock`s.

### 5.2 Page → visit-client

| type | fields | effect |
|---|---|---|
| `host` | `three` (the three.js revision, digits) | this page hosts the room's scene (`visit.host`): the office is now in the lobby to be visited, and may knock (4.2); sent again after each page load |
| `status` | `status`: `"available"` \| `"busy"` | set the office's status (busy: no new knocks, visits carry on) |
| `max_visitors` | `n` (0–8) | change how many visitors the office takes; lower than the current count ends no visit |
| `rename` | `name` | ask the lobby for another name; taken (`name_taken`) or invalid, the office keeps its own |
| `leave_lobby` | — | take the office out of the lobby, and keep it out (away, 4.2): nobody sees it or can knock; its visits end |
| `join_lobby` | — | back into the lobby after `leave_lobby`: a new session |
| `door` | `open` (bool) | open the door (guests come in without knocking) or close it (everyone knocks); kept in the state file |
| `guest_add` | `key`, `name`? (≤ 24) | a guest: an office's key, as the lobby lists it (6.3) or a visit's peer has it (5.3), and the name it is known by; again for a key already there renames it. At most 256 (`too_many_guests`); not this office's own key |
| `guest_remove` | `key` | no longer a guest; its watches of this plot end |
| `world` | `on` (bool) | on: this office watches every guest online whose lobby entry says `world` (8.4), by itself, and keeps doing so (a declined or refused watch is tried again after 20 s); off: its watches end. No page for a minute: off |
| `enter` | `channel` (a watch's), `pose` {`x`, `y`, `z`, `yaw`} (in the watched room's terms) | step into the room watched (8.4): out of any other room first (a visit there ends); refused by its host when full (`enter_refused`) |
| `exit` | `channel` | step out of it again: the watch goes on |
| `place` / `unplace` | `key`, `x`, `z` (within 100 km), `turn` (0–3) / `key` | put a friend's plot in this office's world: its middle there, turned so many quarter turns (8.4); kept in the state file. At most 256 |
| `seen` | `key`, `at` {`dx`, `dz` (m, within 100 km), `turn` (0–3), `size` ([w, d] m: this plot's)} \| null | where this office's world has that office's plot (8.4): its middle `dx`, `dz` metres from this plot's middle, turned `turn` quarter turns left; null, not in it. Told to that office over any link with it, and again over each new one (kept in memory, not in the state file). At most 256 |
| `plot_keep` | `key`, `name`, `plot` {`center`, `size`}, `unit` | a guest's plot in this office's world, to keep while its office is away (8.10): drawn from its last landscape. At most 64 |
| `plot_load` | `key` | that kept plot's landscape, please: sent as `landscape` on channel 0 (`not_found` if none is kept) |
| `plot_forget` | `key` | let that kept plot and its landscape go |
| `link_where` | `channel`, `where` (`"world"` \| `"corner"`) | where the page put a link (8.5): kept, and said again in `visit_started` to a page that reloads |
| `avatar_clear` | — | this office has no avatar (8.6) from now on (its own goes as a binary frame, 5.4) |
| `avatar_want` | `channel` | ask a visitor for its avatar (host side, 8.6): its visit-client sends it, now and whenever its page gives a new one |
| `avatars` | `default` (`"mine"` \| `"theirs"`) | whose look visitors have in this room by default: this room's models, or their own avatars; kept in the state file |
| `avatar_use` | `key`, `use` (`"mine"` \| `"theirs"` \| null: the default) | the same for one office, apart from the default; kept in the state file |
| `phone` | `on` (bool) | this room has a phone (8.8), or no longer: every link is told |
| `call` | `channel`, `act` (`"ring"` \| `"answer"` \| `"hangup"`) | a call on that visit (8.8): ring their phone (refused `no_phone` if their room has none), answer it, end it |
| `say` | `text` (1 to 200 characters), `to`? (none or `"here"`; `{"key"}`; `"lobby"`) | a line this office's user says (8.9). No `to`: to everyone who can see them (the room they are in, and those who see it from outside). `{"key"}`: into the room of an office linked with this one, either way (`no_link` if none). `"lobby"`: to everyone in the lobby (`not_supported` if the lobby does not carry chat). Control characters become spaces; trimmed; at most 5 every 10 s, whatever their `to` (`rate_limited`) |
| `speaker` | `channel`, `on` (bool) | a call on this office's phone's speaker (8.8), or back to the ear (`no_call` if none is on there) |
| `voice_where` | `me` [x, y, z] \| null, `phone` [x, y, z] \| null, `visitors` [[`channel`, x, y, z], …] (metres, this room's terms) | where everyone in this office's room is (8.7): its own user (null: not in it), its phone, each visitor in it. Who hears whom in the room goes by it. Sent when it changes, at most 10 a second |
| `knock` | `to` (office id), `message`? (≤ 280), `link`? (true: a link, 8.5) | ask to visit an office, or to link with it (refused `not_hosting` before `host`) |
| `answer` | `knock`, `accept` (bool), `message`? | let a knocker in, or not |
| `end` | `visit` | end a visit: yours as a visitor (leave), or a visitor's to you (kick) |
| `input` | `forward`, `strafe`, `run`, `yaw`, `pitch`, `t` (8.2) | the visitor's input, whole: whenever it changes (at most every 8 ms) and every 33 ms regardless, while visiting |
| `point` | `yaw`, `pitch` (8.3) | the visitor clicked at the middle of its view, looking there: at most one every 200 ms, while visiting |
| `keyframe` | `channel` | the visitor's page asks for a key delta (8.1): where everything that moves is |
| `scene_resync` | `channel` | the visitor's page asks for the host's whole scene again (an edit was lost, or did not apply) |
| `pose` | `channel`, `state` (≤ 2 KiB) | the host page's state for a visitor (where it stands), about 5 a second; kept by the visit-client and handed back in `ready` to a page that reloads |
| binary | section 5.4 | a scene delta or a scene edit (host) |

### 5.3 Visit-client → page

| type | fields | when |
|---|---|---|
| `ready` | 5.1 | after `hello` |
| `guests` | `door` (`"open"` \| `"closed"`), `guests`: [{`key`, `name`}] | after `door`, `guest_add` or `guest_remove` |
| `layout` | `layout`: [{`key`, `x`, `z`, `turn`}] | after a change |
| `seen` | `key`, `name`, `at` (as the page message `seen`'s, their plot's `size`) \| null | where a friend's world has this office's plot (8.4), as they said; null: not in it, or their last link gone. `ready` has every one known: `seen`: [{`key`, `name`, `at`}] |
| `landscape` | `channel`, `key`, `json` | an office's landscape (8.10), as JSON: the room's on that visit's `channel` (kept here, or asked for and sent once), or a kept plot's (channel 0). Also to a page that comes back, for each visit it is on. `ready` has the kept plots: `kept`: [{`key`, `name`, `plot`, `unit`}] |
| `landscapes` | `channel` | this visitor reads landscapes (8.10): its whole room goes without its landscape (also `landscapes` in `visit_started`). Host side |
| `plot_forgotten` | `key` | a kept plot let go: its host ended this office's visit on purpose (`kicked`: its door shut, a guest no longer), declined its watch, or this office took it off its guests |
| `avatars` | `default`, `by`: [{`key`, `use`}] | whose look visitors have here (also in `ready`), after `avatars` or `avatar_use` |
| `avatar` | `channel`, `avatar` {`unit`, `json`} | a visitor's avatar, which this page asked for (host side, 8.6): unpacked and checked as a scene edit is |
| `phone` | `channel`, `on` | the other office's room has a phone now (8.8), or no longer (also `phone` in `visit_started`) |
| `call` | `channel`, `act` | a call on that visit (8.8): they ring, answer, or hang up |
| `chat` | `channel`, `key`, `name`, `text`, and `id` (a visitor's, by its visit there) or `owner` (true: the room's owner); or `scope` | a line said (8.9): in this office's room by a visitor (that visit's channel, its `id`), or in a room its user is in or sees from outside (that visit's channel: its owner, or another visitor). `scope: "sim"`: said into a room from a linked office, by that office's user (`key`, `name`): into this office's room (`home: true`; `channel`, the link it came by), or into the one its user is in (its `channel`). `scope: "lobby"`: said in the lobby (`id`, the sayer's office id; `key`, its key or null); this office's own too, in the lobby's order. Never this office's own otherwise. `ready` and `online` say whether the lobby carries chat (`lobby_chat`) |
| `voice_near` | `channel`?, `near`: [{`key`, `name`, `distance` (m), `id`?, `phone`?}] | who is near this office's user (8.7), within `voice_range`: in its own room (no `channel`: as its visit-client has it), or in the room it is in (that visit's `channel`: as its owner's says). `id`: a visitor's, by its visit there; `phone`: a call on that room's speaker. When it changes; distances at most every second. `ready` has `voice_range` (45) |
| `enter` / `exit` | `channel`, `pose`? {`x`, `y`, `z`, `yaw`} (for `enter`) | a watcher stepped into this room, there (host side: spawn it, as a visitor), or out of it; no `pose`: a link going there, spawned where newcomers go |
| `enter_refused` | `channel`, `reason` (`"full"`, or `"moved"`: a visit to a room began, and this office stepped out) | stepping into a watched room was refused, or undone: outside it |
| `online` / `offline` | `office`, `knocking` / `away`? | the lobby session came up (after a drop: the same office if it resumed), with this office's own knocks still waiting ([{`id`, `to`, `link`?}]) / went down: `away: true` when the page took it out (`leave_lobby`), `false` when it is on its way back (`join_lobby`), absent when the lobby is out of reach |
| `lobby` | `offices`: [{`id`, `name`, `status`, `sim`, `max_visitors`, `visitors`, `visiting`, `ready`, `key`, `watchers`, `world`, `links`}] | every change (6.3) |
| `knock` | `id`, `from` {`id`, `name`, `sim`, `key`}, `message`, `expires_in`, `link`? | someone wants to visit you, or (`link`) to link with you (never a guest at your open door: let in without asking) |
| `knock_sent` / `knock_cancelled` / `answered` | as in section 6 | your knock's fate; a knock on you withdrawn |
| `visit_started` | `id`, `channel`, `role` (`"host"` \| `"visitor"`), `peer` {`id`, `name`, `sim`, `key`}, `guest`?, `watch`?, `inside`?, `link`?, `where`?, `shared_adds`?, `state`? | a visit began (its link is up). `peer.key` is the other office's key, as the link proved it; `guest: true`, a guest let in through the open door, without asking the page; `watch: true` (and `inside`), a watch (8.4); `link: true` too, a link (8.5), with `where: "world"` if the page put it in its world; `phone: true`, the other office's room has a phone (8.8); in `ready`, a host's visit carries the last `state` its page sent |
| `visit_ended` | `id`, `channel`, `reason` (6.5) | a visit ended |
| `host_paused` / `host_resumed` | `channel` | the host's page went away / came back (visitor side) |
| `input` | `channel`, `seq`, `forward`, `strafe`, `run`, `yaw`, `pitch`, `t` | a visitor's latest input (host side) |
| `point` | `channel`, `yaw`, `pitch` | a visitor pointed (8.3), clamped, at most 5 a second each (host side) |
| `link_stats` | `channel`, `path` (`"direct"` \| `"relay"`), `rtt_ms` | the visit's link, about once a second, both sides: a relayed path is slower and rate-limited |
| `keyframe` | `channel` | send a key delta on this visit soon (host side) |
| `scene_resync` | `channel` | send this visitor the whole scene again (host side): it asked, or the link dropped edits it had not sent |
| `shared_adds` | `channel` | this visitor's page reads an `add` that names what it already has by uuid only (8.3; Visit 0.7 on), as `visit_started`'s `shared_adds: true` says when it is known by then (host side) |
| `scene` | `channel`, `edit` | an edit of the host's scene, unpacked and checked (8.1) (visitor side) |
| `scene_lost` | `channel` | an edit of the host's scene was dropped (malformed, too big, too many): ask for the whole scene (visitor side) |
| `error` | `code`, `message`, `ref`? | a refusal (section 11) |
| binary | section 5.4 | a scene delta (visitor) |

### 5.4 Binary frames

Both directions, one scene delta (or, from the host's page, one scene edit) per WebSocket binary message:

| bytes | field |
|---|---|
| 0–1 | `channel`, u16 big-endian |
| 2 | flags: bit 0 = a key delta (everything that has moved, 8.1); bit 1 = a scene edit (host page to visit-client only, alone); bit 2 = this office's avatar (8.6: page to visit-client only, alone, its channel 0); bit 3 = a packet of voice (8.7: from the page, its own user's, its channel saying where it may go: 1 the room they are in, 2 their calls, 3 both; to it, another office's, on the visit's channel); bit 4 = someone else's voice passed on (8.7, 8.8: to the page only, on the visit's channel it came by: who spoke, then the packet); bit 5 = this room's landscape (8.10: page to visit-client only, alone, its channel 0; gzipped JSON, at most 16 MiB) |
| 3–10 | timestamp, u64 big-endian, microseconds: the host page's clock when it took the delta (unused for an edit) |
| 11… | the delta (8.1), or the edit, gzipped JSON |

A delta larger than 1 MiB, an edit larger than 16 MiB, or an avatar larger than 4 MiB, is dropped. A visit-client sends deltas on the
link as they come (7.4) and edits on the visit's scene stream, and passes the visitor's page each delta as
it is and each edit unpacked, as `scene` (5.3).

## 6. The lobby: `basedverse-lobby/3`

The same transport as version 1 ([../lobby/PROTOCOL.md](../lobby/PROTOCOL.md) section 2): one JSON object
per WebSocket text frame, `wss://`, pings every 20 s, a 64 KiB frame limit. The reference lobby speaks every
version on the same URL, by `hello.proto`, each a lobby of its own whose offices do not see the others':
version 1 (browser sims streaming to a group), version 2 (visit-clients 0.2 to 0.4, rooms by video) and
version 3 (visit-clients 0.5 on, rooms by their scenes). Version 3 is version 2 with one addition: a link can
be withdrawn. Clients talking it are visit-clients: browsers never connect to the lobby directly.

### 6.1 A session

1. Connect; send `hello` within 10 s.
2. The lobby answers `welcome` (with the relays to use), then a `lobby` snapshot.
3. The visit-client starts its iroh endpoint with those relays and, once its page hosts its scene (4.2),
   sends `link` with its endpoint id and address. Until it has, its office shows `ready: false` and cannot
   be visited or knock. It withdraws it (`link` with `endpoint` and `addr` null) when no page hosts.
4. From then on: `status`, `max_visitors`, `knock`, `answer`, `end`; and `link` again whenever its address
   changes (iroh reports this; a laptop changing network, say).

**Resuming.** `welcome` carries a `resume` secret. When the connection drops, the lobby keeps the session
for 30 s: the office stays listed (as it was), knocks on it wait, its visits stay agreed. A visit-client
that reconnects in that time sends `hello` with the `resume` secret and gets `welcome` with
`resumed: true`, the same office id, a new `resume` secret, the session's visits (`visits`, ids) and its own
knocks still waiting (`knocking`); then the `lobby` snapshot, the knocks on it still waiting, and `visit`
again for each of its visits (one agreed while it was away is news; a visit-client ignores the others). It
ends any visit it has that `visits` does not list (it ended meanwhile), and sends `link` again. After 30 s the session ends for good: the office leaves the lobby, its
knocks are answered and withdrawn `gone`, its visits end `gone`, and a `hello` with that `resume` secret
starts a new session (`resumed: false`).

### 6.2 Visit-client → lobby

| type | fields | effect |
|---|---|---|
| `hello` | `proto`: `"basedverse-lobby/3"`, `name`, `sim`?, `status`?, `max_visitors`? (default 3), `resume`?, `world`? (true: this office takes knocks to watch), `links`? (true: it takes links, 8.5), `chat`? (true: it takes lobby chat, 8.9) | join, or resume a dropped session (6.1) |
| `link` | `endpoint` (the iroh endpoint id: its public key, as a string), `addr` (an object, ≤ 2 KiB as JSON, passed through untouched: how to reach it); or both null | publish or update how to reach this office; both null: withdraw it (not ready, until published again) |
| `status` | `status` | as version 1 |
| `max_visitors` | `n` (0–8) | change it |
| `knock` | `to`, `message`?, `watch`? (true: to watch, 6.4), `link`? (true: a link, 6.4) | ask to visit, to watch, or to link |
| `answer` | `knock`, `accept`, `message`? | answer a knock on your door |
| `end` | `visit`, `reason`? (`"left"`, `"kicked"`, `"link_failed"`) | end a visit you are in, either side |
| `rename` | `name` | a new name, if it is free (`name_taken`, `name_invalid` otherwise; the office keeps its own) |
| `chat` | `text` | a line for everyone in the lobby (8.9): to every office in it whose `hello` said `chat`, this one too. Control characters become spaces; trimmed; at most 200 characters; at most 5 every 10 s (`rate_limited`); empty: `bad_message`. Nothing is kept |
| `bye` | — | leave the lobby now: the session ends at once, not held for resuming (a visit-client stopping) |

### 6.3 Lobby → visit-client

| type | fields | when |
|---|---|---|
| `welcome` | `proto`, `id`, `name`, `relays`: [url], `resume` (32 hex), `resumed` (bool), `visits`: [id], `knocking`: [{`id`, `to`}], `limits`, `chat` (true: this lobby carries chat; an older one says nothing) | after a good `hello` |
| `lobby` | `offices`: [{`id`, `name`, `status`, `sim`, `max_visitors`, `visitors` (count), `visiting` (the host's office id, or `null`), `ready`, `key` (the endpoint it last published, kept while its link is withdrawn; `null` before it has published one), `watchers` (count), `world` (it takes knocks to watch), `links` (it takes links)}], you included | on any change |
| `knock` | `id`, `from` {`id`, `name`, `sim`, `key`}, `message`, `expires_in`, `watch`?, `link`? | someone knocked (to watch, with `watch`; to link, with `link`) |
| `knock_sent` | `id`, `to`, `watch`?, `link`? | your knock reached the door (a knock to link with a door that does not take links is an ordinary knock: no `link`) |
| `knock_cancelled` | `id`, `reason`: `"timeout"` \| `"gone"` | a knock on you was withdrawn |
| `answered` | `knock`, `accept`, `reason`? (`"declined"`, `"timeout"`, `"gone"`, `"full"`, `"not_ready"`), `message`?, `watch`?, `link`? | your knock's answer |
| `visit` | `id`, `role`, `peer` {`id`, `name`, `sim`}, `ticket` (32 hex), `peer_link` {`endpoint`, `addr`}, `watch`?, `link`? | a visit (or a watch, or a link: a watch with `link`) was agreed: the visitor dials, the host waits for it (section 7) |
| `visit_ended` | `id`, `reason` (6.5) | a visit ended |
| `lobby_chat` | `from` {`id`, `name`, `key`}, `text` | a line said in the lobby (8.9), to an office whose `hello` said `chat` |
| `error` | `code`, `message`, `ref`? | a refusal (section 11) |

`relays` is the list of iroh relay URLs to use; empty means the visit-client's built-in defaults.

### 6.4 Knocks and visits

- **A knock is refused** (`error` to the knocker) when: the door is not online (`not_found`), is the
  knocker (`self_knock`), is `busy` (`not_available`), has `max_visitors` visitors already (`full`), has
  not published its link, or the knocker has not (`not_ready`); the knocker is already visiting that door
  (`already_visiting`); the knocker's earlier knock there is still waiting (`knock_pending`); or the
  knocker has knocked 6 times in the last minute (`rate_limited`).
- **A knock waits** 60 s, then times out on both sides, as in version 1.
- **Letting in.** On `answer` with `accept: true`, if the door is still under `max_visitors`: a knocker
  visiting another room leaves it first (`visit_ended`, reason `"moved"`); the lobby makes a visit id and
  a fresh ticket and sends `visit` to both, each with the **other's** link (`peer_link`); everyone gets a
  fresh `lobby`. If the door filled up meanwhile, the knocker hears `answered` with `reason: "full"`; if
  either side withdrew its link meanwhile, `reason: "not_ready"` (and the door an `error`, `not_ready`).
- A visit counts toward the host's `max_visitors` from the moment it is agreed until it ends.
- **A guest at an open door.** The host's visit-client answers a knock itself, `accept: true`, when its door
  is open, its page hosts its scene, and the knock's `from.key` is on its guest list; its page is not asked.
  When the lobby then sends `visit`, the visitor's `peer_link.endpoint` must be that key, or the host ends the
  visit (`kicked`) before any link is made (section 3, point 9). To the lobby this is an answer like any other.
- **Watches** (8.4): a knock with `watch: true`. Its `knock_sent`, `answered`, `visit` and errors say so
  (errors with `ref: "watch"`). Refused as a knock is, except: `busy` does not stop it; `full` is the door's
  `max_watchers` (8) watches; `too_many`, the knocker watches `max_watching` (8) plots already;
  `already_watching`; `not_supported`, the door's hello did not say `world`; and its rate is
  `watch_knocks_per_minute` (30: visit-clients make them by themselves). A watch agreed does not move the
  knocker out of the room it is in, and does not count toward `max_visitors` or `visiting`. The door's
  visit-client answers it itself: yes for a guest through its open door, no for anyone else.
- **Links** (8.5): a knock with `link: true`, to a door whose hello said `links`. Its `knock`, `knock_sent`,
  `answered` and `visit` say `link`; its errors are a knock's (`ref: "knock"`). Refused as a knock is (`busy`
  stops it, and 6 a minute), except: `full` is the door's `max_watchers`, `too_many` the knocker's
  `max_watching`, and `already_watching` when the knocker watches the door's plot already. The door answers it as
  any knock: its page, or its visit-client for a guest through its open door. Let in, it is a watch (`watch` and
  `link` on its `visit`), counted as one. To a door that does not take links (an older Visit), it is an ordinary
  knock, and nothing says `link`.

### 6.5 Why visits end

`"left"` (the visitor ended it), `"kicked"` (the host did), `"moved"` (the visitor went into another
room), `"gone"` (either office left the lobby: its visit-client stopped, or its connection stayed down
past the 30 s resume window), `"link_failed"` (the link could not be made, or was lost for longer than the
grace period, section 7.5).

### 6.6 Limits

`welcome.limits`: `name` 24, `message` 280, `knocks_per_minute` 6, `knock_ttl` 60, `max_visitors` 8 (the
highest an office may set), `link_addr` 2048 (bytes of `addr` as JSON), `connections_per_ip` 8,
`max_watchers` 8, `max_watching` 8, `watch_knocks_per_minute` 30, `chat` 200 (characters in a line of lobby chat),
`chats_per_10s` 5.

## 7. The link: visit-client ↔ visit-client

One QUIC connection per visit, made with iroh (hole punching, then the relay if no direct path works),
ALPN **`basedverse-visit/2`**. iroh connections are encrypted and authenticated by the endpoints' keys.

### 7.1 Dialling and the handshake

1. On `visit`, the **visitor's** visit-client dials `peer_link` with the ALPN. The **host's** waits for it.
2. The visitor opens the **control stream** (bidirectional) and sends `{"proto": "basedverse-visit/2",
   "visit": "<id>", "ticket": "<ticket>"}`.
3. The host checks that it has that visit, that the ticket matches, and that the connecting endpoint's id
   is the visitor's `peer_link.endpoint`. If not, it closes the connection (application error code 1,
   `"refused"`). If so it answers `{"ok": true}`.
4. Both tell their pages `visit_started`. If the dial or handshake fails for 20 s, either side sends the
   lobby `end` with `reason: "link_failed"`.

### 7.2 The control stream

Messages are JSON, each prefixed by its length (u32 big-endian). In order, reliable.

| from | message | meaning |
|---|---|---|
| visitor | `{"keyframe": true}` | send a key delta soon (passed to the host's page at most every 500 ms) |
| visitor | `{"scene_resync": true}` | send the whole scene again (passed to the host's page at most every 2 s; one asked for sooner waits, and goes) |
| visitor | `{"point": {"yaw", "pitch"}}` | a point (8.3): passed to the host's page with only those two, clamped, at most 5 a second |
| either | `{"phone": true}` / `{"phone": false}` | this side's room has a phone, or no longer (8.8): sent on every link, and on each new one while it has |
| either | `{"call": "ring" \| "answer" \| "hangup"}` | a call (8.8), passed to the page as `call` |
| visitor | `{"say": "<text>"}` | a line the visitor says in the host's room (8.9): only while in it; checked and rate-limited as the page's is; passed to the host's page as `chat` and on to everyone else who can see the room (its other visitors, and its watchers) |
| host | `{"said": {"key", "name", "text", "id"? \| "owner"?}}` | a line said in the host's room (8.9), by its owner or one of its visitors (by its visit's id): to everyone who can see the room (in it, or watching it); checked, passed to the page as `chat` |
| either | `{"sim_say": "<text>"}` | a line said into the other office's room (8.9), by this office's user, wherever they are; checked and rate-limited as a page's is; passed to that room's page as `chat` (`scope: "sim"`, `home: true`) and on to each visitor in it |
| host | `{"sim_said": {"key", "name", "text"}}` | a line said into the host's room from a linked office (8.9): to each visitor in it but its sayer; checked, passed to the page as `chat` (`scope: "sim"`) |
| host | `{"near": [{"key", "name", "distance", "id"?, "phone"?}]}` | who is near the visitor in the host's room (8.7), as the host's visit-client has it: checked, passed to the page as `voice_near` |
| host | `{"avatar_want": true}` | send this office's avatar (8.6): now, on a stream of its own (7.4), and again whenever its page gives a new one |
| visitor | `{"landscapes": true}` | its visit-client reads landscapes (8.10): sent each time the link is up, passed to the host's page as `landscapes` |
| host | `{"landscape": "<hash>"}` | this room's landscape is this one (8.10: blake3 of its gzipped JSON, hex): sent when the link is up and whenever it changes. The visitor's visit-client gives its page the one it keeps of that office by that hash, or asks for it |
| visitor | `{"landscape_want": "<hash>"}` | send that landscape: on a stream of its own (7.4), once a link for a hash |
| visitor | `{"shared_adds": true}` | its page reads an `add` that names what it already has by uuid only (8.3; Visit 0.7 on): sent each time the link is up, passed to the host's page once as `shared_adds` |
| host | `{"paused": true}` / `{"paused": false}` | the host's page went away / came back |
| watcher | `{"enter": {"x", "y", "z", "yaw"} \| null}` / `{"exit": true}` | stepping into the room watched, there (clamped, passed to the host's page as `enter`; null: a link going there, spawned where newcomers go), or out (8.4, 8.5); in, it counts toward `max_visitors` |
| host | `{"enter_refused": "full"}` | the room is full: the watcher stays outside |
| either | `{"seen": {"dx", "dz", "turn", "size"} \| null}` | where the sender's world has the receiver's plot (8.4), or not; sent when it changes and each time a link comes up. Passed to the page as `seen` with only those fields |
| either | `{"bye": "<reason>"}` | ending the visit (also sent to the lobby as `end`) |

### 7.3 Inputs

Visitor to host as **QUIC datagrams**, each a JSON object `{"seq", "forward", "strafe", "run", "yaw",
"pitch", "t"}` (section 8.2): the whole state, never a change, so the newest is all that matters. Datagrams
may be lost or reordered: the host keeps the one with the highest `seq` and drops older ones, and takes at
most 120 a second. The visitor sends whenever its keys or look change (at most every 8 ms) and every 33 ms
regardless, so a lost "key up" is corrected within one interval; the host treats a visitor whose last input
is older than 300 ms as standing still.

### 7.4 The scene's deltas and edits

Host to visitor on **unidirectional streams**, each starting with one byte that says what it carries:

- **0, deltas**: one stream per key delta (as Media over QUIC carries a group of pictures): it starts with a
  key delta and carries the deltas after it until the next key delta, which starts a new stream. Each delta
  is: length (u32 big-endian, of what follows), flags (u8, bit 0 key), timestamp (u64 big-endian,
  microseconds), the delta. **Newest wins; nothing queues.** The host's visit-client resets an older stream
  when a newer key delta starts one (its unsent deltas are stale), lets at most 64 KiB be sent and not yet
  acknowledged, and drops every delta of a stream that is more than 100 ms older than the newest waiting,
  asking its page for a key delta. The visitor's visit-client stops reading an older stream when a newer
  one starts: a stalled stream is abandoned rather than waited for. Deltas go to the page as they arrive.
- **1, edits**: one stream for the visit, reliable and in order (each edit builds on the last): each edit
  its length (u32 big-endian) then the gzipped JSON. Edits are **never dropped one by one**: the host's
  visit-client lets at most 32 MiB of them wait; past that, or if the stream fails, it drops what waits and
  tells its page `scene_resync`, which sends the whole scene again.

And visitor to host, once its host asked (`avatar_want`):

- **2, its avatar** (8.6): its length (u32 big-endian, at most 4 MiB) then the gzipped JSON, the stream then
  finished. The host's visit-client takes at most one every 2 s, unpacks it to at most 16 MiB of one JSON object
  nested at most 256 deep, and passes it to its page as `avatar`. A host on an older Visit never asks.

And host to visitor, once the visitor asked (`landscape_want`):

- **3, its landscape** (8.10): its length (u32 big-endian, at most 16 MiB) then the gzipped JSON, the stream then
  finished. The visitor's visit-client unpacks it to check it (as an edit), keeps it as it came if its blake3 hash
  is the one the host named (else drops it), and passes it to its page as `landscape`.

Datagrams (unreliable): the visitor's input (7.3), JSON, so starting with `{`; either side's own user's voice (8.7),
one byte 0xA0 then one Opus packet (at most 100 a second taken, each at most 1 000 bytes); and someone else's voice
passed on by a room's visit-client (8.7, 8.8), one byte 0xA1 then who spoke and the packet (at most 400 a second).

### 7.5 Blips

A link that drops (Wi-Fi switching, a laptop waking) is redialled by the visitor every 2 s, with the same
ticket, for a **grace period of 15 s**; the visit carries on if it comes back (the visitor then asks for a
key delta), and ends with `"link_failed"` if not. During the gap the visitor goes on drawing the scene as it
was. A link closed on purpose (application codes 0 bye, 1 refused, 3 visit over: section 11) is not
redialled: the lobby ends its visit, and a visitor refused at the handshake ends it at once (`link_failed`).

## 8. Scenes and input

### 8.1 Scenes

A host sends its **scene**, and the visitor's page draws the room itself: walking and looking are as quick as
in its own room, the host renders and encodes nothing for anyone, and what crosses the link is the scene as
data.

- **The whole scene** is the edit `{"type": "scene", …}`: `three` (the revision), `json` (three.js's own
  `toJSON()` of the scene, or of the part shared), `ids` ([uuid, number] for every object: deltas and edits
  name objects by number; 0 is the root), `targets` (lights' targets, which three.js's JSON leaves out before
  r160: [light, target], or [light, null, [x, y, z]] for a target outside the scene), `renderer` (the host
  renderer's settings, by its release's names: `shadowMap` {enabled, type}, `toneMapping`,
  `toneMappingExposure`, `sortObjects`, `outputEncoding` or `outputColorSpace`, `physicallyCorrectLights` or
  `useLegacyLights`, `clear` [colour, alpha], `colorManagement`), `fov`, `near`, `far` (the visitor's camera),
  `walk` ({speed}, how the host's `move` walks, or null), `yaw0` and `pose` (where the visitor starts), `plot`
  ({center: [x, z], size: [w, d]}, in the scene's units, or null) and `unit` (metres in one of them). It goes
  when the visitor starts, and when asked (`scene_resync`); it replaces whatever the visitor had. A visitor's
  page that has none 3 s after its visit starts (or after it last asked) asks for it.
- **Edits** (`{"type": "edit", …}`): at most one every 33 ms, only when something changed, each field
  optional, applied in this order: `res` ({geometries, materials, textures, images, shapes}, in `toJSON` form:
  new ones, or ones changed in place, whose content the visitor's copy takes), `remove` ([number]), `add`
  ([{parent, json (the new object's `toJSON()`, with what it is made of; when every visitor the edit goes to
  reads it (`shared_adds`, Visit 0.7 on), except the geometries and materials they already have: sent before,
  in the whole scene or an edit, and used by the scene ever since, which the JSON names only by uuid; a visitor
  that does not have one asks for the whole scene), ids, targets}]), `parent` ([[number, new parent's
  number]]), `assign` ([[number, material uuid (or uuids) or null, geometry uuid or null]]),
  `props` ([{uuid, …}]: materials' colours and values as they change: `color`, `emissive`, `specular`,
  `opacity`, `transparent`, `visible`, …), `scene` ({background (a colour, {texture: uuid}, or null), fog
  ({type, color, near, far, density} or null)}).
- **Deltas**, every 33 ms when anything moved, a key delta every second and when asked (`keyframe`), all
  big-endian: u8 version (1; 2 to a watcher that has not stepped in: the pose fields are not its, and are 0); f64 `t`, the visitor's latest input time the host has, and f32 `age`, the ms
  since that input reached the host; f32 x, y, z, yaw, pitch, where the host has the visitor; u32 n; then n
  objects: u32 number, u8 flags (bit 0 visible, bit 1 scaled), f32 position (3) and quaternion (4), and f32
  scale (3) when scaled (else 1). A key delta lists everything that has moved since the whole scene; the
  others, what moved since the last.
- **Moving things** are shown about 70 ms behind the host's clock (estimated as the least of arrival minus
  timestamp over the last 2 s), between the two updates around that time: smooth, and always one to move
  toward.
- **Where the visitor stands.** Its page walks it with `Visit.walk` at the host's `walk.speed`, as its keys
  say, at once (without the host's walls). Each delta's pose is compared with where the page had predicted it
  would be `age` ms after `t`; the difference is put right at once in where it stands, and eased out of what
  it sees over about 100 ms (more than 4 units off: there at once). A host that gives no `walk` is followed,
  eased the same way: walking then waits for the round trip; looking never does.
- **Its own body**, which the host draws for everyone else, the host marks `userData.visitor = <visit id>`;
  the visitor's page does not draw it in its own eyes.
- **userData stays the host's.** Of each object's `userData` (which three.js's `toJSON` would send whole), a
  visitor gets only what Visit reads: `visitor` (above) and `visitPoint` (8.3), each a string, number or
  boolean. Everything else a sim keeps there (who a figure is, its handles, references to other objects)
  never leaves the host's page.
- **Data, never code.** The visitor's page draws a scene with the host's very three.js revision (its first
  release, `0.<r>.0`, r125 to r186 in 0.7.0), fetched from `https://cdn.jsdelivr.net/npm/three@0.<r>.0/build/`
  (or a page's own `threeBase`), checked against the SHA-384 hash visit.js carries for it (Subresource
  Integrity) and run as a module of its own: nothing else ever runs. Before three.js reads what a host sent,
  visit.js makes it safe: materials only of the kinds three.js draws itself (a `ShaderMaterial` or
  `RawShaderMaterial` is a program: it becomes plain grey), images only as PNG, JPEG or WebP data URLs at most
  4096 px a side (read from their headers, before anything decodes them) or typed-array data of that size,
  shapes' segment counts at most 256 (detail 5), and across the scene about 4 million vertices and 100,000
  objects at most. A host can only host a revision its visit.js knows, so every visitor of the same version
  draws it.
- **Checked on the way.** The visitor's visit-client unpacks each edit with a limit (64 MiB: a "zip bomb"
  stops there), checks it is one JSON object nested at most 256 deep, and passes it to the page as `scene`; one
  that fails, or past 64 MiB a second, is dropped and the page told (`scene_lost`): it asks for the whole scene
  again.

### 8.2 Input

| field | type | meaning |
|---|---|---|
| `forward` | −1, 0 or 1 | W/↑ is 1, S/↓ is −1 |
| `strafe` | −1, 0 or 1 | D/→ is 1 (right), A/← is −1 |
| `run` | boolean | Shift held |
| `yaw` | radians | where the visitor is looking, left/right, relative to how it was facing when it arrived (positive: turned left) |
| `pitch` | radians, −1.4 to 1.4 | up (positive) or down |
| `t` | ms | the visitor page's clock when it sent this input (`performance.now()`); the host's deltas carry it back |

**Look belongs to the visitor; position belongs to the host.** The visitor's page turns its view as fast as
the mouse moves and sends where it is looking; the host applies it as is. Where the visitor stands is the
host's to decide (`move`), against its own walls and furniture; the visitor's page walks at once by the
host's `walk` and takes the host's answer (8.1). The host clamps every field to its range.

### 8.3 Points

A visitor clicking at the middle of its view **points**: while it looks around (the pointer locked to the
view), the view shows a crosshair there, and a click sends `point` with where the visitor looks (its `yaw` and
`pitch`, as in its input), at most one every 200 ms. Nothing else: not what it saw there, nor what it thinks it
clicked. The host's visit-client clamps both, drops points beyond 5 a second, and passes them to its page; the
library makes each a ray in the room's own terms, from where the **host** has the visitor (its pose: x, y, z,
its eyes) toward where it looked, and the page decides what that does, if anything. A visitor can point only
from where it stands, in a direction it can look: never through the host's eyes, never at what the host has
not put there.

**Interactions** (Visit 0.9) are what a point may do, by type, and only what the host takes. A host lists them
(`v.interactions`): each type its own entry, `cosmetic` or not, with a `label`, who may (`"everyone"`, or its
`"guests"`), how far (`reach`, in its units) and what it does (`run`). It marks what may be clicked with the
type, `userData.visitPoint = "<type>"` (on an object, or a group it is part of). On a point the library casts the
ray itself, from the visitor's eyes: the first thing it meets that is not a visitor's body (nor hidden), then the
type on it or on what it is part of; if the host takes that type, this visitor may, and it is within reach, its
`run` gets { visit id, visitor, type, object, point (where the ray met it), distance }. A type the host does not
name does nothing. The whole scene (and an edit, when they change) says which types are taken, with their
labels: the visitor's crosshair shows hot over something marked with one, its label beside it, and over nothing
else. (`userData.visitPoint = true`, an older host's mark, shows hot without a label; the host's page hears the
point, `point`, and decides by its own lights.)

**Cosmetic** means the interaction changes only how the room looks or sounds to the people in it: something
moves, lights up, plays, spins. Anything else (an agent's work, a tool, a file, an account, a message to anyone,
saved state beyond the room's looks) is not cosmetic, and **the library refuses to register it unless the host
says its user agreed to that one** (`agreed: true`). What a point may do is a guest's reach into the room: a host
takes points only through this list, whose default is no.

### 8.4 Worlds

An office's world is its own room with its friends' plots round it, drawn by its own page (`v.world`, section
9). Nobody shares a map: each office has its own layout, and walking between plots may look different to each.

- **Who is in it.** With the world on, a visit-client watches its guests' plots: those online whose lobby entry
  says `world`, whose own visit-clients let it (it is their guest, their door open). A watch is a visit with
  nothing from the watcher: the host sends it the scene and its deltas (version 2) and does not spawn it.
- **Plots.** A host says its plot (`plot`, `unit`: 8.1); one that does not is taken to be what its scene covers
  (at most 200 units a side). An office's own plot sits at home, in its own room's coordinates.
- **Layout**, for each plot watched: where the office placed it (`place`: its middle at `x`, `z`, turned `turn`
  quarter turns left); else it goes by itself in a ring round the office's own, in the first of eight places
  (from one its key picks) where it overlaps nothing, `gap` (4 units) apart. A plot is scaled by its `unit`
  against the office's own. Nobody agrees to it: it is the office's alone (Visit 0.7 to 0.9 also had edges, a
  side agreed by both; gone in 0.10, and an older office's edge messages go unanswered).
- **Drawing.** The office's room is drawn clipped to its plot; then the ground between plots; then each plot,
  its scene read with the office's own three.js release (not its own), clipped to its rectangle, into the same
  depth buffer, lit by its own lights only (each plot a scene of its own), with its fog. A plot lit before r155's
  way (lights times pi) drawn by a page lit after it has its lights' strength times pi and its bulbs not dimming
  with distance, and the other way over pi: approximately its look. The watcher's own body, which the host draws
  for others, the watcher's page does not draw: it draws itself.
- **Walking.** At home the page walks its user by its own walls. When where it has them is inside a plot's
  rectangle it steps in (`enter`, where, turned into that room's terms; the host's `spawn` hears it as `at`). In,
  the host has them: their input goes to it, its `yaw` the look in the host's terms (not relative to an
  arrival: the host's `yaw0` for a watch is 0); the page walks them at once by the host's `walk` and takes its
  answers (8.1). When the host has them off its plot (by more than 0.3 of the office's units), they step out
  (`exit`) and walk on at home from there. Refused, or no answer within 3 s: back where they were before.
- **Seen.** The page tells each friend in its world where their plot sits (`seen`: their middle from its own,
  in metres, their turn, and its own plot's size), when that changes, and that they are no longer in it when
  they leave it; nothing else of its world, nor who else is in it. Its visit-client keeps the latest for each,
  tells it over any link with them, and again over each new one. A friend's page has where it is in each world
  that has told it (`v.seen`), until their last link goes. A plot whose door shuts on the world leaves it.

### 8.5 Links

Linking (Visit 0.8) is how two offices meet: instead of walking straight into a room once let in, the knocker
sees it in a corner first, and chooses.

- **Asking.** `knock` with `link: true` (`v.link`), to an office whose lobby entry says `links`; the door's page
  is asked as for any knock (`knock` with `link`), and may make the knocker a guest as it says yes. A guest
  through the open door is let in without asking. To an office on an older Visit, a link is a knock: let in, the
  knocker walks into its room, as before.
- **A link** is a watch (8.4) that the door let in itself: the host sends it the scene and deltas (version 2) and
  does not spawn it; the host's page lists it in `watchers` with `link: true`, and may end it (`end`, as a kick).
  Unlike a guest's watch, it is not ended by the door shutting, by the guest list, or by the knocker's world going
  off: it lasts until either side ends it, or one leaves the lobby.
- **The corner.** The knocker's page draws a link's room in its stage's small corner, with the host's own
  three.js (as a visit is drawn), from outside: from where the host's `preview` says ({x, y, z, yaw, pitch}, in
  its terms), or from above its plot, going round once a minute. Its input goes nowhere.
- **Going there** (`stepIn`): `enter` with no pose, so the host spawns it where newcomers go; from then it is in the
  room as a visitor is (its input and points count, it counts toward `max_visitors`), facing the way the corner
  looked, until **back to its own room** (`stepOut`, `exit`): the corner again. Going there ends a visit the
  knocker is on (in one room at a time).
- **Into the world** (`toWorld`, with `v.world`): the link's room becomes a plot round the knocker's own, read
  again with its own three.js, walked onto as any (8.4), for as long as the link lasts.
- **One corner.** A newer link, or a visit, takes the corner; a link it moves waits (`where: "aside"`, its scene
  not kept), and takes the corner again when it is free.
- **Kept.** A link put in the world (`link_where`) is put back there when the page reloads.

### 8.6 Avatars

A room draws its visitors itself (8.1): by default as its own models. With avatars (Visit 0.9) it may draw a
visitor as the visitor's own body instead.

- **Your own** (`v.avatar(object, { unit })`): a three.js object, its origin at its feet, facing −z, in its
  scene's units (`unit` metres each), with clips named `idle` and `walk` in its `animations` if it has them. The
  page gives it to its visit-client as a binary frame (5.4: its JSON, `{ unit, json }`, `json` its `toJSON()`
  with only what Visit reads of `userData`, gzipped, at most 4 MiB), which keeps it in memory, for the hosts
  that ask.
- **Whose look** is the host's to choose, kept in its state file: its visitors' own avatars (`"theirs"`) or its
  models (`"mine"`), by default (`avatars`) and for any office apart (`avatar_use`, by key).
- **Asking.** A host's page asks a visitor for its avatar (`avatar_want`) when it would show it; the visitor's
  visit-client sends it (7.4: stream 2), now and whenever its page gives a new one. A page reads it with its own
  three.js, as data (`cleanScene`, at most 300 000 vertices and 2 000 objects), scales it to its units, marks it as
  the visitor's body (`userData.visitor`), and plays its `walk` while the visitor moves and its `idle` while it
  stands. `v.visitors[i].avatar` is it while the room shows that visitor's own look, null otherwise: the room
  draws it (in its scene, it goes to every visitor; the visitor's own eyes do not see it).

### 8.7 Voice

Voice goes by where people are, in the same room: nothing to join. Those in one room hear each other the nearer
the louder, from where each stands, and nobody farther than 45 m away (`voice_range`). Nobody hears into another
room: not next door in a world, not across a plot's side.

- **The microphone** is each user's to turn on (`v.setMic`, the panel's 🎙), remembered in their browser (on again
  at the next load, once permission is given); off, they still hear. It is asked for with echo cancellation, noise
  suppression and gain control. Nothing is encoded or sent while nobody is near.
- **Where people are.** Each room's page tells its own visit-client where everyone in it stands (`voice_where`): its
  own user while they are at home (where its world, or `v.listener`, has them), its phone, and each visitor (where
  the room has them: it moves them, so it is the room's word, not the visitor's). It also keeps an empty object
  named `visit:me` in its scene where its own user stands at home (hidden while they are away), and marks each
  visitor's body (`userData.visitor`), so that a visitor's page knows where each voice comes from.
- **Who hears whom is decided by the room's visit-client**, the same for every room, not by its page. A page sends
  its user's voice once, to its own visit-client (where it may go: the room, calls). Their visit-client sends it to
  the room they are in: another's (that room's owner's visit-client decides) or their own. There, the room's
  visit-client sends a voice on to whoever is within 45 m of the speaker, plus a 15 m margin (so it fades in rather
  than starts): its own page, if its user is; and each visitor, the owner's as it is, another visitor's passed on
  (`relay`: who spoke, by their visit's id there, and their name). It tells each in the room who is near them
  (`voice_near`, `near`), so a page with nobody near encodes nothing.
- **Hearing.** A page plays each voice from where the speaker is (Web Audio's HRTF panner, linear to nothing at 45
  m): at home, its visitors where it has them; in another's room, its owner from `visit:me` and the voices passed on
  from their bodies. Visit marks each one heard speaking with a 🔊 over them (Visit 0.13), in the views it draws: a
  world (`speaking: false`, for a page drawing its own from `v.voices`) and another's room.
- **The voice**: 48 kHz mono, 20 ms a packet, Opus at about 24 kbps (WebCodecs), as a binary frame (5.4, bit 3) to
  the visit-client, sent on as a QUIC datagram (7.4: unreliable, so late is lost); the page decodes each speaker's
  in order and plays it a little behind now (60 ms, to ride out the network's unevenness; past 400 ms behind, it
  catches up).
- **Older offices** (Visit 0.9) decided in their pages, by 15 m: a 0.9 room's visitor on 0.10 sends to it and hears
  what it sends, and a 0.9 visitor in a 0.10 room is heard and hears as the 0.10 room decides.

### 8.8 Phones

A phone joins two rooms' users wherever they stand: voice to voice, not by distance. A room may have one; Visit
carries calls, and the room shows the phone (where it stands, its ringing, picking it up).

- **A phone** (`v.phone(true, { at })`): the room says so on every link (control `phone`), and keeps an empty object
  named `visit:phone` in its scene where it stands. A user calls only those linked to them (any visit either way)
  whose rooms have phones (`v.phones`). Visit puts a phone there in the room's scene (Visit 0.13: `visit:phone-model`,
  a stand, its handset at `at`, a lamp), so everyone sees it: shaking with RING RING over it while it rings, its
  handset off its cradle while its user has it to their ear, its lamp lit on speaker. `model: false`: the room draws
  its own. The panel calls (📞 call, a button for each of `v.phones`), picks up, and hangs up.
- **A call**: `ring` (`v.call`), `answer` (`v.pickUp`), `hangup` (`v.hangUp`), as control messages on the visit
  between them; unanswered, it stops ringing after 30 s. While on, each sends its voice on that visit (the
  microphone runs for the call, on or off otherwise).
- **The handset** (as a call starts): only the user, to their ear, sounding as a telephone does.
- **Speaker** (`v.speaker(key, true)`, each side its own; the page tells its visit-client, `speaker`): the call's
  voice comes from the phone, heard by everyone within 45 m of it in that room by distance (the room's visit-client
  passes it on to its visitors near the phone, as the phone's, `relay` id `phone`), and everyone that near the
  phone is heard on the call (the room's visit-client passes its visitors' voices there); the user, only while
  near it. The other side hears them all, each apart.

### 8.9 Chat

As in a game's chat, a line goes one of three ways (its scope). Nothing to join.

- **Say** (the default): everyone who can see its speaker: the room they are in, and those who see that room from
  outside it (their worlds, their corners). It shows over the speaker's head, and in everyone's chat. A page says
  its user's line to its own visit-client (`say`, `v.say(text)`); it goes to the room the user is in: another's (to
  its owner's visit-client) or their own. The room's visit-client gives it to everyone who can see the room: its
  own page (`chat`), and each visitor in it or watching it (`said`), but the one who said it. A visitor's line
  names them by their visit's id there; the owner's says so (`owner`).
- **Into a linked room** (`v.say(text, { key })`): everyone in the room of an office linked with the speaker's,
  either way (in a corner, in a world, visiting, visited: `v.chatTargets`), wherever the speaker is. It shows in
  their chat, not over a head (the speaker is not there). It goes over the link (`sim_say`) to that room's
  visit-client, which gives it to its page (`chat`, `scope: "sim"`, `home`) and to each visitor in it
  (`sim_said`; an older Visit ignores it).
- **Lobby** (`v.say(text, "lobby")`): everyone in the lobby whose Visit takes it, in their chat. The lobby relays
  it (`chat`, `lobby_chat`) to each office whose `hello` said `chat`, the sayer's too, in one order, and keeps
  nothing. A lobby that carries it says so in `welcome` (`chat: true`; the page: `v.lobbyChat`).
- **Checked everywhere.** Every visit-client (and the lobby) checks a line again: plain text (control characters
  become spaces), at most 200 characters, at most 5 lines every 10 s from each, whatever their scope.
- **Showing.** A line said shows over its speaker a few seconds (4 s, and longer the longer it is: at most 12 s),
  until they say another. Visit draws it in the views it draws (`Visit.bubble`, a card over the head): another's
  room, from in it or outside it (over its owner's `visit:me`, over visitors' marked bodies; never one's own, from
  one's own eyes) and a world (`v.world`: at home over its user and its visitors; on each plot, over its owner and
  its visitors; and over its user). A room without a world draws them itself, from `v.chats` and the `chat` event.
- **The chat window** (`Visit.chat`; the panel's): bottom left, as in a game. Enter (or `/`) to type a line, Enter
  to say it, Esc to stop; where it goes is before the box (Say, To <name>'s room, Lobby), picked there or with
  `/s`, `/w <name>`, `/1` (`/l`), `/r` (back to whoever last said a line into a room of yours) and a space, and
  it stays for the next line. Every line of every scope shows in it, coloured by scope (say white, a room's pink,
  the lobby's gold). It fades 20 s after the last line, and comes back with the next one, or Enter.
- **Text is text.** A page shows a line as text (a canvas, `textContent`), never as markup.

### 8.10 Landscapes

The part of a room that never changes (its ground, walls, trees, furniture) is its **landscape**: sent once, kept
by those who visit, and drawn while its office is away. A room marks it: `userData.visitStatic = true` on an
object makes it and everything under it landscape (the marker itself stays on the host's page).

- **Apart.** The host's page leaves the landscape out of its scene's rounds (no deltas, no edits: nothing of it is
  looked at 30 times a second) and out of the whole scene it sends (which says, `landscape.parents`, under which
  object, by number, each landscape object goes; an edit says so again when they change). It makes the landscape
  one JSON of its own: three.js's JSON of a group of the static objects in the scene's order, every uuid named
  anew in order of first appearance (`L1`, `L2`, …), so that the same landscape is the same JSON at every load, and
  gives it to its visit-client (5.4, bit 5) a second after what is static last changed. Something static that
  changes in itself, the room says so (`v.landscapeChanged()`).
- **Sent once.** The visit-client names it by its hash (blake3 of the gzipped JSON) to every visitor (`landscape`),
  and sends it (stream 3) to one that asks (`landscape_want`): one that does not have it. A visitor's visit-client
  keeps each office's latest on disk (`--cache-dir`), by that office's key and the hash, and gives it to its page
  (`landscape`), which puts each object under its parent in the room. A visitor on an older Visit gets the room
  whole, its landscape in it, and again whenever what is static changes.
- **Kept while away.** A guest's plot in a world (8.4) is kept with where it was (`plot_keep`): while its office is
  away (offline, its link lost) the world draws its last landscape there, named "offline", lit softly if it has
  no lights of its own, and its user walks into it as at home, against its walls (they are walked into, not
  through) since no host is there to walk them. It goes live again when its office comes back. It is let go when
  its office says so: it ends the watch itself (`kicked`: its door shut, a guest no longer), declines one, or this
  office takes it off its guests.

## 9. The library: `visit.js`

The normative surface; INTEGRATING.md shows it in use. Loaded with
`<script src="http://127.0.0.1:<port>/visit.js"></script>`, which defines `window.Visit`.

```js
// token: the token, or a function giving it (sync or async), asked again on each reconnect: a visit-client
// restarted with a new token is then found again by itself. A wrong token is final for a string.
// threeBase: where to fetch three.js from instead of the CDN ("{r}" the revision; the same files, checked
// against the same hashes).
const v = await Visit.connect({ port, token, sim: { name, version }, threeBase });

// state, always current; "change" fires whenever any of it changes (never for the per-frame traffic)
v.state        // "connecting" | "online" | "offline" (the lobby out of reach) | "away" (out of it on purpose)
v.stats        // while visiting, about once a second: { latency (input to screen, drawn here, ms), rtt (the link's,
               //   ms), path ("direct" | "relay"), fps (frames drawn a second) }
v.viewFocused  // in a room you visit (or went to by a link), and the view takes the keys and mouse (not in a corner):
               //   the page's own keys wait
v.office       // { id, name } while online
v.key          // this office's key: its lasting identity (the same every run, with a state file)
v.door         // "open" (your guests link and come in without asking) | "closed" (everyone asks)
v.guests       // [{ key, name }]: who walks in through the open door
v.status       // "available" | "busy"
v.maxVisitors  // number
v.offices      // [{ id, name, status, sim, maxVisitors, visitors, visiting, ready, key, links }], you included
v.layout       // [{ key, x, z, turn }]: where you have put friends' plots (8.4)
v.seen         // [{ key, name, at: { dx, dz, turn, size } }]: where friends' worlds have your room (8.4): metres from
               //   their plot's middle (north -z), quarter turns left, and their plot's size
v.watchers     // [{ id, visitor, inside, link }]: who sees your room from outside it (your guests' worlds; links, 8.5)
v.knocks       // knocks on your door: [{ id, from: { id, name, sim, key }, message, until (ms epoch), link }]
v.knocking     // your knocks still waiting: [{ id, to, link }]
v.visiting     // the room in your stage: { id, host: { id, name, sim }, paused, link, inside } or null (a link's: in
               //   the corner until you go there, inside: true)
v.visitors     // your visitors as a host: [{ id, visitor: { id, name, sim, key }, guest, pose, link, avatar }]: avatar,
               //   its own body (8.6) while your room shows its own look, else null
v.links        // your links (8.5): [{ id, host, where ("corner" | "aside" | "world"), inside }]
v.avatars      // whose look your visitors have in your room (8.6): { default: "mine" | "theirs", by: [{ key, use }] }

v.on(event, fn); v.off(event, fn)   // "change" | "knock" | "answered" | "visit_started" | "visit_ended" | "stats" | "error" | "point"
                   //   (knock, answered and visit_started say link: true for a link's)
v.close()          // disconnect for good
v.setStatus(status); v.setMaxVisitors(n); v.rename(name)
v.knock(officeId, message); v.answer(knockId, accept, message)
v.link(officeId, message)   // ask to link (8.5): let in, their room in your stage's corner (to an older office: a knock)
v.stepIn(id); v.stepOut(id) // a link (by visit id; the corner's by default): go into its room, and back to your own
v.toWorld(id)      // a link's room as a plot in your world (v.world first), while the link lasts
v.unlink(id)       // end a link
v.watching(officeId)        // whether a plot of theirs is in your world (a guest's, or a link put there)
v.avatar(object, { unit })  // your own body, for rooms that show their visitors' own looks (8.6); null: none
v.setMic(on); v.mic         // your microphone (8.7): on, those near your user in the same room hear them (remembered)
v.voices; v.voiceRange      // who your user can hear, near them (as the room's visit-client says): [{ key, name, distance (m), speaking }]; metres (45)
v.listener({ x, y, z, yaw })   // where your user is in your room, for a room that draws no world (a world says it)
v.landscapeChanged()        // something marked userData.visitStatic (8.10) changed in itself: its landscape goes again
v.perf(on); v.perfReport()  // telemetry (the panel's ⏱; remembered in this browser; ?visit-perf=1): a corner of the page,
                            //   each second, this page's frames and stalls (long tasks) and Visit's own work by part (ms);
                            //   perfReport(): the last two minutes, a row a second. Nothing leaves the page
v.say(text, to)             // a line (8.9): true if said. No to: everyone who can see your user (over their head);
                            //   { key } (or a key): into that linked office's room; "lobby": everyone in the lobby
v.chatTargets; v.lobbyChat  // whom say(text, { key }) can reach: [{ key, name }]; the lobby carries chat
v.chats                     // the lines over heads still showing where you are and in your room: [{ key, name, text, mine,
                            //   owner, id, channel }]
v.chatLog                   // the last 100 lines of every scope: [{ at, scope ("say", "sim", "lobby"), key, name, text,
                            //   mine, owner, id, channel, to ({ key, name }: the room a "sim" line went into) }]; and the
                            //   "chat" event, each as it comes
v.phone(on, { at, model })  // a phone in your room (8.8), at that spot (your units): Visit's own there (model: false, yours)
v.phones; v.calls           // those linked to you whose rooms have phones: [{ key, name }]; your calls: [{ key, name,
                            //   state ("calling" | "ringing" | "on"), speaker, speaking }]
v.call(key); v.pickUp(key); v.hangUp(key); v.speaker(key, on)   // and the "call" event: { key, name, state, speaker, why }
v.useAvatars(use); v.useAvatar(key, use); v.avatarUse(key)   // "theirs" | "mine": whose look visitors have in
                   //   your room, by default and for one office (null: back to the default)
v.leave()          // end your visit (the stage's link: unlink it)
v.kick(visitId)    // end someone's visit to you
v.leaveLobby()     // away: out of the lobby, nobody sees you or can knock, your visits end (kept across restarts
v.joinLobby()      //   with VISIT_STATE_FILE); and back
v.setDoor(open)    // open or close your door (kept, with VISIT_STATE_FILE); shut, nobody watches your plot
v.addGuest(key, name); v.removeGuest(key); v.isGuest(key)   // a key from v.offices, or (proved by the link) a visit's
                   //   peer.key; "visit_started" says guest: true for one let in through the open door

// hosting: register once after connect (and again after each page load). Until then this office is not in the
// lobby to be visited, and cannot knock: every room takes part with its scene.
v.host({
  spawn(visitor, { at }) { return pose; },    // where a new visitor appears (at: where a world's watcher stepped in, if one did)
  move(pose, input, dt, { id, visitor }) { return pose; },   // where it may go: the library has already set pose.yaw and
                                              //   pose.pitch; id is the visit's, visitor { id, name, sim }
  scene: { root, three, renderer, near, far },      // the room's three.js scene (or the part to share), the THREE it was made with
                                                    //   (r125 to r186), its renderer, and visitors' camera range (8.1)
  fov: 70,                                          // visitors' camera's vertical field of view, in degrees
  walk: { speed },                                  // optional: move() walks with Visit.walk at this speed: visitors walk at once
  plot: { center: [x, z], size: [w, d] }, unit: 1,  // this room's land in a world (8.4), in its units (without it: what its scene
                                                    //   covers); unit: metres in one
  preview: { x, y, z, yaw, pitch },                 // optional: where a link sees this room from, before going in (8.5); without
                                                    //   it, from above its plot, going round
});

// a world (8.4): after host(). Every frame, where your page has its user (in its room's terms) and what they press;
// what comes back is where they are now: at home as given, or in a plot as its host has them (in: { key, name }), its
// y the one given plus however far that host has since moved them up or down (a stair, a lift: its move() sets pose.y).
// Then world.render(camera), in place of renderer.render(scene, camera).
const world = v.world({ scene, renderer, ground, gap, clipOwn, bubbles, speaking });   // your whole scene and its renderer (host()'s by default);
                   //   bubbles (true): it draws the lines said (8.9) in the room your user is in over their speakers' heads;
                   //   speaking (true): a 🔊 over each one your user hears speaking there (8.7)
const me = world.frame(dt, { x, y, z, yaw, pitch }, { forward, strafe, run });
world.render(camera);
world.plots        // [{ key, name, at: { x, z, turn }, rect: [x0, z0, x1, z1], inside, offline }] (offline: a guest's plot
                   //   kept while its office is away, 8.10)
world.inside; world.point(); world.leave(); world.release()
v.place(key, { x, z, turn }); v.unplace(key)   // yours alone: each friend in it is told where it is, nothing more
v.on("seen", ({ key, name, at }) => …)          // a friend's world has your room somewhere new (at), or not (null)

// hosting: what visitors may click (8.3), by type: things marked userData.visitPoint = "<type>". A type not
// named does nothing. One not cosmetic throws unless agreed: true (your user agreed to it, by name).
v.interactions({ spin: { cosmetic: true, label: "spin it", who: "everyone", reach: 4,
                         run({ id, visitor, type, object, point, distance }) { /* ... */ } } });
// every point, raw: { id (its visit), visitor: { id, name, sim }, from: [x, y, z] (its eyes, where this page has
// it), dir: [x, y, z] (a unit vector, where it looked), yaw, pitch (in the room's terms) }; and each
// interaction run: "interaction" { id, visitor, type, cosmetic, object }
v.on("point", ({ id, visitor, from, dir }) => { /* ... */ });

// visiting: where to show the room you are in; the library draws its scene there and captures input; while the
// mouse looks about (the pointer locked), a crosshair at the middle, and a click there points (8.3)
const view = v.view(element);   // { release(), setActive(on), active, canvas }: inactive, it takes no keys or mouse

// helpers
Visit.walk(pose, input, dt, { speed, blocked })   // first-person walking with wall sliding, for move()
Visit.bubble(THREE, text, unit)                  // a line's bubble (8.9), a sprite whose bottom sits where you put it (unit: metres
                                                 //   a unit), for a room that draws its own
Visit.panel(element, v)                          // an optional ready-made lobby panel: Link (Knock, to an older office) with a
                                                 //   message; links asked of you (Link, Not now, ★ always: a guest from now on);
                                                 //   your links (Go there, Back to my room, Put in my world, Unlink); your visitors
                                                 //   and who is linked to you (Kick, Unlink, their look / your model); visitors
                                                 //   look like (default); your world (Map); voice (🎙, who is near); calls (Pick up,
                                                 //   speaker / handset, Hang up), 📞 call (those linked with phones); the chat window (8.9);
                                                 //   notes a while (where a friend's world put your room, 8.4, once it
                                                 //   settles; a call that ended other than hung up); ⏱ telemetry on or
                                                 //   off; stars, door, status, Go offline / online:
                                                 //   { element, chat, release(), say() (the chat window open to type) }
Visit.panel(element, v, { chat: false })         // the panel without the chat window (yours instead)
Visit.chat(v, { element, fade })                 // the chat window (8.9) on its own, bottom left (--visit-chat-left,
                                                 //   --visit-chat-bottom move it): Enter or / to type; /s, /w name, /1, /r;
                                                 //   fades `fade` ms (20000) after the last line: { element, open(), close(),
                                                 //   release() }
Visit.map(v)                                     // an optional ready-made map of your world from above (the panel's Map): drag,
                                                 //   turn or type where friends' rooms sit; pick one: their view of you two;
                                                 //   { element, open(), close(), shown, release() }
Visit.stage(v)                                   // an optional ready-made visit view: the room visited full-window (with the
                                                 //   link's numbers, Back to my room, Leave), or in a corner; a link starts in the
                                                 //   corner, whose click offers Go there, Put in my world (with v.world), Unlink;
                                                 //   { element, big, shrink(), grow(), release() }
```

**Poses** are the host's own: the library only stores them and passes them back. `Visit.walk` uses
`{ x, y, z, yaw, pitch }` with y up, yaw 0 looking toward −z and positive turning left, pitch positive
looking up (three.js's camera, Euler order `"YXZ"`). It moves at `speed` units a second (twice that while
`run`), and where `blocked(x, z)` shuts the way it tries the x move alone, then the z move alone, so a
visitor slides along walls.

**Calling the hooks.** `spawn` once per visitor. `move` 60 times a second per visitor, and the moment its
input arrives, with the latest input and `dt` in seconds. A hook that throws is logged and skipped for that
tick; three throws in a row end that visit (`"kicked"`).

**Scenes.** Every 33 ms, while it has visitors, the library reads the scene (objects' matrices and
visibility, materials' state, geometries' and textures' versions) and sends what changed (8.1). A room marks
each visitor's body with `userData.visitor = <visit id>`, and what a visitor may point at with
`userData.visitPoint = true`; of `userData`, only those go (8.1). Anything else under `root` is shared, so
what should not be belongs outside it.

**Timing.** The library ticks from a Worker's timer: a page's own timers slow to once a second or less
while its tab is in the background, and a host must go on moving its visitors and sending its scene. A page whose
Content-Security-Policy forbids `blob:` workers falls back to its own timers, and its visitors then see it
slowly while its tab is hidden.

## 10. Limits and defaults

| what | value |
|---|---|
| page port | 7401 (flag) |
| page token | ≥ 32 hex characters, new each run |
| page hello timeout | 5 s |
| max visitors | 3 by default, 0–8 |
| three.js | r125 to r186 (the releases visit.js carries hashes for) |
| scene updates | edits at most every 33 ms; deltas every 33 ms when anything moved; a key delta every second and on request |
| scene edits | gzipped ≤ 16 MiB, unpacked ≤ 64 MiB, nested ≤ 256; ≤ 64 MiB a second to a visitor; ≤ 32 MiB waiting on a link |
| scene contents | materials three.js draws itself; images ≤ 4096 px a side; segments ≤ 256; ≈ 4 million vertices, 100,000 objects |
| largest delta | 1 MiB |
| deltas behind | a delta more than 100 ms older than the newest waiting is dropped, to the next key delta |
| moving things shown | 70 ms behind the host's clock |
| input rate | on every change, at most every 8 ms, and every 33 ms regardless; at most 120 a second accepted |
| points | one every 200 ms from a visitor's page; at most 5 a second accepted |
| link send window | 64 KiB sent and not yet acknowledged |
| control messages on a link | at most 20 a second from either side; more are dropped |
| key delta requests | passed to the host's page at most every 500 ms |
| scene resync requests | passed to the host's page at most every 2 s (one sooner waits) |
| lobby silence | a minute: then the connection is made again |
| input staleness | 300 ms |
| link dial timeout | 20 s |
| link grace period | 15 s |
| lobby session kept after a drop (resume) | 30 s |
| knock wait | 60 s |
| watches | 8 watchers of a plot, 8 plots watched; 30 knocks to watch a minute; one declined tried again after 20 s |
| world | a plot not said: what its scene covers, at most 200 units a side; 4 units between plots in a ring; out of a plot 0.3 units past it; stepping in answered within 3 s |
| layout, seen | 256 each |
| chat | a line at most 200 characters; 5 lines every 10 s, from a page and from each visitor, whatever the scope (the lobby counts them too); shown over a head 4 to 12 s, by its length; the chat window keeps 100 lines, and fades 20 s after the last |
| landscapes | at most 16 MiB gzipped each; kept on disk at most 256 MiB in all (one per office, the oldest go first); 64 plots kept while their offices are away; sent a second after what is static last changed; a visitor's whole room waits at most 400 ms to hear whether it reads them |

## 11. Errors

**Page connection refusals:** HTTP 403 before the WebSocket opens (an origin not in `--origins`); close
codes 4400 bad `hello`, 4401 bad or missing token, 4409 replaced by a newer page.

**`error` codes the page can get** (from the visit-client, or passed through from the lobby): those of
section 6.4 (`not_found`, `self_knock`, `not_available`, `full`, `not_ready`, `already_visiting`,
`knock_pending`, `rate_limited`), `message_too_long`, `name_invalid`, `name_taken` (on `rename`; the
office keeps its name), `too_many_guests` (256 at most), `no_phone` (ringing a room with no phone), `no_call`
(`speaker` with no call on), `not_supported`, `too_many`, `already_watching` (knocks to watch, which a page never sees), `not_yours` (answering a knock that is not yours), `not_hosting` (knocking before
the page hosts its scene, 4.2), `no_such_visit` (`end`, `keyframe` or `scene_resync` for a visit you are not
in), `offline` (an action while the lobby is down), `away` (an action
while the office is out of the lobby on purpose: `join_lobby` first), `bad_message`.

**Link application error codes:** 0 normal close (`bye`), 1 refused (bad ticket or endpoint), 2 protocol
mismatch, 3 visit over.

## 12. Versions

Three names, each changed only by something an older peer could not handle (additions keep the name;
[../CHANGELOG.md](../CHANGELOG.md) lists every release's additions, and what an integration does about them):
`basedverse-visit-local/2` (page ↔ visit-client), `basedverse-lobby/3` (visit-client ↔ lobby),
`basedverse-visit/2` (the link's ALPN). Visit 0.5 changed all three (rooms by their scenes, not video): a 0.5
office and an older one are in separate lobbies, and never meet. The library and the visit-client ship together, and the
visit-client serves its own library, so a page always runs the library its visit-client speaks. Between
machines, the lobby refuses an unknown `hello.proto` (`proto_unsupported`), and a link whose ALPN does not
match never opens: the visit ends `"link_failed"`.

## 13. Open questions

- **Avatars, further.** A host may now show a visitor as its own avatar (8.6); whether a host's own user is seen
  in its room by others, and avatars that do more than walk and stand (sit, wave), are for a later version.
- **Further worlds.** A world holds an office's own friends' plots; a friend's friends (a world beyond the
  next plot) are not drawn.
- **More than one corner.** One link is shown in the corner at a time; others wait. A page could show several,
  each with its own renderer, if people link with many at once.
- **Other engines.** Every room is three.js. glTF could carry other engines' scenes the same way, if one
  ever needs to take part.
- **Audio.** None in version 1.
- **The version-1 group view.** Version-1 sims stream their own view to a group; whether version 2 keeps a
  "just watch" mode (a visit that never moves from its spawn) or retires it.
- **The relay's deployment.** It is to run beside the lobby on the same server; the details (ports, TLS
  through Caddy) belong to the build. Until it does, the lobby names no relays and links use iroh's public
  ones.
- **Touch and gamepads.** Input is keyboard and mouse only for now.
