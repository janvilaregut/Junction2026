"""Scores, confidence intervals and three-state certification.

Practice compliance  C_p = 1 - sum_e w_e v_e / sum_e w_e   (LOC-weighted, SIG-style)
Uncertainty: cluster bootstrap over files (entities in one file are not independent).
Verdict for threshold tau:  CERTIFIED if CI_low >= tau, NOT CERTIFIED if CI_high < tau,
INCONCLUSIVE otherwise, INCOMPLETE if the measurement could not be taken.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from .practices import PRACTICES, DIMENSIONS, TEAM_WEIGHTS, SIG_4STAR


def practice_arrays(A, practice):
    """Per-file sums (Σ w v, Σ w) for one practice."""
    num, den = defaultdict(float), defaultdict(float)
    for e in A.entities:
        if e.practice == practice:
            num[e.file] += e.weight * e.v
            den[e.file] += e.weight
    files = sorted(den)
    return files, np.array([num[f] for f in files]), np.array([den[f] for f in files])


def compliance(A, practice, B=1000, seed=7):
    files, num, den = practice_arrays(A, practice)
    if den.sum() == 0:
        return None
    point = 1 - num.sum() / den.sum()
    rng = np.random.default_rng(seed)
    n = len(files)
    if n >= 2:
        idx = rng.integers(0, n, size=(B, n))
        boots = 1 - num[idx].sum(1) / np.maximum(den[idx].sum(1), 1e-12)
        lo, hi = np.percentile(boots, [2.5, 97.5])
    else:
        lo = hi = point
    return dict(point=float(point), lo=float(lo), hi=float(hi), files=n, weight=float(den.sum()),
                violation_mass=float(num.sum()))


def verdict(ci, tau):
    if ci is None:
        return "INCOMPLETE"
    if ci["lo"] >= tau:
        return "CERTIFIED"
    if ci["hi"] < tau:
        return "NOT CERTIFIED"
    return "INCONCLUSIVE"


def sig_profile(A, practice):
    """Share of LOC in units above each SIG band, compared with the 4-star caps."""
    spec = SIG_4STAR.get(practice)
    if spec is None:
        return None
    total = 0
    above = [0, 0, 0]
    for ev in A.unit_evidence.values():
        if "sloc" not in ev:
            continue
        x = {"small_units": ev["sloc"], "simple_units": ev["cc"], "small_interfaces": ev["params"]}[practice]
        w = max(1, ev["sloc"])
        total += w
        for i, b in enumerate(spec["bands"]):
            if x > b:
                above[i] += w
    shares = [a / total if total else 0 for a in above]
    return dict(bands=spec["bands"], shares=shares, caps=spec["caps"],
                passes_4star=all(s <= c for s, c in zip(shares, spec["caps"])))


def exp_score(per_kloc, half=0.5):
    """Map a weighted findings density to (0,100]: 100 at 0, 50 at `half` per KLOC."""
    return 100 * math.exp(-math.log(2) * per_kloc / half)


def score(A, thresholds=None, tests=None, B=1000):
    thresholds = thresholds or {}
    out = {"practices": {}, "dimensions": {}, "sig": {}}
    for pid, p in PRACTICES.items():
        ci = compliance(A, pid, B=B)
        tau = thresholds.get(pid, 0.9)
        out["practices"][pid] = dict(name=p.name, dimension=p.dimension, ci=ci, tau=tau, verdict=verdict(ci, tau),
                                     score=None if ci is None else round(100 * ci["point"], 1))
    for pid in ("small_units", "simple_units", "small_interfaces"):
        out["sig"][pid] = sig_profile(A, pid)
    out["sig"]["duplication_type1"] = dict(density=A.repo_metrics["dry"]["type1_density"],
                                           cap=SIG_4STAR["duplication_cap"],
                                           passes_4star=A.repo_metrics["dry"]["type1_density"] <= SIG_4STAR["duplication_cap"])
    # dimensions (geometric mean of practice scores keeps a single bad practice visible)
    sec = A.repo_metrics.get("security", {})
    rel = A.repo_metrics.get("reliability", {})
    dim = {}
    sec_score = exp_score(sec.get("per_kloc", 0.0)) if sec else None
    dim["security"] = sec_score
    eh = out["practices"]["error_handling"]["score"]
    rel_rules = exp_score(rel.get("per_kloc", 0.0)) if rel else None
    dim["reliability"] = _gmean([x for x in (eh, rel_rules) if x is not None])
    dim["tests"] = tests if tests is not None else None
    for d in ("maintainability", "consistency"):
        vals = [out["practices"][p]["score"] for p in DIMENSIONS[d] if out["practices"].get(p, {}).get("score") is not None]
        dim[d] = _gmean(vals)
    out["dimensions"] = {k: (None if v is None else round(v, 1)) for k, v in dim.items()}
    out["Q_team"] = team_q(out["dimensions"])
    return out


def _gmean(vals):
    vals = [max(v, 1e-6) for v in vals if v is not None]
    if not vals:
        return None
    return float(math.exp(sum(math.log(v) for v in vals) / len(vals)))


def team_q(dims, weights=TEAM_WEIGHTS):
    """Teammate's Q; returns None (=> INCOMPLETE) when any dimension is missing."""
    if any(dims.get(k) is None for k in weights):
        return dict(value=None, state="INCOMPLETE", missing=[k for k in weights if dims.get(k) is None])
    return dict(value=round(sum(w * dims[k] for k, w in weights.items()), 2), state="COMPLETE", missing=[])
