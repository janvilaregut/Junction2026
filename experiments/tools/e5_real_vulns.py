#!/usr/bin/env python3
"""E5: recall of the tool catalog on REAL MessagePack-CSharp vulnerabilities.

Ground truth = OSV advisories for the MessagePack NuGet packages. For each advisory the
vulnerable code locations are the lines that its fixing commit(s) changed under src/
(product .cs files, tests excluded), expressed in the coordinates of the fix's parent
commit (= last vulnerable code). Pure insertions are anchored at the insertion point.
The tools are then run on the parent snapshot and a finding "hits" an advisory when it
lies in a vulnerable file within +-5 lines of a vulnerable line.

Steps:
  python3 experiments/tools/e5_real_vulns.py prepare    # OSV + git -> ground truth, export snapshots
  (run run_tools.py + codeql_arm64.sh on each snapshot, then normalise.py)
  python3 experiments/tools/e5_real_vulns.py evaluate   # overlap, recall + Wilson CI, CWE gap
  python3 experiments/tools/e5_real_vulns.py deps       # OSV ground truth for Directory.Packages.props pins
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tarfile
import io
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
REPO = LAB / "corpus" / "messagepack-csharp"
WORK = LAB / "corpus" / "tools" / "e5"
OUT = LAB / "out" / "tools" / "e5"
TOL = 5
PACKAGES = ["MessagePack", "MessagePack.Annotations", "MessagePackAnalyzer", "MessagePack.UnityShims",
            "MessagePack.ReactiveProperty", "MessagePack.ImmutableCollection", "MessagePack.AspNetCoreMvcFormatter",
            "MessagePack.Generator", "MessagePack.MSBuild.Tasks", "MessagePack.LZ4", "MessagePack.Experimental",
            "MessagePack.SourceGenerator", "MessagePack.Unity"]

# advisory -> fixing commits on the v3 line, with the evidence used for the attribution.
# Merge commits are diffed against their first parent. All 2026 per-CWE commits share the parent
# 06ea2495 (last vulnerable v3 code before 3.1.7).
FIXES = {
    "GHSA-2f33-pr97-265q": (["f077798e"], "commit 'Default MVC input formatter to UntrustedData for CWE-1188'"),
    "GHSA-2x83-8g95-xh59": (["25a3493e"], "commit 'Limit untrusted ExpandoObject maps for CWE-407'"),
    "GHSA-382j-8mxh-c7x2": (["26d4e743", "46c6a0fe"], "advisory text = ReadDateTime stackalloc -> 'Reject invalid DateTime ext lengths for CWE-789'; "
                                                     "plus 'Fix CWE-190 map header length overflow' (CWE-190 listed only in this advisory)"),
    "GHSA-4qm4-8hg2-g2xm": (["8e599af0"], "merge 'secureHash_v3' (Use a collision-resistant hash algorithm), first v3 release 3.0.214-rc.1"),
    "GHSA-7q36-4xx7-xcxf": (["56fa8621"], "OSV reference commit 'Merge security fixes in for v2.1' (v2.1.90)"),
    "GHSA-cj9g-3mj2-g8vv": (["b3af7cf7", "66ad0894", "082ba7da"], "commits 'Guard JSON conversion depth', 'Avoid JSON separator recursion', "
                                                                   "'Guard typeless JSON depth' (CWE-674)"),
    "GHSA-cxmj-83gh-fp49": (["9b5783a7"], "commit 'Fix CWE-789 multidimensional array allocation validation'"),
    "GHSA-hv8m-jj95-wg3x": (["719e690a"], "commit 'Bound LZ4 input reads for CWE-125' (advisory: LZ4 out-of-bounds reads)"),
    "GHSA-q2h6-ghwm-5qm8": (["f96fcf05"], "commit 'Use secure lookup comparer for CWE-407' (InterfaceLookupFormatter)"),
    "GHSA-qhmf-xw27-6rqr": (["f093bdc1", "fb0fe9f0"], "commits 'Reject nested typeless blocklist bypass for CWE-502', "
                                                     "'Honor TypeFormatter options hooks for CWE-470'"),
    "GHSA-qhrr-8q5h-9q3h": (["95b63fca"], "OSV reference commit 'Merge v2 nested container allocation fix' (v3.1.9)"),
    "GHSA-v72x-2h86-7f8m": (["2b5a500a"], "commit 'Guard LZ4 decompression length for CWE-409'"),
    "GHSA-vh6j-jc39-fggf": (["b9cb6050"], "commit 'Use iteration for skipping msgpack structures for CWE-674' (Skip recursion)"),
    "GHSA-w567-gjr2-hm5j": (["0555f07c"], "commit 'Validate Unity blit lengths for CWE-789' (advisory CWE-770)"),
    "GHSA-wfr3-xj75-pfwh": (["b414e6df"], "commit 'Guard dynamic union depth for CWE-674'"),
}

SAST_TOOLS = ["semgrep-csharp-all", "semgrep-default-all", "semgrep-security-audit-all", "codeql-security",
              "codeql-all", "trivy-misconfig"]
SECRET_TOOLS = ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy-secret", "semgrep-secrets-all"]
QUALITY_SIGNALS = ["lizard", "cpd-100", "jscpd-100", "codeql-style"]


def git(*args) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True).stdout


def osv_query(name: str, version: str | None = None) -> list[dict]:
    body = {"package": {"name": name, "ecosystem": "NuGet"}}
    if version:
        body["version"] = version
    req = urllib.request.Request("https://api.osv.dev/v1/query", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r).get("vulns", [])


def is_product_cs(path: str) -> bool:
    p = path.lower()
    return (path.startswith("src/") and path.endswith(".cs") and "/tests/" not in p and ".tests" not in p
            and "/test/" not in p)


def changed_lines(parent: str, commit: str) -> dict[str, list[int]]:
    """Lines (parent coordinates) touched by parent..commit in product C# files under src/."""
    diff = git("diff", "-U0", "--no-color", parent, commit, "--", "src/")
    out, cur = defaultdict(set), None
    for line in diff.splitlines():
        if line.startswith("--- "):
            cur = line[6:] if line.startswith("--- a/") else None
        elif line.startswith("@@") and cur and is_product_cs(cur):
            m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            a, b = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
            if b > 0:
                out[cur].update(range(a, a + b))
            else:  # pure insertion after line a
                out[cur].update({max(a, 1), a + 1})
    return {f: sorted(v) for f, v in out.items()}


