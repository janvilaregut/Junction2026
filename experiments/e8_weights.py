"""E8 — Aggregation analysis of Q = 0.30S + 0.25F + 0.20P + 0.15M + 0.10C.

On the 26 benchmark repos (static dimensions S, F, M, C; P is unavailable for
the benchmark, so weights are renormalised over the available dimensions):
 (1) stated vs effective weights (share of the variance of Q each dimension explains),
 (2) ranking stability under weight perturbations (uniform simplex, order-preserving,
     concentrated Dirichlet around the stated weights): Kendall tau to the baseline,
     mean absolute rank shift,
 (3) arithmetic vs geometric aggregation agreement,
 (4) compensation counterexamples (a dimension < 50 hidden by Q >= 80),
 (5) closed-form: S needed for Q >= 95 if everything else is perfect."""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
recs = {p.stem: json.loads(p.read_text()) for p in (LAB / "out" / "bench").glob("*.json")}
names = sorted(recs)
DIMS = ["security", "reliability", "maintainability", "consistency"]
W = np.array([0.30, 0.25, 0.15, 0.10]); W = W / W.sum()
X = np.array([[recs[n]["dimensions"][d] for d in DIMS] for n in names], dtype=float)
rng = np.random.default_rng(42)


def ranks(q):
    return stats.rankdata(-q, method="average")


q0 = X @ W
r0 = ranks(q0)
res = {"repos": names, "dims": DIMS, "weights_renormalised": W.tolist(), "dimension_std": X.std(0).tolist(),
       "dimension_mean": X.mean(0).tolist()}
# (1) effective weights: contribution of each term to Var(Q)
C = np.cov((X * W).T)
contrib = np.array([C[i].sum() for i in range(len(DIMS))]) / C.sum()
res["effective_weight_share_of_variance"] = dict(zip(DIMS, contrib.tolist()))
res["stated_weight"] = dict(zip(DIMS, W.tolist()))
# (2) stability
def sample(kind, n=20000):
    if kind == "uniform":
        return rng.dirichlet(np.ones(len(DIMS)), n)
    if kind == "ordered":
        w = rng.dirichlet(np.ones(len(DIMS)), n)
        return -np.sort(-w, axis=1)
    if kind == "concentrated":
        return rng.dirichlet(50 * W, n)
for kind in ("uniform", "ordered", "concentrated"):
    ws = sample(kind)
    taus, shifts, top5 = [], [], np.zeros(len(names))
    for w in ws[:5000]:
        r = ranks(X @ w)
        taus.append(stats.kendalltau(r0, r).statistic)
        shifts.append(np.abs(r - r0).mean())
        top5 += (r <= 5)
    res[f"stability_{kind}"] = dict(kendall_tau_median=float(np.median(taus)), kendall_tau_p05=float(np.percentile(taus, 5)),
                                    mean_rank_shift=float(np.mean(shifts)),
                                    top5_probability={n: float(v / 5000) for n, v in zip(names, top5) if v > 0})
# (3) arithmetic vs geometric
qg = np.exp(np.log(np.maximum(X, 1.0)) @ W)
res["arith_vs_geom_kendall"] = float(stats.kendalltau(q0, qg).statistic)
# (4) compensation
hidden = [(n, dict(zip(DIMS, X[i].round(1).tolist())), round(float(q0[i]), 1)) for i, n in enumerate(names)
          if X[i].min() < 50 and q0[i] >= 80]
res["compensation_cases"] = hidden
# (5) closed form on the teammate's original 5 weights
w5 = dict(S=0.30, F=0.25, P=0.20, M=0.15, C=0.10)
res["closed_form"] = dict(
    S_needed_for_Q95_if_rest_perfect=100 - 5 / 0.30,
    Q_if_S_zero_rest_perfect=100 * (1 - 0.30),
    exchange_rate_S_to_C=0.30 / 0.10,
    note="weighted arithmetic mean is fully compensatory: 1 point of S always buys 3 points of C")
# synthetic proof that the gate must be separate: one critical vulnerability costs at most w_S * penalty
for pen in (25, 50, 100):
    res["closed_form"][f"Q_with_one_critical_if_penalty_{pen}"] = 100 - 0.30 * pen
(LAB / "out" / "experiments" / "e8_weights.json").write_text(json.dumps(res, indent=1))
print(json.dumps({k: v for k, v in res.items() if k not in ("repos",)}, indent=1)[:3500])
