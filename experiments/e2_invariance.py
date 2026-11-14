"""E2 — Invariance (metamorphic) tests: semantics-preserving transformations must
not change structural metrics (Weyuker 1988 property; Briand et al. 1996).

Transformations per prod file: blank lines, comment lines, consistent local
renaming, #region wrapping, and Allman->K&R brace style (expected to change SLOC
only: line-based size metrics are layout-dependent, which we quantify).
A pair is invariant when all metrics in its invariant set are identical.
Acceptance (research/07): one-sided 95% lower bound of invariance rate >= 0.99."""
import json
import re
import sys
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from qlab.source import load_repo, load_file     # noqa: E402
from qlab.analyze import analyze                 # noqa: E402
from stats import wilson                         # noqa: E402

REPO = LAB / "corpus" / "messagepack-csharp"
STRUCT_RULES = ("kiss.", "size.parameters", "errors.", "magic.", "srp.", "dead.", "sec.", "secret.", "rel.", "encap.")


def t_blank(src):
    return "\n".join(l + ("\n" if l.rstrip().endswith((";", "{", "}")) else "") for l in src.split("\n"))


def t_comment(src):
    out = []
    for l in src.split("\n"):
        out.append(l)
        if l.rstrip().endswith(";") and not l.lstrip().startswith("//"):
            out.append(re.match(r"\s*", l).group(0) + "// qlab: explanatory remark")
    return "\n".join(out)


def t_rename(src):
    names = set(re.findall(r"\bvar\s+([a-z][A-Za-z0-9]*)\b", src))
    # a valid alpha-renaming must not capture other declarations (fields/params of the same name)
    names = {n for n in names if len(re.findall(r"\b" + n + r"\b\s*[;=,)]", src)) == len(re.findall(r"\bvar\s+" + n + r"\b", src))
             and not re.search(r"this\." + n + r"\b", src) and not re.search(r"[A-Za-z_>\]]\s+" + n + r"\s*[,)]", src)}
    for nm in sorted(names, key=len, reverse=True):
        src = re.sub(r"(?<![\w.])" + nm + r"\b", nm + "Value", src)
    return src


def t_region(src):
    lines = src.split("\n")
    out = []
    for l in lines:
        out.append(l)
    # wrap every top-level type body: after first line that is exactly '{' following a type header
    res, i = [], 0
    while i < len(lines):
        l = lines[i]
        res.append(l)
        if re.match(r"^\s*(public|internal|private|protected|sealed|static|partial|abstract|readonly|ref|\s)*(class|struct|record|interface)\b", l) \
                and i + 1 < len(lines) and lines[i + 1].strip() == "{":
            res.append(lines[i + 1]); res.append(re.match(r"\s*", lines[i + 1]).group(0) + "    #region qlab")
            i += 2
            continue
        i += 1
    return "\n".join(res)


def t_knr(src):
    lines = src.split("\n")
    out = []
    for l in lines:
        if l.strip() == "{" and out and out[-1].strip() and not out[-1].strip().startswith(("//", "#", "[")) \
                and not out[-1].rstrip().endswith((";", "{", "}", ",")):
            out[-1] = out[-1].rstrip() + " {"
        else:
            out.append(l)
    return "\n".join(out)


TRANSFORMS = {"blank_lines": (t_blank, "all"), "comment_lines": (t_comment, "all"),
              "rename_locals": (t_rename, "struct"), "region_wrap": (t_region, "all"),
              "brace_knr": (t_knr, "layout")}


def signature(A, mode):
    units = sorted((u.cc, u.cog, u.nest, u.params) + ((u.sloc,) if mode != "layout" else ())
                   for us in A.units.values() for u in us)
    rules = Counter(f.rule for f in A.findings if f.rule.startswith(STRUCT_RULES))
    if mode == "all":
        rules.update(Counter(f.rule for f in A.findings if f.rule.startswith(("dry.type1", "dry.type2", "naming."))))
    lcom = sorted((ev.get("lcom4") or 0) for k, ev in A.unit_evidence.items() if k[0] == "type")
    d = A.repo_metrics["dry"]
    dup = (round(d["type1_density"] * A.repo_metrics["code_lines"]), round(d["type2_density"] * A.repo_metrics["code_lines"]))
    sig = dict(units=units, rules=dict(rules), lcom=lcom)
    if mode == "all":
        sig["dup_lines"] = dup
        sig["code_lines"] = A.repo_metrics["code_lines"]
    return sig


def run(rel):
    sf = load_file(REPO, rel)
    base = {m: signature(analyze(REPO, files=[sf]), m) for m in ("all", "struct", "layout")}
    out = []
    for name, (fn, mode) in TRANSFORMS.items():
        txt = fn(sf.raw)
        if txt == sf.raw:
            continue
        tf = load_file(REPO, rel, text=txt)
        valid = (tf.root.has_error == sf.root.has_error) and (bool(tf.masked_lines) == bool(sf.masked_lines))
        if tf.root.has_error and not sf.root.has_error:
            out.append(dict(file=rel, transform=name, invalid_transform=True))
            continue
        A = analyze(REPO, files=[tf])
        s = signature(A, mode)
        diff = [k for k in s if s[k] != base[mode][k]]
        sloc_delta = A.repo_metrics["code_lines"] - sf_code(sf)
        out.append(dict(file=rel, transform=name, invariant=not diff, differing=diff, sloc_delta=sloc_delta,
                        sloc_rel=sloc_delta / max(1, sf_code(sf)), clean=not sf.root.has_error and not sf.masked_lines))
    return out


def sf_code(sf):
    return len(sf.code_lines)


def main():
    files = [f.path for f in load_repo(REPO, kinds={"prod"})]
    with Pool(16) as p:
        res = [r for rs in p.map(run, files) for r in rs]
    invalid = [r for r in res if r.get("invalid_transform")]
    res = [r for r in res if not r.get("invalid_transform")]
    summary = {"_invalid_transforms": dict(count=len(invalid), cases=[(r["file"], r["transform"]) for r in invalid])}
    for name in TRANSFORMS:
        rs = [r for r in res if r["transform"] == name]
        k = sum(r["invariant"] for r in rs)
        lo, _ = wilson(k, len(rs), z=1.644854)   # one-sided 95% lower bound
        summary[name] = dict(pairs=len(rs), invariant=k, rate=k / len(rs) if rs else None, lower95_one_sided=lo,
                             differing=dict(Counter(d for r in rs for d in r["differing"])),
                             sloc_rel_change_median=sorted(r["sloc_rel"] for r in rs)[len(rs) // 2] if rs else None,
                             examples=[(r["file"], r["differing"]) for r in rs if not r["invariant"]][:5])
    for label, sel in (("_all", lambda r: True), ("_clean_parse", lambda r: r["clean"]), ("_needs_containment", lambda r: not r["clean"])):
        allpairs = [r for r in res if sel(r)]
        k = sum(r["invariant"] for r in allpairs)
        summary[label] = dict(pairs=len(allpairs), invariant=k, rate=k / len(allpairs) if allpairs else None,
                              lower95_one_sided=wilson(k, len(allpairs), z=1.644854)[0] if allpairs else None)
    (LAB / "out" / "experiments" / "e2_invariance.json").write_text(json.dumps(dict(summary=summary, raw=res), indent=1))
    for k_, v in summary.items():
        print(k_, json.dumps({kk: vv for kk, vv in v.items() if kk != "examples"}), v.get("examples", [])[:2])


if __name__ == "__main__":
    main()
