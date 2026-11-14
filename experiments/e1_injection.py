"""E1 — Sensitivity by controlled violation injection (mutation analysis of metrics).

For each practice we apply a source-to-source operator that injects ONE known
violation into a randomly sampled unit/class of MessagePack (seed fixed), re-run
qlab, and check (a) that the expected finding appears on the injected lines
(detection), (b) metamorphic exactness where the expected delta is known exactly
(e.g. +5 parameters => params +5), (c) locality (no new findings of that rule
elsewhere), and (d) that the practice compliance of the file drops (paired
one-sided Wilcoxon signed-rank, rank-biserial effect size)."""
import json
import random
import re
import string
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from scipy import stats

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from qlab.source import load_repo, load_file   # noqa: E402
from qlab.model import extract                 # noqa: E402
from qlab.analyze import analyze               # noqa: E402
from qlab.score import compliance              # noqa: E402
from qlab import design, complexity            # noqa: E402
from stats import wilson                       # noqa: E402

REPO = LAB / "corpus" / "messagepack-csharp"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40
SEED = 2026


def body_lines(u):
    """(open_brace_line, close_brace_line) 0-based, for block bodies with Allman braces."""
    if u.body.type != "block":
        return None
    a, b = u.body.start_point[0], u.body.end_point[0]
    return (a, b) if b - a >= 2 else None


def insert(lines, at, new):
    return lines[:at] + new + lines[at:], (at + 1, at + len(new))   # 1-based inserted range


def class_end(t):
    return t.end - 1          # 0-based line of the closing brace


# ---------------------------------------------------------------- operators
def op_dry(kind):
    def f(ctx, rng):
        u, sf = ctx["unit"], ctx["sf"]
        tgt = ctx["target"]
        src_lines = sf.raw.split("\n")[u.start - 1:u.end]
        text = "\n".join(src_lines)
        text = re.sub(r"\b" + re.escape(u.name) + r"\b", u.name + "Qcopy", text, count=1)
        if kind in ("t2", "t3"):
            locals_ = set(re.findall(r"\bvar\s+([a-z]\w*)", text)) | set(
                re.findall(r"\b(?:int|long|byte|string|bool|uint|ulong)\s+([a-z]\w*)\s*[=;,)]", text))
            for nm in sorted(locals_, key=len, reverse=True):
                text = re.sub(r"\b" + nm + r"\b", nm + "Renamed", text)
            text = re.sub(r"\b(\d+)\b", lambda m: str(int(m.group(1)) + 1), text)
        new = text.split("\n")
        if kind == "t3":
            ob = next(i for i, l in enumerate(new) if l.strip() == "{")
            mid = ob + max(1, (len(new) - ob) // 2)
            ind = " " * 12
            new = new[:ob + 1] + [ind + "this.QlabTrace(\"enter\");"] + new[ob + 1:mid] + \
                  [ind + "this.QlabTrace(\"middle\");"] + new[mid:]
        tl = tgt["sf"].raw.split("\n")
        tl, rng_ = insert(tl, class_end(tgt["type"]), new)
        return {tgt["sf"].path: "\n".join(tl)}, (tgt["sf"].path, rng_)
    return f


def op_nest(ctx, rng):
    u, sf = ctx["unit"], ctx["sf"]
    a, b = body_lines(u)
    L = sf.raw.split("\n")
    opens = [f"if (qlabA{i} && qlabB{i})" + " {" for i in range(4)]
    L2 = L[:a + 1] + opens + L[a + 1:b] + ["}}}}"] + L[b:]
    return {sf.path: "\n".join(L2)}, (sf.path, (u.start, u.end + 5))


def op_long(ctx, rng):
    u, sf = ctx["unit"], ctx["sf"]
    a, b = body_lines(u)
    L = sf.raw.split("\n")
    inner = L[a + 1:b]
    L2 = L[:b] + ["{"] + inner + ["}"] + L[b:]
    return {sf.path: "\n".join(L2)}, (sf.path, (u.start, u.end + len(inner) + 2))


def op_params(ctx, rng):
    u, sf = ctx["unit"], ctx["sf"]
    pl = u.node.child_by_field_name("parameters")
    row, col = pl.start_point
    L = sf.raw.split("\n")
    has = u.params > 0
    add = "int qa, int qb, int qc, int qd, int qe" + (", " if has else "")
    L[row] = L[row][:col + 1] + add + L[row][col + 1:]
    return {sf.path: "\n".join(L)}, (sf.path, (u.start, u.start + 1))


def op_short_name(ctx, rng):
    u, sf = ctx["unit"], ctx["sf"]
    L = sf.raw.split("\n")
    seg = "\n".join(L[u.start - 1:u.end])
    nm = ctx["local"]
    seg = re.sub(r"\b" + re.escape(nm) + r"\b", "qz", seg)
    L[u.start - 1:u.end] = seg.split("\n")
    return {sf.path: "\n".join(L)}, (sf.path, (ctx["local_line"], ctx["local_line"]))


def _ins_body(stmt):
    def f(ctx, rng):
        u, sf = ctx["unit"], ctx["sf"]
        a, _ = body_lines(u)
        L = sf.raw.split("\n")
        s = stmt(rng) if callable(stmt) else stmt
        L2, r = insert(L, a + 1, ["            " + x for x in s])
        return {sf.path: "\n".join(L2)}, (sf.path, r)
    return f


def op_catch(ctx, rng):
    u, sf = ctx["unit"], ctx["sf"]
    a, b = body_lines(u)
    L = sf.raw.split("\n")
    L2 = L[:a + 1] + ["            try", "            {"] + L[a + 1:b] + \
         ["            }", "            catch (Exception)", "            {", "            }"] + L[b:]
    return {sf.path: "\n".join(L2)}, (sf.path, (b + 4, b + 7))


def op_docs(ctx, rng):
    sf, line = ctx["sf"], ctx["member_line"]
    L = sf.raw.split("\n")
    i = line - 2
    while i >= 0 and (L[i].strip().startswith("///") or L[i].strip().startswith("[")):
        if L[i].strip().startswith("///"):
            L[i] = ""
        i -= 1
    return {sf.path: "\n".join(L)}, (sf.path, (line, line))


def _ins_class(lines):
    def f(ctx, rng):
        t, sf = ctx["type"], ctx["sf"]
        L = sf.raw.split("\n")
        L2, r = insert(L, class_end(t), ["        " + x for x in lines])
        return {sf.path: "\n".join(L2)}, (sf.path, r)
    return f


def _secret(rng):
    key = "AKIA" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(16))
    return [f'var qlabKey = "{key}";']


