#!/usr/bin/env python3
"""The lobby's version 2 (visit-clients, ../../visit/SPEC.md section 6): sessions, links, knocks, visits,
resuming a dropped session, and its separation from version 1. Runs the real server in-process on a free
local port and talks to it over WebSockets. No network beyond localhost.

    python3 test_lobby2.py       (needs `websockets`: pip install -r requirements.txt)
"""
import asyncio
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
P2 = lobby.PROTO2


class Client:
    """One test connection. expect() returns the next message of a type, skipping `lobby` snapshots unless
    asked for one; any other message first is a failure (the protocol's order is part of it)."""

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
        out = []
        try:
            while True:
                out.append(json.loads(await asyncio.wait_for(self.ws.recv(), timeout)))
        except asyncio.TimeoutError:
            return out

    async def last_lobby(self):
        return [m for m in await self.quiet() if m["type"] == "lobby"][-1]

    async def close(self):
        await self.ws.close()


async def join(name, link=True, proto=None, **extra):
    """A version-2 office (or `proto`'s), its link published unless link=False."""
    c = Client(await connect(URL))
    await c.send(type="hello", proto=proto or P2, name=name, sim={"name": "test", "version": "1"}, **extra)
    c.welcome = await c.expect("welcome")
    c.id, c.name = c.welcome["id"], name
    if link:
        c.link = {"endpoint": "ep-" + name, "addr": {"relay": "https://relay.test/", "direct": ["192.0.2.1:7"]}}
        await c.send(type="link", **c.link)
    await c.quiet()
    return c


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("%s  %s%s" % ("ok  " if ok else "FAIL", label, "" if ok else "\n      got  %r\n      want %r" % (got, want)))


async def visit(visitor, host, msg="hi"):
    """visitor knocks on host, host lets it in; returns (visitor's visit, host's visit). Drains both."""
    await visitor.send(type="knock", to=host.id, message=msg)
    await visitor.expect("knock_sent")
    k = await host.expect("knock")
    await host.send(type="answer", knock=k["id"], accept=True)
    await visitor.expect("answered")
    vv, hv = await visitor.expect("visit"), await host.expect("visit")
    await visitor.quiet()
    await host.quiet()
    return vv, hv


def office(lob, name):
    return next(o for o in lob["offices"] if o["name"] == name)


# ---------- cases ----------
async def t_hello():
    a = Client(await connect(URL))
    await a.send(type="hello", proto=P2, name="Ada", sim={"name": "my-workroom", "version": "2", "x": "dropped"}, max_visitors=2)
    w = await a.expect("welcome")
    check("welcome: the protocol, an id, the name, relays, a resume secret, not resumed",
          (w["proto"], w["id"][:1], w["name"], w["relays"], len(w["resume"]), w["resumed"]), (P2, "o", "Ada", [], 32, False))
    check("and the limits", (w["limits"]["max_visitors"], w["limits"]["resume"]), (8, lobby.LIMITS2["resume"]))
    lob = await a.expect("lobby")
    check("the lobby lists it, not ready until it publishes its link",
          [(o["name"], o["max_visitors"], o["visitors"], o["visiting"], o["ready"], o["sim"]) for o in lob["offices"]],
          [("Ada", 2, 0, None, False, {"name": "my-workroom", "version": "2"})])
    await a.send(type="link", endpoint="ep-ada", addr="not an object")
    check("a link needs an addr object", (await a.expect("error"))["code"], "bad_message")
    await a.send(type="link", endpoint="ep-ada", addr={"pad": "x" * 3000})
    check("and a small one", (await a.expect("error"))["code"], "bad_message")
    await a.send(type="link", endpoint="ep-ada", addr={"relay": "https://relay.test/"})
    check("a good link makes it ready", office(await a.last_lobby(), "Ada")["ready"], True)
    await a.send(type="max_visitors", n=9)
    check("max_visitors is 0 to 8", (await a.expect("error"))["code"], "bad_message")
    await a.close()


