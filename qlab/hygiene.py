"""Clean-code micro-practices: naming, error handling, magic numbers,
documentation, comment hygiene and style consistency (normalised entropy)."""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

from .model import text, line0
from .source import parser

# ---------------------------------------------------------------- naming
PASCAL = re.compile(r"^@?[A-Z][A-Za-z0-9]*$")
CAMEL = re.compile(r"^@?[a-z][A-Za-z0-9]*$")
UCAMEL = re.compile(r"^_[a-z][A-Za-z0-9]*$")
SCAMEL = re.compile(r"^[sm]_[a-z][A-Za-z0-9]*$")
IFACE = re.compile(r"^I[A-Z][A-Za-z0-9]*$")
TPARAM = re.compile(r"^T([A-Z][A-Za-z0-9]*)?$")
# allowlist from research/06 (i,j,k,n,x,y,z,e,_,T) plus common two-letter words
ALLOWED_SHORT = {"i", "j", "k", "n", "x", "y", "z", "e", "_", "T", "ex", "id", "ok", "io", "ip", "op", "to",
                 "db", "ms", "os", "ui"}
TECH = set("""
async await bool int uint ulong ushort sbyte byte char str string len args arg param params config cfg
utf utf8 utf16 ascii json xml http https url uri api id ids dto enum enums impl init len max min msg
src dst buf tmp temp ctx env obj val vals var func ptr ref refs util utils info meta lz4 msgpack
dict lhs rhs idx num nums pos prev curr cur req res resp exe dll ns tuple tuples nullable readonly
deserialize deserializer deserialization serialize serializer serialization formatter formatters resolver
resolvers enumerable enumerator iterator getter setter metadata typeless datetime timestamp unicode
inline lowercase uppercase namespace namespaces assembly assemblies runtime analyzer analyzers codegen
roslyn ctor ctors dtor intrinsics simd avx sse vector unmanaged bitwise endian struct structs
""".split())
WORD_SPLIT = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")


@lru_cache(maxsize=1)
def dictionary() -> frozenset:
    words = set(TECH)
    p = Path("/usr/share/dict/words")
    if p.exists():
        words |= {w.strip().lower() for w in p.read_text(errors="ignore").split() if len(w) > 1}
    return frozenset(words)


def split_words(name: str) -> list[str]:
    return [w.lower() for w in WORD_SPLIT.findall(name.lstrip("@_"))]


def declarations(sf, types, units):
    """Yield (kind, name, line, extra) for every declared identifier in the file."""
    for t in types:
        yield ("interface" if t.kind == "interface" else "type", t.name, t.start, {"node": t.node})
        tpl = t.node.child_by_field_name("type_parameters")
        if tpl is not None:
            for tp in tpl.named_children:
                if tp.type == "type_parameter":
                    yield ("type_parameter", text(tp.child_by_field_name("name") or tp), line0(tp), {})
        for kind, name, node, mods, _doc, line in t.members:
            if kind == "field":
                if "const" in mods:
                    yield ("constant", name, line, {})
                elif mods & {"public", "protected", "internal"}:
                    yield ("visible_field", name, line, {})
                elif "static" in mods:
                    yield ("private_static_field", name, line, {})
                else:
                    yield ("private_field", name, line, {})
            elif kind in ("method", "property", "event"):
                yield (kind, name, line, {"node": node, "mods": mods})
        if t.kind == "enum":
            body = t.node.child_by_field_name("body")
            if body is not None:
                for m in body.named_children:
                    if m.type == "enum_member_declaration":
                        nm = m.child_by_field_name("name") or m.named_children[0]
                        yield ("enum_member", text(nm), line0(m), {})
    for u in units:
        if u.kind in ("method", "ctor", "operator", "accessor"):
            pl = u.node.child_by_field_name("parameters")
            if pl is not None:
                for p in pl.named_children:
                    if p.type == "parameter":
                        nm = p.child_by_field_name("name")
                        if nm is not None:
                            yield ("parameter", text(nm), line0(p), {})
        st = [u.body]
        while st:
            n = st.pop()
            if n.type == "variable_declarator" and n.parent is not None and n.parent.parent is not None \
                    and n.parent.parent.type == "local_declaration_statement":
                nm = n.child_by_field_name("name") or (n.named_children[0] if n.named_children else None)
                if nm is not None:
                    is_const = any(text(c) == "const" for c in n.parent.parent.children)
                    yield ("local_const" if is_const else "local", text(nm), line0(n), {"in_for": False})
            elif n.type == "for_statement":
                for c in n.named_children:
                    if c.type == "variable_declaration":
                        for d in c.named_children:
                            if d.type == "variable_declarator":
                                nm = d.child_by_field_name("name") or d.named_children[0]
                                yield ("local", text(nm), line0(d), {"in_for": True})
            elif n.type == "foreach_statement":
                left = n.child_by_field_name("left")
                if left is not None and left.type == "identifier":
                    yield ("local", text(left), line0(n), {"in_for": True})
            elif n.type == "local_function_statement":
                nm = n.child_by_field_name("name")
                if nm is not None:
                    yield ("method", text(nm), line0(n), {"node": n, "mods": set()})
            st.extend(n.children)


