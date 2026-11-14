"""E7 — Is textual duplication shared *knowledge*? Clone co-change and the rule of three.

At snapshot T0, Type-1/2 clone classes (qlab.dry.detect, analyzer defaults: W=50
normalised tokens, >= 6 lines) are mapped to the units (methods) that contain
them. After T0 every non-merge commit is replayed (renames followed) and the set
of changed units is computed by comparing each unit's exact token sequence
between parent and commit. For clone pairs we measure co-change
P(both change | at least one changes) and inconsistent evolution (one changes,
the other never does), against control pairs from the same file/namespace with
similar size. Rule of three: classes with 2 vs >= 3 member units.

usage: e7_clone_cochange.py [months] [repo ...]   (default: 36 months, MessagePack + history repos)"""
import hashlib
import json
import random
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from history import rev, snapshot_months_before, commits, RenameTracker, load_snapshot, cat_blobs   # noqa: E402
from stats import wilson, lr_test            # noqa: E402
from qlab.source import load_file            # noqa: E402
from qlab.model import extract               # noqa: E402
from qlab import complexity, dry             # noqa: E402

MONTHS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 36
ARGS = [a for a in sys.argv[1:] if not a.isdigit()]
REPOS = [Path(a) for a in ARGS] or ([LAB / "corpus" / "messagepack-csharp"] +
                                    sorted(p for p in (LAB / "corpus" / "history").iterdir() if p.is_dir()))
SEED = 7


def unit_table(sf, ident):
    """key -> (signature, sloc, start, end, namespace) for the units of one file version."""
    ts, us = extract(sf)
    ns_of = {t.qname: t.ns for t in ts}
    seen = defaultdict(int)
    out = {}
    for u in us:
        if u.kind == "accessor":
            continue
        base = f"{ident}::{u.qname}({u.params})"
        k = f"{base}#{seen[base]}"
        seen[base] += 1
        toks = tuple(t[1] for t in sf.tokens if u.start <= t[2] <= u.end)
        sig = hashlib.blake2b("\x1f".join(toks).encode(), digest_size=12).hexdigest()
        out[k] = (sig, complexity.sloc(u.start, u.end, sf.code_lines), u.start, u.end, ns_of.get(u.type_qname, ""))
    return out


def commit_job(args):
    repo, sha, parent, items = args
    specs = []
    for t0, old, new in items:
        if old:
            specs.append(f"{parent}:{old}")
        if new:
            specs.append(f"{sha}:{new}")
    blobs = cat_blobs(Path(repo), specs)
    changed = set()
    for t0, old, new in items:
        a = blobs.get(f"{parent}:{old}") if old else None
        b = blobs.get(f"{sha}:{new}") if new else None
        try:
            ta = unit_table(load_file(Path(repo), old, text=a), t0) if a is not None else {}
            tb = unit_table(load_file(Path(repo), new, text=b), t0) if b is not None else {}
        except Exception:
            continue
        for k in set(ta) | set(tb):
            if ta.get(k, (None,))[0] != tb.get(k, (None,))[0]:
                changed.add(k)
    return sha, sorted(changed)


def run_repo(repo: Path):
    head = rev(repo, "origin/HEAD")
    t0 = snapshot_months_before(repo, head, MONTHS)
    cache = LAB / "out" / "cache" / f"e7_{repo.name}_{MONTHS}m.json"
    files, snap = load_snapshot(repo, t0)
    units = {}
    file_units = defaultdict(list)
    for f in files:
        tab = unit_table(f, f.path)
        for k, v in tab.items():
            units[k] = v
            file_units[f.path].append(k)
    res = dry.detect(files, W=50, exact=False, min_lines=6, with_extras=False)
    code_of = {f.path: f.code_lines for f in files}
    cls_units = defaultdict(set)
    cls_type1 = {}
    for r in res.regions:
        lines = {ln for ln in range(r.start, r.end + 1) if ln in code_of[r.file]}
        for k in file_units[r.file]:
            s, e = units[k][2], units[k][3]
            if len({ln for ln in lines if s <= ln <= e}) >= 3:
                cls_units[r.cls].add(k)
        cls_type1[r.cls] = cls_type1.get(r.cls, True) and r.clone_type == 1
    classes = {c: sorted(us) for c, us in cls_units.items() if len(us) >= 2}
    # replay history
    if cache.exists():
        hist = json.loads(cache.read_text())
    else:
        tracker = RenameTracker(snap)
        t0_prod = {f.path for f in files}
        jobs, bug = [], {}
        for c in commits(repo, f"{t0}..{head}"):
            items = []
            for t0p, old, new in tracker.apply(c):
                if t0p in t0_prod and ((old or "").endswith(".cs") or (new or "").endswith(".cs")):
                    items.append((t0p, old, new))
            bug[c.sha] = c.bugfix
            if items:
                jobs.append((str(repo), c.sha, c.parent, items))
        with Pool(16) as p:
            ch = dict(p.map(commit_job, jobs, chunksize=2))
        hist = dict(t0=t0, head=head, bug=bug, changed=ch)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(hist))
    bugfix_shas = {s for s, b in hist["bug"].items() if b}
    files_per_commit = {sha: len({k.split("::")[0] for k in ks}) for sha, ks in hist["changed"].items()}
    out_variants = {}
    for variant, keep in (("all_commits", lambda sha: True), ("focused_commits", lambda sha: files_per_commit[sha] <= 10)):
        changed_by_unit = defaultdict(set)
        for sha, ks in hist["changed"].items():
            if keep(sha):
                for k in ks:
                    changed_by_unit[k].add(sha)
        out_variants[variant] = _measure(units, file_units, classes, cls_type1, changed_by_unit, bugfix_shas, by_ns_cache={})
    return dict(repo=repo.name, t0=t0, months=MONTHS, units=len(units), classes=len(classes),
                class_sizes={str(k): v for k, v in sorted(
                    __import__("collections").Counter(len(us) for us in classes.values()).items())},
                commits_with_unit_changes=len(hist["changed"]),
                sweep_commits_excluded=sum(1 for v in files_per_commit.values() if v > 10),
                variants=out_variants)