def export(rev: str, dest: Path):
    if dest.exists():
        return
    dest.mkdir(parents=True)
    data = subprocess.run(["git", "-C", str(REPO), "archive", rev], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        tf.extractall(dest, filter="data")


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    advisories = {}
    for p in PACKAGES:
        for v in osv_query(p):
            advisories.setdefault(v["id"], v)
    (OUT / "osv_messagepack_raw.json").write_text(json.dumps(advisories, indent=1))
    truth = []
    for aid, adv in sorted(advisories.items()):
        commits, evidence = FIXES.get(aid, ([], "no fix commit attributed"))
        loc, parents = defaultdict(set), set()
        for c in commits:
            parent = git("rev-parse", f"{c}^1").strip()
            parents.add(parent)
            for f, lines in changed_lines(parent, c).items():
                loc[f].update(lines)
        assert len(parents) <= 1, (aid, parents)
        parent = parents.pop() if parents else None
        ranges = [{"package": a["package"]["name"], "events": [e for r in a.get("ranges", []) for e in r.get("events", [])]}
                  for a in adv.get("affected", [])]
        fixed = sorted({e["fixed"] for r in ranges for e in r["events"] if "fixed" in e})
        truth.append({"id": aid, "aliases": adv.get("aliases", []), "summary": adv.get("summary", ""),
                      "cwes": (adv.get("database_specific") or {}).get("cwe_ids", []), "affected": ranges,
                      "fixed_versions": fixed, "fix_commits": commits, "attribution": evidence,
                      "vulnerable_snapshot": parent, "snapshot_describe": git("describe", "--tags", parent).strip() if parent else None,
                      "vulnerable_lines": {f: sorted(v) for f, v in sorted(loc.items())},
                      "n_vulnerable_lines": sum(len(v) for v in loc.values())})
        if parent:
            export(parent, WORK / parent[:8])
    (OUT / "vuln_ground_truth.json").write_text(json.dumps(truth, indent=2) + "\n")
    snaps = sorted({t["vulnerable_snapshot"][:8] for t in truth if t["vulnerable_snapshot"]})
    print(json.dumps({"advisories": len(truth), "snapshots": snaps}, indent=1))


def tool_views(f: dict) -> list[str]:
    """Map a normalised finding to the evaluation 'tools' it counts for."""
    t, c = f["tool"], f["category"]
    if t == "codeql":
        return ["codeql-all", "codeql-security" if c == "sast" else "codeql-style"]
    if t == "trivy":
        return ["trivy-misconfig"] if c == "sast" else ["trivy-secret"] if c == "secret" else []
    return [t]


def chance_baseline(truth, findings, views, draws: int = 300, seed: int = 7) -> dict:
    """Expected number of advisories 'hit' if each advisory's vulnerable-line pattern were moved to a random
    offset in a random product C# file of the same snapshot (Monte Carlo). Calibrates the +-TOL overlap rule:
    dense tools (CPD, CodeQL quality) hit large line sets by chance."""
    import random
    rng = random.Random(seed)
    exp = Counter()
    for t in truth:
        snap = (t["vulnerable_snapshot"] or "")[:8]
        fs = findings.get(snap) or []
        root = WORK / snap
        files = [p for p in root.rglob("*.cs") if is_product_cs(p.relative_to(root).as_posix())]
        lengths = {p.relative_to(root).as_posix(): sum(1 for _ in p.open(errors="replace")) for p in files}
        cover = defaultdict(lambda: defaultdict(set))  # view -> file -> covered lines
        for f in fs:
            for v in tool_views(f):
                if v in views and f["file"] in lengths:
                    cover[v][f["file"]].update(range(f["start_line"] - TOL, f["end_line"] + TOL + 1))
        pattern = [(f, ls) for f, ls in t["vulnerable_lines"].items()]
        if not pattern:
            continue
        names = list(lengths)
        for v in views:
            hits = 0
            for _ in range(draws):
                hit = False
                for _f, ls in pattern:
                    target = rng.choice(names)
                    span = max(ls) - min(ls)
                    off = rng.randint(1, max(1, lengths[target] - span)) - min(ls)
                    if any((ln + off) in cover[v].get(target, ()) for ln in ls):
                        hit = True
                        break
                hits += hit
            exp[v] += hits / draws
    return {v: round(exp[v], 2) for v in views}


def evaluate():
    from analyze import wilson  # noqa: E402 (same folder)
    truth = json.loads((OUT / "vuln_ground_truth.json").read_text())
    findings = {}
    for snap in {t["vulnerable_snapshot"][:8] for t in truth if t["vulnerable_snapshot"]}:
        p = OUT / snap / "normalised.jsonl"
        findings[snap] = [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else None
    all_views = SAST_TOOLS + SECRET_TOOLS + QUALITY_SIGNALS
    per_adv, hits = [], defaultdict(set)
    for t in truth:
        snap = (t["vulnerable_snapshot"] or "")[:8]
        fs = findings.get(snap) or []
        row = {"id": t["id"], "cwes": t["cwes"], "snapshot": t["snapshot_describe"], "files": list(t["vulnerable_lines"]),
               "n_vulnerable_lines": t["n_vulnerable_lines"], "hits": {}}
        for f in fs:
            lines = t["vulnerable_lines"].get(f["file"])
            if not lines:
                continue
            if any(f["start_line"] - TOL <= ln <= f["end_line"] + TOL for ln in lines):
                for v in tool_views(f):
                    row["hits"].setdefault(v, []).append(f"{f['rule_id']}@{f['file']}:{f['start_line']}")
                    hits[v].add(t["id"])
        per_adv.append(row)
    n = len([t for t in truth if t["n_vulnerable_lines"]])
    chance = chance_baseline(truth, findings, all_views)
    recall = {}
    for v in all_views:
        k = len(hits[v])
        recall[v] = {"hit": k, "n": n, "recall": round(k / n, 4) if n else None, "wilson95": wilson(k, n),
                     "expected_hits_by_chance": chance.get(v)}
    sec = set().union(*(hits[v] for v in SAST_TOOLS + SECRET_TOOLS))
    sec_strict = set().union(*(hits[v] for v in ["semgrep-csharp-all", "semgrep-default-all", "semgrep-security-audit-all",
                                                    "codeql-security", "trivy-misconfig"] + SECRET_TOOLS))
    qual = set().union(*(hits[v] for v in QUALITY_SIGNALS))
    cwe_all = Counter(c for t in truth for c in t["cwes"])
    cwe_hit = Counter(c for t in truth if t["id"] in sec_strict for c in t["cwes"])
    res = {"tolerance_lines": TOL, "advisories_with_locations": n, "per_tool": recall,
           "union_security_tools_incl_codeql_quality": {"hit": len(sec), "n": n, "wilson95": wilson(len(sec), n), "ids": sorted(sec)},
           "union_security_rules_only": {"hit": len(sec_strict), "n": n, "wilson95": wilson(len(sec_strict), n), "ids": sorted(sec_strict)},
           "union_quality_signals": {"hit": len(qual), "n": n, "wilson95": wilson(len(qual), n), "ids": sorted(qual)},
           "cwe_coverage": {c: {"advisories": cwe_all[c], "hit_by_security_rules": cwe_hit[c]} for c in sorted(cwe_all)},
           "per_advisory": per_adv,
           "snapshots_missing_findings": [s for s, v in findings.items() if v is None]}
    (OUT / "e5_results.json").write_text(json.dumps(res, indent=2) + "\n")
    print(json.dumps({k: v for k, v in res.items() if k not in ("per_advisory",)}, indent=1))


def deps():
    """OSV ground truth for every package pinned in the base Directory.Packages.props vs the dependency scanners."""
    props = LAB / "corpus" / "tools" / "refs" / "base" / "Directory.Packages.props"
    root = ET.parse(props).getroot()
    propvals = {el.tag: (el.text or "") for pg in root.iter("PropertyGroup") for el in pg}
    pins = []
    for el in root.iter():
        if el.tag in ("PackageVersion", "GlobalPackageReference"):
            ver = el.get("Version") or el.get("version") or ""
            ver = re.sub(r"\$\((\w+)\)", lambda m: propvals.get(m.group(1), m.group(0)), ver)
            pins.append((el.get("Include"), ver))
    pins = sorted(set(pins))
    gt = {}
    for name, ver in pins:
        vulns = osv_query(name, ver)
        gt[f"{name}@{ver}"] = sorted(v["id"] for v in vulns)
    base = [json.loads(l) for l in (LAB / "out" / "tools" / "base" / "normalised.jsonl").read_text().splitlines()]
    found = defaultdict(set)
    for f in base:
        if f["category"] == "dependency":
            found[f["tool"]].add(f"{f.get('package')}@{f.get('version')}")
    vulnerable = {k for k, v in gt.items() if v}
    res = {"pinned_packages": len(pins), "vulnerable_pins": sorted(vulnerable), "osv": gt,
           "per_tool": {t: {"reported_pins": sorted(found[t] & set(gt)), "vulnerable_pins_detected": len(found[t] & vulnerable),
                            "vulnerable_pins": len(vulnerable)} for t in ("trivy", "grype", "grype-dir", "osv-scanner")}}
    (OUT / "e5_dependency_ground_truth.json").write_text(json.dumps(res, indent=2) + "\n")
    print(json.dumps({k: v for k, v in res.items() if k != "osv"}, indent=1))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    {"prepare": prepare, "evaluate": evaluate, "deps": deps}[sys.argv[1]]()