CONVENTION = {
    "type": PASCAL, "method": PASCAL, "property": PASCAL, "event": PASCAL, "enum_member": PASCAL,
    "constant": PASCAL, "visible_field": PASCAL, "interface": IFACE, "type_parameter": TPARAM,
    "parameter": CAMEL, "local": CAMEL,
}
LOCAL_CONST = re.compile(r"^@?[A-Za-z][A-Za-z0-9]*$")
BOOL_TYPES = {"bool", "Boolean", "System.Boolean", "bool?", "Task<bool>", "ValueTask<bool>"}


def naming_findings(decls, field_style: str | None = None, vocab: Counter | None = None):
    """Return list of (line, kind, name, severity, rule, message)."""
    out = []
    words = dictionary()
    for kind, name, line, extra in decls:
        nm = name.lstrip("@")
        if nm == "this[]":
            continue
        if kind == "local_const" and not LOCAL_CONST.match(nm):
            out.append((line, kind, name, 1.0, "naming.convention", f"local constant '{name}' is neither PascalCase nor camelCase"))
            continue
        if kind in CONVENTION:
            rx = CONVENTION[kind]
            if not rx.match(nm) and not (kind == "constant" and re.match(r"^[A-Z][A-Z0-9_]*$", nm)):
                out.append((line, kind, name, 1.0, "naming.convention",
                            f"{kind} '{name}' violates .NET convention ({rx.pattern})"))
                continue
        elif kind in ("private_field", "private_static_field"):
            ok = (UCAMEL.match(nm) or CAMEL.match(nm) or SCAMEL.match(nm) or
                  (kind == "private_static_field" and PASCAL.match(nm)))
            if not ok:
                out.append((line, kind, name, 1.0, "naming.convention", f"private field '{name}' has no recognised convention"))
                continue
            if field_style and kind == "private_field":
                style = "_camel" if UCAMEL.match(nm) else ("camel" if CAMEL.match(nm) else "other")
                if style != field_style:
                    out.append((line, kind, name, 0.5, "naming.inconsistent",
                                f"private field '{name}' uses {style}; repository majority is {field_style}"))
        # descriptiveness
        if len(nm) <= 2 and nm not in ALLOWED_SHORT and not (kind == "type_parameter"):
            if not (kind == "local" and extra.get("in_for")):
                out.append((line, kind, name, 0.5, "naming.too_short", f"{kind} '{name}' is too short to be descriptive"))
                continue
        unknown = [w for w in split_words(nm) if len(w) >= 3 and not w.isdigit() and w not in words
                   and not (vocab and vocab[w] >= 5)]
        if unknown:
            out.append((line, kind, name, 0.25, "naming.abbreviation",
                        f"'{name}' contains non-dictionary token(s) {unknown} (likely abbreviation)"))
        # linguistic antipatterns (Arnaoudova et al. 2013/2016)
        if kind in ("method", "property") and extra.get("node") is not None:
            node = extra["node"]
            ret = text(node.child_by_field_name("returns") or node.child_by_field_name("type")).replace(" ", "")
            ws = split_words(nm)
            mods = extra.get("mods") or set()
            if "override" in mods or "." in nm:
                ws = []          # exempt overrides / explicit interface implementations
            if ret in ("Task", "ValueTask"):
                ret = "void"
            if kind == "method" and ws and ws[0] == "get" and ret == "void":
                out.append((line, kind, name, 1.0, "naming.lap.get_returns_void",
                            f"'{name}' starts with Get but returns void (linguistic antipattern)"))
            if ws and ws[0] in ("is", "has", "can", "should") and ret and ret not in BOOL_TYPES:
                out.append((line, kind, name, 1.0, "naming.lap.predicate_not_bool",
                            f"'{name}' reads as a predicate but returns {ret} (linguistic antipattern)"))
            if kind == "method" and ws and ws[0] == "set" and ret not in ("void", "", "Task", "ValueTask"):
                out.append((line, kind, name, 0.5, "naming.lap.set_returns_value",
                            f"'{name}' starts with Set but returns {ret}"))
    return out