def _measure(units, file_units, classes, cls_type1, changed_by_unit, bugfix_shas, by_ns_cache):

    rng = random.Random(SEED)

    def pair_stats(u, v):
        a, b = changed_by_unit.get(u, set()), changed_by_unit.get(v, set())
        either, both = len(a | b), len(a & b)
        inconsistent = either > 0 and (not a or not b)
        return either, both, inconsistent

    clone_partner = defaultdict(set)
    for us in classes.values():
        for u in us:
            clone_partner[u] |= set(us) - {u}
    by_ns = defaultdict(list)
    for k, v in units.items():
        by_ns[v[4]].append(k)
    clone_pairs, ctrl_pairs = [], []
    MAX_PAIRS = 30          # cap per class so giant template families do not dominate
    for c, us in classes.items():
        size = len(us)
        allp = [(us[i], us[j]) for i in range(len(us)) for j in range(i + 1, len(us))]
        if len(allp) > MAX_PAIRS:
            allp = rng.sample(allp, MAX_PAIRS)
        for u, v in allp:
                clone_pairs.append((u, v, c, size))
                fpath = u.split("::")[0]
                pool = [w for w in file_units[fpath] if w not in (u, v) and w not in clone_partner[u]]
                if len(pool) < 3:
                    pool = [w for w in by_ns[units[u][4]] if w not in (u, v) and w not in clone_partner[u]]
                sv = max(1, units[v][1])
                pool = [w for w in pool if 0.7 * sv <= max(1, units[w][1]) <= 1.3 * sv]
                for w in rng.sample(pool, min(5, len(pool))):
                    ctrl_pairs.append((u, w, c, size))
    # class-level change events (Juergens et al. 2009): a commit touching some but not all members is inconsistent
    class_rows = []
    for c, us in classes.items():
        shas = set().union(*(changed_by_unit.get(u, set()) for u in us))
        partial = sum(1 for sh in shas if not all(sh in changed_by_unit.get(u, set()) for u in us))
        bugs = sum(1 for sh in shas if sh in bugfix_shas)
        class_rows.append(dict(cls=c, size=len(us), events=len(shas), partial=partial, bugfix_events=bugs,
                               type1=cls_type1.get(c, False)))
    rows = []
    for kind, pairs in (("clone", clone_pairs), ("control", ctrl_pairs)):
        for u, v, c, size in pairs:
            e, b, inc = pair_stats(u, v)
            rows.append(dict(kind=kind, u=u, v=v, cls=c, size=size, type1=cls_type1.get(c, False),
                             either=e, both=b, inconsistent=inc))
    # unit-level bug-fix involvement
    unit_rows = []
    in_class = {}
    for c, us in classes.items():
        for u in us:
            in_class[u] = max(in_class.get(u, 0), len(us))
    for k in units:
        ch = changed_by_unit.get(k, set())
        unit_rows.append(dict(unit=k, class_size=in_class.get(k, 0), changed=len(ch) > 0,
                              bugfix=len(ch & bugfix_shas) > 0, sloc=units[k][1]))
    return dict(rows=rows, unit_rows=unit_rows, class_rows=class_rows)


