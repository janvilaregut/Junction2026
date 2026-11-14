"""Entity extraction: namespaces, types, members and units (method-like bodies)."""
from __future__ import annotations

from dataclasses import dataclass, field

TYPE_NODES = {"class_declaration", "struct_declaration", "record_declaration",
              "record_struct_declaration", "interface_declaration", "enum_declaration"}
UNIT_NODES = {"method_declaration", "constructor_declaration", "destructor_declaration",
              "operator_declaration", "conversion_operator_declaration"}
PROP_NODES = {"property_declaration", "indexer_declaration", "event_declaration"}
NS_NODES = {"namespace_declaration", "file_scoped_namespace_declaration"}


def text(n) -> str:
    return n.text.decode("utf8", "replace") if n is not None else ""


def line0(n) -> int:
    return n.start_point[0] + 1


def line1(n) -> int:
    return n.end_point[0] + 1


def modifiers(n) -> set[str]:
    return {text(c) for c in n.children if c.type == "modifier"}


def has_attributes(n) -> bool:
    return any(c.type == "attribute_list" for c in n.children)


def doc_comment_before(n) -> bool:
    p = n.prev_sibling
    while p is not None and p.type == "comment":
        if text(p).lstrip().startswith("///"):
            return True
        p = p.prev_sibling
    return False


@dataclass
class Unit:
    file: str
    type_qname: str
    name: str
    kind: str                 # method | ctor | dtor | operator | accessor | localfn
    node: object
    body: object
    start: int
    end: int
    params: int
    mods: set
    returns: str = ""
    sloc: int = 0
    cc: int = 1
    cog: int = 0
    nest: int = 0
    is_static: bool = False

    @property
    def qname(self):
        return f"{self.type_qname}.{self.name}"


@dataclass
class Field:
    name: str
    node: object
    mods: set
    line: int
    is_const: bool
    is_static: bool
    is_readonly: bool
    is_auto_property: bool = False
    has_attr: bool = False


@dataclass
class TypeDecl:
    file: str
    ns: str
    name: str
    qname: str
    kind: str
    node: object
    start: int
    end: int
    mods: set
    documented: bool
    bases: list = field(default_factory=list)
    fields: list = field(default_factory=list)
    units: list = field(default_factory=list)
    members: list = field(default_factory=list)  # (kind, name, node, mods, documented, line)
    nested_in: str | None = None

    @property
    def is_abstract(self):
        return self.kind == "interface" or "abstract" in self.mods

    @property
    def visibility(self):
        for v in ("public", "protected", "internal", "private"):
            if v in self.mods:
                return v
        return "internal" if self.nested_in is None else "private"


def _type_kind(t: str) -> str:
    return {"class_declaration": "class", "struct_declaration": "struct",
            "record_declaration": "record", "record_struct_declaration": "record",
            "interface_declaration": "interface", "enum_declaration": "enum"}[t]


def _param_count(n) -> int:
    pl = n.child_by_field_name("parameters")
    if pl is None:
        for c in n.children:
            if c.type in ("parameter_list", "bracketed_parameter_list"):
                pl = c
                break
    if pl is None:
        return 0
    return sum(1 for c in pl.named_children if c.type == "parameter")


def _bases(n) -> list[str]:
    out = []
    for c in n.children:
        if c.type == "base_list":
            for b in c.named_children:
                if b.type in ("identifier", "generic_name", "qualified_name"):
                    t = text(b)
                    out.append(t.split("<")[0].split(".")[-1])
                elif b.type == "primary_constructor_base_type":
                    out.append(text(b).split("(")[0].split("<")[0].split(".")[-1])
    return out