# ---------------------------------------------------------------- error handling
GENERAL_EXC = {"Exception", "System.Exception"}
RESERVED_THROW = {"Exception", "SystemException", "ApplicationException", "NullReferenceException",
                  "IndexOutOfRangeException", "OutOfMemoryException", "ExecutionEngineException",
                  "StackOverflowException", "System.Exception"}


def error_handling(sf):
    """Return (population, findings) where findings = (line, severity, rule, msg)."""
    pop, out = 0, []
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type == "catch_clause":
            pop += 1
            decl = next((c for c in n.children if c.type == "catch_declaration"), None)
            filt = any(c.type == "catch_filter_clause" for c in n.children)
            body = n.child_by_field_name("body")
            ctype = text(decl.child_by_field_name("type")) if decl is not None else ""
            cvar = decl.child_by_field_name("name") if decl is not None else None
            stmts = [c for c in body.named_children if c.type != "comment"] if body is not None else []
            has_comment = body is not None and any(c.type == "comment" for c in body.named_children)
            rethrows = False
            for t in _descendants(body, "throw_statement"):
                ex = t.named_children[0] if t.named_children else None
                if ex is None:
                    rethrows = True
                elif cvar is not None and ex.type == "identifier" and text(ex) == text(cvar):
                    out.append((line0(t), 1.0, "errors.throw_ex",
                                f"'throw {text(ex)};' resets the stack trace (CA2200); use 'throw;'"))
                    rethrows = True
                elif ex.type == "object_creation_expression":
                    rethrows = True
            if not stmts:
                out.append((line0(n), 0.5 if has_comment else 1.0, "errors.empty_catch",
                            "empty catch block swallows the exception" + (" (commented)" if has_comment else "")))
            elif (decl is None or ctype in GENERAL_EXC) and not rethrows:
                out.append((line0(n), 0.3 if filt else 0.7, "errors.catch_general",
                            f"catch-all ({ctype or 'no type'}) without rethrow (CA1031)"))
            elif len(stmts) == 1 and stmts[0].type == "throw_statement" and not stmts[0].named_children:
                out.append((line0(n), 0.3, "errors.useless_catch", "catch block only rethrows"))
        elif n.type == "throw_statement" or n.type == "throw_expression":
            ex = n.named_children[0] if n.named_children else None
            if ex is not None and ex.type == "object_creation_expression":
                pop += 1
                ty = text(ex.child_by_field_name("type"))
                if ty in RESERVED_THROW:
                    out.append((line0(n), 0.5, "errors.reserved_exception",
                                f"throws reserved/general exception type {ty} (CA2201)"))
        st.extend(n.children)
    return pop, out


