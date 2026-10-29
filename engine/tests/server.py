#!/usr/bin/env python3
"""The test's workroom's server (run by run-engine.sh, beside visit): on 3001 the room's server page and its
files, to a request carrying a key the sign-in API says is good (POST /v1/check, as a workroom's server asks it:
the engine's, made by visit at its start) and to nothing else (401); on 3002 another origin, which says at /seen
whether any Authorization ever reached it. AUTH_PORT and AUTH_TOKEN_FILE: the sign-in API's."""
import http.server
import json
import os
import threading
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
AUTH = "http://127.0.0.1:%s/v1/check" % os.environ["AUTH_PORT"]
SERVICE = open(os.environ["AUTH_TOKEN_FILE"]).read().strip()


def key_ok(authorization):
    """Whether the sign-in API takes this Authorization's key: the engine's, labelled engine."""
    if not (authorization or "").startswith("Bearer "):
        return False
    req = urllib.request.Request(AUTH, data=json.dumps({"key": authorization[7:]}).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + SERVICE, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r).get("key") == "engine"
    except (urllib.error.URLError, OSError, ValueError):
        return False
seen = {"hits": 0, "authorization": 0}


class Base(http.server.BaseHTTPRequestHandler):
    def answer(self, status, body, kind="text/plain", cors=False):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s %s authorization=%s" % (self.server.server_address[1], fmt % args, "yes" if self.headers.get("Authorization") else "no"), flush=True)


class Room(Base):
    def do_GET(self):
        if not key_ok(self.headers.get("Authorization")):
            return self.answer(401, b"the room's code is for the engine's key\n")
        if self.path == "/room/server":
            with open(os.path.join(HERE, "page.html"), "rb") as f:
                return self.answer(200, f.read(), "text/html; charset=utf-8")
        if self.path == "/asset.txt":
            return self.answer(200, b"ok\n")
        self.answer(404, b"not here\n")


class Other(Base):
    def do_GET(self):
        if self.path == "/seen":
            return self.answer(200, json.dumps(seen).encode(), "application/json", cors=True)
        seen["hits"] += 1
        seen["authorization"] += bool(self.headers.get("Authorization"))
        self.answer(200, b"another origin\n", cors=True)


if __name__ == "__main__":
    servers = [http.server.ThreadingHTTPServer(("127.0.0.1", 3001), Room), http.server.ThreadingHTTPServer(("127.0.0.1", 3002), Other)]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("test server: the room on 3001 (to the key), another origin on 3002", flush=True)
    servers[0].serve_forever()
