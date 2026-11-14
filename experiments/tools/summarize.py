#!/usr/bin/env python3
"""Assemble out/tools/summary.json from runs.json files, normalised findings, analysis.json,
the cost benchmark and the E5 results.

    python3 experiments/tools/summarize.py
"""
from __future__ import annotations

import json
import platform
import statistics
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
OUT = LAB / "out" / "tools"
REFS = ["base", "ju26-issue-2129", "ju26-issue-2234", "ju26-issue-2283", "ju26-issue-2297", "seeded"]
SHAS = {"base": "32258fdbee4bcd653c79f51b4376b5103c6f4d27", "ju26-issue-2129": "083afd994c1c9a994cb2cd5aa0b6ad805a621457",
        "ju26-issue-2234": "9007cee1163c4a274fd60c3cc20c21ae63622786", "ju26-issue-2283": "9df83c38409c8bfad0517aebffe48211eda4a5b4",
        "ju26-issue-2297": "a0aa5ab2de7f5a669d97e37184a89034c1de82b6"}

INSTALL = {
    "gitleaks": "brew install gitleaks", "betterleaks": "brew install betterleaks", "trufflehog": "brew install trufflehog",
    "detect-secrets": "pip install detect-secrets (venv corpus/tools/venv)", "trivy": "brew install trivy",
    "osv-scanner": "brew install osv-scanner", "syft": "brew install syft", "grype": "brew install grype",
    "semgrep": "brew install semgrep; rule packs fetched once from https://semgrep.dev/c/p/<pack> into corpus/tools/semgrep-rules",
    "pmd": "brew install pmd (CPD only for C#)", "jscpd": "npm install jscpd@4 (local, corpus/tools/npm)",
    "scc": "brew install scc", "lizard": "pre-installed in .venv (pip)", "scorecard": "brew install scorecard (--local mode)",
    "codeql": "brew install --cask codeql + codeql pack download codeql/csharp-queries; C# extractor run on an arm64 .NET 10 "
              "runtime through experiments/tools/codeql_arm64.sh (bundle ships x86-64 only, Rosetta 2 absent)",
}

CATEGORY_OF_TOOL = {
    "gitleaks": "secret", "betterleaks": "secret", "trufflehog": "secret", "detect-secrets": "secret",
    "trivy": "dependency+secret+misconfig", "osv-scanner": "dependency", "syft": "sbom", "grype": "dependency",
    "grype-dir": "dependency", "semgrep-csharp": "sast", "semgrep-security-audit": "sast", "semgrep-secrets": "secret",
    "semgrep-default": "sast", "semgrep-csharp-all": "sast", "semgrep-security-audit-all": "sast",
    "semgrep-secrets-all": "secret", "semgrep-default-all": "sast", "cpd-100": "duplication", "cpd-50": "duplication",
    "cpd-100-ignore-ids": "duplication", "jscpd-100": "duplication", "jscpd-50": "duplication", "scc": "size/complexity",
    "lizard": "complexity", "scorecard": "supply-chain", "codeql": "sast+quality",
}


def jload(p: Path, default=None):
    return json.loads(p.read_text()) if p.exists() else default


def normalised(ref: str):
    p = OUT / ref / "normalised.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def codeql_cost(ref: str) -> dict | None:
    out = {}
    for step in ("create", "analyze"):
        p = OUT / ref / f"codeql.{step}.log"
        if not p.exists():
            return None
        txt = p.read_text(errors="replace")
        import re
        m = re.search(r"([\d.]+) real", txt)
        r = re.search(r"(\d+)\s+maximum resident set size", txt)
        out[step] = {"wall_s": float(m.group(1)) if m else None, "max_rss_mb": round(int(r.group(1)) / 2**20, 1) if r else None}
    out["wall_s"] = round(sum(v["wall_s"] or 0 for v in out.values() if isinstance(v, dict)), 2)
    out["max_rss_mb"] = max(v["max_rss_mb"] or 0 for v in out.values() if isinstance(v, dict))
    out["ok"] = (OUT / ref / "codeql.sarif").exists()
    return out


def kloc_base() -> dict:
    scc = jload(OUT / "base" / "scc.json", [])
    cs = next((l for l in scc if l["Name"] == "C#"), {})
    return {"csharp_code_lines": cs.get("Code"), "csharp_files": cs.get("Count"),
            "all_code_lines": sum(l.get("Code", 0) for l in scc), "all_files": sum(l.get("Count", 0) for l in scc)}


def e1() -> dict:
    res = {}
    for ref in REFS + [f"{b}/changed-only" for b in REFS[1:5]]:
        runs = jload(OUT / ref / "runs.json", {})
        if not runs and not (OUT / ref).exists():
            continue
        fs = normalised(ref)
        by = defaultdict(Counter)
        for f in fs:
            by[f["tool"]][f["category"]] += 1
        tools = {}
        for t, r in runs.items():
            tools[t] = {"ok": r["ok"], "version": r["version"], "wall_s": r["wall_s"], "max_rss_mb": r["max_rss_mb"],
                        "exit_codes": [s["exit_code"] for s in r["steps"]], "findings": dict(by.get(t, {})),
                        "cmd": [s["cmd"] for s in r["steps"]]}
            if t == "osv-scanner" and any(s["exit_code"] == 128 for s in r["steps"]):
                tools[t]["note"] = "exit 128: no supported package manifest/lockfile found (zero coverage, not zero findings)"
        cq = codeql_cost(ref)
        if cq:
            tools["codeql"] = {**cq, "version": "CodeQL 2.27.4, codeql/csharp-queries 1.11.0, csharp-security-and-quality.qls",
                               "findings": dict(by.get("codeql", {}))}
        res[ref] = {"sha": SHAS.get(ref.split("/")[0]), "tools": tools, "total_findings": len(fs)}
    return res


