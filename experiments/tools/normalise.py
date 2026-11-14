#!/usr/bin/env python3
"""E3: convert native tool outputs into one finding schema.

Schema (one JSON object per finding):
    tool, rule_id, category (secret|dependency|sast|duplication|complexity|style),
    cwe, severity (critical|high|medium|low|info), file, start_line, end_line,
    message, fingerprint  [+ package, version, advisories for dependency findings,
                             + group for duplication findings]

`file` is always relative to the scanned root, with forward slashes.
`fingerprint` is line-insensitive (tool|rule|file|normalised message|package|version), so it
can be used to diff findings between two revisions of the same file.

Usage:
    python3 experiments/tools/normalise.py out/tools/base --root corpus/tools/refs/base
writes out/tools/base/normalised.jsonl and prints per-tool counts.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

LIZARD_CCN_THRESHOLD = 15  # lizard's own default warning threshold (-C 15)

TOOL_OF_FILE = {  # native file -> (tool name, parser)
    "gitleaks.sarif": "gitleaks",
    "betterleaks.sarif": "betterleaks",
    "trufflehog.jsonl": "trufflehog",
    "detect-secrets.json": "detect-secrets",
    "trivy.json": "trivy",
    "osv-scanner.json": "osv-scanner",
    "grype.json": "grype",
    "grype-dir.json": "grype-dir",
    "semgrep-csharp.sarif": "semgrep-csharp",
    "semgrep-security-audit.sarif": "semgrep-security-audit",
    "semgrep-secrets.sarif": "semgrep-secrets",
    "semgrep-default.sarif": "semgrep-default",
    "semgrep-csharp-all.sarif": "semgrep-csharp-all",
    "semgrep-security-audit-all.sarif": "semgrep-security-audit-all",
    "semgrep-secrets-all.sarif": "semgrep-secrets-all",
    "semgrep-default-all.sarif": "semgrep-default-all",
    "cpd-100.csv": "cpd-100",
    "cpd-50.csv": "cpd-50",
    "cpd-100-ignore-ids.xml.gz": "cpd-100-ignore-ids",
    "jscpd-100/jscpd-report.json": "jscpd-100",
    "jscpd-50/jscpd-report.json": "jscpd-50",
    "lizard.csv": "lizard",
    "codeql.sarif": "codeql",
    "scorecard.json": "scorecard",
}

SEV_ORDER = ["info", "low", "medium", "high", "critical"]


def rel(path: str, root: str) -> str:
    p = path.replace("\\", "/")
    p = re.sub(r"^file://", "", p)
    for r in (root.rstrip("/") + "/", root.rstrip("/").lstrip("/") + "/"):
        if r and p.startswith(r):
            p = p[len(r):]
    p = re.sub(r"^(\./)+", "", p)
    return p.lstrip("/")


def sev_from_text(s: str | None) -> str:
    s = (s or "").lower()
    return {"critical": "critical", "high": "high", "error": "high", "medium": "medium", "moderate": "medium",
            "warning": "medium", "low": "low", "note": "low", "negligible": "info", "unknown": "info",
            "info": "info", "none": "info"}.get(s, "info")


def sev_from_cvss(x) -> str | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return "critical" if v >= 9 else "high" if v >= 7 else "medium" if v >= 4 else "low" if v > 0 else "info"


def cwe_of(tags) -> str | None:
    for t in tags or []:
        m = re.search(r"cwe[-/]?0*(\d+)", str(t), re.I)
        if m:
            return f"CWE-{int(m.group(1))}"
    return None


def fp(*parts) -> str:
    norm = [re.sub(r"\s+", " ", re.sub(r"\d+", "#", str(p))) if i == 3 else str(p) for i, p in enumerate(parts)]
    return hashlib.sha1("|".join(norm).encode()).hexdigest()[:16]


def mk(tool, rule, cat, cwe, sev, file, s, e, msg, **extra):
    s = int(s or 0)
    e = int(e or s)
    d = {"tool": tool, "rule_id": str(rule), "category": cat, "cwe": cwe, "severity": sev, "file": file,
         "start_line": s, "end_line": max(e, s), "message": (msg or "")[:300]}
    d.update(extra)
    d["fingerprint"] = fp(tool, rule, file, d["message"], extra.get("package", ""), extra.get("version", ""))
    return d


# ---------------------------------------------------------------------------- parsers

def parse_sarif(path: Path, tool: str, root: str):
    data = json.loads(path.read_text())
    out = []
    for run in data.get("runs", []):
        rules = {}
        for r in run.get("tool", {}).get("driver", {}).get("rules", []) or []:
            rules[r.get("id")] = r
        for res in run.get("results", []) or []:
            rid = res.get("ruleId") or (res.get("rule") or {}).get("id")
            rule = rules.get(rid, {})
            props = rule.get("properties", {}) or {}
            tags = props.get("tags", []) or []
            cwe = cwe_of(tags) or cwe_of([json.dumps(props)])
            level = res.get("level") or (rule.get("defaultConfiguration") or {}).get("level")
            sev = sev_from_cvss(props.get("security-severity")) or sev_from_text(level)
            if tool.startswith("semgrep"):
                cat = "secret" if ("secrets" in tool or ".secrets." in str(rid)) else "sast"
            elif tool == "codeql":
                cat = "sast" if "security" in tags else "style"
            else:
                cat = "secret"
                sev = "high"
            locs = res.get("locations") or []
            if not locs:
                continue
            pl = locs[0].get("physicalLocation", {})
            uri = pl.get("artifactLocation", {}).get("uri", "")
            reg = pl.get("region", {}) or {}
            s = reg.get("startLine", 0)
            e = reg.get("endLine", s)
            msg = (res.get("message") or {}).get("text", "")
            out.append(mk(tool, rid, cat, cwe, sev, rel(uri, root), s, e, msg))
    return out


def parse_trufflehog(path: Path, tool: str, root: str):
    out = []
    for line in path.read_text().splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        fsm = (d.get("SourceMetadata") or {}).get("Data", {}).get("Filesystem", {})
        f, ln = fsm.get("file", ""), fsm.get("line", 0)
        out.append(mk(tool, d.get("DetectorName"), "secret", "CWE-798", "high", rel(f, root), ln, ln,
                      f"{d.get('DetectorName')} {d.get('DecoderName', '')} verified={d.get('Verified')}"))
    return out


def parse_detect_secrets(path: Path, tool: str, root: str):
    d = json.loads(path.read_text())
    out = []
    for f, items in (d.get("results") or {}).items():
        for it in items:
            out.append(mk(tool, it.get("type"), "secret", "CWE-798", "high", rel(f, root), it.get("line_number"),
                          it.get("line_number"), it.get("type")))
    return out


def parse_trivy(path: Path, tool: str, root: str):
    d = json.loads(path.read_text())
    out = []
    for r in d.get("Results", []) or []:
        tgt = rel(r.get("Target", ""), root)
        for v in r.get("Vulnerabilities") or []:
            locs = v.get("Locations") or [{}]
            ids = {v.get("VulnerabilityID")} | set(v.get("VendorIDs") or [])
            out.append(mk(tool, v.get("VulnerabilityID"), "dependency", cwe_of(v.get("CweIDs")), sev_from_text(v.get("Severity")),
                          tgt, locs[0].get("StartLine", 0), locs[0].get("EndLine", 0),
                          f"{v.get('PkgName')} {v.get('InstalledVersion')} {v.get('Title', '')}",
                          package=v.get("PkgName"), version=v.get("InstalledVersion"), advisories=sorted(i for i in ids if i)))
        for s in r.get("Secrets") or []:
            out.append(mk(tool, s.get("RuleID"), "secret", "CWE-798", sev_from_text(s.get("Severity")), tgt,
                          s.get("StartLine"), s.get("EndLine"), s.get("Title")))
        for m in r.get("Misconfigurations") or []:
            cm = m.get("CauseMetadata") or {}
            out.append(mk(tool, m.get("ID"), "sast", None, sev_from_text(m.get("Severity")), tgt,
                          cm.get("StartLine", 0), cm.get("EndLine", 0), m.get("Title"), subcategory="misconfig"))
    return out


def parse_osv(path: Path, tool: str, root: str):
    if not path.exists() or path.stat().st_size == 0:
        return []
    d = json.loads(path.read_text())
    out = []
    for res in d.get("results", []) or []:
        src = rel((res.get("source") or {}).get("path", ""), root)
        for p in res.get("packages", []) or []:
            pk = p.get("package", {})
            for v in p.get("vulnerabilities", []) or []:
                ids = sorted({v.get("id"), *(v.get("aliases") or [])} - {None})
                sev = sev_from_text((v.get("database_specific") or {}).get("severity"))
                out.append(mk(tool, v.get("id"), "dependency", cwe_of((v.get("database_specific") or {}).get("cwe_ids")), sev,
                              src, 0, 0, f"{pk.get('name')} {pk.get('version')} {v.get('summary', '')}",
                              package=pk.get("name"), version=pk.get("version"), advisories=ids))
    return out


def parse_grype(path: Path, tool: str, root: str):
    d = json.loads(path.read_text())
    out = []
    for m in d.get("matches", []) or []:
        v, a = m.get("vulnerability", {}), m.get("artifact", {})
        ids = sorted({v.get("id"), *[r.get("id") for r in m.get("relatedVulnerabilities", []) or []]} - {None})
        locs = a.get("locations") or [{}]
        cvss = max([c.get("metrics", {}).get("baseScore", 0) for c in v.get("cvss", []) or []] or [0])
        out.append(mk(tool, v.get("id"), "dependency", None, sev_from_text(v.get("severity")) or sev_from_cvss(cvss),
                      rel(locs[0].get("path", ""), root), 0, 0, f"{a.get('name')} {a.get('version')} {v.get('description', '')[:120]}",
                      package=a.get("name"), version=a.get("version"), advisories=ids))
    return out


def parse_cpd_csv(path: Path, tool: str, root: str):
    out = []
    with path.open(newline="") as fh:
        rows = list(csv.reader(fh))
    for gi, row in enumerate(rows[1:], 1):
        if len(row) < 5:
            continue
        lines, tokens, occ = int(row[0]), int(row[1]), int(row[2])
        locs = [(int(row[3 + 2 * k]), row[4 + 2 * k]) for k in range(occ)]
        for ln, f in locs:
            out.append(mk(tool, f"CPD-{tokens >= 100 and '100' or '50'}", "duplication", None, "low", rel(f, root), ln,
                          ln + lines - 1, f"{lines} duplicated lines ({tokens} tokens) in {occ} places", group=f"{tool}#{gi}",
                          tokens=tokens))
    return out


def parse_cpd_xml(path: Path, tool: str, root: str):
    import xml.etree.ElementTree as ET
    out = []
    raw = gzip.open(path).read() if path.suffix == ".gz" else path.read_bytes()
    tree = ET.fromstring(raw)
    ns = {"c": tree.tag.split("}")[0].strip("{")} if tree.tag.startswith("{") else {}
    dups = tree.findall("c:duplication", ns) if ns else tree.findall("duplication")
    for gi, dup in enumerate(dups, 1):
        lines, tokens = int(dup.get("lines")), int(dup.get("tokens"))
        for f in (dup.findall("c:file", ns) if ns else dup.findall("file")):
            s = int(f.get("line"))
            e = int(f.get("endline") or (s + lines - 1))
            out.append(mk(tool, "CPD", "duplication", None, "low", rel(f.get("path"), root), s, e,
                          f"{lines} duplicated lines ({tokens} tokens)", group=f"{tool}#{gi}", tokens=tokens))
    return out


def parse_jscpd(path: Path, tool: str, root: str):
    d = json.loads(path.read_text())
    out = []
    for gi, dup in enumerate(d.get("duplicates", []) or [], 1):
        for side in ("firstFile", "secondFile"):
            f = dup[side]
            out.append(mk(tool, "jscpd-clone", "duplication", None, "low", rel(f["name"], root), f["start"], f["end"],
                          f"{dup.get('lines')} duplicated lines ({dup.get('tokens')} tokens)", group=f"{tool}#{gi}",
                          tokens=dup.get("tokens")))
    return out


def lizard_functions(path: Path, root: str):
    fns = []
    with path.open(newline="", errors="replace") as fh:
        for row in csv.reader(fh):
            if len(row) < 11:
                continue
            try:
                nloc, ccn, tok, par, length = (int(x) for x in row[:5])
            except ValueError:
                continue
            fns.append({"file": rel(row[6], root), "name": row[7], "long_name": row[8], "start": int(row[9]),
                        "end": int(row[10]), "nloc": nloc, "ccn": ccn, "tokens": tok, "params": par})
    return fns


def parse_lizard(path: Path, tool: str, root: str):
    out = []
    for f in lizard_functions(path, root):
        if f["ccn"] > LIZARD_CCN_THRESHOLD:
            out.append(mk(tool, f"CCN>{LIZARD_CCN_THRESHOLD}", "complexity", None,
                          "medium" if f["ccn"] > 25 else "low", f["file"], f["start"], f["end"],
                          f"{f['name']} has cyclomatic complexity {f['ccn']}", ccn=f["ccn"]))
    return out


def parse_scorecard(path: Path, tool: str, root: str):
    """Scorecard --local: one finding per 'Warn:' detail that names a file (supply-chain hygiene -> sast)."""
    d = json.loads(path.read_text())
    out = []
    for c in d.get("checks", []) or []:
        for det in c.get("details") or []:
            if not det.startswith("Warn:"):
                continue
            m = re.search(r"([\w./-]+\.[\w]+):(\d+)", det) or re.search(r"([\w./-]+\.(?:dll|exe|jar|so|dylib))", det)
            if not m:
                continue
            ln = int(m.group(2)) if m.lastindex and m.lastindex >= 2 else 0
            out.append(mk(tool, c["name"], "sast", None, "low", rel(m.group(1), root), ln, ln, det[:200],
                          subcategory="supply-chain"))
    return out


PARSERS = {
    "gitleaks": parse_sarif, "betterleaks": parse_sarif, "trufflehog": parse_trufflehog,
    "detect-secrets": parse_detect_secrets, "trivy": parse_trivy, "osv-scanner": parse_osv, "grype": parse_grype,
    "grype-dir": parse_grype, "cpd-100": parse_cpd_csv, "cpd-50": parse_cpd_csv, "cpd-100-ignore-ids": parse_cpd_xml,
    "jscpd-100": parse_jscpd, "jscpd-50": parse_jscpd, "lizard": parse_lizard, "codeql": parse_sarif,
    "scorecard": parse_scorecard,
}


def normalise_dir(outdir: Path, root: str) -> tuple[list[dict], dict]:
    """Return (findings, status) where status[tool] = 'ok' | 'missing' | 'failed: ...'."""
    runs = json.loads((outdir / "runs.json").read_text()) if (outdir / "runs.json").exists() else {}
    findings, status = [], {}
    for fname, tool in TOOL_OF_FILE.items():
        p = outdir / fname
        run = runs.get(tool if tool != "codeql" else "codeql", {})
        if not p.exists():
            status[tool] = "missing"
            continue
        if run and not run.get("ok", True):
            status[tool] = "failed"
            continue
        parser = PARSERS.get(tool) or parse_sarif
        try:
            fs = parser(p, tool, root)
        except Exception as e:  # noqa: BLE001
            status[tool] = f"parse-error: {e}"
            continue
        status[tool] = "ok"
        findings.extend(fs)
    return findings, status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--root", required=True, help="scanned root (absolute or as passed to the tools)")
    args = ap.parse_args()
    root = str(Path(args.root).resolve())
    findings, status = normalise_dir(args.outdir, root)
    with (args.outdir / "normalised.jsonl").open("w") as fh:
        for f in findings:
            fh.write(json.dumps(f) + "\n")
    from collections import Counter
    c = Counter((f["tool"], f["category"]) for f in findings)
    for (t, cat), n in sorted(c.items()):
        print(f"{t:28s} {cat:12s} {n}")
    print(json.dumps(status), file=sys.stderr)


if __name__ == "__main__":
    main()
