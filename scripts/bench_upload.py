"""Benchmark POST /upload-image insert latency with realistic-sized base64 images.

Generates ~30KB of base64 payload (approx a 20KB JPEG snapshot) and POSTs it
50 times, reporting client-observed latency and the server-reported DB insert
latency (insert_ms).
"""

from __future__ import annotations

import base64
import os
import statistics
import time
import urllib.request
import json

URL = "http://127.0.0.1:8000/upload-image"
N = 50
RAW_BYTES = 22 * 1024  # ~22KB raw → ~30KB base64


def bench() -> None:
    raw = os.urandom(RAW_BYTES)
    img_b64 = base64.b64encode(raw).decode()
    print(f"payload: {len(img_b64)} base64 chars ({len(raw)} raw bytes)")

    client_ms: list[float] = []
    server_ms: list[float] = []

    for i in range(N):
        body = json.dumps(
            {"session_id": f"bench-{i:03d}", "image": img_b64}
        ).encode()
        req = urllib.request.Request(
            URL, data=body, headers={"Content-Type": "application/json"}
        )
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        client_ms.append((time.perf_counter() - t0) * 1000.0)
        server_ms.append(float(data["insert_ms"]))

    def stats(name: str, xs: list[float]) -> None:
        xs_sorted = sorted(xs)
        p50 = xs_sorted[len(xs) // 2]
        p95 = xs_sorted[int(len(xs) * 0.95)]
        print(
            f"{name:10s}  avg={statistics.mean(xs):7.2f}ms  "
            f"p50={p50:7.2f}ms  p95={p95:7.2f}ms  "
            f"min={min(xs):7.2f}ms  max={max(xs):7.2f}ms"
        )

    print(f"\n{N} requests")
    stats("client", client_ms)
    stats("db", server_ms)


if __name__ == "__main__":
    bench()
