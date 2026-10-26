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

Visitors get the host's whole scene: a sim that shows issue titles or agent activity in its room shows them
to its visitors, wherever they stand and whether they look or not. Letting someone in is the host's
decision, one knock at a time.

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
| `--state-file` | `VISIT_STATE_FILE` | none | a file where it keeps whether the office is away (`leave_lobby`, 5.2), so a restart stays away; none: every start joins the lobby. A launcher SHOULD give one |

A flag wins over its environment variable, and a variable set but blank counts as unset (its default), as a
`.env` file has it. [`../.env.example`](../.env.example) is the template of them all.

On start it prints **one JSON line** to stdout once it listens, then logs to stderr:

```json
{"ready": true, "port": 7401, "version": "0.6.0", "proto": "basedverse-visit-local/2"}
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
| `GET /health` | none | `{"ok": true, "version": "0.6.0"}` |
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
{"type": "ready", "version": "0.6.0", "office": {"id": "o1a2b3c4", "name": "Magic Room"},
 "online": true, "away": false, "status": "available", "max_visitors": 3,
 "visits": [{"id": "v…", "channel": 1, "role": "host", "peer": {"id": "o…", "name": "Ada", "sim": {…}}}]}
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
| `knock` | `to` (office id), `message`? (≤ 280) | ask to visit an office (refused `not_hosting` before `host`) |
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
| `online` / `offline` | `office`, `knocking` / `away`? | the lobby session came up (after a drop: the same office if it resumed), with this office's own knocks still waiting ([{`id`, `to`}]) / went down: `away: true` when the page took it out (`leave_lobby`), `false` when it is on its way back (`join_lobby`), absent when the lobby is out of reach |
| `lobby` | `offices`: [{`id`, `name`, `status`, `sim`, `max_visitors`, `visitors`, `visiting`, `ready`}] | every change (6.3) |
| `knock` | `id`, `from` {`id`, `name`, `sim`}, `message`, `expires_in` | someone wants to visit you |
| `knock_sent` / `knock_cancelled` / `answered` | as in section 6 | your knock's fate; a knock on you withdrawn |
| `visit_started` | `id`, `channel`, `role` (`"host"` \| `"visitor"`), `peer` {`id`, `name`, `sim`}, `state`? | a visit began (its link is up); in `ready`, a host's visit carries the last `state` its page sent |
| `visit_ended` | `id`, `channel`, `reason` (6.5) | a visit ended |
| `host_paused` / `host_resumed` | `channel` | the host's page went away / came back (visitor side) |
| `input` | `channel`, `seq`, `forward`, `strafe`, `run`, `yaw`, `pitch`, `t` | a visitor's latest input (host side) |
| `point` | `channel`, `yaw`, `pitch` | a visitor pointed (8.3), clamped, at most 5 a second each (host side) |
| `link_stats` | `channel`, `path` (`"direct"` \| `"relay"`), `rtt_ms` | the visit's link, about once a second, both sides: a relayed path is slower and rate-limited |
| `keyframe` | `channel` | send a key delta on this visit soon (host side) |
| `scene_resync` | `channel` | send this visitor the whole scene again (host side): it asked, or the link dropped edits it had not sent |
| `scene` | `channel`, `edit` | an edit of the host's scene, unpacked and checked (8.1) (visitor side) |
| `scene_lost` | `channel` | an edit of the host's scene was dropped (malformed, too big, too many): ask for the whole scene (visitor side) |
| `error` | `code`, `message`, `ref`? | a refusal (section 11) |
| binary | section 5.4 | a scene delta (visitor) |

### 5.4 Binary frames

Both directions, one scene delta (or, from the host's page, one scene edit) per WebSocket binary message:

| bytes | field |
|---|---|
| 0–1 | `channel`, u16 big-endian |
| 2 | flags: bit 0 = a key delta (everything that has moved, 8.1); bit 1 = a scene edit (host page to visit-client only, alone) |
| 3–10 | timestamp, u64 big-endian, microseconds: the host page's clock when it took the delta (unused for an edit) |
| 11… | the delta (8.1), or the edit, gzipped JSON |

A delta larger than 1 MiB, or an edit larger than 16 MiB, is dropped. A visit-client sends deltas on the
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
| `hello` | `proto`: `"basedverse-lobby/3"`, `name`, `sim`?, `status`?, `max_visitors`? (default 3), `resume`? | join, or resume a dropped session (6.1) |
| `link` | `endpoint` (the iroh endpoint id: its public key, as a string), `addr` (an object, ≤ 2 KiB as JSON, passed through untouched: how to reach it); or both null | publish or update how to reach this office; both null: withdraw it (not ready, until published again) |
| `status` | `status` | as version 1 |
| `max_visitors` | `n` (0–8) | change it |
| `knock` | `to`, `message`? | ask to visit |
| `answer` | `knock`, `accept`, `message`? | answer a knock on your door |
| `end` | `visit`, `reason`? (`"left"`, `"kicked"`, `"link_failed"`) | end a visit you are in, either side |
| `rename` | `name` | a new name, if it is free (`name_taken`, `name_invalid` otherwise; the office keeps its own) |
| `bye` | — | leave the lobby now: the session ends at once, not held for resuming (a visit-client stopping) |

### 6.3 Lobby → visit-client

| type | fields | when |
|---|---|---|
| `welcome` | `proto`, `id`, `name`, `relays`: [url], `resume` (32 hex), `resumed` (bool), `visits`: [id], `knocking`: [{`id`, `to`}], `limits` | after a good `hello` |
| `lobby` | `offices`: [{`id`, `name`, `status`, `sim`, `max_visitors`, `visitors` (count), `visiting` (the host's office id, or `null`), `ready`}], you included | on any change |
| `knock` | `id`, `from` {`id`, `name`, `sim`}, `message`, `expires_in` | someone knocked |
| `knock_sent` | `id`, `to` | your knock reached the door |
| `knock_cancelled` | `id`, `reason`: `"timeout"` \| `"gone"` | a knock on you was withdrawn |
| `answered` | `knock`, `accept`, `reason`? (`"declined"`, `"timeout"`, `"gone"`, `"full"`, `"not_ready"`), `message`? | your knock's answer |
| `visit` | `id`, `role`, `peer` {`id`, `name`, `sim`}, `ticket` (32 hex), `peer_link` {`endpoint`, `addr`} | a visit was agreed: the visitor dials, the host waits for it (section 7) |
| `visit_ended` | `id`, `reason` (6.5) | a visit ended |
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

### 6.5 Why visits end

`"left"` (the visitor ended it), `"kicked"` (the host did), `"moved"` (the visitor went into another
room), `"gone"` (either office left the lobby: its visit-client stopped, or its connection stayed down
past the 30 s resume window), `"link_failed"` (the link could not be made, or was lost for longer than the
grace period, section 7.5).

### 6.6 Limits

`welcome.limits`: `name` 24, `message` 280, `knocks_per_minute` 6, `knock_ttl` 60, `max_visitors` 8 (the
highest an office may set), `link_addr` 2048 (bytes of `addr` as JSON), `connections_per_ip` 8.

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
| host | `{"paused": true}` / `{"paused": false}` | the host's page went away / came back |
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
  `walk` ({speed}, how the host's `move` walks, or null), `yaw0` and `pose` (where the visitor starts). It goes
  when the visitor starts, and when asked (`scene_resync`); it replaces whatever the visitor had. A visitor's
  page that has none 3 s after its visit starts (or after it last asked) asks for it.
- **Edits** (`{"type": "edit", …}`): at most one every 33 ms, only when something changed, each field
  optional, applied in this order: `res` ({geometries, materials, textures, images, shapes}, in `toJSON` form:
  new ones, or ones changed in place, whose content the visitor's copy takes), `remove` ([number]), `add`
  ([{parent, json (the new object's `toJSON()`, with what it is made of), ids, targets}]), `parent` ([[number,
  new parent's number]]), `assign` ([[number, material uuid (or uuids) or null, geometry uuid or null]]),
  `props` ([{uuid, …}]: materials' colours and values as they change: `color`, `emissive`, `specular`,
  `opacity`, `transparent`, `visible`, …), `scene` ({background (a colour, {texture: uuid}, or null), fog
  ({type, color, near, far, density} or null)}).
- **Deltas**, every 33 ms when anything moved, a key delta every second and when asked (`keyframe`), all
  big-endian: u8 version (1); f64 `t`, the visitor's latest input time the host has, and f32 `age`, the ms
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
  release, `0.<r>.0`, r125 to r186 in 0.6.0), fetched from `https://cdn.jsdelivr.net/npm/three@0.<r>.0/build/`
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

