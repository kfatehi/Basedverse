#!/usr/bin/env python3
"""The perf run's table: each scenario's visitors together, against targets from cloud gaming.

    report.py OUT_DIR

Targets (input to frame, which is everything but a browser's own encode, decode and paint):
- p95 within the link's round trip plus 40 ms (a frame's slot at 60 a second, and some jitter);
- frames a second at least 50 (where the link carries them: not under a rate cap below the bitrate);
- no stall: no 100 ms without a frame.
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


def main(out):
    rows = []
    for name in sorted(os.listdir(out), key=lambda n: os.path.getmtime(os.path.join(out, n))):
        d = os.path.join(out, name)
        if not os.path.isdir(d) or not os.path.exists(os.path.join(d, "scenario")):
            continue
        visitors, hostnet, visnet = (open(os.path.join(d, "scenario")).read().split("\n") + ["", "", ""])[:3]
        results = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json")]
        if not results:
            rows.append((name, visitors, "no results", "", "", "", "", "", "", "", "✗"))
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
        capped = "rate" in hostnet
        ok = p95 is not None and rtt is not None and p95 <= rtt + 40 and stalls == 0 and (capped or fps >= 50)
        f = lambda x: "—" if x is None else "%.0f" % x
        rows.append((name, visitors, "/".join(paths) or "?", f(rtt), "%s / %s / %s" % (f(p50), f(p95), f(p99)), "%.0f" % fps,
                     str(stalls), f(worst), "%.1f" % keys, "%.2f" % mbps, "✓" if ok else "✗"))
    head = ("scenario", "visitors", "path", "link rtt ms", "input→frame p50 / p95 / p99 ms", "fps", "stalls", "worst gap ms",
            "keyframes", "Mbit/s", "target")
    print("| " + " | ".join(head) + " |")
    print("|" + "|".join("---" for _ in head) + "|")
    for r in rows:
        print("| " + " | ".join(r) + " |")
    print("\nTarget: input→frame p95 ≤ link rtt + 40 ms, no 100 ms without a frame, and ≥ 50 fps where the link is not capped.")


if __name__ == "__main__":
    main(sys.argv[1])
