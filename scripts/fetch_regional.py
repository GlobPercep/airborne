#!/usr/bin/env python3
"""Fallback data source: synthesize an OpenSky-format states.json from
airplanes.live regional queries when OpenSky itself is unavailable.
Covers the world's dense airspaces with 250 nm circles; oceanic gaps are
acceptable for a degraded mode."""
import json
import sys
import time
import urllib.request

REGIONS = [  # (lat, lon) centers of 250 nm circles over busy airspace
    (40.7, -74.0), (34.0, -81.0), (28.0, -82.5), (41.8, -87.9), (33.0, -97.0),
    (39.7, -105.0), (34.0, -118.2), (45.6, -122.6), (45.5, -73.6), (19.4, -99.1),
    (51.5, 0.0), (48.5, 8.0), (41.4, 2.9), (45.4, 11.9), (52.4, 13.9), (40.4, -3.7),
    (60.2, 24.9), (41.0, 28.9), (25.2, 55.3), (28.6, 77.2), (19.1, 72.9),
    (35.6, 139.7), (34.7, 135.5), (37.5, 126.9), (31.2, 121.5), (23.1, 113.3),
    (13.7, 100.5), (1.35, 103.99), (-6.1, 106.7), (14.5, 121.0),
    (-23.5, -46.6), (-34.6, -58.4), (4.7, -74.1), (-33.9, 151.2), (-37.7, 144.8),
    (30.1, 31.4), (-26.1, 28.2), (6.6, 3.3),
]

def fetch(lat, lon):
    url = f"https://api.airplanes.live/v2/point/{lat:.2f}/{lon:.2f}/250"
    req = urllib.request.Request(url, headers={"User-Agent": "airborne-tracker (github.com/GlobPercep/airborne)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def main(out_path):
    now = time.time()
    best = {}  # hex -> (fix_time, state_row)
    ok = 0
    for lat, lon in REGIONS:
        try:
            data = fetch(lat, lon)
            ok += 1
        except Exception as e:
            print(f"region ({lat},{lon}) failed: {e}", file=sys.stderr)
            continue
        for a in data.get("ac", []):
            hexid = a.get("hex")
            a_lat, a_lon = a.get("lat"), a.get("lon")
            if not hexid or a_lat is None or a_lon is None:
                continue
            alt = a.get("alt_baro")
            on_ground = alt == "ground"
            alt_m = (alt if isinstance(alt, (int, float)) else a.get("alt_geom") or 0) * 0.3048
            fix = now - (a.get("seen_pos") or 0)
            prev = best.get(hexid)
            if prev and prev[0] >= fix:
                continue
            best[hexid] = (fix, [
                hexid, (a.get("flight") or "").strip().ljust(8), "", int(fix), int(fix),
                a_lon, a_lat, None if on_ground else alt_m, on_ground,
                (a.get("gs") or 0) * 0.514444, a.get("track") or 0,
                (a.get("baro_rate") or 0) * 0.00508, None,
                (a.get("alt_geom") or 0) * 0.3048, a.get("squawk"), False, 0, 0,
            ])
        time.sleep(1.2)   # stay well under the 1 req/s guideline
    if ok < 5 or len(best) < 500:
        print(f"insufficient data: {ok} regions, {len(best)} aircraft", file=sys.stderr)
        sys.exit(1)
    states = [row for _, row in best.values()]
    with open(out_path, "w") as f:
        json.dump({"time": int(now), "states": states, "source": "airplanes.live-regional"}, f)
    print(f"wrote {len(states)} aircraft from {ok}/{len(REGIONS)} regions")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/states.json")
