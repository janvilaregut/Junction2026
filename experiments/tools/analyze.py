#!/usr/bin/env python3
"""E1-E4 analysis: recall on the seeded tree, cross-tool dedup/overlap, capture-recapture,
complexity agreement and cost. Reads out/tools/<ref>/{normalised.jsonl,runs.json} and the
ground truth; writes out/tools/analysis.json (merged into summary.json by summarize.py).

    python3 experiments/tools/analyze.py
"""
from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
OUT = LAB / "out" / "tools"
REFS = LAB / "corpus" / "tools" / "refs"
BRANCHES = ["ju26-issue-2129", "ju26-issue-2234", "ju26-issue-2283", "ju26-issue-2297"]
TOL = 2  # line tolerance for matching and dedup

# Tools used for cross-tool overlap (one representative per tool family and category; the "-all"
# semgrep variants include tests/, so they cover the same files as every other tool).
OVERLAP_TOOLS = {
    "secret": ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets-all"],
    "dependency": ["trivy", "grype", "osv-scanner"],
    "sast": ["semgrep-default-all", "codeql", "trivy", "scorecard"],
    "duplication": ["cpd-100", "jscpd-100", "cpd-50", "jscpd-50"],
    "complexity": ["lizard"],
    "style": ["codeql"],
}
# Tool variants evaluated for recall per category.
RECALL_TOOLS = {
    "secret": ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets",
               "semgrep-secrets-all", "semgrep-default", "semgrep-default-all"],
    "dependency": ["trivy", "grype", "grype-dir", "osv-scanner"],
    "sast": ["semgrep-csharp", "semgrep-csharp-all", "semgrep-default", "semgrep-default-all",
             "semgrep-security-audit-all", "codeql"],
    "duplication": ["cpd-100", "cpd-50", "cpd-100-ignore-ids", "jscpd-100", "jscpd-50"],
}


# ---------------------------------------------------------------------------- statistics

def wilson(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (round(max(0.0, c - h), 4), round(min(1.0, c + h), 4))


def capture_recapture(n1: int, n2: int, m: int) -> dict:
    lp = (n1 * n2 / m) if m else None
    ch = (n1 + 1) * (n2 + 1) / (m + 1) - 1
    var = (n1 + 1) * (n2 + 1) * (n1 - m) * (n2 - m) / ((m + 1) ** 2 * (m + 2))
    sd = math.sqrt(var)
    union = n1 + n2 - m
    return {"n1": n1, "n2": n2, "m": m, "observed_union": union,
            "lincoln_petersen": round(lp, 2) if lp is not None else None,
            "chapman": round(ch, 2), "chapman_var": round(var, 2),
            "chapman_ci95": [round(max(union, ch - 1.96 * sd), 2), round(ch + 1.96 * sd, 2)],
            "est_undetected_chapman": round(ch - union, 2)}


def spearman(x, y):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(v):
            j = i
            while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    return pearson(ranks(x), ranks(y))


def pearson(x, y):
    n = len(x)
    if n < 3:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    if sx == 0 or sy == 0:
        return None
    return round(sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy), 4)


# ---------------------------------------------------------------------------- loading

def load(ref: str) -> list[dict]:
    p = OUT / ref / "normalised.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def runs(ref: str) -> dict:
    p = OUT / ref / "runs.json"
    return json.loads(p.read_text()) if p.exists() else {}


def overlaps(f, file, s, e, tol=TOL):
    return f["file"] == file and f["start_line"] - tol <= e and s <= f["end_line"] + tol


# ---------------------------------------------------------------------------- dedup

