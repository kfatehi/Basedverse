#!/usr/bin/env python3
"""One office of a perf run with a real browser: what node.py does, but the page is the test workroom
(../room.html, its busy scene) in a headless Chromium in this same container, so visit.js encodes, decodes
and draws for real. This drives that Chromium (its debugging protocol, on this container's own loopback).

- host: lets every knock in; records each encoded frame's size (keyframes apart), and once a second its
  visitors' frame rate, render scale and bitrate, and how much of the page's time rendering for them takes;
- visitor: knocks, then walks and turns steadily (W held, the look turning 0.004 rad every 8 ms, as a mouse
  would), and after a warm-up records each frame drawn and its input to screen (visit.js's own measure).

    browser_node.py host|visitor NAME --lobby URL [--host NAME] [--seconds 20] [--net ...] [--room "scene=busy&cost=4"]

Writes /out/NAME.json (the host: every second, as it may be stopped at any time).
"""
import argparse
import asyncio
import http.server
import itertools
import json
import os
import functools
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
    await tab.until("window.v && v.state === 'online'")
    await tab.js("""v.on('knock', k => v.answer(k.id, true));
      window.__asked = 0; const hm = v._hostMessage.bind(v); v._hostMessage = m => { if (m.type === 'keyframe') window.__asked++; return hm(m); };
      window.__forced = 0; const rf = v._renderFor.bind(v); v._renderFor = (h, now, input) => { if (h.keyNext) window.__forced++; return rf(h, now, input); };
      window.__sizes = []; const send = v._sendChunk.bind(v);
      v._sendChunk = (h, c) => { window.__sizes.push([c.type === 'key' ? 1 : 0, c.byteLength]); return send(h, c); }; true""")
    seconds = []
    while True:
        await asyncio.sleep(1)
        snap = await tab.js("""(() => { const b = v._busy, now = performance.now();
          return { share: b ? b.spent / Math.max(1, now - b.since) : 0,
                   visits: [...v._hosted.values()].map(h => ({ fps: h.fps, scale: h.scale, width: h.width, height: h.height, codec: h.codec, bps: h.bps, accel: h.accel })) }; })()""")
        sizes = await tab.js("window.__sizes.splice(0)")
        asked = await tab.js("[window.__asked, window.__forced]")
        seconds.append(dict(snap, sizes=sizes, keyframes_asked=asked[0], keyframes_forced=asked[1]))
        json.dump({"role": "host", "name": args.name, "seconds": seconds[-120:], "errors": tab.errors[-20:]}, open("/out/%s.json" % args.name, "w"))


async def visitor(args, tab):
    door = await tab.until("window.v && v.state === 'online' && (v.offices.find(o => o.name === %s && o.ready) || {}).id" % json.dumps(args.host))
    if args.codec:   # this visitor decodes only that codec, so the host encodes it
        await tab.js("v._decoders = %s; v._sendDecoders(); true" % json.dumps([args.codec]))
    await tab.js("v.knock(%s)" % json.dumps(door))
    await tab.until("v.visiting && (v.frames || 0) > 10")
    await tab.js("""window.__drive = setInterval(() => { const w = v._view; if (!w) return;
      w.keys.add('KeyW'); w.yaw += 0.004; v._sendInput(performance.now(), true); }, 8);
      window.__asked = 0; const send = v._send.bind(v); v._send = m => { if (m.type === 'keyframe') window.__asked++; return send(m); };
      window.__bytes = 0; window.__keys = 0; const frame = v._frame.bind(v);
      v._frame = b => { window.__bytes += b.byteLength; if (new DataView(b).getUint8(2) & 1) window.__keys++; return frame(b); }; true""")
    await asyncio.sleep(WARMUP)
    await tab.js("v._samples = { latency: [], drawn: [] }; window.__bytes = 0; window.__keys = 0; window.__asked = 0; window.__t0 = performance.now(); true")
    links = []
    for _ in range(int(args.seconds)):
        await asyncio.sleep(1)
        s = await tab.js("v.stats")
        if s and s.get("path"):
            links.append({"path": s["path"], "rtt_ms": s["rtt"]})
    r = await tab.js("({ lat: v._samples.latency, drawn: v._samples.drawn, bytes: window.__bytes, keys: window.__keys, asked: window.__asked, secs: (performance.now() - window.__t0) / 1000 })")
    gaps = [b - a for a, b in zip(r["drawn"], r["drawn"][1:])]
    return {"name": args.name, "latency_ms": r["lat"], "frames": len(r["drawn"]), "seconds": r["secs"], "keyframes": r["keys"], "bytes": r["bytes"],
            "gaps_over_100ms": sum(1 for g in gaps if g > 100), "worst_gap_ms": max(gaps) if gaps else None, "link": links,
            "keyframes_asked": r["asked"], "errors": tab.errors[-20:], "browser": True}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("role", choices=["host", "visitor"])
    ap.add_argument("name")
    ap.add_argument("--lobby", required=True)
    ap.add_argument("--host", default="Host")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--net", default="")
    ap.add_argument("--room", default="scene=busy")
    ap.add_argument("--codec", default="", help="visitor: the only codec it decodes (the host's choice otherwise)")
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
    finally:
        if result is not None:
            json.dump(result, open("/out/%s.json" % args.name, "w"))
        chrome.terminate()
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
