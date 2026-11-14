"""E6 — Deterministic review of the 4 agent-written PRs (no AI):
new-code quality, introduced findings, impact graph (changed symbols, public
contract delta, new conditions, reverse-BFS impact, statically reaching tests),
and the quality gate (teammate's naive rules vs the 3-state statistical gate),
with real test/coverage/analyzer evidence from out/dotnet/summary.json."""
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict, deque
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from qlab.analyze import analyze                 # noqa: E402
from qlab.source import load_repo                # noqa: E402
from qlab import design, hygiene, complexity     # noqa: E402
from qlab.score import score                     # noqa: E402
from qlab import gate as G                       # noqa: E402
from qlab.practices import TEAM_WEIGHTS          # noqa: E402

CLONE = LAB / "corpus" / "messagepack-csharp"
REFS = {"base": LAB / "corpus" / "dotnet" / "base"} | {b: LAB / "corpus" / "dotnet" / b for b in ("2129", "2234", "2283", "2297")}
DOTNET = json.loads((LAB / "out" / "dotnet" / "summary.json").read_text())


def added_lines(branch):
    out = subprocess.run(["git", "-C", str(CLONE), "diff", "-U0", f"origin/HEAD...origin/ju26-issue-{branch}", "--", "*.cs"],
                         capture_output=True, text=True).stdout
    res, cur = defaultdict(set), None
    for l in out.split("\n"):
        if l.startswith("+++ "):
            cur = l[6:] if l.startswith("+++ b/") else None
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", l)
        if m and cur:
            s, n = int(m.group(1)), int(m.group(2) or 1)
            res[cur] |= set(range(s, s + n))
    return res


def norm_msg(m):
    return re.sub(r"\d+", "#", m)


def fingerprints(A, files=None):
    return Counter((f.rule, f.file, norm_msg(f.message)) for f in A.findings if files is None or f.file in files)


def reverse_bfs(dg, start, depth=None):
    rev = defaultdict(set)
    for a, bs in dg.type_deps.items():
        for b in bs:
            rev[b].add(a)
    seen, q = set(start), deque((s, 0) for s in start)
    while q:
        v, d = q.popleft()
        if depth is not None and d >= depth:
            continue
        for w in rev.get(v, ()):
            if w not in seen:
                seen.add(w); q.append((w, d + 1))
    return seen - set(start)


def api_set(A):
    by_q = {t.qname: t for t in A.types}
    return {(kind, name) for _, _, kind, name, _ in hygiene.api_documentation(A.types, by_q)}


