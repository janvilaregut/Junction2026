"""E5 — Known-groups / tracking validity: do refactoring commits improve the measures?

Commits whose subject says refactor / clean up / simplify / dedup / extract
method|class / remove duplicat / tidy are mined from MessagePack and the
full-history benchmark repos. For each touched production .cs file present in
parent and commit, file-level measures are computed before and after; paired
one-sided Wilcoxon (after < before), rank-biserial and Cliff's delta, Holm
correction. Also reported at commit level (files aggregated per commit)."""
import json
import re
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from history import commits, cat_blobs, rev       # noqa: E402
from stats import cliffs_delta                    # noqa: E402
from qlab.source import load_file, classify       # noqa: E402
from qlab.model import extract                    # noqa: E402
from qlab import complexity, dry, hygiene         # noqa: E402

REFACTOR = re.compile(r"refactor|clean ?up|simplif|dedup|de-dup|extract (method|class)|remove duplicat|tidy", re.I)
MEASURES = ["sloc", "total_cc", "max_cc", "total_cog", "max_nest", "mean_unit_sloc", "dup_t2_frac",
            "magic_density", "naming_density"]
REPOS = [LAB / "corpus" / "messagepack-csharp"] + sorted(p for p in (LAB / "corpus" / "history").iterdir() if p.is_dir())


def measures(repo, rel, raw):
    sf = load_file(repo, rel, text=raw)
    ts, us = extract(sf)
    complexity.measure_units(sf, us)
    code = max(1, len(sf.code_lines))
    r = dry.detect([sf], W=50, exact=False, min_lines=6, with_extras=False)
    dl = sum(len(v) for v in r.dup_lines.values())
    mg = len({ln for ln, _ in hygiene.magic_numbers(sf)})
    ds = list(hygiene.declarations(sf, ts, us))
    nf = hygiene.naming_findings(ds, None, None)
    worst = {}
    for line, kind, name, sev, rule, msg in nf:
        worst[(line, name)] = max(worst.get((line, name), 0), sev)
    units = [u for u in us if u.sloc > 0]
    return dict(sloc=len(sf.code_lines), total_cc=sum(u.cc for u in units), max_cc=max((u.cc for u in units), default=0),
                total_cog=sum(u.cog for u in units), max_nest=max((u.nest for u in units), default=0),
                mean_unit_sloc=float(np.mean([u.sloc for u in units])) if units else 0.0,
                dup_t2_frac=dl / code, magic_density=mg / code,
                naming_density=sum(worst.values()) / max(1, len(ds)))


def job(args):
    repo, c = args
    out = []
    specs, pairs = [], []
    for st, old, new in c["changes"]:
        if st not in ("M", "R") or not new.endswith(".cs"):
            continue
        pairs.append((old, new))
        specs += [f"{c['parent']}:{old}", f"{c['sha']}:{new}", f"{c['sha']}:{new[:-3]}.tt"]
    blobs = cat_blobs(Path(repo), specs)
    for old, new in pairs:
        a, b = blobs.get(f"{c['parent']}:{old}"), blobs.get(f"{c['sha']}:{new}")
        if a is None or b is None or f"{c['sha']}:{new[:-3]}.tt" in blobs:
            continue
        if classify(new, b, Path("/nonexistent-qlab")) != "prod":
            continue
        try:
            mb, ma = measures(Path(repo), old, a), measures(Path(repo), new, b)
        except Exception as e:      # parse/extraction problem: record and skip
            out.append(dict(repo=Path(repo).name, sha=c["sha"], file=new, error=str(e)[:200]))
            continue
        out.append(dict(repo=Path(repo).name, sha=c["sha"], subject=c["subject"], file=new, before=mb, after=ma))
    return out


def holm(p):
    p = np.asarray(p, float); n = len(p); order = np.argsort(p)
    adj = np.empty(n); run = 0.0
    for i, k in enumerate(order):
        run = max(run, min(1.0, (n - i) * p[k])); adj[k] = run
    return adj


def analyse(rows):
    res = {}
    pvals = []
    for m in MEASURES:
        b = np.array([r["before"][m] for r in rows], float)
        a = np.array([r["after"][m] for r in rows], float)
        d = a - b
        nz = d[d != 0]
        if len(nz) == 0:
            res[m] = dict(n=len(d), all_equal=True); pvals.append(1.0); continue
        w = stats.wilcoxon(a, b, alternative="less", zero_method="wilcox")
        rk = stats.rankdata(np.abs(nz))
        rbc = float((rk[nz < 0].sum() - rk[nz > 0].sum()) / rk.sum())   # >0 means improvement (decrease)
        res[m] = dict(n=len(d), improved=int((d < 0).sum()), worsened=int((d > 0).sum()), neutral=int((d == 0).sum()),
                      median_delta=float(np.median(d)), mean_delta=float(d.mean()), p_one_sided=float(w.pvalue),
                      rank_biserial_improvement=rbc, cliffs_delta_after_vs_before=cliffs_delta(a, b))
        pvals.append(float(w.pvalue))
    for m, q in zip(MEASURES, holm(pvals)):
        res[m]["p_holm"] = float(q)
    return res


