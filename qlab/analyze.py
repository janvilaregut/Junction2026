"""Orchestrator: run every measurement on a repository and collect
(1) findings (line-localised violations with a reason),
(2) measurement populations (entity, weight, violation severity v in [0,1]) per practice,
(3) positive evidence per unit, and (4) repository-level indicators."""
from __future__ import annotations

import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import complexity, design, dry, hygiene, security
from .model import extract
from .source import load_repo, error_fraction
from .practices import PRACTICES, clamp, ramp


@dataclass
class Finding:
    practice: str
    rule: str
    file: str
    start: int
    end: int
    severity: float          # 0..1
    message: str
    level: str = "warning"   # SARIF level


@dataclass
class Entity:
    practice: str
    file: str
    start: int
    end: int
    weight: float
    v: float                 # violation severity in [0,1]
    label: str


@dataclass
class Analysis:
    repo: str
    files: list
    units: dict
    types: list
    findings: list = field(default_factory=list)
    entities: list = field(default_factory=list)
    unit_evidence: dict = field(default_factory=dict)
    repo_metrics: dict = field(default_factory=dict)
    timings: dict = field(default_factory=dict)
    incomplete: list = field(default_factory=list)

    def file(self, path):
        return next(f for f in self.files if f.path == path)


def analyze(repo: str | Path, kinds=("prod",), include=None, files=None, dry_params=None,
            field_style: str | None = None) -> Analysis:
    t0 = time.time()
    repo = Path(repo)
    fs = files if files is not None else load_repo(repo, kinds=set(kinds), include=include)
    A = Analysis(str(repo), fs, {}, [])
    for f in fs:
        ts, us = extract(f)
        complexity.measure_units(f, us)
        A.types += ts
        A.units[f.path] = us
    A.timings["parse+units"] = time.time() - t0
    code_total = sum(len(f.code_lines) for f in fs)
    A.repo_metrics["files"] = len(fs)
    A.repo_metrics["code_lines"] = code_total
    A.repo_metrics["units"] = sum(len(u) for u in A.units.values())
    A.repo_metrics["parse_error_fraction"] = (sum(error_fraction(f) * len(f.text) for f in fs) /
                                              max(1, sum(len(f.text) for f in fs)))
    A.repo_metrics["masked_lines"] = sum(len(f.masked_lines) for f in fs)

    _units(A)
    t = time.time(); _dry(A, dry_params or {}); A.timings["dry"] = time.time() - t
    t = time.time(); _design(A); A.timings["design"] = time.time() - t
    t = time.time(); _hygiene(A, field_style); A.timings["hygiene"] = time.time() - t
    t = time.time(); _security(A, repo); A.timings["security"] = time.time() - t
    A.timings["total"] = time.time() - t0
    return A


# ------------------------------------------------------------------ unit practices
def _units(A: Analysis):
    for path, us in A.units.items():
        for u in us:
            w = max(1, u.sloc)
            v_cc = ramp(u.cc, *PRACTICES["simple_units"].thresholds["cc"])
            v_cog = ramp(u.cog, *PRACTICES["simple_units"].thresholds["cog"])
            v_nest = ramp(u.nest, *PRACTICES["simple_units"].thresholds["nest"])
            v_simple = max(v_cc, v_cog, v_nest)
            v_size = ramp(u.sloc, *PRACTICES["small_units"].thresholds["sloc"])
            v_par = ramp(u.params, *PRACTICES["small_interfaces"].thresholds["params"])
            A.entities.append(Entity("simple_units", path, u.start, u.end, w, v_simple, u.qname))
            A.entities.append(Entity("small_units", path, u.start, u.end, w, v_size, u.qname))
            A.entities.append(Entity("small_interfaces", path, u.start, u.start, w, v_par, u.qname))
            A.unit_evidence[(path, u.start)] = dict(name=u.qname, start=u.start, end=u.end, sloc=u.sloc, cc=u.cc,
                                                   cog=u.cog, nest=u.nest, params=u.params,
                                                   v_simple=v_simple, v_size=v_size, v_params=v_par)
            if v_simple > 0:
                why = []
                if v_cc > 0: why.append(f"cyclomatic {u.cc}")
                if v_cog > 0: why.append(f"cognitive {u.cog}")
                if v_nest > 0: why.append(f"nesting {u.nest}")
                A.findings.append(Finding("simple_units", "kiss.complexity", path, u.start, u.end, v_simple,
                                          f"{u.qname}: {', '.join(why)} exceed thresholds"))
            if v_size > 0:
                A.findings.append(Finding("small_units", "size.unit_length", path, u.start, u.end, v_size,
                                          f"{u.qname}: {u.sloc} SLOC"))
            if v_par > 0:
                A.findings.append(Finding("small_interfaces", "size.parameters", path, u.start, u.start, v_par,
                                          f"{u.qname}: {u.params} parameters"))


