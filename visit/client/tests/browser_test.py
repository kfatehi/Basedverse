#!/usr/bin/env python3
"""visit.js in real browsers: the real lobby (in-process), two visit-clients, the test room (room.html, three.js)
open in two headless Chromes driven over the DevTools protocol, A's made with three.js r128 and B's with r160.
B knocks on A, draws A's scene, walks around it with real key presses, sees what A changes, and both pages
reload mid-visit. Then worlds: each draws the other's plot round its own, walks onto it and off, sees where the
other has put it (and nothing else of the other's world), puts the other flush against its own and walks across,
and loses it when the door shuts. Last, links: A sees B's room in a corner, goes
there, comes back, puts it in its world, and unlinks. Run by run-browser.sh, which starts the Chromes.

    python3 browser_test.py path/to/visit-client CDP_PORT_A CDP_PORT_B OUT_DIR
"""
import asyncio
import base64
import functools
import http.server
import json
import math
import os
import re
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
                d = m["params"]["exceptionDetails"]
                self.errors.append(d.get("exception", {}).get("description") or "%s (line %s)" % (d.get("text", "?"), d.get("lineNumber")))
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
    database = "%s/%s" % (os.environ["VISIT_TEST_DB"], name.lower())   # run-browser.sh's Postgres: made ready first
    m = await asyncio.create_subprocess_exec(BIN, "migrate", "--database", database, stdout=asyncio.subprocess.DEVNULL)
    assert await m.wait() == 0, "visit-client migrate failed"
    p = await asyncio.create_subprocess_exec(BIN, "--lobby", url, "--name", name, "--sim", "test-room/1", "--port", str(port),
                                             "--token-file", path, "--relays", "none", "--database", database, stdout=asyncio.subprocess.PIPE,
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
        # A's room is made with three.js r128, B's with r160: each draws the other's with its own (a world), or with
        # the other's very release (a visit).
        room = "http://127.0.0.1:%d/room.html%s#port=%d&token=%s"
        await a.goto(room % (WEB_PORT, "", PORT_A, ta))
        await b.goto(room % (WEB_PORT, "?three=160", PORT_B, tb))

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
        got = await b.until("v._viewer.scene && (n => n === %d && n)((() => { let n = 0; v._viewer.scene.root.traverse(() => n++); return n; })())" % n)
        check("B has every object of A's scene (B's own body is one of them), its landscape too", got, n)
        check("A's floor, walls and desk came apart, as A's landscape: read once by B, each where A has it", await b.until(
            "(l => !!l && !!l.objs && l.objs.length === 6 && l.objs.every(o => o.parent === v._viewer.scene.root))(v._viewer.land)"), True)
        land_a = await a.until("v._landText")
        check("A's landscape, as A's page gave it: the 6, every uuid named in order (no three.js uuid left in it)",
              (len(json.loads(land_a)["object"]["children"]), re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", land_a) is None) if land_a else None, (6, True))
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
        await a.js("document.querySelector('.visit-panel button[data-v=perf]').click()")
        check("A turns on the telemetry from its panel (⏱): a corner of the page says how it is doing", await a.until(
            "(e => !!e && e.textContent.includes('fps') && e.textContent.includes('Visit'))(document.querySelector('.visit-perf'))", 10), True)
        rep = await a.until("(r => r.length >= 2 && r[r.length - 1])(v.perfReport())", 10)
        check("…a row a second: frames, stalls, Visit's work by part (A has a visitor: its scene scanned), what it had to do",
              (rep["fps"] > 0, "scan" in rep["parts"], rep["counts"]["visitors"], "long_tasks" in rep), (True, True, 1, True)) if rep else check("a telemetry row", None, "a row")
        await a.js("document.querySelector('.visit-perf button[data-p=off]').click()")
        check("and off again: the corner goes, remembered off", await a.until("!document.querySelector('.visit-perf') && localStorage.getItem('visit:perf') === 'off'"), True)
        await a.js("room.scene.background.setHex(0x334455)")
        check("A's background changes: B's too", await b.until("v._viewer.scene.root.background.getHex() === 0x334455"), True)
        su = await a.js("room.shader()")
        check("a ShaderMaterial (a program) reaches B as plain grey, not as code", await b.until(
            "(o => o && o.material.type)(v._viewer.scene.root.getObjectByProperty('uuid', %s))" % json.dumps(su)), "MeshLambertMaterial")

        print("\npointing")
        keys = await b.js("(() => { const k = new Set(); v._viewer.scene.root.traverse(o => Object.keys(o.userData || {}).forEach(x => k.add(x))); return [...k].sort(); })()")
        check("B's copy of A's scene has none of A's own userData: only what Visit reads", keys, ["visitPoint", "visitor"])
        check("the cube A marked as one to click: an interaction A takes, spin, with its label", (await b.js("v._viewer.scene.root.getObjectByName('spinner').userData"),
              await b.js("[...v._viewer.scene.interactions]")), ({"visitPoint": "spin"}, [["spin", {"label": "spin it", "cosmetic": True}]]))
        check("an interaction that is not cosmetic is refused unless the user agreed to it", await a.js(
            "(() => { try { v.interactions({ wipe: { run() {} } }); return 'taken'; } catch (e) { v.interactions({ spin: { cosmetic: true, label: 'spin it', run: x => { x.object.rotation.y += 1; window.spins.push({ who: x.visitor.name, type: x.type }); } } }); return e.message.slice(0, 40); } })()"),
            'visit.interactions: "wipe" is not cosmet')
        await a.js("room.frozen = true; room.spinner.position.set(%f, 1.4, %f)" % (a2["x"] + 1.5, a2["z"] - 1.5))
        await asyncio.sleep(0.5)
        look = """(() => { const s = v._viewer.scene, o = s.root.getObjectByName('spinner'), dx = o.position.x - s.pose.x, dy = o.position.y - s.pose.y,
          dz = o.position.z - s.pose.z; v._view.yaw = Math.atan2(-dx, -dz) - s.yaw0 + %s; v._view.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          v._sendInput(performance.now(), true); v._view.cross.style.display = 'block'; return true; })()"""
        await b.js(look % "0")
        check("looking at it, B's crosshair is hot, with what it does", (bool(await b.until("!!v._view.cross.style.background")), await b.js("v._view.hint.textContent")), (True, "spin it"))
        await b.js(look % "Math.PI")
        check("looking away, it is not", await b.until("!v._view.cross.style.background"), True)
        await b.js(look % "0")
        await asyncio.sleep(0.3)
        await b.js("v._pointNow()")
        pt = await a.until("window.points.length && window.points[0]")
        pose = await a.js("({ ...v.visitors[0].pose, eyes: v.visitors[0].eyes })")
        check("B points: A hears it, from B's eyes where A has B (its feet, and its eyes over them), toward the cube: A's ray hits it",
              (pt["visitor"]["name"], [round(x, 2) for x in pt["from"]], round(sum(x * x for x in pt["dir"]), 3), pt["hit"]),
              ("B", [round(pose["x"], 2), round(pose["y"] + pose["eyes"], 2), round(pose["z"], 2)], 1.0, "spinner"))
        check("and it spins: A's interaction ran, for B", await a.until("window.spins.length === 1 && window.spins[0]"), {"who": "B", "type": "spin"})
        await asyncio.sleep(0.25)   # past the first point's 200 ms: one of the ten may go, and only one
        await b.js("for (let i = 0; i < 10; i++) v._pointNow()")
        await asyncio.sleep(0.6)
        check("ten points at once from B: its page sends one of them (one every 200 ms at most)", await a.js("window.points.length"), 2)
        await a.js("room.vault.position.set(%f, 1.4, %f)" % (a2["x"] + 1.5, a2["z"] - 1.5))   # in the cube's place: marked, but with a type A does not take
        await a.js("room.spinner.position.set(0.5, 0.2, 0.5)")
        await asyncio.sleep(0.5)
        spun = await a.js("window.spins.length")
        await b.js(look.replace("'spinner'", "'vault'") % "0")
        check("looking at a thing marked with a type A does not take: not hot", await b.until("!v._view.cross.style.background && !v._view.hint.textContent"), True)
        await asyncio.sleep(0.25)
        await b.js("v._pointNow()")
        await a.until("window.points.length === 3")
        await asyncio.sleep(0.2)
        check("and clicked, nothing runs (A heard the point, and took no interaction)", (await a.js("window.points[2].hit"), await a.js("window.spins.length")), ("vault", spun))
        await b.js("v._view.cross.style.display = 'none'")
        await a.js("room.frozen = false; room.vault.position.set(9, 1.2, 1.2)")

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
        check("A reloaded makes the same landscape, to the byte (so it is never sent again)", await a.until("v._landText", 30) == land_a, True)
        check("and B has it in A's room again", await b.until("(l => !!l && !!l.objs && l.objs.every(o => o.parent === v._viewer.scene.root))(v._viewer.land)"), True)
        check("A kept B where it was", round((await a.until("v.visitors.length && v.visitors[0].pose && v.visitors[0].pose.x")) or 0, 1), round(a2["x"], 1))
        await b.call("Page.reload")
        check("B reloading comes back still in A's room", await b.until("window.v && v.visiting && v.visiting.host.name", 30), "A")
        check("and draws it again", bool(await b.until("!!(v._viewer && v._viewer.scene) && v.frames > 15", 30)), True)
        check("with A's landscape, given again by B's visit-client (it has it)", await b.until(
            "(l => !!l && !!l.objs && l.objs.length === 6 && l.objs.every(o => o.parent === v._viewer.scene.root))(v._viewer && v._viewer.land)", 20), True)

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

        print("\nguests, from the panel")
        star = "document.querySelector('.visit-panel button.star[data-name=B]')"
        check("A's panel has a star by B, not lit", await a.until("%s && %s.textContent" % (star, star)), "☆")
        await a.js("%s.click()" % star)
        check("A clicks it: B is A's guest, by B's key", await a.until("v.guests.length === 1 && v.guests[0].key === v.offices.find(o => o.name === 'B').key && v.guests[0].name"), "B")
        check("and the star is lit", await a.until("%s.textContent === '★'" % star), True)
        await a.js("window.knocksSeen = 0; v.on('knock', () => window.knocksSeen++)")
        await b.js("v.knock(v.offices.find(o => o.name === 'A').id)")
        check("B knocks: in A's room at once, the door being open", await b.until("v.visiting && v.visiting.host.name"), "A")
        check("A's panel never asked: B walked in (one row for B: in your room)", (await a.until(
            "v.visitors.length === 1 && document.querySelector('.visit-panel').textContent.includes('B · in your room') && document.querySelectorAll('.visit-panel button.star[data-name=B]').length === 1"),
                                                     await a.js("window.knocksSeen")), (True, 0))
        await b.js("v.leave()")
        await a.until("v.visitors.length === 0")
        await a.js("(s => { s.value = 'closed'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-panel select[data-v=door]'))")
        check("A closes its door from the panel", await a.until("v.door === 'closed' && v.door"), "closed")
        await b.js("v.knock(v.offices.find(o => o.name === 'A').id)")
        check("then B knocks, and A's panel asks", await a.until("!!document.querySelector('.visit-panel .knock')"), True)
        await a.js("document.querySelector('.visit-panel .knock button[data-v=out]').click()")
        await a.js("v.setDoor(true); v.removeGuest(v.guests[0].key)")
        check("door open again, B no guest", await a.until("v.door === 'open' && v.guests.length === 0"), True)

        print("\nthe world: friends' plots round your room, walked onto")
        world = "http://127.0.0.1:%d/room.html?world=1" % WEB_PORT
        await a.goto(world)
        await b.goto(world + "&three=160")
        up = "window.v && window.room && room.world && v.state === 'online' && v.offices.filter(o => o.ready).length === 2"
        check("both rooms open as worlds", (bool(await a.until(up, 30)), bool(await b.until(up, 30))), (True, True))
        await a.js("v.addGuest(v.offices.find(o => o.name === 'B').key, 'B')")
        await b.js("v.addGuest(v.offices.find(o => o.name === 'A').key, 'A')")
        inworld = "room.world.plots.length === 1 && room.world.plots[0]"
        pa_, pb_ = await a.until(inworld, 20), await b.until(inworld, 20)
        check("guests both ways: each sees the other's plot, in its world", (pa_ and pa_["name"], pb_ and pb_["name"]), ("B", "A"))
        r = pa_["rect"]
        check("placed by itself round A's own, not on it", (round(r[2] - r[0], 3), round(r[3] - r[1], 3), not (r[0] < 10 and r[2] > 0 and r[1] < 8 and r[3] > 0)), (10, 8, True))
        check("A (r128) draws B's (r160) scene with A's own three.js: B's spinner there", await a.until(
            "(w => !!(w && w.scene && w.scene.T.REVISION === '128' && w.scene.root.getObjectByName('spinner')))([...v._watches.values()][0])"), True)
        check("and B (r160) A's (r128), with B's", await b.until(
            "(w => !!(w && w.scene && w.scene.T.REVISION === '160' && w.scene.root.getObjectByName('spinner')))([...v._watches.values()][0])"), True)
        check("B's lights (r160: lit the new way) over pi in A's world (r128 multiplies them by pi): as B sees them", await a.js(
            "(s => { let l; s.root.traverse(o => { if (o.isDirectionalLight) l = o; }); return Math.round(l.intensity * 1000) / 1000; })([...v._watches.values()][0].scene)"),
            round(0.6 / 3.14159265, 3))
        frames0 = await a.js("window.renders")
        await asyncio.sleep(0.5)
        check("and A's page goes on drawing", await a.js("window.renders") > frames0 + 10, True)
        await a.shot("a_world.png")

        async def walk(tab, x, z, yaw, secs, until=None):
            """From there, facing there, W held for `secs`, or (`until`, a JS test) until it holds, at most 3 times
            as long: a page drawing slowly (as these do, on the processor, under load) walks slowly."""
            await tab.js("Object.assign(room.me, { x: %f, z: %f, yaw: %f })" % (x, z, yaw))
            await asyncio.sleep(0.1)
            await tab.key("KeyW", "w", 87, True)
            if until:
                for _ in range(int(secs * 30)):
                    if await tab.js(until):
                        break
                    await asyncio.sleep(0.1)
                await asyncio.sleep(0.3)   # on past the edge a little
            else:
                await asyncio.sleep(secs)
            await tab.key("KeyW", "w", 87, False)
            await asyncio.sleep(0.4)

        midz = (r[1] + r[3]) / 2
        await walk(a, r[0] - 1.0, midz, -3.14159 / 2, 1.5, "!!room.where")   # west of B's plot, facing east, through its west doorway
        check("A walks onto B's plot: in B's room", await a.until("room.where && room.where.name"), "B")
        check("B has A as its visitor, where A stepped in and on", await b.until("v.visitors.length === 1 && v.visitors[0].pose.x > 0.5 && v.visitors[0].visitor.name"), "A")
        check("B draws A's body; A's copy of B's room hides it (A's page draws A as itself)", await a.until(
            "(s => s.own.length === 1 && !s.own[0].visible)([...v._watches.values()][0].scene)"), True)
        await a.shot("a_in_b.png")
        await b.shot("b_has_a.png")
        await b.js("room.lift = 3")
        check("B lifts A 3 m: A's world has A up there, as B's room has it", await a.until("Math.abs(room.atY - 3) < 0.05"), True)
        await b.js("room.lift = 0")
        check("and back down", await a.until("Math.abs(room.atY) < 0.05"), True)
        await a.key("Space", " ", 32, True)
        await asyncio.sleep(0.6)
        check("B lets nobody fly: A holding up stays on B's floor", (round(await b.js("v.visitors[0].pose.y"), 2), round(await a.js("room.atY"), 2)), (0.0, 0.0))   # (positions at the feet: 0.19)
        await b.js("room.fly = true")
        check("B lets visitors fly: A holding up rises, in B's room and in A's world", (await b.until("v.visitors[0].pose.y > 3"), await a.until("room.atY > 2.5")), (True, True))
        await a.key("Space", " ", 32, False)
        await asyncio.sleep(0.3)
        high = await b.js("v.visitors[0].pose.y")
        await asyncio.sleep(0.5)
        check("A lets go: it stays up there (flying, not falling)", abs(await b.js("v.visitors[0].pose.y") - high) < 0.05, True)
        await b.js("room.fly = false")
        await asyncio.sleep(0.4)
        check("B stops flying: A floats down, gently (not at once)", await b.js("v.visitors[0].pose.y") > 2.2, True)
        check("down to B's floor, in B's room and in A's world", (await b.until("Math.abs(v.visitors[0].pose.y) < 0.01", 15), await a.until("Math.abs(room.atY) < 0.05", 15)), (True, True))
        bx = await b.js("v.visitors[0].pose.x")
        await walk(a, await a.js("room.me.x"), await a.js("room.me.z"), 3.14159 / 2, 2.0, "room.where === null")   # turned round: back out west
        check("A walks back off B's plot: home again, and B's visitor gone", (await a.until("room.where === null && room.world.in === null"), await b.until("v.visitors.length === 0")), (True, True))
        check("A ends up west of B's plot, walking on in its own world", await a.js("room.me.x") < r[0], True)
        await b.js("window.highest = 0; window.highT = setInterval(() => { for (const x of v.visitors) if (x.pose) highest = Math.max(highest, x.pose.y); }, 5)")
        await a.js("Object.assign(room.me, { y: 4, air: 4 })")   # A flying at home, 4 m up, crosses onto B's plot (no flying there)
        await walk(a, r[0] - 1.0, midz, -3.14159 / 2, 1.5, "!!room.where")
        await a.js("room.me.air = 0")
        k = await a.js("room.world._layout().find(p => p.key === %s).k" % json.dumps(await a.js("v.offices.find(o => o.name === 'B').key")))
        check("A crosses onto B's plot in the air: B has it 4 m above its floor (in B's units)", await b.until("v.visitors.length === 1 && Math.abs(highest - 4 / %f) < 0.05" % k), True)
        check("and floats it down to its floor, as A's world shows", (await b.until("v.visitors.length === 1 && Math.abs(v.visitors[0].pose.y) < 0.01", 15), await a.until("Math.abs(room.atY) < 0.05", 15)), (True, True))
        await b.js("clearInterval(highT)")
        await walk(a, await a.js("room.me.x"), await a.js("room.me.z"), 3.14159 / 2, 2.0, "room.where === null")
        check("and A walks off again, home on the ground (not back up where it crossed)", (await b.until("v.visitors.length === 0"), abs(await a.js("room.me.y")) < 0.05), (True, True))
        await a.js("room.me.y = 0")   # on the ground again whatever the case above found, so what follows starts as it always has

        print("\neach one's view of the other: where the other has put it, nothing more")
        ka, kb = await b.js("v.offices.find(o => o.name === 'A').key"), await a.js("v.offices.find(o => o.name === 'B').key")
        theirs = await b.until("(p => p && [p.at.x - v._plot().center[0], p.at.z - v._plot().center[1], p.at.turn, ...v._plotMetres()].map(x => Math.round(x * 100) / 100))(room.world.plots[0])")
        got = await a.until("(s => s && [s.at.dx, s.at.dz, s.at.turn, ...s.at.size])(v.seen.find(s => s.name === 'B'))")
        check("A has where B's world puts A (from B's plot's middle, in metres), and B's plot's size", got, theirs)
        check("and B where A's puts B: one each, by key", await b.until("v.seen.length === 1 && v.seen[0].key"), ka)
        await b.js("v.place(%s, { x: 30, z: 4, turn: 1 })" % json.dumps(ka))
        check("B moves A's room in its world: A sees it move (25 m east of B's middle, turned a quarter left)",
              await a.until("(s => s && s.at.dx === 25 && s.at.dz === 0 && s.at.turn === 1 && s.at.dx)(v.seen.find(s => s.key === %s))" % json.dumps(kb)), 25)
        check("A's own world is unchanged by it: nobody agrees, each has its own", await a.js("room.world.plots[0].rect"), r)
        check("A's panel says so once it settles (Visit's own note): B put A's room east of B's", await a.until(
            "[...document.querySelectorAll('.visit-panel .note')].some(n => n.textContent.startsWith('B put your room east of theirs'))", 10), True)

        print("\nflush: walked straight across")
        await a.js("v.place(%s, { x: 15, z: 4, turn: 0 })" % json.dumps(kb))
        ea = await a.until("(p => p && p.at.x === 15 && p.rect)(room.world.plots[0])")
        check("A puts B's room against its own east side", [round(x, 3) for x in ea], [10, 0, 20, 8])
        await walk(a, 8.5, 4, -3.14159 / 2, 1.8, "!!room.where")   # in A's room, facing its east doorway: straight through into B's
        check("A walks out of its own room's east door and straight into B's, by its west door", await a.until("room.where && room.where.name"), "B")
        check("B has A", await b.until("v.visitors.length === 1 && v.visitors[0].visitor.name"), "A")
        await a.shot("a_across.png")
        # Back towards A's room's middle, through B's west doorway: from where B has A (a slow answer may have stepped it
        # in again, and its spawn moved it off the doorway's line), sliding along B's wall into the doorway.
        mx, mz = await a.js("room.me.x"), await a.js("room.me.z")
        await walk(a, mx, mz, math.atan2(-(5 - mx), -(4 - mz)), 3.0, "room.where === null")   # (at most 9 s: under load, slower)
        home = (await a.until("room.where === null"), 0 < await a.js("room.me.x") < 10.01)
        if home != (True, True):
            r0 = await a.js("window.renders"); await asyncio.sleep(1); r1 = await a.js("window.renders")
            print("      A:", await a.js("JSON.stringify({ me: room.me, where: room.where, in: room.world.in, keys: [...room.keys] })"), "frames/s:", r1 - r0,
                  "B has A at:", await b.js("JSON.stringify(v.visitors.map(x => x.pose))"), "B frames/s:", await b.js("window.renders"))
            print("      B's spawns:", await b.js("JSON.stringify((window.spawns || []).slice(-6))"))
        check("and back: home in A's own room", home, (True, True))
        check("both at home, each near the other in its own world (A's: B flush east; B's: A 25 m east): each hears the other near, across the side",
              (await a.until("v.voices.some(x => x.name === 'B') && JSON.parse(v._whereTold.sig).world.some(w => w[0] === %s)" % json.dumps(kb), 15),
               await b.until("v.voices.some(x => x.name === 'A')", 15)), (True, True))

        print("\nB away: its plot kept from its landscape, walked into, not through")
        await b.js("v.leaveLobby()")
        check("B goes offline: A's world keeps B's plot where it was, from B's landscape, marked offline", await a.until(
            "(p => !!p && p.offline && p.at.x === 15)(room.world.plots.find(p => p.name === 'B'))", 20), True)
        await walk(a, 8.5, 4, -3.14159 / 2, 2.5, "room.me.x > 12")   # out of A's east door, into B's kept plot by its west door
        check("A walks into B's kept plot by its doorway (at home all the while: nobody to have A there)", await a.js("room.me.x > 11 && room.where === null"), True)
        await walk(a, await a.js("room.me.x"), 4, 0, 2.5)   # north (-z), at B's north wall
        z = await a.js("room.me.z")
        check("and walks north into B's north wall: stopped at it, not through", (0.1 < z < 2.5, z), (True, z))
        await a.shot("a_kept.png")
        await a.js("Object.assign(room.me, { x: 5, z: 4 })")   # home
        await b.js("v.joinLobby()")
        check("B back: its plot live again", await a.until("(p => !!p && !p.offline)(room.world.plots.find(p => p.name === 'B'))", 45), True)

        print("\nthe door shut")
        await walk(a, 8.5, 4, -3.14159 / 2, 1.8, "!!room.where")   # into B's again, to be lifted there
        check("A in B's room again", (await a.until("room.where && room.where.name"), await b.until("v.visitors.length === 1")), ("B", True))
        await b.js("room.lift = 3")
        check("B lifts A 3 m again", await a.until("Math.abs(room.atY - 3) < 0.05"), True)
        await b.js("v.setDoor(false)")
        check("B shuts its door with A up there: A is home, at its own height", await a.until("room.where === null && Math.abs(room.atY) < 0.05"), True)
        await b.js("room.lift = null")
        check("B shuts its door: B's room leaves A's world, and B is told it is no longer in it",
              (await a.until("room.world.plots.length === 0", 10), await b.until("v.seen.length === 0", 10)), (True, True))
        await b.js("v.setDoor(true)")

        print("\nthe map: placing B's room exactly, from above")
        await a.js("document.querySelector('.visit-panel button[data-v=map]').click()")
        # (B's door was shut: A's watch was refused, and A asks again 20 s after that)
        check("A's panel opens the map: A's room and B's, from above", await a.until("!!(v._mapView && v._mapView.shown && room.world.plots.some(p => p.name === 'B'))", 40), True)
        pick = "[...document.querySelectorAll('.visit-map button[data-m=pick]')].find(b => b.textContent.startsWith('B'))"
        await a.until("!!" + pick)
        await a.js(pick + ".click()")
        check("picked, B's room shows B's view of the two: A's room east of B's, turned, drawn", await a.until(
            "(s => s.textContent.includes('your room east of theirs, 25 m middle to middle, turned a quarter left') && s.querySelectorAll('svg rect').length)(document.querySelector('.visit-map .side'))"), 2)
        await a.until("!!document.querySelector('.visit-map input[data-f=x]')")
        await a.js("(i => { i.value = '-12'; i.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-map input[data-f=x]'))")
        await a.js("(i => { i.value = '-6'; i.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-map input[data-f=z]'))")
        check("typed: B's room's middle at (-12, -6), kept by A's visit-client", await a.until(
            "(p => p && p.x === -12 && p.z === -6 && p)(v.layout.find(p => p.key === %s))" % json.dumps(kb)), {"key": kb, "x": -12, "z": -6, "turn": 0})
        check("and A's world puts it there", await a.until("(p => p && p.at.x === -12 && p.at.z === -6)(room.world.plots.find(p => p.name === 'B'))"), True)
        await a.js("document.querySelector('.visit-map button[data-m=fit]').click()")
        await asyncio.sleep(0.3)
        p0 = await a.js("v._mapView._px(%s)" % json.dumps(kb))
        await a.call("Input.dispatchMouseEvent", type="mousePressed", x=p0[0], y=p0[1], button="left", clickCount=1)
        for i in range(1, 11):
            await a.call("Input.dispatchMouseEvent", type="mouseMoved", x=p0[0] + i * 6, y=p0[1], button="left")
        await a.call("Input.dispatchMouseEvent", type="mouseReleased", x=p0[0] + 60, y=p0[1], button="left", clickCount=1)
        moved = await a.until("(p => p && p.x > -12 && p.z === -6 && p.x)(v.layout.find(p => p.key === %s))" % json.dumps(kb))
        check("dragged right on the map: further east, on a half unit, the same z", (moved > -12, moved * 2 == int(moved * 2)), (True, True))
        await a.js("document.querySelector('.visit-map button[data-m=cw]').click()")
        check("turned a quarter right (three quarter turns left)", await a.until("(p => p && p.turn)(v.layout.find(p => p.key === %s))" % json.dumps(kb)), 3)
        await a.js("(i => { i.value = '14'; i.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-map input[data-f=x]'))")
        await a.js("(i => { i.value = '4'; i.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-map input[data-f=z]'))")
        check("typed again: B's room flush against A's east side", await a.until(
            "(p => p && p.x === 14 && p.z === 4 && p.turn)(v.layout.find(p => p.key === %s))" % json.dumps(kb)), 3)
        check("and B told where it is now in A's world: its middle 9 m east of A's, turned a quarter right", await b.until(
            "(s => s && s.at.dx === 9 && s.at.dz === 0 && s.at.turn)(v.seen.find(s => s.key === %s))" % json.dumps(ka)), 3)
        await a.shot("a_map.png")
        await a.js("document.querySelector('.visit-map button[data-m=close]').click()")
        await a.goto(world)
        check("A's page reloads: where A put B's room is kept", await a.until(
            "window.v && (p => p && p.x === 14 && p.z === 4 && p.turn === 3)(v.layout.find(p => p.key === %s))" % json.dumps(kb), 30), True)
        await a.until("window.room && room.world && room.world.plots.some(p => p.name === 'B')", 30)
        check("and A has, again, where B has put it", await a.until("(s => s && s.at.dx)(v.seen.find(s => s.key === %s))" % json.dumps(kb), 20), 25)
        await a.js("v.unplace(%s)" % json.dumps(kb))
        await b.js("v.unplace(%s)" % json.dumps(ka))
        await a.until("v.layout.length === 0")
        await a.js("v.removeGuest(v.guests[0].key)")
        await b.js("v.removeGuest(v.guests[0].key)")

        print("\nlinks: their room in a corner, then gone to, or put in your world")
        btn = "(id => document.querySelector(`.visit-panel button[data-v=knock][data-o=\"${id}\"]`))(v.offices.find(o => o.name === 'B').id)"
        await a.until("!!%s && !%s.disabled" % (btn, btn), 30)   # (A's watch of B, as B's guest, over first)
        check("A's panel offers B a link (B takes them)", await a.js(btn + ".textContent"), "Link")
        await a.js(btn + ".click()")
        await a.js("(f => { f.querySelector('input').value = 'look?'; f.querySelector('button.go').click(); })(document.querySelector('.visit-panel form'))")
        check("B's panel: A wants to link, with its message", await b.until("(k => k && k.textContent.includes('wants to link') && k.textContent.includes('look?'))(document.querySelector('.visit-panel .knock'))"), True)
        await b.js("(c => { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-panel .knock input[data-v=always]'))")
        await b.js("document.querySelector('.visit-panel .knock button[data-v=in]').click()")
        check("B links, ★ always ticked: A is B's guest from now on", await b.until("v.guests.some(g => g.name === 'A')"), True)
        check("A: B's room in the stage's corner, not in it", await a.until(
            "v.links.length === 1 && v.links[0].where === 'corner' && !v.links[0].inside && !document.querySelector('.visit-stage').hidden && document.querySelector('.visit-stage').classList.contains('small')"), True)
        check("drawn with B's own three.js (r160), from above, going round", await a.until(
            "(w => !!(w.scene && w.scene.T.REVISION === '160' && w.count > 10 && w.scene.camera.position.y > 3))(v._viewer)"), True)
        check("B's panel: A is linked, seeing B's room, not in it", await b.until(
            "v.watchers.length === 1 && v.watchers[0].link && v.visitors.length === 0 && document.querySelector('.visit-panel').textContent.includes('A · linked')"), True)
        await b.js("document.querySelector('.visit-panel button.who').click()")
        check("B opens A's row: A sees B's room; A's look in B's room, their model by default; Kick, no; Unlink", await b.until(
            "(r => !!r && [r.querySelector('.muted').textContent, [...r.querySelectorAll('button')].map(b => b.textContent + (b.classList.contains('on2') ? '*' : '')).join()])(document.querySelector('.visit-panel .sub'))"),
            ["they see your room", "their model*,our model,ban voice,ban chat,Unlink"])
        await a.shot("a_link_corner.png")
        await a.js("document.querySelector('.visit-stage').click()")
        check("a click on the corner: go there, put it in my world, unlink", await a.js(
            "[...document.querySelectorAll('.visit-stage .menu button')].filter(b => !b.hidden).map(b => b.textContent)"), ["Go there", "Put in my world", "Unlink", "Not now"])
        await a.js("document.querySelector('.visit-stage .menu button[data-s=in]').click()")
        check("Go there: A is in B's room, full-window, with the keys", await a.until(
            "v.visiting.inside && document.querySelector('.visit-stage').classList.contains('big') && v.viewFocused"), True)
        check("B has A, where B's spawn put it", await b.until("v.visitors.length === 1 && v.visitors[0].link && v.visitors[0].pose && v.visitors[0].pose.x"), 2)
        await a.shot("a_link_in.png")
        await a.js("document.querySelector('.visit-stage button[data-s=small]').click()")
        check("Back to my room: B's room in the corner again, B's visitor gone, the link on", (await a.until(
            "!v.visiting.inside && document.querySelector('.visit-stage').classList.contains('small') && !v.viewFocused"), await b.until("v.visitors.length === 0 && v.watchers.length === 1")), (True, True))
        await a.js("v.knock(v.offices.find(o => o.name === 'B').id)")   # an ordinary visit (A is B's guest now: in at once)
        check("a visit to B meanwhile: it has the stage, full-window; the link waits aside", await a.until(
            "v.visiting && !v.visiting.link && v.links[0].where === 'aside' && document.querySelector('.visit-stage').classList.contains('big')"), True)
        await a.js("v.leave()")
        check("the visit over: the link in the corner again, its room drawn anew", await a.until(
            "v.links[0] && v.links[0].where === 'corner' && (w => !!(w && w.scene && w.count > 5))(v._viewer) && document.querySelector('.visit-stage').classList.contains('small')"), True)
        await a.js("document.querySelector('.visit-stage').click()")
        await a.js("document.querySelector('.visit-stage .menu button[data-s=world]').click()")
        check("Put in my world: the corner empties, B's plot round A's room", await a.until(
            "v.links[0].where === 'world' && document.querySelector('.visit-stage').hidden && (p => !!(p && p.name === 'B'))(room.world.plots[0])"), True)
        check("read again with A's own three.js (r128)", await a.until("(w => !!(w && w.scene && w.scene.T.REVISION === '128'))([...v._watches.values()].find(w => w.link))"), True)
        await a.goto(world)
        check("A's page reloads: the link comes back in A's world, not the corner", await a.until(
            "window.v && window.room && room.world && v.links.length === 1 && v.links[0].where === 'world' && room.world.plots.some(p => p.name === 'B') && document.querySelector('.visit-stage').hidden", 30), True)
        await a.shot("a_link_world.png")
        await a.js("document.querySelector('.visit-panel button.who').click()")
        check("A opens B's row: B's room in A's world", await a.until("(r => !!r && r.querySelector('.muted').textContent)(document.querySelector('.visit-panel .sub'))"), "their room is in your world")
        await a.js("document.querySelector('.visit-panel .sub button[data-v=cut]').click()")
        check("A unlinks from its panel: gone for both", (await a.until("v.links.length === 0 && room.world.plots.length === 0"), await b.until("v.watchers.length === 0")), (True, True))
        await b.js("v.removeGuest(v.guests[0].key)")
        await b.until("v.guests.length === 0")

        print("\navatars: a visitor as itself, when the room it visits says so")
        await b.js("v.knock(v.offices.find(o => o.name === 'A').id, 'as myself?')")
        await a.until("!!document.querySelector('.visit-panel .knock button[data-v=in]')")
        await a.js("document.querySelector('.visit-panel .knock button[data-v=in]').click()")
        check("B visits A: A shows B as their own model (Visit's default)", await a.until(
            "v.avatars.default === 'theirs' && v.visitors.length === 1 && v.visitors[0].look === 'theirs' && !!room.scene.getObjectByName('avatar:B') && !room.scene.getObjectByName('body:B')"), True)
        check("read with A's three.js (r128, from B's r160): B's torso and head, its walk and idle", await a.js(
            "(h => [h.avatar.object.getObjectByName('torso').geometry.type, !!h.avatar.object.getObjectByName('head'), !!h.avatar.walk, !!h.avatar.idle])([...v._hosted.values()].find(h => h.avatar))"),
            ["CylinderGeometry", True, True, True])
        check("and B, in A's room, does not see itself", await b.until("(s => !!s && s.own.some(o => o.name === 'avatar:B'))(v._viewer && v._viewer.scene)"), True)
        check("Visit draws it, not A's room: at B's feet, facing B's way", await a.until(
            "(o => !!o && o.parent === room.scene && Math.abs(o.position.x - v.visitors[0].pose.x) < 0.01 && Math.abs(o.position.y - v.visitors[0].pose.y) < 0.01 && Math.abs(o.rotation.y - v.visitors[0].pose.yaw) < 0.01)(room.scene.getObjectByName('avatar:B'))"), True)
        check("B sees from its own model's eyes (its \"eyes\" point, 1.5 m): A says so, and B's camera is there", (
            await a.until("Math.abs(v.visitors[0].eyes - 1.5) < 0.01 && v.visitors[0].look"),
            await b.until("(bd => !!bd && bd.look === 'theirs' && Math.abs(bd.eyes - 1.5) < 0.01 && Math.abs(v._viewer.scene.pose.y - 1.5) < 0.05)(v._bodies.get(v._viewer.channel))")), ("theirs", True))
        await a.shot("a_avatar.png")
        await a.js("document.querySelector('.visit-panel button.who').click()")
        await a.js("document.querySelector('.visit-panel .sub button[data-v=look][data-use=mine]').click()")
        check("A opens B's row, our model: B set apart, one of A's own (a box)", await a.until(
            "v.avatarUse(v.visitors[0].visitor.key) === 'mine' && v.avatars.by.length === 1 && v.visitors[0].look === 'mine' && !!room.scene.getObjectByName('body:B')"), True)
        check("and B sees from A's room's eyes now (1.6 m), as B hears", await b.until("(bd => !!bd && bd.look === 'mine' && Math.abs(bd.eyes - 1.6) < 0.01 && Math.abs(v._viewer.scene.pose.y - 1.6) < 0.05)(v._bodies.get(v._viewer.channel))"), True)
        await a.js("document.querySelector('.visit-panel .sub button[data-v=look][data-use=theirs]').click()")
        check("their model again: the default, so no longer apart", await a.until("v.avatars.by.length === 0 && v.visitors[0].look === 'theirs' && !!room.scene.getObjectByName('avatar:B')"), True)
        await a.js("(s => { s.value = 'mine'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-panel select[data-v=looks]'))")
        check("visitors look like: our model: B a box", await a.until(
            "v.avatars.default === 'mine' && v.visitors[0].look === 'mine' && !!room.scene.getObjectByName('body:B') && !room.scene.getObjectByName('avatar:B')"), True)
        await a.js("(s => { s.value = 'theirs'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('.visit-panel select[data-v=looks]'))")
        await a.until("v.avatars.default === 'theirs' && v.visitors[0].look === 'theirs'")
        print("\nmodels, checked as other rooms will read them (Visit.checkModel, MODELS.md)")
        check("B's own avatar: fine, its eyes at its eyes point, its clips", await b.js(
            "(c => [c.ok, c.eyes, c.clips.join()])(Visit.checkModel(v._avatarOwn.object, { three: v._hooks.scene.three }))"), [True, 1.5, "idle,walk"])
        # MODELS.md's own example body, as written there: it must pass (the doc and the check agree)
        models = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "MODELS.md")).read()
        example = next(b_ for b_ in models.split("```js")[1:] if "function myBody" in b_).split("```")[0]
        example = "\n".join(l for l in example.splitlines() if not l.startswith("visit."))
        check("MODELS.md's example body passes the check: its feet, its eyes point (1.7 m), its clips", await b.js(
            "(THREE => { %s; return (c => [c.ok, c.problems.join('; '), c.eyes, c.clips.join()])(Visit.checkModel(myBody(THREE), { three: THREE })); })(v._hooks.scene.three)" % example),
            [True, "", 1.7, "idle,walk,ride"])
        check("a model off its feet, set in a room, a clip moving a part it does not have: each said", await b.js("""(T => {
          const g = new T.Group(), m = new T.Mesh(new T.BoxGeometry(0.5, 1.6, 0.5), new T.MeshBasicMaterial()); m.position.y = 1.5; g.add(m); g.position.x = 3;
          g.animations = [new T.AnimationClip('walk', 1, [new T.NumberKeyframeTrack('leg0.rotation[x]', [0, 1], [0, 1])])];
          const c = Visit.checkModel(g, { three: T });
          return [c.ok, c.problems.some(p => p.startsWith('its feet are not at its origin')), c.problems.some(p => p.includes('"leg0"')), c.problems.some(p => p.startsWith('its own place or turn')), g.position.x];
        })(v._hooks.scene.three)"""), [False, True, True, True, 3])

        print("\nmounts: B rides in A's room, on B's room's own (8.11)")
        check("no mounts of Visit's own: none until B's room gives some, and no row for them in its panel", await b.js(
            "v.mounts.length === 0 && !document.querySelector('.visit-panel select[data-v=mount]')"), True)
        await b.js("""(T => {
          const box = (name, w, h, d, y, color) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), new T.MeshBasicMaterial({ color })); m.name = name; m.position.y = y; return m; };
          const bob = (name, a) => new T.AnimationClip(name, 0.5, [new T.NumberKeyframeTrack('pony-body.position[y]', [0, 0.25, 0.5], [0.9, 0.9 + a, 0.9])]);
          const pony = new T.Group(); pony.add(box('pony-body', 0.5, 0.6, 1.4, 0.9, 0x8b5a2b)); pony.animations = [bob('idle', 0.01), bob('walk', 0.12)];
          const rug = new T.Group(); rug.add(box('rug-body', 1, 0.04, 1.6, 0.4, 0x9b1b30));
          v.possessions([{ id: 'pony', name: 'Pony', object: pony, mount: true, speed: 2, lift: 0.55 },
            { id: 'rug', name: 'Rug', object: rug, mount: true, fly: true, speed: 2, lift: 0.45 },
            { id: 'crate', name: 'Crate', mount: true, lift: 0.3, object: box('crate-box', 1, 0.3, 1.4, 0.15, 0xaa7733) }]);
        })(v._hooks.scene.three)""")
        check("B's room gives its own: its mounts, and a row for them in its panel", (await b.js("v.mounts.map(m => m.id + (m.fly ? '^' : '')).join()"),
              await b.until("!!document.querySelector('.visit-panel select[data-v=mount]')")), ("pony,rug^,crate", True))
        y0 = await a.js("v.visitors[0].pose.y")
        await b.js("v.ride('pony')")
        check("B gets on its pony: A asks for it, has it under B, on A's floor, B lifted onto it", await a.until(
            "(o => !!o && !!o.getObjectByName('pony-body') && !!v.visitors[0].riding && v.visitors[0].riding.id === 'pony' && Math.abs(v.visitors[0].pose.y - %r - 0.55) < 0.01"
            " && Math.abs(o.position.x - v.visitors[0].pose.x) < 0.01 && Math.abs(o.position.y) < 0.01)(room.scene.getObjectByName('mount:B'))" % y0), True)
        await a.shot("a_pony.png")
        check("A's move hears what B rides, at the pony's pace", await a.until("window.movedWith && window.movedWith.riding && window.movedWith.riding.speed"), 2)
        check("B's copy of A's room has the pony, unseen from B's own eyes", await b.until("(s => !!s && s.ownMount.length === 1 && !s.ownMount[0].visible)(v._viewer && v._viewer.scene)"), True)
        await b.key("KeyW", "w", 87, True)
        check("B walks on: A plays the pony's own walk clip", await a.until("(r => !!r && !!r.playing && r.playing === r.clips.walk)([...v._hosted.values()][0].ride)"), True)
        await b.key("KeyW", "w", 87, False)
        await b.js("v.ride('rug')")
        check("the flying rug instead: under B, the pony gone", await a.until(
            "(o => !!o && !!o.getObjectByName('rug-body') && v.visitors[0].riding.id === 'rug' && room.scene.children.filter(c => c.name === 'mount:B').length === 1)(room.scene.getObjectByName('mount:B'))"), True)
        await b.key("Space", " ", 32, True)
        check("A's room says nothing of flying: B's rug flies (Space, up)", await a.until("v.visitors[0].pose.y > %r + 0.45 + 1" % y0), True)
        await a.shot("a_rug.png")
        await b.key("Space", " ", 32, False)
        await a.js("window.room.fly = false")
        check("A's room says no flying (fly: false): B floats down, rug and all", await a.until("Math.abs(v.visitors[0].pose.y - %r - 0.45) < 0.01" % y0, 20), True)
        await a.js("window.room.fly = undefined; window.room.mounts = false")
        check("A's room keeps mounts out (mounts: false): B is off, on the floor", await a.until(
            "!room.scene.getObjectByName('mount:B') && !v.visitors[0].riding && Math.abs(v.visitors[0].pose.y - %r) < 0.01" % y0), True)
        await a.js("window.room.mounts = undefined")
        await b.js("v.ride('crate')")
        check("B rides its crate in A's room: under B", await a.until(
            "(o => !!o && !!o.getObjectByName('crate-box') && Math.abs(v.visitors[0].pose.y - %r - 0.3) < 0.01)(room.scene.getObjectByName('mount:B'))" % y0), True)
        await b.key("KeyM", "m", 77, True)
        await b.key("KeyM", "m", 77, False)
        check("M: off; A's room has B on the floor", (await b.until("v.riding === null"), await a.until("!room.scene.getObjectByName('mount:B') && Math.abs(v.visitors[0].pose.y - %r) < 0.01" % y0)), (True, True))
        await b.key("KeyM", "m", 77, True)
        await b.key("KeyM", "m", 77, False)
        check("M again: on the one B last rode", await b.until("v.riding"), "crate")
        await a.js("v._ws.close()")   # A's page loses its visit-client a moment (it connects again by itself)
        check("A's page loses its visit-client and comes back while B rides: B's crate and B's body in A's room once each, not twice",
              await a.until("v.state === 'online' && v.visitors.length === 1 && !!v.visitors[0].riding && !!room.scene.getObjectByName('crate-box')"
                            " && room.scene.children.filter(c => c.name === 'mount:B').length === 1 && room.scene.children.filter(c => c.name === 'avatar:B').length <= 1", 30), True)
        await b.js("v.ride(null)")
        await a.until("!room.scene.getObjectByName('mount:B')")
        await b.js("v.leave()")
        await a.until("v.visitors.length === 0")

        print("\nvoice: by who is near, in the same room")
        await a.js("v.knock(v.offices.find(o => o.name === 'B').id, 'talk?')")
        await b.until("v.knocks.length === 1")
        await b.js("v.answer(v.knocks[0].id, true)")
        await b.until("v.visitors.length === 1")
        await b.js("document.querySelector('.visit-panel button[data-v=mic]').click()")
        check("B's microphone on from its panel", await b.until("v.mic && !!v._mic"), True)
        await a.js("document.querySelector('.visit-panel button[data-v=mic]').click()")
        await a.until("v.mic && !!v._mic")
        check("A, in B's room, near B: each has the other near", (await a.until("v.voices.length === 1 && v.voices[0].name"), await b.until("v.voices.length === 1 && v.voices[0].name")), ("B", "A"))
        check("A hears B: B's voice decoded and played at A, from where B stands (the fake microphone's tone)", await a.until(
            "(s => !!s && s.frames > 50 && s.level > 0.01 && s.near)(v._voices.get(v.voices[0].key))"), True)
        check("and B hears A, from where B has A in its room", await b.until("(s => !!s && s.frames > 50 && s.level > 0.01 && s.near)(v._voices.get(v.voices[0].key))"), True)
        await a.js("v.setName('Ann')")
        check("A gives the name its user goes by: B's panel row and who is near B say it", (await b.until(
            "[...document.querySelectorAll('.visit-panel button.who')].some(b => b.textContent.includes('Ann (A)'))"), await b.until("v.voices.some(x => x.name === 'Ann')")), (True, True))
        await a.js("v.setName(null)")
        await b.until("v.voices.some(x => x.name === 'A')")
        check("B's panel shows A near, speaking", await b.until("document.querySelector('.visit-panel').textContent.includes('🔊 A')"), True)
        check("A's view of B's room draws a 🔊 over B, as A hears B (Visit's own, by default)", await a.until(
            "(b => !!b && [...b.by.keys()].some(k => k.startsWith('speak:')))(v._viewer && v._viewer.scene && v._viewer.scene.bubbles)"), True)
        check("and B's world one over A's body, as B hears A", await b.until("!!room.world.bubbles && [...room.world.bubbles.by.keys()].some(k => k.startsWith('speak:'))"), True)
        check("heard within 45 m, as both visit-clients say", (await a.js("v.voiceRange"), await b.js("v.voiceRange")), (45, 45))
        bx0 = await b.js("room.me.x")
        await b.js("room.me.x += 30")
        far = "v.voices.length === 1 && v.voices[0].distance > 20 && v.voices[0].distance < 45"
        check("B walks 30 m off: still near each other, as B's visit-client has it (the old 15 m would not have reached)", (await b.until(far), await a.until(far)), (True, True))
        if not await b.js(far):
            print("      B's near:", await b.js("JSON.stringify(v.voices)"), "A's:", await a.js("JSON.stringify(v.voices)"))
        await b.js("room.me.x += 70")
        check("100 m off: neither hears the other, and neither sends a thing (B's visit-client says nobody is near)", (await b.until("v.voices.length === 0 && [...v._voices.values()].every(s => !s.near) && v._voiceTo === 0"),
              await a.until("v.voices.length === 0 && v._voiceTo === 0")), (True, True))
        await b.js("room.me.x = %f" % bx0)
        await a.until("v.voices.length === 1")

        print("\nchat: a line said, over its speaker's head, for everyone in the room")
        await a.js("v.say('hello from A')")
        check("A says a line in B's room: B has it, from A", await b.until("(c => c && c.text)(v.chats.find(c => c.name === 'A'))"), "hello from A")
        check("and B's world draws it over A's body, above its head", await b.until(
            "!!room.world.bubbles && room.world.bubbles.by.size === 1 && [...room.world.bubbles.by.values()][0].sprite.position.y > 1.8"), True)
        async def enter(pg):   # the Enter key, as a person presses it
            for t in ("keyDown", "keyUp"):
                await pg.call("Input.dispatchKeyEvent", type=t, code="Enter", key="Enter", windowsVirtualKeyCode=13, **({"text": "\r"} if t == "keyDown" else {}))
        cw = "document.querySelector('.visit-chat')"
        check("B's panel has the chat window, bottom left, its hint there", await b.js(
            f"(c => !!c && getComputedStyle(c).position === 'fixed' && c.getBoundingClientRect().left < 40 && innerHeight - c.getBoundingClientRect().bottom < 40)({cw})"), True)
        await enter(b)
        check("B presses Enter: the window opens, its box has the keys", await b.until(f"(c => c.classList.contains('typing') && document.activeElement === c.querySelector('input'))({cw})"), True)
        await b.call("Input.insertText", text="hi A, from my chat")
        await enter(b)
        check("B types a line, Enter: A has it, over the room's owner", await a.until("(c => c && c.owner && c.text)(v.chats.find(c => c.name === 'B'))"), "hi A, from my chat")
        check("and B's window shows it, the box gone again", await b.js(f"(c => [c.classList.contains('typing'), c.querySelector('.log').lastChild.textContent])({cw})"),
              [False, "[B] says: hi A, from my chat"])
        check("A's window too", await a.until(f"{cw}.querySelector('.log').lastChild.textContent"), "[B] says: hi A, from my chat")
        check("A's view of B's room draws it over B (B's mark), not A's own line (A's eyes are there)", await a.until(
            "(b => !!b && b.by.size === 1 && [...b.by.values()][0].text === 'hi A, from my chat')(v._viewer && v._viewer.scene && v._viewer.scene.bubbles)"), True)
        check("and B's world draws B's own over B's head too", await b.until("room.world.bubbles.by.size === 2"), True)
        await enter(b)
        await b.call("Input.insertText", text="/w A ")
        check("/w A and a space: the box whispers to A, the command gone", await b.until(
            f"(c => c.dataset.scope === 'whisper' && c.querySelector('select').selectedOptions[0].textContent === 'Tell A:' && c.querySelector('input').value === '')({cw})"), True)
        await b.call("Input.insertText", text="psst")
        await enter(b)
        check("whispered: A has it, from B, and nobody's bubble", await a.until(
            "(l => l && l.scope === 'whisper' && l.name === 'B' && !v.chats.some(c => c.text === 'psst') && l.text)(v.chatLog.at(-1))"), "psst")
        check("A's window: [B] whispers; B's: To [A]", (await a.js(f"{cw}.querySelector('.log').lastChild.textContent"), await b.js(f"{cw}.querySelector('.log').lastChild.textContent")),
              ("[B] whispers: psst", "To [A]: psst"))
        await enter(b)
        await b.call("Input.insertText", text="/s ")
        await b.call("Input.insertText", text="/r ")
        check("/r on B, whom nobody has whispered to yet: back to whom B last whispered (A)", await b.until(
            f"(c => c.dataset.scope === 'whisper' && c.querySelector('select').selectedOptions[0].textContent === 'Tell A:' && c.querySelector('input').value === '')({cw})"), True)
        await b.key("Escape", "Escape", 27, True)
        await b.key("Escape", "Escape", 27, False)
        await enter(a)
        await a.call("Input.insertText", text="/r back at you")
        await enter(a)
        check("A: /r, a whisper back to B", await b.until(f"(t => t.includes('whispers') && t)({cw}.querySelector('.log').lastChild.textContent)"), "[A] whispers: back at you")
        await enter(b)
        await b.call("Input.insertText", text="/room A ")
        check("/room A and a space: the box goes to A's room", await b.until(
            f"(c => c.dataset.scope === 'sim' && c.querySelector('select').selectedOptions[0].textContent === \"To A's room:\" && c.querySelector('input').value === '')({cw})"), True)
        await b.call("Input.insertText", text="into your room")
        await enter(b)
        check("said: A has it in its chat, into its room, from B (over nobody's head)", await a.until(
            "(l => l && l.scope === 'sim' && l.name === 'B' && l.to.key === v.key && l.text)(v.chatLog.at(-1))"), "into your room")
        check("A's window: [Your room] [B]; B's: [A's room] [B] (a room's chat, as a channel)", (await a.js(f"{cw}.querySelector('.log').lastChild.textContent"), await b.js(f"{cw}.querySelector('.log').lastChild.textContent")),
              ("[Your room] [B]: into your room", "[A's room] [B]: into your room"))
        check("the lobby carries chat (its welcome said so)", (await a.js("v.lobbyChat"), await b.js("v.lobbyChat")), (True, True))
        await enter(b)
        check("B's box remembers where it last said a line", await b.until(f"{cw}.dataset.scope"), "sim")
        await b.call("Input.insertText", text="/1 hello lobby")
        await enter(b)
        check("/1: a line to the lobby: A has it, and B (from the lobby)", (await a.until(f"(t => t.startsWith('[Lobby]') && t)({cw}.querySelector('.log').lastChild.textContent)"), await b.until(
            f"(t => t.startsWith('[Lobby]') && t)({cw}.querySelector('.log').lastChild.textContent)")), ("[Lobby] [B]: hello lobby", "[Lobby] [B]: hello lobby"))
        await enter(b)
        await b.call("Input.insertText", text="half a thought")
        await b.key("Escape", "Escape", 27, True)
        await b.key("Escape", "Escape", 27, False)
        check("the window's 🔔: a sound with each line that comes; a click, none (kept in this browser)", (await b.js(f"{cw}.querySelector('button.sound').textContent"),
              await b.js(f"({cw}.querySelector('button.sound').click(), {cw}.querySelector('button.sound').textContent)"), await b.js(f"({cw}.querySelector('button.sound').click(), {cw}.querySelector('button.sound').textContent)")), ("🔔", "🔕", "🔔"))
        check("Esc: the box goes, its line unsaid", (await b.until(f"!{cw}.classList.contains('typing')"), await a.js("v.chatLog.some(l => l.text === 'half a thought')")), (True, False))
        await enter(b)
        check("B, with A linked (visiting): its own room's chat among the choices", await b.js(f"[...{cw}.querySelector('select').options].map(o => o.textContent)"),
              ["Say:", "Tell A:", "To your room:", "To A's room:", "Lobby:"])
        await b.call("Input.insertText", text="/w ")
        check("/w and a space: the names it could be, over the box, to pick", await b.until(f"[...{cw}.querySelectorAll('.names button')].map(b => b.textContent).join()"), "A")
        await b.key("Tab", "Tab", 9, True)
        await b.key("Tab", "Tab", 9, False)
        check("Tab finishes the name, not yet taken (a longer one could follow)", await b.until(f"(c => c.querySelector('input').value === '/w A' && c.dataset.scope)({cw})"), "lobby")
        await b.call("Input.insertText", text=" ")
        check("then a space: the box whispers to A, the names gone", await b.until(
            f"(c => c.dataset.scope === 'whisper' && c.querySelector('select').selectedOptions[0].textContent === 'Tell A:' && c.querySelector('input').value === '' && c.querySelector('.names').textContent)({cw})"), "")
        await b.call("Input.insertText", text="hey @")
        check("@ in a line: whom it could mention, over the box", await b.until(f"[...{cw}.querySelectorAll('.names button')].map(b => b.textContent).join()"), "A")
        await b.key("Enter", "Enter", 13, True)
        await b.key("Enter", "Enter", 13, False)
        check("Enter takes it: the name in the line, nothing said yet", await b.until(
            f"(c => c.querySelector('input').value === 'hey @A ' && c.classList.contains('typing') && !c.querySelector('.names button'))({cw})"), True)
        check("a line that mentions A (@A), however it comes: A's window shows it apart, and the line says so; @Ab is no mention", await a.js(
            "(v._chatMsg({ type: 'chat', scope: 'lobby', id: 'o-test', key: 'k', name: 'Zed', text: 'look, @A' }, false), v._chatMsg({ type: 'chat', scope: 'lobby', id: 'o-test', key: 'k', name: 'Zed', text: 'hey @Ab' }, false),"
            f" (l => [v.chatLog.at(-2).mention, v.chatLog.at(-1).mention, l.at(-2).classList.contains('mention'), l.at(-1).classList.contains('mention')])([...{cw}.querySelectorAll('.log .line')]))"), [True, False, True, False])
        await b.key("Escape", "Escape", 27, True)
        await b.key("Escape", "Escape", 27, False)
        await enter(a)
        await a.call("Input.insertText", text="/room")
        await enter(a)
        check("/room alone, Enter: A's box goes to its own room's chat, still open", await a.until(
            f"(c => c.dataset.scope === 'sim' && c.classList.contains('typing') && c.querySelector('select').selectedOptions[0].textContent)({cw})"), "To your room:")
        await a.call("Input.insertText", text="for everyone here")
        await enter(a)
        check("said: B, linked with A (A visits it), has it in its chat, A's room's", await b.until(
            "(l => l && l.scope === 'sim' && l.name === 'A' && l.to.name === 'A' && l.to.key !== v.key && l.text)(v.chatLog.at(-1))"), "for everyone here")
        check("B's window: [A's room] [A]; A's: [Your room] [A]", (await b.until(f"(t => t.includes('everyone') && t)({cw}.querySelector('.log').lastChild.textContent)"),
              await a.js(f"{cw}.querySelector('.log').lastChild.textContent")), ("[A's room] [A]: for everyone here", "[Your room] [A]: for everyone here"))
        await b.js(f"{cw}.querySelector('button.headset').click()")
        check("B's 🎧 (its box not on a room): into its own room's voice, a line over the box saying so", await b.until(
            f"!!v.roomVoice && v.roomVoice.key === v.key && {cw}.querySelector('.voice').textContent.startsWith('🎧 Your room: you')"), True)
        await a.js("v.joinVoice(v.visiting.host.key)")
        check("A joins it: both lines say who is in it", (await a.until(f"(t => t.startsWith('🎧 B') && t.includes('B · you'))({cw}.querySelector('.voice').textContent)"),
              await b.until(f"{cw}.querySelector('.voice').textContent.includes('you · A')")), (True, True))
        await b.js("document.querySelector('.visit-panel .sub') || document.querySelector('.visit-panel button.who').click()")
        check("B opens A's row: ban voice, ban chat, Kick from voice", await b.until(
            "(s => !!s && [...s.querySelectorAll('button')].map(b => b.textContent).filter(t => /ban|voice/.test(t)).join())(document.querySelector('.visit-panel .sub'))"), "ban voice,ban chat,Kick from voice")
        await b.js("document.querySelector('.visit-panel .sub button[data-v=ban][data-what=chat]').click()")
        check("ban chat: kept, and A told (its window says so)", (await b.until("v.bans.length === 1 && v.bans[0].chat && !v.bans[0].voice && v.bans[0].name"),
              await a.until(f"v.bannedBy.length === 1 && {cw}.querySelector('.log').textContent.includes('keeps you out of its chat')")), ("A", True))
        await b.js("document.querySelector('.visit-panel .sub button[data-v=ban][data-what=chat]').click()")
        check("clicked again: lifted", (await b.until("v.bans.length === 0"), await a.until("v.bannedBy.length === 0")), (True, True))
        await b.js("document.querySelector('.visit-panel .sub button[data-v=voice_kick]').click()")
        check("Kick from voice: A is out, told why", await a.until(f"!v.roomVoice && {cw}.querySelector('.log').textContent.includes('took you out of their room')"), True)
        await b.js(f"{cw}.querySelector('.voice button[data-v=leave]').click()")
        check("B's Leave: out of its own voice, the line gone", await b.until(f"!v.roomVoice && {cw}.querySelector('.voice').textContent === ''"), True)
        await enter(a)
        await a.call("Input.insertText", text="/s ")
        await a.js("""(async () => {
            const c = document.createElement('canvas'); c.width = 64; c.height = 48;
            const g = c.getContext('2d'); g.fillStyle = '#e33'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#3e3'; g.fillRect(16, 12, 32, 24);
            const blob = await new Promise(r => c.toBlob(r, 'image/png'));
            const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
            document.querySelector('.visit-chat input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        })()""")
        check("A pastes a picture into the box: it waits over the box, kept by A's visit-client", await a.until(
            f"(c => c.querySelectorAll('.attach .chip').length === 1 && !c.querySelector('.attach .chip.busy'))({cw})"), True)
        await a.call("Input.insertText", text="my screen")
        await enter(a)
        check("Enter: said with it, in B's room; B's window shows the line and the picture (from B's own visit-client, which had it from A's)", await b.until(
            f"(l => !!l && l.textContent.includes('my screen') && (i => !!i && i.src.startsWith('blob:') && i.complete && i.naturalWidth === 64)(l.querySelector('img.pic')))({cw}.querySelector('.log').lastChild)"), True)
        check("and A's own, the box empty again", await a.until(f"(c => (i => !!i && i.naturalWidth === 64)(c.querySelector('.log').lastChild.querySelector('img.pic')) && !c.querySelector('.attach .chip'))({cw})"), True)
        await b.js(f"{cw}.querySelector('.log').lastChild.querySelector('img.pic').click()")
        check("B clicks it: full size, over everything; a click, gone", (await b.until("!!document.querySelector('.visit-lightbox img')"),
              await b.js("(d => (d.click(), !document.querySelector('.visit-lightbox')))(document.querySelector('.visit-lightbox'))")), (True, True))
        await enter(b)
        await b.call("Input.insertText", text="/s ")
        await b.js(f"{cw}.querySelector('button.gallery').click()")
        check("B's 🖼 (its box on its own room): what was shared in it, from its database: A's picture", await b.until(
            f"(s => s.classList.contains('on') && s.querySelectorAll('.grid img').length === 1 && s.querySelector('.tabs b').textContent)({cw}.querySelector('.shared'))"), "Shared in your room")
        await b.js(f"{cw}.querySelector('.shared button[data-k=links]').click()")
        check("its links: none yet", await b.until(f"(t => t.includes('No links') && t)({cw}.querySelector('.shared .items').textContent)"), "No links shared here yet")
        await b.js(f"{cw}.querySelector('.shared button[data-k=close]').click()")
        await b.key("Escape", "Escape", 27, True)
        await b.key("Escape", "Escape", 27, False)
        await a.js("window.cw2 = Visit.chat(v, { fade: 300 })")
        check("a window idle a while fades away", await a.until("cw2.element.classList.contains('idle')"), True)
        await b.js("v.say('wake up')")
        check("and comes back with the next line", await a.until("!cw2.element.classList.contains('idle') && cw2.element.querySelector('.log').lastChild.textContent"), "[B] says: wake up")
        await a.js("cw2.release()")
        await a.shot("a_chat.png")
        await b.shot("b_chat.png")
        check("six lines at once: the sixth not said (5 every 10 s)", await a.js("(r => r[5])(Array.from({ length: 6 }, (_, i) => v.say('n' + i)))"), False)
        await a.call("Page.reload")
        check("A's page reloads: its chat window has the chat A had, kept by its visit-client, its own lines too, before the window's note; no bubbles, all old",
              await a.until(f"window.v && v.visiting && v.chatLog.length > 5 && (c => !!c && (t => [t.includes('[B] whispers: psst'), t.includes('[Your room] [A]: for everyone here'), "
                            f"t.includes('[B] says: wake up'), t.at(-1).startsWith('Enter to chat'), v.chats.length === 0, v.chatLog.every(l => l.old)])"
                            f"([...c.querySelectorAll('.log .line')].map(d => d.textContent)))({cw})", 30), [True] * 6)
        check("and the box still says where A's lines went (this tab): Say, as A last chose", await a.js("JSON.parse(sessionStorage.getItem('visit:chat-to')).scope"), "say")
        await a.until("v.visiting && !v.visiting.paused && !!(v._viewer && v._viewer.scene)", 30)
        await a.js("v.leave()")
        await b.until("v.visitors.length === 0")
        await a.js("v.setMic(false)")
        await b.js("v.setMic(false)")
        check("each back in its own room, microphones off: nobody near, nothing captured", (await a.until("v.voices.length === 0 && !v._mic"), await b.until("v.voices.length === 0 && !v._mic")), (True, True))

        print("\na phone: a call across rooms")
        await a.js("v.link(v.offices.find(o => o.name === 'B').id)")
        await b.until("v.knocks.length === 1 && v.knocks[0].link")
        await b.js("v.answer(v.knocks[0].id, true)")
        await a.until("v.links.length === 1")
        kb = await a.js("v.offices.find(o => o.name === 'B').key")
        check("linked: A sees B's room has a phone (and B A's)", (await a.until("v.phones.length === 1 && v.phones[0].name"), await b.until("v.phones.length === 1 && v.phones[0].name")), ("B", "A"))
        await b.js("v.phone(true, { at: { x: room.me.x + 1, y: 1, z: room.me.z } })")   # B's phone, a step from B: Visit's ready-made one
        check("B's room has Visit's ready-made phone, where B said", await b.until("(p => !!p && !!p.g.parent && p.g.name === 'visit:phone-model')(v._phoneObj)"), True)
        check("A's panel offers B's phone to call", await a.until("(b => b && b.textContent)(document.querySelector('.visit-panel button[data-v=call]'))"), "B")
        await a.js("document.querySelector('.visit-panel button[data-v=call]').click()")
        check("A calls B: B's phone rings (its panel too)", await b.until("v.calls.length === 1 && v.calls[0].state === 'ringing' && document.querySelector('.visit-panel').textContent.includes('A is calling')"), True)
        check("B's phone shakes and says RING RING while it rings", await b.until("(p => Math.abs(p.handset.rotation.z) > 0.01 || p.ring.visible)(v._phoneObj)"), True)
        check("and A sees it in B's room (it is in B's scene)", await a.until("!!(v._viewer && v._viewer.scene && v._viewer.scene.root.getObjectByName('visit:phone-model'))"), True)
        await b.js("document.querySelector('.visit-panel button[data-v=pick_up]').click()")
        check("B picks up: on, both ways, each in its own room", (await a.until("v.calls.length === 1 && v.calls[0].state === 'on'"), await b.until("v.calls.length === 1 && v.calls[0].state === 'on'")), (True, True))
        check("A hears B, as a telephone (not by where anyone stands), and B A", (await a.until("(s => !!s && s.frames > 50 && s.level > 0.005)(v._voices.get('call:' + v.calls[0].key))"),
              await b.until("(s => !!s && s.frames > 50 && s.level > 0.005)(v._voices.get('call:' + v.calls[0].key))")), (True, True))
        check("the microphone on for the call only: nobody near either", (await a.js("!v.mic && !!v._mic && v.voices.length === 0"), await b.js("!v.mic && !!v._mic")), (True, True))
        ka = await b.js("v.calls[0].key")
        await b.js("v.phone(true, { at: { x: room.me.x + 1, y: 1, z: room.me.z } })")   # B's phone, a step from B
        check("B's handset off its cradle, at B's ear", await b.until("!v._phoneObj.handset.visible && !v._phoneObj.ring.visible"), True)
        await b.js("document.querySelector('.visit-panel button[data-v=speaker]').click()")
        check("B puts it on speaker: its lamp lit, its handset back", await b.until("v._phoneObj.lamp.visible && v._phoneObj.handset.visible"), True)
        check("B puts it on speaker: A's voice from B's phone, heard where B stands (its voice for the call only: its microphone is off)", await b.until(
            "v.calls[0].speaker && (s => !!s && s.near && s.frames > 10)(v._voices.get(" + json.dumps("call:" + ka) + ")) && v._voiceTo === 2"), True)
        heard = "(s => s ? s.frames : 0)(v._voices.get('call:' + v.calls[0].key))"
        async def growing(tab):
            f0 = await tab.js(heard)
            await asyncio.sleep(1.0)
            return await tab.js(heard) - f0 > 20
        check("and B, near it, heard by A", await growing(a), True)
        await b.js("v.phone(true, { at: { x: room.me.x + 100, y: 1, z: room.me.z } })")
        await b.until("!v._voices.get(" + json.dumps("call:" + ka) + ").near")
        await asyncio.sleep(0.5)
        check("B far from its phone: B not hearing the call, and (B's visit-client deciding) not heard in it", await growing(a), False)
        await b.js("document.querySelector('.visit-panel button[data-v=speaker]').click()")
        check("back to the handset: only B, to its ear, heard by A again", (await b.until("!v.calls[0].speaker && v._voiceTo === 2"), await growing(a)), (True, True))
        await a.js("v.hangUp(%s)" % json.dumps(kb))
        check("A hangs up: over for both, microphones off again", (await a.until("v.calls.length === 0 && !v._mic"), await b.until("v.calls.length === 0 && !v._mic")), (True, True))
        await a.js("v.unlink()")
        await b.until("v.watchers.length === 0")

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