async def t_hello_rules_and_separation():
    c = Client(await connect(URL))
    await c.send(type="hello", proto=P2, name="-bad")
    check("an invalid name is refused", (await c.expect("error"))["code"], "name_invalid")
    taken = await join("Grace")
    await c.send(type="hello", proto=P2, name="grace")
    check("a name is taken whatever its case", (await c.expect("error"))["code"], "name_taken")
    await c.send(type="hello", proto=P2, name="Grace 2", max_visitors=True)
    check("max_visitors must be a number", (await c.expect("error"))["code"], "bad_message")
    await c.close()
    # A version-1 office named Grace: a separate lobby, so the name is free there, and neither sees the other.
    v1 = Client(await connect(URL))
    await v1.send(type="hello", proto=lobby.PROTO, name="Grace")
    await v1.expect("welcome")
    lob1 = await v1.expect("lobby")
    check("version 1 does not see version 2", [o["name"] for o in lob1["offices"]], ["Grace"])
    await taken.send(type="status", status="available")
    lob2 = await taken.expect("lobby")
    check("nor version 2 version 1", [o["name"] for o in lob2["offices"]], ["Grace"])
    check("the same name in both, each its own office", lob1["offices"][0]["id"] != lob2["offices"][0]["id"], True)
    await v1.close()
    await taken.close()


async def t_knock_refusals():
    a, b = await join("A2"), await join("B2")
    n = await join("N2", link=False)
    await a.send(type="knock", to="o-none")
    check("knocking on nobody", (await a.expect("error"))["code"], "not_found")
    await a.send(type="knock", to=a.id)
    check("on yourself", (await a.expect("error"))["code"], "self_knock")
    await a.send(type="knock", to=n.id)
    check("on an office with no link yet", (await a.expect("error"))["code"], "not_ready")
    await n.send(type="knock", to=a.id)
    check("or with none of your own", (await n.expect("error"))["code"], "not_ready")
    await b.send(type="status", status="busy")
    await a.quiet()
    await a.send(type="knock", to=b.id)
    check("on a busy office", (await a.expect("error"))["code"], "not_available")
    await b.send(type="status", status="available")
    await b.send(type="max_visitors", n=0)
    await a.quiet()
    await a.send(type="knock", to=b.id)
    check("on an office that takes no visitors (or has all it takes)", (await a.expect("error"))["code"], "full")
    await b.send(type="max_visitors", n=3)
    await a.quiet()
    await a.send(type="knock", to=b.id, message="x" * 281)
    check("a message over 280 characters", (await a.expect("error"))["code"], "message_too_long")
    await a.send(type="knock", to=b.id)
    await a.expect("knock_sent")
    await a.send(type="knock", to=b.id)
    check("a second knock while the first waits", (await a.expect("error"))["code"], "knock_pending")
    for x in (a, b, n):
        await x.close()