# ------------------------------------------------------------------ DRY
def _dry(A: Analysis, params):
    p1 = dict(W=100, exact=True, min_lines=6)
    p1.update(params.get("type1", {}))
    p2 = dict(W=50, exact=False, min_lines=6)
    p2.update(params.get("type2", {}))
    r1 = dry.detect(A.files, with_extras=False, **p1)
    r2 = dry.detect(A.files, units_by_file=A.units, with_extras=True, **p2)
    per_line = defaultdict(dict)       # file -> line -> (v, reason)

    def put(path, ln, v, why):
        cur = per_line[path].get(ln)
        if cur is None or v > cur[0]:
            per_line[path][ln] = (v, why)

    for res, v0, tag in ((r1, 1.0, "Type-1 exact clone"), (r2, 0.7, "Type-2 clone (renamed identifiers/literals)")):
        for r in res.regions:
            inst = len(res.classes.get(r.cls, [])) or 1
            partners = sorted(r.partners)[:3]
            ptxt = ", ".join(f"{p}:{l}" for p, l in partners) or "same region"
            f = A.file(r.file)
            for ln in range(r.start, r.end + 1):
                if ln in f.code_lines:
                    put(r.file, ln, v0, f"{tag}, {r.tokens} tokens, class of {inst}; also at {ptxt}")
            A.findings.append(Finding("dry", "dry.type1" if v0 == 1.0 else "dry.type2", r.file, r.start, r.end, v0,
                                      f"{tag} ({r.tokens} tokens, {inst} instances); also at {ptxt}"))
    for ua, ub, jac in r2.near_miss:
        for u, o in ((ua, ub), (ub, ua)):
            f = A.file(u.file)
            for ln in range(u.start, u.end + 1):
                if ln in f.code_lines:
                    put(u.file, ln, 0.4, f"near-miss (Type-3) clone of {o.qname} (Jaccard {jac:.2f})")
            A.findings.append(Finding("dry", "dry.type3", u.file, u.start, u.end, 0.4,
                                      f"{u.qname} is a near-miss clone of {o.file}:{o.start} {o.qname} (Jaccard {jac:.2f})"))
    for path, occ, txt in r2.micro:
        for a, b in occ:
            for ln in range(a, b + 1):
                put(path, ln, 0.3, f"statement repeated {len(occ)}x in file: {txt[:60]}")
        A.findings.append(Finding("dry", "dry.micro", path, occ[0][0], occ[-1][1], 0.3,
                                  f"statement repeated {len(occ)} times in this file (lines {', '.join(str(a) for a, _ in occ[:6])}): {txt[:80]}"))
    for f in A.files:
        lines = per_line.get(f.path, {})
        for ln in f.code_lines:
            v, why = lines.get(ln, (0.0, ""))
            A.entities.append(Entity("dry", f.path, ln, ln, 1.0, v, why))
    code = max(1, A.repo_metrics["code_lines"])
    A.repo_metrics["dry"] = dict(
        type1_density=sum(len(v) for v in r1.dup_lines.values()) / code,
        type2_density=sum(len(v) for v in r2.dup_lines.values()) / code,
        near_miss_pairs=len(r2.near_miss), micro_clones=len(r2.micro),
        type1_classes=len(r1.classes), type2_classes=len(r2.classes),
        class_sizes=dict(Counter(len(c) for c in r2.classes.values())),
        params=dict(type1=r1.params, type2=r2.params))


