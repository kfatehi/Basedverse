#!/usr/bin/env python3
"""The perf run's table: each scenario's visitors together, against targets.

    report.py OUT_DIR

A visitor walks and looks at once, drawn by its own browser (SPEC 8.3); what the network shapes is the host's
answer: where the host has it (correcting its own idea, as it walks into walls) and where the room's moving
things are. Targets:
- input to the host's answer, p95 within the link's round trip plus 40 ms (one of the host's updates, every
  33 ms, and some jitter);
- updates at least 25 a second (one every 33 ms; with browsers, frames drawn, at least 30 a second: the
  browsers here draw on the processor, not a GPU, which on a real machine keeps to the screen's rate);
- no stall: no 100 ms without an update (or a frame drawn);
- with browsers, input to screen (drawn here) p95 under 50 ms.
"""
import json
import os
import statistics
import sys


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def host_row(name, h):
    secs = h["seconds"][3:] or h["seconds"]   # past the first seconds' settling
    ticks = [t for sec in secs for t in sec["ticks"]]
    return (name, str(max((s["visitors"] for s in secs), default=0)), "%.2f / %.2f" % (pct(ticks, 50) or 0, pct(ticks, 95) or 0),
            "%.1f" % (len(ticks) / max(1, len(secs))), str(len(h.get("errors") or [])))


def main(out):
    rows, hosted = [], []
    for name in sorted(os.listdir(out), key=lambda n: os.path.getmtime(os.path.join(out, n))):
        d = os.path.join(out, name)
        if not os.path.isdir(d) or not os.path.exists(os.path.join(d, "scenario")):
            continue
        visitors, hostnet, visnet = (open(os.path.join(d, "scenario")).read().split("\n") + ["", "", ""])[:3]
        everything = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json") and not f.endswith(".errors.json")]
        results = [r for r in everything if r.get("role") != "host"]
        hosts = [r for r in everything if r.get("role") == "host"]
        if hosts:
            hosted.append((name, hosts[0]))
        if not results:
            rows.append((name, visitors, "no results", "", "", "", "", "", "", "", "", "✗"))
            continue
        lat = [x for r in results for x in r["latency_ms"]]
        rtts = [s["rtt_ms"] for r in results for s in r["link"]]
        paths = sorted({s["path"] for r in results for s in r["link"]})
        rtt = statistics.median(rtts) if rtts else None
        fps = statistics.mean(r["frames"] / r["seconds"] for r in results if r["seconds"]) if any(r["seconds"] for r in results) else 0
        mbps = statistics.mean(r["bytes"] * 8 / r["seconds"] / 1e6 for r in results if r["seconds"]) if any(r["seconds"] for r in results) else 0
        stalls = sum(r["gaps_over_100ms"] for r in results)
        worst = max((r["worst_gap_ms"] or 0) for r in results)
        keys = sum(r["keyframes"] for r in results) / len(results)
        p50, p95, p99 = pct(lat, 50), pct(lat, 95), pct(lat, 99)
        browsers = any(r.get("browser") for r in results)
        here = [x for r in results for x in r.get("here_ms", [])]
        ok = p95 is not None and rtt is not None and p95 <= rtt + 40 and stalls == 0 and fps >= (30 if browsers else 25) \
            and (not browsers or (pct(here, 95) is not None and pct(here, 95) < 50))
        f = lambda x: "—" if x is None else "%.0f" % x
        rows.append((name, visitors, "/".join(paths) or "?", f(rtt), "%s / %s / %s" % (f(p50), f(p95), f(p99)),
                     "%s / %s" % (f(pct(here, 50)), f(pct(here, 95))) if browsers else "—", "%.0f" % fps,
                     str(stalls), f(worst), "%.1f" % keys, "%.2f" % mbps, "✓" if ok else "✗"))
    head = ("scenario", "visitors", "path", "link rtt ms", "input→host's answer p50 / p95 / p99 ms", "input→screen (here) p50 / p95 ms",
            "updates (or frames drawn) a second", "stalls", "worst gap ms", "key deltas", "Mbit/s", "target")
    print("| " + " | ".join(head) + " |")
    print("|" + "|".join("---" for _ in head) + "|")
    for r in rows:
        print("| " + " | ".join(r) + " |")
    print("\nTarget: the host's answer p95 ≤ link rtt + 40 ms, ≥ 25 updates a second (with browsers ≥ 30 frames drawn, on the processor here, and input to screen p95 < 50 ms), no 100 ms without one.")
    if hosted:
        print("")
        head = ("scenario", "visitors", "host's time per scene update p50 / p95 ms", "updates a second", "page errors")
        print("| " + " | ".join(head) + " |")
        print("|" + "|".join("---" for _ in head) + "|")
        for name, h in hosted:
            print("| " + " | ".join(host_row(name, h)) + " |")


if __name__ == "__main__":
    main(sys.argv[1])
