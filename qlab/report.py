"""Outputs: SARIF 2.1.0 (GitHub code scanning) and line-level heatmap data
(per practice heat h_p(l) in [0,1] + human-readable reasons + positive evidence)."""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict

from .practices import PRACTICES, ramp

# heat weights per practice for the combined (noisy-OR) heat; ordered by the evidence ranking
HEAT_WEIGHT = {"security": 1.0, "reliability": 0.8, "error_handling": 0.8, "dry": 0.7, "simple_units": 0.7,
               "small_units": 0.5, "coupling": 0.5, "small_interfaces": 0.4, "cohesion": 0.4, "dead_code": 0.4,
               "naming": 0.3, "documentation": 0.25, "encapsulation": 0.3, "magic_numbers": 0.2, "consistency": 0.15}
SPREAD_UNIT = {"simple_units", "small_units"}     # unit-level findings colour the whole unit


def to_sarif(A, tool_version="0.1.0"):
    rules, results = {}, []
    lines_of = {f.path: f.raw.split("\n") for f in A.files}
    for f in A.findings:
        rules.setdefault(f.rule, {"id": f.rule, "name": f.rule.replace(".", "_"),
                                  "shortDescription": {"text": PRACTICES[f.practice].name if f.practice in PRACTICES else f.practice},
                                  "properties": {"practice": f.practice}})
        txt = lines_of[f.file][f.start - 1].strip() if 0 < f.start <= len(lines_of[f.file]) else ""
        h = hashlib.sha256(f"{f.rule}|{f.file}|{txt}".encode()).hexdigest()[:32]
        results.append({"ruleId": f.rule, "level": f.level, "message": {"text": f.message},
                        "locations": [{"physicalLocation": {"artifactLocation": {"uri": f.file},
                                                            "region": {"startLine": f.start, "endLine": max(f.start, f.end)}}}],
                        "partialFingerprints": {"primaryLocationLineHash": h},
                        "properties": {"severity": round(f.severity, 3), "practice": f.practice}})
    return {"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
            "runs": [{"tool": {"driver": {"name": "qlab", "version": tool_version, "informationUri": "https://example.invalid/qlab",
                                          "rules": list(rules.values())}}, "results": results}]}


def heat_data(A, S=None, files=None):
    """Return a JSON-serialisable structure for the heatmap viewer."""
    sel = [f for f in A.files if files is None or f.path in files]
    by_file = {}
    for f in sel:
        n = len(f.raw.split("\n"))
        heat = defaultdict(lambda: defaultdict(float))     # line -> practice -> h
        why = defaultdict(list)                             # line -> [(practice, sev, msg)]
        by_file[f.path] = dict(heat=heat, why=why, n=n, f=f)
    for fd in A.findings:
        d = by_file.get(fd.file)
        if d is None:
            continue
        rng_ = range(fd.start, fd.end + 1) if (fd.practice in SPREAD_UNIT or fd.practice == "dry") else [fd.start]
        for ln in rng_:
            if ln in d["f"].code_lines or ln == fd.start:
                d["heat"][ln][fd.practice] = max(d["heat"][ln][fd.practice], fd.severity)
        d["why"][fd.start].append((fd.practice, round(fd.severity, 2), fd.message))
    # positive evidence at unit header lines
    good = defaultdict(list)
    for (key, ev) in A.unit_evidence.items():
        if key[0] == "type" or "sloc" not in ev:
            continue
        path, start = key
        ok = []
        ok.append(("simple_units", ev["v_simple"] == 0, f"CC {ev['cc']} · cognitive {ev['cog']} · nesting {ev['nest']}"))
        ok.append(("small_units", ev["v_size"] == 0, f"{ev['sloc']} SLOC"))
        ok.append(("small_interfaces", ev["v_params"] == 0, f"{ev['params']} parameters"))
        good[(path, start)] = ok
    out_files = []
    for path, d in by_file.items():
        f = d["f"]
        lines = f.raw.split("\n")
        rows = []
        tot = 0.0
        for i, text in enumerate(lines, 1):
            hp = d["heat"].get(i, {})
            comb = 1.0
            for p, h in hp.items():
                comb *= 1 - HEAT_WEIGHT.get(p, 0.3) * h
            comb = 1 - comb
            if i in f.code_lines:
                tot += comb
            row = [text]
            if hp or i in d["why"] or (path, i) in good:
                row.append(round(comb, 3))
                row.append({p: round(h, 2) for p, h in hp.items()})
                row.append(d["why"].get(i, []))
                row.append(good.get((path, i), []))
            rows.append(row)
        code = max(1, len(f.code_lines))
        out_files.append(dict(path=path, kind=f.kind, code_lines=len(f.code_lines), heat_density=round(tot / code, 4),
                              findings=sum(len(v) for v in d["why"].values()), rows=rows))
    out_files.sort(key=lambda x: -x["heat_density"])
    practices = {pid: dict(name=p.name, dimension=p.dimension, definition=p.definition) for pid, p in PRACTICES.items()}
    practices["security"] = dict(name="Security", dimension="security", definition="secrets, dangerous APIs (CWE-mapped)")
    practices["reliability"] = dict(name="Reliability", dimension="reliability", definition="async void, sync-over-async, lock(this), float equality")
    summary = None
    if S is not None:
        summary = dict(practices={k: dict(score=v["score"], lo=None if v["ci"] is None else round(100 * v["ci"]["lo"], 1),
                                          hi=None if v["ci"] is None else round(100 * v["ci"]["hi"], 1), verdict=v["verdict"])
                                  for k, v in S["practices"].items()},
                       dimensions=S["dimensions"])
    return dict(repo=A.repo.split("/")[-1], practices=practices, weights=HEAT_WEIGHT, summary=summary, files=out_files,
                repo_metrics={k: v for k, v in A.repo_metrics.items() if k in ("files", "code_lines", "units", "parse_error_fraction", "dry")})