async def t_visit():
    a, b, c = await join("A3"), await join("B3"), await join("C3")
    await a.send(type="knock", to=b.id, message="can I walk around?")
    sent = await a.expect("knock_sent")
    k = await b.expect("knock")
    check("the knock reaches the door", (k["id"], k["from"]["name"], k["message"]), (sent["id"], "A3", "can I walk around?"))
    await c.send(type="answer", knock=k["id"], accept=True)
    check("only its door answers it", (await c.expect("error"))["code"], "not_yours")
    await b.send(type="answer", knock=k["id"], accept=True, message="come in")
    ans = await a.expect("answered")
    check("the knocker hears yes", (ans["accept"], ans["message"]), (True, "come in"))
    va, vb = await a.expect("visit"), await b.expect("visit")
    check("both get the visit: one id, one ticket, each its role and the other",
          (va["id"] == vb["id"], va["ticket"] == vb["ticket"], len(va["ticket"]), va["role"], vb["role"], va["peer"]["name"], vb["peer"]["name"]),
          (True, True, 32, "visitor", "host", "B3", "A3"))
    check("each gets the other's link, to dial or to check the dialler against",
          (va["peer_link"], vb["peer_link"]), (b.link, a.link))
    lob = await c.last_lobby()
    check("the lobby shows who is visiting whom", (office(lob, "A3")["visiting"], office(lob, "B3")["visitors"]), (b.id, 1))
    await a.send(type="knock", to=b.id)
    check("no knocking on the room you are in", (await a.expect("error"))["code"], "already_visiting")
    # A visitor going into another room leaves the first: told so before it hears of the new visit.
    await a.send(type="knock", to=c.id)
    await a.expect("knock_sent")
    k = await c.expect("knock")
    await c.send(type="answer", knock=k["id"], accept=True)
    await a.expect("answered")
    moved = await a.expect("visit_ended")
    await a.expect("visit")
    await c.expect("visit")
    ended = await b.expect("visit_ended")
    check("going into another room ends the visit to the first, `moved`, for both",
          (moved["reason"], ended["reason"], ended["id"]), ("moved", "moved", vb["id"]))
    await a.quiet()
    await a.send(type="end", visit="v-none")
    check("ending a visit you are not in", (await a.expect("error"))["code"], "no_such_visit")
    await b.quiet()
    await c.quiet()
    await visit(b, c)   # c hosts a and b
    await c.send(type="status", status="available")
    check("a host's visitors count", office(await c.expect("lobby"), "C3")["visitors"], 2)
    for x in (a, b, c):
        await x.close()


async def t_end_and_full():
    h, v1, v2 = await join("H4"), await join("V4a"), await join("V4b")
    vv, hv = await visit(v1, h)
    await v1.send(type="end", visit=vv["id"], reason="sideways")
    check("an end reason must be one of left, kicked, link_failed", (await v1.expect("error"))["code"], "bad_message")
    await v1.send(type="end", visit=vv["id"])
    e1, e2 = await v1.expect("visit_ended"), await h.expect("visit_ended")
    check("the visitor leaving: `left`, to both", (e1["reason"], e2["reason"], e1["id"]), ("left", "left", vv["id"]))
    vv, hv = await visit(v1, h)
    await h.send(type="end", visit=hv["id"])
    check("the host ending it: `kicked`", ((await v1.expect("visit_ended"))["reason"], (await h.expect("visit_ended"))["reason"]), ("kicked", "kicked"))
    vv, hv = await visit(v1, h)
    await v1.send(type="end", visit=vv["id"], reason="link_failed")
    check("a link that could not be made: `link_failed`", (await h.expect("visit_ended"))["reason"], "link_failed")
    # The door fills up between a knock and its answer.
    await v2.send(type="knock", to=h.id)
    await v2.expect("knock_sent")
    k = await h.expect("knock")
    await h.send(type="max_visitors", n=0)
    await h.send(type="answer", knock=k["id"], accept=True)
    check("letting in past max_visitors: the knocker hears `full`", (await v2.expect("answered"))["reason"], "full")
    check("and the host an error", (await h.expect("error"))["code"], "full")
    for x in (h, v1, v2):
        await x.close()


