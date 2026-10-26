#!/usr/bin/env python3
"""visit.js in real browsers: the real lobby (in-process), two visit-clients, the test room (room.html, three.js)
open in two headless Chromes driven over the DevTools protocol. B knocks on A, draws A's scene, walks around
it with real key presses, sees what A changes, and both pages reload mid-visit. Run by run-browser.sh, which
starts the Chromes.

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
        check("both rooms connect, host their scenes, and see each other, ready", (bool(await a.until(both, 30)), bool(await b.until(both, 30))), (True, True))
        check("the token left the address bar", "token" in (await a.js("location.href")), False)

        print("\nknocking and letting in")
        await b.js("v.knock(v.offices.find(o => o.name === 'A').id, 'can I look around?')")
        check("A's panel shows the knock", await a.until("document.querySelector('.visit-panel .knock') && document.querySelector('.visit-panel .knock').textContent.includes('can I look around?')"), True)
        await a.js("document.querySelector('.visit-panel .knock button.go').click()")
        check("B is in A's room", await b.until("v.visiting && v.visiting.host.name"), "A")
        check("A has B as its visitor", await a.until("v.visitors.length && v.visitors[0].visitor.name"), "B")
        check("and move() is told whose pose it moves", await a.until("window.movedFor === v.visitors[0].id"), True)
        check("B's stage is up, full-window", await b.js("!document.querySelector('.visit-stage').hidden && document.querySelector('.visit-stage').classList.contains('big')"), True)

        print("\nA's scene, drawn by B's own browser")
        check("B draws A's scene (three.js r128, fetched and checked against its hash)", bool(await b.until("!!(v._viewer && v._viewer.scene) && v.frames > 30", 30)), True)
        n = await a.js("(() => { let n = 0; room.scene.traverse(() => n++); return n; })()")
        got = await b.until("v._viewer.scene && (() => { let n = 0; v._viewer.scene.root.traverse(() => n++); return n; })()")
        check("B has every object of A's scene (B's own body is one of them)", got, n)
        check("B's own body is there, not drawn in its own eyes", await b.until("(s => s.own.length === 1 && !s.own[0].visible)(v._viewer.scene)"), True)
        check("A's renderer settings came along (shadows)", await b.js("v._viewer.scene.renderer.shadowMap.enabled"), True)
        check("A's sun aims where A's does (its target, in the scene)", await b.js(
            "(s => { let l; s.root.traverse(o => { if (o.isDirectionalLight) l = o; }); return l && l.target.parent === s.root && l.target.position.toArray(); })(v._viewer.scene)"), [5, 0, 4])
        await b.shot("b_visiting.png")

        print("\nwalking, at once")
        await a.js("window.panelChanges = 0; new MutationObserver(() => window.panelChanges++).observe(document.querySelector('.visit-panel'), { childList: true, subtree: true, characterData: true })")
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
        check("A walked B as far, forward (toward -z): its answer", (round(a1["x"], 1) == round(a0["x"], 1), 1.5 < a0["z"] - a1["z"] < 3.5), (True, True))
        check("and B's own idea of where it is agrees with A's", (abs(p1["x"] - a1["x"]) < 0.15, abs(p1["z"] - a1["z"]) < 0.15), (True, True))
        check("A's panel stays as it is while B walks (its menus stay open, its buttons take clicks)", await a.js("window.panelChanges"), 0)
        await b.js("v._view.yaw = Math.PI / 2; v._sendInput(performance.now(), true)")
        await asyncio.sleep(0.3)
        check("turning B's view turns B in A's room", round(await a.js("v.visitors[0].pose.yaw"), 2), round(3.14159 / 2, 2))
        await b.key("KeyW", "w", 87, True)
        await asyncio.sleep(2.5)
        await b.key("KeyW", "w", 87, False)
        await asyncio.sleep(0.8)
        p2 = await b.js("({ ...v._viewer.scene.pose })")
        a2 = await a.js("({ ...v.visitors[0].pose })")
        check("into A's wall: A stops B, and B's view is put right (no walking through)", (a2["x"] >= 0.3, abs(p2["x"] - a2["x"]) < 0.15), (True, True))
        st = await b.until("v.stats.latency != null && v.stats.path && v.stats.fps > 0 && v.stats", timeout=10)
        check("B's numbers: input to screen, the link's path, frames drawn", (st["latency"] > 0, st["path"], st["fps"] > 0), (True, "direct", True))
        check("input to screen, drawn here: a frame's time, not a round trip's (under 50 ms)", st["latency"] < 50, True)
        check("the stage shows them", await b.js("document.querySelector('.visit-stage .stats').textContent.includes('input to screen')"), True)
        print("      (input to screen %d ms, link %.1f ms, %d fps)" % (st["latency"], st["rtt"] or 0, st["fps"]))
        await b.shot("b_walked.png")

        print("\nwhat changes in A's room")
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
        sign = json.dumps(await a.js("room.sign.uuid"))
        v0 = await b.js("v._viewer.scene.root.getObjectByProperty('uuid', %s).material.map.version" % sign)
        await a.js("room.write('changed')")
        check("A redraws its sign: B's sign is redrawn", await b.until("v._viewer.scene.root.getObjectByProperty('uuid', %s).material.map.version > %d" % (sign, v0)), True)
        await a.js("room.scene.background.setHex(0x334455)")
        check("A's background changes: B's too", await b.until("v._viewer.scene.root.background.getHex() === 0x334455"), True)
        su = await a.js("room.shader()")
        check("a ShaderMaterial (a program) reaches B as plain grey, not as code", await b.until(
            "(o => o && o.material.type)(v._viewer.scene.root.getObjectByProperty('uuid', %s))" % json.dumps(su)), "MeshLambertMaterial")

        print("\npointing")
        keys = await b.js("(() => { const k = new Set(); v._viewer.scene.root.traverse(o => Object.keys(o.userData || {}).forEach(x => k.add(x))); return [...k].sort(); })()")
        check("B's copy of A's scene has none of A's own userData: only what Visit reads", keys, ["visitPoint", "visitor"])
        check("the cube A marked as one to point at", await b.js("v._viewer.scene.root.getObjectByName('spinner').userData"), {"visitPoint": True})
        await a.js("room.frozen = true; room.spinner.position.set(%f, 1.4, %f)" % (a2["x"] + 1.5, a2["z"] - 1.5))
        await asyncio.sleep(0.5)
        look = """(() => { const s = v._viewer.scene, o = s.root.getObjectByName('spinner'), dx = o.position.x - s.pose.x, dy = o.position.y - s.pose.y,
          dz = o.position.z - s.pose.z; v._view.yaw = Math.atan2(-dx, -dz) - s.yaw0 + %s; v._view.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          v._sendInput(performance.now(), true); v._view.cross.style.display = 'block'; return true; })()"""
        await b.js(look % "0")
        check("looking at it, B's crosshair is hot", bool(await b.until("!!v._view.cross.style.background")), True)
        await b.js(look % "Math.PI")
        check("looking away, it is not", await b.until("!v._view.cross.style.background"), True)
        await b.js(look % "0")
        await asyncio.sleep(0.3)
        await b.js("v._pointNow()")
        pt = await a.until("window.points.length && window.points[0]")
        pose = await a.js("({ ...v.visitors[0].pose })")
        check("B points: A hears it, from where A has B, toward the cube: A's ray hits it",
              (pt["visitor"]["name"], [round(x, 2) for x in pt["from"]], round(sum(x * x for x in pt["dir"]), 3), pt["hit"]),
              ("B", [round(pose[k], 2) for k in "xyz"], 1.0, "spinner"))
        await asyncio.sleep(0.25)   # past the first point's 200 ms: one of the ten may go, and only one
        await b.js("for (let i = 0; i < 10; i++) v._pointNow()")
        await asyncio.sleep(0.6)
        check("ten points at once from B: its page sends one of them (one every 200 ms at most)", await a.js("window.points.length"), 2)
        await b.js("v._view.cross.style.display = 'none'")
        await a.js("room.frozen = false")

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
        check("and the corner still draws A's room", bool(await b.until("(f => new Promise(r => setTimeout(() => r(v.frames > f + 10), 600)))(v.frames)")), True)
        await b.js("document.querySelector('.visit-stage').click()")
        check("a click on the corner: back to A's room, full-window, with the keys", await b.js("[document.querySelector('.visit-stage').classList.contains('big'), v.viewFocused]"), [True, True])

        print("\nreloads")
        await b.js("window.sawPause = false; v.on('change', () => { if (v.visiting && v.visiting.paused) window.sawPause = true; })")
        await a.call("Page.reload")
        check("A reloading: B sees its host paused", await b.until("window.sawPause"), True)
        check("A back: B's host resumes, and B gets A's scene again", bool(await b.until(
            "v.visiting && !v.visiting.paused && v._viewer.scene && !!v._viewer.scene.root.getObjectByName('spinner')", 30)), True)
        check("A kept B where it was", round((await a.until("v.visitors.length && v.visitors[0].pose && v.visitors[0].pose.x")) or 0, 1), round(a2["x"], 1))
        await b.call("Page.reload")
        check("B reloading comes back still in A's room", await b.until("window.v && v.visiting && v.visiting.host.name", 30), "A")
        check("and draws it again", bool(await b.until("!!(v._viewer && v._viewer.scene) && v.frames > 15", 30)), True)

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

        print("\nwhat a host sends is only data")
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
        check("a room whose three.js visit.js does not know cannot host", await b.js(
            "(() => { try { v.host({ spawn() {}, move() {}, scene: { root: room.scene, three: { REVISION: '99' } } }); return 'hosted'; } catch (e) { return e.message.slice(0, 30); } })()"),
            "visit.host: three.js r99 is no")
        check("no errors in either page", (a.errors, b.errors), ([], []))
        for p in (pa, pb):
            p.terminate()
            await p.wait()
    web.shutdown()
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
