"""Three-state quality gate (Kleene logic) and score aggregation variants.

States are ordered FAIL < INCOMPLETE < PASS; the gate is the minimum over its
conditions. "Not applicable" conditions pass; "should have been measured but
was not" is INCOMPLETE; a confirmed blocking finding FAILS even when other
evidence is missing (witness rule). Sampled conditions (coverage, duplication of
new lines) are decided on Wilson confidence bounds.
"""
from __future__ import annotations

import math

FAIL, INCOMPLETE, PASS = 0, 1, 2
NAMES = {FAIL: "FAIL", INCOMPLETE: "INCOMPLETE", PASS: "PASS"}


def wilson(k, n, z=1.959964):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def cond_count_zero(count):
    """Blocking counter (e.g. new critical vulnerabilities, failing tests)."""
    if count is None:
        return INCOMPLETE
    return PASS if count == 0 else FAIL


def cond_proportion_at_least(k, n, tau, mode="statistical"):
    """Coverage-like condition: proportion k/n should be >= tau.
    naive: observed >= tau.  statistical: FAIL if upper95 < tau, PASS if observed >= tau
    (research/12 recommendation), INCOMPLETE otherwise. n == 0 -> not applicable."""
    if k is None or n is None:
        return INCOMPLETE
    if n == 0:
        return PASS
    p = k / n
    if mode == "naive":
        return PASS if p >= tau else FAIL
    lo, hi = wilson(k, n, z=1.644854)
    if hi < tau:
        return FAIL
    return PASS if p >= tau else INCOMPLETE


def cond_proportion_at_most(k, n, tau, mode="statistical"):
    """Duplication-like condition: proportion k/n should be <= tau."""
    if k is None or n is None:
        return INCOMPLETE
    if n == 0:
        return PASS
    p = k / n
    if mode == "naive":
        return PASS if p <= tau else FAIL
    lo, hi = wilson(k, n, z=1.644854)
    if lo > tau:
        return FAIL
    return PASS if p <= tau else INCOMPLETE


def gate(conditions: dict) -> dict:
    """conditions: name -> state. Returns overall state and the binding conditions."""
    if not conditions:
        return dict(state=NAMES[INCOMPLETE], binding=[])
    worst = min(conditions.values())
    return dict(state=NAMES[worst], binding=[k for k, v in conditions.items() if v == worst and worst != PASS],
                conditions={k: NAMES[v] for k, v in conditions.items()})


# ---------------------------------------------------------------- aggregation variants
ROC5 = [0.457, 0.257, 0.157, 0.090, 0.040]     # rank-order centroid weights, 5 criteria


def roc_weights(order):
    n = len(order)
    w = [sum(1 / j for j in range(i, n + 1)) / n for i in range(1, n + 1)]
    return dict(zip(order, w))


def q_arithmetic(dims, w):
    if any(dims.get(k) is None for k in w):
        return None
    return sum(w[k] * dims[k] for k in w)


def q_geometric(dims, w, floor=1.0):
    if any(dims.get(k) is None for k in w):
        return None
    return math.exp(sum(w[k] * math.log(max(dims[k], floor)) for k in w))


def q_interval(dims, w, agg=q_arithmetic):
    """Quamoco-style interval: missing dimensions filled with worst (0) and best (100)."""
    lo = {k: (0.0 if dims.get(k) is None else dims[k]) for k in w}
    hi = {k: (100.0 if dims.get(k) is None else dims[k]) for k in w}
    return (agg(lo, w), agg(hi, w))


def coverage_utility(pct):
    """research/12: piecewise linear, 0 at 0%, 50 at 70%, 75 at 80%, 100 at >= 90%."""
    pts = [(0, 0), (70, 50), (80, 75), (90, 100), (100, 100)]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if pct <= x1:
            return y0 + (y1 - y0) * (pct - x0) / (x1 - x0)
    return 100.0
