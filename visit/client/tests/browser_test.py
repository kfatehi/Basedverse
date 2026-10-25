#!/usr/bin/env python3
"""visit.js in real browsers: the real lobby (in-process), two visit-clients, the test room (room.html) open
in two headless Chromes driven over the DevTools protocol. B knocks on A, walks around A's room with real
key presses, and both pages reload mid-visit. Run by run-browser.sh, which starts the Chromes.

    python3 browser_test.py path/to/visit-client CDP_PORT_A CDP_PORT_B OUT_DIR
"""
import asyncio
import base64
import functools
import http.server
import json
import os
import secrets
import sys
import tempfile
import threading
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "lobby", "server"))
import lobby  # noqa: E402
import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

BIN, CDP_A, CDP_B, OUT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
LOBBY_PORT, WEB_PORT, PORT_A, PORT_B = 18770, 18771, 7421, 7422
TMP = tempfile.mkdtemp()
fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("%s  %s%s" % ("ok  " if ok else "FAIL", label, "" if ok else "\n      got  %r\n      want %r" % (got, want)), flush=True)


class Tab:
    """One Chrome's page, over the DevTools protocol."""

    def __init__(self, port, name):
        self.port, self.name, self.n, self.pending, self.errors = port, name, 0, {}, []

    async def start(self):
        tabs = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % self.port))
        self.ws = await websockets.connect(next(t for t in tabs if t["type"] == "page")["webSocketDebuggerUrl"], max_size=50_000_000)
        self.reader = asyncio.create_task(self._read())
        await self.call("Runtime.enable")
        await self.call("Page.enable")
        await self.call("Emulation.setDeviceMetricsOverride", width=1280, height=720, deviceScaleFactor=1, mobile=False)

    async def _read(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if "id" in m and m["id"] in self.pending:
                self.pending.pop(m["id"]).set_result(m.get("result", {"error": m.get("error")}))
            elif m.get("method") == "Runtime.exceptionThrown":
                self.errors.append(m["params"]["exceptionDetails"].get("exception", {}).get("description", "?"))
            elif m.get("method") == "Runtime.consoleAPICalled" and m["params"]["type"] == "error":
                self.errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"]))

    async def call(self, method, **params):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        return await asyncio.wait_for(fut, 30)

    async def js(self, expr):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")

    async def until(self, expr, timeout=15):
        for _ in range(int(timeout * 5)):
            v = await self.js(expr)
            if v:
                return v
            await asyncio.sleep(0.2)
        return await self.js(expr)

    async def goto(self, url):
        await self.call("Page.navigate", url=url)

    async def key(self, code, key, vk, down):
        await self.call("Input.dispatchKeyEvent", type="keyDown" if down else "keyUp", code=code, key=key, windowsVirtualKeyCode=vk)

    async def shot(self, name):
        r = await self.call("Page.captureScreenshot", format="png")
        open(os.path.join(OUT, name), "wb").write(base64.b64decode(r["data"]))


async def start_client(name, port, url):
    token = secrets.token_hex(32)
    path = os.path.join(TMP, name + ".token")
    with open(path, "w") as f:
        f.write(token)
    p = await asyncio.create_subprocess_exec(BIN, "--lobby", url, "--name", name, "--sim", "test-room/1", "--port", str(port),
                                             "--token-file", path, "--relays", "none", stdout=asyncio.subprocess.PIPE,
                                             stderr=open(os.path.join(OUT, name + ".log"), "w"))
    await asyncio.wait_for(p.stdout.readline(), 10)
    return p, token


async def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    web = http.server.ThreadingHTTPServer(("127.0.0.1", WEB_PORT), handler)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    async with serve(lobby.handler, "127.0.0.1", LOBBY_PORT, max_size=lobby.LIMITS["frame"]):
        url = "ws://127.0.0.1:%d" % LOBBY_PORT
        (pa, ta), (pb, tb) = await start_client("A", PORT_A, url), await start_client("B", PORT_B, url)
        a, b = Tab(CDP_A, "A"), Tab(CDP_B, "B")
        await a.start()
        await b.start()
        room = "http://127.0.0.1:%d/room.html#port=%d&token=%s"
        await a.goto(room % (WEB_PORT, PORT_A, ta))
        await b.goto(room % (WEB_PORT, PORT_B, tb))

        print("\nconnecting")
        both = "window.v && v.state === 'online' && v.offices.filter(o => o.ready).length === 2"
        check("both rooms connect and see each other, ready", (bool(await a.until(both)), bool(await b.until(both))), (True, True))
        check("the token left the address bar", "token" in (await a.js("location.href")), False)

        print("\nknocking and letting in")
        await b.js("v.knock(v.offices.find(o => o.name === 'A').id, 'can I look around?')")
        check("A's panel shows the knock", await a.until("document.querySelector('.visit-panel .knock') && document.querySelector('.visit-panel .knock').textContent.includes('can I look around?')"), True)
        await a.js("document.querySelector('.visit-panel .knock button.go').click()")
        check("B is in A's room", await b.until("v.visiting && v.visiting.host.name"), "A")
        check("A has B as its visitor", await a.until("v.visitors.length && v.visitors[0].visitor.name"), "B")
        check("B's stage is up, full-window", await b.js("!document.querySelector('.visit-stage').hidden && document.querySelector('.visit-stage').classList.contains('big')"), True)

        print("\nvideo")
        frames = await b.until("(v.frames || 0) > 15 && v.frames", timeout=20)
        check("B decodes A's room (frames)", (frames or 0) > 15, True)
        codec = await a.js("[...v._hosted.values()][0].codec")
        check("in a codec both sides support (H.264 or VP8)", codec in ("avc1.42E01F", "vp8", "vp09.00.10.08"), True)
        size = await a.js("(h => [h.width, h.height])([...v._hosted.values()][0])")
        check("encoded at B's view size (1280x720, its stage)", size, [1280, 720])
        rate = await a.js("(async () => { const r0 = window.renders; await new Promise(r => setTimeout(r, 2000)); return (window.renders - r0) / 2; })()")
        check("A renders for B at up to 60 fps (at least 15 headless)", (rate or 0) >= 15, True)
        print("      (%s, %d renders a second)" % (codec, rate or 0))
        await b.shot("b_visiting.png")

        print("\nwalking")
        await a.js("window.panelChanges = 0; new MutationObserver(() => window.panelChanges++).observe(document.querySelector('.visit-panel'), { childList: true, subtree: true, characterData: true })")
        p0 = await a.js("v.visitors[0].pose")
        await b.call("Runtime.evaluate", expression="document.querySelector('.visit-stage canvas').focus()")
        await b.key("KeyW", "w", 87, True)
        await asyncio.sleep(1.0)
        await b.key("KeyW", "w", 87, False)
        await asyncio.sleep(0.3)
        p1 = await a.js("v.visitors[0].pose")
        check("holding W walks B forward (toward -z) in A's room", (round(p1["x"], 1) == round(p0["x"], 1), 1.5 < p0["z"] - p1["z"] < 3.5), (True, True))
        check("A's panel stays as it is while B walks (its menus stay open, its buttons take clicks)", await a.js("window.panelChanges"), 0)
        await b.js("v._view.yaw = Math.PI / 2")
        await asyncio.sleep(0.3)
        check("turning B's view turns B in A's room", round(await a.js("v.visitors[0].pose.yaw"), 2), round(3.14159 / 2, 2))
        await b.key("KeyW", "w", 87, True)
        await asyncio.sleep(1.5)
        await b.key("KeyW", "w", 87, False)
        await asyncio.sleep(0.3)
        p2 = await a.js("v.visitors[0].pose")
        check("facing left now, W walks toward -x, stopped by A's wall", (p2["x"] < p1["x"], p2["x"] >= 0.3), (True, True))
        await b.shot("b_walked.png")

        print("\nlatency")
        st = await b.until("v.stats.latency != null && v.stats.path && v.stats.fps > 0 && v.stats", timeout=10)
        check("B measures input to screen (A's frames carry B's input time back), the link's path, its frame rate",
              (st["latency"] > 0, st["path"], st["fps"] > 0), (True, "direct", True))
        check("input to screen under 300 ms, two software-rendering headless browsers on one machine", st["latency"] < 300, True)
        print("      (input to screen %d ms, link %.1f ms, %s, %d fps)" % (st["latency"], st["rtt"] or 0, st["path"], st["fps"]))
        check("A was told the camera's field of view, for B's turning between frames", await b.js("v._viewer.fov"), 70)
        check("the stage shows those numbers", await b.js("document.querySelector('.visit-stage .stats').textContent.includes('input to screen')"), True)

        print("\npicture in picture")
        await b.js("document.querySelector('.visit-stage button[data-s=small]').click()")
        check("Back to my room: A's room shrinks to a corner, and takes no keys", await b.js("[document.querySelector('.visit-stage').classList.contains('small'), v.viewFocused]"), [True, False])
        q0 = await a.js("v.visitors[0].pose")
        await b.key("KeyW", "w", 87, True)
        await asyncio.sleep(0.6)
        await b.key("KeyW", "w", 87, False)
        await asyncio.sleep(0.3)
        q1 = await a.js("v.visitors[0].pose")
        check("W then walks nobody in A's room (B's own room has the keys)", (round(q1["x"], 2), round(q1["z"], 2)), (round(q0["x"], 2), round(q0["z"], 2)))
        await b.js("document.querySelector('.visit-stage').click()")
        check("a click on the corner: back to A's room, full-window, with the keys", await b.js("[document.querySelector('.visit-stage').classList.contains('big'), v.viewFocused]"), [True, True])

        print("\nreloads")
        f0 = await b.js("v.frames")
        await b.js("window.sawPause = false; v.on('change', () => { if (v.visiting && v.visiting.paused) window.sawPause = true; })")
        await a.call("Page.reload")
        check("A reloading: B sees its host paused", await b.until("window.sawPause"), True)
        check("A back: B's host resumes", await b.until("v.visiting && !v.visiting.paused"), True)
        check("and B's frames flow again", bool(await b.until("v.frames > %d + 15" % f0, timeout=20)), True)
        check("A kept B where it was", round((await a.until("v.visitors.length && v.visitors[0].pose && v.visitors[0].pose.x")) or 0, 1), round(p2["x"], 1))
        await b.call("Page.reload")
        check("B reloading comes back still in A's room", await b.until("window.v && v.visiting && v.visiting.host.name"), "A")
        check("and decodes again", bool(await b.until("(v.frames || 0) > 15", timeout=20)), True)

        print("\nleaving")
        await b.js("document.querySelector('.visit-stage button[data-s=leave]').click()")
        check("B leaves: its stage goes", await b.until("!v.visiting && document.querySelector('.visit-stage').hidden"), True)
        check("and A has no visitors", await a.until("v.visitors.length === 0"), True)

        print("\ngoing offline from the panel, and back")
        await a.js("document.querySelector('.visit-panel button[data-v=away]').click()")
        check("A clicks Go offline: A is away", await a.until("v.state === 'away' && v.state"), "away")
        check("and B's lobby no longer lists A", await b.until("!v.offices.some(o => o.name === 'A')"), True)
        check("A's panel offers Go online, and lists nobody", await a.until("!!document.querySelector('.visit-panel button[data-v=back]') && v.offices.length === 0"), True)
        await a.js("document.querySelector('.visit-panel button[data-v=back]').click()")
        check("A clicks Go online: online again", await a.until("v.state === 'online' && v.state"), "online")
        check("and B sees A again, ready to visit", await b.until("v.offices.some(o => o.name === 'A' && o.ready)"), True)
        check("no errors in either page", (a.errors, b.errors), ([], []))
        for p in (pa, pb):
            p.terminate()
            await p.wait()
    web.shutdown()
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
