#!/usr/bin/env python3
"""The lobby: who is online, knocks between offices, and the WebRTC signalling that lets the
offices in a group stream their rooms to each other. lobby/PROTOCOL.md is the contract; this is its
reference server. The video never passes through here: it goes peer to peer (or through the TURN relay
when a network blocks that), and this server only introduces the peers.

One process, all state in memory. A restart empties the lobby; every client reconnects and says hello
again. Nobody signs in: a client picks a name, first come first served, like IRC.

    python3 lobby.py     listens on LOBBY_HOST:LOBBY_PORT (default 0.0.0.0:8765), plain ws://.
                         In production Caddy terminates TLS in front of it (lobby/deploy/).

Environment:
    LOBBY_HOST, LOBBY_PORT   where to listen
    TRUST_PROXY=1            take the client's address from X-Forwarded-For (set behind Caddy only)
    STUN_URLS                comma-separated STUN urls handed to clients (default: Google's public one)
    TURN_URLS, TURN_SECRET   coturn's urls and its static-auth-secret. Each client gets TURN
                             credentials that expire (the TURN REST convention), never the secret.
    KNOCK_TTL                seconds a knock waits for an answer (default 60)
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
        return connection.respond(200, "ok %d online\n" % len(OFFICES))
    return None


async def main():
    async with serve(handler, HOST, PORT, max_size=LIMITS["frame"], ping_interval=20, ping_timeout=20,
                     process_request=health) as server:
        log.info("%s listening on %s:%d", PROTO, HOST, PORT)
        await server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(main())
