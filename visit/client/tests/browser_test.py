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


async def scenes(a, b, room_a, room_b):
    """The same, with A's room in three.js: B's page draws A's scene itself (SPEC 8.3)."""
    print("\nscenes: A's room in three.js, drawn by B's own browser")
    three = lambda url: url.replace("room.html#", "room.html?three=1#")
    await a.goto(three(room_a))
    await b.goto(three(room_b))
    both = "window.v && v.state === 'online' && v.offices.filter(o => o.ready).length === 2 && !!window.room"
    check("both three.js rooms connect", (bool(await a.until(both, 30)), bool(await b.until(both, 30))), (True, True))
    await b.js("v.knock(v.offices.find(o => o.name === 'A').id)")
    await a.until("v.knocks.length > 0")
    await a.js("v.answer(v.knocks[0].id, true)")
    check("B is in A's room", await b.until("v.visiting && v.visiting.host.name"), "A")
    check("B draws A's scene (three.js r128, fetched and checked against its hash)", await b.until("v.stats.mode", 30), "scene")
    check("A sends B its scene, not video: no encoder", await a.js("(h => [h.mode, h.encoder])([...v._hosted.values()][0])"), ["scene", None])
    n = await a.js("(() => { let n = 0; room.scene.traverse(() => n++); return n; })()")
    got = await b.until("v._viewer.scene && (() => { let n = 0; v._viewer.scene.root.traverse(() => n++); return n; })()")
    check("B has every object of A's scene (B's own body is one of them)", got, n)
    check("B's own body is there, not drawn in its own eyes", await b.until("(s => s.own.length === 1 && !s.own[0].visible)(v._viewer.scene)"), True)
    check("A's renderer settings came along (shadows)", await b.js("v._viewer.scene.renderer.shadowMap.enabled"), True)
    check("A's sun aims where A's does (its target, in the scene)", await b.js(
        "(s => { let l; s.root.traverse(o => { if (o.isDirectionalLight) l = o; }); return l && l.target.parent === s.root && l.target.position.toArray(); })(v._viewer.scene)"), [5, 0, 4])
    await b.until("v.frames > 30", 20)
    await b.shot("b_scene.png")

    print("\nscenes: walking, at once")
    await b.call("Runtime.evaluate", expression="document.querySelector('.visit-stage canvas:not([style*=none])').focus()")
    p0 = await b.js("({ ...v._viewer.scene.pose })")
    a0 = await a.js("({ ...v.visitors[0].pose })")
    await b.key("KeyW", "w", 87, True)
    await asyncio.sleep(0.12)
    early = await b.js("({ ...v._viewer.scene.pose })")
    check("B walks in its own view at once, before A's answer (120 ms in)", p0["z"] - early["z"] > 0.1, True)
    await asyncio.sleep(0.9)
    await b.key("KeyW", "w", 87, False)
    await asyncio.sleep(0.6)
    p1 = await b.js("({ ...v._viewer.scene.pose })")
    a1 = await a.js("({ ...v.visitors[0].pose })")
    check("A walked B as far (its answer)", 1.5 < a0["z"] - a1["z"] < 3.5, True)
    check("and B's own idea of where it is agrees with A's", (abs(p1["x"] - a1["x"]) < 0.15, abs(p1["z"] - a1["z"]) < 0.15), (True, True))
    await b.js("v._view.yaw = Math.PI / 2")
    await b.key("KeyW", "w", 87, True)
    await asyncio.sleep(2.5)
    await b.key("KeyW", "w", 87, False)
    await asyncio.sleep(0.8)
    p2 = await b.js("({ ...v._viewer.scene.pose })")
    a2 = await a.js("({ ...v.visitors[0].pose })")
    check("into A's wall: A stops B, and B's view is put right (no walking through)", (a2["x"] >= 0.3, abs(p2["x"] - a2["x"]) < 0.15), (True, True))
    st = await b.until("v.stats.latency != null && v.stats.fps > 0 && v.stats", timeout=10)
    check("input to screen, drawn here: a frame's time, not a round trip's (under 50 ms)", st["latency"] < 50, True)
    check("the stage says it is drawn here", await b.js("document.querySelector('.visit-stage .stats').textContent.includes('drawn here')"), True)
    print("      (input to screen %d ms, %d fps)" % (st["latency"], st["fps"]))

    print("\nscenes: what changes in A's room")
    spin = "(() => { const o = v._viewer.scene.root.getObjectByName('spinner'); return o && o.position.toArray(); })()"
    s0 = await b.js(spin)
    await asyncio.sleep(0.5)
    s1 = await b.js(spin)
    check("A's spinning cube moves in B's view too", s0 != s1 and s1 is not None, True)
    await a.js("room.frozen = true")
    await asyncio.sleep(0.6)
    check("where A stopped it, B shows it", [round(x, 2) for x in await b.js(spin)], [round(x, 2) for x in await a.js("room.spinner.position.toArray()")])
    await a.js("room.frozen = false")
    await a.js("room.spinner.material.color.setHex(0xff0000)")
    check("A colours it red: red in B's view", await b.until("v._viewer.scene.root.getObjectByName('spinner').material.color.getHex() === 0xff0000"), True)
    uuid = await a.js("room.add('newcomer')")
    check("A adds an object: B has it", await b.until("!!v._viewer.scene.root.getObjectByProperty('uuid', %s)" % json.dumps(uuid)), True)
    await a.js("room.remove('newcomer')")
    check("A takes it away: gone from B's", await b.until("!v._viewer.scene.root.getObjectByProperty('uuid', %s)" % json.dumps(uuid)), True)
    v0 = await b.js("v._viewer.scene.root.getObjectByProperty('uuid', %s).material.map.version" % json.dumps(await a.js("room.sign.uuid")))
    await a.js("room.write('changed')")
    check("A redraws its sign: B's sign is redrawn", await b.until("v._viewer.scene.root.getObjectByProperty('uuid', %s).material.map.version > %d" % (json.dumps(await a.js("room.sign.uuid")), v0)), True)
    await a.js("room.scene.background.setHex(0x334455)")
    check("A's background changes: B's too", await b.until("v._viewer.scene.root.background.getHex() === 0x334455"), True)
    su = await a.js("room.shader()")
    check("a ShaderMaterial (a program) reaches B as plain grey, not as code", await b.until(
        "(o => o && o.material.type)(v._viewer.scene.root.getObjectByProperty('uuid', %s))" % json.dumps(su)), "MeshLambertMaterial")
    await b.shot("b_scene_changed.png")

    print("\nscenes: reloads")
    await a.call("Page.reload")
    check("A reloads: B gets A's scene again, still drawing it", bool(await b.until("v.visiting && !v.visiting.paused && v.stats.mode === 'scene' && v._viewer.scene && !!v._viewer.scene.root.getObjectByName('spinner')", 30)), True)
    await b.call("Page.reload")
    check("B reloads: back in A's room, drawing its scene", await b.until("window.v && v.visiting && v.stats.mode", 30), "scene")
    await b.js("v.leave()")
    await a.until("v.visitors.length === 0")

    print("\nscenes: a page that draws none gets video")
    await b.goto(three(room_b).replace("three=1", "three=1&scenes=0"))
    await b.until("window.v && v.state === 'online' && v.offices.some(o => o.name === 'A' && o.ready)", 30)
    await b.js("v.knock(v.offices.find(o => o.name === 'A').id)")
    await a.until("v.knocks.length > 0")
    await a.js("v.answer(v.knocks[0].id, true)")
    check("B (scenes: false) decodes A's three.js room as video", bool(await b.until("(v.frames || 0) > 15 && !v.stats.mode", 30)), True)
    check("A encodes for it", await a.js("(h => [h.mode, !!h.encoder])([...v._hosted.values()][0])"), ["video", True])
    await b.js("v.leave()")
    await a.until("v.visitors.length === 0")
    print("\nscenes: what a host sends is only data")
    r = await b.js("""(() => { const c = Visit._test.cleanScene, budget = { vertices: 0, objects: 0 };
      const j = c({ materials: [{ uuid: "m", type: "RawShaderMaterial", vertexShader: "x" }],
        geometries: [{ uuid: "g", type: "SphereGeometry", parameters: { widthSegments: 1e9, heightSegments: 1e9 } }],
        images: [{ uuid: "i", url: "https://example.com/x.png" }, { uuid: "j", url: [1, { data: [1], width: 9999, height: 1, type: "Uint8Array" }] }],
        object: { type: "Scene", children: [{ type: "Mesh" }, 5] } }, budget);
      return [j.materials[0].type, j.geometries[0].parameters.widthSegments, j.images[0].url.slice(0, 15), j.images[1].url.map(u => typeof u === "string" ? u.slice(0, 15) : u), j.object.children.length, budget.objects]; })()""")
    check("cleanScene: a shader becomes grey, segments are capped, only data-URL images of a sane size, junk objects dropped", r,
          ["MeshLambertMaterial", 256, "data:image/png;", ["data:image/png;", "data:image/png;"], 1, 2])
    big = "data:image/png;base64," + base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452") + (20000).to_bytes(4, "big") + (20000).to_bytes(4, "big") + b"\x08\x06\x00\x00\x00").decode()
    check("an image's size is read from its header, before anything decodes it", await b.js("Visit._test.imageDims(%s)" % json.dumps(big)), [20000, 20000])


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

        await scenes(a, b, room % (WEB_PORT, PORT_A, ta), room % (WEB_PORT, PORT_B, tb))
        check("no errors in either page, with scenes", (a.errors, b.errors), ([], []))
        for p in (pa, pb):
            p.terminate()
            await p.wait()
    web.shutdown()
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