OPS = {
    # name: (practice, expected rule prefix, operator, unit filter, metamorphic check)
    "dry_type1": ("dry", "dry.type1", op_dry("t1"), "dry", None),
    "dry_type2": ("dry", "dry.type", op_dry("t2"), "dry", None),
    "dry_type3": ("dry", "dry.", op_dry("t3"), "dry", None),
    "kiss_nesting": ("simple_units", "kiss.complexity", op_nest, "block", ("cc", 8)),
    "unit_length": ("small_units", "size.unit_length", op_long, "medium", None),
    "parameters": ("small_interfaces", "size.parameters", op_params, "params", ("params", 5)),
    "short_name": ("naming", "naming.too_short", op_short_name, "local", None),
    "magic_number": ("magic_numbers", "magic.number", _ins_body(["var qlabLimit = 4093 * 37;"]), "block", None),
    "empty_catch": ("error_handling", "errors.empty_catch", op_catch, "block", None),
    "throw_ex": ("error_handling", "errors.throw_ex", _ins_body(["try { this.QlabWork(); } catch (InvalidOperationException qlabEx) { throw qlabEx; }"]), "block", None),
    "remove_docs": ("documentation", "docs.missing_xml_doc", op_docs, "documented", None),
    "dead_method": ("dead_code", "dead.unused_private", _ins_class(["private void QlabUnusedHelper()", "{", "}"]), "class", None),
    "public_field": ("encapsulation", "encap.public_mutable_field", _ins_class(["public int qlabExposed;"]), "class", None),
    "cohesion_split": ("cohesion", "srp.", _ins_class(["private int qlabIsolated;", "public void QlabIsolatedOp()", "{",
                                                       "    this.qlabIsolated++;", "}", "public int QlabIsolatedRead()", "{",
                                                       "    return this.qlabIsolated;", "}"]), "cohesive", ("lcom4", 1)),
    "insecure_deserializer": ("security", "sec.insecure_deserializer",
                              _ins_body(["var qlabFmt = new System.Runtime.Serialization.Formatters.Binary.BinaryFormatter();"]), "block", None),
    "hardcoded_secret": ("security", "secret.", _ins_body(_secret), "block", None),
    "lock_this": ("reliability", "rel.lock_this", _ins_body(["lock (this)", "{", "}"]), "block", None),
}


