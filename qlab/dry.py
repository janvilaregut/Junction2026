"""DRY: clone detection on normalised token streams + unit-level near-miss clones
+ statement-level micro-clones.

Formal definition (Type-1/Type-2, token based, after Kamiya et al. 2002 / PMD-CPD):
  Let N_f = n_1..n_k be the normalised token sequence of file f (identifiers -> ID,
  literals -> LIT, comments/usings/attributes removed). A token n_i is *duplicated*
  iff some window N_f[j..j+W-1] with j <= i < j+W also occurs at another position
  (f', j') with (f', j') non-overlapping. Windows with token diversity below delta
  (|set(window)|/W < delta) are ignored (they are tables/literal lists, not logic).
  Duplicated lines DL = lines carrying a duplicated token, restricted to regions
  spanning >= L code lines.  Duplicated-line density  d = |DL| / |code lines|.
Type-3 (near-miss): units with >= T tokens whose 5-gram shingle sets have
  Jaccard similarity >= tau (SourcererCC-style overlap).
Micro-clones: identical (whitespace-normalised) statements of >= m tokens that
  occur >= 3 times inside one file (Mondal et al.'s micro-clones).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from scipy import sparse

MOD = (1 << 61) - 1
BASE = 1_000_003


@dataclass
class CloneRegion:
    file: str
    start: int
    end: int
    tokens: int
    clone_type: int               # 1 exact, 2 renamed
    cls: int = -1                  # clone class id
    partners: set = field(default_factory=set)   # {(file, start_line)}


@dataclass
class DryResult:
    regions: list
    classes: dict                  # cls -> list[CloneRegion]
    dup_lines: dict                # file -> set(lines)  (type 1/2)
    near_miss: list                # (unitA, unitB, jaccard)
    near_lines: dict               # file -> set(lines)
    micro: list                    # (file, [lines], text)
    micro_lines: dict
    params: dict


def _ids(files, exact: bool = False):
    vocab: dict[str, int] = {}
    arrs = []
    k = 1 if exact else 0
    for f in files:
        arrs.append(np.fromiter((vocab.setdefault(t[k], len(vocab)) for t in f.tokens), dtype=np.int64,
                                count=len(f.tokens)))
    return arrs, vocab


def _window_hashes(a: np.ndarray, W: int) -> list[int]:
    n = len(a)
    if n < W:
        return []
    powW = pow(BASE, W, MOD)
    h = 0
    out = []
    vals = a.tolist()
    for i in range(W):
        h = (h * BASE + vals[i] + 1) % MOD
    out.append(h)
    for i in range(W, n):
        h = (h * BASE + vals[i] + 1 - (vals[i - W] + 1) * powW) % MOD
        out.append(h)
    return out


def detect(files, W: int = 50, min_lines: int = 6, diversity: float = 0.25,
           near_min_tokens: int = 40, near_tau: float = 0.7, micro_min_tokens: int = 10,
           units_by_file: dict | None = None, exact: bool = False,
           with_extras: bool = True) -> DryResult:
    """exact=True -> Type-1 only (identifiers/literals kept, comparable to CPD/Sonar defaults)."""
    arrs, _ = _ids(files, exact)
    buckets: dict[int, list] = defaultdict(list)
    for fi, a in enumerate(arrs):
        for j, h in enumerate(_window_hashes(a, W)):
            buckets[h].append((fi, j))

    marked = [np.zeros(len(a), dtype=np.int8) for a in arrs]        # 0 none, 1 type1, 2 type2
    links: list[list] = []                                         # groups of (fi, j)
    for occ in buckets.values():
        if len(occ) < 2:
            continue
        fi0, j0 = occ[0]
        win = arrs[fi0][j0:j0 + W]
        if len(set(win.tolist())) < diversity * W:
            continue
        # verify equality (hash collisions) and drop same-file overlapping occurrences
        groups: dict[tuple, list] = defaultdict(list)
        for fi, j in occ:
            groups[tuple(arrs[fi][j:j + W].tolist())].append((fi, j))
        for g in groups.values():
            kept = []
            for fi, j in sorted(g):
                if kept and kept[-1][0] == fi and j - kept[-1][1] < W:
                    continue
                kept.append((fi, j))
            if len(kept) < 2:
                continue
            exact0 = [t[1] for t in files[kept[0][0]].tokens[kept[0][1]:kept[0][1] + W]]
            for fi, j in kept:
                ex = [t[1] for t in files[fi].tokens[j:j + W]]
                typ = 1 if ex == exact0 else 2
                seg = marked[fi][j:j + W]
                np.maximum(seg, np.where(seg == 0, typ, np.minimum(seg, typ)), out=seg)
            links.append(kept)

    # regions = maximal runs of marked tokens
    regions: list[CloneRegion] = []
    tok_region = [np.full(len(a), -1, dtype=np.int64) for a in arrs]
    for fi, m in enumerate(marked):
        toks = files[fi].tokens
        i, n = 0, len(m)
        while i < n:
            if m[i] == 0:
                i += 1
                continue
            j = i
            while j < n and m[j] != 0:
                j += 1
            lines = {toks[k][2] for k in range(i, j)}
            code = lines & files[fi].code_lines
            if len(code) >= min_lines:
                typ = 2 if (m[i:j] == 2).any() else 1
                regions.append(CloneRegion(files[fi].path, min(lines), max(lines), j - i, typ))
                tok_region[fi][i:j] = len(regions) - 1
            i = j

    # clone classes by union-find over linked windows
    parent = list(range(len(regions)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for kept in links:
        rs = [int(tok_region[fi][j]) for fi, j in kept if tok_region[fi][j] >= 0]
        for r in rs[1:]:
            parent[find(r)] = find(rs[0])
        for r in rs:
            for r2 in rs:
                if r2 != r:
                    regions[r].partners.add((regions[r2].file, regions[r2].start))
    classes: dict[int, list] = defaultdict(list)
    for i, r in enumerate(regions):
        r.cls = find(i)
        classes[r.cls].append(r)

    dup_lines: dict[str, set] = defaultdict(set)
    for r in regions:
        f = next(ff for ff in files if ff.path == r.file)
        dup_lines[r.file] |= {ln for ln in range(r.start, r.end + 1) if ln in f.code_lines}

    if with_extras:
        near, near_lines = near_miss(files, units_by_file or {}, near_min_tokens, near_tau, dup_lines)
        micro, micro_lines = micro_clones(files, micro_min_tokens)
    else:
        near, near_lines, micro, micro_lines = [], {}, [], {}
    return DryResult(regions, dict(classes), dict(dup_lines), near, near_lines, micro, micro_lines,
                     dict(W=W, exact=exact, min_lines=min_lines, diversity=diversity, near_min_tokens=near_min_tokens,
                          near_tau=near_tau, micro_min_tokens=micro_min_tokens))


def _unit_tokens(f, u):
    return [t[0] for t in f.tokens if u.start <= t[2] <= u.end]


def near_miss(files, units_by_file, min_tokens, tau, dup_lines):
    """Type-3 clones between units via Jaccard on 5-gram shingles (sparse product)."""
    units, shingles = [], []
    vocab: dict[int, int] = {}
    for f in files:
        for u in units_by_file.get(f.path, []):
            if u.kind == "accessor":
                continue
            toks = _unit_tokens(f, u)
            if len(toks) < min_tokens:
                continue
            sh = {hash(tuple(toks[i:i + 5])) for i in range(len(toks) - 4)}
            units.append((f, u))
            shingles.append([vocab.setdefault(s, len(vocab)) for s in sh])
    if len(units) < 2:
        return [], {}
    rows = np.repeat(np.arange(len(units)), [len(s) for s in shingles])
    cols = np.fromiter((c for s in shingles for c in s), dtype=np.int64)
    M = sparse.csr_matrix((np.ones(len(cols), dtype=np.float32), (rows, cols)), shape=(len(units), len(vocab)))
    sizes = np.asarray(M.sum(axis=1)).ravel()
    inter = (M @ M.T).tocoo()
    out, lines = [], defaultdict(set)
    for i, j, v in zip(inter.row, inter.col, inter.data):
        if i >= j:
            continue
        jac = v / (sizes[i] + sizes[j] - v)
        if jac < tau:
            continue
        (fa, ua), (fb, ub) = units[i], units[j]
        # skip pairs fully explained by token clones
        la = {ln for ln in range(ua.start, ua.end + 1) if ln in fa.code_lines}
        lb = {ln for ln in range(ub.start, ub.end + 1) if ln in fb.code_lines}
        cov_a = len(la & dup_lines.get(fa.path, set())) / max(1, len(la))
        cov_b = len(lb & dup_lines.get(fb.path, set())) / max(1, len(lb))
        if cov_a > 0.8 and cov_b > 0.8:
            continue
        out.append((ua, ub, float(jac)))
        lines[fa.path] |= la
        lines[fb.path] |= lb
    return out, dict(lines)


STMT_TYPES = {"expression_statement", "local_declaration_statement", "if_statement", "return_statement",
              "throw_statement"}


def micro_clones(files, min_tokens=10, min_count=3):
    out, lines = [], defaultdict(set)
    for f in files:
        seen: dict[str, list] = defaultdict(list)
        st = [f.root]
        while st:
            n = st.pop()
            if n.type in STMT_TYPES and n.end_point[0] - n.start_point[0] <= 6:
                txt = " ".join(n.text.decode("utf8", "replace").split())
                ntok = sum(1 for t in f.tokens if n.start_point[0] + 1 <= t[2] <= n.end_point[0] + 1)
                if ntok >= min_tokens and len(txt) <= 400:
                    seen[txt].append((n.start_point[0] + 1, n.end_point[0] + 1))
                    continue  # do not also count nested statements
            st.extend(n.children)
        for txt, occ in seen.items():
            # nested identical statements (if inside if) are counted once
            if len(occ) >= min_count:
                out.append((f.path, occ, txt))
                for a, b in occ:
                    lines[f.path] |= {ln for ln in range(a, b + 1) if ln in f.code_lines}
    return out, dict(lines)
