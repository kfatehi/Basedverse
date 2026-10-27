#!/usr/bin/env python3
"""The lobby: who is online, knocks between offices, and the WebRTC signalling that lets the
offices in a group stream their rooms to each other. lobby/PROTOCOL.md is the contract; this is its
reference server. The video never passes through here: it goes peer to peer (or through the TURN relay
when a network blocks that), and this server only introduces the peers.

One process, all state in memory. A restart empties the lobby; every client reconnects and says hello
again. Nobody signs in: a client picks a name, first come first served, like IRC.

It also speaks versions 2 and 3 (basedverse-lobby/2 and /3, ../../visit/SPEC.md section 6) on the same port:
visit-clients, not browsers, agreeing visits (one office walking around another's room) and swapping the
addresses their visit-clients connect to each other by. Each version's offices are a lobby of their own (3:
Visit 0.5 and later, three.js rooms only; 2: Visit 0.2 to 0.4); the first hello decides.

    python3 lobby.py     listens on LOBBY_HOST:LOBBY_PORT (default 0.0.0.0:8765), plain ws://.
                         In production Caddy terminates TLS in front of it (lobby/deploy/).

Environment:
    LOBBY_HOST, LOBBY_PORT   where to listen
    TRUST_PROXY=1            take the client's address from X-Forwarded-For (set behind Caddy only)
    STUN_URLS                comma-separated STUN urls handed to clients (default: Google's public one)
    TURN_URLS, TURN_SECRET   coturn's urls and its static-auth-secret. Each client gets TURN
                             credentials that expire (the TURN REST convention), never the secret.
    KNOCK_TTL                seconds a knock waits for an answer (default 60)
    RELAY_URLS               comma-separated iroh relay URLs handed to visit-clients (version 2); none: their own
Needs the `websockets` package (requirements.txt).
"""
import asyncio
import base64
import collections
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time

from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed

PROTO = "basedverse-lobby/1"
HOST = os.environ.get("LOBBY_HOST", "0.0.0.0")
PORT = int(os.environ.get("LOBBY_PORT", "8765"))
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"
STUN_URLS = [u.strip() for u in os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302").split(",") if u.strip()]
TURN_URLS = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
TURN_SECRET = os.environ.get("TURN_SECRET", "")
TURN_TTL = 24 * 3600

# Every limit a client must respect, sent in `welcome` so a client can enforce them before sending.
LIMITS = {
    "name": 24,                  # characters; see NAME
    "message": 280,              # characters in a knock or an answer
    "frame": 64 * 1024,          # bytes in one WebSocket message; a bigger one closes the connection (1009)
    "knocks_per_minute": 6,      # per office
    "knock_ttl": int(os.environ.get("KNOCK_TTL", "60")),  # seconds a knock waits for its answer
    "group": 6,                  # offices in one group: each streams to every other, so it stays small
    "connections_per_ip": 8,
}
NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,22}[A-Za-z0-9])?$")
STATUSES = ("available", "busy")
HELLO_TIMEOUT = 10   # seconds to say hello once connected
HELLO_TRIES = 5      # names a client may try before it is closed

log = logging.getLogger("lobby")


class Office:
    """One connected client: a sim's room. `id` is set by a successful hello."""

    def __init__(self, ws, ip):
        self.ws, self.ip = ws, ip
        self.id = self.name = None
        self.status = "available"
        self.sim = {}
        self.group = None                       # the group id, or None
        self.knocked = collections.deque()      # times of its knocks in the last minute


OFFICES = {}                  # id -> Office, every office that said hello
BY_NAME = {}                  # name.casefold() -> id
GROUPS = {}                   # group id -> [office ids], in the order they joined
KNOCKS = {}                   # knock id -> {"id", "from", "to", "message", "timer"}
PER_IP = collections.Counter()


# ---------- sending ----------
def tell(office, msg):
    """Send `msg` to one office. Never blocks and never raises: a closed connection just misses it."""
    broadcast([office.ws], json.dumps(msg))


def error(office, code, text, ref=None):
    tell(office, dict({"type": "error", "code": code, "message": text}, **({"ref": ref} if ref else {})))


def lobby_view():
    return {"type": "lobby", "offices": [
        {"id": o.id, "name": o.name, "status": o.status, "sim": o.sim, "group": o.group}
        for o in sorted(OFFICES.values(), key=lambda o: o.name.casefold())]}


def announce_lobby():
    broadcast([o.ws for o in OFFICES.values()], json.dumps(lobby_view()))


def announce_group(gid):
    members = [OFFICES[i] for i in GROUPS.get(gid, [])]
    msg = {"type": "group", "id": gid, "members": [{"id": o.id, "name": o.name} for o in members]}
    broadcast([o.ws for o in members], json.dumps(msg))


def ice_servers(office_id):
    """STUN for everyone; TURN with credentials that expire, when a relay is configured."""
    out = [{"urls": STUN_URLS}] if STUN_URLS else []
    if TURN_URLS and TURN_SECRET:
        user = "%d:%s" % (int(time.time()) + TURN_TTL, office_id)
        cred = base64.b64encode(hmac.new(TURN_SECRET.encode(), user.encode(), hashlib.sha1).digest()).decode()
        out.append({"urls": TURN_URLS, "username": user, "credential": cred})
    return out