async def t_resume():
    a, b = await join("A5"), await join("B5")
    vv, hv = await visit(a, b)
    secret = a.welcome["resume"]
    await a.ws.close()   # dropped
    await asyncio.sleep(0.2)
    await b.send(type="status", status="available")
    lob = await b.expect("lobby")
    check("a dropped session stays listed, still visiting", office(lob, "A5")["visiting"], b.id)
    c = await join("C5")
    await c.send(type="knock", to=a.id, message="while you were out")
    await c.expect("knock_sent")
    r = Client(await connect(URL))
    await r.send(type="hello", proto=P2, name="ignored on resume", resume=secret)
    w = await r.expect("welcome")
    check("resuming: the same office, a new secret, resumed", (w["id"], w["name"], w["resumed"], w["resume"] != secret), (a.id, "A5", True, True))
    await r.expect("lobby")
    k = await r.expect("knock")
    check("a knock that came while it was out is waiting for it", (k["from"]["name"], k["message"]), ("C5", "while you were out"))
    await r.send(type="end", visit=vv["id"])
    check("its visit is still there to end", (await b.expect("visit_ended"))["reason"], "left")
    # The old secret is spent.
    x = Client(await connect(URL))
    await x.send(type="hello", proto=P2, name="Thief", resume=secret)
    w2 = await x.expect("welcome")
    check("a spent secret resumes nothing: a new session", (w2["resumed"], w2["id"] != a.id, w2["name"]), (False, True, "Thief"))
    await x.close()
    # Resuming while the old connection is still open (the server has not noticed it died): it is closed.
    await r.quiet()
    r2 = Client(await connect(URL))
    await r2.send(type="hello", proto=P2, resume=w["resume"])
    await r2.expect("welcome")
    try:
        while True:
            await asyncio.wait_for(r.ws.recv(), 1)
    except ConnectionClosed as e:
        check("the stale connection is closed when its session resumes elsewhere", e.rcvd.code if e.rcvd else None, 4000)
    except asyncio.TimeoutError:
        check("the stale connection is closed when its session resumes elsewhere", "open", "closed")
    for y in (b, c, r2):
        await y.close()


async def t_resume_replays_visits():
    a, b = await join("A8"), await join("B8")
    await b.send(type="knock", to=a.id)
    await b.expect("knock_sent")
    k = await a.expect("knock")
    secret = b.welcome["resume"]
    await b.ws.close()   # away just as its knock is answered
    await asyncio.sleep(0.2)
    await a.send(type="answer", knock=k["id"], accept=True)
    va = await a.expect("visit")
    r = Client(await connect(URL))
    await r.send(type="hello", proto=P2, resume=secret)
    w = await r.expect("welcome")
    check("a resumed welcome lists the session's visits", w["visits"], [va["id"]])
    check("and its own knocks still waiting (none: this one was answered)", w["knocking"], [])
    vb = await r.expect("visit")
    check("and a visit agreed while it was away is told to it", (vb["id"], vb["role"], vb["ticket"] == va["ticket"], vb["peer_link"]), (va["id"], "visitor", True, a.link))
    for x in (a, r):
        await x.close()


async def t_rename():
    a, b = await join("A9"), await join("B9")
    await a.send(type="rename", name="b9")
    check("renaming to a taken name: refused", (await a.expect("error"))["code"], "name_taken")
    await a.send(type="status", status="available")
    check("and the office keeps its own name", office(await a.expect("lobby"), "A9")["id"], a.id)
    await a.send(type="rename", name="-bad")
    check("renaming to an invalid name: refused", (await a.expect("error"))["code"], "name_invalid")
    await a.send(type="rename", name="A9 New")
    lob = await b.last_lobby()
    check("renaming to a free name: everyone sees it, the same office", (office(lob, "A9 New")["id"], [o["name"] for o in lob["offices"]]), (a.id, ["A9 New", "B9"]))
    c = await join("A9")
    check("and the old name is free again", c.welcome["name"], "A9")
    for x in (a, b, c):
        await x.close()


async def t_resume_window_and_bye():
    saved = lobby.LIMITS2["resume"]
    lobby.LIMITS2["resume"] = 1
    try:
        a, b = await join("A6"), await join("B6")
        await visit(a, b)
        await b.send(type="knock", to=a.id)   # b, visited by a, knocks on a too (a visit the other way)
        await b.expect("knock_sent")
        await a.expect("knock")
        await a.ws.close()
        ans = await b.expect("answered", timeout=3)
        check("past the resume window the session ends: knocks on it are answered `gone`", (ans["accept"], ans["reason"]), (False, "gone"))
        e = await b.expect("visit_ended", timeout=1)
        check("and its visits end `gone`", e["reason"], "gone")
        lob = await b.last_lobby()
        check("and it leaves the lobby", [o["name"] for o in lob["offices"]], ["B6"])
        c = await join("C6")
        await visit(c, b)
        await c.send(type="bye")
        check("bye: gone at once, not held", (await b.expect("visit_ended", timeout=0.5))["reason"], "gone")
        await b.close()
    finally:
        lobby.LIMITS2["resume"] = saved