def summarise(rows, unit_rows, class_rows=()):
    def pooled(sel):
        e = sum(r["either"] for r in sel); b = sum(r["both"] for r in sel)
        act = [r for r in sel if r["either"] > 0]
        inc = sum(r["inconsistent"] for r in act)
        rates = [r["both"] / r["either"] for r in act]
        return dict(pairs=len(sel), active=len(act), events_either=e, events_both=b,
                    cochange_pooled=b / e if e else None, cochange_ci=wilson(b, e),
                    mean_pair_rate=float(np.mean(rates)) if rates else None,
                    inconsistent=inc, inconsistent_rate=inc / len(act) if act else None,
                    inconsistent_ci=wilson(inc, len(act))), rates
    out = {}
    cl, r_cl = pooled([r for r in rows if r["kind"] == "clone"])
    co, r_co = pooled([r for r in rows if r["kind"] == "control"])
    out["clone"], out["control"] = cl, co
    if cl["events_either"] and co["events_either"]:
        tab = [[cl["events_both"], cl["events_either"] - cl["events_both"]],
               [co["events_both"], co["events_either"] - co["events_both"]]]
        orr, p = stats.fisher_exact(tab, alternative="greater")
        out["cochange_fisher"] = dict(odds_ratio=float(orr), p=float(p))
    if r_cl and r_co:
        # permutation test on mean pair-level co-change rate (active pairs)
        rng = np.random.default_rng(SEED)
        allr = np.array(r_cl + r_co); n1 = len(r_cl)
        obs = np.mean(r_cl) - np.mean(r_co)
        perm = []
        for _ in range(5000):
            rng.shuffle(allr)
            perm.append(allr[:n1].mean() - allr[n1:].mean())
        out["cochange_permutation"] = dict(diff=float(obs), p=float((np.sum(np.array(perm) >= obs) + 1) / 5001))
        bs = [rng.choice(r_cl, len(r_cl)).mean() - rng.choice(r_co, len(r_co)).mean() for _ in range(3000)]
        out["cochange_diff_ci"] = (float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5)))
    if cl["active"] and co["active"]:
        tab = [[cl["inconsistent"], cl["active"] - cl["inconsistent"]], [co["inconsistent"], co["active"] - co["inconsistent"]]]
        orr, p = stats.fisher_exact(tab)
        out["inconsistency_fisher"] = dict(odds_ratio=float(orr), p=float(p))
    # rule of three
    two, three = pooled([r for r in rows if r["kind"] == "clone" and r["size"] == 2])[0], \
        pooled([r for r in rows if r["kind"] == "clone" and r["size"] >= 3])[0]
    out["rule_of_three"] = dict(size2=two, size3plus=three)
    if two["events_either"] and three["events_either"]:
        tab = [[three["events_both"], three["events_either"] - three["events_both"]],
               [two["events_both"], two["events_either"] - two["events_both"]]]
        orr, p = stats.fisher_exact(tab)
        out["rule_of_three"]["cochange_fisher_3plus_vs_2"] = dict(odds_ratio=float(orr), p=float(p))
    if two["active"] and three["active"]:
        tab = [[three["inconsistent"], three["active"] - three["inconsistent"]],
               [two["inconsistent"], two["active"] - two["inconsistent"]]]
        orr, p = stats.fisher_exact(tab)
        out["rule_of_three"]["inconsistency_fisher_3plus_vs_2"] = dict(odds_ratio=float(orr), p=float(p))
    # bug-fix involvement of changed units by clone-class size
    bf = {}
    for name, sel in (("not_cloned", [u for u in unit_rows if u["class_size"] == 0]),
                      ("class_of_2", [u for u in unit_rows if u["class_size"] == 2]),
                      ("class_of_3plus", [u for u in unit_rows if u["class_size"] >= 3])):
        n = len(sel); k = sum(u["bugfix"] for u in sel); chg = sum(u["changed"] for u in sel)
        kc = sum(u["bugfix"] for u in sel if u["changed"])
        bf[name] = dict(units=n, bugfix_units=k, rate=k / n if n else None, ci=wilson(k, n),
                        changed_units=chg, bugfix_given_changed=kc / chg if chg else None, ci_given_changed=wilson(kc, chg))
    for a, b in (("class_of_2", "not_cloned"), ("class_of_3plus", "not_cloned"), ("class_of_3plus", "class_of_2")):
        A, B = bf[a], bf[b]
        if A["units"] and B["units"]:
            orr, p = stats.fisher_exact([[A["bugfix_units"], A["units"] - A["bugfix_units"]],
                                         [B["bugfix_units"], B["units"] - B["bugfix_units"]]])
            bf[f"{a}_vs_{b}"] = dict(odds_ratio=float(orr), p=float(p))
    # size-controlled: logistic bugfix ~ log(sloc) + in_class_of_2 + in_class_of_3plus (units that changed at all)
    ch = [u for u in unit_rows if u["changed"]]
    if len(ch) > 30:
        y = np.array([u["bugfix"] for u in ch], float)
        ls = np.log(np.array([max(1, u["sloc"]) for u in ch], float))
        c2 = np.array([u["class_size"] == 2 for u in ch], float)
        c3 = np.array([u["class_size"] >= 3 for u in ch], float)
        try:
            lr, p, b = lr_test(ls[:, None], np.column_stack([c2, c3]), y)
            bf["size_controlled_logit_changed_units"] = dict(n=len(ch), lr=lr, p=p, or_class2=float(np.exp(b[2])),
                                                             or_class3plus=float(np.exp(b[3])), or_per_log_sloc=float(np.exp(b[1])))
        except Exception as e:
            bf["size_controlled_logit_changed_units"] = dict(error=str(e))
    out["bugfix_involvement"] = bf
    # class-level inconsistent-change rate, 2 vs >= 3 members
    cl2 = [c for c in class_rows if c["size"] == 2 and c["events"]]
    cl3 = [c for c in class_rows if c["size"] >= 3 and c["events"]]
    def agg(sel):
        ev = sum(c["events"] for c in sel); pa = sum(c["partial"] for c in sel)
        per = [c["partial"] / c["events"] for c in sel]
        return dict(classes=len(sel), events=ev, partial=pa, partial_rate=pa / ev if ev else None,
                    ci=wilson(pa, ev), mean_class_partial_rate=float(np.mean(per)) if per else None,
                    bugfix_event_rate=(sum(c["bugfix_events"] for c in sel) / ev) if ev else None), per
    a2, p2 = agg(cl2); a3, p3 = agg(cl3)
    out["class_level"] = dict(size2=a2, size3plus=a3)
    if p2 and p3:
        u = stats.mannwhitneyu(p3, p2, alternative="two-sided")
        out["class_level"]["mannwhitney_partial_rate_3plus_vs_2"] = dict(U=float(u.statistic), p=float(u.pvalue))
    return out


