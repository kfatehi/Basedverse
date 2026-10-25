#!/usr/bin/env python3
"""visit-client end to end: the real lobby (in-process), two real visit-clients (A hosts, B visits) and
two stand-in pages speaking basedverse-visit-local/1 (../../SPEC.md section 5). Everything on this
machine's loopback; the visit-clients link directly (no relay).

    python3 e2e.py path/to/visit-client [B's]   (run-e2e.sh runs it in a container; a second binary runs B,
                                                 to try two versions together)
"""
import asyncio
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
BIN_B = sys.argv[2] if len(sys.argv) > 2 else BIN
OLD_B = BIN_B != BIN   # B is an older visit-client (0.2): the checks of what only 0.3 does become checks it still works
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
        await self.send(type="hello", proto="basedverse-visit-local/1", token=token or self.token, sim={"name": "e2e", "version": "1"})
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

    async def expect(self, type_, timeout=10, skip=("lobby", "bitrate", "online", "knock_sent", "link_stats")):
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
    check("%s prints its ready line" % name, (ready["ready"], ready["port"], ready["proto"]), (True, port, "basedverse-visit-local/1"))
    return p, token


def frame(channel, key, ts, payload):
    return struct.pack(">HBQ", channel, 1 if key else 0, ts) + payload


def frame_meta(channel, key, ts, meta, payload):
    return struct.pack(">HBQ", channel, (1 if key else 0) | 2, ts) + meta + payload


def unframe(b):
    channel, flags, ts = struct.unpack(">HBQ", b[:11])
    return (channel, bool(flags & 1), ts, b[27:]) if flags & 2 else (channel, bool(flags & 1), ts, b[11:])


def meta_of(b):
    return b[11:27] if struct.unpack(">B", b[2:3])[0] & 2 else None


