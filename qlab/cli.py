"""qlab command line.

  python -m qlab.cli analyze <repo> [--out DIR] [--kinds prod,test]
      -> results.json (scores, CIs, verdicts, SIG profiles), qlab.sarif, heat.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .analyze import analyze
from .report import heat_data, to_sarif
from .score import score


def main(argv=None):
    ap = argparse.ArgumentParser(prog="qlab")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("repo")
    a.add_argument("--out", default="out/qlab")
    a.add_argument("--kinds", default="prod")
    a.add_argument("--bootstrap", type=int, default=1000)
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    A = analyze(args.repo, kinds=tuple(args.kinds.split(",")))
    S = score(A, B=args.bootstrap)
    (out / "results.json").write_text(json.dumps(dict(scores=S, repo_metrics=A.repo_metrics, timings=A.timings),
                                                 indent=1, default=str))
    (out / "qlab.sarif").write_text(json.dumps(to_sarif(A)))
    (out / "heat.json").write_text(json.dumps(heat_data(A, S), separators=(",", ":")))
    for pid, p in S["practices"].items():
        ci = p["ci"]
        if ci:
            print(f"{p['name']:40s} {p['score']:6.1f}  [{100 * ci['lo']:.1f}, {100 * ci['hi']:.1f}]  {p['verdict']}")
    print(f"findings: {len(A.findings)}  ->  {out}/")


if __name__ == "__main__":
    main()
