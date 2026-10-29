#!/usr/bin/env python3
"""visit-engine's driver (engine/SPEC.md 5): a headless Chromium, spoken to over its devtools pipe; the room's
server page loaded in it with the engine's key, the shim (shim.js) in front of it, kept alive, and /health.
Python's standard library only.

    engine.py [--room-url URL] [--key-file FILE] [--token-file FILE] ...   (each setting of SPEC 5.2; a flag wins
    engine.py --version                                                      over its variable)

Test aid, not part of the contract: with --debug (ENGINE_DEBUG=1), POST /debug/eval runs the body as JavaScript
in the page and answers its value as JSON, POST /debug/crash crashes the page's renderer; `engine.py --eval EXPR`
is a client for the first (http://127.0.0.1:ENGINE_PORT). Nothing of it exists without the flag.
"""
import argparse
import collections
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VERSION = "0.0.0-dev"
SETTINGS = [   # flag, variable, default, what (SPEC 5.2)
    ("room-url", "ENGINE_ROOM_URL", None, "the room's server page"),
    ("key-file", "ENGINE_KEY_FILE", None, "an API key of auth-client's, in a file"),
    ("visit-host", "VISIT_HOST", "visit", "visit-client, by its name on the network"),
    ("visit-port", "VISIT_PORT", "7401", "visit-client's port"),
    ("token-file", "VISIT_TOKEN_FILE", None, "the host token's file"),
    ("port", "ENGINE_PORT", "7405", "/health"),
    ("tick-idle", "ENGINE_TICK_IDLE", "10", "frames a second with nobody there (1 to 60)"),
    ("memory-max", "ENGINE_MEMORY_MAX", "1024", "MiB, the browser's, past which it is restarted"),
    ("window", "ENGINE_WINDOW", "1280x720", "the page's window size"),
    ("log", "ENGINE_LOG", "info", "error, warn, info or debug"),
]
LEVELS = {"error": 0, "warn": 1, "info": 2, "debug": 3}
READY_S, STALL_S, BACKOFF_MAX_S, MEMORY_EVERY_S = 60, 10, 30, 5   # SPEC 5.1 point 6, 10

# What the driver asks the page once a second (SPEC 5.1, points 5 and 6): who is there (visit.js's visitors,
# watchers and owner, the page's connection as window.visit), the shim's frame count, and whether `ready` came.
# `ready` is read as the page having its connection: Visit.connect resolves on `ready`, and the server page keeps
# what it resolves to as window.visit.
PROBE = """(() => { const v = window.visit, E = window.VISIT_ENGINE;
  const n = v && typeof v === "object" ? ((v.visitors || []).length + (v.watchers || []).length + (v.owner ? 1 : 0)) : 0;
  if (E) E.idle = n === 0;
  return JSON.stringify({ frames: E ? E.frames : null, people: n, ready: !!(v && typeof v === "object" && v.office !== undefined) }); })()"""


def version():
    try:
        with open(os.path.join(HERE, "..", "VERSION")) as f:
            return f.read().strip() or DEFAULT_VERSION
    except OSError:
        return DEFAULT_VERSION


