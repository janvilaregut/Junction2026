#!/usr/bin/env python3
"""E1/E4: run the AI-free tool catalog on one source tree and record cost.

For every tool this writes the native report(s) to OUT/<tool>.* and appends a
record to OUT/runs.json: version, exact command, wall-clock seconds, peak RSS
(largest process, from /usr/bin/time -l), exit status and whether the run is
usable. A tool that fails is recorded as failed, never as "zero findings".

Example (repository root):
    python3 experiments/tools/run_tools.py --target corpus/tools/refs/base --out out/tools/base
    python3 experiments/tools/run_tools.py --target corpus/tools/seeded --out out/tools/seeded \
        --tools gitleaks,trufflehog --redact-values corpus/tools/seeded-secret-values.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "corpus" / "tools"
VENV = WORK / "venv" / "bin"
LIZARD = ROOT / ".venv" / "bin" / "lizard"
JSCPD = WORK / "npm" / "node_modules" / ".bin" / "jscpd"
RULES = WORK / "semgrep-rules"
CACHE = WORK / "cache"

ENV = dict(os.environ,
           TRIVY_CACHE_DIR=str(CACHE / "trivy"),
           GRYPE_DB_CACHE_DIR=str(CACHE / "grype"),
           GRYPE_CHECK_FOR_APP_UPDATE="false",
           SYFT_CHECK_FOR_APP_UPDATE="false",
           SEMGREP_SEND_METRICS="off",
           NO_COLOR="1")

VERSIONS = {
    "gitleaks": ["gitleaks", "version"],
    "betterleaks": ["betterleaks", "version"],
    "trufflehog": ["trufflehog", "--version"],
    "detect-secrets": [str(VENV / "detect-secrets"), "--version"],
    "trivy": ["trivy", "--version"],
    "osv-scanner": ["osv-scanner", "--version"],
    "syft": ["syft", "version"],
    "grype": ["grype", "version"],
    "semgrep": ["semgrep", "--version"],
    "pmd": ["pmd", "--version"],
    "jscpd": [str(JSCPD), "--version"],
    "scc": ["scc", "--version"],
    "lizard": [str(LIZARD), "--version"],
    "scorecard": ["scorecard", "version"],
    "codeql": ["codeql", "version"],
}


def tool_specs(t: Path, o: Path) -> dict[str, dict]:
    """name -> {family, cmds: [argv...], stdout: file or None, cwd, ok_codes}."""
    T, O = str(t), str(o)
    # --no-git-ignore: our exported trees live in a git-ignored folder of the lab repo; without it semgrep
    # silently scans 0 files. --project-root makes semgrep treat the exported tree as the project (otherwise
    # it climbs to the enclosing lab repository and never reads a .semgrepignore placed in the tree). The "-all" variants also neutralise semgrep's built-in default ignore list
    # (which skips tests/) by placing an empty .semgrepignore at the root for the duration of the run.
    sg = lambda pack, all_files=False: {  # noqa: E731
        "family": "semgrep",
        "cmds": [["semgrep", "scan", "--config", str(RULES / f"p-{pack}.yml"), "--metrics", "off",
                  "--disable-version-check", "--quiet", "--no-git-ignore", "--semgrepignore-v2", "--project-root", T,
                  "--jobs", "8", "--timeout", "30",
                  "--sarif-output", f"{O}/semgrep-{pack}{'-all' if all_files else ''}.sarif",
                  "--json-output", f"{O}/semgrep-{pack}{'-all' if all_files else ''}.json", T]],
        "ok_codes": {0, 1}, "semgrepignore_empty": all_files}
    return {
        "gitleaks": {"family": "gitleaks", "cmds": [["gitleaks", "dir", T, "--report-format", "sarif", "--report-path",
                                                     f"{O}/gitleaks.sarif", "--redact", "--no-banner", "--exit-code", "0",
                                                     "--log-level", "warn"]]},
        "betterleaks": {"family": "betterleaks", "cmds": [["betterleaks", "dir", T, "--report-format", "sarif", "--report-path",
                                                           f"{O}/betterleaks.sarif", "--redact", "--no-banner", "--exit-code", "0",
                                                           "--log-level", "warn"]]},
        "trufflehog": {"family": "trufflehog", "cmds": [["trufflehog", "filesystem", T, "--json", "--no-verification",
                                                         "--no-update", "--log-level=-1"]],
                       "stdout": f"{O}/trufflehog.jsonl"},
        "detect-secrets": {"family": "detect-secrets", "cmds": [[str(VENV / "detect-secrets"), "scan", "--all-files"]],
                           "stdout": f"{O}/detect-secrets.json", "cwd": T},
        "trivy": {"family": "trivy", "cmds": [
            ["trivy", "fs", "--scanners", "vuln,secret,misconfig", "--format", "json", "--output", f"{O}/trivy.json",
             "--skip-db-update", "--skip-check-update", "--quiet", T],
            ["trivy", "convert", "--format", "sarif", "--output", f"{O}/trivy.sarif", f"{O}/trivy.json"]]},
        # --no-ignore: like semgrep, osv-scanner honours the enclosing lab repo's .gitignore and otherwise
        # reports "no package sources found" (exit 128) for our exported trees.
        "osv-scanner": {"family": "osv-scanner", "cmds": [
            ["osv-scanner", "scan", "source", "-r", "--no-ignore", "--format", "json", "--output-file", f"{O}/osv-scanner.json", T],
            ["osv-scanner", "scan", "source", "-r", "--no-ignore", "--format", "sarif", "--output-file", f"{O}/osv-scanner.sarif", T]],
            "ok_codes": {0, 1, 128}},
        "syft": {"family": "syft", "cmds": [["syft", f"dir:{T}", "-q", "-o", f"cyclonedx-json={O}/syft.cdx.json"]]},
        "grype": {"family": "grype", "cmds": [["grype", f"sbom:{O}/syft.cdx.json", "-q", "-o", f"json={O}/grype.json",
                                               "-o", f"sarif={O}/grype.sarif"]], "needs": "syft"},
        "grype-dir": {"family": "grype", "cmds": [["grype", f"dir:{T}", "-q", "-o", f"json={O}/grype-dir.json"]]},
        "semgrep-csharp": sg("csharp"),
        "semgrep-security-audit": sg("security-audit"),
        "semgrep-secrets": sg("secrets"),
        "semgrep-default": sg("default"),
        "semgrep-csharp-all": sg("csharp", True),
        "semgrep-security-audit-all": sg("security-audit", True),
        "semgrep-secrets-all": sg("secrets", True),
        "semgrep-default-all": sg("default", True),
        "cpd-100": {"family": "pmd", "cmds": [
            ["pmd", "cpd", "--language", "cs", "--minimum-tokens", "100", "--dir", T, "--format", "xml",
             "--encoding", "UTF-8", "--no-fail-on-violation", "--skip-lexical-errors"],
            ["pmd", "cpd", "--language", "cs", "--minimum-tokens", "100", "--dir", T, "--format", "csv",
             "--encoding", "UTF-8", "--no-fail-on-violation", "--skip-lexical-errors"]],
            "stdout": [f"{O}/cpd-100.xml", f"{O}/cpd-100.csv"]},
        "cpd-50": {"family": "pmd", "cmds": [
            ["pmd", "cpd", "--language", "cs", "--minimum-tokens", "50", "--dir", T, "--format", "xml",
             "--encoding", "UTF-8", "--no-fail-on-violation", "--skip-lexical-errors"],
            ["pmd", "cpd", "--language", "cs", "--minimum-tokens", "50", "--dir", T, "--format", "csv",
             "--encoding", "UTF-8", "--no-fail-on-violation", "--skip-lexical-errors"]],
            "stdout": [f"{O}/cpd-50.xml", f"{O}/cpd-50.csv"]},
        "cpd-100-ignore-ids": {"family": "pmd", "cmds": [
            ["pmd", "cpd", "--language", "cs", "--minimum-tokens", "100", "--dir", T, "--format", "xml",
             "--ignore-identifiers", "--ignore-literals", "--encoding", "UTF-8", "--no-fail-on-violation",
             "--skip-lexical-errors"]], "stdout": f"{O}/cpd-100-ignore-ids.xml"},
        # jscpd ignores any path containing a dot-directory (our absolute path contains /.claude/), so it is
        # run from inside the target with "." as the path.
        "jscpd-100": {"family": "jscpd", "cmds": [[str(JSCPD), "--min-tokens", "100", "--format", "csharp", "--reporters",
                                                    "json", "--output", f"{O}/jscpd-100", "--silent", "."]], "cwd": T},
        "jscpd-50": {"family": "jscpd", "cmds": [[str(JSCPD), "--min-tokens", "50", "--format", "csharp", "--reporters",
                                                   "json", "--output", f"{O}/jscpd-50", "--silent", "."]], "cwd": T},
        # OpenSSF Scorecard in --local mode needs no GitHub token but only runs the file-based checks.
        "scorecard": {"family": "scorecard", "cmds": [["scorecard", f"--local={T}", "--format=json", "--show-details"]],
                      "stdout": f"{O}/scorecard.json"},
        "scc": {"family": "scc", "cmds": [["scc", "--format", "json", "--by-file", "--no-cocomo", T]],
                "stdout": f"{O}/scc.json"},
        "lizard": {"family": "lizard", "cmds": [[str(LIZARD), "-l", "csharp", "-t", "8", "--csv", T],
                                                 [str(LIZARD), "-l", "csharp", "-t", "8", "--xml", T]],
                   "stdout": [f"{O}/lizard.csv", f"{O}/lizard.xml"], "ok_codes": {0, 1}},
    }


DEFAULT_TOOLS = ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "osv-scanner", "syft", "grype",
                 "grype-dir", "semgrep-csharp", "semgrep-security-audit", "semgrep-secrets", "semgrep-default",
                 "semgrep-csharp-all", "semgrep-security-audit-all", "semgrep-secrets-all", "semgrep-default-all",
                 "cpd-100", "cpd-50", "jscpd-100", "jscpd-50", "scc", "lizard", "scorecard"]

_RSS = re.compile(r"^\s*(\d+)\s+maximum resident set size", re.M)


def run_one(argv, stdout_path, cwd):
    t0 = time.perf_counter()
    with open(stdout_path, "wb") if stdout_path else open(os.devnull, "wb") as out:
        p = subprocess.run(["/usr/bin/time", "-l", *argv], stdout=out, stderr=subprocess.PIPE, cwd=cwd, env=ENV)
    wall = time.perf_counter() - t0
    err = p.stderr.decode(errors="replace")
    m = _RSS.search(err)
    return p.returncode, wall, (int(m.group(1)) if m else None), _RSS.split(err)[0][-2000:]


def version(family: str) -> str:
    argv = VERSIONS.get(family)
    if not argv:
        return "?"
    try:
        out = subprocess.run(argv, capture_output=True, text=True, env=ENV, timeout=60)
        txt = (out.stdout + out.stderr).strip().splitlines()
        if family == "pmd":
            txt = [l for l in txt if "PMD" in l] or txt
        if family == "scorecard":
            txt = [l for l in txt if l.startswith("GitVersion")] or txt
        if family in ("syft", "grype"):
            txt = [l for l in txt if l.startswith("Version")] or txt
        return txt[0].strip() if txt else "?"
    except Exception as e:  # noqa: BLE001
        return f"? ({e})"


def redact_file(path: Path, values: list[str]):
    """Replace known fake secret values (seeded run) by a short hash so reports can be shared."""
    if not path.exists() or path.is_dir():
        return
    data = path.read_text(errors="replace")
    changed = False
    for v in sorted(values, key=len, reverse=True):
        if v and v in data:
            data = data.replace(v, "REDACTED-" + hashlib.sha256(v.encode()).hexdigest()[:12])
            changed = True
        jv = json.dumps(v)[1:-1]
        if v and jv != v and jv in data:
            data = data.replace(jv, "REDACTED-" + hashlib.sha256(v.encode()).hexdigest()[:12])
            changed = True
    if changed:
        path.write_text(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--tools", default=",".join(DEFAULT_TOOLS))
    ap.add_argument("--label", default=None)
    ap.add_argument("--redact-values", type=Path, default=None,
                    help="JSON {id: [values]} of fake secrets to scrub from every report after the run")
    args = ap.parse_args()
    t, o = args.target.resolve(), args.out.resolve()
    o.mkdir(parents=True, exist_ok=True)
    runs_path = o / "runs.json"
    runs = json.loads(runs_path.read_text()) if runs_path.exists() else {}
    specs = tool_specs(t, o)
    redact_vals = []
    if args.redact_values:
        for vs in json.loads(args.redact_values.read_text()).values():
            for v in vs:
                redact_vals += [v] + v.split("\n")
    if redact_vals and not [x for x in args.tools.split(",") if x]:  # --tools "" : only scrub existing reports
        for f in o.rglob("*"):
            if f.is_file() and f.name != "runs.json":
                redact_file(f, redact_vals)
    for name in [x for x in args.tools.split(",") if x]:
        spec = specs[name]
        stdouts = spec.get("stdout")
        if not isinstance(stdouts, list):
            stdouts = [stdouts] * len(spec["cmds"])
        rec = {"tool": name, "family": spec["family"], "version": version(spec["family"]), "target": str(t),
               "label": args.label or o.name, "steps": []}
        ok_codes = spec.get("ok_codes", {0})
        total_wall, peak = 0.0, 0
        ign = t / ".semgrepignore"
        if spec.get("semgrepignore_empty"):
            assert not ign.exists(), ign
            ign.write_text("# empty: disable semgrep's built-in default ignore list (lab variant)\n")
        for argv, so in zip(spec["cmds"], stdouts):
            rc, wall, rss, err = run_one(argv, so, spec.get("cwd"))
            total_wall += wall
            peak = max(peak, rss or 0)
            rec["steps"].append({"cmd": " ".join(shlex.quote(a) for a in argv), "exit_code": rc, "wall_s": round(wall, 3),
                                 "max_rss_mb": round((rss or 0) / 2**20, 1), "stderr_tail": err[-600:] if rc not in ok_codes else ""})
        if spec.get("semgrepignore_empty"):
            ign.unlink()
        for big in o.glob("cpd-*.xml"):  # CPD XML embeds every code fragment (cpd-50 is ~200 MB): keep it gzipped
            subprocess.run(["gzip", "-f", "-9", str(big)], check=False)
        rec["wall_s"] = round(total_wall, 3)
        rec["max_rss_mb"] = round(peak / 2**20, 1)
        rec["ok"] = all(s["exit_code"] in ok_codes for s in rec["steps"])
        rec["primary_wall_s"] = rec["steps"][0]["wall_s"]
        runs[name] = rec
        if redact_vals:
            for f in o.rglob("*"):
                if f.is_file() and f.name != "runs.json":
                    redact_file(f, redact_vals)
        if name == "trufflehog":  # trufflehog has no --redact: scrub Raw/RawV2 for every run
            p = Path(stdouts[0])
            if p.exists():
                lines = []
                for line in p.read_text(errors="replace").splitlines():
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    for k in ("Raw", "RawV2"):
                        if d.get(k):
                            d[k] = "REDACTED-" + hashlib.sha256(d[k].encode()).hexdigest()[:12]
                    lines.append(json.dumps(d))
                p.write_text("\n".join(lines) + ("\n" if lines else ""))
        print(f"{name:24s} ok={rec['ok']!s:5s} wall={rec['wall_s']:8.2f}s rss={rec['max_rss_mb']:8.1f}MB "
              f"exit={[s['exit_code'] for s in rec['steps']]}", flush=True)
        runs_path.write_text(json.dumps(runs, indent=2) + "\n")


if __name__ == "__main__":
    main()