async def t_knock_timeout_and_health():
    saved = lobby.LIMITS2["knock_ttl"]
    lobby.LIMITS2["knock_ttl"] = 1
    try:
        a, b = await join("A7"), await join("B7")
        await a.send(type="knock", to=b.id)
        await a.expect("knock_sent")
        k = await b.expect("knock")
        ans = await a.expect("answered", timeout=3)
        check("an unanswered knock times out", (ans["accept"], ans["reason"]), (False, "timeout"))
        check("and is withdrawn from the door", (await b.expect("knock_cancelled", timeout=3))["id"], k["id"])
        body = (await asyncio.to_thread(lambda: urllib.request.urlopen(URL.replace("ws://", "http://") + "/health", timeout=2).read())).decode()
        check("GET /health counts version-2 offices too", body.strip(), "ok 2 online")
        await a.send(type="bye")
        await b.send(type="bye")
    finally:
        lobby.LIMITS2["knock_ttl"] = saved


async def t_version_3():
    """basedverse-lobby/3 (Visit 0.5, three.js rooms only): a lobby of its own; a link withdrawn and published
    again (its page stopped hosting, and started again)."""
    old = await join("Old")
    a, b = await join("Neu A", proto=lobby.PROTO3), await join("Neu B", proto=lobby.PROTO3)
    check("a version-3 office is welcomed as such", a.welcome["proto"], lobby.PROTO3)
    await a.send(type="status", status="available")
    lob = await a.last_lobby()
    check("version 3 sees only version 3", sorted(o["name"] for o in lob["offices"]), ["Neu A", "Neu B"])
    await old.send(type="status", status="available")
    lob = await old.last_lobby()
    check("and version 2 only version 2", [o["name"] for o in lob["offices"]], ["Old"])
    await old.send(type="knock", to=a.id)
    check("a knock across: there is no such office", (await old.expect("error"))["code"], "not_found")
    await a.send(type="link", endpoint=None, addr=None)
    lob = await b.last_lobby()
    check("a link withdrawn: not ready", office(lob, "Neu A")["ready"], False)
    await b.send(type="knock", to=a.id)
    check("and not knockable", (await b.expect("error"))["code"], "not_ready")
    await a.send(type="knock", to=b.id)
    check("nor can it knock", (await a.expect("error"))["code"], "not_ready")
    await a.send(type="link", **a.link)
    check("published again: ready", office(await b.last_lobby(), "Neu A")["ready"], True)
    await b.send(type="knock", to=a.id)
    await b.expect("knock_sent")
    k = await a.expect("knock")
    await a.send(type="link", endpoint=None, addr=None)
    await a.quiet()
    await a.send(type="answer", knock=k["id"], accept=True)
    check("letting in after withdrawing its link: refused, not_ready", (await a.expect("error"))["code"], "not_ready")
    check("and the knocker told", ((await b.expect("answered"))["reason"]), "not_ready")
    for c in (old, a, b):
        await c.send(type="bye")


