// The dependency graph between the functions of a repository, and the network measures that say how much
// depends on each one. Every declared symbol is a node; an edge A -> B means "A uses B" (calls it, constructs
// it, reads it). Built from tokens and names only, so it works on any ref straight from git in milliseconds.
//
// WHAT THE GRAPH IS, AND IS NOT
// It is name-based: there is no type inference and no compiler. A reference is linked by the rules below, and
// what they cannot decide stays unresolved or ambiguous with no edge. Nothing is guessed. So every number
// derived from it (fan-in, dependents, reach, rank) is an ESTIMATE of the real dependency structure, never a
// proof that something is or is not used.
//   It over-approximates where a name is all there is to go by: under rules 3 and 4 a call links to EVERY
//   admissible symbol of that name in the file, namespace or directory, and under rule 5 to up to
//   `maxCandidates` of them anywhere; C# types that share a name inside one namespace (partial parts, generic
//   arities, #if alternatives, and copies of one type kept by several projects or test fixtures of the same
//   repository) are one container; an inherited call links to every nearest base that declares the name.
//   It under-approximates where the target is decided at run time or lies outside what is parsed: dynamic
//   dispatch (a call through an interface or a virtual method links to the declaration that the name finds,
//   not to its overrides), reflection, callbacks and delegates held in variables, member calls with a
//   ubiquitous name on a receiver of unknown type (the stop list: skipped), names carried by more than
//   `maxCandidates` symbols (ambiguous: no edge), code that belongs to no declared symbol (field initialisers,
//   statements at the top of a module), types named only in declarations, casts or generic arguments (a type
//   gets edges from `new T` and `T.member` only), and everything outside the repository.
// `graph.unlinked` counts, per name, the references left without an edge because the name is on the stop list
// or ambiguous; centrality() repeats it per symbol, and a symbol whose name has unlinked references has fan-in
// and dependents that are LOWER BOUNDS. "Nothing depends on it" is only ever "no dependent was found".
//
// RESOLUTION (the first rule that yields candidates wins)
//   1  bare calls and this./self. calls: members of the same container, then what its declared base types
//      hand down (on each branch the nearest type that declares the name) and, for a bare call, the enclosing
//      types. base./super. calls: only what the bases hand down, never the caller's own container.
//   2  JavaScript, TypeScript, Python: the name is imported: the exported or top-level symbol of that name in
//      the file the import path resolves to, following re-exports
//   3  same file      4  same directory, or the same namespace in C#
//   5  anywhere, when at most `maxCandidates` symbols carry the name; more is ambiguous and adds no edge
//   Type.member with Type declared in the repository resolves inside that type only. A member call on a
//   receiver of unknown type (also a this./base. call that rule 1 cannot place) uses rules 4 and 5 and is
//   skipped for stop-list names.
// Arity: when the number of arguments of a call is known, a candidate must admit it (minParams <= n <=
// maxParams; a C# extension method called through its receiver takes n + 1). The exception is a name that
// JavaScript, TypeScript or Python scoping binds to one declaration (rules 1 to 3 there): a wrong argument
// count is then a finding about that call, not a reason to unlink it.
// Scoping facts are used only to REMOVE candidates: a parameter, local variable or local function hides an
// outer name; an identifier bound by an import means that import and nothing else; in a module (a JavaScript
// file with imports or exports, any Python file) a bare name that is neither declared in the file nor
// imported is a global or builtin, never another file's function; a C# static method that is not an extension
// method is not called through an instance.
//
// BASIS
//   Zimmermann, Nagappan 2008, "Predicting Defects using Network Analysis on Dependency Graphs", ICSE,
//     pp. 531-540: on the binaries of Windows Server 2003, defect models built from network measures of the
//     dependency graph had about 10 points more recall than models built from complexity metrics. That is the
//     reason to measure position in the graph at all; it was shown for binaries of one system, so at the level
//     of functions it is a prior for where to look, not a calibrated probability.
//   Inoue, Yokomori, Yamamoto, Matsushita, Kusumoto 2005, "Ranking Significance of Software Components Based
//     on Use Relations", IEEE TSE 31(3), pp. 213-225 (Component Rank): a use relation is a vote for what is
//     used, ranked like PageRank (Brin, Page 1998, "The Anatomy of a Large-Scale Hypertextual Web Search Engine").
//   Arnold, Bohner 1996, "Software Change Impact Analysis", IEEE Computer Society Press: the impact set of a
//     change is what can reach the changed element.
//   Martin 1994, "OO Design Quality Metrics: An Analysis of Dependencies": instability I = Ce / (Ca + Ce),
//     defined there for packages and computed here per symbol.
//   Tarjan 1972, "Depth-First Search and Linear Graph Algorithms", SIAM J. Comput. 1(2): strongly connected
//     components in O(V + E).
//   Del Corso, Gulli, Romani 2005, "Fast PageRank Computation via a Sparse Linear System", Internet
//     Mathematics 2(3): PageRank as the solution of a sparse linear system.
import path from 'node:path';
import { isJsLike } from './lex.js';
import { isTestPath } from './symbols.js';

// Member names so common that a call on a receiver of unknown type says nothing about which declaration is
// meant: the object, collection, string, query, stream and promise vocabulary of the standard libraries.
// Such calls add no edge; they are still listed by callSites (status 'skipped') and counted in graph.unlinked,
// because a repository method that carries one of these names loses real callers this way. The list is kept
// short on purpose: a missing edge understates what depends on a function, which is the unsafe direction.
export const STOPLIST = new Set(`
  ToString Equals GetHashCode GetType Dispose Add AddRange Remove Contains ContainsKey Clear Get Set Write WriteLine Read
  ReadLine Serialize Deserialize Create Count Length Push Pop Any All Select Where First FirstOrDefault Last Single OrderBy
  GroupBy ToArray ToList ToDictionary Concat Distinct Cast Sum Min Max TryGetValue IndexOf CompareTo GetEnumerator MoveNext
  CopyTo Insert Append Substring StartsWith EndsWith Replace Split Join Trim Format Invoke
  map filter forEach reduce push pop shift unshift slice splice join split keys values entries then catch finally toString
  valueOf get set has add delete call apply bind find findIndex some every includes indexOf concat sort reverse trim replace
  match test startsWith endsWith toUpperCase toLowerCase stringify parse log error warn length
  append extend items update strip lower upper format encode decode remove clear count write read contains equals hashCode
  size isEmpty put toArray iterator dispose create serialize deserialize any all select where first
`.split(/\s+/).filter(Boolean));

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const ANGLE = words('cs java ts kt c rs swift dart scala');     // generic arguments are written in angle brackets
const IMPLICIT_THIS = words('cs java kt swift c dart scala');   // a bare name can be a member of the enclosing type
const OVERLOADS = words('cs java kt swift c scala');            // arity selects among members of one name
const CALL_CONSTRUCTS = words('py kt swift dart scala go rs');  // `Name(args)` can build an instance
const NO_NEW = words('py go rs kt swift');
const DECL_BLOCK = words('js ts cs java c dart php');           // `name(…) {` declares a function, it never calls one
const TYPED = words('cs java c dart');                          // `Type name` declares `name`
const FN_KW = words('function func fn fun def');
const HEAD_KW = words('function func fn fun def class struct interface enum record trait');
const DECL_KW = words('const let var val');
const TYPE_KW = words('bool byte char decimal double float int long object sbyte short string uint ulong ushort void var dynamic boolean auto unsigned signed');
const PATTERN_KW = words('is case not or and');
const SELF = words('this self Self $this');
const ACCESS = words('. ?. :: ->');
const GENERIC_OP = words(', . ? [ ] ( ) :: *');
// What may follow the `>` that closes a type-argument list (C# language standard, ECMA-334, "Grammar
// ambiguities"): anything else and `a < b > c` is two comparisons.
const AFTER_GENERIC = words('( ) ] } : ; , . ? == != | ^ { [');
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py'];
const NONE = Object.freeze([]);
const AMBIGUOUS = Object.freeze({ ambiguous: true });
const EXTERNAL = Object.freeze({ external: true });
const SKIP = Object.freeze({ skip: true });

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const isType = (x) => x.s.kind === 'type';
const some = (a) => (a && a.length ? a : null);
const callable = (k) => k === 'method' || k === 'function';
/** Test code: a test case, or any symbol declared in a test file. Never counted as a production dependent. */
const isTestCode = (s) => !!s && (!!s.isTest || isTestPath(s.file));

