"""Unit-level size and complexity metrics.

Definitions (all on the tree-sitter C# syntax tree of one unit body):

McCabe cyclomatic complexity  CC = 1 + |D| where D is the multiset of decision
points: if, while, do, for, foreach, each `case` label (not `default`), each
non-discard switch-expression arm, catch, ?:, &&, ||, ??, and/or patterns.

Cognitive complexity (Campbell 2018, SonarSource):
  +1 (+nesting) for if, ?:, switch (statement or expression), for, foreach,
     while, do, catch;   +1 (no nesting) for else-if, else, goto,
     each change of operator in a sequence of && / ||, each recursive call.
  nesting +1 inside the bodies of the above and inside lambdas/local functions.

Max nesting depth: deepest chain of nested control structures (else-if
chains count as one level).

SLOC: number of distinct physical lines of the unit carrying a code token.
"""
from __future__ import annotations

LOOPS = {"while_statement", "do_statement", "for_statement", "foreach_statement"}
NESTERS = LOOPS | {"if_statement", "switch_statement", "switch_expression", "try_statement",
                   "catch_clause", "using_statement", "lock_statement", "fixed_statement",
                   "checked_statement", "unsafe_statement"}
FUNC_LIKE = {"lambda_expression", "anonymous_method_expression", "local_function_statement"}
LOGIC = {"&&", "||"}


def _op(n):
    o = n.child_by_field_name("operator")
    return o.type if o is not None else None


def decision_points(body) -> list[tuple[str, int]]:
    """Return [(kind, line)] for every McCabe decision point under `body`."""
    out, st = [], [body]
    while st:
        n = st.pop()
        t = n.type
        ln = n.start_point[0] + 1
        if t in ("if_statement", "while_statement", "do_statement", "for_statement",
                 "foreach_statement", "catch_clause", "conditional_expression"):
            out.append((t, ln))
        elif t == "switch_section":
            for c in n.children:
                if c.type == "case":
                    out.append(("case", c.start_point[0] + 1))
        elif t == "switch_expression_arm":
            pat = n.named_children[0] if n.named_children else None
            if pat is None or pat.type != "discard" and pat.text != b"_":
                out.append(("arm", ln))
        elif t == "binary_expression" and _op(n) in ("&&", "||", "??"):
            out.append((_op(n), ln))
        elif t in ("and_pattern", "or_pattern"):
            out.append((t, ln))
        st.extend(n.children)
    return out


def cyclomatic(body) -> int:
    return 1 + len(decision_points(body))


def _logic_ops(n, acc):
    """In-order list of && / || operators in a logical expression chain."""
    t = n.type
    if t == "binary_expression" and _op(n) in LOGIC:
        _logic_ops(n.child_by_field_name("left"), acc)
        acc.append(_op(n))
        _logic_ops(n.child_by_field_name("right"), acc)
    elif t == "parenthesized_expression" and n.named_child_count == 1:
        _logic_ops(n.named_children[0], acc)
    return acc


def _logic_operands(n, acc):
    t = n.type
    if t == "binary_expression" and _op(n) in LOGIC:
        _logic_operands(n.child_by_field_name("left"), acc)
        _logic_operands(n.child_by_field_name("right"), acc)
    elif t == "parenthesized_expression" and n.named_child_count == 1 and \
            n.named_children[0].type == "binary_expression" and _op(n.named_children[0]) in LOGIC:
        _logic_operands(n.named_children[0], acc)
    else:
        acc.append(n)
    return acc


def cognitive(body, fname: str = "", trace: list | None = None) -> int:
    """Cognitive complexity of a unit body. If `trace` is a list, increments
    are appended as (line, amount, reason) for explainability."""
    def inc(n, amount, why):
        if trace is not None:
            trace.append((n.start_point[0] + 1, amount, why))
        return amount

    def walk(n, nest) -> int:
        t = n.type
        s = 0
        if t == "if_statement":
            s += inc(n, 1 + nest, f"if (nesting {nest})")
            return s + _if_parts(n, nest)
        if t in LOOPS:
            s += inc(n, 1 + nest, f"{t.split('_')[0]} (nesting {nest})")
            for c in n.children:
                s += walk(c, nest + 1)
            return s
        if t in ("switch_statement", "switch_expression"):
            s += inc(n, 1 + nest, f"switch (nesting {nest})")
            for c in n.children:
                s += walk(c, nest + 1)
            return s
        if t == "catch_clause":
            s += inc(n, 1 + nest, f"catch (nesting {nest})")
            for c in n.children:
                s += walk(c, nest + 1)
            return s
        if t == "conditional_expression":
            s += inc(n, 1 + nest, f"?: (nesting {nest})")
            for c in n.children:
                s += walk(c, nest + 1)
            return s
        if t in FUNC_LIKE:
            for c in n.children:
                s += walk(c, nest + 1)
            return s
        if t == "goto_statement":
            s += inc(n, 1, "goto")
        if t == "binary_expression" and _op(n) in LOGIC:
            ops = _logic_ops(n, [])
            seqs = sum(1 for i, o in enumerate(ops) if i == 0 or o != ops[i - 1])
            s += inc(n, seqs, f"boolean operator sequence {' '.join(ops)}")
            for operand in _logic_operands(n, []):
                s += walk(operand, nest)
            return s
        if t == "invocation_expression" and fname:
            f = n.child_by_field_name("function")
            if f is not None:
                callee = f.text.decode("utf8", "replace").split("<")[0]
                if callee == fname or callee == f"this.{fname}":
                    s += inc(n, 1, "recursion")
        for c in n.children:
            s += walk(c, nest)
        return s

    def _if_parts(n, nest) -> int:
        s = 0
        cond = n.child_by_field_name("condition")
        if cond is not None:
            s += walk(cond, nest)
        cons = n.child_by_field_name("consequence")
        if cons is not None:
            s += walk(cons, nest + 1)
        alt = n.child_by_field_name("alternative")
        if alt is not None:
            if alt.type == "if_statement":
                s += inc(alt, 1, "else if")
                s += _if_parts(alt, nest)
            else:
                s += inc(alt, 1, "else")
                s += walk(alt, nest + 1)
        return s

    return walk(body, 0)


def max_nesting(body) -> tuple[int, int]:
    """(depth, line of deepest structure)."""
    best = (0, body.start_point[0] + 1)
    st = [(body, 0)]
    while st:
        n, d = st.pop()
        t = n.type
        nd = d
        if t in NESTERS:
            parent = n.parent
            is_else_if = (t == "if_statement" and parent is not None and parent.type == "if_statement"
                          and parent.child_by_field_name("alternative") == n)
            if not is_else_if:
                nd = d + 1
                if nd > best[0]:
                    best = (nd, n.start_point[0] + 1)
        for c in n.children:
            st.append((c, nd))
    return best


def sloc(unit_start: int, unit_end: int, code_lines: set) -> int:
    return sum(1 for ln in range(unit_start, unit_end + 1) if ln in code_lines)


def measure_units(sf, units) -> None:
    for u in units:
        u.sloc = sloc(u.start, u.end, sf.code_lines)
        u.cc = cyclomatic(u.body)
        u.cog = cognitive(u.body, u.name)
        u.nest = max_nesting(u.body)[0]