What a point may do is the host's to choose, and is a guest's reach into its room: a host takes points through
an allow list of what its user would let a guest do (pushing a ball, ringing a bell), never anything that
reaches its user's tools, data or accounts. A host marks what a visitor may point at with
`userData.visitPoint = true` (on an object, or on a group it is part of): the visitor's crosshair shows hot
over it (the first thing in its line of sight that is, or is part of, one so marked). The mark is a hint for
the visitor's eyes; the host still decides each point by its own lights.

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
v.viewFocused  // visiting, and the view takes the keys and mouse (not shrunk to a corner): the page's own keys wait
v.office       // { id, name } while online
v.status       // "available" | "busy"
v.maxVisitors  // number
v.offices      // [{ id, name, status, sim, maxVisitors, visitors, visiting, ready }], you included
v.knocks       // knocks on your door: [{ id, from: { id, name, sim }, message, until (ms epoch) }]
v.knocking     // your knocks still waiting: [{ id, to }]
v.visiting     // your visit as a visitor: { id, host: { id, name, sim }, paused } or null
v.visitors     // your visitors as a host: [{ id, visitor: { id, name, sim }, pose }]

v.on(event, fn); v.off(event, fn)   // "change" | "knock" | "answered" | "visit_started" | "visit_ended" | "stats" | "error" | "point"
v.close()          // disconnect for good
v.setStatus(status); v.setMaxVisitors(n); v.rename(name)
v.knock(officeId, message); v.answer(knockId, accept, message)
v.leave()          // end your visit
v.kick(visitId)    // end someone's visit to you
v.leaveLobby()     // away: out of the lobby, nobody sees you or can knock, your visits end (kept across restarts
v.joinLobby()      //   with VISIT_STATE_FILE); and back