/** T[i] is '<': the index of the '>' that closes it when everything in between can be a type-argument list, else -1. */
function genericClose(T, i, hi) {
  let d = 0;
  for (let j = i, lim = Math.min(hi, i + 96); j < lim; j++) {
    const t = T[j];
    if (t.k === 'op') {
      if (t.v === '<') d++;
      else if (t.v === '>') { if (--d === 0) return j; }
      else if (!GENERIC_OP.has(t.v)) return -1;
    } else if (t.k !== 'id' && t.k !== 'kw') return -1;
  }
  return -1;
}
/** T[i] is '>': the index of the '<' that opens it, else -1. */
function genericOpen(T, i, lo) {
  let d = 0;
  for (let j = i, lim = Math.max(lo, i - 96); j >= lim; j--) {
    const t = T[j];
    if (t.k === 'op') {
      if (t.v === '>') d++;
      else if (t.v === '<') { if (--d === 0) return j; }
      else if (!GENERIC_OP.has(t.v)) return -1;
    } else if (t.k !== 'id' && t.k !== 'kw') return -1;
  }
  return -1;
}

/**
 * Number of arguments of the call whose '(' is at `open`: commas at depth 0 plus one, 0 for `()`.
 * null when the count is not known from the text: a spread (`...xs`, Python `*xs` / `**kw`), a Python lambda
 * (its parameter commas are not argument commas), or `a < b, c > d`, which is one generic argument or two
 * comparisons depending on types this engine does not have.
 */
function countArgs(T, match, open, lang) {
  const close = match[open];
  if (close < 0) return null;
  if (close === open + 1) return 0;
  const angle = ANGLE.has(lang), py = lang === 'py';
  let n = 1;
  for (let i = open + 1; i < close; i++) {
    const t = T[i];
    if (t.k !== 'op') { if (py && t.k === 'kw' && t.v === 'lambda') return null; continue; }
    const v = t.v;
    if (v === '(' || v === '[' || v === '{' || v === '${') { if (match[i] > i) i = match[i]; continue; }
    if (v === ',') { if (i + 1 < close) n++; continue; } // a trailing comma adds no argument
    if (v === '...') return null;
    if (py && (v === '*' || v === '**')) { const p = T[i - 1]; if (p.k === 'op' && (p.v === '(' || p.v === ',')) return null; continue; }
    if (angle && v === '<' && T[i - 1].k === 'id') {
      const g = genericClose(T, i, close);
      if (g < 0) continue;
      if (g + 1 >= close || (T[g + 1].k === 'op' && AFTER_GENERIC.has(T[g + 1].v))) { i = g; continue; }
      for (let j = i + 1; j < g; j++) if (T[j].k === 'op' && T[j].v === ',') return null;
    }
  }
  return n;
}

/** Block and file-scoped C# namespaces of a file as token ranges, outer before inner. */
function namespacesOf(file) {
  const T = file.tokens, match = file.match, res = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.k === 'op') { if ((t.v === '{' || t.v === '(' || t.v === '[') && match[i] > i) i = match[i]; continue; } // a namespace is declared at the top of a file or of another namespace
    if (t.k !== 'kw' || t.v !== 'namespace') continue;
    let j = i + 1, name = '';
    for (; j < T.length && (T[j].k === 'id' || T[j].k === 'kw' || (T[j].k === 'op' && (T[j].v === '.' || T[j].v === '::'))); j++) if (T[j].k !== 'op') name += (name ? '.' : '') + T[j].v;
    if (!name || j >= T.length || T[j].k !== 'op') continue;
    const b = T[j].v === '{' && match[j] > j ? match[j] : T[j].v === ';' ? T.length : -1;
    if (b < 0) continue;
    let outer = ''; for (const r of res) if (r.a < i && i < r.b) outer = r.name;
    res.push({ a: i, b, name: outer ? `${outer}.${name}` : name });
    i = j; // step inside the block: nested namespaces
  }
  return res;
}

/**
 * Names a body binds itself: parameters, local variables, local functions, lambda parameters. A bare use of
 * one of them is not a use of a repository symbol of the same name. Flow-insensitive: a name bound anywhere in
 * the body counts for the whole body.
 */
function localsOf(f, s) {
  const T = f.tokens, match = f.match, lang = f.lang, A = s.bodyA, B = s.bodyB, set = new Set();
  for (const p of s.paramNames) if (p) set.add(p);
  const typed = TYPED.has(lang), py = lang === 'py', js = lang === 'js';
  const params = (o) => { // a parameter list
    const c = match[o]; if (c < 0) return;
    for (let j = o + 1; j < c; j++) {
      const t = T[j]; if (t.k !== 'id') continue;
      const nx = T[j + 1], pv = T[j - 1];
      if (typed) { if (nx.k === 'op' && (nx.v === ',' || nx.v === ')' || nx.v === '=')) set.add(t.v); }
      else if (pv.k === 'op' && (pv.v === '(' || pv.v === ',' || pv.v === '{' || pv.v === '[' || pv.v === '...' || pv.v === '*' || pv.v === '**' || (js && pv.v === ':'))) set.add(t.v);
    }
  };
  const pattern = (o) => { // a destructuring pattern: { a, b: c, d = 1 }, [x, y], (p, q)
    const c = match[o]; if (c < 0) return;
    for (let j = o + 1; j < c; j++) { const t = T[j], nx = T[j + 1]; if (t.k === 'id' && nx.k === 'op' && (nx.v === ',' || nx.v === '}' || nx.v === ']' || nx.v === ')' || nx.v === '=')) set.add(t.v); }
  };
  // Parameters the parser gives no name: the single one of `name = x => …`, and destructured ones, `f({ a, b }, [c])`.
  if (A > s.a + 1 && T[A - 1].k === 'op' && T[A - 1].v === '=>' && T[A - 2].k === 'id') set.add(T[A - 2].v);
  if (isJsLike(lang)) for (let i = s.a, d = 0; i < A; i++) {
    const t = T[i]; if (t.k !== 'op') continue;
    if (t.v === '(') d++; else if (t.v === ')') d--;
    else if (d > 0 && (t.v === '{' || t.v === '[') && match[i] > i) { pattern(i); i = match[i]; }
  }
  for (let i = A; i + 1 < B; i++) {
    const t = T[i], nx = T[i + 1];
    if (t.k === 'kw') {
      const v = t.v;
      if (typed ? TYPE_KW.has(v) : DECL_KW.has(v)) {
        if (nx.k === 'id') set.add(nx.v);
        else if (nx.k === 'op' && (nx.v === '{' || nx.v === '[' || nx.v === '(') && (!typed || v === 'var')) pattern(i + 1);
      } else if (FN_KW.has(v)) {
        let j = i + 1; if (T[j].k === 'op' && T[j].v === '*') j++;
        if (j < B && T[j].k === 'id') set.add(T[j++].v);
        if (j < B && T[j].k === 'op' && T[j].v === '(') params(j);
      } else if (v === 'catch') { if (nx.k === 'op' && nx.v === '(') params(i + 1); }
      else if (py) {
        if (v === 'for') { for (let j = i + 1; j < B && j < i + 32 && !(T[j].k === 'kw' && T[j].v === 'in'); j++) if (T[j].k === 'id') set.add(T[j].v); }
        else if (v === 'lambda') { for (let j = i + 1; j < B && j < i + 32 && !(T[j].k === 'op' && T[j].v === ':'); j++) if (T[j].k === 'id' && !(T[j - 1].k === 'op' && T[j - 1].v === '=')) set.add(T[j].v); }
        else if (v === 'as' && nx.k === 'id') set.add(nx.v);
      }
    } else if (t.k === 'id') {
      if (nx.k === 'op') {
        if (nx.v === '=>' || nx.v === ':=') set.add(t.v);
        else if (py && nx.v === '=') { const p = T[i - 1]; if (i === A || (p.k === 'op' && (p.v === ';' || p.v === '{' || p.v === '}'))) set.add(t.v); }
      } else if (typed && nx.k === 'id') set.add(nx.v); // `Type name`, also a local function `Type Name(…)`
    } else if (t.k === 'op') {
      if (t.v === ')' && nx.k === 'op' && nx.v === '=>' && match[i] >= A) params(match[i]);
      else if (typed && (t.v === '>' || t.v === ']' || t.v === '?') && nx.k === 'id' && i + 2 < B) { // List<int> x = …, int[] a = …, int? n = …
        const n2 = T[i + 2]; if ((n2.k === 'op' && n2.v === '=') || (n2.k === 'kw' && n2.v === 'in')) set.add(nx.v);
      }
    }
  }
  return set;
}

/**
 * buildGraph(files, { maxCandidates = 3 }) → graph
 *   files   parseFile() results for every source file of one ref
 *   graph   { nodes: Map<id, symbol>, out: Map<id, Set<id>>, in: Map<id, Set<id>>,
 *             refs: Map<id, [{ name, line, kind: 'call'|'new'|'member'|'type', to: id[], status, args }]>,
 *             byName: Map<name, symbol[]>, files: Map<path, file>,
 *             stats: { symbols, edges, resolved, ambiguous, unresolved, skipped },
 *             sites, unlinked: Map<name, number> }
 * Establishes: every edge comes from a reference in the source that the rules in the header link to that
 * symbol; `status` says how each reference ended ('resolved' | 'ambiguous' | 'unresolved'), `args` is the
 * argument count of a call (null when unknown or when it is not a call). Does NOT establish that a linked
 * symbol is the one called at run time, nor that an unlinked one is not.
 * refs holds every call and every `new` written inside a symbol, linked or not ('unresolved' is mostly the
 * standard library, not a defect), and the uses of members and types that were linked. `sites` is the index
 * behind callSites(); `unlinked` counts per name the references skipped by the stop list or left ambiguous;
 * stats.skipped counts the stop-list ones, which are in `sites` but not in refs.
 * Symbols that share an id (type declarations of one name in one file) are one node. A use of a symbol by
 * itself (recursion) is listed in refs but is not an edge.
 * The graph is not meant to be changed afterwards: the measures below cache what they derive from it.
 */