async def t_keys():
    """Each office's key (the endpoint it publishes: Visit 0.7's lasting identity) in the lobby and on its knocks,
    for a host's guest list; kept while its link is withdrawn. Additions: version 3 as it was."""
    a, b = await join("Key A", proto=lobby.PROTO3), await join("Key B", proto=lobby.PROTO3)
    nolink = await join("Key C", link=False, proto=lobby.PROTO3)
    lob = await a.last_lobby()
    check("each office's key in the lobby: its endpoint, or null before it has published one",
          [(o["name"], o["key"]) for o in lob["offices"]], [("Key A", "ep-Key A"), ("Key B", "ep-Key B"), ("Key C", None)])
    await a.send(type="link", endpoint=None, addr=None)
    lob = await b.last_lobby()
    check("a link withdrawn: not ready, but still its key", (office(lob, "Key A")["ready"], office(lob, "Key A")["key"]), (False, "ep-Key A"))
    await a.send(type="link", **a.link)
    await b.quiet()
    await a.send(type="knock", to=b.id)
    await a.expect("knock_sent")
    k = await b.expect("knock")
    check("a knock says whose key it is", k["from"]["key"], "ep-Key A")
    for c in (a, b, nolink):
        await c.send(type="bye")


async def t_watch():
    """Watches (Visit 0.7's world): a knock with watch: true, to see a plot from outside it. Counted apart from
    visits, never moving the watcher out of the room it is in, not stopped by busy; errors say ref: watch."""
    a, b, c = (await join("W A", proto=lobby.PROTO3, world=True), await join("W B", proto=lobby.PROTO3, world=True), await join("W C", proto=lobby.PROTO3, world=True))
    old = await join("W Old", proto=lobby.PROTO3)
    await a.send(type="knock", to=old.id, watch=True)
    e = await a.expect("error")
    lob = await c.last_lobby()
    check("an office that did not say world (an older Visit) cannot be watched: not_supported, never asked",
          (e["code"], e.get("ref"), office(lob, "W Old")["world"], office(lob, "W A")["world"]), ("not_supported", "watch", False, True))
    await old.send(type="bye")
    await a.send(type="knock", to=c.id)
    await a.expect("knock_sent")
    await c.send(type="answer", knock=(await c.expect("knock"))["id"], accept=True)
    await a.expect("answered")
    vv = await a.expect("visit")
    await a.quiet()
    await c.quiet()
    await b.send(type="status", status="busy")
    await b.quiet()
    await a.send(type="knock", to=b.id, watch=True)
    sent = await a.expect("knock_sent")
    k = await b.expect("knock")
    check("a knock to watch: says so both ways (and busy does not stop it)", (sent.get("watch"), k.get("watch"), k["from"]["key"]), (True, True, "ep-W A"))
    await b.send(type="answer", knock=k["id"], accept=True)
    ans = await a.expect("answered")
    wa, wb = await a.expect("visit"), await b.expect("visit")
    check("let in: a watch, both told so, the watcher's room visit untouched",
          (ans["accept"], ans.get("watch"), wa.get("watch"), wb.get("watch"), wa["role"], wb["role"], lobby.OFFICES2[a.id].visiting == vv["id"]),
          (True, True, True, True, "visitor", "host", True))
    lob = await c.last_lobby()
    check("the lobby counts watchers apart from visitors", (office(lob, "W B")["watchers"], office(lob, "W B")["visitors"], office(lob, "W C")["visitors"]), (1, 0, 1))
    await a.send(type="knock", to=b.id, watch=True)
    e = await a.expect("error")
    check("watching the same plot twice: already_watching, ref watch", (e["code"], e.get("ref")), ("already_watching", "watch"))
    await c.send(type="knock", to=b.id, watch=True)
    await c.expect("knock_sent")
    k = await b.expect("knock")
    await b.send(type="answer", knock=k["id"], accept=False)
    ans = await c.expect("answered")
    check("a watch declined: the knocker told, a watch's answer", (ans["accept"], ans.get("reason"), ans.get("watch")), (False, "declined", True))
    await a.send(type="end", visit=wa["id"])
    e1, e2 = await a.expect("visit_ended"), await b.expect("visit_ended")
    check("a watch ends like a visit", (e1["id"], e2["id"], e1["reason"]), (wa["id"], wa["id"], "left"))
    check("and the lobby forgets it", (len(lobby.OFFICES2[b.id].watched), len(lobby.OFFICES2[a.id].watching)), (0, 0))
    for c_ in (a, b, c):
        await c_.send(type="bye")


