#!/usr/bin/env python3
"""One office of a perf run with a real browser: what node.py does, but the page is the test workroom
(../room.html, three.js, with ?movers=N moving cubes) in a headless Chromium in this same container, so visit.js
sends and draws scenes for real. This drives that Chromium (its debugging protocol, on its own loopback).

- host: lets every knock in; records once a second how long each of its scene updates took (reading the scene
  for changes, and sending them), and its visitors;
- visitor: knocks, then walks and turns steadily (W held, the look turning 0.004 rad every 8 ms, as a mouse
  would), and after a warm-up records each frame it draws, its input to screen (drawn here), and each delta's
  input to the host's answer.

    browser_node.py host|visitor NAME --lobby URL [--host NAME] [--seconds 20] [--net ...] [--room "movers=50"]

Writes /out/NAME.json (the host: every second, as it may be stopped at any time).
"""
import argparse
import asyncio
import http.server
import itertools
import json
import os
import functools
import sys
import threading
import time
import urllib.request

from websockets.asyncio.client import connect

from node import WARMUP, shape, start_client

TESTS = "/tests"


class Tab:
    def __init__(self):
        self.ids, self.errors, self.pending = itertools.count(1), [], {}

    async def start(self):
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
                url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
                break
            except Exception:   # noqa: BLE001 -- Chromium still starting
                await asyncio.sleep(0.2)
        self.ws = await connect(url, max_size=1 << 26)
        self.reader = asyncio.create_task(self._read())
        await self.call("Runtime.enable")
        await self.call("Page.enable")

    async def _read(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if m.get("method") == "Runtime.exceptionThrown":
                self.errors.append(m["params"]["exceptionDetails"].get("exception", {}).get("description", "?")[:300])
            elif m.get("method") == "Runtime.consoleAPICalled" and m["params"]["type"] == "error":
                self.errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"])[:300])
            elif "id" in m and m["id"] in self.pending:
                self.pending.pop(m["id"]).set_result(m)

    async def call(self, method, **params):
        i = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[i] = fut
        await self.ws.send(json.dumps({"id": i, "method": method, "params": params}))
        return await asyncio.wait_for(fut, 30)

    async def js(self, expr):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r.get("result", {}):
            raise RuntimeError(r["result"]["exceptionDetails"].get("exception", {}).get("description", expr))
        return r.get("result", {}).get("result", {}).get("value")

    async def until(self, expr, timeout=60):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = await self.js(expr)
            if v:
                return v
            await asyncio.sleep(0.2)
        raise TimeoutError(expr)


def serve_tests():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=TESTS)
    handler.log_message = lambda *a: None
    web = http.server.ThreadingHTTPServer(("127.0.0.1", 8000), handler)
    threading.Thread(target=web.serve_forever, daemon=True).start()


async def chromium():
    return await asyncio.create_subprocess_exec(
        "chromium", "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--remote-debugging-port=9222", "--user-data-dir=/tmp/chrome", "--window-size=1280,720", "--no-first-run",
        "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "about:blank", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)


async def host(args, tab):
    await tab.until("!!(window.v && v.state === 'online' && v._hooks)")
    await tab.js("""v.on('knock', k => v.answer(k.id, true)); for (const k of v.knocks) v.answer(k.id, true);   // and any that came first
      window.__ticks = []; const st = v._sceneTick.bind(v);
      v._sceneTick = now => { const t0 = performance.now(); st(now); if (v._hosted.size) window.__ticks.push(performance.now() - t0); }; true""")
    seconds = []
    while True:
        await asyncio.sleep(1)
        ticks = await tab.js("for (const k of v.knocks) v.answer(k.id, true); window.__ticks.splice(0)")
        seconds.append({"ticks": ticks, "visitors": await tab.js("v._hosted.size")})
        json.dump({"role": "host", "name": args.name, "seconds": seconds[-120:], "errors": tab.errors[-20:]}, open("/out/%s.json" % args.name, "w"))


async def visitor(args, tab):
    door = await tab.until("window.v && v.state === 'online' && v._hooks && (v.offices.find(o => o.name === %s && o.ready) || {}).id" % json.dumps(args.host))
    await tab.js("v.on('error', e => console.error('visit error', JSON.stringify(e))); v.knock(%s)" % json.dumps(door))
    await tab.until("v.visiting && v._viewer && v._viewer.scene && (v.frames || 0) > 10", 60)
    await tab.js("""window.__drive = setInterval(() => { const w = v._view; if (!w) return;
      w.keys.add('KeyW'); w.yaw += 0.004; w.changedAt = w.changedAt || performance.now(); v._sendInput(performance.now(), true); }, 8);
      window.__answers = []; window.__bytes = 0; window.__keys = 0;
      const f = v._frame.bind(v); v._frame = b => { window.__bytes += b.byteLength; const dv = new DataView(b);
        if (dv.getUint8(2) & 1) window.__keys++; if (b.byteLength >= 20) { const t = dv.getFloat64(12); if (t > 0) window.__answers.push(performance.now() - t); } return f(b); };
      const e = v._sceneEdit.bind(v); v._sceneEdit = m => { window.__bytes += JSON.stringify(m.edit).length; return e(m); }; true""")
    await asyncio.sleep(WARMUP)
    await tab.js("v._samples = { latency: [], drawn: [] }; window.__answers = []; window.__bytes = 0; window.__keys = 0; window.__t0 = performance.now(); true")
    links = []
    for _ in range(int(args.seconds)):
        await asyncio.sleep(1)
        s = await tab.js("v.stats")
        if s and s.get("path"):
            links.append({"path": s["path"], "rtt_ms": s["rtt"]})
    r = await tab.js("({ lat: window.__answers, here: v._samples.latency, drawn: v._samples.drawn, bytes: window.__bytes, keys: window.__keys, secs: (performance.now() - window.__t0) / 1000 })")
    gaps = [b - a for a, b in zip(r["drawn"], r["drawn"][1:])]
    return {"name": args.name, "latency_ms": r["lat"], "here_ms": r["here"], "frames": len(r["drawn"]), "seconds": r["secs"], "keyframes": r["keys"],
            "bytes": r["bytes"], "gaps_over_100ms": sum(1 for g in gaps if g > 100), "worst_gap_ms": max(gaps) if gaps else None, "link": links,
            "errors": tab.errors[-20:], "browser": True}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("role", choices=["host", "visitor"])
    ap.add_argument("name")
    ap.add_argument("--lobby", required=True)
    ap.add_argument("--host", default="Host")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--net", default="")
    ap.add_argument("--room", default="movers=50")
    args = ap.parse_args()
    shape(args.net)
    serve_tests()
    proc, token = await start_client(args.name, args.lobby, 7401)
    chrome = await chromium()
    tab = Tab()
    await tab.start()
    await tab.call("Page.navigate", url="http://127.0.0.1:8000/room.html?%s#port=7401&token=%s" % (args.room, token))
    result = None
    try:
        if args.role == "host":
            await host(args, tab)
        else:
            result = await visitor(args, tab)
    except Exception:
        json.dump({"errors": tab.errors[-20:]}, open("/out/%s.errors.json" % args.name, "w"))
        raise
    finally:
        if result is not None:
            json.dump(result, open("/out/%s.json" % args.name, "w"))
        chrome.terminate()
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