# ------------------------------------------------------------------ design
def _design(A: Analysis):
    G = design.merge_partials(A.types)
    dg = design.dependency_graph(G)
    sloc_of = {}
    for qn, parts in G.items():
        sloc_of[qn] = sum(u.sloc for p in parts for u in p.units) or 1
    th = PRACTICES["cohesion"].thresholds
    for qn, parts in G.items():
        c = design.cohesion(parts)
        p0 = parts[0]
        wmc = sum(u.cc for p in parts for u in p.units)
        if c.lcom4 is not None:
            v = ramp(c.lcom4, *th["lcom4"])
            god = wmc >= th["god_wmc"] and c.tcc is not None and c.tcc < th["god_tcc"]
            if god:
                v = 1.0
            A.entities.append(Entity("cohesion", p0.file, p0.start, p0.end, sloc_of[qn], v, qn))
            if v > 0:
                comp_txt = " | ".join("{" + ", ".join(cc[:4]) + ("…" if len(cc) > 4 else "") + "}" for cc in c.components[:4])
                msg = (f"{qn}: LCOM4={c.lcom4} (method groups sharing no state: {comp_txt})"
                       + (f"; God Class (WMC={wmc}, TCC={c.tcc:.2f})" if god else ""))
                A.findings.append(Finding("cohesion", "srp.lcom4" if not god else "srp.god_class",
                                          p0.file, p0.start, p0.start, v, msg))
        cbo = len(dg.type_deps.get(qn, set()) | {t for t, d in dg.type_deps.items() if qn in d})
        v = ramp(cbo, *PRACTICES["coupling"].thresholds["cbo"])
        A.entities.append(Entity("coupling", p0.file, p0.start, p0.end, sloc_of[qn], v, qn))
        A.unit_evidence[("type", qn)] = dict(name=qn, file=p0.file, start=p0.start, lcom4=c.lcom4, tcc=c.tcc,
                                              wmc=wmc, cbo=cbo, ce=dg.ce.get(qn, 0), ca=dg.ca.get(qn, 0))
        if v > 0:
            A.findings.append(Finding("coupling", "coupling.cbo", p0.file, p0.start, p0.start, v,
                                      f"{qn}: coupled to {cbo} project types (Ce={dg.ce.get(qn, 0)}, Ca={dg.ca.get(qn, 0)})"))
        # encapsulation
        for (file, line, name, kind) in design.public_mutable_fields(parts):
            pass
        fields = [f for p in parts for f in p.fields if not f.is_const and not f.is_auto_property]
        pmf = {(fl, ln) for fl, ln, _, _ in design.public_mutable_fields(parts)}
        for p in parts:
            for f in p.fields:
                if f.is_const or f.is_auto_property:
                    continue
                bad = (p.file, f.line) in pmf
                v = (1.0 if p.kind == "class" else 0.5) if bad else 0.0
                A.entities.append(Entity("encapsulation", p.file, f.line, f.line, 1.0, v, f"{qn}.{f.name}"))
                if bad:
                    A.findings.append(Finding("encapsulation", "encap.public_mutable_field", p.file, f.line, f.line, v,
                                              f"{qn}.{f.name} is a publicly writable field (CA1051)"))
        # dead code: unused private members
        for (file, line, kind, name) in design.unused_private_members(parts):
            A.findings.append(Finding("dead_code", "dead.unused_private", file, line, line, 1.0,
                                      f"private {kind} '{name}' is never referenced (IDE0051)"))
    # namespace graph
    sccs = [s for s in design.tarjan_scc(dg.ns_deps) if len(s) > 1]
    tsccs = [s for s in design.tarjan_scc(dg.type_deps) if len(s) > 1]
    A.repo_metrics["design"] = dict(
        namespace_cycles=len(sccs), largest_namespace_cycle=max((len(s) for s in sccs), default=0),
        namespace_cycle_members=[sorted(s) for s in sccs],
        type_cycles=len(tsccs), largest_type_cycle=max((len(s) for s in tsccs), default=0),
        propagation_cost=design.propagation_cost(dg.type_deps),
        martin=design.martin_metrics(G, dg), types=len(G))
    for u_list in A.units.values():
        for u in u_list:
            for ln, nm in design.unused_locals(u):
                A.findings.append(Finding("dead_code", "dead.unused_local", u.file, ln, ln, 1.0,
                                          f"local '{nm}' is assigned but never used"))
            for ln, typ in design.unreachable(u):
                A.findings.append(Finding("dead_code", "dead.unreachable", u.file, ln, ln, 1.0,
                                          f"unreachable {typ.replace('_', ' ')}"))


