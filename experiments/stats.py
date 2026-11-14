"""Small, dependency-light statistics helpers (numpy/scipy only)."""
import math

import numpy as np
from scipy import stats


def wilson(k, n, z=1.959964):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def spearman(x, y):
    r, p = stats.spearmanr(x, y)
    return float(r), float(p)


def partial_spearman(x, y, z):
    """Rank-based partial correlation of x and y controlling for z."""
    rx, ry, rz = (stats.rankdata(v) for v in (x, y, z))
    def resid(a, b):
        b1 = np.vstack([b, np.ones_like(b)]).T
        coef, *_ = np.linalg.lstsq(b1, a, rcond=None)
        return a - b1 @ coef
    ex, ey = resid(rx, rz), resid(ry, rz)
    r = float(np.corrcoef(ex, ey)[0, 1])
    n = len(x)
    t = r * math.sqrt(max(1e-12, (n - 3) / max(1e-12, 1 - r * r)))
    p = 2 * stats.t.sf(abs(t), n - 3)
    return r, float(p)


def logit_fit(X, y, iters=50):
    """Logistic regression by IRLS. Returns (beta, loglik)."""
    X = np.column_stack([np.ones(len(y)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        eta = X @ b
        p = 1 / (1 + np.exp(-eta))
        W = np.clip(p * (1 - p), 1e-9, None)
        H = X.T @ (X * W[:, None]) + 1e-8 * np.eye(X.shape[1])
        g = X.T @ (y - p)
        step = np.linalg.solve(H, g)
        b += step
        if np.max(np.abs(step)) < 1e-8:
            break
    p = np.clip(1 / (1 + np.exp(-(X @ b))), 1e-12, 1 - 1e-12)
    ll = float(np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))
    return b, ll


def lr_test(X0, X1, y):
    """Likelihood-ratio test: does adding X1 columns to X0 improve the fit?"""
    _, l0 = logit_fit(X0, y)
    b1, l1 = logit_fit(np.column_stack([X0, X1]), y)
    df = X1.shape[1] if X1.ndim > 1 else 1
    lr = 2 * (l1 - l0)
    return float(lr), float(stats.chi2.sf(lr, df)), b1


def auc(score, y):
    y = np.asarray(y).astype(bool)
    if y.all() or (~y).all():
        return float("nan")
    u = stats.mannwhitneyu(np.asarray(score)[y], np.asarray(score)[~y]).statistic
    return float(u / (y.sum() * (~y).sum()))


def bh(pvals):
    """Benjamini-Hochberg adjusted p-values."""
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    order = np.argsort(p)
    adj = np.empty(n)
    prev = 1.0
    for rank, i in reversed(list(enumerate(order, 1))):
        prev = min(prev, p[i] * n / rank)
        adj[i] = prev
    return adj


def cliffs_delta(a, b):
    a, b = np.asarray(a), np.asarray(b)
    gt = sum((x > b).sum() for x in a)
    lt = sum((x < b).sum() for x in a)
    return float((gt - lt) / (len(a) * len(b)))


def icc_2_1(x, y):
    """Two-way random, absolute agreement, single measure ICC(2,1)."""
    M = np.column_stack([x, y]).astype(float)
    n, k = M.shape
    gm = M.mean()
    msr = k * ((M.mean(1) - gm) ** 2).sum() / (n - 1)
    msc = n * ((M.mean(0) - gm) ** 2).sum() / (k - 1)
    sse = ((M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + gm) ** 2).sum()
    mse = sse / ((n - 1) * (k - 1))
    return float((msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n))
