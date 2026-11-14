#!/usr/bin/env python3
"""E4: repeat the tool catalog N times on the base tree (machine otherwise idle) and store
per-tool wall-clock repetitions in out/tools/_bench/bench.json.

    python3 experiments/tools/bench.py --reps 3
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
OUT = LAB / "out" / "tools" / "_bench"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--target", default=str(LAB / "corpus" / "tools" / "refs" / "base"))
    args = ap.parse_args()
    reps = {}
    for i in range(1, args.reps + 1):
        d = OUT / f"rep{i}"
        subprocess.run([sys.executable, str(Path(__file__).parent / "run_tools.py"), "--target", args.target,
                        "--out", str(d)], check=True)
        for t, r in json.loads((d / "runs.json").read_text()).items():
            reps.setdefault(t, []).append(r["wall_s"])
    (OUT / "bench.json").write_text(json.dumps(reps, indent=2) + "\n")
    print(json.dumps(reps))


if __name__ == "__main__":
    main()