def build_contexts(files, units, types, rng):
    by_file = {f.path: f for f in files}
    cand = defaultdict(list)
    classes = [t for t in types if t.kind == "class" and t.end - t.start > 5]
    G = design.merge_partials(types)
    for u in units:
        sf = by_file[u.file]
        bl = body_lines(u)
        if u.kind not in ("method", "ctor") or bl is None:
            continue
        L = sf.raw.split("\n")
        if L[bl[0]].strip() != "{" or L[bl[1]].strip() != "}":
            continue
        cand["block"].append(dict(unit=u, sf=sf))
        if 8 <= u.sloc <= 40:
            cand["medium"].append(dict(unit=u, sf=sf))
        if u.kind == "method" and u.node.child_by_field_name("parameters") is not None and "=>" not in L[u.start - 1]:
            cand["params"].append(dict(unit=u, sf=sf))
        if u.sloc >= 15:
            cand["dry"].append(dict(unit=u, sf=sf))
        m = re.search(r"\bvar\s+([a-z][A-Za-z0-9]{3,})\s*=", "\n".join(L[u.start - 1:u.end]))
        if m:
            off = "\n".join(L[u.start - 1:u.end])[:m.start()].count("\n")
            cand["local"].append(dict(unit=u, sf=sf, local=m.group(1), local_line=u.start + off))
    for t in classes:
        cand["class"].append(dict(type=t, sf=by_file[t.file]))
        parts = G[t.qname]
        if len(parts) == 1:
            c = design.cohesion(parts)
            if c.lcom4 == 1 and c.methods >= 2:
                cand["cohesive"].append(dict(type=t, sf=by_file[t.file], lcom4=c.lcom4))
        for kind, name, node, mods, doc, line in t.members:
            if doc and "public" in mods and "public" in t.mods:
                cand["documented"].append(dict(sf=by_file[t.file], member_line=line, type=t))
    return cand


def run_one(job):
    op_name, idx, ctx_ser = job
    practice, rule, op, _, meta = OPS[op_name]
    rng = random.Random(SEED * 1000 + idx)
    files = {p: load_file(REPO, p) for p in ctx_ser["paths"]}
    # rebuild context objects from the freshly parsed files
    ctx = dict(ctx_ser)
    sf = files[ctx_ser["file"]]
    ctx["sf"] = sf
    ts, us = extract(sf)
    if "unit_start" in ctx_ser:
        ctx["unit"] = next(u for u in us if u.start == ctx_ser["unit_start"] and u.name == ctx_ser["unit_name"])
    if "type_start" in ctx_ser:
        ctx["type"] = next(t for t in ts if t.start == ctx_ser["type_start"])
    if "target_file" in ctx_ser:
        tsf = files[ctx_ser["target_file"]]
        tts, _ = extract(tsf)
        ctx["target"] = dict(sf=tsf, type=next(t for t in tts if t.start == ctx_ser["target_type_start"]))
    try:
        changes, (path, (r0, r1)) = op(ctx, rng)
    except Exception as e:
        return dict(op=op_name, idx=idx, error=f"operator: {e}")
    if practice in ("cohesion", "coupling"):
        r0 = r1 = ctx["type"].start
    before = analyze(REPO, files=list(files.values()))
    mfiles = [load_file(REPO, p, text=changes.get(p)) if p in changes else files[p] for p in files]
    after = analyze(REPO, files=mfiles)

    def hits(A, lo, hi):
        return [f for f in A.findings if f.rule.startswith(rule) and f.file == path and f.start <= hi and f.end >= lo]
    det = len(hits(after, r0, r1)) > 0
    # Is the violation large enough to be expected by the metric's own definition?
    expected = True
    if op_name.startswith("dry"):
        u0 = ctx["unit"]
        ntok = sum(1 for t in sf.tokens if u0.start <= t[2] <= u0.end)
        expected = ntok >= {"dry_type1": 100, "dry_type2": 50, "dry_type3": 50}[op_name]
    if op_name == "unit_length":
        ua = next((u for us_ in after.units.values() for u in us_ if u.name == ctx_ser["unit_name"]
                   and u.start == ctx_ser["unit_start"]), None)
        expected = ua is not None and ua.sloc > 15
    pre = len(hits(before, r0, r1)) > 0 if path not in changes else False
    other_before = sum(1 for f in before.findings if f.rule.startswith(rule))
    other_after = sum(1 for f in after.findings if f.rule.startswith(rule)) - len(hits(after, r0, r1))
    if op_name.startswith("dry"):   # the copied original is the expected clone partner, not a spurious finding
        u0 = ctx["unit"]
        other_after -= sum(1 for f in after.findings if f.rule.startswith(rule) and f.file == sf.path
                           and f.start <= u0.end and f.end >= u0.start)
    cb, ca = compliance(before, practice, B=1), compliance(after, practice, B=1)
    exact = None
    if meta:
        key, delta = meta
        if key in ("cc", "params"):
            ub = next(u for us_ in before.units.values() for u in us_ if u.name == ctx_ser["unit_name"] and u.start == ctx_ser["unit_start"])
            ua = next(u for us_ in after.units.values() for u in us_ if u.name == ctx_ser["unit_name"] and u.start == ctx_ser["unit_start"])
            exact = (getattr(ua, key) - getattr(ub, key)) == delta
            if key == "cc":
                exact = exact and (ua.nest - ub.nest) == 4
        elif key == "lcom4":
            qb = before.unit_evidence.get(("type", ctx["type"].qname), {}).get("lcom4")
            qa = after.unit_evidence.get(("type", ctx["type"].qname), {}).get("lcom4")
            exact = qb is not None and qa is not None and qa - qb == delta
    return dict(op=op_name, idx=idx, detected=det, expected=expected, preexisting=pre, spurious=max(0, other_after - other_before),
                c_before=None if cb is None else cb["point"], c_after=None if ca is None else ca["point"], exact=exact)