# ---------- groups ----------
def busy_member(gid, but=None):
    """An office in group `gid` (other than `but`) that is busy, or None. A busy member is a veto: nobody
    joins its group."""
    return next((OFFICES[i] for i in GROUPS.get(gid, []) if OFFICES[i] is not but and OFFICES[i].status == "busy"), None)


def join(knocker, host):
    """`knocker` joins the group `host` is in (or a new one with `host`), leaving its own first."""
    if knocker.group:
        leave(knocker)
    if not host.group:
        host.group = "g" + secrets.token_hex(4)
        GROUPS[host.group] = [host.id]
    GROUPS[host.group].append(knocker.id)
    knocker.group = host.group
    announce_group(host.group)
    announce_lobby()


def leave(office, tell_it=True):
    """Take `office` out of its group. A group left with one office ends."""
    gid = office.group
    if not gid:
        return
    office.group = None
    members = GROUPS.get(gid, [])
    if office.id in members:
        members.remove(office.id)
    if tell_it:
        tell(office, {"type": "group", "id": None, "members": []})
    if len(members) <= 1:
        for i in members:
            OFFICES[i].group = None
            tell(OFFICES[i], {"type": "group", "id": None, "members": []})
        GROUPS.pop(gid, None)
    else:
        announce_group(gid)
    announce_lobby()


# ---------- knocks ----------
def expire(kid):
    k = KNOCKS.pop(kid, None)
    if not k:
        return
    if k["from"] in OFFICES:
        tell(OFFICES[k["from"]], {"type": "answered", "knock": kid, "accept": False, "reason": "timeout"})
    if k["to"] in OFFICES:
        tell(OFFICES[k["to"]], {"type": "knock_cancelled", "id": kid, "reason": "timeout"})


def drop_knocks(office):
    """An office left: its knocks are cancelled and the knocks waiting on it are answered `gone`."""
    for kid, k in list(KNOCKS.items()):
        if office.id not in (k["from"], k["to"]):
            continue
        KNOCKS.pop(kid)
        k["timer"].cancel()
        if k["from"] == office.id and k["to"] in OFFICES:
            tell(OFFICES[k["to"]], {"type": "knock_cancelled", "id": kid, "reason": "gone"})
        if k["to"] == office.id and k["from"] in OFFICES:
            tell(OFFICES[k["from"]], {"type": "answered", "knock": kid, "accept": False, "reason": "gone"})


def text_field(m, key, office, ref):
    """A message's optional text field: a string within LIMITS["message"], or None after an error."""
    v = m.get(key, "")
    if not isinstance(v, str):
        error(office, "bad_message", "%s must be a string" % key, ref)
        return None
    if len(v) > LIMITS["message"]:
        error(office, "message_too_long", "%s is over %d characters" % (key, LIMITS["message"]), ref)
        return None
    return v


# ---------- what a client may send ----------
def on_status(me, m):
    if m.get("status") not in STATUSES:
        return error(me, "bad_message", "status must be one of %s" % ", ".join(STATUSES), "status")
    me.status = m["status"]
    announce_lobby()


def on_knock(me, m):
    target = OFFICES.get(m.get("to"))
    msg = text_field(m, "message", me, "knock")
    if msg is None:
        return
    if not target:
        return error(me, "not_found", "no office with that id", "knock")
    if target is me:
        return error(me, "self_knock", "an office cannot knock on itself", "knock")
    if target.status != "available":
        return error(me, "not_available", "%s is not available" % target.name, "knock")
    if me.group and me.group == target.group:
        return error(me, "already_together", "you are already in a group with %s" % target.name, "knock")
    busy = target.group and busy_member(target.group)
    if busy:
        return error(me, "not_available", "%s is in a group with %s, who is busy" % (target.name, busy.name), "knock")
    if any(k["from"] == me.id and k["to"] == target.id for k in KNOCKS.values()):
        return error(me, "knock_pending", "your knock on %s is still waiting" % target.name, "knock")
    if target.group and len(GROUPS[target.group]) >= LIMITS["group"]:
        return error(me, "group_full", "%s's group is full" % target.name, "knock")
    now = time.monotonic()
    while me.knocked and now - me.knocked[0] > 60:
        me.knocked.popleft()
    if len(me.knocked) >= LIMITS["knocks_per_minute"]:
        return error(me, "rate_limited", "at most %d knocks a minute" % LIMITS["knocks_per_minute"], "knock")
    me.knocked.append(now)
    kid = "k" + secrets.token_hex(6)
    timer = asyncio.get_running_loop().call_later(LIMITS["knock_ttl"], expire, kid)
    KNOCKS[kid] = {"id": kid, "from": me.id, "to": target.id, "message": msg, "timer": timer}
    tell(target, {"type": "knock", "id": kid, "from": {"id": me.id, "name": me.name, "sim": me.sim},
                  "message": msg, "expires_in": LIMITS["knock_ttl"]})
    tell(me, {"type": "knock_sent", "id": kid, "to": target.id})


