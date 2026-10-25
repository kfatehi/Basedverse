# Visit — the specification

**Status: built** (visit-client and visit.js in `client/`, the lobby's version 2 in `../lobby/server/`) and
tested on one machine; not yet between two machines over the internet. This is the contract they are built
to. Where it says MUST, SHOULD or MAY, those words mean what RFC 2119 says they mean.

Visit lets the people running agent-office sims ("workrooms") walk around each other's rooms. A visitor
moves with WASD and the mouse; the host's sim renders what the visitor sees, from where the visitor
stands, and streams it back as video. Nothing about a room travels but video one way and inputs the
other, so every sim draws its room its own way, in its own engine.

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
| **visit.js** | the library, in the sim's page. Talks only to its own visit-client. Calls the sim's host hooks, encodes and decodes video (WebCodecs), captures input. Served by the visit-client itself, so the two always match. | shared, identical for everyone |
| **lobby server** | presence, knocks, and introducing visit-clients to each other (`basedverse-lobby/2`, section 6). | shared, one server |
| **relay** | an [iroh](https://iroh.computer) relay, for links between machines that cannot reach each other directly. Encrypted end to end; it cannot read what it carries. | shared, beside the lobby |
| **the sim** | its own room and engine; a launcher step; three host hooks (`spawn`, `move`, `render`); its UI (or the library's default panel). | each sim |

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
7. **A host controls its room.** Visitors only send input. The host's sim decides where a visitor can go
   (`move`) and what it sees (`render`). The host visit-client clamps every input field to its range and
   drops inputs beyond 60 a second, and control messages beyond 20 a second from either side of a link.

Visitors see whatever the host renders, from wherever the host lets them stand: a sim that shows issue
titles or agent activity shows them to its visitors. Letting someone in is the host's decision, one knock
at a time.

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
{"ready": true, "port": 7401, "version": "0.3.0", "proto": "basedverse-visit-local/1"}
```

Exit codes: 0 asked to stop (SIGINT/SIGTERM, or idle-exit); 2 bad flags; 3 the port is taken; 4 the
lobby refused it for good (`proto_unsupported`, `name_invalid`).

### 4.2 Lifecycle

- **A page reload** closes the localhost connection only. The lobby session, the office's knocks and every
  visit and link carry on. While a host's page is gone its visitors are told `host_paused` (their view
  holds the last frame); when a page connects again it gets `ready` with every active visit and starts
  rendering again, a keyframe first.
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
| `GET /health` | none | `{"ok": true, "version": "0.3.0"}` |
| `GET /ws` (WebSocket upgrade) | `hello.token` (5.1) | the page connection |
| anything else | — | 404 |

## 5. Page ↔ visit-client: `basedverse-visit-local/1`

One WebSocket, `ws://127.0.0.1:<port>/ws`, with Nagle's algorithm off at both ends (a visit-client sets
`TCP_NODELAY`, as browsers do: without it a small message waits for the last one's acknowledgement, some
20 ms). Text frames are JSON objects with a string `type`; binary frames carry video (5.4). The library implements all of this; a sim never sees it unless it writes its own
library (for a native sim, say).

### 5.1 Handshake

The page sends, within 5 s:

```json
{"type": "hello", "proto": "basedverse-visit-local/1", "token": "…", "sim": {"name": "my-sim", "version": "1.0"}}
```

The visit-client answers `ready` (or closes: 4401 bad token, 4400 bad `proto`):

```json
{"type": "ready", "version": "0.3.0", "office": {"id": "o1a2b3c4", "name": "Magic Room"},
 "online": true, "away": false, "status": "available", "max_visitors": 3,
 "visits": [{"id": "v…", "channel": 1, "role": "host", "peer": {"id": "o…", "name": "Ada", "sim": {…}}}],
 "limits": {"max_width": 1280, "max_height": 720, "fps": 60}}
```

followed by a `lobby` snapshot and any pending `knock`s.

### 5.2 Page → visit-client

| type | fields | effect |
|---|---|---|
| `status` | `status`: `"available"` \| `"busy"` | set the office's status (busy: no new knocks, visits carry on) |
| `max_visitors` | `n` (0–8) | change how many visitors the office takes; lower than the current count ends no visit |
| `rename` | `name` | ask the lobby for another name; taken (`name_taken`) or invalid, the office keeps its own |
| `leave_lobby` | — | take the office out of the lobby, and keep it out (away, 4.2): nobody sees it or can knock; its visits end |
| `join_lobby` | — | back into the lobby after `leave_lobby`: a new session |
| `knock` | `to` (office id), `message`? (≤ 280) | ask to visit an office |
| `answer` | `knock`, `accept` (bool), `message`? | let a knocker in, or not |
| `end` | `visit` | end a visit: yours as a visitor (leave), or a visitor's to you (kick) |
| `input` | `forward`, `strafe`, `run`, `yaw`, `pitch`, `t` (8.2) | the visitor's input, whole: whenever it changes (at most every 8 ms) and every 33 ms regardless, while visiting |
| `viewport` | `width`, `height` | the visitor's view size, on start and when it changes (debounced 250 ms) |
| `video_config` | `channel`, `codec`, `width`, `height`, `fov`? | the host's encoder settings for a visit, before its first frame and whenever they change; `fov`, its camera's vertical field of view in degrees, lets the visitor turn its picture between frames (9) |
| `decoders` | `codecs`: [string] | the codecs this page can decode, best first (sent once after `ready`) |
| `keyframe` | `channel` | the visitor's page asks for a keyframe (its decoder lost its place) |
| `pose` | `channel`, `state` (≤ 2 KiB) | the host page's state for a visitor (where it stands), about 5 a second; kept by the visit-client and handed back in `ready` to a page that reloads |
| binary | section 5.4 | an encoded frame (host) |

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
| `input` | `channel`, `seq`, `forward`, `strafe`, `run`, `yaw`, `pitch` | a visitor's latest input (host side) |
| `viewport` | `channel`, `width`, `height` | a visitor's view size (host side) |
| `decoders` | `channel`, `codecs` | what a visitor can decode (host side) |
| `video_config` | `channel`, `codec`, `width`, `height`, `fov` | the host's encoder settings (visitor side); `fov` null when the host gave none |
| `bitrate` | `channel`, `bps` | the bitrate the host should encode a visit at, about once a second (7.5) |
| `link_stats` | `channel`, `path` (`"direct"` \| `"relay"`), `rtt_ms` | the visit's link, about once a second, both sides: a relayed path is slower and rate-limited |
| `keyframe` | `channel` | send a keyframe on this visit soon (host side) |
| `error` | `code`, `message`, `ref`? | a refusal (section 11) |
| binary | section 5.4 | an encoded frame (visitor) |

### 5.4 Binary frames

Both directions, one encoded video frame per WebSocket binary message:

| bytes | field |
|---|---|
| 0–1 | `channel`, u16 big-endian |
| 2 | flags: bit 0 = keyframe; bit 1 = the frame carries its meta |
| 3–10 | timestamp, u64 big-endian, microseconds (the `VideoFrame` timestamp) |
| 11–26 | the meta, when flagged: `t` (f64, the visitor's input time this frame reflects, from its `input`), then `yaw` and `pitch` (f32 each, the look it was drawn at, from that input); all big-endian |
| 11… or 27… | the encoded chunk, as `EncodedVideoChunk.copyTo` gives it |

A frame larger than 1 MiB is dropped. The meta lets the visitor measure input to screen (its own clock,
now minus `t`) and turn its picture between frames (section 9); a visit-client passes it through untouched,
and leaves it out for a visitor whose link handshake did not ask for it (7.1).

## 6. The lobby: `basedverse-lobby/2`

The same transport as version 1 ([../lobby/PROTOCOL.md](../lobby/PROTOCOL.md) section 2): one JSON object
per WebSocket text frame, `wss://`, pings every 20 s, a 64 KiB frame limit. The reference lobby speaks both
versions on the same URL, by `hello.proto`; version-1 offices (browser sims streaming to a group) and
version-2 offices (visit-clients) are in separate lobbies and do not see each other. Clients talking
version 2 are visit-clients: browsers never connect to the lobby directly any more.

### 6.1 A session

1. Connect; send `hello` within 10 s.
2. The lobby answers `welcome` (with the relays to use), then a `lobby` snapshot.
3. The visit-client starts its iroh endpoint with those relays and sends `link` with its endpoint id and
   address. Until it has, its office shows `ready: false` and cannot be visited or knock.
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
| `hello` | `proto`: `"basedverse-lobby/2"`, `name`, `sim`?, `status`?, `max_visitors`? (default 3), `resume`? | join, or resume a dropped session (6.1) |
| `link` | `endpoint` (the iroh endpoint id: its public key, as a string), `addr` (an object, ≤ 2 KiB as JSON, passed through untouched: how to reach it) | publish or update how to reach this office |
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
| `answered` | `knock`, `accept`, `reason`? (`"declined"`, `"timeout"`, `"gone"`, `"full"`), `message`? | your knock's answer |
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
  fresh `lobby`. If the door filled up meanwhile, the knocker hears `answered` with `reason: "full"`.
- A visit counts toward the host's `max_visitors` from the moment it is agreed until it ends.

### 6.5 Why visits end

`"left"` (the visitor ended it), `"kicked"` (the host did), `"moved"` (the visitor went into another
room), `"gone"` (either office left the lobby: its visit-client stopped, or its connection stayed down
past the 30 s resume window), `"link_failed"` (the link could not be made, or was lost for longer than the
grace period, section 7.6).

### 6.6 Limits

`welcome.limits`: `name` 24, `message` 280, `knocks_per_minute` 6, `knock_ttl` 60, `max_visitors` 8 (the
highest an office may set), `link_addr` 2048 (bytes of `addr` as JSON), `connections_per_ip` 8.

## 7. The link: visit-client ↔ visit-client

One QUIC connection per visit, made with iroh (hole punching, then the relay if no direct path works),
ALPN **`basedverse-visit/1`**. iroh connections are encrypted and authenticated by the endpoints' keys.

### 7.1 Dialling and the handshake

1. On `visit`, the **visitor's** visit-client dials `peer_link` with the ALPN. The **host's** waits for it.
2. The visitor opens the **control stream** (bidirectional) and sends `{"proto": "basedverse-visit/1",
   "visit": "<id>", "ticket": "<ticket>", "frame_meta": true}` (`frame_meta`: it reads frames' meta,
   section 7.4; visit-clients before 0.3 leave it out, and get frames without).
3. The host checks that it has that visit, that the ticket matches, and that the connecting endpoint's id
   is the visitor's `peer_link.endpoint`. If not, it closes the connection (application error code 1,
   `"refused"`). If so it answers `{"ok": true}`.
4. Both tell their pages `visit_started`. If the dial or handshake fails for 20 s, either side sends the
   lobby `end` with `reason: "link_failed"`.

### 7.2 The control stream

Messages are JSON, each prefixed by its length (u32 big-endian). In order, reliable.

| from | message | meaning |
|---|---|---|
| visitor | `{"decoders": [codec, …]}` | what the visitor's page can decode, best first |
| visitor | `{"viewport": {"width", "height"}}` | the visitor's view size |
| visitor | `{"keyframe": true}` | send a keyframe soon |
| host | `{"video_config": {"codec", "width", "height", "fov"}}` | before the first frame and on every change |
| host | `{"paused": true}` / `{"paused": false}` | the host's page went away / came back |
| either | `{"bye": "<reason>"}` | ending the visit (also sent to the lobby as `end`) |

### 7.3 Inputs

Visitor to host as **QUIC datagrams**, each a JSON object `{"seq", "forward", "strafe", "run", "yaw",
"pitch", "t"}` (section 8.2): the whole state, never a change, so the newest is all that matters. Datagrams
may be lost or reordered: the host keeps the one with the highest `seq` and drops older ones, and takes at
most 120 a second. The visitor sends whenever its keys or look change (at most every 8 ms) and every 33 ms
regardless, so a lost "key up" is corrected within one interval; the host treats a visitor whose last input
is older than 300 ms as standing still.

### 7.4 Video

Host to visitor on **unidirectional streams, one per group of pictures** (as Media over QUIC does): each
stream starts with a keyframe and carries the frames after it until the next keyframe, which goes on a new
stream. Each frame on a stream is: length (u32 big-endian, the length of what follows), flags (u8, bit 0
keyframe, bit 1 meta), timestamp (u64 big-endian, microseconds), the meta (16 bytes, when flagged: only to
a visitor that said `frame_meta`), the encoded chunk.

**Newest wins; nothing queues.** The host's visit-client resets an older stream when a newer keyframe
starts one (its unsent frames are stale), lets at most 64 KiB be sent and not yet acknowledged (6 Mbit/s
over an 80 ms round trip, and little more: a slow path backs up the sender, not seconds of video), and drops
every frame of a group that is more than
100 ms older than the newest frame waiting, asking its page for a keyframe. The visitor's visit-client reads
streams in order of their keyframes' timestamps. When a newer stream starts it stops reading older ones
(QUIC `STOP_SENDING`): a stalled group is abandoned rather than waited for, and no frame of an older group
follows a newer group's keyframe. Frames go to the page as they arrive (5.4).

### 7.5 Bitrate

The host's visit-client sets each visit's bitrate as WebRTC's congestion control (GCC) does, every 500 ms,
from the link's round trip (against its lowest in the last 10 s: the path's own, without queueing) and its
loss over the last interval: down to 85% the moment queueing delay builds (the round trip more than an
eighth of that floor above it, and at least 8 ms); down by half the loss above 10% loss; held between 2%
and 10% (Wi-Fi loses packets without being full); up 8% a second otherwise. It starts at 1 Mbit/s, stays
between 300 kbit/s and 6 Mbit/s, and tells its page (`bitrate`) when it moves by 5% or more. Both
visit-clients also tell their pages the link's path and round-trip time (`link_stats`), and log the path
whenever it changes.

### 7.6 Blips

A link that drops (Wi-Fi switching, a laptop waking) is redialled by the visitor every 2 s, with the same
ticket, for a **grace period of 15 s**; the visit carries on if it comes back, and ends with
`"link_failed"` if not. During the gap the visitor's view holds its last frame. A link closed on purpose
(application codes 0 bye, 1 refused, 3 visit over: section 11) is not redialled: the lobby ends its visit,
and a visitor refused at the handshake ends it at once (`link_failed`).

## 8. Video and input

### 8.1 Video

- **Codecs.** The visitor's page lists what it can decode (`VideoDecoder.isConfigSupported`), best first.
  The host's page picks the first in that list it can encode, from: `avc1.42E01F` (H.264 constrained
  baseline, Annex B: SPS and PPS travel with each keyframe, so no decoder description is needed), `vp8`,
  `vp09.00.10.08`.