class Log:
    level = LEVELS["info"]

    @classmethod
    def log(cls, level, msg):
        if LEVELS[level] <= cls.level:
            print("%s %-5s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), level, msg), file=sys.stderr, flush=True)


log = Log.log


class BrowserGone(Exception):
    """The browser's pipe is closed: it exited, or is being stopped."""


class CDPError(Exception):
    """The browser answered a command with an error."""


class CDPTimeout(Exception):
    """A command went unanswered: the page's main thread is busy, or stuck."""


class Browser:
    """One Chromium over --remote-debugging-pipe: commands in on its fd 3, answers and events out on its fd 4,
    each a JSON message ended by a NUL byte. Commands may carry a sessionId (a page attached flat). Events go to
    `on_event` on the reading thread, which must only `post`, never `call` (the answer would wait on itself)."""

    def __init__(self, argv, on_event):
        self.on_event = on_event
        to_browser, from_browser = os.pipe(), os.pipe()
        def place():   # in the child: the pipes' ends onto 3 and 4, via copies, whatever 3 and 4 hold there
            r, w = os.dup(to_browser[0]), os.dup(from_browser[1])
            os.dup2(r, 3)
            os.dup2(w, 4)
        self.proc = subprocess.Popen(argv, pass_fds=(3, 4), preexec_fn=place, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        os.close(to_browser[0])
        os.close(from_browser[1])
        self.w, self.r = to_browser[1], from_browser[0]
        self.n, self.pending, self.lock, self.wlock = 0, {}, threading.Lock(), threading.Lock()
        self.gone = threading.Event()
        self.stderr = collections.deque(maxlen=40)   # the browser's last lines, for when it dies
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain, daemon=True).start()

    @property
    def pid(self):
        return self.proc.pid

    def _read(self):
        buf = bytearray()
        while True:
            try:
                d = os.read(self.r, 1 << 16)
            except OSError:
                d = b""
            if not d:
                break
            buf += d
            while True:
                i = buf.find(b"\0")
                if i < 0:
                    break
                raw = bytes(buf[:i])
                del buf[:i + 1]
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if "id" in m:
                    with self.lock:
                        slot = self.pending.pop(m["id"], None)
                    if slot:
                        slot[1] = m
                        slot[0].set()
                else:
                    try:
                        self.on_event(m)
                    except Exception as e:   # a handler's slip must not stop the reading
                        log("error", "event %s: %r" % (m.get("method"), e))
        self.gone.set()
        with self.lock:
            waiting, self.pending = list(self.pending.values()), {}
        for slot in waiting:
            slot[1] = {"error": {"message": "the browser is gone"}}
            slot[0].set()

    def _drain(self):
        for line in self.proc.stderr:
            line = line.decode("utf-8", "replace").rstrip()
            self.stderr.append(line)
            log("debug", "chromium: " + line)

    def post(self, method, params=None, session=None):
        """Send a command and return at once; its slot is set when the answer comes."""
        if self.gone.is_set():
            raise BrowserGone()
        with self.lock:
            self.n += 1
            n = self.n
            slot = [threading.Event(), None, n]
            self.pending[n] = slot
        msg = {"id": n, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        data = json.dumps(msg).encode() + b"\0"
        try:
            with self.wlock:
                while data:
                    data = data[os.write(self.w, data):]
        except OSError:
            with self.lock:
                self.pending.pop(n, None)
            raise BrowserGone()
        return slot

    def call(self, method, params=None, session=None, timeout=10):
        slot = self.post(method, params, session)
        if not slot[0].wait(timeout):
            with self.lock:
                self.pending.pop(slot[2], None)
            raise CDPTimeout(method)
        m = slot[1]
        if "error" in m:
            if self.gone.is_set():
                raise BrowserGone()
            raise CDPError("%s: %s" % (method, m["error"].get("message", m["error"])))
        return m.get("result", {})

    def alive(self):
        return self.proc.poll() is None and not self.gone.is_set()

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        for fd in (self.w, self.r):
            try:
                os.close(fd)
            except OSError:
                pass
        self.gone.set()


def children(pid):
    """pid and every descendant of it, from /proc."""
    by_parent = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % p) as f:
                stat = f.read()
        except OSError:
            continue
        ppid = int(stat[stat.rindex(")") + 2:].split()[1])
        by_parent.setdefault(ppid, []).append(int(p))
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        out.append(p)
        todo.extend(by_parent.get(p, []))
    return out


def kib_of(path, keys):
    """The sum of the lines of a /proc file that start with one of keys, in KiB; None if it cannot be read or has none."""
    total, found = 0, False
    try:
        with open(path) as f:
            for line in f:
                if line.startswith(keys):
                    total, found = total + int(line.split()[1]), True
    except (OSError, IndexError, ValueError):
        return None
    return total if found else None


def memory_mib(pid):
    """What the browser's processes hold together, in MiB: anonymous and shared memory, each page counted once
    (Pss from /proc/<pid>/smaps_rollup; a process that will not show it, counted by RssAnon and RssShmem from
    /proc/<pid>/status). The binary mapped in every process is not the browser's doing and is left out: a plain
    sum of RSS puts an idle browser near 1 GB, past the default ENGINE_MEMORY_MAX at once."""
    total = 0
    for p in children(pid):
        kib = kib_of("/proc/%d/smaps_rollup" % p, ("Pss_Anon:", "Pss_Shmem:"))
        if kib is None:
            kib = kib_of("/proc/%d/status" % p, ("RssAnon:", "RssShmem:")) or 0
        total += kib
    return total / 1024


def reap(keep):
    """As the container's PID 1 the driver inherits the browser's orphans; their exits are collected here, the
    live browser's own left to Popen."""
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) == keep:
            continue
        try:
            with open("/proc/%s/stat" % p) as f:
                stat = f.read()
            rest = stat[stat.rindex(")") + 2:].split()
            if rest[0] == "Z" and int(rest[1]) == os.getpid():
                os.waitpid(int(p), os.WNOHANG)
        except (OSError, ChildProcessError, IndexError, ValueError):
            pass


