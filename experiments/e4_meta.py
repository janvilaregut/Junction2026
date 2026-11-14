"""E4b — Random-effects meta-analysis of E4 across repositories.

For each predictor, per-repo partial Spearman r (controlling log SLOC) is
Fisher-transformed (var ~ 1.06/(n-3), Fieller et al.) and pooled with the
DerSimonian–Laird random-effects estimator; I² measures heterogeneity.
Repos are included when they have >= 8 files with and >= 8 without a fix."""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB / "experiments"))
from stats import bh   # noqa: E402

OUT = LAB / "out" / "experiments"


def dl_pool(r, n):
    r = np.clip(np.asarray(r, float), -0.999, 0.999)
    n = np.asarray(n, float)
    z = np.arctanh(r)
    v = 1.06 / (n - 3)
    w = 1 / v
    zf = (w * z).sum() / w.sum()
    Q = (w * (z - zf) ** 2).sum()
    k = len(z)
    c = w.sum() - (w ** 2).sum() / w.sum()
    tau2 = max(0.0, (Q - (k - 1)) / c) if k > 1 else 0.0
    ws = 1 / (v + tau2)
    zr = (ws * z).sum() / ws.sum()
    se = math.sqrt(1 / ws.sum())
    p = 2 * stats.norm.sf(abs(zr / se))
    I2 = max(0.0, (Q - (k - 1)) / Q) if Q > 0 else 0.0
    return dict(r=float(np.tanh(zr)), lo=float(np.tanh(zr - 1.96 * se)), hi=float(np.tanh(zr + 1.96 * se)),
                p=float(p), I2=float(I2), tau2=float(tau2), k=k, fixed_r=float(np.tanh(zf)))


def main():
    result = {}
    for win in (24, 36):
        recs = []
        for f in sorted(OUT.glob(f"e4_predictive_*_{win}m.json")):
            d = json.loads(f.read_text())
            nfix = d["files_with_bugfix"]
            if nfix >= 8 and d["files"] - nfix >= 8:
                recs.append(d)
        preds = [m for m in recs[0]["predictors"] if m != "sloc"]
        rows = {}
        for m in preds + ["sloc"]:
            rr, nn, raw, gains, sig, pos = [], [], [], [], 0, 0
            for d in recs:
                p = d["predictors"].get(m)
                if not p or p.get("constant"):
                    continue
                rr.append(p["partial_spearman_bug_given_size"]); nn.append(d["files"])
                raw.append(p["spearman_bug"])
                gains.append(p["auc_size_churn_metric"] - p["auc_size_churn"])
                sig += (p.get("q_lr", 1) < 0.05 or p.get("q_partial", 1) < 0.05)
                pos += p["partial_spearman_bug_given_size"] > 0
            if len(rr) < 3:
                continue
            pooled = dl_pool(rr, nn)
            pooled_raw = dl_pool(raw, nn)
            rows[m] = dict(partial=pooled, raw=pooled_raw, mean_auc_gain=float(np.mean(gains)),
                           repos_significant=int(sig), repos_positive=int(pos), repos=len(rr))
        names = [m for m in rows if m != "sloc"]
        q = bh([rows[m]["partial"]["p"] for m in names])
        qr = bh([rows[m]["raw"]["p"] for m in names])
        for m, a, b in zip(names, q, qr):
            rows[m]["partial"]["q"] = float(a)
            rows[m]["raw"]["q"] = float(b)
            sig_raw, sig_part = b < 0.05, a < 0.05
            rows[m]["verdict"] = ("adds over size" if sig_part and rows[m]["partial"]["r"] > 0 else
                                  "protective beyond size" if sig_part else
                                  "size-redundant" if sig_raw else "no association")
        result[f"{win}m"] = dict(repos=[d["repo"] for d in recs], n_files=sum(d["files"] for d in recs),
                                  n_files_fixed=sum(d["files_with_bugfix"] for d in recs), predictors=rows)
        print(f"\n=== window {win} months: {len(recs)} repos, {result[f'{win}m']['n_files']} files, "
              f"{result[f'{win}m']['n_files_fixed']} with >=1 bug-fix ===")
        print(f"{'predictor':26s} {'raw r':>6s} {'q':>7s} | {'r|size':>6s} [{'95% CI':^13s}] {'q':>7s} {'I2':>5s} {'+':>3s}/{'k':<3s} {'dAUC':>6s}  verdict")
        order = sorted(names, key=lambda m: -rows[m]["partial"]["r"])
        for m in ["sloc"] + order:
            r = rows[m]
            pr = r["partial"]
            print(f"{m:26s} {r['raw']['r']:6.3f} {r['raw'].get('q', r['raw']['p']):7.4f} | {pr['r']:6.3f} "
                  f"[{pr['lo']:5.2f},{pr['hi']:5.2f}] {pr.get('q', float('nan')):7.4f} {pr['I2']:5.2f} {r['repos_positive']:3d}/{r['repos']:<3d} "
                  f"{r['mean_auc_gain']:6.3f}  {r.get('verdict', 'size baseline')}")
    (OUT / "e4_meta.json").write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
