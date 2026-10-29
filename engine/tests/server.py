#!/usr/bin/env python3
"""The test's workroom's server (run by run-engine.sh, in a container on the test's network): on 3001 the room's
server page and its files, to a request carrying the engine's key (`Authorization: Bearer test-key`) and to
nothing else (401); on 3002 another origin, which says at /seen whether any Authorization ever reached it."""
import http.server
import json
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = "Bearer test-key"
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
        if self.headers.get("Authorization") != KEY:
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
    servers = [http.server.ThreadingHTTPServer(("0.0.0.0", 3001), Room), http.server.ThreadingHTTPServer(("0.0.0.0", 3002), Other)]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("test server: the room on 3001 (to the key), another origin on 3002", flush=True)
    servers[0].serve_forever()