async def main():
    # Pings every second, dropping a connection that does not answer within one: the keepalive check below.
    async with serve(lobby.handler, "127.0.0.1", 0, max_size=lobby.LIMITS["frame"], process_request=lobby.health,
                     ping_interval=1, ping_timeout=1) as server:
        url = "ws://127.0.0.1:%d" % server.sockets[0].getsockname()[1]
        state = os.path.join(TMP, "A.state.json")   # where A keeps whether it is away
        a_flags = ("--origins", "http://room.test", "--state-file", state)
        (pa, ta), (pb, tb) = await start_client("A", 7411, url, *a_flags), await start_client("B", 7412, url, binary=BIN_B)

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
        check("ready: the version, limits, no visits, not away", (ra["version"], ra["limits"]["fps"], ra["visits"], ra["away"]), (VERSION, 60, [], False))
        both = lambda m: m["type"] == "lobby" and sum(o["ready"] for o in m["offices"]) == 2
        lob = await a.until(both)
        await b.until(both)
        ids = {o["name"]: o["id"] for o in lob["offices"]}
        check("both offices in the lobby, each with its link published", sorted(ids), ["A", "B"])
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

        print("\nvisitor to host: decoders, viewport, input, keyframe")
        await b.send(type="decoders", codecs=["avc1.42E01F", "vp8"])
        await b.send(type="viewport", width=1600, height=900)
        d, vp = await a.expect("decoders"), await a.expect("viewport")
        check("A's page hears what B decodes and B's view size, on A's channel", (d["channel"], d["codecs"], vp["width"], vp["height"]), (cha, ["avc1.42E01F", "vp8"], 1600, 900))
        await b.send(type="input", forward=1, strafe=-1, run=True, yaw=0.5, pitch=9, t=12345.5)
        i = await a.expect("input")
        check("B's input reaches A's page, clamped", (i["channel"], i["forward"], i["strafe"], i["run"], i["yaw"], i["pitch"]), (cha, 1, -1, True, 0.5, 1.4))
        check("with B's time on it, for A's frames to carry back" if not OLD_B else "an older B sends no time: A's page gets 0", i["t"], 0.0 if OLD_B else 12345.5)
        await a.drain()
        for _ in range(5):
            await b.send(type="keyframe", channel=chb)
        await asyncio.sleep(0.3)
        keys = []
        while not a.texts.empty():
            m = a.texts.get_nowait()
            if m and m["type"] == "keyframe":
                keys.append(m["channel"])
        check("B asking for a keyframe five times at once: A's page is asked once (they cost its machine)", keys, [cha])
        sa_stats = await a.until(lambda m: m["type"] == "link_stats", timeout=4)
        sb_stats = {"channel": chb, "path": "direct", "rtt_ms": 0} if OLD_B else await b.until(lambda m: m["type"] == "link_stats", timeout=4)
        check("both pages hear the link's path and round trip, about once a second: direct here" + (" (A's only: B is older)" if OLD_B else ""),
              (sa_stats["channel"], sa_stats["path"], sb_stats["channel"], sb_stats["path"], 0 <= sb_stats["rtt_ms"] < 100), (cha, "direct", chb, "direct", True))

        print("\nhost to visitor: video")
        await a.send(type="video_config", channel=cha, codec="vp8", width=1280, height=720)
        vc = await b.expect("video_config")
        check("A's encoder settings reach B, on B's channel", (vc["channel"], vc["codec"], vc["width"]), (chb, "vp8", 1280))
        sent = [frame(cha, n % 10 == 0, 1000 * n, secrets.token_bytes(200 + n)) for n in range(25)]
        for f in sent:   # paced, as a page encoding its room sends them
            await a.ws.send(f)
            await asyncio.sleep(0.01)
        got = [unframe(await asyncio.wait_for(b.frames.get(), 5)) for _ in range(25)]
        check("25 frames, in order, keyframes marked, on B's channel",
              [(g[0], g[1], g[2], g[3]) for g in got], [(chb,) + unframe(f)[1:] for f in sent])
        # Three groups of pictures at once: a newer group abandons the older, so nothing older than a
        # keyframe ever follows it, and the newest group arrives whole.
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
        check("a burst: never an older frame after a newer one", ts == sorted(ts), True)
        check("and the newest group of pictures whole", ts[-4:], [58_000, 59_000, 60_000, 61_000])
        meta = struct.pack(">dff", 4242.25, 0.5, -0.25)
        await a.ws.send(frame_meta(cha, False, 70_000, meta, b"with meta"))
        got = await asyncio.wait_for(b.frames.get(), 5)
        if OLD_B:
            check("a frame with meta reaches an older B without it (B's handshake did not ask), the chunk whole", (unframe(got)[3], meta_of(got)), (b"with meta", None))
        else:
            check("a frame with meta (the input it shows, the look it was drawn at) reaches B whole",
                  (unframe(got)[3], meta_of(got) and struct.unpack(">dff", meta_of(got))), (b"with meta", (4242.25, 0.5, -0.25)))
        bitrate = await a.until(lambda m: m["type"] == "bitrate", timeout=4)
        check("A's page is told a bitrate for the visit", (bitrate["channel"], 300_000 <= bitrate["bps"] <= 6_000_000), (cha, True))

        print("\nreloads")
        await a.send(type="pose", channel=cha, state={"pose": {"x": 1.5, "z": 2}, "yaw0": 0})
        await asyncio.sleep(0.2)
        await a.close()
        check("A's page goes: B hears its host paused", (await b.expect("host_paused"))["channel"], chb)
        a = await Page(7411, ta).open()
        ra = await a.expect("ready")
        check("A's page back: ready lists the visit", [(v["id"], v["role"], v["channel"]) for v in ra["visits"]], [(vid, "host", cha)])
        check("with where B stood, as A's page last said", ra["visits"][0].get("state"), {"pose": {"x": 1.5, "z": 2}, "yaw0": 0})
        d2, vp2 = await a.expect("decoders"), await a.expect("viewport")
        check("and what B decodes and its view size again, to encode for", (d2["codecs"], vp2["width"]), (["avc1.42E01F", "vp8"], 1600))
        check("and B hears its host resumed", (await b.expect("host_resumed"))["channel"], chb)
        await a.ws.send(frame(cha, True, 99_000, b"after the reload"))
        check("frames flow again", unframe(await asyncio.wait_for(b.frames.get(), 5))[3], b"after the reload")
        await b.close()
        b = await Page(7412, tb).open()
        rb = await b.expect("ready")
        check("B's page back: still visiting", [(v["id"], v["role"]) for v in rb["visits"]], [(vid, "visitor")])
        check("with A's encoder settings again", (await b.expect("video_config"))["codec"], "vp8")
        check("and A is asked for a keyframe to start B's decoder", (await a.until(lambda m: m["type"] == "keyframe"))["channel"], cha)
        c = await Page(7411, ta).open()
        await c.expect("ready")
        await asyncio.sleep(0.3)
        check("a second page on A takes over; the first is closed 4409", a.ws.close_code, 4409)
        a = c

        print("\nthe lobby connection drops and resumes")
        await a.drain()
        await b.drain()
        office_b = lobby.OFFICES2[ids["B"]]
        await office_b.ws.close()
        check("B's page hears it is offline", (await b.until(lambda m: m["type"] in ("offline", "online")))["type"], "offline")
        on = await b.until(lambda m: m["type"] == "online", timeout=10)
        check("then online again as the same office", on["office"]["id"], ids["B"])
        await a.ws.send(frame(cha, True, 200_000, b"still linked"))
        check("the visit never noticed: frames still flow", unframe(await asyncio.wait_for(b.frames.get(), 5))[3], b"still linked")

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
        check("A's state file says away", json.load(open(state)), {"away": True})
        a2 = await Page(7411, ta).open()
        ra2 = await a2.expect("ready")
        check("a page connecting to A meanwhile: ready says away, not online", (ra2["away"], ra2["online"]), (True, False))
        a = a2
        pa.terminate()
        await asyncio.wait_for(pa.wait(), 5)
        pa, ta = await start_client("A", 7411, url, *a_flags)
        a = await Page(7411, ta).open()
        ra = await a.expect("ready")
        await asyncio.sleep(1.5)
        check("A restarted with its state file: still away, and not in the lobby",
              (ra["away"], ra["online"], "a" in lobby.BY_NAME2), (True, False, False))
        await a.send(type="join_lobby")
        back = await a.until(lambda m: m["type"] == "offline")
        check("A joins again: its page hears it is no longer away", back.get("away"), False)
        on = await a.until(lambda m: m["type"] == "online")
        lob = await b.until(lambda m: m["type"] == "lobby" and any(o["name"] == "A" and o["ready"] for o in m["offices"]))
        check("then online, a new office, and B sees it (link published)", (on["office"]["name"], on["office"]["id"] != ids["A"]), ("A", True))
        check("A's state file says not away", json.load(open(state)), {"away": False})
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
