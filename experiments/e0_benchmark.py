"""E0 — Benchmark distributions, calibrated thresholds and MessagePack's position."""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))
from qlab.practices import PRACTICES, SIG_4STAR   # noqa: E402

recs = {p.stem: json.loads(p.read_text()) for p in (LAB / "out" / "bench").glob("*.json")}
target = recs.pop("messagepack-csharp")
names = sorted(recs)
out = {"n_repos": len(names), "repos": names, "practices": {}, "sig": {}, "repo_metrics": {}}
print(f"{'practice':18s} {'P10':>6s} {'P25':>6s} {'median':>6s} {'P75':>6s}   MsgPack  pct-rank")
for pid in PRACTICES:
    vals = np.array([recs[n]["practices"][pid]["point"] for n in names if recs[n]["practices"].get(pid)])
    t = target["practices"][pid]["point"]
    pr = stats.percentileofscore(vals, t, kind="mean")
    q = np.percentile(vals, [10, 25, 50, 75])
    out["practices"][pid] = dict(p10=q[0], p25=q[1], median=q[2], p75=q[3], min=vals.min(), max=vals.max(),
                                 target=t, target_ci=(target["practices"][pid]["lo"], target["practices"][pid]["hi"]),
                                 target_percentile=pr, tau_median=q[2], tau_p25=q[1])
    print(f"{pid:18s} {100*q[0]:6.1f} {100*q[1]:6.1f} {100*q[2]:6.1f} {100*q[3]:6.1f}   {100*t:6.1f}   {pr:5.1f}")
for key in ("small_units", "simple_units", "small_interfaces"):
    shares = np.array([recs[n]["sig"][key]["shares"] for n in names])
    passes = sum(recs[n]["sig"][key]["passes_4star"] for n in names)
    out["sig"][key] = dict(median_shares=np.median(shares, 0).tolist(), passes_4star=int(passes),
                           target_shares=target["sig"][key]["shares"], caps=SIG_4STAR[key]["caps"])
    print(key, "bench median shares", np.round(np.median(shares, 0), 3), f"pass4*={passes}/{len(names)}",
          "MsgPack", np.round(target["sig"][key]["shares"], 3))
dup = np.array([recs[n]["dry"]["type1_density"] for n in names])
dup2 = np.array([recs[n]["dry"]["type2_density"] for n in names])
out["sig"]["duplication"] = dict(median_t1=float(np.median(dup)), passes=int((dup <= 0.058).sum()),
                                 target_t1=target["dry"]["type1_density"], median_t2=float(np.median(dup2)),
                                 target_t2=target["dry"]["type2_density"])
print("dup T1 median", round(np.median(dup), 4), "pass(<=5.8%)", int((dup <= 0.058).sum()), "MsgPack", round(target['dry']['type1_density'], 4),
      "| T2 median", round(np.median(dup2), 4), "MsgPack", round(target['dry']['type2_density'], 4))
for k in ("propagation_cost", "namespace_cycles", "largest_namespace_cycle", "largest_type_cycle"):
    v = np.array([recs[n]["design"][k] for n in names], dtype=float)
    out["repo_metrics"][k] = dict(median=float(np.median(v)), p25=float(np.percentile(v, 25)), p75=float(np.percentile(v, 75)),
                                  target=target["design"][k], pct=float(stats.percentileofscore(v, target["design"][k], kind="mean")))
    print(k, "median", np.median(v), "MsgPack", target["design"][k])
pe = np.array([recs[n]["parse_error_fraction"] for n in names])
out["parse_error_fraction"] = dict(median=float(np.median(pe)), max=float(pe.max()), target=target["parse_error_fraction"])
print("parse error fraction median", np.median(pe), "max", pe.max(), max(names, key=lambda n: recs[n]['parse_error_fraction']))
lines = sum(recs[n]["code_lines"] for n in names)
out["total_code_lines"] = lines
print("bench code lines", lines)
(LAB / "out" / "experiments").mkdir(exist_ok=True, parents=True)
(LAB / "out" / "experiments" / "e0_benchmark.json").write_text(json.dumps(out, indent=1, default=float))