def cluster(findings: list[dict], tools: list[str], category: str):
    """Union-find clusters of findings from `tools` in `category` (file+lines±TOL, or package+advisory)."""
    fs = [f for f in findings if f["category"] == category and f["tool"] in tools]
    parent = list(range(len(fs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    if category == "dependency":
        by_key = defaultdict(list)
        for i, f in enumerate(fs):
            for adv in f.get("advisories") or [f["rule_id"]]:
                by_key[((f.get("package") or "").lower(), f.get("version"), adv)].append(i)
        for idx in by_key.values():
            for j in idx[1:]:
                union(idx[0], j)
    else:
        by_file = defaultdict(list)
        for i, f in enumerate(fs):
            by_file[f["file"]].append(i)
        for idx in by_file.values():
            idx.sort(key=lambda i: fs[i]["start_line"])
            for a in range(len(idx)):
                fa = fs[idx[a]]
                for b in range(a + 1, len(idx)):
                    fb = fs[idx[b]]
                    if fb["start_line"] - TOL > fa["end_line"] + TOL:
                        break
                    union(idx[a], idx[b])
            # second pass for long intervals that span beyond the sort window
            for a in range(len(idx)):
                for b in range(a + 1, len(idx)):
                    fa, fb = fs[idx[a]], fs[idx[b]]
                    if fa["start_line"] - TOL <= fb["end_line"] and fb["start_line"] <= fa["end_line"] + TOL:
                        union(idx[a], idx[b])
    clusters = defaultdict(list)
    for i, f in enumerate(fs):
        clusters[find(i)].append(f)
    return list(clusters.values())


def overlap_report(findings: list[dict]) -> dict:
    rep = {}
    for cat, tools in OVERLAP_TOOLS.items():
        present = sorted({f["tool"] for f in findings if f["category"] == cat and f["tool"] in tools})
        cl = cluster(findings, tools, cat)
        raw = Counter(f["tool"] for c in cl for f in c)
        per_tool_clusters = {t: {i for i, c in enumerate(cl) if any(f["tool"] == t for f in c)} for t in tools}
        total_raw = sum(raw.values())
        entry = {"tools": tools, "tools_with_findings": present,
                 "raw_findings": dict(raw), "raw_total": total_raw, "clusters_after_dedup": len(cl),
                 "duplicate_ratio": round(1 - len(cl) / total_raw, 4) if total_raw else None,
                 "clusters_per_tool": {t: len(v) for t, v in per_tool_clusters.items()},
                 "clusters_by_n_tools": dict(Counter(len({f['tool'] for f in c}) for c in cl)),
                 "jaccard": {}, "capture_recapture": {}}
        for a, b in combinations(tools, 2):
            A, B = per_tool_clusters[a], per_tool_clusters[b]
            u = len(A | B)
            entry["jaccard"][f"{a}|{b}"] = round(len(A & B) / u, 4) if u else None
            if A or B:
                entry["capture_recapture"][f"{a}|{b}"] = capture_recapture(len(A), len(B), len(A & B))
        rep[cat] = entry
    return rep


# ---------------------------------------------------------------------------- E2 recall

def recall_report(seeded: list[dict], base: list[dict], truth: dict, seeded_runs: dict) -> dict:
    items = truth["items"]
    base_fp = Counter(f["fingerprint"] for f in base)
    rep = {"per_tool": {}, "items": {}}
    matched_findings = set()
    for cat, tools in RECALL_TOOLS.items():
        cat_items = [i for i in items if i["category"] == cat]
        for tool in tools:
            if tool not in {f["tool"] for f in seeded} and not (seeded_runs.get(tool, {}).get("ok")):
                rep["per_tool"].setdefault(tool, {})[cat] = {"status": "not-run"}
                continue
            tf = [f for f in seeded if f["tool"] == tool]
            det, det_any, det_strict, by_sub = [], [], [], defaultdict(lambda: [0, 0])
            for it in cat_items:
                hit = hit_any = hit_strict = False
                for k, f in enumerate(tf):
                    if cat == "dependency":
                        ok = (f["category"] == "dependency" and (f.get("package") or "").lower() == it["package"].lower()
                              and (not f.get("version") or f["version"] == it["version"]))
                        if ok:
                            hit = hit_any = hit_strict = True
                            matched_findings.add((tool, f["fingerprint"], f["file"], f["start_line"]))
                        continue
                    if overlaps(f, it["file"], it["start_line"], it["end_line"]):
                        hit_any = True
                        if f["category"] == cat:
                            hit = True
                            matched_findings.add((tool, f["fingerprint"], f["file"], f["start_line"]))
                            if cat == "duplication":
                                partners = [g for g in tf if g.get("group") == f.get("group") and g is not f]
                                if any(overlaps(g, it["source_file"], it["source_start_line"], it["source_end_line"])
                                       for g in partners):
                                    hit_strict = True
                            else:
                                hit_strict = True
                det.append(hit)
                det_any.append(hit_any)
                det_strict.append(hit_strict)
                by_sub[it["subtype"]][0] += hit
                by_sub[it["subtype"]][1] += 1
                rep["items"].setdefault(it["id"], {"category": cat, "subtype": it["subtype"], "detected_by": []})
                if hit:
                    rep["items"][it["id"]]["detected_by"].append(tool)
            k, n = sum(det), len(det)
            noise = sum(1 for f in base if f["tool"] == tool and f["category"] == cat)
            extra = [f for f in tf if f["category"] == cat and (tool, f["fingerprint"], f["file"], f["start_line"]) not in matched_findings]
            new_extra = Counter(f["fingerprint"] for f in extra) - base_fp
            rep["per_tool"].setdefault(tool, {})[cat] = {
                "detected": k, "seeded": n, "recall": round(k / n, 4) if n else None, "wilson95": wilson(k, n),
                "detected_strict": sum(det_strict), "recall_strict": round(sum(det_strict) / n, 4) if n else None,
                "detected_any_category": sum(det_any),
                "by_subtype": {s: {"detected": v[0], "seeded": v[1], "recall": round(v[0] / v[1], 3)} for s, v in sorted(by_sub.items())},
                "noise_floor_base_findings": noise,
                "unmatched_new_findings_on_seeded": sum(new_extra.values()),
            }
    # union recall per category ("all tools of the category together")
    rep["union"] = {}
    for cat, tools in RECALL_TOOLS.items():
        ids = [i["id"] for i in items if i["category"] == cat]
        k = sum(1 for i in ids if rep["items"].get(i, {}).get("detected_by"))
        rep["union"][cat] = {"detected": k, "seeded": len(ids), "recall": round(k / len(ids), 4), "wilson95": wilson(k, len(ids)),
                             "never_detected": [i for i in ids if not rep["items"].get(i, {}).get("detected_by")]}
    return rep


def seeded_capture_recapture(seeded: list[dict], truth: dict) -> dict:
    """Validate the estimator: restrict to true-positive clusters on the seeded tree and compare N-hat to the truth."""
    out = {}
    for cat in ("secret", "sast", "duplication"):
        items = [i for i in truth["items"] if i["category"] == cat]
        tools = [t for t in OVERLAP_TOOLS[cat]]
        caught = {t: set() for t in tools}
        for it in items:
            for f in seeded:
                if f["tool"] in caught and f["category"] == cat and overlaps(f, it["file"], it["start_line"], it["end_line"]):
                    caught[f["tool"]].add(it["id"])
        pairs = {}
        for a, b in combinations(tools, 2):
            A, B = caught[a], caught[b]
            if A or B:
                pairs[f"{a}|{b}"] = capture_recapture(len(A), len(B), len(A & B))
        out[cat] = {"true_N": len(items), "caught_per_tool": {t: len(v) for t, v in caught.items()}, "pairs": pairs}
    return out


# ---------------------------------------------------------------------------- complexity agreement

def complexity_agreement(ref: str, root: Path) -> dict:
    liz = defaultdict(lambda: [0, 0, 0])  # file -> [sum(ccn-1), n functions, max ccn]
    with (OUT / ref / "lizard.csv").open(newline="", errors="replace") as fh:
        for row in csv.reader(fh):
            try:
                ccn = int(row[1])
            except (ValueError, IndexError):
                continue
            f = row[6].replace(str(root.resolve()) + "/", "")
            liz[f][0] += ccn - 1
            liz[f][1] += 1
            liz[f][2] = max(liz[f][2], ccn)
    scc = {}
    for lang in json.loads((OUT / ref / "scc.json").read_text()):
        if lang["Name"] != "C#":
            continue
        for f in lang["Files"]:
            scc[f["Location"].replace(str(root.resolve()) + "/", "")] = f["Complexity"]
    common = sorted(set(liz) & set(scc))
    x = [liz[f][0] for f in common]
    y = [scc[f] for f in common]
    diffs = [abs(a - b) for a, b in zip(x, y)]
    return {"files_compared": len(common), "files_scc_only": len(set(scc) - set(liz)),
            "metric_lizard": "sum over functions of (CCN-1) = decision points", "metric_scc": "per-file Complexity",
            "pearson": pearson(x, y), "spearman": spearman(x, y),
            "exact_match_share": round(sum(1 for d in diffs if d == 0) / len(diffs), 4) if diffs else None,
            "median_abs_diff": sorted(diffs)[len(diffs) // 2] if diffs else None,
            "mean_lizard": round(sum(x) / len(x), 2) if x else None, "mean_scc": round(sum(y) / len(y), 2) if y else None,
            "note": "scc reports complexity per file only (no per-function values), so per-function comparison is impossible; "
                    "this compares per-file decision-point totals."}


def complexity_function_level(ref: str, root: Path) -> dict:
    """Per-function agreement: lizard CCN vs a tree-sitter McCabe (qlab.complexity.cyclomatic, the lab's own
    definition), matched on (file, start line of the declaration)."""
    import sys
    sys.path.insert(0, str(LAB))
    try:
        import tree_sitter_c_sharp as tscs
        from tree_sitter import Language, Parser
        from qlab.complexity import cyclomatic
    except Exception as e:  # noqa: BLE001
        return {"status": f"skipped: {e}"}
    parser = Parser(Language(tscs.language()))
    liz = {}
    with (OUT / ref / "lizard.csv").open(newline="", errors="replace") as fh:
        for row in csv.reader(fh):
            try:
                liz[(row[6].replace(str(root.resolve()) + "/", ""), int(row[9]))] = int(row[1])
            except (ValueError, IndexError):
                continue
    files = sorted({f for f, _ in liz})
    pairs = []
    kinds = {"method_declaration", "constructor_declaration", "local_function_statement", "operator_declaration",
             "destructor_declaration", "conversion_operator_declaration"}
    for f in files:
        src = (root / f).read_bytes()
        tree = parser.parse(src)
        st = [tree.root_node]
        while st:
            n = st.pop()
            st.extend(n.children)
            if n.type in kinds:
                body = n.child_by_field_name("body")
                if body is None:
                    continue
                name = n.child_by_field_name("name")
                line = (name or n).start_point[0] + 1
                for cand in (line, n.start_point[0] + 1):
                    if (f, cand) in liz:
                        pairs.append((liz[(f, cand)], cyclomatic(body)))
                        break
    if not pairs:
        return {"status": "no matches"}
    x, y = [a for a, _ in pairs], [b for _, b in pairs]
    d = [a - b for a, b in pairs]
    return {"functions_matched": len(pairs), "functions_lizard": len(liz), "pearson": pearson(x, y), "spearman": spearman(x, y),
            "exact_match_share": round(sum(1 for v in d if v == 0) / len(d), 4),
            "lizard_higher_share": round(sum(1 for v in d if v > 0) / len(d), 4),
            "lizard_lower_share": round(sum(1 for v in d if v < 0) / len(d), 4),
            "over_threshold_15": {"lizard": sum(1 for v in x if v > 15), "treesitter": sum(1 for v in y if v > 15),
                                  "both": sum(1 for a, b in pairs if a > 15 and b > 15)}}


# ---------------------------------------------------------------------------- E1 branches

def branch_report(base: list[dict]) -> dict:
    rep = {}
    base_fp = Counter((f["tool"], f["fingerprint"]) for f in base)
    for b in BRANCHES:
        fs = load(b)
        if not fs:
            continue
        changed = set((REFS / f"changed-{b}.txt").read_text().split())

        def ran(ref):
            r = set(runs(ref))
            if (OUT / ref / "codeql.sarif").exists():
                r.add("codeql")
            if (OUT / ref / "scorecard.json").exists():
                r.add("scorecard")
            return r
        common = ran("base") & ran(b)
        fpc = Counter((f["tool"], f["fingerprint"]) for f in fs if f["tool"] in common)
        bfp = Counter({k: v for k, v in base_fp.items() if k[0] in common})
        new = fpc - bfp
        gone = bfp - fpc
        per_tool = defaultdict(lambda: {"total": 0, "new_vs_base": 0, "resolved_vs_base": 0, "in_changed_files": 0,
                                        "changed_only_run": 0})
        for f in fs:
            per_tool[f["tool"]]["total"] += 1
            per_tool[f["tool"]]["in_changed_files"] += f["file"] in changed
        for (t, _), n in new.items():
            per_tool[t]["new_vs_base"] += n
        for (t, _), n in gone.items():
            per_tool[t]["resolved_vs_base"] += n
        for f in load(f"{b}/changed-only"):
            per_tool[f["tool"]]["changed_only_run"] += 1
        new_examples = [dict(tool=f["tool"], rule=f["rule_id"], file=f["file"], line=f["start_line"], cat=f["category"])
                        for f in fs if (f["tool"], f["fingerprint"]) in new and f["tool"] in
                        ("codeql", "semgrep-default-all", "semgrep-csharp-all", "gitleaks", "trufflehog", "detect-secrets",
                         "lizard", "cpd-100", "jscpd-100", "trivy")][:40]
        rep[b] = {"changed_files": len(changed), "tools_compared": sorted(common), "per_tool": dict(per_tool),
                  "new_examples": new_examples}
    return rep


def main():
    base, seeded = load("base"), load("seeded")
    truth = json.loads((OUT / "seeded" / "ground_truth.json").read_text())
    res = {
        "e2_recall": recall_report(seeded, base, truth, runs("seeded")),
        "e2_capture_recapture_validation": seeded_capture_recapture(seeded, truth),
        "e3_overlap_base": overlap_report(base),
        "e3_overlap_seeded": overlap_report(seeded),
        "e3_complexity_agreement_base": complexity_agreement("base", REFS / "base"),
        "e3_complexity_function_level_base": complexity_function_level("base", REFS / "base"),
        "e1_branches": branch_report(base),
    }
    (OUT / "analysis.json").write_text(json.dumps(res, indent=2) + "\n")
    r = res["e2_recall"]["per_tool"]
    for tool, cats in r.items():
        for cat, v in cats.items():
            if "recall" in v:
                print(f"{tool:28s} {cat:12s} {v['detected']:3d}/{v['seeded']:<3d} recall={v['recall']:.2f} "
                      f"CI={v['wilson95']} strict={v['detected_strict']} noise={v['noise_floor_base_findings']}")
    print(json.dumps(res["e2_recall"]["union"], indent=1))


if __name__ == "__main__":
    main()