def on_answer(me, m):
    k = KNOCKS.get(m.get("knock"))
    msg = text_field(m, "message", me, "answer")
    if msg is None:
        return
    if not k:
        return error(me, "not_found", "no knock with that id (answered, expired, or withdrawn)", "answer")
    if k["to"] != me.id:
        return error(me, "not_yours", "that knock is not on your door", "answer")
    if not isinstance(m.get("accept"), bool):
        return error(me, "bad_message", "accept must be true or false", "answer")
    KNOCKS.pop(k["id"])
    k["timer"].cancel()
    knocker = OFFICES[k["from"]]   # a knocker that left took its knocks with it (drop_knocks)
    if m["accept"] and me.group and knocker.group == me.group:   # someone else let it in meanwhile
        return tell(knocker, {"type": "answered", "knock": k["id"], "accept": True, "message": msg})
    if not m["accept"]:
        return tell(knocker, {"type": "answered", "knock": k["id"], "accept": False, "reason": "declined", "message": msg})
    busy = me.group and busy_member(me.group, but=me)   # went busy after the knock came
    if busy:
        tell(knocker, {"type": "answered", "knock": k["id"], "accept": False, "reason": "busy", "message": msg})
        return error(me, "not_available", "%s is busy: nobody joins your group until they are available" % busy.name, "answer")
    if me.group and len(GROUPS[me.group]) >= LIMITS["group"]:
        tell(knocker, {"type": "answered", "knock": k["id"], "accept": False, "reason": "group_full", "message": msg})
        return error(me, "group_full", "your group is full", "answer")
    tell(knocker, {"type": "answered", "knock": k["id"], "accept": True, "message": msg})
    join(knocker, me)


def on_leave(me, m):
    if me.group:
        leave(me)
    else:
        tell(me, {"type": "group", "id": None, "members": []})


def on_signal(me, m):
    target = OFFICES.get(m.get("to"))
    if not target:
        return error(me, "not_found", "no office with that id", "signal")
    if not me.group or target.group != me.group or target is me:
        return error(me, "not_in_group", "signals go only to another office in your group", "signal")
    if not isinstance(m.get("data"), dict):
        return error(me, "bad_message", "data must be an object", "signal")
    tell(target, {"type": "signal", "from": me.id, "data": m["data"]})


HANDLERS = {"status": on_status, "knock": on_knock, "answer": on_answer, "leave": on_leave, "signal": on_signal}


def parse(office, raw):
    """A message as a dict with a string `type`, or None after an error."""
    try:
        m = json.loads(raw)
    except (ValueError, TypeError):
        error(office, "bad_json", "a message is one JSON object")
        return None
    if not isinstance(m, dict) or not isinstance(m.get("type"), str):
        error(office, "bad_message", "a message is a JSON object with a string `type`")
        return None
    return m


def hello(me, raw):
    """True once `me` is in the lobby. An error leaves the connection open for another try."""
    m = parse(me, raw)
    if m is None:
        return False
    if m["type"] != "hello":
        error(me, "hello_first", "say hello first", m["type"])
        return False
    if m.get("proto") != PROTO:
        error(me, "proto_unsupported", "this lobby speaks %s" % PROTO, "hello")
        return False
    name, sim = m.get("name"), m.get("sim", {})
    if not isinstance(name, str) or not NAME.match(name):
        error(me, "name_invalid", "a name is 1-24 letters, digits, spaces, _ . -, starting and ending "
                                  "with a letter or digit", "hello")
        return False
    if name.casefold() in BY_NAME:
        error(me, "name_taken", "%s is taken" % name, "hello")
        return False
    if m.get("status", "available") not in STATUSES:
        error(me, "bad_message", "status must be one of %s" % ", ".join(STATUSES), "hello")
        return False
    if not isinstance(sim, dict):
        error(me, "bad_message", "sim must be an object", "hello")
        return False
    me.id = "o" + secrets.token_hex(4)
    me.name, me.status = name, m.get("status", "available")
    me.sim = {k: str(sim[k])[:40] for k in ("name", "version") if isinstance(sim.get(k), str)}
    OFFICES[me.id], BY_NAME[name.casefold()] = me, me.id
    tell(me, {"type": "welcome", "proto": PROTO, "id": me.id, "name": me.name,
              "ice_servers": ice_servers(me.id), "limits": LIMITS})
    announce_lobby()
    log.info("+ %s (%d online)", me.name, len(OFFICES))
    return True


def depart(me):
    OFFICES.pop(me.id, None)
    BY_NAME.pop(me.name.casefold(), None)
    drop_knocks(me)
    leave(me, tell_it=False)
    announce_lobby()
    log.info("- %s (%d online)", me.name, len(OFFICES))


