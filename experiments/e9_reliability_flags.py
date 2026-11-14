"""E9 — Score reliability (split-half across files, Spearman-Brown) and
E10 — DRY vs KISS: do methods with boolean flag arguments (bool parameters that
steer an if/?:) have higher cognitive complexity for their size?"""
import json
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from stats import cliffs_delta   # noqa: E402

SPLITS = 40


def flag_params(u):
    pl = u.node.child_by_field_name("parameters")
    if pl is None:
        return set()
    bools = set()
    for p in pl.named_children:
        if p.type == "parameter":
            t = p.child_by_field_name("type"); n = p.child_by_field_name("name")
            if t is not None and n is not None and t.text in (b"bool", b"Boolean", b"System.Boolean"):
                bools.add(n.text)
    if not bools:
        return set()
    used = set()
    st = [u.body]
    while st:
        n = st.pop()
        if n.type in ("if_statement", "conditional_expression", "while_statement"):
            c = n.child_by_field_name("condition")
            if c is not None:
                s2 = [c]
                while s2:
                    x = s2.pop()
                    if x.type == "identifier" and x.text in bools:
                        used.add(x.text)
                    s2.extend(x.children)
        st.extend(n.children)
    return used


def run(repo_dir):
    from qlab.analyze import analyze
    from qlab.practices import PRACTICES
    A = analyze(repo_dir)
    num, den = defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(float))
    for e in A.entities:
        num[e.practice][e.file] += e.weight * e.v
        den[e.practice][e.file] += e.weight
    rng = np.random.default_rng(3)
    files = sorted({f.path for f in A.files})
    halves = {p: [] for p in PRACTICES}
    for _ in range(SPLITS):
        perm = rng.permutation(len(files))
        a = {files[i] for i in perm[: len(files) // 2]}
        for p in PRACTICES:
            def comp(sel):
                n_ = sum(v for f, v in num[p].items() if (f in a) == sel)
                d_ = sum(v for f, v in den[p].items() if (f in a) == sel)
                return 1 - n_ / d_ if d_ else np.nan
            halves[p].append((comp(True), comp(False)))
    flags = []
    for us in A.units.values():
        for u in us:
            if u.kind != "method" or u.sloc < 3:
                continue
            f = bool(flag_params(u))
            flags.append((f, u.cog / u.sloc, u.cc / u.sloc, u.sloc, u.cog))
    return Path(repo_dir).name, halves, flags


def main():
    dirs = [str(p) for p in sorted((LAB / "corpus" / "bench").iterdir()) if p.is_dir()] + [str(LAB / "corpus" / "messagepack-csharp")]
    with Pool(14) as pool:
        res = pool.map(run, dirs)
    from qlab.practices import PRACTICES
    out = {"reliability": {}, "flags": {}}
    for p in PRACTICES:
        rs = []
        for s in range(SPLITS):
            a = np.array([r[1][p][s][0] for r in res]); b = np.array([r[1][p][s][1] for r in res])
            ok = ~(np.isnan(a) | np.isnan(b))
            if ok.sum() > 5:
                rs.append(stats.pearsonr(a[ok], b[ok]).statistic)
        r = float(np.median(rs)) if rs else float("nan")
        out["reliability"][p] = dict(split_half_r=r, spearman_brown=2 * r / (1 + r) if r == r else None)
        print(f"{p:18s} split-half r={r:.3f}  Spearman-Brown={2*r/(1+r):.3f}")
    allf = [x for r in res for x in r[2]]
    fl = np.array([x for x in allf if x[0]], dtype=float); nf = np.array([x for x in allf if not x[0]], dtype=float)
    mw = stats.mannwhitneyu(fl[:, 1], nf[:, 1], alternative="greater")
    # within-repo: median cognitive density difference per repo, sign test across repos
    per_repo = []
    for name, _, fs in res:
        a = [x[1] for x in fs if x[0]]; b = [x[1] for x in fs if not x[0]]
        if len(a) >= 5:
            per_repo.append((name, float(np.median(a) - np.median(b)), len(a)))
    pos = sum(1 for _, d, _ in per_repo if d > 0)
    sign_p = stats.binomtest(pos, len(per_repo), 0.5, alternative="greater").pvalue
    out["flags"] = dict(n_flag_methods=len(fl), n_other=len(nf), share_flag=len(fl) / len(allf),
                        cog_density_median_flag=float(np.median(fl[:, 1])), cog_density_median_other=float(np.median(nf[:, 1])),
                        mannwhitney_p=float(mw.pvalue), cliffs_delta=cliffs_delta(fl[:2000, 1], nf[:6000, 1]),
                        sloc_median_flag=float(np.median(fl[:, 3])), sloc_median_other=float(np.median(nf[:, 3])),
                        repos_flag_more_complex=pos, repos=len(per_repo), sign_test_p=float(sign_p), per_repo=per_repo)
    print(json.dumps({k: v for k, v in out["flags"].items() if k != "per_repo"}, indent=1))
    (LAB / "out" / "experiments" / "e9_reliability_flags.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