def main():
    per = []
    for repo in REPOS:
        try:
            per.append(run_repo(repo))
        except Exception as e:
            print(repo.name, "ERROR", e)
    result = dict(months=MONTHS, repos=[{k: v for k, v in d.items() if k != "variants"} for d in per], variants={})
    for variant in ("all_commits", "focused_commits"):
        V = [d["variants"][variant] for d in per]
        result["variants"][variant] = dict(
            pooled=summarise([r for v in V for r in v["rows"]], [u for v in V for u in v["unit_rows"]],
                             [c for v in V for c in v["class_rows"]]),
            per_repo={d["repo"]: summarise(d["variants"][variant]["rows"], d["variants"][variant]["unit_rows"],
                                           d["variants"][variant]["class_rows"]) for d in per})
    tag = "_".join(sorted(r.name for r in REPOS)) if len(REPOS) == 1 else "pooled"
    (LAB / "out" / "experiments" / f"e7_clone_cochange_{tag}_{MONTHS}m.json").write_text(json.dumps(result, indent=1, default=float))
    for variant, V in result["variants"].items():
        P = V["pooled"]
        print(f"=== {variant}")
        for k in ("clone", "control"):
            x = P[k]
            print(f"  {k:8s} pairs={x['pairs']} active={x['active']} co-change={x['cochange_pooled']} "
                  f"mean_pair={x['mean_pair_rate']} inconsistent_rate={x['inconsistent_rate']}")
        print("  fisher", P.get("cochange_fisher"), "perm", P.get("cochange_permutation"), "diffCI", P.get("cochange_diff_ci"))
        print("  inconsistency fisher", P.get("inconsistency_fisher"))
        r3 = P["rule_of_three"]
        print("  pairs size2", {k: r3["size2"][k] for k in ("pairs", "cochange_pooled", "inconsistent_rate")},
              "size3+", {k: r3["size3plus"][k] for k in ("pairs", "cochange_pooled", "inconsistent_rate")},
              r3.get("cochange_fisher_3plus_vs_2"), r3.get("inconsistency_fisher_3plus_vs_2"))
        print("  class-level", json.dumps(P["class_level"], default=float))
        reps = V["per_repo"]
        pos = sum(1 for r in reps.values() if r["clone"]["cochange_pooled"] is not None and r["control"]["cochange_pooled"] is not None
                  and r["clone"]["cochange_pooled"] > r["control"]["cochange_pooled"])
        tot = sum(1 for r in reps.values() if r["clone"]["cochange_pooled"] is not None and r["control"]["cochange_pooled"] is not None)
        print(f"  repos with clone co-change > control: {pos}/{tot}")
        print("  size-controlled", P["bugfix_involvement"].get("size_controlled_logit_changed_units"))
        print("  bugfix", json.dumps({k: (v.get("rate"), v.get("units")) if "units" in v else v for k, v in P["bugfix_involvement"].items()}, default=float))


if __name__ == "__main__":
    main()