def main():
    jobs = []
    per_repo_commits = {}
    for repo in REPOS:
        cs = [c for c in commits(repo, rev(repo, "origin/HEAD")) if REFACTOR.search(c.subject)]
        per_repo_commits[repo.name] = len(cs)
        for c in cs:
            jobs.append((str(repo), dict(sha=c.sha, parent=c.parent, subject=c.subject, changes=c.changes)))
    cache = LAB / "out" / "cache" / "e5_rows.json"
    if cache.exists() and "--fresh" not in sys.argv:
        rows = json.loads(cache.read_text())
    else:
        with Pool(16) as p:
            rows = [r for rs in p.map(job, jobs, chunksize=2) for r in rs]
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(rows))
    errs = [r for r in rows if "error" in r]
    rows = [r for r in rows if "error" not in r]
    # commit-level aggregation
    by_commit = defaultdict(list)
    for r in rows:
        by_commit[(r["repo"], r["sha"])].append(r)
    crow = []
    for (repo, sha), rs in by_commit.items():
        agg = {}
        for side in ("before", "after"):
            s = {k: sum(r[side][k] for r in rs) for k in ("sloc", "total_cc", "total_cog")}
            s["max_cc"] = max(r[side]["max_cc"] for r in rs)
            s["max_nest"] = max(r[side]["max_nest"] for r in rs)
            tot = max(1, s["sloc"])
            for k in ("mean_unit_sloc",):
                s[k] = float(np.mean([r[side][k] for r in rs]))
            for k in ("dup_t2_frac", "magic_density"):
                s[k] = sum(r[side][k] * max(1, r[side]["sloc"]) for r in rs) / tot
            s["naming_density"] = float(np.mean([r[side]["naming_density"] for r in rs]))
            agg[side] = s
        crow.append(dict(repo=repo, sha=sha, before=agg["before"], after=agg["after"]))
    res = dict(repos=per_repo_commits, refactoring_commits=len(jobs), file_pairs=len(rows), commit_pairs=len(crow),
               errors=len(errs), file_level=analyse(rows), commit_level=analyse(crow),
               messagepack_only=analyse([r for r in rows if r["repo"] == "messagepack-csharp"]) if
               sum(r["repo"] == "messagepack-csharp" for r in rows) > 5 else None)
    # subgroups by stated intent
    SUB = {"dry_intent": re.compile(r"dedup|de-dup|duplicat|extract (method|class)|reuse|consolidat|share common", re.I),
           "simplify_intent": re.compile(r"simplif", re.I)}
    res["subgroups"] = {}
    for name, rx in SUB.items():
        sub = [r for r in rows if rx.search(r.get("subject", ""))]
        res["subgroups"][name] = dict(file_pairs=len(sub), commits=len({(r["repo"], r["sha"]) for r in sub}),
                                      file_level=analyse(sub) if len(sub) > 10 else None)
    (LAB / "out" / "experiments" / "e5_refactoring.json").write_text(json.dumps(res, indent=1))
    print(f"refactoring commits={len(jobs)} file pairs={len(rows)} commit pairs={len(crow)} errors={len(errs)}")
    blocks = [(lv, res[lv]) for lv in ("file_level", "commit_level")]
    blocks += [(f"subgroup {k} ({v['commits']} commits, {v['file_pairs']} files)", v["file_level"])
               for k, v in res["subgroups"].items() if v["file_level"]]
    for level, tab in blocks:
        print(f"--- {level}")
        for m in MEASURES:
            r = tab[m]
            if r.get("all_equal"):
                print(f"{m:16s} all equal"); continue
            print(f"{m:16s} n={r['n']:4d} improved={r['improved']:4d} worse={r['worsened']:4d} neutral={r['neutral']:4d} "
                  f"med_delta={r['median_delta']:8.3f} p={r['p_one_sided']:.2e} p_holm={r['p_holm']:.2e} "
                  f"rbc={r['rank_biserial_improvement']:.3f} cliff={r['cliffs_delta_after_vs_before']:.3f}")


if __name__ == "__main__":
    main()