class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.room, self.since, self.reloads = "loading", int(time.time() * 1000), 0
        self.stop_event = threading.Event()
        self.browser = None
        self.session = None          # the page's devtools session, while there is one
        self.target = None           # its tab
        self.no_sandbox = False      # set when the container cannot run Chromium's own sandbox
        self.crashed = threading.Event()
        self.documents = {}          # loaderId -> HTTP status of a main document, from Network.responseReceived
        self.profile = tempfile.mkdtemp(prefix="visit-engine-")
        with open(os.path.join(HERE, "shim.js")) as f:
            self.shim_template = f.read()
        u = urllib.parse.urlsplit(cfg.room_url)
        self.origin = "%s://%s" % (u.scheme, u.netloc)
        self.width, self.height = cfg.window

    # ----- /health -----
    def health(self):
        return {"ok": self.room != "failed", "version": version(), "room": self.room, "since": self.since, "reloads": self.reloads}

    def set_room(self, state):
        if state != self.room:
            self.room, self.since = state, int(time.time() * 1000)

    # ----- the browser -----
    def start_browser(self):
        chromium = shutil.which("chromium") or shutil.which("chromium-browser") or "chromium"
        while not self.stop_event.is_set():
            argv = [chromium, "--headless=new", "--disable-gpu", "--enable-unsafe-swiftshader", "--no-first-run",
                    "--no-default-browser-check", "--window-size=%d,%d" % (self.width, self.height), "--remote-debugging-pipe",
                    "--user-data-dir=" + self.profile, "--disable-dev-shm-usage", "about:blank"]
            if self.no_sandbox:
                argv.insert(2, "--no-sandbox")
            try:
                b = Browser(argv, self.on_event)
            except OSError as e:
                log("error", "cannot start %s: %s" % (chromium, e))
                sys.exit(1)
            try:
                v = b.call("Browser.getVersion", timeout=30)
                log("info", "%s started (pid %d%s)" % (v.get("product", "chromium"), b.pid, ", no sandbox" if self.no_sandbox else ""))
                return b
            except (BrowserGone, CDPTimeout):
                b.stop()
                tail = "\n".join(b.stderr)
                if not self.no_sandbox and re.search(r"sandbox|namespace", tail, re.I):
                    # SPEC 5.3: its own sandbox where the container allows it, the container the boundary where not.
                    log("warn", "Chromium's sandbox cannot run in this container (%s): the container is the boundary; starting it with --no-sandbox"
                        % next((l for l in b.stderr if re.search(r"sandbox|namespace", l, re.I)), "?").split("] ")[-1][:160])
                    self.no_sandbox = True
                    continue
                log("error", "chromium did not start%s" % (": " + tail[-600:] if tail else ""))
                self.set_room("failed")
                reap(None)
                self.stop_event.wait(5)
        return None

    def stop_browser(self):
        b, self.browser, self.session, self.target = self.browser, None, None, None
        if b:
            b.stop()
            reap(None)

    # ----- events from the page -----
    def on_event(self, m):
        method, p, session = m.get("method"), m.get("params", {}), m.get("sessionId")
        if method == "Fetch.requestPaused":
            # The engine's key on every request to the room's origin (the pattern given to Fetch.enable), and on
            # nothing else: a CDN or visit-client never sees it.
            headers = [{"name": k, "value": v} for k, v in p["request"]["headers"].items() if k.lower() != "authorization"]
            headers.append({"name": "Authorization", "value": "Bearer " + self.key})
            b = self.browser
            try:
                if b:
                    b.post("Fetch.continueRequest", {"requestId": p["requestId"], "headers": headers}, session)
            except BrowserGone:
                pass
        elif method == "Network.responseReceived":
            if p.get("type") == "Document":
                self.documents[p.get("loaderId")] = p["response"].get("status")
                while len(self.documents) > 32:   # frames' documents, never asked for
                    del self.documents[next(iter(self.documents))]
        elif method == "Runtime.consoleAPICalled":
            kind = p.get("type")
            level = "error" if kind in ("error", "assert") else "warn" if kind == "warning" else "debug" if kind in ("debug", "trace", "count", "timeEnd") else "info"
            log(level, "page: " + " ".join(describe(a) for a in p.get("args", [])))
        elif method == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            text = d.get("exception", {}).get("description") or d.get("text", "?")
            where = d.get("url")
            log("error", "page: %s%s" % (text, " (%s:%s)" % (where, d.get("lineNumber")) if where else ""))
        elif method == "Log.entryAdded":
            e = p.get("entry", {})
            level = {"verbose": "debug", "info": "info", "warning": "warn", "error": "error"}.get(e.get("level"), "info")
            log(level, "page: %s%s" % (e.get("text", ""), " (%s)" % e["url"] if e.get("url") else ""))
        elif method == "Inspector.targetCrashed" and session == self.session:
            self.crashed.set()
        elif method == "Target.detachedFromTarget" and p.get("sessionId") == self.session:   # on the browser's own session
            self.crashed.set()

    # ----- the page -----
    def read_files(self):
        with open(self.cfg.key_file) as f:
            self.key = f.read().strip()
        with open(self.cfg.token_file) as f:
            self.token = f.read().strip()
        if not self.key or not self.token:
            raise OSError("empty")

    def shim(self):
        url = "ws://%s:%d/ws" % (self.cfg.visit_host, self.cfg.visit_port)
        return (self.shim_template.replace('"__URL__"', json.dumps(url)).replace('"__TOKEN__"', json.dumps(self.token))
                .replace("__TICK_IDLE__", str(self.cfg.tick_idle)))

    def load(self):
        """A fresh tab with the shim, navigated to the room; the tabs before it closed."""
        b = self.browser
        target = b.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = b.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        self.crashed.clear()
        self.session, self.target = session, target
        for method, params in [
            ("Page.enable", {}), ("Runtime.enable", {}), ("Log.enable", {}), ("Network.enable", {}), ("Inspector.enable", {}),
            ("Emulation.setDeviceMetricsOverride", {"width": self.width, "height": self.height, "deviceScaleFactor": 1, "mobile": False}),
            ("Fetch.enable", {"patterns": [{"urlPattern": self.origin + "/*"}]}),
            ("Page.addScriptToEvaluateOnNewDocument", {"source": self.shim()}),
        ]:
            b.call(method, params, session)
        for t in b.call("Target.getTargets").get("targetInfos", []):
            if t["type"] == "page" and t["targetId"] != target:
                b.post("Target.closeTarget", {"targetId": t["targetId"]})
        r = b.call("Page.navigate", {"url": self.cfg.room_url}, session, timeout=READY_S)
        if r.get("errorText"):
            raise CDPError("could not load %s: %s" % (self.cfg.room_url, r["errorText"]))
        loader = r.get("loaderId")
        for _ in range(20):   # the document's status comes as an event, usually before navigate answers
            if loader in self.documents:
                break
            time.sleep(0.1)
        status = self.documents.pop(loader, None)
        if status and status >= 400:
            raise CDPError("could not load %s: HTTP %d" % (self.cfg.room_url, status))

    def probe(self):
        """One question to the page: sets VISIT_ENGINE.idle; returns {frames, people, ready} or None if unanswered."""
        try:
            r = self.browser.call("Runtime.evaluate", {"expression": PROBE, "returnByValue": True, "timeout": 5000}, self.session, timeout=6)
        except CDPTimeout:
            return None
        except CDPError as e:
            log("debug", "probe: %s" % e)
            return None
        v = r.get("result", {}).get("value")
        return json.loads(v) if isinstance(v, str) else None

    def evaluate(self, expression):
        """The test aid's: an expression's value, awaited."""
        if not (self.browser and self.session):
            raise CDPError("no page")
        r = self.browser.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True, "timeout": 10000},
                              self.session, timeout=12)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise CDPError(d.get("exception", {}).get("description") or d.get("text", "exception"))
        return r.get("result", {}).get("value")

    def crash(self):
        """The test aid's: the renderer, crashed."""
        if not (self.browser and self.session):
            raise CDPError("no page")
        self.browser.post("Page.crash", {}, self.session)

    # ----- the loop -----
    def run(self):
        backoff = 1
        memory_checked = 0
        threading.Thread(target=self.stopper, daemon=True).start()
        while not self.stop_event.is_set():
            reap(self.browser.pid if self.browser else None)
            if not (self.browser and self.browser.alive()):
                self.stop_browser()
                self.browser = self.start_browser()
                if not self.browser:
                    break
            try:
                self.read_files()
            except OSError as e:
                self.fail("cannot read %s or %s (%s)" % (self.cfg.key_file, self.cfg.token_file, e), backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
                continue
            log("info", "room: loading %s%s" % (self.cfg.room_url, " (again, %d)" % self.reloads if self.reloads else ""))
            try:
                self.load()
            except (CDPError, CDPTimeout) as e:
                self.fail(str(e) if isinstance(e, CDPError) else "could not load %s: no answer in %d s" % (self.cfg.room_url, READY_S), backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
                continue
            except BrowserGone:
                self.fail("the browser exited", backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
                continue
            loaded = last_frame_at = time.monotonic()
            frames, hosting, reason = None, False, None
            while not self.stop_event.is_set():
                if self.stop_event.wait(1):
                    break
                now = time.monotonic()
                if not self.browser.alive():
                    reason = "the browser exited (code %s)" % self.browser.proc.poll()
                    break
                if self.crashed.is_set():
                    reason = "the page crashed"
                    break
                if now - memory_checked > MEMORY_EVERY_S:
                    memory_checked = now
                    reap(self.browser.pid)
                    mib = memory_mib(self.browser.pid)
                    log("debug", "browser: %.0f MiB" % mib)
                    if mib > self.cfg.memory_max:
                        log("warn", "browser at %.0f MiB, past ENGINE_MEMORY_MAX %d: starting it again" % (mib, self.cfg.memory_max))
                        self.stop_browser()
                        self.set_room("loading")
                        self.reloads += 1
                        break
                p = self.probe()
                if p and p.get("frames") is not None and p["frames"] != frames:
                    frames, last_frame_at = p["frames"], now
                if now - last_frame_at > STALL_S:
                    reason = "no frame in %d s" % STALL_S
                    break
                if not hosting:
                    if p and p.get("ready"):
                        hosting, backoff = True, 1
                        self.set_room("hosting")
                        log("info", "room: hosting")
                    elif now - loaded > READY_S:
                        reason = "`ready` never came in %d s" % READY_S
                        break
            if reason:
                self.fail(reason, backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
        self.stop_browser()
        shutil.rmtree(self.profile, ignore_errors=True)
        log("info", "stopped")

    def stopper(self):
        """On stop, the browser goes first: whatever command the loop waits on then fails, and the loop ends."""
        self.stop_event.wait()
        b = self.browser
        if b and b.proc.poll() is None:
            b.proc.terminate()

    def fail(self, reason, backoff):
        """A load that did not get there, or a room that went: say so, and wait before the next try."""
        self.set_room("failed")
        log("error", "room: failed (%s); loading again in %d s" % (reason, backoff))
        if self.browser and self.target:
            try:
                self.browser.post("Target.closeTarget", {"targetId": self.target})
            except BrowserGone:
                pass
        self.session = self.target = None
        self.reloads += 1
        self.stop_event.wait(backoff)


def describe(arg):
    """A console argument, as text."""
    if "value" in arg:
        v = arg["value"]
        return v if isinstance(v, str) else json.dumps(v)
    return arg.get("unserializableValue") or arg.get("description") or arg.get("type", "")


class HealthServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve_health(engine, cfg):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                self.answer(200, engine.health())
            else:
                self.answer(404, {"error": "not found"})

        def do_POST(self):   # the test aid (see the file's docstring); nothing without --debug
            if not cfg.debug or self.path not in ("/debug/eval", "/debug/crash"):
                return self.answer(404, {"error": "not found"})
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8", "replace")
            try:
                if self.path == "/debug/crash":
                    engine.crash()
                    self.answer(200, {"value": None})
                else:
                    self.answer(200, {"value": engine.evaluate(body)})
            except (CDPError, CDPTimeout, BrowserGone) as e:
                self.answer(500, {"error": str(e) or e.__class__.__name__})

        def answer(self, status, obj):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            log("debug", "health: " + fmt % args)

    try:
        server = HealthServer(("0.0.0.0", cfg.port), Handler)
    except OSError as e:
        print("engine: cannot listen on port %d for /health: %s" % (cfg.port, e), file=sys.stderr)
        sys.exit(2)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def settings(argv):
    ap = argparse.ArgumentParser(prog="engine", description="visit-engine: a room's server page, run headless beside visit-client (engine/SPEC.md 5).",
                                 add_help=True)
    for flag, var, default, what in SETTINGS:
        ap.add_argument("--" + flag, metavar=var, help="%s (%s%s)" % (what, var, ", default %s" % default if default else ", required"))
    ap.add_argument("--debug", action="store_true", help="the test aid's routes (ENGINE_DEBUG=1)")
    ap.add_argument("--eval", metavar="EXPR", help="test aid: run EXPR in the page of the engine on 127.0.0.1:ENGINE_PORT and print its value")
    ap.add_argument("--version", action="store_true", help="print the version and exit")
    a = ap.parse_args(argv)
    if a.version:
        print(version())
        sys.exit(0)
    cfg = argparse.Namespace(debug=a.debug or os.environ.get("ENGINE_DEBUG") == "1", eval=a.eval)
    missing = []
    for flag, var, default, what in SETTINGS:
        name = flag.replace("-", "_")
        v = getattr(a, name)
        if v is None:
            v = os.environ.get(var) or default
        if v is None:
            missing.append("--%s (%s)" % (flag, var))
        setattr(cfg, name, v)

    def bad(msg):
        print("engine: %s" % msg, file=sys.stderr)
        sys.exit(2)
    if a.eval is None and missing:
        bad("missing: " + ", ".join(missing))
    for name, lo, hi in [("visit_port", 1, 65535), ("port", 1, 65535), ("tick_idle", 1, 60), ("memory_max", 1, 1 << 30)]:
        try:
            v = int(getattr(cfg, name))
            if not lo <= v <= hi:
                raise ValueError()
            setattr(cfg, name, v)
        except (TypeError, ValueError):
            bad("%s must be a whole number from %d to %d, not %r" % (name.replace("_", "-"), lo, hi, getattr(cfg, name)))
    m = re.fullmatch(r"(\d{2,5})x(\d{2,5})", cfg.window or "")
    if not m:
        bad("window must be WIDTHxHEIGHT, like 1280x720, not %r" % cfg.window)
    cfg.window = (int(m.group(1)), int(m.group(2)))
    if cfg.log not in LEVELS:
        bad("log must be one of %s, not %r" % (", ".join(LEVELS), cfg.log))
    if a.eval is None and not re.match(r"https?://", cfg.room_url or ""):
        bad("room-url must be an http:// or https:// URL, not %r" % cfg.room_url)
    return cfg


def eval_client(cfg):
    """`engine.py --eval EXPR`: the test aid's client."""
    req = urllib.request.Request("http://127.0.0.1:%d/debug/eval" % cfg.port, data=cfg.eval.encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(json.dumps(json.load(r)["value"]))
    except urllib.error.HTTPError as e:
        print(json.load(e).get("error", str(e)), file=sys.stderr)
        sys.exit(1)


def main():
    cfg = settings(sys.argv[1:])
    if cfg.eval is not None:
        return eval_client(cfg)
    Log.level = LEVELS[cfg.log]
    engine = Engine(cfg)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *a: engine.stop_event.set())
    log("info", "visit-engine %s: %s; /health on %d%s" % (version(), cfg.room_url, cfg.port, "; --debug" if cfg.debug else ""))
    server = serve_health(engine, cfg)
    try:
        engine.run()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