async def t_link():
    """Links (Visit 0.8): a knock with link: true, answered by its door as any knock, that starts a watch (the
    knocker sees the room in a corner, and may step in). To a door that does not take links, an ordinary knock."""
    a, b = await join("L A", proto=lobby.PROTO3, world=True, links=True), await join("L B", proto=lobby.PROTO3, world=True, links=True)
    old = await join("L Old", proto=lobby.PROTO3, world=True)
    lob = await a.last_lobby()
    check("the lobby says who takes links", (office(lob, "L B")["links"], office(lob, "L Old")["links"]), (True, False))
    await b.send(type="status", status="busy")
    await b.quiet()
    await a.send(type="knock", to=b.id, link=True)
    e = await a.expect("error")
    check("busy stops a link, as a knock", (e["code"], e.get("ref")), ("not_available", "knock"))
    await b.send(type="status", status="available")
    await b.quiet()
    await a.send(type="knock", to=b.id, link=True, message="look")
    sent = await a.expect("knock_sent")
    k = await b.expect("knock")
    check("a link: says so both ways, with the knocker's key and message, not a watch",
          (sent.get("link"), sent.get("watch"), k.get("link"), k.get("watch"), k["from"]["key"], k["message"]), (True, None, True, None, "ep-L A", "look"))
    await b.send(type="answer", knock=k["id"], accept=True)
    ans = await a.expect("answered")
    va, vb = await a.expect("visit"), await b.expect("visit")
    check("let in: a watch that is a link, both told so",
          (ans["accept"], ans.get("link"), va.get("watch"), va.get("link"), vb.get("watch"), vb.get("link"), va["role"], vb["role"]),
          (True, True, True, True, True, True, "visitor", "host"))
    lob = await a.last_lobby()
    check("counted as a watcher, not a visitor", (office(lob, "L B")["watchers"], office(lob, "L B")["visitors"]), (1, 0))
    await a.send(type="knock", to=b.id, link=True)
    e = await a.expect("error")
    check("linked already: already_watching", (e["code"], e.get("ref")), ("already_watching", "knock"))
    await a.send(type="knock", to=old.id, link=True)
    sent = await a.expect("knock_sent")
    k = await old.expect("knock")
    check("to a door that does not take links: an ordinary knock", (sent.get("link"), k.get("link")), (None, None))
    await old.send(type="answer", knock=k["id"], accept=True)
    await a.expect("answered")
    vo = await a.expect("visit")
    check("which is an ordinary visit, the link going on", (vo.get("watch"), vo.get("link"), len(lobby.OFFICES2[a.id].watching)), (None, None, 1))
    await a.send(type="end", visit=va["id"])
    e1, e2 = await a.expect("visit_ended"), await b.expect("visit_ended")
    check("a link ends like a visit", (e1["id"], e2["id"], len(lobby.OFFICES2[b.id].watched)), (va["id"], va["id"], 0))
    for c_ in (a, b, old):
        await c_.send(type="bye")


async def t_chat():
    """Lobby chat (Visit 0.15): a line to everyone in the lobby that takes it, the sayer too; plain, capped, rate-limited."""
    a, b = await join("C A", proto=lobby.PROTO3, chat=True), await join("C B", proto=lobby.PROTO3, chat=True)
    old = await join("C Old", proto=lobby.PROTO3)
    check("the welcome says the lobby relays chat", a.welcome.get("chat"), True)
    await a.send(type="chat", text="  hello\tall \n")
    la, lb = await a.expect("lobby_chat"), await b.expect("lobby_chat")
    check("a says a line: b has it, and a too (in order), plain, from a",
          (lb["text"], lb["from"]["name"], lb["from"]["id"], la["text"]), ("hello all", "C A", a.id, "hello all"))
    check("an office whose hello did not say chat gets nothing", [m["type"] for m in await old.quiet()], [])
    await b.send(type="chat", text="é" * 500)
    check("a long line: cut to 200 characters", len((await a.expect("lobby_chat"))["text"]), 200)
    await b.quiet()
    await a.send(type="chat", text=" \n ")
    check("an empty one: refused", (await a.expect("error"))["code"], "bad_message")
    for i in range(4):
        await a.send(type="chat", text="line %d" % i)
    await a.send(type="chat", text="one too many")
    got = [m for m in await a.quiet() if m["type"] in ("lobby_chat", "error")]
    check("five lines in 10 s, the sixth refused", ([m.get("text") for m in got if m["type"] == "lobby_chat"], [m.get("code") for m in got if m["type"] == "error"]),
          (["line 0", "line 1", "line 2", "line 3"], ["rate_limited"]))
    for c_ in (a, b, old):
        await c_.send(type="bye")


