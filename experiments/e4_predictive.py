"""E4 — Predictive validity of qlab metrics against future bug-fix activity.

Snapshot T0 (first-parent commit ~N months before HEAD). Unit = production .cs
file at T0. Outcomes after T0: number of non-merge bug-fix commits touching the
file (keyword labelled, renames followed) and number of changes. Predictors are
computed with qlab on the T0 tree. For each predictor: Spearman, partial Spearman
controlling log(SLOC), logistic regression has_bugfix ~ log(SLOC) + log1p(prior
churn) + z(metric) with a likelihood-ratio test and AUC, BH-adjusted.

usage: e4_predictive.py [repo_dir] [months] [label]
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from history import (rev, snapshot_months_before, commit_date, commits, RenameTracker, load_snapshot, git)  # noqa: E402
from stats import spearman, partial_spearman, lr_test, logit_fit, auc, bh  # noqa: E402
from qlab.analyze import analyze      # noqa: E402
from qlab import design               # noqa: E402

REPO = Path(sys.argv[1]) if len(sys.argv) > 1 else LAB / "corpus" / "messagepack-csharp"
MONTHS = int(sys.argv[2]) if len(sys.argv) > 2 else 24
LABEL = sys.argv[3] if len(sys.argv) > 3 else REPO.name


def pagerank(nodes, edges, d=0.85, iters=200):
    idx = {n: i for i, n in enumerate(nodes)}
    n = len(nodes)
    out = defaultdict(list)
    for a, b in edges:
        out[idx[a]].append(idx[b])
    pr = np.full(n, 1 / n)
    for _ in range(iters):
        new = np.full(n, (1 - d) / n)
        dangling = sum(pr[i] for i in range(n) if not out[i])
        new += d * dangling / n
        for i, js in out.items():
            if js:
                share = d * pr[i] / len(js)
                for j in js:
                    new[j] += share
        if np.abs(new - pr).sum() < 1e-12:
            pr = new
            break
        pr = new
    return {nodes[i]: float(pr[i]) for i in range(n)}


def betweenness(nodes, edges):
    """Brandes betweenness on the directed file graph (unweighted)."""
    adj = defaultdict(list)
    for a, b in edges:
        adj[a].append(b)
    cb = dict.fromkeys(nodes, 0.0)
    for s in nodes:
        stack, pred = [], defaultdict(list)
        sigma = dict.fromkeys(nodes, 0.0); sigma[s] = 1.0
        dist = dict.fromkeys(nodes, -1); dist[s] = 0
        q = [s]; qi = 0
        while qi < len(q):
            v = q[qi]; qi += 1
            stack.append(v)
            for w in adj[v]:
                if dist[w] < 0:
                    dist[w] = dist[v] + 1; q.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]; pred[w].append(v)
        delta = dict.fromkeys(nodes, 0.0)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                delta[v] += sigma[v] / sigma[w] * (1 + delta[w])
            if w != s:
                cb[w] += delta[w]
    return cb


def file_predictors(A):
    per = defaultdict(lambda: defaultdict(float))
    ent = defaultdict(lambda: defaultdict(list))
    for e in A.entities:
        ent[e.file][e.practice].append(e)
    for f in A.files:
        p = f.path
        d = per[p]
        d["sloc"] = len(f.code_lines)
        us = [u for u in A.units.get(p, []) if u.kind != "accessor" or u.sloc > 0]
        d["sum_cc"] = sum(u.cc for u in us)
        d["max_cc"] = max((u.cc for u in us), default=0)
        d["sum_cog"] = sum(u.cog for u in us)
        d["max_cog"] = max((u.cog for u in us), default=0)
        d["max_nest"] = max((u.nest for u in us), default=0)
        d["max_unit_sloc"] = max((u.sloc for u in us), default=0)
        d["max_params"] = max((u.params for u in us), default=0)
        dry = ent[p]["dry"]
        n = max(1, len(dry))
        d["dup_t1_frac"] = sum(1 for e in dry if e.v >= 1.0) / n
        d["dup_t2_frac"] = sum(1 for e in dry if e.v >= 0.7) / n
        d["dup_any_frac"] = sum(1 for e in dry if e.v > 0) / n
        mg = ent[p]["magic_numbers"]
        d["magic_density"] = sum(e.v for e in mg) / max(1, len(mg))
        nm = ent[p]["naming"]
        d["naming_violation_density"] = sum(e.v for e in nm) / max(1, len(nm))
        doc = ent[p]["documentation"]
        d["doc_coverage"] = 1 - (sum(e.v for e in doc) / len(doc)) if doc else 1.0
        dc = ent[p]["dead_code"]
        d["dead_code_density"] = sum(e.v for e in dc) / max(1, len(dc))
    for f in A.findings:
        if f.practice == "error_handling":
            per[f.file]["error_handling_violations"] += f.severity
    for key, ev in A.unit_evidence.items():
        if key[0] == "type":
            fp = ev["file"]
            if ev.get("lcom4") is not None:
                per[fp]["max_lcom4"] = max(per[fp]["max_lcom4"], ev["lcom4"])
            per[fp]["max_cbo"] = max(per[fp]["max_cbo"], ev.get("cbo", 0))
    # file-level dependency graph from type dependencies
    G = design.merge_partials(A.types)
    dg = design.dependency_graph(G)
    files_of = {qn: {p.file for p in parts} for qn, parts in G.items()}
    nodes = [f.path for f in A.files]
    edges = set()
    for a, bs in dg.type_deps.items():
        for b in bs:
            for fa in files_of.get(a, ()):
                for fb in files_of.get(b, ()):
                    if fa != fb:
                        edges.add((fa, fb))
    indeg = defaultdict(int); outdeg = defaultdict(int)
    for a, b in edges:
        outdeg[a] += 1; indeg[b] += 1
    pr = pagerank(nodes, sorted(edges))
    bc = betweenness(nodes, sorted(edges))
    for p in nodes:
        per[p]["in_degree"] = indeg[p]
        per[p]["out_degree"] = outdeg[p]
        per[p]["pagerank"] = pr[p]
        per[p]["betweenness"] = bc[p]
    return per, len(edges)


def main():
    head = rev(REPO, "origin/HEAD")
    t0 = snapshot_months_before(REPO, head, MONTHS)
    files, snap = load_snapshot(REPO, t0)
    A = analyze(REPO, files=files)
    per, n_edges = file_predictors(A)
    t0_paths = {f.path for f in files}
    # outcomes after T0 (follow renames)
    tracker = RenameTracker(snap)
    bug = defaultdict(int); chg = defaultdict(int)
    n_commits = n_bug = 0
    for c in commits(REPO, f"{t0}..{head}"):
        n_commits += 1
        touched = {t for t, _, _ in tracker.apply(c) if t is not None}
        if c.bugfix:
            n_bug += 1
        for t in touched & t0_paths:
            chg[t] += 1
            if c.bugfix:
                bug[t] += 1
    # prior churn: 12 months before T0
    import datetime as dt
    d0 = dt.datetime.fromisoformat(commit_date(REPO, t0).replace("Z", "+00:00"))
    since = (d0 - dt.timedelta(days=365)).isoformat()
    prior = defaultdict(int)
    out = git(REPO, "log", "--no-merges", "--name-only", "--format=%x00", f"--since={since}", t0)
    for block in out.split("\x00"):
        for p in set(x for x in block.split("\n") if x.strip()):
            prior[p] += 1
    paths = [p for p in sorted(t0_paths) if per[p]["sloc"] > 0]
    y_bug = np.array([bug[p] for p in paths], float)
    y_any = (y_bug > 0).astype(float)
    y_chg = np.array([chg[p] for p in paths], float)
    sloc = np.array([per[p]["sloc"] for p in paths], float)
    lsloc = np.log(sloc)
    churn = np.log1p(np.array([prior[p] for p in paths], float))
    predictors = ["sloc", "sum_cc", "max_cc", "sum_cog", "max_cog", "max_nest", "max_unit_sloc", "max_params",
                  "dup_t1_frac", "dup_t2_frac", "dup_any_frac", "magic_density", "naming_violation_density",
                  "doc_coverage", "dead_code_density", "error_handling_violations", "max_lcom4", "max_cbo",
                  "in_degree", "out_degree", "pagerank", "betweenness", "prior_churn"]
    rows = {}
    base_X = np.column_stack([lsloc, churn])
    _, ll_size = logit_fit(lsloc[:, None], y_any)
    b_base, _ = logit_fit(base_X, y_any)
    auc_base = auc(np.column_stack([np.ones(len(paths)), base_X]) @ b_base, y_any)
    b_s, _ = logit_fit(lsloc[:, None], y_any)
    auc_size = auc(np.column_stack([np.ones(len(paths)), lsloc]) @ b_s, y_any)
    for m in predictors:
        x = churn if m == "prior_churn" else np.array([per[p][m] for p in paths], float)
        if np.std(x) == 0:
            rows[m] = dict(constant=True); continue
        rs, ps = spearman(x, y_bug)
        rc, pc = spearman(x, y_chg)
        if m == "sloc":
            rp, pp = rs, ps
        else:
            rp, pp = partial_spearman(x, y_bug, lsloc)
        z = (x - x.mean()) / x.std()
        if m in ("sloc",):
            X0, X1 = churn[:, None], z
        elif m == "prior_churn":
            X0, X1 = lsloc[:, None], z
        else:
            X0, X1 = base_X, z
        lr, plr, b1 = lr_test(X0, X1[:, None], y_any)
        Xf = np.column_stack([np.ones(len(paths)), X0, X1])
        a_full = auc(Xf @ b1, y_any)
        b_only, _ = logit_fit(z[:, None], y_any)
        a_only = auc(z, y_any) if b_only[1] >= 0 else auc(-z, y_any)
        rows[m] = dict(spearman_bug=rs, p_spearman=ps, spearman_changes=rc, p_changes=pc,
                       partial_spearman_bug_given_size=rp, p_partial=pp, lr=lr, p_lr=plr,
                       odds_ratio_per_sd=float(math.exp(b1[-1])), auc_metric_alone=a_only,
                       auc_size_churn=auc_base, auc_size_churn_metric=a_full)
    names = [m for m in predictors if not rows[m].get("constant")]
    for key, src in (("q_spearman", "p_spearman"), ("q_partial", "p_partial"), ("q_lr", "p_lr")):
        q = bh([rows[m][src] for m in names])
        for m, qq in zip(names, q):
            rows[m][key] = float(qq)
    for m in names:
        r = rows[m]
        raw_sig = r["q_spearman"] < 0.05
        adj_sig = r["q_partial"] < 0.05 or r["q_lr"] < 0.05
        r["verdict"] = ("adds over size" if adj_sig else ("size-redundant" if raw_sig else "no association"))
        if m == "sloc":
            r["verdict"] = "size baseline" + (" (significant)" if raw_sig else "")
    res = dict(repo=LABEL, head=head, t0=t0, t0_date=commit_date(REPO, t0), months=MONTHS, files=len(paths),
               commits_after=n_commits, bugfix_commits_after=n_bug, files_with_bugfix=int(y_any.sum()),
               file_edges=n_edges, auc_size_only=auc_size, auc_size_churn=auc_base, predictors=rows)
    outd = LAB / "out" / "experiments"
    outd.mkdir(parents=True, exist_ok=True)
    (outd / f"e4_predictive_{LABEL}.json").write_text(json.dumps(res, indent=1))
    print(f"{LABEL}: T0={t0[:8]} ({res['t0_date'][:10]}), files={len(paths)}, bugfix commits={n_bug}/{n_commits}, "
          f"files with >=1 fix={int(y_any.sum())}, AUC size={auc_size:.3f} size+churn={auc_base:.3f}")
    print(f"{'metric':26s} {'rho':>6s} {'q':>7s} {'rho|size':>8s} {'q':>7s} {'OR/sd':>6s} {'q_lr':>7s} {'AUC+':>6s}  verdict")
    for m in names:
        r = rows[m]
        print(f"{m:26s} {r['spearman_bug']:6.3f} {r['q_spearman']:7.4f} {r['partial_spearman_bug_given_size']:8.3f} "
              f"{r['q_partial']:7.4f} {r['odds_ratio_per_sd']:6.2f} {r['q_lr']:7.4f} {r['auc_size_churn_metric']:6.3f}  {r['verdict']}")


if __name__ == "__main__":
    main()