# ---------- version 2: visit-clients (../../visit/SPEC.md section 6) ----------
# A separate lobby on the same server: version-2 offices are visit-clients, not browsers, and they do not
# see version-1 offices. A visit is one office walking around another's room; the lobby agrees it and
# gives each side the other's link address, and the two visit-clients connect to each other directly. A
# dropped connection's session is kept LIMITS2["resume"] seconds, so a visit-client that reconnects in
# time comes back as the same office, with its knocks and visits.
PROTO2 = "basedverse-lobby/2"
PROTO3 = "basedverse-lobby/3"   # the same, for Visit 0.5 on: a lobby of its own (they cannot visit Visit 0.4 rooms)
PROTOS2 = (PROTO2, PROTO3)
RELAY_URLS = [u.strip() for u in os.environ.get("RELAY_URLS", "").split(",") if u.strip()]
LIMITS2 = {
    "name": 24, "message": 280, "frame": 64 * 1024, "knocks_per_minute": 6,
    "knock_ttl": int(os.environ.get("KNOCK_TTL", "60")),
    "max_visitors": 8,           # the most an office may take
    "max_watchers": 8,           # the most offices watching one office's plot at once (Visit 0.7's world)
    "max_watching": 8,           # the most plots one office watches at once
    "watch_knocks_per_minute": 30,   # a world's knocks to watch are made by visit-clients, by themselves
    "link_addr": 2048,           # bytes of a link's `addr`, as JSON
    "connections_per_ip": 8,
    "resume": 30,                # seconds a dropped session is kept
    "chat": 200,                 # characters in a line of lobby chat (Visit 0.15)
    "chats_per_10s": 5,          # lines of lobby chat an office may say in 10 s
}
END_REASONS = ("left", "kicked", "link_failed")


class Office2:
    """One visit-client's session. Outlives its connection by LIMITS2["resume"] seconds (`ws` None)."""

    def __init__(self, ws):
        self.ws = ws
        self.id = self.name = self.resume = None
        self.status = "available"
        self.sim = {}
        self.max_visitors = 3
        self.proto = PROTO2          # which lobby it is in: it sees, and visits, only offices of the same
        self.link = None             # {"endpoint", "addr"} once published (and until withdrawn)
        self.key = None              # the endpoint it last published: its key, kept while its link is withdrawn
        self.world = False           # it takes knocks to watch (Visit 0.7 on: its hello said world: true)
        self.links = False           # it takes links: a knock answered with a watch, seen in a corner (Visit 0.8 on)
        self.chat = False            # it takes lobby chat (Visit 0.15 on: its hello said chat: true)
        self.said = collections.deque()   # when it said its last lines of lobby chat
        self.visiting = None         # the visit it is on, as a visitor
        self.hosting = set()         # the visits to it, as a host
        self.watching = set()        # the watches it has of others' plots (visits with watch: they see, nothing else)
        self.watched = set()         # the watches of its own plot
        self.knocked = collections.deque()
        self.knocked_watch = collections.deque()
        self.held = None             # the timer that ends a dropped session


OFFICES2 = {}                 # id -> Office2
BY_NAME2 = {}                 # name.casefold() -> id
RESUMES2 = {}                 # resume secret -> id
KNOCKS2 = {}                  # knock id -> {"id", "from", "to", "message", "timer", "watch", "link"}
VISITS2 = {}                  # visit id -> {"id", "host", "visitor", "ticket", "watch", "link"}


def tell2(office, msg):
    """Send to an office's connection; a session whose connection dropped (held) just misses it."""
    if office.ws is not None:
        broadcast([office.ws], json.dumps(msg))


def error2(office, code, text, ref=None):
    tell2(office, dict({"type": "error", "code": code, "message": text}, **({"ref": ref} if ref else {})))


def lobby_view2(proto):
    return {"type": "lobby", "offices": [
        {"id": o.id, "name": o.name, "status": o.status, "sim": o.sim, "max_visitors": o.max_visitors,
         "visitors": len(o.hosting), "visiting": VISITS2[o.visiting]["host"] if o.visiting else None,
         "ready": o.link is not None, "key": o.key, "watchers": len(o.watched), "world": o.world, "links": o.links}
        for o in sorted(OFFICES2.values(), key=lambda o: o.name.casefold()) if o.proto == proto]}


def announce2():
    for proto in PROTOS2:
        broadcast([o.ws for o in OFFICES2.values() if o.ws is not None and o.proto == proto], json.dumps(lobby_view2(proto)))


def start_visit(host, visitor, watch=False, link=False):
    """A visit agreed: the visitor leaves any room it is in, then both get `visit` with the other's link. A
    watch (Visit 0.7's world: seeing a plot from outside it) leaves nothing, and counts apart; so does a link
    (Visit 0.8: a knock answered with a watch, which its visitor sees in a corner and may step into)."""
    watch = watch or link
    if visitor.visiting and not watch:
        end_visit(visitor.visiting, "moved")
    vid, ticket = "v" + secrets.token_hex(6), secrets.token_hex(16)
    VISITS2[vid] = {"id": vid, "host": host.id, "visitor": visitor.id, "ticket": ticket, "watch": watch, "link": link}
    if watch:
        host.watched.add(vid)
        visitor.watching.add(vid)
    else:
        host.hosting.add(vid)
        visitor.visiting = vid
    for me in (host, visitor):
        tell2(me, visit_msg(VISITS2[vid], me))
    announce2()


