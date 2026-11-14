"""Design-level metrics: cohesion (LCOM4, TCC), coupling (Ce/Ca/CBO), namespace
dependency graph (Martin I/A/D, Tarjan SCC for the Acyclic Dependencies
Principle, MacCormack propagation cost), encapsulation and dead code.

All dependencies are approximated syntactically: a type T depends on U when an
identifier equal to U's simple name occurs inside T's declaration (types, generic
arguments, object creation, static access, base list). This is the standard
syntax-only approximation; it over-approximates when a member shares a type's
name and misses `var`-inferred types.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .model import text


def merge_partials(types):
    """Group TypeDecl by qualified name (partial classes span files)."""
    groups = defaultdict(list)
    for t in types:
        groups[t.qname].append(t)
    return groups


def identifiers(node, own_only=False) -> list:
    out, st = [], [node]
    while st:
        n = st.pop()
        if n.type == "identifier":
            out.append(n)
        st.extend(n.children)
    return out


def self_refs(body) -> set[str]:
    """Names referenced as bare identifiers or via this./base. (not other.x)."""
    s = set()
    for n in identifiers(body):
        p = n.parent
        if p is not None and p.type == "member_access_expression" and p.child_by_field_name("name") == n:
            e = p.child_by_field_name("expression")
            if e is None or e.type not in ("this", "base", "this_expression", "base_expression"):
                continue
        s.add(text(n))
    return s


@dataclass
class Cohesion:
    qname: str
    lcom4: int | None
    tcc: float | None
    methods: int
    fields: int
    components: list = field(default_factory=list)


def cohesion(parts) -> Cohesion:
    t0 = parts[0]
    qn = t0.qname
    if t0.kind in ("interface", "enum"):
        return Cohesion(qn, None, None, 0, 0)
    fields = {f.name for p in parts for f in p.fields if not f.is_static and not f.is_const}
    nodes: dict[str, set] = defaultdict(set)     # method-node -> referenced names
    visible: set[str] = set()
    for p in parts:
        for u in p.units:
            if u.kind in ("ctor", "dtor", "operator") or u.is_static:
                continue
            key = u.name.split(".")[0] if u.kind == "accessor" else u.name
            nodes[key] |= self_refs(u.body)
            if "private" not in u.mods:
                visible.add(key)
    names = list(nodes)
    if len(names) < 2 or not fields:
        return Cohesion(qn, None, None, len(names), len(fields))
    # union-find over method nodes connected via shared fields or direct calls
    parent = {m: m for m in names}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    by_field = defaultdict(list)
    for m in names:
        for f in nodes[m] & fields:
            by_field[f].append(m)
        for m2 in nodes[m] & set(names):
            if m2 != m:
                parent[find(m2)] = find(m)
    for ms in by_field.values():
        for m2 in ms[1:]:
            parent[find(m2)] = find(ms[0])
    comps = defaultdict(list)
    for m in names:
        comps[find(m)].append(m)
    vis = [m for m in names if m in visible]
    pairs = len(vis) * (len(vis) - 1) / 2
    tcc = None
    if pairs:
        direct = sum(1 for i, a in enumerate(vis) for b in vis[i + 1:] if nodes[a] & nodes[b] & fields)
        tcc = direct / pairs
    return Cohesion(qn, len(comps), tcc, len(names), len(fields), sorted(comps.values(), key=len, reverse=True))


@dataclass
class DepGraph:
    type_deps: dict           # qname -> set(qname)
    simple_index: dict        # simple name -> [qname]
    ns_of: dict               # qname -> namespace
    ns_deps: dict             # ns -> set(ns)
    ce: dict
    ca: dict


def dependency_graph(groups) -> DepGraph:
    simple = defaultdict(list)
    ns_of = {}
    for qn, parts in groups.items():
        simple[parts[0].name].append(qn)
        ns_of[qn] = parts[0].ns
    deps = {qn: set() for qn in groups}
    for qn, parts in groups.items():
        own_ns = parts[0].ns
        for p in parts:
            for idn in identifiers(p.node):
                nm = text(idn)
                cands = simple.get(nm)
                if not cands:
                    continue
                # prefer same-namespace candidate, else all (ambiguity -> first)
                tgt = next((c for c in cands if ns_of[c] == own_ns), cands[0])
                if tgt != qn and not tgt.startswith(qn + ".") and not qn.startswith(tgt + "."):
                    deps[qn].add(tgt)
    ce = {qn: len(d) for qn, d in deps.items()}
    ca = defaultdict(int)
    for qn, d in deps.items():
        for t in d:
            ca[t] += 1
    nsd = defaultdict(set)
    for qn, d in deps.items():
        for t in d:
            a, b = ns_of[qn], ns_of[t]
            if a != b:
                nsd[a].add(b)
    for qn in groups:
        nsd.setdefault(ns_of[qn], set())
    return DepGraph(deps, dict(simple), ns_of, dict(nsd), ce, dict(ca))


def tarjan_scc(graph: dict) -> list[list]:
    """Iterative Tarjan strongly connected components."""
    index, low, on, stack, out = {}, {}, set(), [], []
    counter = [0]
    for root in graph:
        if root in index:
            continue
        work = [(root, iter(graph.get(root, ())))]
        index[root] = low[root] = counter[0]; counter[0] += 1
        stack.append(root); on.add(root)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1
                    stack.append(w); on.add(w)
                    work.append((w, iter(graph.get(w, ()))))
                    advanced = True
                    break
                elif w in on:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop(); on.discard(w); comp.append(w)
                    if w == v:
                        break
                out.append(comp)
    return out


def propagation_cost(graph: dict) -> float:
    """MacCormack et al. 2006: density of the transitive closure (incl. self)."""
    nodes = list(graph)
    n = len(nodes)
    if n == 0:
        return 0.0
    total = 0
    for s in nodes:
        seen, st = {s}, [s]
        while st:
            v = st.pop()
            for w in graph.get(v, ()):
                if w not in seen:
                    seen.add(w); st.append(w)
        total += len(seen)
    return total / (n * n)


def martin_metrics(groups, dg: DepGraph) -> dict:
    """Per namespace: Ca, Ce (namespace level), I = Ce/(Ca+Ce), A, D = |A+I-1|."""
    out = {}
    ca = defaultdict(set)
    for a, bs in dg.ns_deps.items():
        for b in bs:
            ca[b].add(a)
    types_in = defaultdict(list)
    for qn, parts in groups.items():
        types_in[dg.ns_of[qn]].append(parts[0])
    for ns, ts in types_in.items():
        ce_n = len(dg.ns_deps.get(ns, ()))
        ca_n = len(ca.get(ns, ()))
        inst = ce_n / (ca_n + ce_n) if (ca_n + ce_n) else 0.0
        abst = sum(1 for t in ts if t.is_abstract) / len(ts)
        out[ns] = dict(Ca=ca_n, Ce=ce_n, I=inst, A=abst, D=abs(abst + inst - 1), types=len(ts))
    return out


# ---------------- dead code & encapsulation ----------------

def _decl_name_nodes(node):
    out = set()
    st = [node]
    while st:
        n = st.pop()
        nm = n.child_by_field_name("name")
        if nm is not None and n.type in ("variable_declarator", "method_declaration", "property_declaration",
                                         "local_function_statement", "parameter", "event_declaration"):
            out.add((nm.start_byte, nm.end_byte))
        st.extend(n.children)
    return out


def unused_private_members(parts) -> list:
    """Private members never referenced inside their (merged) type."""
    refs = defaultdict(int)
    decl_pos = set()
    for p in parts:
        decl_pos |= _decl_name_nodes(p.node)
    for p in parts:
        for idn in identifiers(p.node):
            if (idn.start_byte, idn.end_byte) in decl_pos:
                continue
            refs[text(idn)] += 1
    out = []
    for p in parts:
        if p.kind in ("interface", "enum"):
            continue
        for kind, name, node, mods, _doc, line in p.members:
            if kind not in ("field", "method", "property"):
                continue
            access = mods & {"public", "protected", "internal"}
            if access or {"override", "extern", "partial", "abstract", "virtual"} & mods:
                continue
            if any(c.type == "attribute_list" for c in node.children):
                continue
            if node.child_by_field_name("explicit_interface_specifier") is not None or \
                    any(c.type == "explicit_interface_specifier" for c in node.children):
                continue
            if name in ("Dispose", "Finalize", "ToString", "Equals", "GetHashCode") or name.startswith("operator"):
                continue
            if refs.get(name, 0) == 0:
                out.append((p.file, line, kind, name))
    return out


def unused_locals(unit) -> list:
    out = []
    decls = []
    st = [unit.body]
    while st:
        n = st.pop()
        if n.type == "local_declaration_statement" and not any(c.type == "using" for c in n.children):
            for vd in n.named_children:
                if vd.type == "variable_declaration":
                    for d in vd.named_children:
                        if d.type == "variable_declarator":
                            nm = d.child_by_field_name("name") or (d.named_children[0] if d.named_children else None)
                            if nm is not None and text(nm) != "_":
                                decls.append(nm)
        st.extend(n.children)
    if not decls:
        return out
    counts = defaultdict(int)
    for idn in identifiers(unit.body):
        counts[text(idn)] += 1
    for nm in decls:
        if counts[text(nm)] <= 1:
            out.append((nm.start_point[0] + 1, text(nm)))
    return out


def unreachable(unit) -> list:
    """Statements following return/throw/break/continue/goto in the same block."""
    out = []
    st = [unit.body]
    while st:
        n = st.pop()
        if n.type == "block":
            stmts = [c for c in n.named_children if c.type != "comment"]
            for i, s in enumerate(stmts[:-1]):
                if s.type in ("return_statement", "throw_statement", "break_statement",
                              "continue_statement", "goto_statement"):
                    nxt = stmts[i + 1]
                    if nxt.type not in ("labeled_statement", "local_function_statement"):
                        out.append((nxt.start_point[0] + 1, nxt.type))
                    break
        st.extend(n.children)
    return out


def public_mutable_fields(parts) -> list:
    out = []
    for p in parts:
        if p.kind not in ("class", "struct", "record"):
            continue
        for f in p.fields:
            if f.is_auto_property or f.is_const or f.is_readonly:
                continue
            if f.mods & {"public", "protected"}:
                out.append((p.file, f.line, f.name, p.kind))
    return out