// hosting: register once after connect (and again after each page load). Until then this office is not in the
// lobby to be visited, and cannot knock: every room takes part with its scene.
v.host({
  spawn(visitor) { return pose; },            // where a new visitor appears
  move(pose, input, dt, { id, visitor }) { return pose; },   // where it may go: the library has already set pose.yaw and
                                              //   pose.pitch; id is the visit's, visitor { id, name, sim }
  scene: { root, three, renderer, near, far },      // the room's three.js scene (or the part to share), the THREE it was made with
                                                    //   (r125 to r186), its renderer, and visitors' camera range (8.1)
  fov: 70,                                          // visitors' camera's vertical field of view, in degrees
  walk: { speed },                                  // optional: move() walks with Visit.walk at this speed: visitors walk at once
});

// hosting: a visitor pointed (8.3): { id (its visit), visitor: { id, name, sim }, from: [x, y, z] (its eyes,
// where this page has it), dir: [x, y, z] (a unit vector, where it looked), yaw, pitch (in the room's terms) }.
// What it does, if anything, is yours: take it through an allow list of what a guest may do.
v.on("point", ({ id, visitor, from, dir }) => { /* ... */ });

// visiting: where to show the room you are in; the library draws its scene there and captures input; while the
// mouse looks about (the pointer locked), a crosshair at the middle, and a click there points (8.3)
const view = v.view(element);   // { release(), setActive(on), active, canvas }: inactive, it takes no keys or mouse

// helpers
Visit.walk(pose, input, dt, { speed, blocked })   // first-person walking with wall sliding, for move()
Visit.panel(element, v)                          // an optional ready-made lobby panel, with Go offline / Go online: { element, release() }
Visit.stage(v)                                   // an optional ready-made visit view: the room visited full-window (with the
                                                 //   link's numbers, Back to my room, Leave), or in a corner; { element, big, shrink(), grow(), release() }
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

## 11. Errors

**Page connection refusals:** HTTP 403 before the WebSocket opens (an origin not in `--origins`); close
codes 4400 bad `hello`, 4401 bad or missing token, 4409 replaced by a newer page.

**`error` codes the page can get** (from the visit-client, or passed through from the lobby): those of
section 6.4 (`not_found`, `self_knock`, `not_available`, `full`, `not_ready`, `already_visiting`,
`knock_pending`, `rate_limited`), `message_too_long`, `name_invalid`, `name_taken` (on `rename`; the
office keeps its name), `not_yours` (answering a knock that is not yours), `not_hosting` (knocking before
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

- **Avatars.** Hosts know every visitor's pose, so they can draw visitors in their own room, and visitors
  then see each other there too (8.1); whether visitors should also see the host is for a later version.
- **Other engines.** Every room is three.js. glTF could carry other engines' scenes the same way, if one
  ever needs to take part.
- **Audio.** None in version 1.
- **The version-1 group view.** Version-1 sims stream their own view to a group; whether version 2 keeps a
  "just watch" mode (a visit that never moves from its spawn) or retires it.
- **The relay's deployment.** It is to run beside the lobby on the same server; the details (ports, TLS
  through Caddy) belong to the build. Until it does, the lobby names no relays and links use iroh's public
  ones.
- **Touch and gamepads.** Input is keyboard and mouse only for now.