def end_visit(vid, reason):
    v = VISITS2.pop(vid, None)
    if not v:
        return
    host, visitor = OFFICES2.get(v["host"]), OFFICES2.get(v["visitor"])
    if host:
        host.hosting.discard(vid)
        host.watched.discard(vid)
    if visitor:
        visitor.watching.discard(vid)
        if visitor.visiting == vid:
            visitor.visiting = None
    for o in (host, visitor):
        if o:
            tell2(o, {"type": "visit_ended", "id": vid, "reason": reason})
    announce2()


def expire2(kid):
    k = KNOCKS2.pop(kid, None)
    if not k:
        return
    if k["from"] in OFFICES2:
        tell2(OFFICES2[k["from"]], answered(k, False, "timeout"))
    if k["to"] in OFFICES2:
        tell2(OFFICES2[k["to"]], {"type": "knock_cancelled", "id": kid, "reason": "timeout"})


def on2_link(me, m):
    endpoint, addr = m.get("endpoint"), m.get("addr")
    if endpoint is None and addr is None:   # withdrawn (version 3: its page stopped hosting): not ready, until again
        me.link = None
        return announce2()
    if not isinstance(endpoint, str) or not 0 < len(endpoint) <= 200 or not isinstance(addr, dict):
        return error2(me, "bad_message", "link needs an endpoint (string) and an addr (object)", "link")
    if len(json.dumps(addr)) > LIMITS2["link_addr"]:
        return error2(me, "bad_message", "addr is over %d bytes" % LIMITS2["link_addr"], "link")
    me.link = {"endpoint": endpoint, "addr": addr}
    me.key = endpoint
    announce2()


def on2_status(me, m):
    if m.get("status") not in STATUSES:
        return error2(me, "bad_message", "status must be one of %s" % ", ".join(STATUSES), "status")
    me.status = m["status"]
    announce2()


def on2_max_visitors(me, m):
    n = m.get("n")
    if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= LIMITS2["max_visitors"]:
        return error2(me, "bad_message", "n must be 0 to %d" % LIMITS2["max_visitors"], "max_visitors")
    me.max_visitors = n   # lower than the visitors it has ends no visit
    announce2()


def text_field2(m, key, office, ref):
    v = m.get(key, "")
    if not isinstance(v, str):
        error2(office, "bad_message", "%s must be a string" % key, ref)
        return None
    if len(v) > LIMITS2["message"]:
        error2(office, "message_too_long", "%s is over %d characters" % (key, LIMITS2["message"]), ref)
        return None
    return v


def on2_knock(me, m):
    """A knock to visit, or (`watch`: true, Visit 0.7's world) to watch: to see the door's plot from outside it.
    A watch is not stopped by `busy` (the door's visit-client decides: its guests, through an open door), counts
    toward max_watchers rather than max_visitors, and its errors say `ref: "watch"`. A link (`link`: true, Visit
    0.8) is a knock its door answers, as any (busy stops it), that starts a watch when let in: counted as one. To
    a door that does not take links (an older Visit) it is an ordinary knock, and its knock_sent does not say link."""
    watch = m.get("watch") is True
    ref = "watch" if watch else "knock"
    target = OFFICES2.get(m.get("to"))
    if target and target.proto != me.proto:   # in the other lobby: not one this office can see
        target = None
    link = m.get("link") is True and not watch and target is not None and target.links
    msg = text_field2(m, "message", me, ref)
    if msg is None:
        return
    if not target:
        return error2(me, "not_found", "no office with that id", ref)
    if target is me:
        return error2(me, "self_knock", "an office cannot knock on itself", ref)
    if watch and not target.world:
        return error2(me, "not_supported", "%s cannot be watched (an older Visit)" % target.name, ref)
    if not watch and target.status != "available":
        return error2(me, "not_available", "%s is not available" % target.name, ref)
    if not watch and not link and len(target.hosting) >= target.max_visitors:
        return error2(me, "full", "%s has all the visitors it takes" % target.name, ref)
    if (watch or link) and len(target.watched) >= LIMITS2["max_watchers"]:
        return error2(me, "full", "%s has all the watchers it takes" % target.name, ref)
    if (watch or link) and len(me.watching) >= LIMITS2["max_watching"]:
        return error2(me, "too_many", "you watch %d plots already" % LIMITS2["max_watching"], ref)
    if not target.link or not me.link:
        return error2(me, "not_ready", "%s cannot be visited yet" % (target.name if not target.link else "you"), ref)
    if not watch and me.visiting and VISITS2[me.visiting]["host"] == target.id:
        return error2(me, "already_visiting", "you are already in %s's room" % target.name, ref)
    if (watch or link) and any(VISITS2[v]["host"] == target.id for v in me.watching):
        return error2(me, "already_watching", "you already %s %s" % ("are linked with" if link else "watch", target.name), ref)
    if any(k["from"] == me.id and k["to"] == target.id and k["watch"] == watch for k in KNOCKS2.values()):
        return error2(me, "knock_pending", "your knock on %s is still waiting" % target.name, ref)
    now, (knocked, most) = time.monotonic(), (me.knocked_watch, LIMITS2["watch_knocks_per_minute"]) if watch else (me.knocked, LIMITS2["knocks_per_minute"])
    while knocked and now - knocked[0] > 60:
        knocked.popleft()
    if len(knocked) >= most:
        return error2(me, "rate_limited", "at most %d knocks a minute" % most, ref)
    knocked.append(now)
    kid = "k" + secrets.token_hex(6)
    timer = asyncio.get_running_loop().call_later(LIMITS2["knock_ttl"], expire2, kid)
    KNOCKS2[kid] = {"id": kid, "from": me.id, "to": target.id, "message": msg, "timer": timer,
                    "until": time.monotonic() + LIMITS2["knock_ttl"], "watch": watch, "link": link}
    tell2(target, knock_msg(kid))
    tell2(me, dict({"type": "knock_sent", "id": kid, "to": target.id}, **({"watch": True} if watch else {}), **({"link": True} if link else {})))


