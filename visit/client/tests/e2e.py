#!/usr/bin/env python3
"""visit-client end to end: the real lobby (in-process), two real visit-clients (A hosts, B visits) and
two stand-in pages speaking basedverse-visit-local/2 (../../SPEC.md section 5). Everything on this
machine's loopback; the visit-clients link directly (no relay).

    python3 e2e.py path/to/visit-client   (run-e2e.sh runs it in a container)
"""
import asyncio
import gzip
import json
import os
import re
import secrets
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "lobby", "server"))
import lobby  # noqa: E402
from websockets.asyncio.client import connect  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

BIN = sys.argv[1]
VERSION = re.search(r'^version = "(.*)"', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Cargo.toml")).read(), re.M).group(1)
TMP = tempfile.mkdtemp()
fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("%s  %s%s" % ("ok  " if ok else "FAIL", label, "" if ok else "\n      got  %r\n      want %r" % (got, want)), flush=True)


class Page:
    """A stand-in for a workroom's page: its messages in order, its binary frames apart."""

    def __init__(self, port, token):
        self.port, self.token = port, token

    async def open(self, token=None, origin="http://room.test"):
        self.ws = await connect("ws://127.0.0.1:%d/ws" % self.port, max_size=4 << 20, origin=origin)
        self.texts, self.frames = asyncio.Queue(), asyncio.Queue()
        await self.send(type="hello", proto="basedverse-visit-local/2", token=token or self.token, sim={"name": "e2e", "version": "1"})
        self.pump = asyncio.create_task(self._pump())
        return self

    async def _pump(self):
        try:
            async for m in self.ws:
                await (self.frames if isinstance(m, bytes) else self.texts).put(m if isinstance(m, bytes) else json.loads(m))
        except ConnectionClosed:
            pass
        await self.texts.put(None)

    async def send(self, **m):
        await self.ws.send(json.dumps(m))

    async def expect(self, type_, timeout=10, skip=("lobby", "online", "knock_sent", "link_stats", "shared_adds")):
        """The next message of this type, passing over the kinds in `skip`; any other first is a failure."""
        while True:
            m = await asyncio.wait_for(self.texts.get(), timeout)
            if m is None:
                raise AssertionError("the connection closed waiting for %s" % type_)
            if m["type"] == type_:
                return m
            if m["type"] not in skip:
                raise AssertionError("wanted %s, got %s" % (type_, m))

    async def until(self, pred, timeout=15):
        """Messages until one satisfies pred; that one."""
        async def go():
            while True:
                m = await self.texts.get()
                if m is None:
                    raise AssertionError("the connection closed")
                if pred(m):
                    return m
        return await asyncio.wait_for(go(), timeout)

    async def drain(self):
        await asyncio.sleep(0.3)
        while not self.texts.empty():
            self.texts.get_nowait()

    async def close(self):
        await self.ws.close()
        self.pump.cancel()


async def start_client(name, port, url, *extra, binary=None):
    token = secrets.token_hex(32)
    path = os.path.join(TMP, name + ".token")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, token.encode())
    os.close(fd)
    log = open(os.path.join(TMP, name + ".log"), "w")
    p = await asyncio.create_subprocess_exec(binary or BIN, "--lobby", url, "--name", name, "--sim", "e2e/1", "--port", str(port),
                                             "--token-file", path, "--relays", "none", *extra,
                                             stdout=asyncio.subprocess.PIPE, stderr=log,
                                             env=dict(os.environ, RUST_LOG=os.environ.get("RUST_LOG", "visit_client=debug,iroh=warn")))
    ready = json.loads(await asyncio.wait_for(p.stdout.readline(), 10))
    check("%s prints its ready line" % name, (ready["ready"], ready["port"], ready["proto"]), (True, port, "basedverse-visit-local/2"))
    return p, token


def frame(channel, key, ts, payload):
    """A page's scene delta: channel, flags (bit 0 a key delta), timestamp, the delta."""
    return struct.pack(">HBQ", channel, 1 if key else 0, ts) + payload


def scene_edit(channel, edit, raw=None):
    """A page's scene edit: the edit flag (bit 1), then the edit, gzipped JSON (or `raw` bytes as they are)."""
    return struct.pack(">HBQ", channel, 2, 0) + (raw if raw is not None else gzip.compress(json.dumps(edit).encode()))


def unframe(b):
    channel, flags, ts = struct.unpack(">HBQ", b[:11])
    return (channel, bool(flags & 1), ts, b[11:])