def main():
    analyses = {r: analyze(p) for r, p in REFS.items()}
    tests = {r: load_repo(p, kinds={"test"}) for r, p in REFS.items()}
    base = analyses["base"]
    base_fp = fingerprints(base)
    base_units = {(u.file, u.qname): u for us in base.units.values() for u in us}
    base_api = api_set(base)
    results = {}
    for b in ("2129", "2234", "2283", "2297"):
        A = analyses[b]
        add = added_lines(b)
        prod_files = {f.path for f in A.files}
        add_prod = {f: ls for f, ls in add.items() if f in prod_files}
        add_code = {f: ls & A.file(f).code_lines for f, ls in add_prod.items()}
        n_add = sum(len(v) for v in add_code.values())
        # ---- introduced findings on added lines
        fp = fingerprints(A)
        introduced = []
        for f in A.findings:
            ls = add_code.get(f.file)
            if not ls or not any(f.start <= l <= f.end for l in ls):
                continue
            key = (f.rule, f.file, norm_msg(f.message))
            if fp[key] > base_fp.get(key, 0):
                introduced.append(dict(rule=f.rule, file=f.file, line=f.start, severity=f.severity, message=f.message))
        # ---- new-code practice compliance (entities touching added lines)
        newcode = {}
        for e in A.entities:
            ls = add_code.get(e.file)
            if ls and any(e.start <= l <= e.end for l in ls):
                d = newcode.setdefault(e.practice, [0.0, 0.0, 0])
                d[0] += e.weight * e.v; d[1] += e.weight; d[2] += 1
        newcode = {k: dict(compliance=1 - v[0] / v[1] if v[1] else None, entities=v[2]) for k, v in newcode.items()}
        dup_new = sum(1 for e in A.entities if e.practice == "dry" and e.v >= 0.7 and e.start in add_code.get(e.file, ()))
        # ---- impact graph
        changed_units, new_units = [], []
        for us in A.units.values():
            for u in us:
                ls = add_code.get(u.file, set())
                if any(u.start <= l <= u.end for l in ls):
                    (new_units if (u.file, u.qname) not in base_units else changed_units).append(u)
        removed_units = [k for k in base_units if k[0] in add and k not in {(u.file, u.qname) for us in A.units.values() for u in us}]
        api = api_set(A)
        api_added = sorted(api - base_api); api_removed = sorted(base_api - api)
        new_conditions = []
        for u in changed_units + new_units:
            for kind, ln in complexity.decision_points(u.body):
                if ln in add_code.get(u.file, ()):
                    new_conditions.append(dict(unit=u.qname, kind=kind, line=ln))
        Gm = design.merge_partials(A.types)
        dg = design.dependency_graph(Gm)
        changed_types = {u.type_qname for u in changed_units + new_units}
        changed_types = {t for t in changed_types if t in dg.type_deps}
        imp1, imp2, impall = (reverse_bfs(dg, changed_types, 1), reverse_bfs(dg, changed_types, 2), reverse_bfs(dg, changed_types))
        names = {t.split(".")[-1] for t in changed_types} | {u.name for u in changed_units + new_units if u.kind == "method"}
        # static test impact analysis: a test reaches the change if it references a project type whose
        # forward dependency closure contains a changed type (direct name hits are the depth-0 case)
        closure_cache = {}

        def closure(t):
            if t not in closure_cache:
                seen, st = {t}, [t]
                while st:
                    v = st.pop()
                    for w in dg.type_deps.get(v, ()):
                        if w not in seen:
                            seen.add(w); st.append(w)
                closure_cache[t] = seen
            return closure_cache[t]
        reaching = []
        for tf in tests[b]:
            ids = {t[1] for t in tf.tokens if t[0] == "ID"}
            direct = names & ids
            via = [q for nm in ids for q in dg.simple_index.get(nm, ()) if closure(q) & changed_types]
            if direct or via:
                reaching.append(dict(file=tf.path, direct=sorted(direct)[:5], via=sorted(set(via))[:5], new_in_pr=tf.path in add))
        # ---- gate
        dn = DOTNET["refs"][b]
        pc = dn["patch_coverage"]
        conds_naive = dict(
            failing_tests=G.cond_count_zero(dn["tests"]["failed"]),
            new_high_findings=G.cond_count_zero(dn["analyzers"]["new_high_severity_count"] + sum(
                1 for i in introduced if i["rule"].startswith(("sec.", "secret.")))),
            patch_coverage=G.cond_proportion_at_least(pc["covered"], pc["new_lines"], 0.80, "naive"),
            new_duplication=G.cond_proportion_at_most(dup_new, n_add, 0.03, "naive"),
            analyzers_completed=G.PASS)
        conds_stat = dict(conds_naive)
        conds_stat["patch_coverage"] = G.cond_proportion_at_least(pc["covered"], pc["new_lines"], 0.80, "statistical")
        conds_stat["new_duplication"] = G.cond_proportion_at_most(dup_new, n_add, 0.03, "statistical")
        results[b] = dict(
            added_code_lines=n_add, added_lines_all=sum(len(v) for v in add.values()),
            introduced_findings=introduced, introduced_by_rule=dict(Counter(i["rule"] for i in introduced)),
            new_code_compliance=newcode, new_dup_lines=dup_new,
            impact=dict(changed_units=[u.qname for u in changed_units], new_units=[u.qname for u in new_units],
                        removed_units=[k[1] for k in removed_units], public_api_added=api_added, public_api_removed=api_removed,
                        new_conditions=new_conditions, changed_types=sorted(changed_types),
                        impacted_depth1=len(imp1), impacted_depth2=len(imp2), impacted_all=len(impall), types_total=len(dg.type_deps),
                        tests_statically_reaching=len(reaching), tests_reaching_new_in_pr=sum(r["new_in_pr"] for r in reaching),
                        reaching_examples=reaching[:6]),
            evidence=dict(tests=dn["tests"]["passed"], failed=dn["tests"]["failed"], patch_coverage=(pc["covered"], pc["new_lines"]),
                          patch_cov_wilson=(pc["wilson_low"], pc["wilson_high"]), analyzer_new=dn["analyzers"]["new_vs_base_count"]),
            gate_naive=G.gate(conds_naive), gate_statistical=G.gate(conds_stat))
        print(f"\n=== PR {b}: +{n_add} prod code lines; introduced {len(introduced)} findings {dict(Counter(i['rule'] for i in introduced).most_common(6))}")
        print(f"    changed units {len(changed_units)}, new units {len(new_units)}, public API +{len(api_added)}/-{len(api_removed)}, "
              f"new conditions {len(new_conditions)}, impacted types d1={len(imp1)} d2={len(imp2)} all={len(impall)}/{len(dg.type_deps)}, "
              f"tests reaching {len(reaching)} (direct {sum(bool(r['direct']) for r in reaching)}, new {sum(r['new_in_pr'] for r in reaching)})")
        print(f"    gate naive: {results[b]['gate_naive']['state']} {results[b]['gate_naive']['binding']} | statistical: "
              f"{results[b]['gate_statistical']['state']} {results[b]['gate_statistical']['binding']}")
    # repo-level scores & teammate Q per ref (tests dimension from real coverage)
    qtab = {}
    for r, A in analyses.items():
        S = score(A, B=200)
        dn = DOTNET["refs"][r]
        mt = dn["coverage"].get("merged_totals", {})
        cov = mt["lines-covered"] / mt["lines-valid"] if mt.get("lines-valid") else None
        tests_dim = 0.0 if dn["tests"]["failed"] else (G.coverage_utility(100 * cov) if cov is not None else None)
        dims = dict(S["dimensions"]); dims["tests"] = tests_dim
        w = TEAM_WEIGHTS
        qtab[r] = dict(dimensions=dims, Q_team=G.q_arithmetic(dims, w), Q_geometric=G.q_geometric(dims, w),
                       Q_roc_geometric=G.q_geometric(dims, G.roc_weights(["security", "reliability", "tests", "maintainability", "consistency"])),
                       practices={k: v["score"] for k, v in S["practices"].items()})
        print(r, json.dumps({k: (round(v, 2) if isinstance(v, float) else v) for k, v in qtab[r].items() if k != "practices"}))
    (LAB / "out" / "experiments" / "e6_pr_analysis.json").write_text(json.dumps(dict(prs=results, scores=qtab), indent=1, default=str))


if __name__ == "__main__":
    main()