def knock_msg(kid):
    k, knocker = KNOCKS2[kid], OFFICES2[KNOCKS2[kid]["from"]]
    return dict({"type": "knock", "id": kid, "from": {"id": knocker.id, "name": knocker.name, "sim": knocker.sim, "key": knocker.key},
                 "message": k["message"], "expires_in": max(0, round(k["until"] - time.monotonic()))},
                **({"watch": True} if k["watch"] else {}), **({"link": True} if k.get("link") else {}))


def answered(k, accept, reason=None, msg=""):
    """A knock's answer, for its knocker: a watch's says so, and a link's."""
    a = {"type": "answered", "knock": k["id"], "accept": accept, "message": msg}
    if reason:
        a["reason"] = reason
    if k.get("watch"):
        a["watch"] = True
    if k.get("link"):
        a["link"] = True
    return a


def on2_answer(me, m):
    k = KNOCKS2.get(m.get("knock"))
    msg = text_field2(m, "message", me, "answer")
    if msg is None:
        return
    if not k:
        return error2(me, "not_found", "no knock with that id (answered, expired, or withdrawn)", "answer")
    if k["to"] != me.id:
        return error2(me, "not_yours", "that knock is not on your door", "answer")
    if not isinstance(m.get("accept"), bool):
        return error2(me, "bad_message", "accept must be true or false", "answer")
    KNOCKS2.pop(k["id"])
    k["timer"].cancel()
    knocker = OFFICES2[k["from"]]   # a knocker that left took its knocks with it
    if not m["accept"]:
        return tell2(knocker, answered(k, False, "declined", msg))
    seen = k["watch"] or k.get("link")
    if (len(me.watched) >= LIMITS2["max_watchers"]) if seen else (len(me.hosting) >= me.max_visitors):
        tell2(knocker, answered(k, False, "full", msg))
        return error2(me, "full", "you have all the %s you take" % ("watchers" if seen else "visitors"), "answer")
    if not me.link or not knocker.link:   # withdrawn meanwhile (version 3: a page that stopped hosting)
        tell2(knocker, answered(k, False, "not_ready", msg))
        return error2(me, "not_ready", "%s cannot be visited right now" % ("you" if not me.link else knocker.name), "answer")
    tell2(knocker, answered(k, True, None, msg))
    start_visit(me, knocker, k["watch"], k.get("link", False))


def on2_end(me, m):
    v = VISITS2.get(m.get("visit"))
    if not v or me.id not in (v["host"], v["visitor"]):
        return error2(me, "no_such_visit", "you are not in a visit with that id", "end")
    reason = m.get("reason") or ("left" if me.id == v["visitor"] else "kicked")
    if reason not in END_REASONS:
        return error2(me, "bad_message", "reason must be one of %s" % ", ".join(END_REASONS), "end")
    end_visit(v["id"], reason)


def on2_rename(me, m):
    """A new name, if it is free; a taken or invalid one leaves the office as it was."""
    name = m.get("name")
    if not isinstance(name, str) or not NAME.match(name):
        return error2(me, "name_invalid", "a name is 1-24 letters, digits, spaces, _ . -, starting and ending "
                                          "with a letter or digit", "rename")
    if name.casefold() in BY_NAME2 and BY_NAME2[name.casefold()] != me.id:
        return error2(me, "name_taken", "%s is taken" % name, "rename")
    BY_NAME2.pop(me.name.casefold(), None)
    me.name = name
    BY_NAME2[name.casefold()] = me.id
    announce2()


def on2_chat(me, m):
    """A line for everyone in the lobby (Visit 0.15, like a game's general channel): to every office of the same
    lobby that takes them (its hello said chat: true), the one who said it too, so that it shows in order. Plain text:
    what is not printable becomes a space, trimmed, at most LIMITS2["chat"] characters; LIMITS2["chats_per_10s"] a
    10 s at most. Nothing is kept."""
    text = m.get("text")
    if not isinstance(text, str):
        return error2(me, "bad_message", "text is a string", "chat")
    text = "".join(c if c.isprintable() else " " for c in text).strip()[:LIMITS2["chat"]].strip()
    if not text:
        return error2(me, "bad_message", "text is 1 to %d characters" % LIMITS2["chat"], "chat")
    now = time.monotonic()
    while me.said and now - me.said[0] >= 10:
        me.said.popleft()
    if len(me.said) >= LIMITS2["chats_per_10s"]:
        return error2(me, "rate_limited", "at most %d lines every 10 s" % LIMITS2["chats_per_10s"], "chat")
    me.said.append(now)
    line = {"type": "lobby_chat", "from": {"id": me.id, "name": me.name, "key": me.key}, "text": text}
    for o in OFFICES2.values():
        if o.chat and o.proto == me.proto:
            tell2(o, line)


