"""E0 — Benchmark calibration: run qlab on a corpus of well-regarded C# repos
and store per-repo practice compliance, SIG risk profiles and repo metrics."""
import json
import sys
import time
import traceback
from multiprocessing import Pool
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))


def run(repo_dir: str):
    from qlab.analyze import analyze
    from qlab.score import score
    name = Path(repo_dir).name
    out = LAB / "out" / "bench" / f"{name}.json"
    if out.exists():
        return name, "cached"
    try:
        t = time.time()
        A = analyze(repo_dir)
        S = score(A, B=300)
        rec = dict(repo=name, code_lines=A.repo_metrics["code_lines"], files=A.repo_metrics["files"],
                   units=A.repo_metrics["units"], parse_error_fraction=A.repo_metrics["parse_error_fraction"],
                   practices={k: v["ci"] for k, v in S["practices"].items()}, sig=S["sig"],
                   dimensions=S["dimensions"], dry=A.repo_metrics["dry"],
                   design={k: v for k, v in A.repo_metrics["design"].items() if k not in ("martin", "namespace_cycle_members")},
                   consistency=A.repo_metrics["consistency"], security=dict(per_kloc=A.repo_metrics["security"]["per_kloc"]),
                   reliability=A.repo_metrics["reliability"], timings=A.timings, seconds=time.time() - t,
                   rules={})
        from collections import Counter
        rec["rules"] = dict(Counter(f.rule for f in A.findings))
        out.write_text(json.dumps(rec, default=str, indent=1))
        return name, f"ok {rec['code_lines']} lines {rec['seconds']:.0f}s"
    except Exception as e:  # record, never hide
        (LAB / "out" / "bench" / f"{name}.error.txt").write_text(traceback.format_exc())
        return name, f"ERROR {e}"


if __name__ == "__main__":
    dirs = [str(p) for p in sorted((LAB / "corpus" / "bench").iterdir()) if p.is_dir()]
    dirs.append(str(LAB / "corpus" / "messagepack-csharp"))
    with Pool(int(sys.argv[1]) if len(sys.argv) > 1 else 10) as pool:
        for name, status in pool.imap_unordered(run, dirs):
            print(name, status, flush=True)