def serialise(op_name, ctx, cand, rng):
    d = {"file": ctx["sf"].path, "paths": [ctx["sf"].path]}
    if "unit" in ctx:
        d.update(unit_start=ctx["unit"].start, unit_name=ctx["unit"].name)
    if "type" in ctx:
        d.update(type_start=ctx["type"].start)
    for k in ("local", "local_line", "member_line"):
        if k in ctx:
            d[k] = ctx[k]
    if op_name.startswith("dry"):
        tgt = rng.choice([c for c in cand["class"] if c["sf"].path != ctx["sf"].path])
        d.update(target_file=tgt["sf"].path, target_type_start=tgt["type"].start)
        d["paths"].append(tgt["sf"].path)
    return d


def main():
    rng = random.Random(SEED)
    files = load_repo(REPO, kinds={"prod"})
    units, types = [], []
    for f in files:
        ts, us = extract(f)
        complexity.measure_units(f, us)
        types += ts; units += us
    cand = build_contexts(files, units, types, rng)
    jobs = []
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    for op_name, (practice, rule, op, filt, meta) in OPS.items():
        if only and op_name not in only:
            continue
        pool = cand[filt]
        sample = rng.sample(pool, min(N, len(pool)))
        for i, ctx in enumerate(sample):
            jobs.append((op_name, i, serialise(op_name, ctx, cand, rng)))
    with Pool(14) as p:
        results = p.map(run_one, jobs, chunksize=4)
    summary = {}
    prev = LAB / "out" / "experiments" / "e1_injection.json"
    if only and prev.exists():
        old = json.loads(prev.read_text())
        summary = {k: v for k, v in old["summary"].items() if k not in only}
        results = [r for r in old["raw"] if r["op"] not in only] + results
    for op_name, (practice, rule, *_ ) in OPS.items():
        if only and op_name not in only:
            continue
        rs = [r for r in results if r["op"] == op_name and "error" not in r]
        errs = [r for r in results if r["op"] == op_name and "error" in r]
        k = sum(r["detected"] for r in rs); n = len(rs)
        ex_rs = [r for r in rs if r.get("expected", True)]
        k_e, n_e = sum(r["detected"] for r in ex_rs), len(ex_rs)
        fp_unexpected = sum(r["detected"] for r in rs if not r.get("expected", True))
        cb = np.array([r["c_before"] for r in rs if r["c_before"] is not None and r["c_after"] is not None])
        ca = np.array([r["c_after"] for r in rs if r["c_before"] is not None and r["c_after"] is not None])
        d = cb - ca
        w = stats.wilcoxon(cb, ca, alternative="greater", zero_method="wilcox") if (d != 0).any() else None
        nz = d[d != 0]
        rbc = None
        if len(nz):
            r_ = stats.rankdata(np.abs(nz))
            rbc = float((r_[nz > 0].sum() - r_[nz < 0].sum()) / r_.sum())
        ex = [r["exact"] for r in rs if r["exact"] is not None]
        summary[op_name] = dict(practice=practice, n=n, detected=k, recall=k / n if n else None,
                                recall_ci=wilson(k, n), n_expected=n_e, recall_expected=k_e / n_e if n_e else None,
                                recall_expected_ci=wilson(k_e, n_e), detected_when_not_expected=fp_unexpected, spurious_total=int(sum(r["spurious"] for r in rs)),
                                compliance_drop_median=float(np.median(d)) if len(d) else None,
                                wilcoxon_p=None if w is None else float(w.pvalue), rank_biserial=rbc,
                                metamorphic_exact=(sum(ex), len(ex)) if ex else None, errors=len(errs),
                                error_examples=[e["error"] for e in errs[:2]])
    out = LAB / "out" / "experiments"
    out.mkdir(parents=True, exist_ok=True)
    (out / "e1_injection.json").write_text(json.dumps(dict(N=N, seed=SEED, summary=summary, raw=results), indent=1, default=str))
    print("written")
    for k, v in summary.items():
        if only and k not in only:
            continue
        print(k, json.dumps({kk: vv for kk, vv in v.items() if kk != "error_examples"}, default=str), v["error_examples"][:1])


if __name__ == "__main__":
    main()