HANDLERS2 = {"link": on2_link, "status": on2_status, "max_visitors": on2_max_visitors, "knock": on2_knock,
             "answer": on2_answer, "end": on2_end, "rename": on2_rename, "chat": on2_chat}


def welcome2(me, resumed):
    """A fresh resume secret each time: the last one is spent. The welcome lists the session's visits and its
    own knocks still waiting, so a visit-client back from a drop can drop any that ended while it was away."""
    RESUMES2.pop(me.resume, None)
    me.resume = secrets.token_hex(16)
    RESUMES2[me.resume] = me.id
    visits = [v["id"] for v in VISITS2.values() if me.id in (v["host"], v["visitor"])]
    knocking = [{"id": k["id"], "to": k["to"]} for k in KNOCKS2.values() if k["from"] == me.id]
    tell2(me, {"type": "welcome", "proto": me.proto, "id": me.id, "name": me.name, "relays": RELAY_URLS,
               "resume": me.resume, "resumed": resumed, "visits": visits, "knocking": knocking, "limits": dict(LIMITS2),
               "chat": True})


def visit_msg(v, me):
    """A visit as told to one of its two offices: its role, the other office, and the other's link."""
    role, peer = ("host", OFFICES2[v["visitor"]]) if v["host"] == me.id else ("visitor", OFFICES2[v["host"]])
    return dict({"type": "visit", "id": v["id"], "role": role, "peer": {"id": peer.id, "name": peer.name, "sim": peer.sim},
                 "ticket": v["ticket"], "peer_link": peer.link}, **({"watch": True} if v.get("watch") else {}),
                **({"link": True} if v.get("link") else {}))


def hello2(ws, m):
    """The session a version-2 hello opens or resumes, or None after an error (the connection stays open)."""
    probe = Office2(ws)   # stands in for the session until there is one, to answer errors on
    old = OFFICES2.get(RESUMES2.get(m.get("resume")))
    if old and old.proto == m.get("proto"):
        if old.ws is not None and old.ws is not ws:   # its old connection is not known to be dead yet: it is
            asyncio.ensure_future(old.ws.close(4000, "resumed on another connection"))
        if old.held:
            old.held.cancel()
            old.held = None
        old.ws = ws
        welcome2(old, True)
        tell2(old, lobby_view2(old.proto))
        for kid, k in KNOCKS2.items():
            if k["to"] == old.id:
                tell2(old, knock_msg(kid))
        for v in VISITS2.values():   # again, in case one was agreed while it was away (a visit-client ignores repeats)
            if old.id in (v["host"], v["visitor"]):
                tell2(old, visit_msg(v, old))
        log.info("~ %s resumed", old.name)
        return old
    name, sim, max_visitors = m.get("name"), m.get("sim", {}), m.get("max_visitors", 3)
    if not isinstance(name, str) or not NAME.match(name):
        error2(probe, "name_invalid", "a name is 1-24 letters, digits, spaces, _ . -, starting and ending "
                                      "with a letter or digit", "hello")
        return None
    if name.casefold() in BY_NAME2:
        error2(probe, "name_taken", "%s is taken" % name, "hello")
        return None
    if m.get("status", "available") not in STATUSES or not isinstance(sim, dict) or not isinstance(max_visitors, int) \
            or isinstance(max_visitors, bool) or not 0 <= max_visitors <= LIMITS2["max_visitors"]:
        error2(probe, "bad_message", "status must be available or busy, sim an object, max_visitors 0 to %d"
               % LIMITS2["max_visitors"], "hello")
        return None
    me = probe
    me.id = "o" + secrets.token_hex(4)
    me.name, me.status, me.max_visitors, me.proto = name, m.get("status", "available"), max_visitors, m["proto"]
    me.sim = {k: str(sim[k])[:40] for k in ("name", "version") if isinstance(sim.get(k), str)}
    me.world = m.get("world") is True
    me.links = m.get("links") is True
    me.chat = m.get("chat") is True
    OFFICES2[me.id], BY_NAME2[name.casefold()] = me, me.id
    welcome2(me, False)
    announce2()
    log.info("+ %s, visits (%d online)", me.name, len(OFFICES2))
    return me