- **Size.** The visitor's `viewport`, scaled down to fit 1280×720 if larger, rounded down to even numbers.
- **Rate.** Up to 60 frames a second per visit (`limits.fps`): the host's `fps` (10–60, default 60). A
  visitor's input is applied, and its frame rendered if one is due, the moment it arrives, not on the next
  tick. While rendering for visitors takes more than a quarter of the page's time over the last second,
  the library first renders smaller (three-quarters, then half the view's size: a smaller picture costs no
  latency, fewer frames do), then lowers the frame rate (never below 10); it climbs back the other way when
  it fits.
- **Encoder.** `latencyMode: "realtime"`, the machine's own encoder where it has one
  (`hardwareAcceleration: "prefer-hardware"`), the bitrate from section 7.5, a keyframe every 10 s (the
  link is reliable: a keyframe is for a decoder starting or lost, not for loss, and each is a burst a slow
  link feels), when a visitor asks (`keyframe`; at most every 500 ms, as keyframes cost the host far more
  than other frames) and as the first frame after `video_config` changes or the page reconnects. Frames
  keep an even beat: the next is due a frame's time after this one was due, not after it went. No B-frames (the codecs
  above have none in realtime mode): every frame can be shown as soon as it is decoded.

### 8.2 Input

| field | type | meaning |
|---|---|---|
| `forward` | −1, 0 or 1 | W/↑ is 1, S/↓ is −1 |
| `strafe` | −1, 0 or 1 | D/→ is 1 (right), A/← is −1 |
| `run` | boolean | Shift held |
| `yaw` | radians | where the visitor is looking, left/right, relative to how it was facing when it arrived (positive: turned left) |
| `pitch` | radians, −1.4 to 1.4 | up (positive) or down |
| `t` | ms | the visitor page's clock when it sent this input (`performance.now()`); the host's frames carry it back in their meta |