# ------------------------------------------------------------------ hygiene
def _hygiene(A: Analysis, field_style):
    by_q = {t.qname: t for t in A.types}
    vocab = Counter()
    decl_by_file = {}
    for f in A.files:
        ts = [t for t in A.types if t.file == f.path]
        ds = list(hygiene.declarations(f, ts, A.units[f.path]))
        decl_by_file[f.path] = ds
        for d in ds:
            for w in set(hygiene.split_words(d[1])):
                vocab[w] += 1
    if field_style is None:
        st = Counter("_camel" if hygiene.UCAMEL.match(d[1]) else "camel"
                     for ds in decl_by_file.values() for d in ds
                     if d[0] == "private_field" and (hygiene.UCAMEL.match(d[1]) or hygiene.CAMEL.match(d[1])))
        field_style = st.most_common(1)[0][0] if st else None
    A.repo_metrics["naming_field_style"] = field_style
    style_obs = defaultdict(list)
    dead_lines = defaultdict(set)
    for fd in A.findings:
        if fd.practice == "dead_code":
            dead_lines[fd.file].add(fd.start)
    for f in A.files:
        # naming
        ds = decl_by_file[f.path]
        nf = hygiene.naming_findings(ds, field_style, vocab)
        worst = {}
        for line, kind, name, sev, rule, msg in nf:
            k = (line, name)
            if k not in worst or sev > worst[k][0]:
                worst[k] = (sev, rule, msg)
            A.findings.append(Finding("naming", rule, f.path, line, line, sev, msg))
        for kind, name, line, _ in ds:
            sev = worst.get((line, name), (0.0,))[0]
            A.entities.append(Entity("naming", f.path, line, line, 1.0, sev, f"{kind} {name}"))
        # error handling
        pop, eh = hygiene.error_handling(f)
        for line, sev, rule, msg in eh:
            A.findings.append(Finding("error_handling", rule, f.path, line, line, sev, msg))
        bad = sum(s for _, s, _, _ in eh)
        if pop:
            A.entities.append(Entity("error_handling", f.path, 1, 1, pop, min(1.0, bad / pop), f"{pop} handlers/throws"))
        # magic numbers
        mlines = defaultdict(list)
        for line, lit in hygiene.magic_numbers(f):
            mlines[line].append(lit)
        for ln in f.code_lines:
            v = 1.0 if ln in mlines else 0.0
            A.entities.append(Entity("magic_numbers", f.path, ln, ln, 1.0, v,
                                     f"magic literal(s) {', '.join(mlines[ln][:4])}" if v else ""))
        for ln, lits in mlines.items():
            A.findings.append(Finding("magic_numbers", "magic.number", f.path, ln, ln, 1.0,
                                      f"unnamed numeric literal(s) {', '.join(lits[:4])}; extract a named constant", "note"))
        # comments: SATD + commented-out code
        satd, blocks = hygiene.comment_hygiene(f)
        for ln, txt in satd:
            A.findings.append(Finding("documentation", "debt.satd", f.path, ln, ln, 0.3, f"self-admitted technical debt: {txt}", "note"))
        for a, b, txt in blocks:
            A.findings.append(Finding("dead_code", "dead.commented_out_code", f.path, a, b, 1.0,
                                      f"commented-out code: {txt.strip()[:70]}"))
            dead_lines[f.path] |= set(range(a, b + 1))
        for k, v in hygiene.style_observations(f).items():
            style_obs[k] += [(c, f.path, ln) for c, ln in v]
    # dead code population over code + comment-out lines
    for f in A.files:
        lines = f.code_lines | dead_lines.get(f.path, set())
        for ln in lines:
            A.entities.append(Entity("dead_code", f.path, ln, ln, 1.0, 1.0 if ln in dead_lines.get(f.path, ()) else 0.0, ""))
    # documentation coverage
    for file, line, kind, name, doc in hygiene.api_documentation(A.types, by_q):
        A.entities.append(Entity("documentation", file, line, line, 1.0, 0.0 if doc else 1.0, name))
        if not doc:
            A.findings.append(Finding("documentation", "docs.missing_xml_doc", file, line, line, 1.0,
                                      f"public {kind} {name} has no XML documentation (CS1591)", "note"))
    # consistency
    table = hygiene.consistency({k: [(c, ln) for c, _, ln in v] for k, v in style_obs.items()})
    A.repo_metrics["consistency"] = table
    for conv, items in style_obs.items():
        maj = table[conv]["majority"]
        for c, path, ln in items:
            A.entities.append(Entity("consistency", path, ln, ln, 1.0 / max(1, table[conv]["total"]),
                                     0.0 if c == maj else 1.0, conv))
            if c != maj and table[conv]["share"] >= 0.8:
                A.findings.append(Finding("consistency", f"style.{conv}", path, ln, ln, 0.5,
                                          f"{conv} = {c}; {table[conv]['share']:.0%} of the repository uses {maj}", "note"))


# ------------------------------------------------------------------ security & reliability
def _security(A: Analysis, repo: Path):
    kloc = max(0.001, A.repo_metrics["code_lines"] / 1000)
    sec_w, rel_w = 0.0, 0.0
    for f in A.files:
        for line, rule, sev, info in security.secrets(f):
            w = security.SEV[sev]; sec_w += w
            A.findings.append(Finding("security", rule, f.path, line, line, w, f"possible hard-coded secret ({info})", "error"))
        for line, rule, sev, cwe, msg in security.dangerous_apis(f):
            w = security.SEV[sev]; sec_w += w
            A.findings.append(Finding("security", rule, f.path, line, line, w, f"{msg} [{cwe}]",
                                      "error" if sev in ("critical", "high") else "warning"))
        for line, rule, sev, msg in security.reliability(f, A.units[f.path]):
            w = security.SEV[sev]; rel_w += w
            A.findings.append(Finding("reliability", rule, f.path, line, line, w, msg))
    A.repo_metrics["security"] = dict(weighted_findings=sec_w, per_kloc=sec_w / kloc,
                                      packages=security.package_inventory(repo))
    A.repo_metrics["reliability"] = dict(weighted_findings=rel_w, per_kloc=rel_w / kloc)