async def t_whisper():
    """Whispers (Visit 0.16): a line to one office alone, through the lobby; only to one whose hello said whisper."""
    a, b = await join("W A", proto=lobby.PROTO3, chat=True, whisper=True), await join("W B", proto=lobby.PROTO3, chat=True, whisper=True)
    c, old = await join("W C", proto=lobby.PROTO3, chat=True, whisper=True), await join("W Old", proto=lobby.PROTO3, chat=True)
    lob = await a.last_lobby()
    check("the lobby says who takes whispers", (office(lob, "W B")["whisper"], office(lob, "W Old")["whisper"]), (True, False))
    await a.send(type="whisper", to=b.id, text="  psst\n ")
    w = await b.expect("whisper")
    check("A whispers to B: B has it, from A, plain", (w["text"], w["from"]["name"], w["from"]["id"], w["from"]["key"]), ("psst", "W A", a.id, "ep-W A"))
    check("and nobody else: not C, not A", ([m["type"] for m in await c.quiet() if m["type"] != "lobby"], [m["type"] for m in await a.quiet() if m["type"] != "lobby"]), ([], []))
    await a.send(type="whisper", to=old.id, text="hi")
    e = await a.expect("error")
    check("to an office that takes none: refused, by name", (e["code"], e.get("ref"), "W Old" in e["message"]), ("not_supported", "whisper", True))
    for to in ("nobody", a.id, 5):
        await a.send(type="whisper", to=to, text="hi")
    check("to nobody, to itself, to no id: not_found", [(await a.expect("error"))["code"] for _ in range(3)], ["not_found"] * 3)
    for i in range(4):
        await a.send(type="whisper", to=b.id, text="w%d" % i)
    await a.send(type="chat", text="and one in the lobby")
    got = [m for m in await a.quiet() if m["type"] in ("lobby_chat", "error")]
    check("whispers and lobby lines count together: the sixth refused", [m.get("code") for m in got], ["rate_limited"])
    for c_ in (a, b, c, old):
        await c_.send(type="bye")


async def main():
    global URL
    async with serve(lobby.handler, "127.0.0.1", 0, max_size=lobby.LIMITS["frame"], process_request=lobby.health) as server:
        URL = "ws://127.0.0.1:%d" % server.sockets[0].getsockname()[1]
        for t in (t_hello, t_hello_rules_and_separation, t_knock_refusals, t_visit, t_end_and_full, t_resume, t_resume_replays_visits, t_rename,
                  t_resume_window_and_bye, t_knock_timeout_and_health, t_version_3, t_keys, t_watch, t_link, t_chat, t_whisper):
            print("\n" + t.__name__[2:])
            try:
                await t()
            except Exception as e:
                global fails
                fails += 1
                print("FAIL  %s raised %s: %s" % (t.__name__, type(e).__name__, e))
            await asyncio.sleep(0.2)
            # every session dropped by a test is held for the resume window: end them before the next
            for oid in list(lobby.OFFICES2):
                lobby.depart2(oid)
        check("\nevery office left the lobby", (len(lobby.OFFICES2), len(lobby.VISITS2), len(lobby.KNOCKS2)), (0, 0, 0))
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