def _descendants(n, typ):
    if n is None:
        return []
    out, st = [], [n]
    while st:
        x = st.pop()
        if x.type == typ:
            out.append(x)
        st.extend(x.children)
    return out


# ---------------------------------------------------------------- magic numbers
IGNORED_NUMBERS = {0.0, 1.0, 2.0, -1.0}


def _num(s: str):
    s = s.lower().replace("_", "")
    s = re.sub(r"(ul|lu|u|l|f|d|m)$", "", s) if not s.startswith("0x") else re.sub(r"(ul|lu|u|l)$", "", s)
    try:
        if s.startswith("0x"):
            return float(int(s, 16))
        if s.startswith("0b"):
            return float(int(s[2:], 2))
        return float(s)
    except ValueError:
        return None


def _exempt(n) -> bool:
    p = n.parent
    while p is not None:
        t = p.type
        if t in ("attribute_argument", "attribute_list", "enum_member_declaration"):
            return True
        if t == "field_declaration":
            mods = {text(c) for c in p.children if c.type == "modifier"}
            return "const" in mods or "readonly" in mods
        if t == "local_declaration_statement":
            return any(text(c) == "const" for c in p.children)
        if t == "method_declaration":
            nm = p.child_by_field_name("name")
            return nm is not None and text(nm) == "GetHashCode"
        if t in ("parameter",):
            return True           # default parameter values are named by the parameter
        p = p.parent
    return False


def magic_numbers(sf):
    out = []
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type in ("integer_literal", "real_literal"):
            v = _num(text(n))
            neg = n.parent is not None and n.parent.type == "prefix_unary_expression" and text(n.parent).startswith("-")
            if v is not None and neg:
                v = -v
            if v is not None and v not in IGNORED_NUMBERS and not _exempt(n):
                out.append((line0(n), text(n)))
            continue
        st.extend(n.children)
    return out


# ---------------------------------------------------------------- documentation & comments
def effective_public(t, by_qname) -> bool:
    cur = t
    while cur is not None:
        if "public" not in cur.mods and not (cur.nested_in and "protected" in cur.mods):
            return False
        cur = by_qname.get(cur.nested_in) if cur.nested_in else None
    return True


def api_documentation(types, by_qname):
    """Return list of (file, line, kind, name, documented)."""
    out = []
    for t in types:
        if not effective_public(t, by_qname):
            continue
        out.append((t.file, t.start, t.kind, t.qname, t.documented))
        for kind, name, node, mods, doc, line in t.members:
            if t.kind == "interface" or mods & {"public", "protected"}:
                if "private" in mods:
                    continue
                out.append((t.file, line, kind, f"{t.qname}.{name}", doc))
    return out


SATD = re.compile(r"\b(TODO|FIXME|HACK|XXX|KLUDGE|WORKAROUND|TEMP(?:ORARY)? FIX)\b", re.I)


def comments(sf):
    """Yield (line_start, line_end, text) for every comment node."""
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type == "comment":
            yield (n.start_point[0] + 1, n.end_point[0] + 1, text(n))
            continue
        st.extend(n.children)


def _parses_as_code(snippet: str) -> bool:
    snippet = snippet.strip()
    if len(snippet) < 6 or not re.search(r"[;{}()=]", snippet):
        return False
    if re.match(r"^(see|note|todo|e\.g|i\.e|http|copyright|licensed)\b", snippet, re.I):
        return False
    for wrap in ("class __Q {{ void __M() {{ {} }} }}", "class __Q {{ {} }}"):
        tree = parser().parse(wrap.format(snippet).encode("utf8"))
        if not tree.root_node.has_error:
            # require at least one real statement/member beyond an expression of one identifier
            body_text = snippet.replace(" ", "")
            if re.fullmatch(r"[A-Za-z_]\w*;?", body_text):
                return False
            return True
    return False