def extract(sf) -> tuple[list[TypeDecl], list[Unit]]:
    """Walk a parsed file and return its type declarations and units."""
    types: list[TypeDecl] = []
    units: list[Unit] = []
    file_ns = ""

    def visit(n, ns: str, outer: TypeDecl | None):
        nonlocal file_ns
        t = n.type
        if t == "file_scoped_namespace_declaration":
            file_ns = text(n.child_by_field_name("name"))
            for c in n.children:
                visit(c, file_ns, outer)
            return
        if t == "namespace_declaration":
            name = text(n.child_by_field_name("name"))
            inner = f"{ns}.{name}" if ns else name
            for c in n.children:
                visit(c, inner, outer)
            return
        if t in TYPE_NODES:
            name = text(n.child_by_field_name("name"))
            q = f"{outer.qname}.{name}" if outer else (f"{ns}.{name}" if ns else name)
            td = TypeDecl(file=sf.path, ns=ns, name=name, qname=q, kind=_type_kind(t), node=n,
                          start=line0(n), end=line1(n), mods=modifiers(n),
                          documented=doc_comment_before(n), bases=_bases(n),
                          nested_in=outer.qname if outer else None)
            types.append(td)
            body = n.child_by_field_name("body")
            if t == "enum_declaration":
                return
            # primary-constructor parameters act like fields
            if body is not None:
                for m in body.children:
                    member(m, td, ns)
            return
        for c in n.children:
            visit(c, ns or file_ns, outer)

    def add_unit(td, name, kind, node, body, params, mods, returns=""):
        u = Unit(file=sf.path, type_qname=td.qname, name=name, kind=kind, node=node, body=body,
                 start=line0(node), end=line1(node), params=params, mods=mods, returns=returns,
                 is_static="static" in mods)
        td.units.append(u)
        units.append(u)

    def member(m, td: TypeDecl, ns):
        t = m.type
        if t in TYPE_NODES:
            visit(m, ns, td)
            return
        if t == "field_declaration" or t == "event_field_declaration":
            mods = modifiers(m)
            vd = next((c for c in m.children if c.type == "variable_declaration"), None)
            if vd is None:
                return
            for d in vd.named_children:
                if d.type == "variable_declarator":
                    nm = text(d.child_by_field_name("name") or d.named_children[0])
                    td.fields.append(Field(nm, d, mods, line0(d), "const" in mods, "static" in mods,
                                           "readonly" in mods, has_attr=has_attributes(m)))
                    td.members.append(("field", nm, m, mods, doc_comment_before(m), line0(d)))
            return
        if t in UNIT_NODES:
            mods = modifiers(m)
            kind = {"method_declaration": "method", "constructor_declaration": "ctor",
                    "destructor_declaration": "dtor"}.get(t, "operator")
            nm_node = m.child_by_field_name("name")
            nm = text(nm_node) if nm_node is not None else ("op_" + kind)
            if t == "operator_declaration":
                op = m.child_by_field_name("operator")
                nm = "operator" + (text(op) if op is not None else "")
            if t == "conversion_operator_declaration":
                nm = "operator_" + text(m.child_by_field_name("type"))
            body = m.child_by_field_name("body")
            if body is None:
                body = next((c for c in m.children if c.type in ("block", "arrow_expression_clause")), None)
            ret = text(m.child_by_field_name("returns") or m.child_by_field_name("type"))
            td.members.append((kind, nm, m, mods, doc_comment_before(m), line0(m)))
            if body is not None:
                add_unit(td, nm, kind, m, body, _param_count(m), mods, ret)
            return
        if t in PROP_NODES:
            mods = modifiers(m)
            nm_node = m.child_by_field_name("name")
            nm = text(nm_node) if nm_node is not None else "this[]"
            td.members.append(("property" if t != "event_declaration" else "event", nm, m, mods,
                               doc_comment_before(m), line0(m)))
            value = m.child_by_field_name("value")
            accessors = m.child_by_field_name("accessors")
            if value is not None and value.type == "arrow_expression_clause":
                add_unit(td, f"{nm}.get", "accessor", m, value, _param_count(m), mods, text(m.child_by_field_name("type")))
                return
            if accessors is None:
                accessors = next((c for c in m.children if c.type == "accessor_list"), None)
            auto = True
            if accessors is not None:
                for a in accessors.named_children:
                    if a.type != "accessor_declaration":
                        continue
                    body = a.child_by_field_name("body") or next(
                        (c for c in a.children if c.type in ("block", "arrow_expression_clause")), None)
                    if body is not None:
                        auto = False
                        an = text(a.child_by_field_name("name")) or "acc"
                        add_unit(td, f"{nm}.{an}", "accessor", a, body, _param_count(m), mods | modifiers(a),
                                 text(m.child_by_field_name("type")))
            if auto and t == "property_declaration":
                td.fields.append(Field(nm, m, mods, line0(m), False, "static" in mods,
                                       False, is_auto_property=True, has_attr=has_attributes(m)))
            return

    visit(sf.root, "", None)
    return types, units


def local_functions(unit: Unit) -> list:
    out, st = [], [unit.body]
    while st:
        n = st.pop()
        if n.type == "local_function_statement":
            out.append(n)
        st.extend(n.children)
    return out