export function buildGraph(files, { maxCandidates = 3 } = {}) {
  const nodes = new Map(), out = new Map(), inn = new Map(), refs = new Map(), byName = new Map(), fileMap = new Map();
  const stats = { symbols: 0, edges: 0, resolved: 0, ambiguous: 0, unresolved: 0, skipped: 0 };
  const named = new Map(), typesNamed = new Map(), members = new Map(), topOf = new Map(), typeOfGroup = new Map();
  const sites = new Map(), unlinked = new Map(), recs = [];
  const push = (map, key, v) => { const a = map.get(key); if (a) a.push(v); else map.set(key, [v]); };

  // One record per declared symbol: where it can be seen from (scope), which container it is a member of
  // (group) and, for a type, the container its own members live in (own).
  for (const f of files) {
    fileMap.set(f.path, f);
    const cs = f.lang === 'cs', spaces = cs ? namespacesOf(f) : NONE, dir = dirOf(f.path), inFile = new Map();
    topOf.set(f.path, inFile);
    const scopeD = `D:${dir}`, baseF = `F:${f.path}`;
    let lastKey = null, group = null, mem = null, ns = null, scope = scopeD, base = baseF;
    for (const s of f.symbols) {
      if (cs) { let q = ''; for (const sp of spaces) if (sp.a <= s.a && s.a < sp.b) q = sp.name; if (q !== ns) { ns = q; scope = base = `N:${ns}`; lastKey = null; } }
      const c = s.container || '';
      if (c !== lastKey) { lastKey = c; group = `${base}|${c}`; mem = members.get(group); if (!mem) members.set(group, mem = new Map()); }
      const r = { s, id: s.id, f, ns, scope, base, group, mem, own: s.kind === 'type' ? `${base}|${s.qname}` : null, stat: s.modifiers.includes('static'), ext: undefined, one: undefined };
      if (!nodes.has(s.id)) { nodes.set(s.id, s); out.set(s.id, new Set()); inn.set(s.id, new Set()); refs.set(s.id, []); }
      recs.push(r); push(named, s.name, r); push(byName, s.name, s); push(inFile, s.name, r); push(mem, s.name, r);
      if (r.own) { push(typesNamed, s.name, r); push(typeOfGroup, r.own, r); }
    }
  }
  const own = (group, name) => { const g = members.get(group); return g ? g.get(name) : undefined; };

  // ── Imports (JavaScript, TypeScript, Python) ────────────────────────────────────────────────────────
  const sourceCache = new Map(), bindCache = new Map(), defaultCache = new Map(), usingCache = new Map(), aliasCache = new Map();
  const norm = (p) => { const q = path.posix.normalize(p); return q === '.' ? '' : q.replace(/^\.\//, ''); };
  function resolveSource(f, source) {
    const key = `${f.path}\n${source}`; let hit = sourceCache.get(key);
    if (hit !== undefined) return hit;
    hit = null;
    const dir = dirOf(f.path), tryPath = (p) => { const x = fileMap.get(p); if (x && !hit) hit = x; };
    if (f.lang === 'py') { // `.mod`, `..pkg.mod`, `pkg.mod`: dots climb, an absolute name is tried from every ancestor
      const m = /^(\.*)(.*)$/.exec(source), rest = m[2] ? m[2].split('.').join('/') : '', bases = [];
      if (m[1]) { let d = dir; for (let k = 1; k < m[1].length; k++) d = dirOf(d); bases.push(d); }
      else for (let d = dir; ; d = dirOf(d)) { bases.push(d); if (!d) break; }
      for (const b of bases) { const p = norm(path.posix.join(b, rest)); if (p) tryPath(`${p}.py`); tryPath(p ? `${p}/__init__.py` : '__init__.py'); }
    } else if (source.startsWith('.') || source.startsWith('/')) {
      const p = norm(source.startsWith('/') ? source.slice(1) : path.posix.join(dir, source));
      tryPath(p);
      for (const e of EXTS) tryPath(p + e);
      const stem = p.replace(/\.(js|mjs|cjs|jsx)$/, ''); // TypeScript sources are imported under the name of their output
      if (stem !== p) for (const e of ['.ts', '.tsx', '.mts', '.cts']) tryPath(stem + e);
      for (const e of EXTS) tryPath(`${p}/index${e}`);
    }
    sourceCache.set(key, hit);
    return hit;
  }
  /** Local name → { kind: 'named' | 'default' | 'ns', imported, target: file | null }; `.stars` are `import *` targets. */
  function bindingsOf(f) {
    let m = bindCache.get(f); if (m) return m;
    m = new Map(); m.stars = []; bindCache.set(f, m);
    for (const imp of f.imports) {
      if (imp.reexport || imp.dynamic || imp.source == null) continue;
      const target = resolveSource(f, imp.source);
      for (const nm of imp.names) {
        if (nm.imported === '*') { if (target) m.stars.push(target); continue; }
        const sub = f.lang === 'py' ? resolveSource(f, imp.source.endsWith('.') ? imp.source + nm.imported : `${imp.source}.${nm.imported}`) : null;
        m.set(nm.local, sub ? { kind: 'ns', imported: null, target: sub } : { kind: 'named', imported: nm.imported, target });
      }
      if (imp.default && imp.default !== imp.ns) m.set(imp.default, { kind: 'default', imported: 'default', target });
      const top = f.lang === 'py' && imp.source.includes('.') && imp.ns === imp.source.split('.')[0]; // `import a.b` binds `a`, not the module read
      if (imp.ns && !top) m.set(imp.ns, { kind: 'ns', imported: null, target });
    }
    return m;
  }
  /** The name a file exports as its default (`export default foo`, `module.exports = foo`), or null. */
  function defaultName(f) {
    if (defaultCache.has(f)) return defaultCache.get(f);
    const T = f.tokens, match = f.match; let name = null;
    for (let i = 0; i < T.length && !name; i++) {
      const t = T[i];
      if (t.k === 'op') { if ((t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') && match[i] > i) i = match[i]; continue; }
      if (t.k === 'kw' && t.v === 'export' && T[i + 1] && T[i + 1].k === 'kw' && T[i + 1].v === 'default') {
        let j = i + 2, decl = false;
        while (T[j] && T[j].k === 'kw' && (T[j].v === 'async' || T[j].v === 'function' || T[j].v === 'class')) { decl = decl || T[j].v !== 'async'; j++; }
        if (T[j] && T[j].k === 'op' && T[j].v === '*') j++;
        if (T[j] && T[j].k === 'id' && (decl || !T[j + 1] || (T[j + 1].k === 'op' && T[j + 1].v === ';') || T[j + 1].l > T[j].l)) name = T[j].v;
      } else if (t.v === 'module' && T[i + 3] && T[i + 1].v === '.' && T[i + 2].v === 'exports' && T[i + 3].v === '=' && T[i + 4] && T[i + 4].k === 'id' && (!T[i + 5] || T[i + 5].v === ';' || T[i + 5].l > T[i + 4].l)) name = T[i + 4].v;
    }
    defaultCache.set(f, name);
    return name;
  }
  const topLevel = (f, name) => {
    const m = topOf.get(f.path).get(name); if (!m) return NONE;
    let r = null;
    for (const x of m) { const c = x.s.container; if (c === null || c === 'exports' || c === 'default') (r || (r = [])).push(x); }
    return r || NONE;
  };
  /** The symbols a file exposes under `name`, following re-exports and pass-through imports. */
  function exportsOf(f, name, depth = 0) {
    if (!f || depth > 6) return NONE;
    if (name === 'default') { const d = defaultName(f), r = d ? topLevel(f, d) : NONE; if (r.length) return r; }
    const here = topLevel(f, name); if (here.length) return here;
    for (const imp of f.imports) {
      if (imp.dynamic || imp.source == null) continue;
      const nm = imp.names.find((x) => x.local === name && x.imported !== '*');
      let r = NONE;
      if (nm) { if (imp.reexport || f.lang === 'py' || f.exports.includes(name)) r = exportsOf(resolveSource(f, imp.source), nm.imported, depth + 1); }
      else if ((imp.reexport && imp.ns === '*') || imp.names.some((x) => x.imported === '*')) r = exportsOf(resolveSource(f, imp.source), name, depth + 1);
      else if (imp.default === name && !imp.reexport && f.exports.includes(name)) r = exportsOf(resolveSource(f, imp.source), 'default', depth + 1);
      if (r.length) return r;
    }
    return NONE;
  }
  const moduleScoped = (f) => f.lang === 'py' || (isJsLike(f.lang) && (f.imports.length > 0 || f.exports.length > 0));
  const lexicalLang = (lang) => lang === 'py' || isJsLike(lang);
  /**
   * What a bare name is bound to in JavaScript, TypeScript or Python, by the language's own scoping: an
   * enclosing container that is not a class, an import, the file's top level, an `import *`.
   * → records | EXTERNAL (bound to a module outside the repository) | null (not bound in this file)
   */
  function lexicalName(n, name) {
    const f = n.f;
    for (let c = n.s.container; c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') {
      const g = `${n.base}|${c}`; if (typeOfGroup.has(g)) continue; // a class member needs this./self.
      const m = own(g, name); if (m) return m;
    }
    const binds = bindingsOf(f), b = binds.get(name);
    if (b) {
      if (!b.target) return EXTERNAL;
      const e = exportsOf(b.target, b.kind === 'ns' ? 'default' : b.imported);
      return e.length ? e : EXTERNAL;
    }
    const top = own(`${n.base}|`, name); if (top) return top;
    for (const t of binds.stars) { const e = exportsOf(t, name); if (e.length) return e; }
    return null;
  }

  // ── Types: which declaration a type name means, and what a type inherits ────────────────────────────
  const usingsOf = (f) => { let u = usingCache.get(f); if (!u) usingCache.set(f, u = new Set(f.imports.map((i) => i.source))); return u; };
  /** C# `using Alias = Ns.Type<…>;` → Map<alias, type name>. Read from the tokens: generic aliases are not in file.imports. */
  const aliasesOf = (f) => {
    let m = aliasCache.get(f); if (m) return m;
    aliasCache.set(f, m = new Map());
    const T = f.tokens, match = f.match;
    for (let i = 0; i + 3 < T.length; i++) {
      const t = T[i];
      if (t.k === 'op') { if ((t.v === '{' || t.v === '(' || t.v === '[') && match[i] > i) i = match[i]; continue; }
      if (t.k !== 'kw' || t.v !== 'using' || T[i + 1].k !== 'id' || T[i + 2].v !== '=') continue;
      let j = i + 3, name = null;
      for (; j < T.length && !(T[j].k === 'op' && (T[j].v === ';' || T[j].v === '<')); j++) if (T[j].k === 'id') name = T[j].v;
      if (name) m.set(T[i + 1].v, name);
    }
    return m;
  };
  /** → type records | AMBIGUOUS | null. Nearest first: enclosing types, same file, enclosing namespaces, imported namespaces, anywhere. */
  function typesFor(n, name) {
    const f = n.f;
    if (lexicalLang(f.lang)) {
      const r = lexicalName(n, name);
      if (r === EXTERNAL) return null;
      if (r) { const t = r.filter(isType); return t.length ? t : null; }
      if (moduleScoped(f)) return null;
    }
    if (f.lang === 'cs') name = aliasesOf(f).get(name) || name;
    const all = typesNamed.get(name); if (!all) return null;
    let c;
    for (let q = isType(n) ? n.s.qname : n.s.container; q; q = q.includes('.') ? q.slice(0, q.lastIndexOf('.')) : '') { // a type nested in an enclosing type comes first
      const m = own(`${n.base}|${q}`, name); c = m ? m.filter(isType) : NONE;
      if (c.length) return some(c.filter((t) => t.f === f)) || c; // parts of one container in other files may repeat the name
    }
    c = all.filter((t) => t.f === f); if (c.length) return c;
    if (f.lang === 'cs') {
      for (let ns = n.ns; ; ns = ns.includes('.') ? ns.slice(0, ns.lastIndexOf('.')) : '') { c = all.filter((t) => t.ns === ns); if (c.length) return c; if (!ns) break; }
      const u = usingsOf(f); c = all.filter((t) => u.has(t.ns)); if (c.length) return c;
    } else { c = all.filter((t) => t.scope === n.scope); if (c.length) return c; }
    return new Set(all.map((t) => t.own)).size <= maxCandidates ? all : AMBIGUOUS;
  }
  /** Names in the base list of a type declaration: `: A, B<T>`, `extends A implements B`, `class X(A, B):`. */
  function baseNames(t) {
    const T = t.f.tokens, match = t.f.match, s = t.s, py = t.f.lang === 'py', names = [];
    let i = s.a + 1;
    while (i < s.bodyA && !(T[i].k === 'id' && T[i].v === s.name && T[i - 1].k === 'kw')) i++;
    for (let j = i + 1, d = 0; j < s.bodyA; j++) {
      const x = T[j];
      if (x.k === 'op') {
        if (x.v === '<') d++;
        else if (x.v === '>') { if (d) d--; }
        else if ((x.v === '(' && !py || x.v === '[') && match[j] > j) j = match[j]; // primary constructor, base constructor arguments
        else if (py && x.v === '=') j++; // metaclass=Meta
      } else if (x.k === 'kw') { if (x.v === 'where') break; }
      else if (x.k === 'id' && d === 0) { const nx = T[j + 1]; if (!(nx.k === 'op' && (nx.v === '.' || nx.v === '::' || (py && nx.v === '=')))) names.push(x.v); }
    }
    return names;
  }
  const baseCache = new Map();
  function basesOf(group) {
    let b = baseCache.get(group); if (b) return b;
    b = []; baseCache.set(group, b);
    for (const t of typeOfGroup.get(group) || NONE) {
      if (t.s.bodyA <= t.s.a) continue;
      for (const name of baseNames(t)) { const r = typesFor(t, name); if (r && r !== AMBIGUOUS) for (const x of r) if (x.own !== group && !b.includes(x.own)) b.push(x.own); }
    }
    return b;
  }
  /** Members named `name` that the declared base types hand down: on each branch of the hierarchy, the nearest type that has one `keep` accepts. */
  function inherited(group, name, keep, seen = new Set([group]), depth = 0) {
    let found = null;
    for (const g of basesOf(group)) {
      if (seen.has(g)) continue;
      seen.add(g);
      const r = keep(own(g, name)) || (depth < 8 ? inherited(g, name, keep, seen, depth + 1) : null);
      if (r) found = found ? found.concat(r) : r;
    }
    return found;
  }

  // ── Candidates ──────────────────────────────────────────────────────────────────────────────────────
  const isExt = (x) => { // a C# extension method: static, first parameter marked `this`
    if (x.ext !== undefined) return x.ext;
    x.ext = false;
    if (x.f.lang === 'cs' && x.stat && x.s.maxParams > 0) { const T = x.f.tokens, hi = Math.min(x.s.b, x.s.bodyA > x.s.a ? x.s.bodyA : x.s.b); for (let i = x.s.a; i + 1 < hi; i++) if (T[i].k === 'op' && T[i].v === '(' && T[i + 1].k === 'kw' && T[i + 1].v === 'this') { x.ext = true; break; } }
    return x.ext;
  };
  /** `name = x => …`: the parser reports no parameters for a lambda with one unparenthesised parameter. It takes exactly one. */
  const oneParam = (x) => {
    if (x.one !== undefined) return x.one;
    const s = x.s, T = x.f.tokens, a = s.bodyA - 1; // the token before the body: the arrow
    return (x.one = s.maxParams === 0 && callable(s.kind) && a > s.a + 1 && T[a].k === 'op' && T[a].v === '=>' && T[a - 1].k === 'id' && T[a - 2].k !== 'id' && !(T[a - 2].k === 'op' && T[a - 2].v === '.'));
  };
  /** Does the declaration accept `args` arguments? Unknown counts, properties and types always pass. */
  const admits = (x, args, viaMember) => {
    const s = x.s;
    if (args == null || s.kind === 'property' || s.kind === 'type') return true;
    if (s.maxParams === 0 && oneParam(x)) return args === 1;
    const k = viaMember && isExt(x) ? args + 1 : args; // an extension method takes its receiver as first argument
    return k >= s.minParams && k <= s.maxParams;
  };
  /** A type stands for itself and for the constructors that accept the arguments. */
  const withCtors = (res, args, strict) => {
    if (!res || res === AMBIGUOUS || !res.some(isType)) return res;
    const all = res.slice();
    for (const x of res) {
      if (!isType(x)) continue;
      const g = members.get(x.own); if (!g) continue;
      for (const nm of [x.s.name, 'constructor', '__init__', 'init']) for (const c of g.get(nm) || NONE) if ((c.s.kind === 'ctor' || nm === '__init__') && (!strict || admits(c, args, false)) && !all.includes(c)) all.push(c);
    }
    return all;
  };
  /** Rules 3, 4 and 5 over every symbol of that name that `pred` and the arity admit. `from4` skips rule 3. */
  const byRules = (n, name, args, pred, viaMember, from4) => {
    const all = named.get(name); if (!all) return null;
    const c = []; for (const x of all) if (pred(x) && admits(x, args, viaMember)) c.push(x);
    if (!c.length) return null;
    if (!from4) { const here = c.filter((x) => x.f === n.f); if (here.length) return here; }
    const near = c.filter((x) => x.scope === n.scope); if (near.length) return near;
    return c.length <= maxCandidates ? c : AMBIGUOUS;
  };

  // ── References of one symbol ────────────────────────────────────────────────────────────────────────
  function scan(n) {
    const f = n.f, T = f.tokens, match = f.match, lang = f.lang, s = n.s, A = s.bodyA, B = s.bodyB;
    const list = refs.get(n.id), outSet = out.get(n.id);
    const js = isJsLike(lang), py = lang === 'py', cs = lang === 'cs', lexical = js || py, modular = lexical && moduleScoped(f);
    const angle = ANGLE.has(lang), implicit = IMPLICIT_THIS.has(lang), strict = OVERLOADS.has(lang), constructs = CALL_CONSTRUCTS.has(lang);
    const declBlock = DECL_BLOCK.has(lang), typed = TYPED.has(lang), hasNew = !NO_NEW.has(lang);
    const bound = localsOf(f, s), binds = lexical ? bindingsOf(f) : null;
    const braces = []; // C#: is the innermost open brace an object or collection initialiser?

    const site = (name, ref) => { const a = sites.get(name); if (a) a.push(n.id, ref); else sites.set(name, [n.id, ref]); };
    const emit = (name, line, kind, res, args) => {
      if (res === SKIP) { stats.skipped++; unlinked.set(name, (unlinked.get(name) || 0) + 1); site(name, { name, line, kind, to: NONE, status: 'skipped', args }); return; }
      let to = NONE, status = 'unresolved';
      if (res === AMBIGUOUS) { status = 'ambiguous'; unlinked.set(name, (unlinked.get(name) || 0) + 1); }
      else if (res && res.length) {
        status = 'resolved'; to = res.length > 8 ? [...new Set(res.map((x) => x.id))] : [];
        if (res.length <= 8) for (const x of res) if (!to.includes(x.id)) to.push(x.id);
        for (const id of to) if (id !== n.id && !outSet.has(id)) { outSet.add(id); inn.get(id).add(n.id); stats.edges++; }
      }
      const ref = { name, line, kind, to, status, args };
      list.push(ref); stats[status]++;
      if (kind === 'call' || kind === 'new') site(name, ref);
    };
    const pick = (cands, args, kindOk, viaMember) => {
      if (!cands) return null;
      const r = []; for (const x of cands) if (kindOk(x.s.kind) && (!strict || admits(x, args, viaMember))) r.push(x);
      return r.length ? r : null;
    };
    const memberKind = (k) => callable(k) || k === 'property';
    const calleeKind = (k) => callable(k) || k === 'property' || (constructs && k === 'type');
    const notSelf = (r) => (r ? some(r.filter((x) => x.id !== n.id && x.s.kind !== 'type' && x.s.kind !== 'ctor')) : null);

    /** A member call whose receiver says nothing: rules 4 and 5, nothing for stop-list names. */
    const unknownCall = (name, args, exclude) => {
      if (STOPLIST.has(name)) return SKIP;
      return byRules(n, name, args, (x) => callable(x.s.kind) && x.group !== exclude && !(cs && x.stat && !isExt(x)), true, true);
    };
    const bareCall = (name, args) => {
      if (lexical) {
        const r = lexicalName(n, name);
        if (r === EXTERNAL) return null;
        if (r) return withCtors(r, args, false); // the binding is exact; arity cannot change it
        if (modular) return null;
        return withCtors(byRules(n, name, args, (x) => !x.s.container && (callable(x.s.kind) || x.s.kind === 'type'), false, false), args, false);
      }
      const keep = (c) => pick(c, args, calleeKind, false);
      let r = keep(n.mem.get(name)) || (implicit ? inherited(n.group, name, keep) : null);
      for (let c = s.container; !r && implicit && c && c.includes('.');) { c = c.slice(0, c.lastIndexOf('.')); r = keep(own(`${n.base}|${c}`, name)); } // enclosing types
      if (r) return withCtors(r, args, strict);
      if (implicit && STOPLIST.has(name)) return SKIP; // inherited from a type the repository does not declare
      return withCtors(byRules(n, name, args, (x) => callable(x.s.kind) || (constructs && x.s.kind === 'type'), false, false), args, strict);
    };
    const bareUse = (name) => {
      if (lexical) { const r = lexicalName(n, name); return r && r !== EXTERNAL ? some(r.filter((x) => x.id !== n.id)) : null; }
      return implicit ? notSelf(n.mem.get(name)) : null;
    };
    const isInit = (i) => { // C#: `new T { … }`, `new T(…) { … }`, `x with { … }`, `P = { … }`
      if (i === A) return false;
      const p = T[i - 1];
      if (p.k === 'id') return true;
      if (p.k === 'kw') return p.v === 'new' || p.v === 'with';
      if (p.k !== 'op') return false;
      if (p.v === '>' || p.v === ']' || p.v === '=') return true;
      if (p.v === '{' || p.v === ',') return braces.length > 0 && braces[braces.length - 1];
      if (p.v !== ')' || match[i - 1] < 1) return false;
      let q = match[i - 1] - 1;
      if (T[q].k === 'op' && T[q].v === '>') q = genericOpen(T, q, A) - 1;
      while (q > 1 && T[q].k === 'id' && T[q - 1].k === 'op' && T[q - 1].v === '.') q -= 2;
      return q > 0 && T[q].k === 'id' && T[q - 1].k === 'kw' && T[q - 1].v === 'new';
    };

    /** `new Name(args)`: the type and the constructors that admit the arguments. Returns the index to continue from. */
    const construct = (i) => {
      let j = i + 1, last = null, head = null, parts = 0;
      if (j + 1 < B && T[j].k === 'kw' && T[j].v === 'global' && T[j + 1].v === '::') j += 2;
      while (j < B && T[j].k === 'id') {
        if (!head) head = T[j];
        last = T[j]; parts++; j++;
        if (angle && j < B && T[j].k === 'op' && T[j].v === '<') { const g = genericClose(T, j, B); if (g > 0) j = g + 1; }
        if (j + 1 < B && T[j].k === 'op' && (T[j].v === '.' || T[j].v === '::') && T[j + 1].k === 'id') j++; else break;
      }
      if (!last) return i; // new(), new[] { … }, new { … }, new int[n]
      const nx = j < B ? T[j] : null, name = last.v;
      let kind = 'new', args = 0;
      if (nx && nx.k === 'op' && nx.v === '(') args = countArgs(T, match, j, lang);
      else if (nx && nx.k === 'op' && (nx.v === '[' || nx.v === '?')) kind = 'type'; // an array of them: no constructor runs
      if (bound.has(head.v)) return j - 1;
      let res;
      if (lexical) {
        const b = parts > 1 ? binds.get(head.v) : null;
        const r = parts === 1 ? lexicalName(n, name) : b && b.kind !== 'named' && b.target ? exportsOf(b.target, name) : null;
        res = r === EXTERNAL || (r && !r.length) ? null : r;
        if (!r && !modular && parts === 1) res = typesFor(n, name);
      } else res = typesFor(n, name);
      if (kind === 'new') emit(name, last.l, kind, withCtors(res, args, strict), args);
      else if (res) emit(name, last.l, kind, res, null);
      return j - 1;
    };

    const member = (i, t, call, j) => {
      const name = t.v, args = call ? countArgs(T, match, j, lang) : null;
      let r = i - 2, rt = r >= 0 ? T[r] : null;
      if (rt && rt.k === 'op' && rt.v === '!' && r > 0) rt = T[--r]; // x!.Member
      if (rt && rt.k === 'op' && rt.v === '>' && angle) { const o = genericOpen(T, r, 0); if (o > 0) { r = o - 1; rt = T[r]; } } // Cache<T>.Member
      let mode = 'unknown', types = null, target = null, chained = false;
      if (rt && rt.k === 'kw' && (rt.v === 'base' || rt.v === 'super')) mode = 'base';
      else if (rt && (rt.k === 'kw' || rt.k === 'id') && (SELF.has(rt.v) || (py && rt.v === 'cls'))) mode = 'this';
      else if (rt && rt.k === 'op' && rt.v === ')' && py && r >= 2 && T[r - 1].v === '(' && T[r - 2].v === 'super') mode = 'base';
      else if (rt && rt.k === 'id') {
        const v = rt.v;
        chained = r > 0 && T[r - 1].k === 'op' && ACCESS.has(T[r - 1].v);
        if (chained) { if (!lexical && typesNamed.has(v)) { const ty = typesFor(n, v); if (ty && ty !== AMBIGUOUS) { mode = 'type'; types = ty; } } }
        else if (!bound.has(v) && !(implicit && notSelf(n.mem.get(v)))) { // a local or a member of the same name hides a type
          const b = lexical ? binds.get(v) : null;
          if (b && !b.target) mode = 'external';
          else if (b && b.kind !== 'named') {
            const e = b.kind === 'default' ? exportsOf(b.target, 'default').filter(isType) : NONE;
            if (e.length) { mode = 'type'; types = e; } else { mode = 'ns'; target = b.target; }
          } else { const ty = typesFor(n, v); if (ty === AMBIGUOUS) mode = 'ambiguous'; else if (ty) { mode = 'type'; types = ty; } }
        }
      }
      if (mode === 'this') {
        const keep = call ? (c) => pick(c, args, memberKind, true) : notSelf;
        const res = keep(n.mem.get(name)) || inherited(n.group, name, keep);
        if (res) emit(name, t.l, call ? 'call' : 'member', res, args);
        else if (call) emit(name, t.l, 'call', unknownCall(name, args, null), args);
      } else if (mode === 'base') { // never the caller's own container: base access is not virtual
        const keep = call ? (c) => pick(c, args, memberKind, true) : notSelf;
        const res = inherited(n.group, name, keep);
        if (res) emit(name, t.l, call ? 'call' : 'member', res, args);
        else if (call) emit(name, t.l, 'call', unknownCall(name, args, n.group), args);
      } else if (mode === 'type') {
        const keep = (c) => (c ? (call ? pick(c, args, (k) => memberKind(k) || k === 'type', false) : some(c.filter((x) => x.s.kind !== 'ctor'))) : null);
        let res = null;
        for (const g of new Set(types.map((x) => x.own))) { const q = keep(own(g, name)) || inherited(g, name, keep); if (q) res = res ? res.concat(q) : q; }
        if (res) emit(name, t.l, call ? 'call' : res.every(isType) ? 'type' : 'member', call ? withCtors(res, args, strict) : res, args);
        else if (chained) { if (call) emit(name, t.l, 'call', unknownCall(name, args, null), args); }
        else { // a field, constant or enum member, which are not symbols: the use is of the type
          emit(rt.v, rt.l, 'type', types, null);
          if (call) emit(name, t.l, 'call', null, args);
        }
      } else if (mode === 'ns') {
        const e = exportsOf(target, name);
        if (call) emit(name, t.l, 'call', e.length ? withCtors(e, args, false) : null, args);
        else if (e.length) emit(name, t.l, 'member', e, null);
      } else if (mode === 'ambiguous') emit(call ? name : rt.v, t.l, call ? 'call' : 'type', AMBIGUOUS, args);
      else if (call) emit(name, t.l, 'call', mode === 'external' ? null : unknownCall(name, args, null), args);
    };

    const bare = (i, t, call, j) => {
      const name = t.v, p = i > 0 ? T[i - 1] : null;
      if (p && p.k === 'kw' && HEAD_KW.has(p.v)) return; // `function name(`, `def name(`, `class Name(`: a declaration
      if (p && p.k === 'op' && p.v === '*' && i > 1 && T[i - 2].k === 'kw' && T[i - 2].v === 'function') return;
      if (bound.has(name)) return;
      if (call) {
        const nx = match[j] + 1 < T.length ? T[match[j] + 1] : null;
        if (nx && nx.k === 'op' && ((nx.v === '{' && declBlock) || (nx.v === '=>' && (cs || lang === 'dart')))) return; // a local function, or a method of an object literal
        if (cs && p && p.k === 'kw' && PATTERN_KW.has(p.v)) return; // `is Point(var x, var y)`: a positional pattern
        const args = countArgs(T, match, j, lang);
        emit(name, t.l, 'call', bareCall(name, args), args);
        return;
      }
      const nx = i + 1 < T.length ? T[i + 1] : null;
      if (nx && nx.k === 'op' && p && p.k === 'op') {
        if (nx.v === ':' && (p.v === '(' || p.v === ',' || p.v === '{')) return; // named argument, object key, property pattern
        if (nx.v === '=' && (py ? p.v === '(' || p.v === ',' : (p.v === '{' || p.v === ',') && braces.length > 0 && braces[braces.length - 1])) return; // keyword argument, member of the object being initialised
      } else if (nx && typed && nx.k === 'id') return; // `Type name`: the identifier is a type in a declaration
      const res = bareUse(name);
      if (res) emit(name, t.l, res.every(isType) ? 'type' : 'member', res, null);
    };

    // A C# constructor initialiser sits between the parameter list and the body: `: this(…)`, `: base(…)`.
    if (cs && s.kind === 'ctor') for (let i = s.a + 1; i + 1 < A; i++) {
      const t = T[i];
      if (t.k !== 'kw' || (t.v !== 'this' && t.v !== 'base') || T[i - 1].v !== ':' || T[i + 1].v !== '(') continue;
      const args = countArgs(T, match, i + 1, lang), ok = (c) => (c ? c.filter((x) => x.s.kind === 'ctor' && x.id !== n.id && admits(x, args, false)) : NONE);
      let res = [];
      if (t.v === 'this') res = ok(n.mem.get(s.name));
      else for (const g of basesOf(n.group)) for (const b of typeOfGroup.get(g) || NONE) for (const c of ok(own(g, b.s.name))) if (!res.includes(c)) res.push(c);
      emit(t.v === 'this' ? s.name : res.length ? res[0].s.name : 'base', t.l, 'new', res.length ? res : null, args);
      break;
    }

    for (let i = A; i < B; i++) {
      const t = T[i], k = t.k;
      if (k === 'op') { if (cs) { if (t.v === '{') braces.push(isInit(i)); else if (t.v === '}') braces.pop(); } continue; }
      if (k !== 'id' && k !== 'kw') continue;
      const p = i > 0 ? T[i - 1] : null, access = p !== null && p.k === 'op' && (p.v === '.' || p.v === '?.' || p.v === '::' || p.v === '->');
      if (k === 'kw' && !access) { if (t.v === 'new' && hasNew) i = construct(i); continue; }
      let j = i + 1; // the call parenthesis, past explicit generic arguments: Name<T>(…)
      if (angle && j < B && T[j].k === 'op' && T[j].v === '<') { const g = genericClose(T, j, B); if (g > 0 && g + 1 < B && T[g + 1].k === 'op' && T[g + 1].v === '(') j = g + 1; }
      const call = j < B && T[j].k === 'op' && T[j].v === '(' && match[j] > j;
      if (access) member(i, t, call, j); else bare(i, t, call, j);
    }
  }

  for (const n of recs) if (n.s.kind !== 'type' && n.s.bodyB > n.s.bodyA) scan(n);
  stats.symbols = nodes.size;
  return { nodes, out, in: inn, refs, byName, files: fileMap, stats, sites, unlinked };
}

/**
 * callSites(graph, name) → [{ from, file, line, args, kind, to, status }]
 * Every call written with that name (and every `new Name(…)`) inside a declared symbol, in source order.
 * `args` is the argument count or null when it is not known from the text; `to` the ids the call was linked
 * to; `status` 'resolved' | 'ambiguous' | 'unresolved' | 'skipped' (stop-list name on an unknown receiver).
 * A call site is a fact about the text; which declaration it reaches is the estimate described above.
 */
export function callSites(graph, name) {
  const list = graph.sites ? graph.sites.get(name) : null, res = [];
  if (!list) return res;
  for (let i = 0; i < list.length; i += 2) { const from = list[i], r = list[i + 1]; res.push({ from, file: graph.nodes.get(from).file, line: r.line, args: r.args, kind: r.kind, to: r.to, status: r.status }); }
  return res;
}

// ── Derived structure: arrays, strongly connected components ──────────────────────────────────────────
const derived = new WeakMap();
/** The graph as index arrays (compressed sparse rows, both directions), node order = insertion order of graph.nodes. */
function arrays(graph) {
  let c = derived.get(graph); if (c) return c;
  const ids = [...graph.nodes.keys()], n = ids.length, pos = new Map();
  for (let i = 0; i < n; i++) pos.set(ids[i], i);
  const outStart = new Int32Array(n + 1), inStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { const s = graph.out.get(ids[i]); if (s) for (const to of s) { const j = pos.get(to); if (j !== undefined) { outStart[i + 1]++; inStart[j + 1]++; } } }
  for (let i = 0; i < n; i++) { outStart[i + 1] += outStart[i]; inStart[i + 1] += inStart[i]; }
  const outTo = new Int32Array(outStart[n]), inFrom = new Int32Array(outStart[n]), fill = inStart.slice(0, n);
  for (let i = 0, e = 0; i < n; i++) { const s = graph.out.get(ids[i]); if (s) for (const to of s) { const j = pos.get(to); if (j !== undefined) { outTo[e++] = j; inFrom[fill[j]++] = i; } } }
  const testCode = new Uint8Array(n), testCase = new Uint8Array(n), type = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const s = graph.nodes.get(ids[i]); testCode[i] = isTestCode(s) ? 1 : 0; testCase[i] = s && s.isTest ? 1 : 0; type[i] = s && s.kind === 'type' ? 1 : 0; }
  c = { ids, pos, n, outStart, outTo, inStart, inFrom, testCode, testCase, type, cond: null };
  derived.set(graph, c);
  return c;
}

/**
 * Strongly connected components (Tarjan 1972), iterative so a long call chain cannot overflow the stack.
 * Components come out in reverse topological order: for an edge u -> v between two components,
 * comp[u] > comp[v]. So descending component number visits users before what they use.
 */
function condense(c) {
  if (c.cond) return c.cond;
  const { n, outStart, outTo } = c;
  const comp = new Int32Array(n).fill(-1), num = new Int32Array(n).fill(-1), low = new Int32Array(n);
  const stack = new Int32Array(n), on = new Uint8Array(n), cv = new Int32Array(n), ce = new Int32Array(n);
  let sp = 0, counter = 0, count = 0;
  for (let root = 0; root < n; root++) {
    if (num[root] !== -1) continue;
    let cp = 0;
    cv[0] = root; ce[0] = outStart[root]; cp = 1; num[root] = low[root] = counter++; stack[sp++] = root; on[root] = 1;
    while (cp) {
      const v = cv[cp - 1], e = ce[cp - 1];
      if (e < outStart[v + 1]) {
        const w = outTo[e]; ce[cp - 1] = e + 1;
        if (num[w] === -1) { num[w] = low[w] = counter++; stack[sp++] = w; on[w] = 1; cv[cp] = w; ce[cp] = outStart[w]; cp++; }
        else if (on[w] && num[w] < low[v]) low[v] = num[w];
      } else {
        if (low[v] === num[v]) { let w; do { w = stack[--sp]; on[w] = 0; comp[w] = count; } while (w !== v); count++; }
        cp--;
        if (cp && low[v] < low[cv[cp - 1]]) low[cv[cp - 1]] = low[v];
      }
    }
  }
  const start = new Int32Array(count + 1), members = new Int32Array(n);
  for (let v = 0; v < n; v++) start[comp[v] + 1]++;
  for (let k = 0; k < count; k++) start[k + 1] += start[k];
  const fill = start.slice(0, count);
  for (let v = 0; v < n; v++) members[fill[comp[v]]++] = v;
  return (c.cond = { comp, count, start, members });
}

/**
 * pagerank(graph, { damping = 0.85, iterations = 50, tol = 1e-10, includeTests = true }) → Map<id, number>
 * Rank flows from the user to the used (Component Rank, Inoue et al. 2005; PageRank, Brin and Page 1998):
 *   r(v) = (1 - d) / n + d * ( Σ over users u of v  r(u) / out(u)  +  D / n ),   D = rank held by nodes that use nothing
 * so dangling nodes hand their rank to everyone uniformly, and Σ r = 1.
 * How it is solved: with uniform teleport and uniform dangling redistribution r is proportional to the
 * solution of the linear system x = 1 + d·Pᵀx, where P has an empty row for a dangling node (Del Corso,
 * Gullí, Romani 2005, "Fast PageRank Computation via a Sparse Linear System"). That system is triangular over
 * the condensation of the graph, so it is solved by forward substitution, users first, exactly for every node
 * outside a cycle; inside a strongly connected component Gauss-Seidel sweeps run until the summed change is at
 * most tol·n or `iterations` sweeps were made. The result is the same fixed point a power iteration converges to.
 * `includeTests: false` ranks production code only: test code neither votes nor is ranked (its entries are 0).
 * The returned Map also carries `.sweeps` (most sweeps any component needed) and `.residual` (L1 defect of the
 * equation above for the returned vector): a residual far above tol means `iterations` was too small.
 * Establishes a ranking of use, on a graph that is itself an estimate. A high rank is not a measure of risk.
 */
export function pagerank(graph, { damping = 0.85, iterations = 50, tol = 1e-10, includeTests = true } = {}) {
  const c = arrays(graph), { n, ids, inStart, inFrom, outStart, outTo } = c, cond = condense(c);
  const off = includeTests ? null : c.testCode, x = new Float64Array(n), w = new Float64Array(n), result = new Map();
  let m = 0;
  for (let u = 0; u < n; u++) {
    if (off && off[u]) continue;
    m++;
    let d = 0; for (let e = outStart[u]; e < outStart[u + 1]; e++) if (!off || !off[outTo[e]]) d++;
    w[u] = d ? damping / d : 0;
  }
  let sweeps = 0;
  for (let k = cond.count - 1; k >= 0 && m; k--) {
    const a = cond.start[k], b = cond.start[k + 1];
    let cyclic = b - a > 1;
    if (!cyclic) { const v = cond.members[a]; for (let e = inStart[v]; e < inStart[v + 1]; e++) if (inFrom[e] === v) cyclic = true; }
    for (let round = 1; ; round++) {
      let delta = 0;
      for (let q = a; q < b; q++) {
        const v = cond.members[q]; if (off && off[v]) continue;
        let sum = 1; for (let e = inStart[v]; e < inStart[v + 1]; e++) { const u = inFrom[e]; sum += w[u] * x[u]; }
        delta += Math.abs(sum - x[v]); x[v] = sum;
      }
      if (!cyclic || delta <= tol * m || round >= iterations) { if (round > sweeps) sweeps = round; break; }
    }
  }
  let total = 0; for (let v = 0; v < n; v++) total += x[v];
  let dangling = 0, residual = 0;
  for (let v = 0; v < n; v++) { x[v] = total ? x[v] / total : 0; if (!w[v]) dangling += x[v]; }
  for (let v = 0; v < n && m; v++) {
    if (off && off[v]) continue;
    let sum = (1 - damping) / m + damping * dangling / m; for (let e = inStart[v]; e < inStart[v + 1]; e++) { const u = inFrom[e]; sum += w[u] * x[u]; }
    residual += Math.abs(sum - x[v]);
  }
  for (let v = 0; v < n; v++) result.set(ids[v], x[v]);
  result.sweeps = sweeps; result.residual = residual;
  return result;
}

function reach(graph, edges, id, { maxDepth = Infinity, includeTests = true } = {}) {
  const seen = new Set();
  if (!graph.nodes.has(id)) return seen;
  seen.add(id);
  let frontier = [id];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const v of frontier) { const s = edges.get(v); if (s) for (const u of s) if (!seen.has(u)) { seen.add(u); next.push(u); } }
    frontier = next;
  }
  seen.delete(id);
  if (!includeTests) for (const u of seen) if (isTestCode(graph.nodes.get(u))) seen.delete(u);
  return seen;
}
/**
 * reverseReach(graph, id, { maxDepth = Infinity, includeTests = true }) → Set<id>
 * Every symbol with a path of use edges to `id`, `id` itself excluded: what a defect in `id` can affect, its
 * blast radius (the impact set of Arnold and Bohner 1996), in breadth-first order. `maxDepth` bounds the path
 * length; `includeTests: false` drops test code from the result (paths may still pass through it).
 * Exact on the graph; the graph is an estimate, so this is neither a superset nor a subset of the real
 * impact: see the header for where edges are missing and where there are too many.
 */
export const reverseReach = (graph, id, opts) => reach(graph, graph.in, id, opts);
/** forwardReach: the other direction, everything `id` depends on, directly or through what it uses. Same options and caveats. */
export const forwardReach = (graph, id, opts) => reach(graph, graph.out, id, opts);

const popcount = (v) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/**
 * Exact transitive dependents of every node at once. R(C), the set of nodes that can reach component C,
 * is nodes(C) ∪ R(P) over the components P that use C; components are visited users first, so every R(P) is
 * complete when it is needed. Sets are bit rows over the nodes; a row is recycled once every user of it has
 * taken it. Returns null when the rows would not fit in `maxBytes`.
 */
function exactReach(c, maxBytes) {
  const { n, inStart, inFrom, testCode, testCase } = c, { comp, count, start, members } = condense(c);
  const W = (n + 31) >>> 5, prod = new Uint32Array(W), test = new Uint32Array(W);
  for (let v = 0; v < n; v++) { if (!testCode[v]) prod[v >>> 5] |= 1 << (v & 31); if (testCase[v]) test[v >>> 5] |= 1 << (v & 31); }
  const dependents = new Int32Array(n), testedBy = new Int32Array(n), rows = new Array(count).fill(null), pending = new Int32Array(count), stamp = new Int32Array(count).fill(-1);
  const pool = []; let allocated = 0;
  for (let k = 0; k < count; k++) for (let q = start[k]; q < start[k + 1]; q++) { const v = members[q]; for (let e = inStart[v]; e < inStart[v + 1]; e++) { const p = comp[inFrom[e]]; if (p !== k && stamp[p] !== k) { stamp[p] = k; pending[p]++; } } }
  stamp.fill(-1);
  for (let k = count - 1; k >= 0; k--) {
    let row = null, np = 0, nt = 0;
    for (let q = start[k]; q < start[k + 1]; q++) { const v = members[q]; if (!testCode[v]) np++; if (testCase[v]) nt++; }
    for (let q = start[k]; q < start[k + 1]; q++) {
      const v = members[q];
      for (let e = inStart[v]; e < inStart[v + 1]; e++) {
        const p = comp[inFrom[e]]; if (p === k || stamp[p] === k) continue;
        stamp[p] = k;
        if (!row) {
          row = pool.pop();
          if (!row) { allocated += W * 4; if (allocated > maxBytes) return null; row = new Uint32Array(W); } else row.fill(0);
          for (let z = start[k]; z < start[k + 1]; z++) row[members[z] >>> 5] |= 1 << (members[z] & 31);
        }
        const src = rows[p];
        if (src) for (let i = 0; i < W; i++) row[i] |= src[i]; else for (let z = start[p]; z < start[p + 1]; z++) row[members[z] >>> 5] |= 1 << (members[z] & 31);
        if (--pending[p] === 0 && src) { pool.push(src); rows[p] = null; }
      }
    }
    if (row) { np = 0; nt = 0; for (let i = 0; i < W; i++) { const r = row[i]; if (r) { np += popcount(r & prod[i]); nt += popcount(r & test[i]); } } }
    for (let q = start[k]; q < start[k + 1]; q++) { const v = members[q]; dependents[v] = np - (testCode[v] ? 0 : 1); testedBy[v] = nt - (testCase[v] ? 1 : 0); }
    if (row) { if (pending[k] === 0) pool.push(row); else rows[k] = row; }
  }
  return { dependents, testedBy };
}

/** Rank percentile in [0, 1] of each member of the population: (mean rank - 1) / (M - 1), ties share their mean rank; 0.5 when M = 1. NaN outside. */
function percentiles(values, inPop, n) {
  const idx = []; for (let v = 0; v < n; v++) if (inPop[v] && values[v] >= 0) idx.push(v);
  idx.sort((a, b) => values[a] - values[b] || a - b);
  const pct = new Float64Array(n).fill(NaN), M = idx.length;
  for (let a = 0; a < M;) {
    let b = a + 1; while (b < M && values[idx[b]] === values[idx[a]]) b++;
    const p = M > 1 ? (a + b - 1) / 2 / (M - 1) : 0.5;
    for (let i = a; i < b; i++) pct[idx[i]] = p;
    a = b;
  }
  return pct;
}

/**
 * centrality(graph, { exactFor = null, maxBytes = 256 MiB }) → Map<id, { fanIn, fanOut, directTests, dependents,
 *   testedBy, pagerank, pagerankPct, fanInPct, dependentsPct, instability, unlinked }>
 *   fanIn        direct users that are not test code          directTests  direct users that are test cases
 *   fanOut       symbols it uses directly
 *   dependents   production symbols (not test code) that can reach it through use edges
 *   testedBy     test cases that can reach it. Reaching is not asserting: this is not coverage.
 *   pagerank     pagerank(graph, { includeTests: false })
 *   …Pct         rank percentile in [0, 1] among production symbols that are not types (ties share their mean
 *                rank); null for test code and for types, which are not ranked
 *   instability  Martin 1994: fanOut / (fanIn + fanOut); null when both are 0
 *   unlinked     references written with this symbol's name that could not be linked (stop list, ambiguous).
 *                When it is not 0, fanIn and dependents are lower bounds.
 * "Test code" is a test case (symbol.isTest) or anything declared in a test file; a "test case" is symbol.isTest.
 * Method: exact for every node. Strongly connected components are condensed (Tarjan 1972) and the set of
 * nodes that can reach each component is propagated over the condensation as bit rows, users first. If those
 * rows would exceed `maxBytes` the result is `.mode = 'sampled'` instead of 'exact': dependents and testedBy are
 * computed exactly (breadth-first) only for the ids in `exactFor` and for a deterministic sample of every k-th
 * production symbol, they are null elsewhere, and dependentsPct is then measured against that sample.
 * All of it describes the graph; the graph is an estimate (see the header).
 */
export function centrality(graph, { exactFor = null, maxBytes = 256 * 1024 * 1024 } = {}) {
  const c = arrays(graph), { n, ids, inStart, inFrom, outStart, testCode, testCase, type } = c;
  const pr = pagerank(graph, { includeTests: false });
  const fanIn = new Int32Array(n), direct = new Int32Array(n), rank = new Float64Array(n), pop = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    for (let e = inStart[v]; e < inStart[v + 1]; e++) { const u = inFrom[e]; if (!testCode[u]) fanIn[v]++; if (testCase[u]) direct[v]++; }
    rank[v] = pr.get(ids[v]); pop[v] = !testCode[v] && !type[v] ? 1 : 0;
  }
  let reachOf = exactReach(c, maxBytes), mode = 'exact', sample = 0, depPct;
  if (reachOf) depPct = percentiles(reachOf.dependents, pop, n);
  else { // too large for the bit rows: exact where asked, a deterministic sample for the distribution
    mode = 'sampled';
    const dependents = new Int32Array(n).fill(-1), testedBy = new Int32Array(n).fill(-1), picked = new Uint8Array(n);
    let M = 0; for (let v = 0; v < n; v++) M += pop[v];
    const step = Math.max(1, Math.ceil(M / 256));
    const one = (v) => { if (dependents[v] >= 0) return; let d = 0, t = 0; for (const u of reach(graph, graph.in, ids[v])) { const j = c.pos.get(u); if (!testCode[j]) d++; if (testCase[j]) t++; } dependents[v] = d; testedBy[v] = t; };
    for (let v = 0, seen = 0; v < n; v++) if (pop[v] && seen++ % step === 0) { one(v); picked[v] = 1; sample++; }
    depPct = percentiles(dependents, picked, n);
    const sorted = []; for (let v = 0; v < n; v++) if (picked[v]) sorted.push(dependents[v]);
    sorted.sort((x, y) => x - y);
    if (exactFor) for (const id of exactFor) { // placed in the sample's distribution as one more member of it
      const v = c.pos.get(id); if (v === undefined || picked[v]) continue;
      one(v);
      if (!pop[v] || !sample) continue;
      let less = 0, equal = 0; for (const x of sorted) { if (x < dependents[v]) less++; else if (x === dependents[v]) equal++; }
      depPct[v] = (less + equal / 2) / sample;
    }
    reachOf = { dependents, testedBy };
  }
  const prPct = percentiles(rank, pop, n), inPct = percentiles(fanIn, pop, n);
  const result = new Map(), num = (x) => (Number.isNaN(x) ? null : x), known = (x) => (x < 0 ? null : x);
  for (let v = 0; v < n; v++) {
    const fanOut = outStart[v + 1] - outStart[v], s = graph.nodes.get(ids[v]);
    result.set(ids[v], {
      fanIn: fanIn[v], fanOut, directTests: direct[v], dependents: known(reachOf.dependents[v]), testedBy: known(reachOf.testedBy[v]),
      pagerank: rank[v], pagerankPct: num(prPct[v]), fanInPct: num(inPct[v]), dependentsPct: num(depPct[v]),
      instability: fanIn[v] + fanOut ? fanOut / (fanIn[v] + fanOut) : null,
      unlinked: (graph.unlinked && s && graph.unlinked.get(s.name)) || 0,
    });
  }
  result.mode = mode; result.sample = sample;
  return result;
}

/**
 * neighbourhood(graph, ids, { depth = 1, max = 40, score = null }) → { nodes: id[], edges: [from, to][] }
 * The given ids plus the symbols that use them or are used by them, up to `depth` steps. At most `max` extra
 * nodes are kept, the highest-scored first (`score`: Map<id, number>, default the number of direct users);
 * each step grows only from nodes that were kept, so every extra node is connected to a given id through
 * kept nodes. `edges` is every use edge between two kept nodes. A drawing aid: what is left out is not absent.
 */
export function neighbourhood(graph, ids, { depth = 1, max = 40, score = null } = {}) {
  const kept = new Set(); for (const id of ids) if (graph.nodes.has(id)) kept.add(id);
  const value = (id) => (score ? score.get(id) || 0 : (graph.in.get(id) || NONE).size || 0);
  let frontier = [...kept], room = Math.max(0, max);
  for (let d = 0; d < depth && frontier.length && room > 0; d++) {
    const cand = new Set();
    for (const v of frontier) for (const side of [graph.in.get(v), graph.out.get(v)]) if (side) for (const u of side) if (!kept.has(u) && graph.nodes.has(u)) cand.add(u);
    const ranked = [...cand].map((id) => [id, value(id)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, room);
    frontier = ranked.map((r) => r[0]);
    for (const id of frontier) kept.add(id);
    room -= frontier.length;
  }
  const edges = [];
  for (const a of kept) { const s = graph.out.get(a); if (s) for (const b of s) if (kept.has(b)) edges.push([a, b]); }
  return { nodes: [...kept], edges };
}
