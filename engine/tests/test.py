#!/usr/bin/env python3
"""The checks on the engine inside a running visit (run by run-engine.sh beside it: the engine's /health on
ENGINE_PORT, the test server on 3001/3002, visit's page port and host token in VISIT_PORT and TOKEN): the room
hosting, what the page measured (page.html, read through ENGINE_DEBUG's eval route), frames a second busy and
idle, a crash reloaded, and the browser's memory."""
import json
import os
import sys
import time
import urllib.request

ENGINE, ROOM, TOKEN = "http://127.0.0.1:%s" % os.environ["ENGINE_PORT"], "http://127.0.0.1", os.environ.get("TOKEN", "")
VISIT_PORT = int(os.environ["VISIT_PORT"])
fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print("%s  %s%s" % ("ok  " if ok else "FAIL", label, "" if ok else "\n      got  %r\n      want %r" % (got, want)), flush=True)


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)


def health():
    try:
        return get(ENGINE + "/health")
    except OSError:
        return {}


def ev(expr):
    req = urllib.request.Request(ENGINE + "/debug/eval", data=expr.encode(), method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["value"]


def results():
    return json.loads(ev("JSON.stringify(window.results)"))


def until(fn, timeout, every=0.2):
    end = time.monotonic() + timeout
    while True:
        v = fn()
        if v or time.monotonic() > end:
            return v
        time.sleep(every)


def room_is(state, timeout):
    return until(lambda: health().get("room") == state, timeout)


# 1. Up and hosting: the page loaded (so the key arrived: the server serves nothing without it), window.visit there.
check("the room is hosting within 60 s", room_is("hosting", 60), True)
h = health()
check("/health: ok, a version, no reload yet", (h.get("ok"), isinstance(h.get("version"), str) and h["version"] != "", h.get("reloads"), isinstance(h.get("since"), int)), (True, True, 0, True))

# 2. What the page saw.
r = until(lambda: (lambda r: r if "mic" in r and "subresource" in r and "other" in r and len(r["raf"]["history"]) >= 3 else None)(results()), 15)
check("the page's results are complete", bool(r), True)
r = r or {"webgl": {}, "visibility": {}, "engine": {}, "raf": {"history": []}, "window": {}}
check("VISIT_ENGINE: visit-client's url, the host token, role host, ENGINE_TICK_IDLE", r["engine"], {"url": "ws://127.0.0.1:%d/ws" % VISIT_PORT, "token": TOKEN, "role": "host", "tickIdle": 10, "idle": False})
check("a WebGL context, its program linked, no GL error", (r["webgl"].get("context") in ("webgl", "webgl2"), r["webgl"].get("linked"), r["webgl"].get("error")), (True, True, 0))
print("      (%s)" % r["webgl"].get("renderer"))
check("nothing drawn: a cleared canvas with a triangle reads back all zero", r["webgl"].get("drawn"), False)
check("a 2D canvas still draws", r.get("canvas2d"), True)
check("visible, not hidden, focused", r["visibility"], {"state": "visible", "hidden": False, "focus": True})
check("getUserMedia rejects NotFoundError", r.get("mic"), "NotFoundError")
check("the window is ENGINE_WINDOW (1280x720)", r["window"], {"w": 1280, "h": 720})
check("the key went with the page's own fetch", r.get("subresource"), 200)
seen = get(ROOM + ":3002/seen")
check("and not to another origin", (r.get("other"), seen["hits"] >= 1, seen["authorization"]), (200, True, 0))

# 3. Frames: 60 a second with a visitor, ENGINE_TICK_IDLE with nobody, 60 again.
busy = r["raf"]["history"][-2:]
check("about 60 frames a second with a visitor (%s)" % busy, all(50 <= n <= 70 for n in busy), True)
ev("window.visit.visitors = []; 1")
time.sleep(3.5)
r = results()
idle = r["raf"]["history"][-2:]
check("about 10 a second with nobody (%s), VISIT_ENGINE.idle true" % idle, (all(8 <= n <= 12 for n in idle), r["raf"]["idle"]), (True, True))
ev("window.visit.visitors = [{}]; 1")
time.sleep(3.5)
r = results()
busy = r["raf"]["history"][-2:]
check("60 again with a visitor back (%s), idle false" % busy, (all(50 <= n <= 70 for n in busy), r["raf"]["idle"]), (True, False))

# 4. A crash: failed, then loaded again and hosting.
before = r["loaded"]
urllib.request.urlopen(urllib.request.Request(ENGINE + "/debug/crash", data=b"", method="POST"), timeout=10).read()
check("a crashed page: /health says failed, ok false", room_is("failed", 5) and health().get("ok"), False)
check("and hosting again", room_is("hosting", 15), True)
h = health()
check("one reload counted", h.get("reloads"), 1)
check("the page is a new one", results()["loaded"] > before, True)

# 5. Memory: the browser's processes, as the engine counts them (Pss, anonymous and shared), under its ceiling.
def chrome_mib():
    total = 0
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            if not open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")[0].endswith(b"chrome-headless-shell"):
                continue
            for line in open("/proc/%s/smaps_rollup" % pid):
                if line.startswith(("Pss_Anon:", "Pss_Shmem:")):
                    total += int(line.split()[1])
        except OSError:
            pass
    return total // 1024
mib = chrome_mib()
check("the browser's memory within ENGINE_MEMORY_MAX, 1024 MiB (%d MiB)" % mib, 0 < mib < 1024, True)

print("%d failed" % fails if fails else "all ok", flush=True)
sys.exit(1 if fails else 0)