async def main():
    # Pings every second, dropping a connection that does not answer within one: the keepalive check below.
    async with serve(lobby.handler, "127.0.0.1", 0, max_size=lobby.LIMITS["frame"], process_request=lobby.health,
                     ping_interval=1, ping_timeout=1) as server:
        url = "ws://127.0.0.1:%d" % server.sockets[0].getsockname()[1]
        state = os.path.join(TMP, "A.state.json")   # where A keeps whether it is away
        a_flags = ("--origins", "http://room.test", "--state-file", state)
        (pa, ta), (pb, tb) = await start_client("A", 7411, url, *a_flags), await start_client("B", 7412, url)

        print("\npage connection")
        bad = await Page(7411, ta).open(token="0" * 64)
        try:
            await bad.expect("ready", timeout=3)
            check("a wrong token is refused", "ready", "closed 4401")
        except AssertionError:
            check("a wrong token is refused", bad.ws.close_code, 4401)
        try:
            await Page(7411, ta).open(origin="http://elsewhere.test")
            check("A takes pages only from its --origins", "connected", "refused")
        except Exception as e:
            check("A takes pages only from its --origins", "403" in str(e), True)
        a, b = await Page(7411, ta).open(), await Page(7412, tb).open()
        ra, rb = await a.expect("ready"), await b.expect("ready")
        check("ready: the version, no visits, not away", (ra["version"], ra["visits"], ra["away"]), (VERSION, [], False))
        ka, kb = ra["key"], rb["key"]
        check("and each office's key (64 hex), its door open, no guests", (bool(re.fullmatch(r"[0-9a-f]{64}", ka)), ka != kb, ra["door"], ra["guests"]),
              (True, True, "open", []))
        lob = await a.until(lambda m: m["type"] == "lobby" and len(m["offices"]) == 2)
        check("both offices in the lobby, neither ready: no page hosts its scene yet", sorted((o["name"], o["ready"]) for o in lob["offices"]), [("A", False), ("B", False)])
        await b.send(type="knock", to=next(o["id"] for o in lob["offices"] if o["name"] == "A"))
        check("knocking before hosting: refused, not_hosting", (await b.expect("error"))["code"], "not_hosting")
        await b.send(type="host", three="r128")
        check("a revision that is not digits: refused", (await b.expect("error"))["code"], "bad_message")
        await a.send(type="host", three="128")
        await b.send(type="host", three="128")
        both = lambda m: m["type"] == "lobby" and sum(o["ready"] for o in m["offices"]) == 2
        lob = await a.until(both)
        await b.until(both)
        ids = {o["name"]: o["id"] for o in lob["offices"]}
        check("each page hosts its scene: both ready (links published)", sorted(ids), ["A", "B"])
        check("the lobby lists each office's key: the one its page was told", {o["name"]: o["key"] for o in lob["offices"]}, {"A": ka, "B": kb})
        await a.drain()
        await b.drain()
        await asyncio.sleep(4)   # idle through four of the lobby's pings
        seen = []
        while not b.texts.empty():
            seen.append(b.texts.get_nowait()["type"])
        check("idle, the visit-clients answer the lobby's pings: B never goes offline", "offline" in seen, False)
        await b.send(type="status", status="away")
        check("a status other than available or busy is refused, there and then", (await b.expect("error"))["code"], "bad_message")
        await b.send(type="rename", name="A")
        check("renaming to a taken name: refused", (await b.expect("error"))["code"], "name_taken")
        await b.send(type="rename", name="B2")
        lob = await a.until(lambda m: m["type"] == "lobby" and any(o["name"] == "B2" for o in m["offices"]))
        check("renaming to a free name: the same office, its new name for all", [o["id"] for o in lob["offices"] if o["name"] == "B2"], [ids["B"]])
        await b.send(type="rename", name="B")
        await a.until(lambda m: m["type"] == "lobby" and any(o["name"] == "B" for o in m["offices"]))
        await a.drain()
        await b.drain()

        print("\nknock, let in, link up")
        await b.send(type="knock", to=ids["A"], message="may I?")
        k = await a.expect("knock")
        check("the knock reaches A's page", (k["from"]["name"], k["message"]), ("B", "may I?"))
        await a.send(type="answer", knock=k["id"], accept=True)
        await b.expect("answered")
        sa, sb = await a.expect("visit_started"), await b.expect("visit_started")
        check("both pages: visit_started, A hosting, B visiting, one visit", (sa["role"], sb["role"], sa["id"] == sb["id"], sa["peer"]["name"], sb["peer"]["name"]),
              ("host", "visitor", True, "B", "A"))
        cha, chb, vid = sa["channel"], sb["channel"], sa["id"]
        sh = await a.until(lambda m: m["type"] == "shared_adds")
        check("B's visit-client says its page reads an add naming what it has by uuid: A's page hears it", sh, {"type": "shared_adds", "channel": cha})

        print("\nvisitor to host: input, key deltas, the link")
        await b.send(type="input", forward=1, strafe=-1, run=True, yaw=0.5, pitch=9, t=12345.5)
        i = await a.expect("input")
        check("B's input reaches A's page, clamped", (i["channel"], i["forward"], i["strafe"], i["run"], i["yaw"], i["pitch"]), (cha, 1, -1, True, 0.5, 1.4))
        check("with B's time on it, for A's deltas to carry back", i["t"], 12345.5)
        await a.drain()
        for _ in range(5):
            await b.send(type="keyframe", channel=chb)
        await asyncio.sleep(0.3)
        keys = []
        while not a.texts.empty():
            m = a.texts.get_nowait()
            if m and m["type"] == "keyframe":
                keys.append(m["channel"])
        check("B asking for a key delta five times at once: A's page is asked once", keys, [cha])
        await a.drain()
        await b.send(type="point", yaw=-0.75, pitch=-9, target="something of A's", channel=99)
        pt = await a.expect("point")
        check("B's point (a click at the middle of its view) reaches A's page: its look only, clamped, on A's channel",
              pt, {"type": "point", "channel": cha, "yaw": -0.75, "pitch": -1.4})
        await a.drain()
        for n in range(12):
            await b.send(type="point", yaw=n / 10, pitch=0)
        await asyncio.sleep(0.4)
        pts = []
        while not a.texts.empty():
            m = a.texts.get_nowait()
            if m and m["type"] == "point":
                pts.append(m["yaw"])
        check("B pointing twelve times at once: A's page hears the first five", pts, [0.0, 0.1, 0.2, 0.3, 0.4])
        sa_stats = await a.until(lambda m: m["type"] == "link_stats", timeout=4)
        sb_stats = await b.until(lambda m: m["type"] == "link_stats", timeout=4)
        check("both pages hear the link's path and round trip, about once a second: direct here",
              (sa_stats["channel"], sa_stats["path"], sb_stats["channel"], sb_stats["path"], 0 <= sb_stats["rtt_ms"] < 100), (cha, "direct", chb, "direct", True))

        print("\nhost to visitor: the scene")
        await a.drain()
        await b.drain()
        whole = {"type": "scene", "three": "128", "json": {"metadata": {"version": 4.5}, "object": {"type": "Scene", "uuid": "u-1"}}, "ids": [["u-1", 1]]}
        edits = [whole] + [{"type": "edit", "props": [{"uuid": "m", "opacity": n / 10}]} for n in range(5)]
        for e in edits:
            await a.ws.send(scene_edit(cha, e))
        got = [await b.expect("scene") for _ in edits]
        check("A's scene and its edits reach B's page whole, in order, on B's channel (gzipped on the way, unpacked for the page)",
              [(g["channel"], g["edit"]) for g in got], [(chb, e) for e in edits])
        big = {"type": "edit", "blob": secrets.token_hex(750_000)}
        await a.ws.send(scene_edit(cha, big))
        check("a 1.5 MB edit (a big room's whole scene) arrives whole", (await b.expect("scene", timeout=20))["edit"] == big, True)
        bomb = gzip.compress(b" " * (65 << 20))
        await a.ws.send(scene_edit(cha, None, raw=bomb))
        check("a zip bomb (%d KB that would unpack to 65 MB): dropped, and B's page told the scene is lost" % (len(bomb) // 1024),
              (await b.expect("scene_lost", timeout=20))["channel"], chb)
        for raw in (gzip.compress(b'{"type": "edit", '), gzip.compress(b"[1, 2]"), b"not gzip at all"):
            await a.ws.send(scene_edit(cha, None, raw=raw))
            await b.expect("scene_lost")
        check("cut-short JSON, an array, not gzip: each dropped, scene_lost", True, True)
        await a.ws.send(scene_edit(cha, {"type": "edit", "after": True}))
        check("and the next edit after them still arrives", (await b.expect("scene"))["edit"], {"type": "edit", "after": True})
        for _ in range(3):
            await b.send(type="scene_resync", channel=chb)
        await asyncio.sleep(0.4)
        asked = []
        while not a.texts.empty():
            m = a.texts.get_nowait()
            if m and m["type"] == "scene_resync":
                asked.append(m["channel"])
        check("B asking for the whole scene three times at once: A's page is asked once", asked, [cha])
        await a.ws.send(scene_edit(9999, {"type": "edit"}))
        await b.send(type="scene_resync", channel=9999)
        check("an edit for no visit is dropped; a resync for none is refused", (await b.expect("error"))["code"], "no_such_visit")
        sent = [frame(cha, n % 10 == 0, 1000 * n, secrets.token_bytes(40 + n)) for n in range(25)]
        for f in sent:   # paced, as a page sends them (every 33 ms, here faster)
            await a.ws.send(f)
            await asyncio.sleep(0.01)
        got = [unframe(await asyncio.wait_for(b.frames.get(), 5)) for _ in range(25)]
        check("25 deltas, in order, key deltas marked, on B's channel", [(g[0], g[1], g[2], g[3]) for g in got], [(chb,) + unframe(f)[1:] for f in sent])
        # Three key deltas' streams at once: a newer abandons the older, so nothing older than a key delta ever
        # follows it, and the newest stream arrives whole.
        burst = [frame(cha, n % 4 == 0, 50_000 + 1000 * n, b"burst %d" % n) for n in range(12)]
        for f in burst:
            await a.ws.send(f)
        got = []
        try:
            while True:
                got.append(unframe(await asyncio.wait_for(b.frames.get(), 1)))
        except asyncio.TimeoutError:
            pass
        ts = [g[2] for g in got]
        check("a burst: never an older delta after a newer one", ts == sorted(ts), True)
        check("and the newest key delta's stream whole", ts[-4:], [58_000, 59_000, 60_000, 61_000])

        print("\nreloads")
        await a.send(type="pose", channel=cha, state={"pose": {"x": 1.5, "z": 2}, "yaw0": 0})
        await asyncio.sleep(0.2)
        await a.close()
        paused = lob = None
        while paused is None or lob is None:   # in either order: the link and the lobby are separate ways
            m = await b.until(lambda m: m["type"] == "host_paused" or (m["type"] == "lobby" and any(o["name"] == "A" and not o["ready"] for o in m["offices"])))
            paused, lob = (m, lob) if m["type"] == "host_paused" else (paused, m)
        check("A's page goes: B hears its host paused", paused["channel"], chb)
        check("and A, with no page hosting, is not ready to be visited (the visit goes on)", [o["ready"] for o in lob["offices"] if o["name"] == "A"], [False])
        a = await Page(7411, ta).open()
        ra = await a.expect("ready")
        check("A's page back: ready lists the visit", [(v["id"], v["role"], v["channel"]) for v in ra["visits"]], [(vid, "host", cha)])
        check("with where B stood, as A's page last said", ra["visits"][0].get("state"), {"pose": {"x": 1.5, "z": 2}, "yaw0": 0})
        check("and B hears its host resumed", (await b.expect("host_resumed"))["channel"], chb)
        await a.send(type="host", three="128")
        lob = await b.until(lambda m: m["type"] == "lobby" and any(o["name"] == "A" and o["ready"] for o in m["offices"]))
        check("A's page hosts again: ready again", [o["ready"] for o in lob["offices"] if o["name"] == "A"], [True])
        await a.ws.send(frame(cha, True, 99_000, b"after the reload"))
        check("deltas flow again", unframe(await asyncio.wait_for(b.frames.get(), 5))[3], b"after the reload")
        await b.close()
        b = await Page(7412, tb).open()
        rb = await b.expect("ready")
        check("B's page back: still visiting", [(v["id"], v["role"]) for v in rb["visits"]], [(vid, "visitor")])
        check("and A is asked for its whole scene again, for B's new page (at most every 2 s: this one waited, and went)",
              (await a.until(lambda m: m["type"] == "scene_resync", timeout=5))["channel"], cha)
        await b.send(type="host", three="128")
        c = await Page(7411, ta).open()
        await c.expect("ready")
        await asyncio.sleep(0.3)
        check("a second page on A takes over; the first is closed 4409", a.ws.close_code, 4409)
        a = c
        await a.send(type="host", three="128")

        print("\nthe lobby connection drops and resumes")
        await a.drain()
        await b.drain()
        office_b = lobby.OFFICES2[ids["B"]]
        await office_b.ws.close()
        check("B's page hears it is offline", (await b.until(lambda m: m["type"] in ("offline", "online")))["type"], "offline")
        on = await b.until(lambda m: m["type"] == "online", timeout=10)
        check("then online again as the same office", on["office"]["id"], ids["B"])
        await a.ws.send(frame(cha, True, 200_000, b"still linked"))
        check("the visit never noticed: deltas still flow", unframe(await asyncio.wait_for(b.frames.get(), 5))[3], b"still linked")

        print("\nending")
        await b.send(type="end", visit=vid)
        ea, eb = await a.until(lambda m: m["type"] == "visit_ended"), await b.until(lambda m: m["type"] == "visit_ended")
        check("B leaving: both pages hear visit_ended, `left`", (ea["reason"], eb["reason"], ea["channel"], eb["channel"]), ("left", "left", cha, chb))
        await asyncio.sleep(1.5)
        stray = []
        for pg in (a, b):
            while not pg.texts.empty():
                m = pg.texts.get_nowait()
                if m and m["type"] == "error":
                    stray.append(m)
        check("and no error after it (the link ended on purpose: no redialling, no link_failed)", stray, [])

        print("\nguests and the door")
        await a.drain()
        await b.drain()
        await a.send(type="guest_add", key=kb, name="B")
        g = await a.expect("guests")
        check("A adds B as a guest: its page hears the list, the door open", (g["door"], g["guests"]), ("open", [{"key": kb, "name": "B"}]))
        saved = json.load(open(state))
        check("kept in A's state file, with its key (the secret half, readable by A only)",
              (saved["door"], saved["guests"], len(saved["key"]), oct(os.stat(state).st_mode & 0o777)), ("open", [{"key": kb, "name": "B"}], 64, "0o600"))
        await b.send(type="knock", to=ids["A"])
        sa, sb = await a.expect("visit_started", skip=("lobby",)), await b.expect("visit_started", skip=("lobby", "knock_sent", "answered"))
        check("B knocks: a guest at an open door walks in, A's page never asked (it hears the visit start, a guest's)",
              (sa["role"], sa.get("guest"), sa["peer"]["name"], sb["role"]), ("host", True, "B", "visitor"))
        check("both told the other's key, as its link proved it", (sa["peer"]["key"], sb["peer"]["key"]), (kb, ka))
        await b.send(type="end", visit=sa["id"])
        await a.until(lambda m: m["type"] == "visit_ended")
        await b.until(lambda m: m["type"] == "visit_ended")
        await a.send(type="door", open=False)
        check("A closes its door", (await a.expect("guests"))["door"], "closed")
        await b.send(type="knock", to=ids["A"])
        k = await a.expect("knock")
        check("door closed: even a guest knocks, and A's page is asked", (k["from"]["name"], k["from"]["key"]), ("B", kb))
        await a.send(type="answer", knock=k["id"], accept=False)
        await b.until(lambda m: m["type"] == "answered")
        await a.send(type="door", open=True)
        await a.expect("guests")
        await a.send(type="guest_remove", key=kb)
        check("B no longer a guest", (await a.expect("guests"))["guests"], [])
        await b.send(type="knock", to=ids["A"])
        k = await a.expect("knock")
        check("door open, but B not a guest: A's page is asked", k["from"]["name"], "B")
        await a.send(type="answer", knock=k["id"], accept=False)
        await b.until(lambda m: m["type"] == "answered")
        await a.send(type="guest_add", key="o1a2b3c4", name="nope")
        check("a guest's key must be a key", (await a.expect("error"))["code"], "bad_message")
        await a.send(type="guest_add", key=ka)
        check("and not A's own", (await a.expect("error"))["code"], "bad_message")
        # A lobby that lies: it says B's knock comes from a guest's key. A lets it in, and the visit is agreed,
        # but B's link is B's own key, not the guest's: A ends it before any link is made.
        other = "5866666666666666666666666666666666666666666666666666666666666666"   # ed25519's base point: a key
        await a.send(type="guest_add", key=other, name="someone")
        await a.expect("guests")
        real = lobby.knock_msg
        def lying(kid):
            m = real(kid)
            m["from"]["key"] = other
            return m
        lobby.knock_msg = lying
        try:
            await b.send(type="knock", to=ids["A"])
            await asyncio.sleep(1.5)
        finally:
            lobby.knock_msg = real
        seen_a = [m["type"] for m in [a.texts.get_nowait() for _ in range(a.texts.qsize())] if m]
        seen_b = [m["type"] for m in [b.texts.get_nowait() for _ in range(b.texts.qsize())] if m]
        check("a lobby lying about whose knock it is: no visit (A's page asked nothing, B's never in)",
              ("knock" in seen_a, "visit_started" in seen_a, "visit_started" in seen_b, len(lobby.VISITS2)), (False, False, False, 0))
        await a.send(type="guest_remove", key=other)
        await a.expect("guests")

        print("\nthe world: watching guests' plots, stepping in and out")
        await a.drain()
        await b.drain()
        quiet_types = lambda pg: [m["type"] for m in [pg.texts.get_nowait() for _ in range(pg.texts.qsize())] if m]
        await a.send(type="guest_add", key=kb, name="B")
        await b.send(type="guest_add", key=ka, name="A")
        await a.expect("guests")
        await b.expect("guests")
        await a.send(type="world", on=True)
        wa = await a.until(lambda m: m["type"] == "visit_started")
        wb = await b.until(lambda m: m["type"] == "visit_started")
        check("A's world on: A watches its guest B's plot, B (A its guest, door open) lets it, neither page asked",
              (wa["role"], wa.get("watch"), wa.get("inside"), wa["peer"]["name"], wb["role"], wb.get("watch"), wb.get("inside")),
              ("visitor", True, False, "B", "host", True, False))
        await b.send(type="world", on=True)
        wa2 = await a.until(lambda m: m["type"] == "visit_started")
        wb2 = await b.until(lambda m: m["type"] == "visit_started")
        check("B's world on: each watches the other's plot (two watches, one each way)", (wa2["role"], wb2["role"], wb2["peer"]["name"]), ("host", "visitor", "A"))
        b = await Page(7412, tb).open()   # B's page reloads, and this one does not draw a world
        await b.expect("ready")
        await b.send(type="host", three="128")
        e = await b.until(lambda m: m["type"] == "visit_ended", timeout=15)
        check("B's page reloaded, not asking for its world again: within 10 s B's watch ends", e["id"], wb2["id"])
        await a.until(lambda m: m["type"] == "visit_ended")
        await b.send(type="world", on=True)
        wb2 = await b.until(lambda m: m["type"] == "visit_started")
        await a.until(lambda m: m["type"] == "visit_started")
        check("asking again: watching again", (wb2.get("watch"), wb2["peer"]["name"]), (True, "A"))
        await asyncio.sleep(0.5)
        seen = quiet_types(a) + quiet_types(b)
        check("no knock, knock_sent or answered reached either page", [t for t in seen if t in ("knock", "knock_sent", "answered")], [])
        cha_w, chb_w = wa["channel"], wb["channel"]   # A watching B: A's channel, B's
        await b.ws.send(scene_edit(chb_w, {"type": "scene", "three": "128", "json": {"object": {"type": "Scene"}}, "plot": {"center": [5, 4], "size": [10, 8]}}))
        got = await a.expect("scene", skip=("lobby", "link_stats"))
        check("B's plot's scene reaches its watcher, as a visit's does", (got["channel"], got["edit"]["plot"]), (cha_w, {"center": [5, 4], "size": [10, 8]}))
        await a.send(type="input", forward=1, strafe=0, run=False, yaw=0, pitch=0, t=1)
        await a.send(type="point", yaw=0, pitch=0)
        await asyncio.sleep(0.5)
        check("watching, not in: A's input and points go nowhere", [t for t in quiet_types(b) if t in ("input", "point")], [])
        await a.send(type="enter", channel=cha_w, pose={"x": 1.5, "y": 0, "z": 7.9, "yaw": 0.5, "evil": "no"})
        e = await b.expect("enter", skip=("lobby", "link_stats", "visit_started"))
        check("A steps onto B's plot: B's page hears where, in its own terms, and nothing else", (e["channel"], e["pose"]), (chb_w, {"x": 1.5, "y": 0.0, "z": 7.9, "yaw": 0.5}))
        await a.send(type="input", forward=1, strafe=0, run=False, yaw=0.25, pitch=0, t=2)
        i = await b.expect("input", skip=("lobby", "link_stats"))
        check("in: A's input reaches B's page, on the watch's channel", (i["channel"], i["forward"], i["yaw"]), (chb_w, 1, 0.25))
        await a.send(type="exit", channel=cha_w)
        check("A steps off: B's page hears it", (await b.expect("exit", skip=("lobby", "link_stats", "input")))["channel"], chb_w)
        await b.drain()
        await a.send(type="input", forward=1, strafe=0, run=False, yaw=0, pitch=0, t=3)
        await asyncio.sleep(0.4)
        check("out again: A's input goes nowhere", [t for t in quiet_types(b) if t == "input"], [])
        await a.send(type="enter", channel=cha_w, pose={"x": 1, "z": 1})
        await b.expect("enter", skip=("lobby", "link_stats", "input"))
        await a.send(type="knock", to=ids["B"])   # in B's plot, A visits B the old way (a guest: let in at once)
        r = await a.expect("enter_refused", skip=("lobby", "link_stats", "knock_sent", "answered"))
        ex = await b.until(lambda m: m["type"] == "exit")
        va = await a.until(lambda m: m["type"] == "visit_started")
        check("in B's plot, A starts a visit: out of the plot first (A's page told: moved; B's: it stepped out)",
              (r["channel"], r["reason"], ex["channel"], va["role"], va.get("watch")), (cha_w, "moved", chb_w, "visitor", None))
        await a.send(type="end", visit=va["id"])
        await a.until(lambda m: m["type"] == "visit_ended")
        await b.until(lambda m: m["type"] == "visit_ended")
        await b.send(type="max_visitors", n=0)
        await asyncio.sleep(0.3)
        await a.send(type="enter", channel=cha_w, pose={"x": 1, "z": 1})
        r = await a.expect("enter_refused", skip=("lobby", "link_stats"))
        check("B taking no visitors: A stepping in is refused, full, and stays outside", (r["channel"], r["reason"]), (cha_w, "full"))
        await b.send(type="max_visitors", n=3)
        await a.send(type="world", on=False)
        ends = [await a.until(lambda m: m["type"] == "visit_ended"), await b.until(lambda m: m["type"] == "visit_ended")]
        check("A's world off: its watch of B ends (B's of A goes on)", [(x["id"], x["reason"]) for x in ends], [(wa["id"], "left")] * 2)
        await b.send(type="guest_remove", key=ka)
        await b.expect("guests")
        await a.drain()
        await b.drain()
        await a.send(type="world", on=True)
        await asyncio.sleep(1.5)
        check("A no longer B's guest: A's knock to watch is declined by B's visit-client, B's page never asked",
              ([t for t in quiet_types(a) if t == "visit_started"], [t for t in quiet_types(b) if t in ("knock", "visit_started")]), ([], []))
        await a.send(type="place", key=kb, x=20.5, z=-3, turn=1)
        lay = await a.expect("layout", skip=("lobby", "link_stats"))
        check("A places B's plot in its world: kept, by key", lay["layout"], [{"key": kb, "x": 20.5, "z": -3.0, "turn": 1}])
        check("in A's state file too", json.load(open(state))["layout"], [{"key": kb, "x": 20.5, "z": -3.0, "turn": 1}])
        await a.send(type="place", key=kb, x=1, z=1, turn=7)
        check("a turn past 3: refused", (await a.expect("error", skip=("lobby", "link_stats")))["code"], "bad_message")
        await a.send(type="unplace", key=kb)
        check("unplaced", (await a.expect("layout", skip=("lobby", "link_stats")))["layout"], [])
        # Where each has put the other in its world (8.4): told to that office alone, over a link either way (here
        # B's watch of A); no agreeing, and nothing else of either world.
        seen_b = {"dx": 22.5, "dz": -4, "turn": 1, "size": [12, 9]}
        await b.send(type="seen", key=ka, at=dict(seen_b, evil="no"))
        sa = await a.expect("seen", skip=("lobby", "link_stats"))
        check("B tells A where A sits in B's world: A's page has it, from B, and nothing else", {k: v for k, v in sa.items() if k != "type"},
              {"key": kb, "name": "B", "at": seen_b})
        seen_a = {"dx": -15, "dz": 0, "turn": 0, "size": [10, 8]}
        await a.send(type="seen", key=kb, at=seen_a)
        sb = await b.expect("seen", skip=("lobby", "link_stats"))
        check("and A, B where B sits in A's: over the same link, the other way", (sb["key"], sb["name"], sb["at"]), (ka, "A", seen_a))
        await b.send(type="seen", key=ka, at=dict(seen_b, turn=5))
        check("a turn past 3: refused", (await b.expect("error", skip=("lobby", "link_stats")))["code"], "bad_message")
        await b.send(type="seen", key="nope", at=seen_b)
        check("no office's key: refused", (await b.expect("error", skip=("lobby", "link_stats")))["code"], "bad_message")
        await b.send(type="world", on=False)
        na = await a.until(lambda m: m["type"] == "seen")
        nb = await b.until(lambda m: m["type"] == "seen")
        check("their last link gone: each forgets where it was in the other's world", ((na["key"], na["at"]), (nb["key"], nb["at"])), ((kb, None), (ka, None)))
        await a.send(type="seen", key=kb, at=dict(seen_a, dx=-16))
        await asyncio.sleep(0.3)
        check("told with no link: kept for the next one, no error", [t for t in quiet_types(a) if t == "error"], [])
        await b.send(type="guest_add", key=ka, name="A")   # (B's world watches its guests: A again, for this)
        await b.send(type="world", on=True)
        sb = await b.until(lambda m: m["type"] == "seen")
        check("B's watch of A comes up: A's visit-client tells B again, the latest", (sb["key"], sb["at"]["dx"]), (ka, -16))
        await a.send(type="seen", key=kb, at=None)
        check("A puts B out of its world: B told", (await b.until(lambda m: m["type"] == "seen"))["at"], None)
        await a.send(type="world", on=False)
        await b.send(type="world", on=False)
        await b.send(type="guest_remove", key=ka)
        await asyncio.sleep(1)
        await a.drain()
        await b.drain()
        await a.send(type="guest_remove", key=kb)
        await a.expect("guests")
        check("and every visit is over", len(lobby.VISITS2), 0)

        print("\nlinks: a knock let in as a watch, seen in a corner, stepped into")
        await a.drain()
        await b.drain()
        await a.send(type="knock", to=ids["B"], link=True, message="peek")   # (A knocks: B has knocked its six a minute)
        k = await b.expect("knock")
        sent = await a.until(lambda m: m["type"] == "knock_sent")
        check("A links to B: B's page asked, told it is a link; A's knock_sent says so", (k.get("link"), k["message"], sent.get("link")), (True, "peek", True))
        await b.send(type="answer", knock=k["id"], accept=True)
        lb = await b.until(lambda m: m["type"] == "visit_started")
        la = await a.until(lambda m: m["type"] == "visit_started")
        check("let in: a link both ways, A outside B's room",
              (lb["role"], lb.get("watch"), lb.get("link"), lb.get("inside"), la["role"], la.get("watch"), la.get("link"), la.get("inside")),
              ("host", True, True, False, "visitor", True, True, False))
        cha_l, chb_l = la["channel"], lb["channel"]
        await b.send(type="door", open=False)
        await b.expect("guests")
        await a.send(type="world", on=False)
        await asyncio.sleep(0.6)
        check("B's door shut, A's world off: the link goes on", [t for t in quiet_types(a) + quiet_types(b) if t == "visit_ended"], [])
        await b.send(type="door", open=True)
        await b.expect("guests")
        await a.send(type="enter", channel=cha_l)
        e = await b.expect("enter", skip=("lobby", "link_stats", "guests"))
        check("A goes there: B's page hears it step in with no pose (B's spawn says where)", (e["channel"], "pose" in e), (chb_l, False))
        await a.send(type="exit", channel=cha_l)
        check("and back to its own room", (await b.expect("exit", skip=("lobby", "link_stats")))["channel"], chb_l)
        await a.send(type="end", visit=la["id"])
        ends = (await a.until(lambda m: m["type"] == "visit_ended"), await b.until(lambda m: m["type"] == "visit_ended"))
        check("A unlinks: over for both", [x["id"] for x in ends], [la["id"]] * 2)
        await b.send(type="guest_add", key=ka, name="A")
        await b.expect("guests")
        await a.send(type="knock", to=ids["B"], link=True)
        lb = await b.until(lambda m: m["type"] == "visit_started")
        la = await a.until(lambda m: m["type"] == "visit_started")
        check("A, B's guest, links through B's open door: let in at once, a link still", (lb.get("link"), lb.get("guest"), la.get("link")), (True, True, True))
        await b.send(type="guest_remove", key=ka)
        await b.expect("guests")
        await asyncio.sleep(0.5)
        check("A no longer B's guest: its link goes on", [t for t in quiet_types(b) if t == "visit_ended"], [])
        await b.send(type="end", visit=lb["id"])
        await a.until(lambda m: m["type"] == "visit_ended")
        await b.until(lambda m: m["type"] == "visit_ended")
        check("B ends it: every visit over", len(lobby.VISITS2), 0)

        print("\navatars: asked for by a host, sent by the visitor's visit-client")
        await a.drain()
        await b.drain()
        av = {"unit": 1, "json": {"metadata": {"version": 4.5}, "object": {"type": "Group", "uuid": "av-1", "name": "me"}}}
        await a.ws.send(struct.pack(">HBQ", 0, 4, 0) + gzip.compress(json.dumps(av).encode()))   # A's own, kept by A's visit-client
        await a.send(type="knock", to=ids["B"])
        await b.send(type="answer", knock=(await b.expect("knock"))["id"], accept=True)
        vb = await b.until(lambda m: m["type"] == "visit_started")
        va = await a.until(lambda m: m["type"] == "visit_started")
        await b.send(type="avatar_want", channel=vb["channel"])
        got = await b.until(lambda m: m["type"] == "avatar")
        check("B asks for A's avatar: A's visit-client sends the one A's page gave it, and B's page has it, whole", (got["channel"], got["avatar"]), (vb["channel"], av))
        av["json"]["object"]["name"] = "me again"
        await asyncio.sleep(2.1)   # (a host takes one at most every 2 s)
        await a.ws.send(struct.pack(">HBQ", 0, 4, 0) + gzip.compress(json.dumps(av).encode()))
        got = await b.until(lambda m: m["type"] == "avatar")
        check("A's page gives a new one: it goes to B at once, B having asked", got["avatar"]["json"]["object"]["name"], "me again")

        print("\nvoice: the room's visit-client decides who hears whom, by where its page has everyone (C visits B too)")
        voice = lambda to, n: struct.pack(">HBQ", to, 8, 0) + bytes([0xFC, n]) + b"opus"   # a stand-in Opus packet, to the room (1) or calls (2)
        opus = lambda n: bytes([0xFC, n]) + b"opus"
        said = lambda who, name, n: bytes([len(who)]) + who.encode() + bytes([len(name.encode())]) + name.encode() + opus(n)   # who spoke, then the voice
        drain_frames = lambda pg: [pg.frames.get_nowait() for _ in range(pg.frames.qsize())]
        async def next_voice(pg, fl):
            while True:   # (deltas of the room may come first)
                f = await asyncio.wait_for(pg.frames.get(), 5)
                if f[2] == fl:
                    return struct.unpack(">H", f[:2])[0], f[11:]
        async def no_voice(*pgs):
            await asyncio.sleep(0.5)
            return [[(f[2], f[11:]) for f in drain_frames(pg) if f[2] in (8, 16)] for pg in pgs]
        near = lambda m: sorted((n["name"], n["distance"], "id" in n) for n in m["near"])
        pc, tc = await start_client("C", 7413, url)
        c = await Page(7413, tc).open()
        await c.expect("ready")
        await c.send(type="host", three="128")
        await c.until(lambda m: m["type"] == "lobby" and any(o["name"] == "B" and o["ready"] for o in m["offices"]))
        await c.send(type="knock", to=ids["B"])
        await b.send(type="answer", knock=(await b.until(lambda m: m["type"] == "knock"))["id"], accept=True)
        vbc = await b.until(lambda m: m["type"] == "visit_started")
        vc = await c.until(lambda m: m["type"] == "visit_started")
        await b.send(type="voice_where", me=[0, 1.6, 0], phone=None, visitors=[[vb["channel"], 10, 0, 0], [vbc["channel"], 20, 0, 0], ["evil"], [9, 1e9, 0, 0]])
        nb = await b.until(lambda m: m["type"] == "voice_near")
        check("B's page says where everyone in its room is: B's visit-client tells it who is near B (A 10 m off, C 20 m)", near(nb), [("A", 10, True), ("C", 20, True)])
        na, nc = await a.until(lambda m: m["type"] == "voice_near"), await c.until(lambda m: m["type"] == "voice_near")
        check("and A and C, each in B's room, who is near them, from B: its owner, and the other visitor (by its visit there)",
              ((na["channel"], near(na)), (nc["channel"], near(nc))), ((va["channel"], [("B", 10, False), ("C", 10, True)]), (vc["channel"], [("A", 10, True), ("B", 20, False)])))
        drain_frames(a); drain_frames(b); drain_frames(c)
        await a.ws.send(voice(1, 1))
        check("A speaks, its page sending it once: B's page has it, on B's channel for A", await next_voice(b, 8), (vb["channel"], opus(1)))
        check("and C's, passed on by B's visit-client: who spoke (A's visit there, and A), then the voice", await next_voice(c, 16), (vc["channel"], said(va["id"], "A", 1)))
        await b.ws.send(voice(1, 2))
        check("B speaks: A and C both have it, from B", (await next_voice(a, 8), await next_voice(c, 8)), ((va["channel"], opus(2)), (vc["channel"], opus(2))))
        await b.send(type="voice_where", me=[0, 1.6, 0], phone=None, visitors=[[vb["channel"], 10, 0, 0], [vbc["channel"], 100, 0, 0]])
        check("C walks 100 m off (as B's room has it): C told nobody is near", (await c.until(lambda m: m["type"] == "voice_near"))["near"], [])
        drain_frames(a); drain_frames(b); drain_frames(c)
        await a.ws.send(voice(1, 3))
        await c.ws.send(voice(1, 4))
        check("A speaks: B hears it, C (too far) does not; C speaks: nobody hears it", await no_voice(a, b, c), [[], [(8, opus(3))], []])
        await a.ws.send(voice(2, 5))
        check("A's voice for its calls only, with no call on: nowhere", await no_voice(b, c), [[], []])
        await b.send(type="voice_where", me=None, phone=None, visitors=[[vb["channel"], 10, 0, 0]])
        await a.until(lambda m: m["type"] == "voice_near" and m["near"] == [])
        await a.ws.send(voice(1, 6))
        check("B's user away from its room (its page says so): nobody there to hear A", await no_voice(b), [[]])
        await a.send(type="phone", on=True)
        ph = await b.until(lambda m: m["type"] == "phone")
        check("A's room has a phone: B's page hears it, on its channel", (ph["channel"], ph["on"]), (vb["channel"], True))
        await b.send(type="call", channel=vb["channel"], act="ring")
        cl = await a.until(lambda m: m["type"] == "call")
        check("B rings A: A's page hears it", (cl["channel"], cl["act"]), (va["channel"], "ring"))
        await a.send(type="call", channel=va["channel"], act="answer")
        check("A answers: B's page hears it", (await b.until(lambda m: m["type"] == "call"))["act"], "answer")
        await a.send(type="call", channel=va["channel"], act="ring")
        check("B's room has no phone: A cannot ring it", (await a.until(lambda m: m["type"] == "error"))["code"], "no_phone")
        await a.send(type="call", channel=va["channel"], act="hangup")
        check("a hang-up goes all the same", (await b.until(lambda m: m["type"] == "call"))["act"], "hangup")
        await a.send(type="phone", on=False)
        check("A's phone gone: B's page hears it", (await b.until(lambda m: m["type"] == "phone"))["on"], False)
        await a.send(type="end", visit=va["id"])
        await a.until(lambda m: m["type"] == "visit_ended")
        await b.until(lambda m: m["type"] == "visit_ended")

        print("\na phone on speaker: those near it hear the call, and are heard in it")
        await a.send(type="knock", to=ids["B"], link=True)   # A, at home, linked to B, calls B's room
        await b.send(type="answer", knock=(await b.until(lambda m: m["type"] == "knock"))["id"], accept=True)
        lb = await b.until(lambda m: m["type"] == "visit_started")
        la = await a.until(lambda m: m["type"] == "visit_started")
        await a.send(type="phone", on=True)
        await b.send(type="phone", on=True)
        await a.until(lambda m: m["type"] == "phone")
        await b.until(lambda m: m["type"] == "phone" and m["channel"] == lb["channel"])
        await a.send(type="call", channel=la["channel"], act="ring")
        await b.until(lambda m: m["type"] == "call")
        await b.send(type="call", channel=lb["channel"], act="answer")
        await a.until(lambda m: m["type"] == "call")
        await b.send(type="voice_where", me=[0, 1.6, 0], phone=[0, 1, 5], visitors=[[vbc["channel"], 2, 0, 5]])
        await b.send(type="speaker", channel=lb["channel"], on=True)
        nc = await c.until(lambda m: m["type"] == "voice_near" and any(n.get("phone") for n in m["near"]))
        check("B puts the call on speaker: C, by B's phone, has the caller near it, as the phone", [(n["name"], n["distance"]) for n in nc["near"] if n.get("phone")], [("A", 2)])
        drain_frames(a); drain_frames(b); drain_frames(c)
        await a.ws.send(voice(2, 7))   # A, on the call
        check("A speaks on the call: B's page has it, on the call's channel", await next_voice(b, 8), (lb["channel"], opus(7)))
        check("and C, near B's phone, has it from the phone", await next_voice(c, 16), (vc["channel"], said("phone", "A", 7)))
        await c.ws.send(voice(1, 8))
        check("C speaks near B's phone: A has it in the call, passed on (who spoke, C)", await next_voice(a, 16), (la["channel"], said(vbc["id"], "C", 8)))
        check("and B, near C, has it too", await next_voice(b, 8), (vbc["channel"], opus(8)))
        await b.send(type="speaker", channel=lb["channel"], on=False)
        await c.until(lambda m: m["type"] == "voice_near" and not any(n.get("phone") for n in m["near"]))
        drain_frames(a); drain_frames(b); drain_frames(c)
        await a.ws.send(voice(2, 9))
        await c.ws.send(voice(1, 10))
        check("back to B's ear: A to B only; C heard by B, not in the call", await no_voice(a, b, c), [[], [(8, opus(9)), (8, opus(10))], []])
        await b.send(type="speaker", channel=999, on=True)
        check("a speaker for no call: refused", (await b.until(lambda m: m["type"] == "error"))["code"], "no_call")
        await a.send(type="call", channel=la["channel"], act="hangup")
        await b.until(lambda m: m["type"] == "call")
        for pg in (a, b):
            await pg.send(type="phone", on=False)
        await a.send(type="end", visit=la["id"])
        await c.send(type="end", visit=vc["id"])
        for _ in range(2):
            await b.until(lambda m: m["type"] == "visit_ended")
        await c.close()
        pc.terminate()
        await pc.wait()
        await a.until(lambda m: m["type"] == "lobby" and len(m["offices"]) == 2)
        await a.drain()
        await b.drain()
        await a.send(type="avatars", default="theirs")
        x = await a.until(lambda m: m["type"] == "avatars")
        await a.send(type="avatar_use", key=kb, use="mine")
        y = await a.until(lambda m: m["type"] == "avatars")
        check("A shows visitors' own looks by default, but B's as A's models: kept in its state file",
              (x["default"], y["by"], json.load(open(state))["avatars"]), ("theirs", [{"key": kb, "use": "mine"}], {"default": "theirs", "by": [{"key": kb, "use": "mine"}]}))
        await a.send(type="avatar_use", key=kb, use=None)
        await a.send(type="avatars", default="mine")
        z = [await a.until(lambda m: m["type"] == "avatars"), await a.until(lambda m: m["type"] == "avatars")][-1]
        check("and back: B with the default, the default A's models", (z["default"], z["by"]), ("mine", []))

        print("\naway: out of the lobby on purpose, and back")
        await a.drain()
        await b.drain()
        await b.send(type="knock", to=ids["A"])
        await a.send(type="answer", knock=(await a.expect("knock"))["id"], accept=True)
        await a.until(lambda m: m["type"] == "visit_started")
        await b.until(lambda m: m["type"] == "visit_started")
        await a.send(type="leave_lobby")
        off = await a.until(lambda m: m["type"] == "offline")
        check("A leaves the lobby: its page hears offline, away", off.get("away"), True)
        eb = await b.until(lambda m: m["type"] == "visit_ended")
        check("B's visit to A ends, `gone`", eb["reason"], "gone")
        lob = await b.until(lambda m: m["type"] == "lobby" and all(o["name"] != "A" for o in m["offices"]))
        check("and B's lobby no longer has A (it said bye: no resume window)", [o["name"] for o in lob["offices"]], ["B"])
        await a.send(type="knock", to=ids["B"])
        check("away, A cannot knock: refused `away`", (await a.expect("error", skip=("lobby", "visit_ended")))["code"], "away")
        check("A's state file says away", json.load(open(state))["away"], True)
        a2 = await Page(7411, ta).open()
        ra2 = await a2.expect("ready")
        check("a page connecting to A meanwhile: ready says away, not online", (ra2["away"], ra2["online"]), (True, False))
        a = a2
        pa.terminate()
        await asyncio.wait_for(pa.wait(), 5)
        pa, ta = await start_client("A", 7411, url, *a_flags)
        a = await Page(7411, ta).open()
        ra = await a.expect("ready")
        await a.send(type="host", three="128")
        await asyncio.sleep(1.5)
        check("A restarted with its state file: still away, and not in the lobby",
              (ra["away"], ra["online"], "a" in lobby.BY_NAME2), (True, False, False))
        check("and the same key as before: the same office to its friends", ra["key"], ka)
        await a.send(type="join_lobby")
        back = await a.until(lambda m: m["type"] == "offline")
        check("A joins again: its page hears it is no longer away", back.get("away"), False)
        on = await a.until(lambda m: m["type"] == "online")
        lob = await b.until(lambda m: m["type"] == "lobby" and any(o["name"] == "A" and o["ready"] for o in m["offices"]))
        check("then online, a new office, and B sees it (link published)", (on["office"]["name"], on["office"]["id"] != ids["A"]), ("A", True))
        check("A's state file says not away", json.load(open(state))["away"], False)
        await a.drain()
        pb.terminate()
        await asyncio.wait_for(pb.wait(), 5)
        check("B stopping exits 0", pb.returncode, 0)
        lob = await a.until(lambda m: m["type"] == "lobby", timeout=3)
        check("and leaves the lobby at once (bye), not after the resume window", [o["name"] for o in lob["offices"]], ["A"])
        pa.terminate()
        await asyncio.wait_for(pa.wait(), 5)

    print("\n%d failure(s)" % fails)
    if fails:
        logs()
    return 1 if fails else 0


def logs():
    for n in ("A", "B"):
        path = os.path.join(TMP, n + ".log")
        if os.path.exists(path):
            print("\n--- %s's log" % n)
            print(open(path).read()[-4000:])


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception:
        logs()
        raise