def depart2(oid):
    """A session ends for good: its knocks are withdrawn and its visits end `gone`."""
    me = OFFICES2.pop(oid, None)
    if not me:
        return
    BY_NAME2.pop(me.name.casefold(), None)
    RESUMES2.pop(me.resume, None)
    if me.held:
        me.held.cancel()
    for kid, k in list(KNOCKS2.items()):
        if me.id not in (k["from"], k["to"]):
            continue
        KNOCKS2.pop(kid)
        k["timer"].cancel()
        if k["from"] == me.id and k["to"] in OFFICES2:
            tell2(OFFICES2[k["to"]], {"type": "knock_cancelled", "id": kid, "reason": "gone"})
        if k["to"] == me.id and k["from"] in OFFICES2:
            tell2(OFFICES2[k["from"]], answered(k, False, "gone"))
    for vid in [v["id"] for v in VISITS2.values() if me.id in (v["host"], v["visitor"])]:
        end_visit(vid, "gone")
    announce2()
    log.info("- %s, visits (%d online)", me.name, len(OFFICES2))


async def handler2(ws, raw):
    """A version-2 connection, from its first hello on. `bye` leaves at once; a dropped connection's
    session is held for the resume window."""
    me, probe = None, Office2(ws)
    try:
        for _ in range(HELLO_TRIES):
            m = parse2(probe, raw)
            if m is not None:
                if m["type"] != "hello":
                    error2(probe, "hello_first", "say hello first", m["type"])
                elif m.get("proto") not in PROTOS2:
                    error2(probe, "proto_unsupported", "this lobby speaks %s, %s and %s" % (PROTO, PROTO2, PROTO3), "hello")
                else:
                    me = hello2(ws, m)
                    if me:
                        break
            try:
                raw = await asyncio.wait_for(ws.recv(), HELLO_TIMEOUT)
            except asyncio.TimeoutError:
                error2(probe, "hello_timeout", "say hello within %d seconds" % HELLO_TIMEOUT)
                await ws.close(1008, "no hello")
                return
        else:
            await ws.close(1008, "too many tries")
            return
        async for raw in ws:
            m = parse2(me, raw)
            if m is None:
                continue
            if m["type"] == "bye":
                depart2(me.id)
                me = None
                await ws.close(1000, "bye")
                return
            if m["type"] == "hello":
                error2(me, "already_hello", "this connection is already in the lobby as %s" % me.name, "hello")
            elif m["type"] in HANDLERS2:
                HANDLERS2[m["type"]](me, m)
            else:
                error2(me, "unknown_type", "no message type %r" % m["type"], m["type"])
    except ConnectionClosed:
        pass
    finally:
        if me and me.ws is ws and me.id in OFFICES2:   # dropped, not resumed elsewhere: hold the session
            me.ws = None
            me.held = asyncio.get_running_loop().call_later(LIMITS2["resume"], depart2, me.id)
            log.info("? %s dropped; held %ds", me.name, LIMITS2["resume"])


def parse2(office, raw):
    try:
        m = json.loads(raw)
    except (ValueError, TypeError):
        error2(office, "bad_json", "a message is one JSON object")
        return None
    if not isinstance(m, dict) or not isinstance(m.get("type"), str):
        error2(office, "bad_message", "a message is a JSON object with a string `type`")
        return None
    return m


def is_v2(raw):
    try:
        m = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return isinstance(m, dict) and m.get("proto") in PROTOS2


def client_ip(ws):
    if TRUST_PROXY:
        fwd = ws.request.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return (ws.remote_address or ("?",))[0]


async def handler(ws):
    ip = client_ip(ws)
    if PER_IP[ip] >= LIMITS["connections_per_ip"]:
        await ws.send(json.dumps({"type": "error", "code": "too_many_connections",
                                  "message": "at most %d connections from one address" % LIMITS["connections_per_ip"]}))
        await ws.close(1008, "too many connections")
        return
    PER_IP[ip] += 1
    me = Office(ws, ip)
    try:
        for _ in range(HELLO_TRIES):
            try:
                raw = await asyncio.wait_for(ws.recv(), HELLO_TIMEOUT)
            except asyncio.TimeoutError:
                error(me, "hello_timeout", "say hello within %d seconds" % HELLO_TIMEOUT)
                await ws.close(1008, "no hello")
                return
            if is_v2(raw):   # a visit-client: the version-2 lobby takes this connection over
                return await handler2(ws, raw)
            if hello(me, raw):
                break
        else:
            await ws.close(1008, "too many tries")
            return
        async for raw in ws:
            m = parse(me, raw)
            if m is None:
                continue
            if m["type"] == "hello":
                error(me, "already_hello", "this connection is already in the lobby as %s" % me.name, "hello")
            elif m["type"] in HANDLERS:
                HANDLERS[m["type"]](me, m)
            else:
                error(me, "unknown_type", "no message type %r" % m["type"], m["type"])
    except ConnectionClosed:
        pass
    finally:
        PER_IP[ip] -= 1
        if not PER_IP[ip]:
            del PER_IP[ip]
        if me.id:
            depart(me)


def health(connection, request):
    """A plain GET /health answers 200, for the load balancer or a curl; everything else is the lobby."""
    if request.path == "/health":
        return connection.respond(200, "ok %d online\n" % (len(OFFICES) + len(OFFICES2)))
    return None


async def main():
    async with serve(handler, HOST, PORT, max_size=LIMITS["frame"], ping_interval=20, ping_timeout=20,
                     process_request=health) as server:
        log.info("%s listening on %s:%d", PROTO, HOST, PORT)
        await server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(main())
