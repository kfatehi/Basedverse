#!/usr/bin/env python3
"""One office of a perf run, in its own container: the network it is given (tc netem on its way out), a real
visit-client, and a fake page speaking basedverse-visit-local/2 (../../../SPEC.md section 5) in place of a
browser's.

- host: hosts a scene, lets every knock in, and for each visitor sends deltas as visit.js does (SPEC 8.3):
  every 33 ms (and the moment its input arrives, when one is due), each with where the host has the visitor and
  the visitor's latest input time, and MOVERS moving objects' places; a key delta every second and when asked;
- visitor: knocks on the host, then sends input as a moving mouse would (every 8 ms, with its time), and times
  every delta: now minus the input time it carries is input to the host's answer (the network both ways and the
  host's beat: what corrects where a visitor's page has walked it; its own view moves at once regardless).

    node.py host|visitor NAME --lobby URL [--host NAME] [--seconds 20] [--net "delay 4ms 1ms loss 1% rate 20mbit"]

Writes /out/NAME.json.
"""
import argparse
import asyncio
import gzip
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import time

from websockets.asyncio.client import connect

PROTO = "basedverse-visit-local/2"
KEY = 1
WARMUP = 4.0   # seconds of a visit not measured: the link settling
SCENE_MS = 1000 / 30
MOVERS = 50    # moving objects in the host's scene: each delta carries their places (33 bytes each)


def now_ms():
    return time.monotonic() * 1000.0


def shape(net):
    """This container's way out, as the scenario says (tc netem on eth0): half a round trip's delay, its jitter,
    loss, a rate cap."""
    if net:   # a buffer the scenario does not size is a deep one (netem's default, 1000 packets, is shallow for a LAN)
        subprocess.run(["tc", "qdisc", "add", "dev", "eth0", "root", "netem"] + net.split() + ([] if "limit" in net else ["limit", "10000"]), check=True)


async def start_client(name, lobby, port):
    token = secrets.token_hex(32)
    path = "/tmp/%s.token" % name
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(token)
    log = open("/out/%s.log" % name, "w")
    p = await asyncio.create_subprocess_exec("/bin/visit-client", "--lobby", lobby, "--name", name, "--sim", "perf/1", "--port", str(port),
                                             "--token-file", path, "--relays", "none", "--max-visitors", "8",
                                             stdout=asyncio.subprocess.PIPE, stderr=log, env=dict(os.environ, RUST_LOG="visit=info,iroh=warn"))
    json.loads(await asyncio.wait_for(p.stdout.readline(), 15))
    return p, token


class Page:
    def __init__(self, port, token):
        self.port, self.token = port, token

    async def open(self):
        self.ws = await connect("ws://127.0.0.1:%d/ws" % self.port, max_size=4 << 20, origin="http://perf.test")
        # as a browser does: Nagle's algorithm off, so a small message goes at once
        self.ws.transport.get_extra_info("socket").setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        await self.send(type="hello", proto=PROTO, token=self.token, sim={"name": "perf", "version": "1"})
        await self.send(type="host", three="128")   # every office hosts its scene, or it is not in the lobby
        return self

    async def send(self, **m):
        await self.ws.send(json.dumps(m))


def delta(channel, key, now, v, movers):
    """A delta as visit.js sends it (SPEC 5.4, 8.3): header, where the host has the visitor, then objects."""
    head = struct.pack(">HBQ", channel, KEY if key else 0, int(now * 1000))
    pose = struct.pack(">BdffffffI", 1, v["t"], now - v["at"] if v["at"] else 0.0, v["x"], 1.6, v["z"], v["yaw"], 0.0, movers)
    body = b"".join(struct.pack(">IBfffffff", i + 2, 1, i * 0.1, 1.0, now % 7, 0.0, 0.0, 0.0, 1.0) for i in range(movers))
    return head + pose + body