def e4(kl: dict) -> dict:
    bench = jload(OUT / "_bench" / "bench.json")
    base_runs = jload(OUT / "base" / "runs.json", {})
    fs = normalised("base")
    seeded_fs = normalised("seeded")
    cnt = Counter(f["tool"] for f in fs)
    kloc = (kl["csharp_code_lines"] or 1) / 1000
    rows = {}
    for t, r in base_runs.items():
        wall = r["wall_s"]
        reps = None
        if bench and t in bench:
            reps = bench[t]
            wall = statistics.median(reps)
        rows[t] = {"category": CATEGORY_OF_TOOL.get(t), "wall_s_median": round(wall, 2), "wall_s_reps": reps,
                   "max_rss_mb": r["max_rss_mb"], "findings_base": cnt.get(t, 0),
                   "findings_per_kloc_base": round(cnt.get(t, 0) / kloc, 3),
                   "findings_seeded": sum(1 for f in seeded_fs if f["tool"] == t), "ok": r["ok"]}
    cq = codeql_cost("base")
    if cq:
        rows["codeql"] = {"category": "sast+quality", "wall_s_median": cq["wall_s"], "wall_s_reps": None,
                          "max_rss_mb": cq["max_rss_mb"], "findings_base": cnt.get("codeql", 0),
                          "findings_per_kloc_base": round(cnt.get("codeql", 0) / kloc, 3),
                          "findings_seeded": sum(1 for f in seeded_fs if f["tool"] == "codeql"), "ok": cq["ok"],
                          "breakdown": {k: v for k, v in cq.items() if k in ("create", "analyze")}}
    return {"kloc_denominator": round(kloc, 3), "kloc_definition": "C# code lines (scc) of the base tree / 1000",
            "timing": ("median of 3 sequential repetitions (machine shared with another lab agent; load average "
                       "4.7-8.4 during the benchmark)") if bench else "single run",
            "rows": rows}


def main():
    kl = kloc_base()
    analysis = jload(OUT / "analysis.json", {})
    truth = jload(OUT / "seeded" / "ground_truth.json", {})
    summary = {
        "generated": str(date.today()),
        "environment": {"machine": platform.machine(), "os": platform.platform(), "note": "Apple M5 Max, 64 GB, no Docker, no sudo"},
        "corpus": {"repo": "MessagePack-CSharp", "base_ref": "origin/HEAD", "refs": SHAS, "size_base": kl},
        "tools": {t: {"install": INSTALL.get(t)} for t in INSTALL},
        "incomplete": [
            {"tool": "SonarQube Community", "reason": "C# analysis requires SonarScanner for .NET wrapping an MSBuild build "
             "(dotnet build), which is out of scope for this agent (owned by the build/test agent); plain sonar-scanner "
             "does not analyse C#. Not attempted."},
            {"tool": "PMD rule engine (pmd check) for C#", "reason": "PMD 7.29 has no C# rule module (valid languages: apex, "
             "ecmascript, html, java, jsp, kotlin, modelica, plsql, pom, scala, swift, velocity, visualforce, wsdl, xml, xsl); "
             "only CPD supports C#."},
            {"tool": "OpenSSF Scorecard (full)", "reason": "Ran in --local mode only (11 of 18 checks). The API-based checks "
             "(Code-Review, Maintained, Branch-Protection, CI-Tests, Contributors, Signed-Releases, CII-Best-Practices, "
             "Webhooks) need a GitHub token; the user's token was deliberately not used."},
            {"tool": "osv-scanner (coverage)", "reason": "Runs (with --no-ignore; without it, it honours the enclosing lab "
             "repo's .gitignore and exits 128 'no package sources found'). It parses Directory.Packages.props but extracts 0 "
             "packages (no central-package-management support) and skips PackageReference items without a version, so on "
             "the real tree it only sees the Unity packages.config (no advisories): effectively no coverage of the real "
             "dependencies. Counted as no coverage, not as zero findings."},
            {"tool": "trufflehog verification", "reason": "Run with --no-verification on purpose (verification would send "
             "discovered credentials to third-party APIs)."},
            {"tool": "CodeQL (standard setup)", "reason": "The bundled C# extractor is x86-64-only and Rosetta 2 is not installed "
             "(installing it needs admin rights and a licence acceptance). CodeQL was run through a framework-dependent "
             "arm64 shim; results should be equivalent but the setup is non-standard."},
        ],
        "e1_baseline": e1(),
        "e1_branch_deltas": analysis.get("e1_branches"),
        "e2_seeded": {"ground_truth": str(OUT / "seeded" / "ground_truth.json"), "counts": truth.get("counts"),
                      "seed": truth.get("seed"), "recall": analysis.get("e2_recall"),
                      "capture_recapture_validation": analysis.get("e2_capture_recapture_validation")},
        "e3_overlap": {"base": analysis.get("e3_overlap_base"), "seeded": analysis.get("e3_overlap_seeded"),
                       "complexity_agreement_base": analysis.get("e3_complexity_agreement_base")},
        "e4_cost": e4(kl),
        "e5_real_vulnerabilities": {"advisories": jload(OUT / "e5" / "e5_results.json"),
                                    "dependency_ground_truth": jload(OUT / "e5" / "e5_dependency_ground_truth.json")},
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print("wrote", OUT / "summary.json")


if __name__ == "__main__":
    main()
