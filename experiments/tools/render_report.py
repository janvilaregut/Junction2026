#!/usr/bin/env python3
"""Render research/15-tool-catalog-experiments.md from report_template.txt + out/tools/summary.json.

    python3 experiments/tools/render_report.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAB = HERE.parents[1]
sys.path.insert(0, str(HERE))
import report_tables as rt  # noqa: E402

S = rt.S


def size() -> str:
    k = S["corpus"]["size_base"]
    return (f"{k['csharp_files']} C# files, {k['csharp_code_lines']:,} C# code lines; "
            f"{k['all_files']} files / {k['all_code_lines']:,} code lines in all languages")


def semgrep_sha() -> str:
    out = []
    for p in sorted((LAB / "corpus" / "tools" / "semgrep-rules").glob("p-*.yml")):
        out.append(f"`{p.stem}` {hashlib.sha256(p.read_bytes()).hexdigest()[:16]}")
    return ", ".join(out) or "n/a"


def complexity() -> str:
    c = S["e3_overlap"]["complexity_agreement_base"]
    f = json.loads((LAB / "out" / "tools" / "analysis.json").read_text()).get("e3_complexity_function_level_base", {})
    s = (f"scc reports complexity per file only, so lizard and scc can be compared only at file level. Over "
         f"{c['files_compared']} C# files, lizard's sum of (CCN−1) and scc's file Complexity correlate with Pearson "
         f"r = {c['pearson']} and Spearman ρ = {c['spearman']}. They match exactly in {100 * c['exact_match_share']:.0f}% of "
         f"files (median absolute difference {c['median_abs_diff']}; mean {c['mean_lizard']} vs {c['mean_scc']}). "
         f"{c['files_scc_only']} files have scc complexity but no lizard function.")
    if f.get("functions_matched"):
        s += (f" As a per-function reference, lizard was also compared with a tree-sitter McCabe count (the lab's own "
              f"`qlab.complexity.cyclomatic`) on {f['functions_matched']} matched functions: Pearson {f['pearson']}, "
              f"Spearman {f['spearman']}, identical CCN in {100 * f['exact_match_share']:.1f}% of functions (lizard higher in "
              f"{100 * f['lizard_higher_share']:.1f}%, lower in {100 * f['lizard_lower_share']:.1f}%). Above the CCN>15 "
              f"threshold, lizard flags {f['over_threshold_15']['lizard']} functions, tree-sitter "
              f"{f['over_threshold_15']['treesitter']}, and both {f['over_threshold_15']['both']}.")
    return s


def depgt() -> str:
    d = S["e5_real_vulnerabilities"]["dependency_ground_truth"]
    pt = d["per_tool"]
    return (f"the base `Directory.Packages.props` pins {d['pinned_packages']} distinct (package, version) pairs, counting "
            f"conditional item groups and the 4 `GlobalPackageReference`s. Querying OSV for each pair finds "
            f"{len(d['vulnerable_pins'])} vulnerable direct pin(s): {', '.join(d['vulnerable_pins'])}. Detected by trivy "
            f"{pt['trivy']['vulnerable_pins_detected']}/{pt['trivy']['vulnerable_pins']}, grype "
            f"{pt['grype']['vulnerable_pins_detected']}/{pt['grype']['vulnerable_pins']}, osv-scanner "
            f"{pt['osv-scanner']['vulnerable_pins_detected']}/{pt['osv-scanner']['vulnerable_pins']}. Transitive "
            f"dependencies (for example those of Microsoft.AspNetCore.Mvc.Core 2.2.5) are not covered: the repository has "
            f"no `packages.lock.json`, and resolving them needs a `dotnet restore`, which belongs to the build agent.")


def main():
    e4 = S["e4_cost"]
    fill = {
        "SIZE": size(), "SEMGREP_SHA": semgrep_sha(), "E1": rt.e1(), "E1B": rt.e1_branches(), "E2": rt.e2(),
        "E2SUB": rt.e2_subtypes(), "E3BASE": rt.e3("base"), "E3SEEDED": rt.e3("seeded"), "E2CR": rt.e2_cr(),
        "COMPLEXITY": complexity(), "E4TIMING": "Timing: " + e4["timing"],
        "KLOC": f"{e4['kloc_denominator']} ({e4['kloc_definition']})", "E4": rt.e4(), "E5": rt.e5(), "DEPGT": depgt(),
    }
    text = (HERE / "report_template.txt").read_text()
    for k, v in fill.items():
        text = text.replace("{{" + k + "}}", v)
    assert "{{" not in text, [l for l in text.splitlines() if "{{" in l]
    out = LAB / "research" / "15-tool-catalog-experiments.md"
    out.write_text(text)
    print("wrote", out)


if __name__ == "__main__":
    main()
