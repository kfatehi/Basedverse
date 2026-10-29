#!/usr/bin/env python3
"""visit, started fresh on this machine as a person would start it (V2.md 6.2): release.yml runs it on every
platform's runner, natively, with nothing installed. An account made (its database made for the command, Postgres
started and stopped); visit run with the sign-in API and the engine hosting a page (engine/tests/page.html, served
here); hosting within 90 s; a sign-in through the API; the engine's key on the page's requests, one the API takes;
visit stopped, nothing of it left running; the account still there after. Python's standard library only.

  python3 visit/client/tests/fresh_start.py path/to/visit
"""
import http.server
import json
import os
import platform
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

VISIT = os.path.abspath(sys.argv[1])
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "..", "..", "..", "engine", "tests", "page.html")
WINDOWS = platform.system() == "Windows"
TMP = tempfile.mkdtemp(prefix="visit-fresh-")
DATA = os.path.join(TMP, "office")
ENV = dict(os.environ, VISIT_DATA_DIR=DATA)
if platform.system() == "Linux":
    ENV["XDG_DATA_HOME"] = os.path.join(TMP, "xdg")   # (macOS and Windows: the user's own data folder, a runner's)
PASSWORD = "correct horse battery staple"
seen = []   # the Authorization each request to the room's page carried
failures = []


def check(what, got, want):
    if got == want:
        print("ok    " + what, flush=True)
    else:
        failures.append(what)
        print("FAIL  %s\n      got  %r\n      want %r" % (what, got, want), flush=True)


def call(port, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method="POST" if data else "GET")
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except OSError:
        return 0, {}


def postgres_running():
    """How many of Postgres' processes run on this machine."""
    if WINDOWS:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq postgres.exe", "/NH"], capture_output=True, text=True).stdout
        return out.lower().count("postgres.exe")
    if os.path.isdir("/proc"):
        n = 0
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                n += open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")[0].endswith(b"/postgres")
            except OSError:
                pass
        return n
    out = subprocess.run(["ps", "-A", "-o", "comm="], capture_output=True, text=True).stdout
    return sum(1 for l in out.splitlines() if l.strip().rsplit("/", 1)[-1] == "postgres")


class Room(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append(self.headers.get("Authorization") or "")
        body = open(PAGE, "rb").read() if self.path == "/room/server" else b"ok\n"
        self.send_response(200 if self.path in ("/room/server", "/asset.txt") else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8" if self.path == "/room/server" else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def secret_file(name):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(secrets.token_hex(32))
    return path


def main():
    r = subprocess.run([VISIT, "--version"], capture_output=True, text=True, env=ENV)
    print("      " + r.stdout.strip())
    check("visit --version: Postgres and Chrome inside it", (r.returncode, "Postgres" in r.stdout, "Chrome" in r.stdout), (0, True, True))

    t = time.time()
    r = subprocess.run([VISIT, "auth", "user", "add", "tester", "--password-stdin"], input=PASSWORD + "\n", capture_output=True, text=True, env=ENV, timeout=300)
    check("visit auth user add, the first command: Postgres unpacked, the database made, the account (%.1f s)" % (time.time() - t),
          (r.returncode, r.stdout.strip()), (0, "tester can sign in now"))
    if r.returncode:
        print(r.stderr)

    room = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Room)
    threading.Thread(target=room.serve_forever, daemon=True).start()
    vtoken, atoken = secret_file("visit-token"), secret_file("auth-token")
    if not WINDOWS:
        os.chmod(atoken, 0o600)
    flags = ["--lobby", "ws://127.0.0.1:9/", "--name", "Fresh Start", "--port", "17401", "--token-file", vtoken,
             "--auth-token-file", atoken, "--auth-port", "17403",
             "--engine-room-url", "http://127.0.0.1:%d/room/server" % room.server_address[1], "--engine-port", "17405"]
    log = open(os.path.join(TMP, "visit.log"), "w")
    t = time.time()
    p = subprocess.Popen([VISIT, *flags], stdout=subprocess.PIPE, stderr=log, env=ENV, text=True,
                         creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if WINDOWS else 0)
    try:
        ready = json.loads(p.stdout.readline() or "{}")
        check("visit runs, and says it is ready (%.1f s: Chrome unpacked the first time)" % (time.time() - t), ready.get("ready"), True)
        hosting = None
        for _ in range(450):
            hosting = call(17405, "/health")[1].get("room")
            if hosting == "hosting":
                break
            time.sleep(0.2)
        check("the engine hosts the room's page, in the Chrome inside visit (%.1f s)" % (time.time() - t), hosting, "hosting")
        token = open(atoken).read().strip()
        code, body = call(17403, "/v1/login", {"user": "tester", "password": PASSWORD, "client": {"address": "127.0.0.1", "agent": "fresh"}}, token)
        check("a sign-in through the API visit serves", (code, body.get("user")), (200, "tester"))
        key = next((a[7:] for a in seen if a.startswith("Bearer ")), "")
        check("the engine's key on the room's requests: one the API takes, labelled engine", call(17403, "/v1/check", {"key": key}, token), (200, {"key": "engine"}))
    finally:
        if WINDOWS:
            p.kill()   # a launcher's kill on Windows: no word to the process (its Postgres is stopped by whoever comes next)
        else:
            p.terminate()
        p.wait(60)
        room.shutdown()
    if not WINDOWS:
        check("stopped: Postgres with it", postgres_running(), 0)
    r = subprocess.run([VISIT, "auth", "user", "list"], capture_output=True, text=True, env=ENV, timeout=120)
    check("the account still there afterwards (Postgres started for the command, and stopped)", (r.returncode, "tester" in r.stdout), (0, True))
    check("nothing of visit's left running", postgres_running(), 0)
    if failures:
        print("--- visit's log")
        print(open(os.path.join(TMP, "visit.log")).read()[-4000:])
    print("\n%d failure(s)" % len(failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
