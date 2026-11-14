"""E0b — Benchmark-derived risk bands (Alves, Ypma & Visser 2010) and star caps for
our tree-sitter definitions, then the risk-profile certification test with
one-sided cluster-bootstrap bounds (intersection-union test, Berger 1982).

Bands: LOC-weighted quantiles of the pooled unit distribution where every
system has equal total weight: 70/80/90% for SLOC, CC and cognitive; 80/90/95%
for parameters (as Alves did). Caps: 4-star = 35th, 3-star = 65th percentile of
the per-system share of LOC above each band (SIG's 5/30/30/30/5 split)."""
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))

METRICS = {"sloc": (70, 80, 90), "cc": (70, 80, 90), "cog": (70, 80, 90), "params": (80, 90, 95)}


def units_of(repo_dir):
    from qlab.source import load_repo
    from qlab.model import extract
    from qlab import complexity
    rows = []
    for f in load_repo(Path(repo_dir), kinds={"prod"}):
        _, us = extract(f)
        complexity.measure_units(f, us)
        for u in us:
            rows.append((hash(f.path) & 0x7fffffff, u.sloc, u.cc, u.cog, u.nest, u.params))
    return Path(repo_dir).name, np.array(rows, dtype=np.int64)


def wquantile(x, w, q):
    o = np.argsort(x)
    cw = np.cumsum(w[o]) / w.sum()
    return float(x[o][np.searchsorted(cw, q / 100.0)])


def shares(arr, col, bands):
    w = np.maximum(arr[:, 1], 1)
    return [float(w[arr[:, col] > b].sum() / w.sum()) for b in bands]


def certify(arr, col, bands, caps, B=2000, seed=11):
    """One-sided 95% cluster bootstrap (files) on each band share; IUT verdict."""
    rng = np.random.default_rng(seed)
    files = np.unique(arr[:, 0])
    idx_by_file = {f: np.where(arr[:, 0] == f)[0] for f in files}
    w = np.maximum(arr[:, 1], 1).astype(float)
    above = [(arr[:, col] > b).astype(float) for b in bands]
    fw = np.array([w[idx_by_file[f]].sum() for f in files])
    fa = [np.array([(w * a)[idx_by_file[f]].sum() for f in files]) for a in above]
    point = [float(a.sum() / fw.sum()) for a in fa]
    draws = rng.integers(0, len(files), size=(B, len(files)))
    ups, los = [], []
    for a in fa:
        s = a[draws].sum(1) / fw[draws].sum(1)
        ups.append(float(np.percentile(s, 95)))
        los.append(float(np.percentile(s, 5)))
    if all(u <= c for u, c in zip(ups, caps)):
        v = "CERTIFIED"
    elif any(l > c for l, c in zip(los, caps)):
        v = "NOT CERTIFIED"
    else:
        v = "INCONCLUSIVE"
    return dict(point=point, upper95=ups, lower95=los, caps=list(caps), verdict=v)


def main():
    dirs = [str(p) for p in sorted((LAB / "corpus" / "bench").iterdir()) if p.is_dir()]
    target_dir = str(LAB / "corpus" / "messagepack-csharp")
    with Pool(14) as p:
        res = dict(p.map(units_of, dirs + [target_dir]))
    target = res.pop("messagepack-csharp")
    names = sorted(res)
    cols = {"sloc": 1, "cc": 2, "cog": 3, "params": 5}
    out = {"repos": names, "bands": {}, "caps": {}, "bench_shares": {}, "certification": {}}
    for m, qs in METRICS.items():
        xs, ws = [], []
        for n in names:
            a = res[n]
            w = np.maximum(a[:, 1], 1).astype(float)
            xs.append(a[:, cols[m]]); ws.append(w / w.sum())
        x, w = np.concatenate(xs), np.concatenate(ws)
        bands = [wquantile(x, w, q) for q in qs]
        out["bands"][m] = dict(quantiles=qs, thresholds=bands)
        sh = np.array([shares(res[n], cols[m], bands) for n in names])
        caps4 = np.percentile(sh, 35, axis=0).tolist()
        caps3 = np.percentile(sh, 65, axis=0).tolist()
        out["caps"][m] = dict(four_star=caps4, three_star=caps3)
        out["bench_shares"][m] = {n: s.tolist() for n, s in zip(names, sh)}
        # leave-one-out sanity: how many bench repos certify at 3 stars against caps from the others
        loo = 0
        for i, n in enumerate(names):
            others = np.delete(sh, i, axis=0)
            c3 = np.percentile(others, 65, axis=0)
            loo += int(all(s <= c for s, c in zip(sh[i], c3)))
        out["caps"][m]["loo_certified_3star"] = loo
        out["certification"][m] = dict(three_star=certify(target, cols[m], bands, caps3),
                                       four_star=certify(target, cols[m], bands, caps4))
        print(f"{m:7s} bands {qs} -> {bands}  caps3* {np.round(caps3, 3)}  caps4* {np.round(caps4, 3)}  "
              f"LOO 3* certified {loo}/{len(names)}")
        c = out["certification"][m]["three_star"]
        print(f"        MessagePack shares {np.round(c['point'], 3)} upper95 {np.round(c['upper95'], 3)} -> 3*: {c['verdict']}, "
              f"4*: {out['certification'][m]['four_star']['verdict']}")
    (LAB / "out" / "experiments" / "e0b_alves.json").write_text(json.dumps(out, indent=1))
    np.savez_compressed(LAB / "out" / "experiments" / "bench_units.npz", **{n: res[n] for n in names}, messagepack=target)


if __name__ == "__main__":
    main()
