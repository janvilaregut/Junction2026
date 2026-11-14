#!/usr/bin/env python3
"""Render the markdown tables of research/15-tool-catalog-experiments.md from out/tools/summary.json.

    python3 experiments/tools/report_tables.py > /tmp/tables.md
"""
from __future__ import annotations

import json
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
S = json.loads((LAB / "out" / "tools" / "summary.json").read_text())


def pct(x):
    return "n/a" if x is None else f"{100 * x:.0f}%"


def ci(c):
    return f"[{100 * c[0]:.0f}, {100 * c[1]:.0f}]"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def e1():
    refs = ["base", "ju26-issue-2129", "ju26-issue-2234", "ju26-issue-2283", "ju26-issue-2297", "seeded"]
    e = S["e1_baseline"]
    tools = sorted({t for r in refs if r in e for t in e[r]["tools"]})
    rows = []
    for t in tools:
        row = [t]
        for r in refs:
            x = e.get(r, {}).get("tools", {}).get(t)
            if not x:
                row.append("–")
            elif not x.get("ok", True):
                row.append("FAILED")
            else:
                n = sum(x.get("findings", {}).values())
                row.append(f"{n}" + ("*" if x.get("note") else ""))
        rows.append(row)
    return table(["tool"] + refs, rows)


def e1_branches():
    rows = []
    for b, v in (S.get("e1_branch_deltas") or {}).items():
        for t, x in sorted(v["per_tool"].items()):
            if t not in v["tools_compared"]:
                continue
            if x["new_vs_base"] or x["resolved_vs_base"] or x["in_changed_files"]:
                rows.append([b, t, x["total"], x["new_vs_base"], x["resolved_vs_base"], x["in_changed_files"], x["changed_only_run"]])
    return table(["branch", "tool", "total", "new vs base", "gone vs base", "in changed files", "changed-only run"], rows)


def e2():
    r = S["e2_seeded"]["recall"]
    rows = []
    for t, cats in r["per_tool"].items():
        for c, v in cats.items():
            if "recall" not in v:
                rows.append([t, c, "not run", "", "", "", ""])
                continue
            rows.append([t, c, f"{v['detected']}/{v['seeded']}", pct(v["recall"]), ci(v["wilson95"]),
                         f"{v['detected_strict']}", v["noise_floor_base_findings"]])
    out = table(["tool", "category", "detected", "recall", "Wilson 95% CI", "strict", "base findings (noise floor)"], rows)
    urows = [[c, f"{v['detected']}/{v['seeded']}", pct(v["recall"]), ci(v["wilson95"]), ", ".join(v["never_detected"])]
             for c, v in r["union"].items()]
    out += "\n\nUnion of all tools per category:\n\n" + table(["category", "detected", "recall", "CI", "never detected"], urows)
    return out


def e2_subtypes():
    r = S["e2_seeded"]["recall"]["per_tool"]
    rows = []
    for t, cats in r.items():
        for c, v in cats.items():
            if "by_subtype" not in v:
                continue
            for st, x in v["by_subtype"].items():
                rows.append([c, st, t, f"{x['detected']}/{x['seeded']}"])
    rows.sort()
    return table(["category", "subtype", "tool", "detected"], rows)


def e3(which="base"):
    o = S["e3_overlap"][which]
    parts = []
    for cat, v in o.items():
        if not v["raw_total"]:
            parts.append(f"**{cat}**: no findings from {', '.join(v['tools'])}.")
            continue
        parts.append(f"**{cat}** — raw {v['raw_total']}, clusters after dedup {v['clusters_after_dedup']}, "
                     f"duplicate ratio {pct(v['duplicate_ratio'])}; clusters per tool {v['clusters_per_tool']}; "
                     f"clusters by #tools {v['clusters_by_n_tools']}")
        jr = [[k.replace("|", " vs "), "n/a" if j is None else f"{j:.3f}"] for k, j in v["jaccard"].items() if j is not None]
        if jr:
            parts.append(table(["pair", "Jaccard"], jr))
        cr = [[k.replace("|", " vs "), x["n1"], x["n2"], x["m"], x["lincoln_petersen"] if x["lincoln_petersen"] is not None else "∞ (m=0)",
               x["chapman"], f"[{x['chapman_ci95'][0]}, {x['chapman_ci95'][1]}]", x["est_undetected_chapman"]]
              for k, x in v["capture_recapture"].items()]
        if cr:
            parts.append(table(["pair", "n1", "n2", "m", "Lincoln–Petersen", "Chapman", "95% CI", "est. undetected"], cr))
    return "\n\n".join(parts)


def e2_cr():
    v = S["e2_seeded"]["capture_recapture_validation"]
    rows = []
    for cat, x in v.items():
        for k, p in x["pairs"].items():
            rows.append([cat, x["true_N"], k.replace("|", " vs "), p["n1"], p["n2"], p["m"],
                         p["lincoln_petersen"] if p["lincoln_petersen"] is not None else "∞", p["chapman"],
                         f"[{p['chapman_ci95'][0]}, {p['chapman_ci95'][1]}]"])
    return table(["category", "true N", "pair", "n1", "n2", "m", "LP", "Chapman", "95% CI"], rows)


def e4():
    rows = []
    for t, x in sorted(S["e4_cost"]["rows"].items(), key=lambda kv: kv[1]["wall_s_median"]):
        rows.append([t, x["category"], f"{x['wall_s_median']:.2f}", x["max_rss_mb"], x["findings_base"],
                     x["findings_per_kloc_base"], x["findings_seeded"]])
    return table(["tool", "category", "wall s (median)", "peak RSS MB", "findings base", "per KLOC", "findings seeded"], rows)


def e5():
    a = S["e5_real_vulnerabilities"]["advisories"]
    rows = [[t, f"{v['hit']}/{v['n']}", ci(v["wilson95"]), v["expected_hits_by_chance"]] for t, v in a["per_tool"].items()]
    out = table(["tool view", "advisories hit (±5 lines)", "Wilson 95% CI", "expected by chance"], rows)
    prow = [[p["id"], ", ".join(p["cwes"][:4]) + ("…" if len(p["cwes"]) > 4 else ""), p["snapshot"], p["n_vulnerable_lines"],
             ", ".join(sorted(p["hits"])) or "—"] for p in a["per_advisory"]]
    out += "\n\n" + table(["advisory", "CWE", "vulnerable snapshot", "vuln. lines", "tools with a finding within ±5 lines"], prow)
    return out


if __name__ == "__main__":
    for name, fn in [("E1", e1), ("E1 branches", e1_branches), ("E2", e2), ("E2 subtypes", e2_subtypes),
                     ("E2 CR validation", e2_cr), ("E3 base", lambda: e3("base")), ("E3 seeded", lambda: e3("seeded")),
                     ("E4", e4), ("E5", e5)]:
        print(f"\n<!-- {name} -->\n")
        print(fn())
