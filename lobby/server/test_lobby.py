#!/usr/bin/env python3
"""The lobby against PROTOCOL.md: every message type, every refusal, groups forming and ending. Runs
the real server in-process on a free local port and talks to it over WebSockets. No network beyond
localhost.

    python3 test_lobby.py       (needs `websockets`: pip install -r requirements.txt)
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lobby  # noqa: E402
from websockets.asyncio.client import connect  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

URL = None
fails = 0


class Client:
    """One test connection. expect() returns the next message of a type, skipping `lobby` snapshots
    unless asked for one; any other message first is a failure (the protocol's order is part of it)."""

    def __init__(self, ws):
        self.ws = ws

    async def send(self, **m):
        await self.ws.send(json.dumps(m))

    async def expect(self, type_, timeout=2.0):
        while True:
            m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
            if m["type"] == type_:
                return m
            if m["type"] != "lobby":
                raise AssertionError("wanted %s, got %s" % (type_, m))

    async def quiet(self, timeout=0.3):
        """Every message until the line goes quiet, `lobby` included."""
        out = []
        try:
            while True:
                out.append(json.loads(await asyncio.wait_for(self.ws.recv(), timeout)))
        except asyncio.TimeoutError:
            return out

    async def close(self):
        await self.ws.close()


async def join(name, **extra):
    c = Client(await connect(URL))
    await c.send(type="hello", proto=lobby.PROTO, name=name, sim={"name": "test", "version": "1"}, **extra)
    c.welcome = await c.expect("welcome")
    c.id = c.welcome["id"]
    await c.quiet()
    return c


async def raw_client():
    return Client(await connect(URL))


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("%s  %s%s" % ("ok  " if ok else "FAIL", label, "" if ok else "\n      got  %r\n      want %r" % (got, want)))


async def together(a, b, msg="hi"):
    """a knocks on b, b lets it in; returns b's knock message. Drains both."""
    await a.send(type="knock", to=b.id, message=msg)
    await a.expect("knock_sent")
    k = await b.expect("knock")
    await b.send(type="answer", knock=k["id"], accept=True)
    await a.expect("answered")
    await a.quiet()
    await b.quiet()
    return k


# ---------- cases ----------
async def t_hello():
    a = Client(await connect(URL))
    await a.send(type="hello", proto=lobby.PROTO, name="Ada", sim={"name": "my-workroom", "version": "1.0", "x": "dropped"})
    w = await a.expect("welcome")
    check("welcome names the protocol, an id, the name", (w["proto"], w["id"][:1], w["name"]), (lobby.PROTO, "o", "Ada"))
    check("welcome hands out STUN servers and the limits", (bool(w["ice_servers"]), w["limits"]["message"]), (True, 280))
    lob = await a.expect("lobby")
    check("the lobby snapshot follows, with the office in it",
          [(o["name"], o["status"], o["sim"], o["group"]) for o in lob["offices"]],
          [("Ada", "available", {"name": "my-workroom", "version": "1.0"}, None)])
    await a.close()


async def t_hello_rules():
    c = await raw_client()
    await c.send(type="status", status="busy")
    check("anything before hello is refused", (await c.expect("error"))["code"], "hello_first")
    await c.send(type="hello", proto="basedverse-lobby/0", name="Ok")
    check("another protocol is refused", (await c.expect("error"))["code"], "proto_unsupported")
    for bad in ("", "-dash", "two\nlines"):   # with the two above: the HELLO_TRIES failed hellos allowed
        await c.send(type="hello", proto=lobby.PROTO, name=bad)
        check("name %r is invalid" % bad, (await c.expect("error"))["code"], "name_invalid")
    try:
        await c.expect("error")
        check("after %d failed hellos the connection is closed" % lobby.HELLO_TRIES, "open", "closed")
    except ConnectionClosed as e:
        check("after %d failed hellos the connection is closed" % lobby.HELLO_TRIES, e.rcvd.reason, "too many tries")
    c = await raw_client()
    await c.send(type="hello", proto=lobby.PROTO, name="x" * 25)
    check("a name over 24 characters is invalid", (await c.expect("error"))["code"], "name_invalid")
    await c.close()
    taken = await join("Grace")
    c = await raw_client()
    await c.send(type="hello", proto=lobby.PROTO, name="grace")
    check("a name is taken whatever its case", (await c.expect("error"))["code"], "name_taken")
    await c.send(type="hello", proto=lobby.PROTO, name="Grace 2")
    check("another try on the same connection gets in", (await c.expect("welcome"))["name"], "Grace 2")
    await c.send(type="hello", proto=lobby.PROTO, name="Again")
    check("a second hello is refused", (await c.expect("error"))["code"], "already_hello")
    await c.send(type="nope")
    check("an unknown type is refused", (await c.expect("error"))["code"], "unknown_type")
    await c.ws.send("{not json")
    check("bad JSON is refused", (await c.expect("error"))["code"], "bad_json")
    await c.close()
    await taken.close()


async def t_status_and_knock_refusals():
    a, b = await join("A1"), await join("B1")
    await b.send(type="status", status="busy")
    lob = (await a.quiet())[-1]
    check("a status change reaches everyone", {o["name"]: o["status"] for o in lob["offices"]}, {"A1": "available", "B1": "busy"})
    await a.send(type="knock", to=b.id, message="hi")
    check("a busy office cannot be knocked on", (await a.expect("error"))["code"], "not_available")
    await a.send(type="knock", to=a.id)
    check("nor can yourself", (await a.expect("error"))["code"], "self_knock")
    await a.send(type="knock", to="o-none")
    check("nor an office that is not there", (await a.expect("error"))["code"], "not_found")
    await b.send(type="status", status="available")
    await a.quiet()
    await a.send(type="knock", to=b.id, message="x" * 281)
    check("a message over 280 characters is refused", (await a.expect("error"))["code"], "message_too_long")
    await a.send(type="status", status="asleep")
    check("an unknown status is refused", (await a.expect("error"))["code"], "bad_message")
    await a.close()
    await b.close()


async def t_knock_accept_signal():
    a, b, c = await join("A2"), await join("B2"), await join("C2")
    await a.send(type="knock", to=b.id, message="can I see your office?")
    sent = await a.expect("knock_sent")
    k = await b.expect("knock")
    check("the knock reaches its door with who and what", (k["id"], k["from"]["name"], k["message"], k["expires_in"]),
          (sent["id"], "A2", "can I see your office?", lobby.LIMITS["knock_ttl"]))
    await a.send(type="knock", to=b.id, message="again")
    check("a second knock while the first waits is refused", (await a.expect("error"))["code"], "knock_pending")
    await c.send(type="answer", knock=k["id"], accept=True)
    check("only its door answers a knock", (await c.expect("error"))["code"], "not_yours")
    await b.send(type="answer", knock=k["id"], accept=True, message="come in")
    ans = await a.expect("answered")
    check("the knocker hears yes", (ans["accept"], ans["message"]), (True, "come in"))
    ga, gb = await a.expect("group"), await b.expect("group")
    check("both get the group, the door first", ([m["name"] for m in ga["members"]], ga["id"] == gb["id"]), (["B2", "A2"], True))
    lob = (await c.quiet())[-1]
    check("the lobby shows them together", len({o["group"] for o in lob["offices"] if o["name"] in ("A2", "B2")}), 1)
    await a.send(type="signal", to=b.id, data={"sdp": {"type": "offer", "sdp": "v=0"}})
    s = await b.expect("signal")
    check("a signal goes to a group member, marked from", (s["from"], s["data"]["sdp"]["type"]), (a.id, "offer"))
    await a.send(type="signal", to=c.id, data={"candidate": {}})
    check("never to an office outside the group", (await a.expect("error"))["code"], "not_in_group")
    await a.send(type="signal", to=b.id, data="text")
    check("signal data is an object", (await a.expect("error"))["code"], "bad_message")
    await a.send(type="knock", to=b.id)
    check("no knocking on your own group", (await a.expect("error"))["code"], "already_together")
    # C joins through A: everyone in the group sees everyone.
    await c.send(type="knock", to=a.id, message="me too")
    await c.expect("knock_sent")
    k2 = await a.expect("knock")
    await a.send(type="answer", knock=k2["id"], accept=True)
    await c.expect("answered")
    groups = [await x.expect("group") for x in (a, b, c)]
    check("any member lets a third in, and all three see all three",
          [[m["name"] for m in g["members"]] for g in groups], [["B2", "A2", "C2"]] * 3)
    await c.send(type="leave")
    check("leaving: the leaver's group is none", (await c.expect("group"))["id"], None)
    check("the rest go on as two", [m["name"] for m in (await b.expect("group"))["members"]], ["B2", "A2"])
    await a.close()
    check("a group left with one office ends", (await b.expect("group"))["id"], None)
    await b.close()
    await c.close()


async def t_busy_group():
    a, b, c, d = await join("A6"), await join("B6"), await join("C6"), await join("D6")
    await together(b, a)
    await c.send(type="knock", to=b.id, message="before")   # waits on B while everyone is available
    await c.expect("knock_sent")
    early = await b.expect("knock")
    await d.send(type="knock", to=a.id)                      # and one on A's own door
    await d.expect("knock_sent")
    own = await a.expect("knock")
    await a.send(type="status", status="busy")
    await a.quiet()
    await c.quiet()
    await c.send(type="knock", to=b.id)
    err = await c.expect("error")
    check("an office in a group with a busy one cannot be knocked on", (err["code"], "A6" in err["message"]), ("not_available", True))
    await b.send(type="answer", knock=early["id"], accept=True)
    check("nor can a knock from before be let in", (await b.expect("error"))["code"], "not_available")
    ans = await c.expect("answered")
    check("the knocker hears no, because of a busy office", (ans["accept"], ans["reason"]), (False, "busy"))
    check("the group stays as it was", (lobby.OFFICES[c.id].group, len(lobby.GROUPS[lobby.OFFICES[a.id].group])), (None, 2))
    await d.quiet()
    await a.send(type="answer", knock=own["id"], accept=True)
    await d.expect("answered")
    check("the busy office itself may still let in a knock on its own door",
          [m["name"] for m in (await d.expect("group"))["members"]], ["A6", "B6", "D6"])
    for x in (a, b, c, d):
        await x.close()


async def t_decline_timeout_gone():
    a, b = await join("A3"), await join("B3")
    await a.send(type="knock", to=b.id, message="hello?")
    await a.expect("knock_sent")
    k = await b.expect("knock")
    await b.send(type="answer", knock=k["id"], accept=False, message="not now")
    ans = await a.expect("answered")
    check("a no, with its reason and message", (ans["accept"], ans["reason"], ans["message"]), (False, "declined", "not now"))
    await b.send(type="answer", knock=k["id"], accept=True)
    check("an answered knock cannot be answered again", (await b.expect("error"))["code"], "not_found")
    lobby.LIMITS["knock_ttl"] = 1
    try:
        await a.send(type="knock", to=b.id)
        await a.expect("knock_sent")
        k = await b.expect("knock")
        ans = await a.expect("answered", timeout=3)
        check("an unanswered knock times out for the knocker", (ans["accept"], ans["reason"]), (False, "timeout"))
        cancel = await b.expect("knock_cancelled", timeout=3)
        check("and is withdrawn from the door", (cancel["id"], cancel["reason"]), (k["id"], "timeout"))
    finally:
        lobby.LIMITS["knock_ttl"] = 60
    await a.send(type="knock", to=b.id)
    await a.expect("knock_sent")
    k = await b.expect("knock")
    await a.close()
    cancel = await b.expect("knock_cancelled")
    check("a knocker that leaves withdraws its knock", (cancel["id"], cancel["reason"]), (k["id"], "gone"))
    a = await join("A3")
    await a.send(type="knock", to=b.id)
    await a.expect("knock_sent")
    await b.expect("knock")
    await b.close()
    ans = await a.expect("answered")
    check("a door that leaves answers its knocks `gone`", (ans["accept"], ans["reason"]), (False, "gone"))
    await a.close()


async def t_limits():
    a, b = await join("A4"), await join("B4")
    for _ in range(lobby.LIMITS["knocks_per_minute"]):
        await a.send(type="knock", to=b.id)
        await a.expect("knock_sent")
        k = await b.expect("knock")
        await b.send(type="answer", knock=k["id"], accept=False)
        await a.expect("answered")
    await a.send(type="knock", to=b.id)
    check("more knocks than the minute allows are refused", (await a.expect("error"))["code"], "rate_limited")
    c, d = await join("C4"), await join("D4")
    saved = lobby.LIMITS["group"]
    lobby.LIMITS["group"] = 2
    try:
        await together(c, d)
        await b.send(type="knock", to=c.id)
        check("a full group cannot be knocked on", (await b.expect("error"))["code"], "group_full")
    finally:
        lobby.LIMITS["group"] = saved
    try:
        await a.ws.send(json.dumps({"type": "status", "status": "busy", "pad": "x" * lobby.LIMITS["frame"]}))
        await a.expect("error")
        check("a message over the frame limit closes the connection", "still open", "closed (1009)")
    except ConnectionClosed as e:
        check("a message over the frame limit closes the connection", "closed (%d)" % e.rcvd.code, "closed (1009)")
    saved = lobby.LIMITS["connections_per_ip"]
    await asyncio.sleep(0.2)   # the server's cleanup of the connection it just closed
    lobby.LIMITS["connections_per_ip"] = lobby.PER_IP["127.0.0.1"]   # every connection here is from 127.0.0.1
    try:
        e = await raw_client()
        check("too many connections from one address are refused", (await e.expect("error"))["code"], "too_many_connections")
    finally:
        lobby.LIMITS["connections_per_ip"] = saved
    for x in (b, c, d):
        await x.close()


async def t_turn_and_health():
    lobby.TURN_URLS, lobby.TURN_SECRET = ["turn:203.0.113.5:3478"], "s3cret"
    try:
        a = await join("A5")
        turn = [s for s in a.welcome["ice_servers"] if s.get("username")]
        want = base64.b64encode(hmac.new(b"s3cret", turn[0]["username"].encode(), hashlib.sha1).digest()).decode() if turn else None
        check("TURN credentials expire, name the office, and are the HMAC coturn checks",
              (len(turn), turn[0]["username"].split(":")[1] if turn else None, turn[0]["credential"] if turn else None),
              (1, a.id, want))
        check("the TURN secret itself is never sent", "s3cret" in json.dumps(a.welcome), False)
        await a.close()
    finally:
        lobby.TURN_URLS, lobby.TURN_SECRET = [], ""
    # In a thread: the server answers on this same event loop.
    body = (await asyncio.to_thread(lambda: urllib.request.urlopen(URL.replace("ws://", "http://") + "/health", timeout=2).read())).decode()
    check("GET /health answers", body.startswith("ok "), True)


async def main():
    global URL
    async with serve(lobby.handler, "127.0.0.1", 0, max_size=lobby.LIMITS["frame"], process_request=lobby.health) as server:
        URL = "ws://127.0.0.1:%d" % server.sockets[0].getsockname()[1]
        for t in (t_hello, t_hello_rules, t_status_and_knock_refusals, t_knock_accept_signal, t_busy_group,
                  t_decline_timeout_gone, t_limits, t_turn_and_health):
            print("\n" + t.__name__[2:])
            try:
                await t()
            except Exception as e:
                global fails
                fails += 1
                print("FAIL  %s raised %s: %s" % (t.__name__, type(e).__name__, e))
            await asyncio.sleep(0.2)
        check("\nevery office left the lobby", (len(lobby.OFFICES), len(lobby.GROUPS), len(lobby.KNOCKS)), (0, 0, 0))
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