**Look belongs to the visitor; position belongs to the host.** The visitor's page turns the view as fast
as the mouse moves and sends where it is looking; the host applies it as is. Between the host's frames the
visitor's page shifts the last one by how far it has turned since (it knows the look each frame was drawn
at, and the host's field of view), so turning feels instant whatever the round trip; walking waits for
the host. Where the visitor stands is
the host's to decide (`move`), against its own walls and furniture. The host clamps every field to its
range.

## 9. The library: `visit.js`

The normative surface; INTEGRATING.md shows it in use. Loaded with
`<script src="http://127.0.0.1:<port>/visit.js"></script>`, which defines `window.Visit`.

```js
// token: the token, or a function giving it (sync or async), asked again on each reconnect: a visit-client
// restarted with a new token is then found again by itself. A wrong token is final for a string.
const v = await Visit.connect({ port, token, sim: { name, version } });

// state, always current; "change" fires whenever any of it changes (never for the per-frame traffic)
v.state        // "connecting" | "online" | "offline" (the lobby out of reach) | "away" (out of it on purpose)
v.stats        // while visiting, about once a second: { latency (input to screen, ms), rtt (the link's, ms),
               //   path ("direct" | "relay"), fps (frames drawn a second) }
v.viewFocused  // visiting, and the view takes the keys and mouse (not shrunk to a corner): the page's own keys wait
v.office       // { id, name } while online
v.status       // "available" | "busy"
v.maxVisitors  // number
v.offices      // [{ id, name, status, sim, maxVisitors, visitors, visiting, ready }], you included
v.knocks       // knocks on your door: [{ id, from: { id, name, sim }, message, until (ms epoch) }]
v.knocking     // your knocks still waiting: [{ id, to }]
v.visiting     // your visit as a visitor: { id, host: { id, name, sim }, paused } or null
v.visitors     // your visitors as a host: [{ id, visitor: { id, name, sim }, pose }]

v.on(event, fn); v.off(event, fn)   // "change" | "knock" | "answered" | "visit_started" | "visit_ended" | "stats" | "error"
v.close()          // disconnect for good
v.setStatus(status); v.setMaxVisitors(n); v.rename(name)
v.knock(officeId, message); v.answer(knockId, accept, message)
v.leave()          // end your visit
v.kick(visitId)    // end someone's visit to you
v.leaveLobby()     // away: out of the lobby, nobody sees you or can knock, your visits end (kept across restarts
v.joinLobby()      //   with VISIT_STATE_FILE); and back

// hosting: register once after connect (and again after each page load)
v.host({
  spawn(visitor) { return pose; },            // where a new visitor appears
  move(pose, input, dt) { return pose; },     // where it may go: the library has already set pose.yaw and pose.pitch
  render(pose, width, height) { return canvas; },   // your room from pose, into a canvas of that size
  fps: 60,                                          // optional: the most frames a second per visitor (10–60)
  fov: 70,                                          // optional: the camera's vertical field of view, in degrees: visitors turn instantly
});

// visiting: where to show the room you are in; the library draws it there and captures input
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

**Calling the hooks.** `spawn` once per visitor. `move` 30 times a second per visitor, with the latest
input and `dt` in seconds. `render` at the visit's frame rate (8.1: up to 60 a second per visitor), one visitor at a time: the library makes
its `VideoFrame` from the returned canvas before the next call, so one canvas MAY serve every visitor. A
hook that throws is logged and skipped for that tick; three throws in a row end that visit (`"kicked"`).

**Timing.** The library ticks from a Worker's timer: a page's own timers slow to once a second or less
while its tab is in the background, and a host must go on rendering for its visitors. A page whose
Content-Security-Policy forbids `blob:` workers falls back to its own timers, and its visitors then see it
slowly while its tab is hidden.

## 10. Limits and defaults

| what | value |
|---|---|
| page port | 7401 (flag) |
| page token | ≥ 32 hex characters, new each run |
| page hello timeout | 5 s |
| max visitors | 3 by default, 0–8 |
| view size | the visitor's, at most 1280×720 |
| frame rate | up to 60 per visit: the host's `fps` (10–60, default 60), lowered (after the size) while it does not fit |
| render size | the visitor's view, then three-quarters, then half of it while the host is busy |
| bitrate | 1 Mbit/s to start, 0.3–6 Mbit/s, set every 500 ms |
| keyframe interval | 10 s, and on request (a visitor's requests passed on at most every 500 ms) |
| input rate | on every change, at most every 8 ms, and every 33 ms regardless; at most 120 a second accepted |
| video behind | a frame more than 100 ms older than the newest waiting is dropped, to the next keyframe |
| link send window | 64 KiB sent and not yet acknowledged |
| control messages on a link | at most 20 a second from either side; more are dropped |
| lobby silence | a minute: then the connection is made again |
| input staleness | 300 ms |
| link dial timeout | 20 s |
| link grace period | 15 s |
| lobby session kept after a drop (resume) | 30 s |
| largest frame | 1 MiB |
| knock wait | 60 s |

## 11. Errors

**Page connection refusals:** HTTP 403 before the WebSocket opens (an origin not in `--origins`); close
codes 4400 bad `hello`, 4401 bad or missing token, 4409 replaced by a newer page.

**`error` codes the page can get** (from the visit-client, or passed through from the lobby): those of
section 6.4 (`not_found`, `self_knock`, `not_available`, `full`, `not_ready`, `already_visiting`,
`knock_pending`, `rate_limited`), `message_too_long`, `name_invalid`, `name_taken` (on `rename`; the
office keeps its name), `not_yours` (answering a knock that is not yours), `no_such_visit` (`end` or
`keyframe` for a visit you are not in), `offline` (an action while the lobby is down), `away` (an action
while the office is out of the lobby on purpose: `join_lobby` first), `bad_message`.

**Link application error codes:** 0 normal close (`bye`), 1 refused (bad ticket or endpoint), 2 protocol
mismatch, 3 visit over.

## 12. Versions

Three names, each changed only by something an older peer could not handle (additions keep the name;
[../CHANGELOG.md](../CHANGELOG.md) lists every release's additions, and what an integration does about them):
`basedverse-visit-local/1` (page ↔ visit-client), `basedverse-lobby/2` (visit-client ↔ lobby),
`basedverse-visit/1` (the link's ALPN). The library and the visit-client ship together, and the
visit-client serves its own library, so a page always runs the library its visit-client speaks. Between
machines, the lobby refuses an unknown `hello.proto` (`proto_unsupported`), and a link whose ALPN does not
match never opens: the visit ends `"link_failed"`.

## 13. Open questions

- **Avatars.** Hosts know every visitor's pose, so they can draw visitors in their own room; whether
  visitors should also see each other (and the host) is for a later version.
- **Audio.** None in version 1.
- **The version-1 group view.** Version-1 sims stream their own view to a group; whether version 2 keeps a
  "just watch" mode (a visit that never moves from its spawn) or retires it.
- **The relay's deployment.** It runs beside the lobby on the same server; the details (ports, TLS through
  Caddy) belong to the build.
- **Touch and gamepads.** Input is keyboard and mouse only for now.