# ---------- the host ----------
async def host(args, page):
    visits = {}   # channel -> {t, at, x, z, yaw, next_at, last_key, key_next, sent}

    async def emit(ch, v, now):
        key = v["key_next"] or now - v["last_key"] >= 1000
        await page.ws.send(delta(ch, key, now, v, MOVERS))
        if key:
            v["key_next"], v["last_key"] = False, now
        v["next_at"] = now + SCENE_MS if v["next_at"] + SCENE_MS < now else v["next_at"] + SCENE_MS
        v["sent"] += 1

    async def ticker():
        while True:
            await asyncio.sleep(1 / 240)
            now = now_ms()
            for ch, v in list(visits.items()):
                if now >= v["next_at"] - 2:
                    await emit(ch, v, now)

    tick = asyncio.create_task(ticker())
    try:
        async for raw in page.ws:
            if isinstance(raw, bytes):
                continue
            m = json.loads(raw)
            t = m["type"]
            if t == "knock":
                await page.send(type="answer", knock=m["id"], accept=True)
            elif t == "visit_started" and m["role"] == "host":
                visits[m["channel"]] = {"t": 0.0, "at": 0.0, "x": 2.0, "z": 6.0, "yaw": 0.0, "next_at": 0.0, "last_key": 0.0, "key_next": True, "sent": 0}
                whole = {"type": "scene", "three": "128", "json": {"metadata": {"version": 4.5, "type": "Object"}, "object": {"type": "Scene", "uuid": "s"}}, "ids": [["s", 1]]}
                await page.ws.send(struct.pack(">HBQ", m["channel"], 2, 0) + gzip.compress(json.dumps(whole).encode()))
            elif t == "visit_ended":
                visits.pop(m.get("channel"), None)
            elif t == "input" and m["channel"] in visits:
                v = visits[m["channel"]]
                now = now_ms()
                v["t"], v["at"], v["yaw"] = m.get("t", 0.0), now, m.get("yaw", 0.0)
                v["z"] -= 0.004 * m.get("forward", 0)   # as move() would walk it
                if now >= v["next_at"] - 2:   # as visit.js: moved the moment the input arrives, in the next delta when one is due
                    await emit(m["channel"], v, now)
            elif t == "keyframe" and m["channel"] in visits:
                visits[m["channel"]]["key_next"] = True
    finally:
        tick.cancel()


# ---------- a visitor ----------
async def visitor(args, page):
    lat, arrivals, sizes, keys, stats = [], [], [], 0, []
    state = {"visiting": None, "t0": None, "knocked": False, "yaw": 0.0}

    async def inputs():
        while True:
            await asyncio.sleep(0.008)
            if state["visiting"] is not None:
                state["yaw"] += 0.004   # a mouse turning, steadily: every input new
                await page.send(type="input", forward=1, strafe=0, run=False, yaw=state["yaw"], pitch=0.0, t=now_ms())

    loop = asyncio.create_task(inputs())
    deadline = None
    try:
        while True:
            timeout = None if deadline is None else max(0.0, deadline - time.monotonic())
            try:
                raw = await asyncio.wait_for(page.ws.recv(), timeout)
            except asyncio.TimeoutError:
                break
            if isinstance(raw, bytes):
                if state["t0"] is None or time.monotonic() < state["t0"] + WARMUP:
                    continue
                now = now_ms()
                arrivals.append(now)
                sizes.append(len(raw))
                keys += raw[2] & KEY
                if len(raw) >= 20:
                    t = struct.unpack(">d", raw[12:20])[0]
                    if t > 0:
                        lat.append(now - t)
                continue
            m = json.loads(raw)
            t = m["type"]
            if t == "lobby" and not state["knocked"]:
                door = next((o for o in m["offices"] if o["name"] == args.host and o["ready"]), None)
                if door:
                    state["knocked"] = True
                    await page.send(type="knock", to=door["id"])
            elif t == "visit_started" and m["role"] == "visitor":
                state["visiting"], state["t0"] = m["channel"], time.monotonic()
                deadline = state["t0"] + WARMUP + args.seconds
            elif t == "link_stats":
                if state["t0"] and time.monotonic() >= state["t0"] + WARMUP:
                    stats.append({"path": m["path"], "rtt_ms": m["rtt_ms"]})
            elif t == "answered" and not m.get("accept"):
                print("%s: refused: %s" % (args.name, m), file=sys.stderr)
    finally:
        loop.cancel()
    secs = (arrivals[-1] - arrivals[0]) / 1000 if len(arrivals) > 1 else 0
    gaps = [b - a for a, b in zip(arrivals, arrivals[1:])]
    return {"name": args.name, "latency_ms": lat, "frames": len(arrivals), "seconds": secs, "keyframes": keys, "bytes": sum(sizes),
            "gaps_over_100ms": sum(1 for g in gaps if g > 100), "worst_gap_ms": max(gaps) if gaps else None, "link": stats}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("role", choices=["host", "visitor"])
    ap.add_argument("name")
    ap.add_argument("--lobby", required=True)
    ap.add_argument("--host", default="Host")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--net", default="")
    args = ap.parse_args()
    shape(args.net)
    proc, token = await start_client(args.name, args.lobby, 7401)
    page = await Page(7401, token).open()
    result = None
    try:
        if args.role == "host":
            await host(args, page)
        else:
            result = await visitor(args, page)
    finally:
        if result is not None:
            json.dump(result, open("/out/%s.json" % args.name, "w"))
        proc.terminate()
        await proc.wait()


if __name__ == "__main__":
    asyncio.run(main())