def comment_hygiene(sf):
    """SATD markers and commented-out code blocks. Returns (satd, code_blocks)."""
    satd, blocks = [], []
    run: list[tuple[int, str]] = []

    def flush():
        if not run:
            return
        joined = "\n".join(t for _, t in run)
        if _parses_as_code(joined):
            blocks.append((run[0][0], run[-1][0], joined[:120]))
        else:
            for ln, t in run:
                if _parses_as_code(t):
                    blocks.append((ln, ln, t[:120]))
        run.clear()

    prev = None
    for a, b, t in sorted(comments(sf)):
        if SATD.search(t):
            satd.append((a, t.strip()[:140]))
        if t.startswith("///"):
            continue
        if t.startswith("//"):
            body = t[2:]
            if prev is not None and a != prev + 1:
                flush()
            run.append((a, body))
            prev = a
        else:
            flush()
            prev = None
            inner = t[2:-2] if t.startswith("/*") else t
            if _parses_as_code(inner):
                blocks.append((a, b, inner.strip()[:120]))
    flush()
    return satd, blocks


# ---------------------------------------------------------------- style consistency
def style_observations(sf):
    """Return {convention: [(choice, line)]} for categorical style decisions."""
    obs = defaultdict(list)
    lines = sf.raw.split("\n")
    for i, ln in enumerate(lines, 1):
        if i not in sf.code_lines:
            continue
        lead = ln[:len(ln) - len(ln.lstrip())]
        if lead:
            obs["indent_char"].append(("tab" if "\t" in lead else "space", i))
            if "\t" not in lead:
                obs["indent_multiple_of_4"].append(("yes" if len(lead) % 4 == 0 else "no", i))
        obs["trailing_whitespace"].append(("yes" if ln != ln.rstrip() else "no", i))
    st = [sf.root]
    while st:
        n = st.pop()
        t = n.type
        if t in ("block", "declaration_list", "switch_body", "accessor_list"):
            br = n.children[0] if n.children else None
            if br is not None and br.type == "{" and br.start_point[0] != br.end_point[0] + 1:
                row = br.start_point[0]
                before = lines[row][:br.start_point[1]].strip() if row < len(lines) else ""
                if n.parent is not None and n.parent.start_point[0] != row or before == "":
                    obs["brace_style"].append(("own_line" if before == "" else "end_of_line", row + 1))
        elif t == "if_statement":
            cons = n.child_by_field_name("consequence")
            if cons is not None:
                obs["if_braces"].append(("braced" if cons.type == "block" else "unbraced", line0(n)))
        elif t == "local_declaration_statement":
            vd = next((c for c in n.children if c.type == "variable_declaration"), None)
            ty = vd.child_by_field_name("type") if vd is not None else None
            if ty is not None:
                obs["var_usage"].append(("var" if ty.type == "implicit_type" else "explicit", line0(n)))
        elif t == "predefined_type" or (t == "identifier" and text(n) in ("String", "Int32", "Boolean", "Object")):
            tx = text(n)
            if tx in ("string", "int", "bool", "object"):
                obs["builtin_alias"].append(("alias", line0(n)))
            elif tx in ("String", "Int32", "Boolean", "Object") and (n.parent is None or n.parent.type != "member_access_expression"
                                                                      or n.parent.child_by_field_name("expression") != n):
                obs["builtin_alias"].append(("framework_name", line0(n)))
        st.extend(n.children)
    return obs


def consistency(obs_all: dict):
    """For each convention: majority choice, share, normalised entropy, deviations."""
    out = {}
    for conv, items in obs_all.items():
        cnt = Counter(c for c, _ in items)
        total = sum(cnt.values())
        if total == 0:
            continue
        maj, mc = cnt.most_common(1)[0]
        k = len(cnt)
        H = -sum((v / total) * math.log2(v / total) for v in cnt.values())
        Hn = H / math.log2(k) if k > 1 else 0.0
        out[conv] = dict(majority=maj, share=mc / total, entropy=H, norm_entropy=Hn, counts=dict(cnt), total=total)
    return out
