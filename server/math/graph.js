// The dependency graph between the functions of a repository, and the network measures that say how much
// depends on each one. Every declared symbol is a node; an edge A -> B means "A uses B" (calls it, constructs
// it, reads it). Built from tokens and names only, so it works on any ref straight from git in milliseconds.
//
// WHAT THE GRAPH IS, AND IS NOT
// It is built from names and from what declarations say in the text: there is no compiler and no inference of
// the type of an expression. A reference is linked by the rules below, and what they cannot decide stays
// unresolved or ambiguous with no edge. Nothing is guessed. So every number derived from it (fan-in,
// dependents, reach, rank) is an ESTIMATE of the real dependency structure, never a proof that something is or
// is not used. Measured on 80 edges sampled from a 690-file C# repository and read against the source: 59 name
// exactly the declaration that is used, 77 the right member of the right type (the difference is overloads
// that only argument types tell apart).
//   It over-approximates where the text does not decide: a call whose receiver has no declared type links to
//   EVERY admissible symbol of that name in the namespace or directory (rule 4) and to up to `maxCandidates`
//   anywhere (rule 5); overloads that differ only in parameter types are all linked unless the written types
//   of the arguments single one out; a call through a base type or an interface links to the overrides in
//   every type that derives from it (up to `maxDispatch`); C# `partial` types that share a name inside one
//   namespace are one container, also when they are copies kept by several projects or test fixtures; a local
//   declared twice in one body with two types is taken as either.
//   It under-approximates where the target is decided at run time or lies outside what is parsed: reflection,
//   callbacks and delegates held in variables, dispatch past `maxDispatch` overrides (the call keeps its
//   declared target only), member calls with a ubiquitous name on a receiver of unknown type (the stop list:
//   skipped), names carried by more than `maxCandidates` symbols (ambiguous: no edge), code that belongs to no
//   declared symbol (field initialisers, statements at the top of a module), types named only in declarations,
//   casts or generic arguments (a type gets edges from `new T` and `T.member` only), a class that implements
//   an interface through a member its base class declares, and everything outside the repository.
// `graph.unlinked` counts, per name, the references left without an edge because the name is on the stop list,
// ambiguous, or dispatched past the cap; centrality() repeats it per symbol, and a symbol whose name has
// unlinked references has fan-in and dependents that are LOWER BOUNDS. "Nothing depends on it" is only ever
// "no dependent was found".
//
// RESOLUTION (the first rule that yields candidates wins)
//   1  bare calls and this./self. calls: members of the same container, then what its declared base types
//      hand down (on each branch the nearest type that declares the name) and, for a bare call, the enclosing
//      types. base./super. calls: only what the bases hand down, never the caller's own container.
//   2  JavaScript, TypeScript, Python: the name is imported: the exported or top-level symbol of that name in
//      the file the import path resolves to, following re-exports
//   3  same file      4  same directory, or the same namespace in C#
//   5  anywhere, when at most `maxCandidates` symbols carry the name; more is ambiguous and adds no edge
//   Type.member with Type declared in the repository resolves inside that type only.
//   C# and Java, where declarations carry types: a receiver that is a parameter, a local (`T x`, `var x = new
//   T()`), a field or a property, or a chain of those (`this.options.Resolver`), has the type its declaration
//   writes. The member is then looked up in that type and its bases only, plus the overrides that deriving
//   types declare (class hierarchy analysis); when the type has no such member only an extension method whose
//   `this` parameter can be that type is linked; when the declared type is not one of the repository
//   (List<int>, string, an array) nothing but such an extension method is. Rules 4 and 5 and the stop list are
//   for the receivers that are left: `var` from a call, a lambda parameter, the result of a call.
// Arity: when the number of arguments of a call is known, a candidate must admit it (a C# extension method
// called through its receiver takes n + 1). The exception is a name that JavaScript, TypeScript or Python
// scoping binds to one declaration (rules 1 to 3 there): a wrong argument count is then a finding about that
// call, not a reason to unlink it.
// Facts of the language are used only to REMOVE candidates. All languages: a parameter, local variable or local
// function hides an outer name; an identifier bound by an import means that import and nothing else; in a
// module (a JavaScript file with imports or exports, any Python file) a bare name that is neither declared in
// the file nor imported is a global or builtin, never another file's function; code that is not test code does
// not resolve by name to test code. C#: a static method that is not an extension method is not called through
// an instance, nor an instance method through a type name; a bare call reaches a method of another class only
// through `using static`; a member that is private to another type, or an explicit interface implementation,
// is not what a name means; `F<int>(x)` needs a method with one generic parameter, `new Box<int>()` the Box
// with one; `ref` and `out` are written at the call and convert to nothing; a type that is not `partial` owns
// exactly the members written inside it; `A.B.C` names a C declared in B.
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
//   Dean, Grove, Chambers 1995, "Optimization of Object-Oriented Programs Using Static Class Hierarchy
//     Analysis", ECOOP: the targets of a call through a declared type are the method that type sees and its
//     overrides in the subtypes, read off the class hierarchy.
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
const DECLARED = words('cs java');                              // receivers are typed from declarations (verified on these two)
const NULLABLE = words('cs java kt swift dart c scala');        // `T? x` is a nullable type, not an optional parameter
// Contextual words that can stand in front of an identifier without being its type (`from x in`, `await x`).
const NOT_TYPE = words('from let join select group by into orderby ascending descending on equals where await async yield when and or not is in out ref return throw case else new this global value get set init add remove partial with scoped readonly const static params required file unmanaged notnull managed nameof typeof default using var dynamic record final');
const BCL = { Boolean: 'bool', Byte: 'byte', SByte: 'sbyte', Char: 'char', Decimal: 'decimal', Double: 'double', Single: 'float', Int32: 'int', UInt32: 'uint', Int64: 'long', UInt64: 'ulong', Int16: 'short', UInt16: 'ushort', Object: 'object', String: 'string' };
const SIZED = { Length: words('[] string Span ReadOnlySpan Memory ReadOnlyMemory StringBuilder'), Count: words('List IList ICollection IReadOnlyList IReadOnlyCollection Dictionary IDictionary IReadOnlyDictionary HashSet Queue Stack') };
const OUTSIDE = Object.freeze({ outside: true });               // an array, pointer or tuple: its members belong to the runtime
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

/** Number of type arguments between the '<' at `open` and its '>' at `close`: `<int, List<string>>` is 2, `<,>` is 2. */
function countTypeArgs(T, match, open, close) {
  let n = 1;
  for (let i = open + 1, d = 0; i < close; i++) {
    const t = T[i]; if (t.k !== 'op') continue;
    if (t.v === '<') d++; else if (t.v === '>') d--;
    else if ((t.v === '(' || t.v === '[') && match[i] > i && match[i] < close) i = match[i];
    else if (t.v === ',' && d === 0) n++;
  }
  return n;
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
 * buildGraph(files, { maxCandidates = 3, maxDispatch = 16 }) → graph
 *   files   parseFile() results for every source file of one ref
 *   maxCandidates   rule 5: how many symbols anywhere may carry a name before it is ambiguous
 *   maxDispatch     how many overrides a call through a base type or interface is linked to; past it the call
 *                   keeps its declared target only, stats.capped counts it and `unlinked` counts the name
 *   graph   { nodes: Map<id, symbol>, out: Map<id, Set<id>>, in: Map<id, Set<id>>,
 *             refs: Map<id, [{ name, line, kind: 'call'|'new'|'member'|'type', to: id[], status, args }]>,
 *             byName: Map<name, symbol[]>, files: Map<path, file>,
 *             stats: { symbols, edges, resolved, ambiguous, unresolved, skipped, capped },
 *             sites, unlinked: Map<name, number> }
 * Establishes: every edge comes from a reference in the source that the rules in the header link to that
 * symbol; `status` says how each reference ended ('resolved' | 'ambiguous' | 'unresolved'), `args` is the
 * argument count of a call (null when unknown or when it is not a call). Does NOT establish that a linked
 * symbol is the one called at run time, nor that an unlinked one is not.
 * refs holds every call and every `new` written inside a symbol, linked or not ('unresolved' is mostly the
 * standard library, not a defect), and the uses of members and types that were linked. `sites` is the index
 * behind callSites(); `unlinked` counts per name the references skipped by the stop list, left ambiguous, or
 * dispatched past `maxDispatch`;
 * stats.skipped counts the stop-list ones, which are in `sites` but not in refs.
 * Symbols that share an id (type declarations of one name in one file) are one node. A use of a symbol by
 * itself (recursion) is listed in refs but is not an edge.
 * The graph is not meant to be changed afterwards: the measures below cache what they derive from it.
 */
export function buildGraph(files, { maxCandidates = 3, maxDispatch = 16 } = {}) {
  const nodes = new Map(), out = new Map(), inn = new Map(), refs = new Map(), byName = new Map(), fileMap = new Map();
  const stats = { symbols: 0, edges: 0, resolved: 0, ambiguous: 0, unresolved: 0, skipped: 0, capped: 0 };
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
    const testFile = isTestPath(f.path), open = []; // the type declarations the walk is inside of
    let ns = null, scope = scopeD, base = baseF;
    for (const s of f.symbols) {
      if (cs) { let q = ''; for (const sp of spaces) if (sp.a <= s.a && s.a < sp.b) q = sp.name; if (q !== ns) { ns = q; scope = base = `N:${ns}`; } }
      while (open.length && s.a >= open[open.length - 1].s.b) open.pop();
      const c = s.container || '', top = open.length ? open[open.length - 1] : null, decl = top && top.s.qname === c ? top : null;
      const group = decl ? decl.own : `${base}|${c}`;
      let mem = members.get(group); if (!mem) members.set(group, mem = new Map());
      const r = { s, id: s.id, f, ns, scope, base, group, mem, decl, own: null, stat: s.modifiers.includes('static'), test: testFile || !!s.isTest, partial: s.modifiers.includes('partial'), ptypes: undefined, ext: undefined, one: undefined, priv: undefined, expl: undefined, pmods: undefined, head: undefined, min: undefined, dtype: undefined, iface: undefined, fields: undefined };
      if (s.kind === 'type') {
        // A C# type is one container across files only when it says `partial`; any other declaration is closed:
        // its members are exactly the ones written inside it, however many types elsewhere share its name.
        r.own = cs && !r.partial ? `${base}|${s.qname}#${f.path}@${s.a}` : `${base}|${s.qname}`;
        open.push(r);
      }
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

  // ── What a declaration says about itself: its name token, parameter list and generic parameters ─────
  /** → { name, open, gen, tps }: index of the name token, of the '(' of the parameter list (-1: none), number and names of generic parameters. */
  const headOf = (x) => {
    if (x.head) return x.head;
    const s = x.s, T = x.f.tokens, match = x.f.match, hi = s.bodyA > s.a ? s.bodyA : s.b, type = s.kind === 'type';
    const h = (x.head = { name: -1, open: -1, gen: 0, tps: NONE });
    for (let i = s.a; i + 1 < hi; i++) {
      const t = T[i];
      if (t.k === 'op') { if ((t.v === '[' || t.v === '(') && match[i] > i) i = match[i]; continue; } // attributes, a tuple return type
      if (t.v !== s.name) continue;
      const nx = T[i + 1];
      if (type ? !(i > s.a && T[i - 1].k === 'kw') : !(nx.k === 'op' && (nx.v === '(' || nx.v === '<'))) continue;
      let j = i + 1;
      if (nx.k === 'op' && nx.v === '<') {
        const g = genericClose(T, j, hi);
        if (g < 0 || (!type && !(T[g + 1] && T[g + 1].k === 'op' && T[g + 1].v === '('))) continue;
        h.gen = countTypeArgs(T, match, j, g); h.tps = [];
        for (let k = j + 1, d = 0; k < g; k++) { const y = T[k]; if (y.k === 'op') { if (y.v === '<') d++; else if (y.v === '>') d--; else if ((y.v === '[' || y.v === '(') && match[k] > k) k = match[k]; } else if (y.k === 'id' && d === 0) h.tps.push(y.v); }
        j = g + 1;
      }
      h.name = i;
      if (!type && T[j] && T[j].k === 'op' && T[j].v === '(' && match[j] > j) h.open = j;
      break;
    }
    return h;
  };
  /** Generic parameters in scope at a declaration: its own and those of the types around it. */
  const isTypeParam = (x, name) => { for (let d = x; d; d = d.decl) if (headOf(d).tps.includes(name)) return true; return false; };
  /**
   * Fewest arguments a declaration accepts. The parser counts a parameter of nullable type (`object? x`,
   * Java `List<?> xs`) as optional; outside JavaScript and TypeScript only a default value (`= …`) or a rest
   * parameter makes one optional, so the count is taken again from the parameter list.
   */
  const minOf = (x) => {
    if (x.min !== undefined) return x.min;
    const s = x.s; let min = s.minParams;
    if (NULLABLE.has(x.f.lang) && s.minParams < s.params) {
      const open = headOf(x).open, T = x.f.tokens, match = x.f.match;
      if (open >= 0) {
        const close = match[open]; let n = 0, need = 0, any = false, opt = false, d = 0;
        for (let i = open + 1; i <= close; i++) {
          const t = T[i];
          if (i === close || (t.k === 'op' && t.v === ',' && d === 0)) { if (any) { n++; if (!opt) need++; } any = opt = false; continue; }
          any = true;
          if (t.k === 'op') {
            if ((t.v === '(' || t.v === '[' || t.v === '{') && match[i] > i) i = match[i];
            else if (t.v === '<') d++; else if (t.v === '>') { if (d) d--; }
            else if (t.v === '=' || t.v === '...') opt = true;
          } else if (t.k === 'kw' && t.v === 'params') opt = true;
        }
        if (n === s.params) min = need;
      }
    }
    return (x.min = min);
  };
  /** Is the code of `n` written inside the container `group` (or a type nested in it)? */
  const inside = (n, group) => { if (n.group === group || n.own === group) return true; for (let d = n.decl; d; d = d.decl) if (d.own === group || d.group === group) return true; return false; };
  /**
   * Private to its declaring type: written `private`, or, in C#, a member of a class or struct with no access
   * modifier at all (the language default). Such a symbol cannot be named from outside that type.
   */
  const hidden = (x) => {
    if (x.priv !== undefined) return x.priv;
    const m = x.s.modifiers, lang = x.f.lang;
    let p = false;
    if (x.decl && (lang === 'cs' || lang === 'java')) {
      if (m.includes('private')) p = !m.includes('protected');
      else if (lang === 'cs' && !m.includes('public') && !m.includes('internal') && !m.includes('protected') && !isInterface(x.decl)) { p = !explicitImpl(x); }
    }
    return (x.priv = p);
  };
  /** `void IFoo.Bar()`: an explicit interface implementation. It has no name of its own; only a call through the interface reaches it. */
  const explicitImpl = (x) => {
    if (x.expl !== undefined) return x.expl;
    const s = x.s, T = x.f.tokens; let k = -1;
    if (x.f.lang === 'cs' && s.kind !== 'type' && s.kind !== 'ctor') { k = headOf(x).name; if (k < 0) { k = (s.bodyA > s.a ? s.bodyA : s.b) - 1; while (k > s.a && !(T[k].k === 'id' && T[k].v === s.name)) k--; } }
    return (x.expl = k > s.a && T[k - 1].k === 'op' && T[k - 1].v === '.');
  };
  const reachable = (n, x) => (n.test || !x.test) && !(hidden(x) && !inside(n, x.group));
  const isInterface = (t) => {
    if (!t) return false;
    if (t.iface === undefined) { t.iface = false; const T = t.f.tokens, hi = t.s.bodyA > t.s.a ? t.s.bodyA : t.s.b; for (let i = t.s.a; i < hi; i++) if (T[i].v === 'interface' && T[i].k !== 'str') { t.iface = true; break; } }
    return t.iface;
  };

  // ── Types: which declaration a type name means, and what a type inherits ────────────────────────────
  const globalUsings = new Set(); // C# `global using X;` of any file: which project it belongs to is not known, so it counts for all
  for (const f of files) if (f.lang === 'cs') { const T = f.tokens; for (let i = 0, lim = Math.min(T.length - 2, 600); i < lim; i++) if (T[i].k === 'kw' && T[i].v === 'global' && T[i + 1].k === 'kw' && T[i + 1].v === 'using') { let j = i + 2, q = ''; if (T[j].v === 'static') j++; for (; j < T.length && !(T[j].k === 'op' && T[j].v === ';'); j++) if (T[j].k === 'id') q += (q ? '.' : '') + T[j].v; if (q) globalUsings.add(q); } }
  const usingsOf = (f) => { let u = usingCache.get(f); if (!u) usingCache.set(f, u = new Set([...f.imports.map((i) => String(i.source).replace(/^global\./, '')), ...globalUsings])); return u; };
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
  const lastSeg = (q) => { const i = q.lastIndexOf('.'); return i < 0 ? q : q.slice(i + 1); };
  /**
   * → type records | AMBIGUOUS | null. Nearest first: enclosing types, same file, enclosing namespaces,
   * imported namespaces, anywhere. C#: `arity` (number of type arguments written, 0 for none) must be the
   * declaration's, because `Box`, `Box<T>` and `Box<T, U>` are three types; `qual` (the name written in front,
   * `Outer.Name`) is honoured when a declaration of that name sits in such a type or namespace. `visible`
   * leaves out the last step: a name that only a declaration somewhere else carries is then AMBIGUOUS.
   */
  function typesFor(n, name, arity, qual, visible) {
    const f = n.f, cs = f.lang === 'cs';
    if (lexicalLang(f.lang)) {
      const r = lexicalName(n, name);
      if (r === EXTERNAL) return null;
      if (r) { const t = r.filter(isType); return t.length ? t : null; }
      if (moduleScoped(f)) return null;
    }
    let aliased = false;
    if (cs) { const al = aliasesOf(f), a = al.get(name); if (a) { name = a; aliased = true; } if (qual) qual = al.get(qual) || qual; }
    let all = typesNamed.get(name); if (!all) return null;
    let narrowed = false, c;
    // Test code is not named by the code it tests, and a private nested type is not named outside its container.
    if (all.some((t) => !reachable(n, t))) { all = all.filter((t) => reachable(n, t)); if (!all.length) return null; narrowed = true; }
    if (cs && arity !== undefined && !aliased) { c = all.filter((t) => headOf(t).gen === arity); if (!c.length) return null; if (c.length < all.length) { all = c; narrowed = true; } }
    if (qual) { c = all.filter((t) => lastSeg(t.s.container || t.ns || '') === qual); if (c.length && c.length < all.length) { all = c; narrowed = true; } }
    for (let d = isType(n) ? n : n.decl; d; d = d.decl) { // a type nested in an enclosing type comes first
      const m = own(d.own, name); c = m ? m.filter((t) => isType(t) && (!narrowed || all.includes(t))) : NONE;
      if (c.length) return sameBuild(some(c.filter((t) => t.f === f)) || c, f); // parts of one container in other files may repeat the name
    }
    c = all.filter((t) => t.f === f); if (c.length) return c;
    if (cs) {
      for (let ns = n.ns; ; ns = ns.includes('.') ? ns.slice(0, ns.lastIndexOf('.')) : '') { c = all.filter((t) => t.ns === ns); if (c.length) return sameBuild(c, f); if (!ns) break; }
      const u = usingsOf(f); c = all.filter((t) => u.has(t.ns)); if (c.length) return sameBuild(c, f);
    } else { c = all.filter((t) => t.scope === n.scope); if (c.length) return c; }
    if (visible) return AMBIGUOUS;
    all = sameBuild(all, f);
    return new Set(all.map((t) => `${t.base}|${t.s.qname}`)).size <= maxCandidates ? all : AMBIGUOUS;
  }
  /**
   * C# declarations that are not `partial` and share namespace, name and arity cannot be in one build (error
   * CS0101): they are copies that separate projects or test fixtures keep. When one of the copies sits in the
   * directory of the code that names the type, that is the one its build sees, and the others are left out.
   */
  function sameBuild(c, f) {
    if (c.length < 2 || f.lang !== 'cs') return c;
    const dir = dirOf(f.path), groups = new Map(); let drop = null;
    for (const t of c) if (!t.partial) push(groups, `${t.base}|${t.s.qname}|${headOf(t).gen}`, t);
    for (const g of groups.values()) if (g.length > 1 && g.some((t) => dirOf(t.f.path) === dir)) for (const t of g) if (dirOf(t.f.path) !== dir) (drop || (drop = new Set())).add(t);
    return drop ? c.filter((t) => !drop.has(t)) : c;
  }
  /** Types in the base list of a type declaration: `: A, B<T>`, `extends A implements B`, `class X(A, B):` → [{ name, arity, qual }]. */
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
      else if (x.k === 'id' && d === 0) {
        const nx = T[j + 1];
        if (nx.k === 'op' && (nx.v === '.' || nx.v === '::' || (py && nx.v === '='))) continue;
        let arity = 0;
        if (nx.k === 'op' && nx.v === '<') { const g = genericClose(T, j + 1, s.bodyA); arity = g > 0 ? countTypeArgs(T, match, j + 1, g) : undefined; }
        names.push({ name: x.v, arity, qual: T[j - 1].k === 'op' && T[j - 1].v === '.' && T[j - 2].k === 'id' ? T[j - 2].v : null });
      }
    }
    return names;
  }
  const baseCache = new Map();
  function basesOf(group) {
    let b = baseCache.get(group); if (b) return b;
    b = []; baseCache.set(group, b);
    for (const t of typeOfGroup.get(group) || NONE) {
      if (t.s.bodyA <= t.s.a) continue;
      for (const bn of baseNames(t)) { const r = typesFor(t, bn.name, bn.arity, bn.qual); if (r === AMBIGUOUS) b.open = true; else if (r) for (const x of r) if (x.own !== group && !b.includes(x.own)) b.push(x.own); }
    }
    return b;
  }
  /** Members named `name` that the declared base types hand down: on each branch of the hierarchy, the nearest type that has one `keep` accepts. */
  const ifaceGroup = (g) => { const t = typeOfGroup.get(g); return !!t && t[0].f.lang === 'cs' && isInterface(t[0]); };
  function inherited(group, name, keep, seen = new Set([group]), depth = 0, cls = !ifaceGroup(group) && (typeOfGroup.get(group) || NONE).some((t) => t.f.lang === 'cs')) {
    let found = null;
    for (const g of basesOf(group)) {
      if (seen.has(g)) continue;
      seen.add(g);
      if (cls && ifaceGroup(g)) continue; // a C# class implements an interface; it does not inherit the interface's members
      const r = keep(own(g, name)) || (depth < 8 ? inherited(g, name, keep, seen, depth + 1, cls) : null);
      if (r) found = found ? found.concat(r) : r;
    }
    return found;
  }
  /** Is some base of the container a name the repository declares too often to choose from? Then what it inherits is not known. */
  const openBases = (group, seen = new Set()) => { if (seen.has(group)) return false; seen.add(group); const b = basesOf(group); return !!b.open || b.some((g) => openBases(g, seen)); };
  /** Can a type that derives from the declaring one supply its own version? */
  const overridable = (x) => {
    const s = x.s, m = s.modifiers;
    if (x.stat || !(callable(s.kind) || s.kind === 'property')) return false;
    if (x.f.lang === 'cs') return s.abstract || m.includes('virtual') || m.includes('abstract') || m.includes('override') || isInterface(x.decl);
    return !m.includes('private') && !m.includes('final');
  };
  /** Every container whose declared bases lead to `group` (the types that can override what it declares). */
  let derivedIndex = null; const derivedCache = new Map();
  function derivedOf(group) {
    let r = derivedCache.get(group); if (r) return r;
    if (!derivedIndex) { derivedIndex = new Map(); for (const g of typeOfGroup.keys()) for (const b of basesOf(g)) push(derivedIndex, b, g); }
    r = []; derivedCache.set(group, r);
    const seen = new Set([group]);
    for (let q = [group]; q.length;) { const next = []; for (const g of q) for (const d of derivedIndex.get(g) || NONE) if (!seen.has(d)) { seen.add(d); r.push(d); next.push(d); } q = next; }
    return r;
  }

  // ── Declared types (C#, Java): what the text says a parameter, local, field or property is ──────────
  // A description of a static type is { keys: containers, inst: true (a value of it) | false (the type itself)
  // | null (either), name } for types declared in the repository, { ext: true, name } for a type the repository
  // does not declare, and null when the text does not say (var, dynamic, a type parameter, an ambiguous name).
  const extDesc = (name) => ({ ext: true, name });
  const descOf = (types, inst, name) => { const keys = []; for (const t of types) if (!keys.includes(t.own)) keys.push(t.own); return { keys, inst, name }; };
  const sameDesc = (a, b) => !!a && !!b && (a.ext ? !!b.ext && a.name === b.name : !b.ext && a.inst === b.inst && a.keys.length === b.keys.length && a.keys.every((k) => b.keys.includes(k)));
  /** The type written just before a declared name, read backwards from its last token T[e] → { name, arity, qual } | { kw } | OUTSIDE | null. */
  function typeHead(T, e, lo) {
    if (e < lo) return null;
    let t = T[e];
    let opt = false;
    if (t.k === 'op' && t.v === '?') { if (--e < lo) return null; t = T[e]; opt = true; } // nullable annotation
    const qualAt = (i) => (i - 2 >= lo && T[i - 1].k === 'op' && (T[i - 1].v === '.' || T[i - 1].v === '::') && T[i - 2].k === 'id' ? T[i - 2].v : null);
    if (t.k === 'op') {
      if (t.v === ']' || t.v === '*' || t.v === ')') return OUTSIDE;
      if (t.v !== '>') return null;
      const o = genericOpen(T, e, lo); if (o <= lo || T[o - 1].k !== 'id') return null;
      let n = 1, text = BCL[T[o - 1].v] || T[o - 1].v; const ids = [];
      for (let k = o, d = 0; k <= e; k++) { const y = T[k]; text += BCL[y.v] || y.v; if (y.k !== 'op') { if (y.k === 'id') ids.push(y.v); continue; } if (y.v === '<' || y.v === '(' || y.v === '[') d++; else if (y.v === '>' || y.v === ')' || y.v === ']') d--; else if (y.v === ',' && d === 1) n++; }
      return { name: T[o - 1].v, arity: n, qual: qualAt(o - 1), opt, text, ids };
    }
    if (t.k === 'kw') return TYPE_KW.has(t.v) ? { kw: t.v, opt } : null;
    return t.k === 'id' ? { name: t.v, arity: 0, qual: qualAt(e), opt } : null;
  }
  /**
   * A name under which two written types can be compared for identity, or null when the text is not enough: a
   * generic type (its arguments would have to match too), a nullable value type, an array, a type parameter.
   */
  const typeKey = (h, ctx) => {
    if (!h || h === OUTSIDE) return null;
    if (h.kw) return h.opt && h.kw !== 'string' && h.kw !== 'object' ? null : h.kw === 'var' || h.kw === 'dynamic' ? null : h.kw;
    if (h.opt || isTypeParam(ctx, h.name)) return null;
    if (!h.arity) return BCL[h.name] || h.name;
    return h.ids.some((v) => isTypeParam(ctx, v)) ? null : h.text; // `Span<byte>` is itself; `List<T>` depends on who says T
  };
  /** The static type declared by the type expression that ends at token `e` of the file of `ctx`. */
  function typeDescAt(ctx, e, lo) {
    const h = typeHead(ctx.f.tokens, e, lo);
    if (!h) return null;
    if (h === OUTSIDE) return extDesc('[]');
    let d;
    if (h.kw) { if (h.kw === 'var' || h.kw === 'dynamic' || h.kw === 'auto') return null; d = extDesc(h.kw); }
    else {
      if (NOT_TYPE.has(h.name) || isTypeParam(ctx, h.name)) return null;
      const r = typesFor(ctx, h.name, h.arity, h.qual, true);
      if (r === AMBIGUOUS) return null;
      d = r ? descOf(r, true, h.name) : extDesc(h.name);
    }
    d.key = typeKey(h, ctx);
    return d;
  }
  /** Parameter types of a declaration as comparable keys ('&' in front: ref or out, '~': in), null where the text is not enough. */
  const paramTypes = (x) => {
    if (x.ptypes !== undefined) return x.ptypes;
    const open = headOf(x).open, T = x.f.tokens, match = x.f.match;
    if (open < 0) { x.pmods = null; return (x.ptypes = null); }
    const res = [], mods = (x.pmods = []);
    for (let i = open + 1, close = match[open], d = 0, eq = -1, any = false, mod = ''; i <= close; i++) {
      const t = T[i];
      if (i === close || (t.k === 'op' && t.v === ',' && d === 0)) {
        if (any) {
          const e = (eq < 0 ? i : eq) - 1, h = e > open && T[e].k === 'id' ? typeHead(T, e - 1, open + 1) : null;
          const k = typeKey(h, x);
          res.push(k ? mod + k : null); mods.push(mod);
        }
        eq = -1; any = false; mod = ''; continue;
      }
      any = true;
      if (t.k === 'kw') { if (eq < 0 && d === 0) { if (t.v === 'ref' || t.v === 'out') mod = '&'; else if (t.v === 'in' || (t.v === 'readonly' && mod === '&')) mod = '~'; } continue; } // `ref readonly` takes an argument with or without ref, like `in`
      if (t.k !== 'op') continue;
      if ((t.v === '(' || t.v === '[' || t.v === '{') && match[i] > i) i = match[i];
      else if (t.v === '<') d++; else if (t.v === '>') { if (d) d--; }
      else if (t.v === '=' && eq < 0) eq = i;
    }
    return (x.ptypes = res);
  };
  /** Fields of one type declaration: name → index of the last token of the declared type. Read from the body: fields are not symbols. */
  const fieldsOf = (t) => {
    if (t.fields) return t.fields;
    const m = (t.fields = new Map()), T = t.f.tokens, match = t.f.match, hi = t.s.bodyB - 1;
    for (let i = t.s.bodyA + 1, st = i; i < hi; i++) {
      const x = T[i];
      if (x.k !== 'op') continue;
      if (x.v === '{') { i = match[i] > i ? match[i] : hi; st = i + 1; continue; }
      if (x.v === '}') { st = i + 1; continue; }
      if (x.v !== ';') { if ((x.v === '(' || x.v === '[') && match[i] > i) i = match[i]; continue; }
      let end = i, ok = true; // the declarator part: up to the first `=`
      for (let k = st; k < i; k++) { const y = T[k]; if (y.k === 'op') { if (y.v === '=') { end = k; break; } if (y.v === '(' || y.v === '=>') { ok = false; break; } if (y.v === '[' && match[k] > k) k = match[k]; } else if (y.k === 'kw' && (y.v === 'using' || y.v === 'namespace' || y.v === 'delegate' || y.v === 'return' || y.v === 'import' || y.v === 'package')) { ok = false; break; } }
      if (ok && end - st >= 2 && T[end - 1].k === 'id') m.set(T[end - 1].v, end - 2);
      st = i + 1;
    }
    return m;
  };
  const propDesc = (x) => { // the declared type of a property
    if (x.dtype !== undefined) return x.dtype;
    const s = x.s, T = x.f.tokens; let k = (s.bodyA > s.a ? s.bodyA : s.b) - 1;
    while (k > s.a && !(T[k].k === 'id' && T[k].v === s.name)) k--;
    return (x.dtype = k > s.a && !(T[k - 1].k === 'op' && T[k - 1].v === '.') ? typeDescAt(x, k - 1, s.a) : null);
  };
  const mergeDesc = (a, b) => {
    if (a === undefined) return b; if (b === undefined) return a;
    if (!a || !b) return null;
    if (sameDesc(a, b)) return a;
    if (a.ext || b.ext) return null;
    const keys = a.keys.slice(); for (const k of b.keys) if (!keys.includes(k)) keys.push(k);
    return { keys, inst: a.inst === b.inst ? a.inst : null, name: a.name };
  };
  /** Declared type of the property or field `name` of a container, or of the nearest base that has one. undefined: there is none. */
  const memberTypeCache = new Map();
  function memberType(group, name, depth = 0) {
    const key = `${group}\n${name}`; let d = memberTypeCache.get(key);
    if (d !== undefined || memberTypeCache.has(key)) return d;
    memberTypeCache.set(key, undefined); // a cycle of bases ends here
    for (const x of own(group, name) || NONE) if (x.s.kind === 'property' && !explicitImpl(x)) d = mergeDesc(d, propDesc(x));
    if (d === undefined) for (const t of typeOfGroup.get(group) || NONE) { if (t.s.bodyB <= t.s.bodyA) continue; const e = fieldsOf(t).get(name); if (e !== undefined) d = mergeDesc(d, typeDescAt(t, e, t.s.bodyA)); }
    if (d === undefined && depth < 8) for (const b of basesOf(group)) d = mergeDesc(d, memberType(b, name, depth + 1));
    memberTypeCache.set(key, d);
    return d;
  }
  /** Names a description answers to: its types and everything they declare as a base, resolved or not. */
  const superNames = (d) => {
    if (d.names) return d.names;
    const names = (d.names = new Set()), seen = new Set();
    for (let q = d.keys.slice(); q.length;) { const g = q.pop(); if (seen.has(g)) continue; seen.add(g); for (const t of typeOfGroup.get(g) || NONE) { names.add(t.s.name); if (t.s.bodyA > t.s.a) for (const b of baseNames(t)) names.add(b.name); } for (const b of basesOf(g)) q.push(b); }
    return names;
  };

  // ── Candidates ──────────────────────────────────────────────────────────────────────────────────────
  const isExt = (x) => { // a C# extension method: static, first parameter marked `this`
    if (x.ext !== undefined) return x.ext;
    x.ext = false;
    if (x.f.lang === 'cs' && x.stat && x.s.maxParams > 0) { const T = x.f.tokens, hi = Math.min(x.s.b, x.s.bodyA > x.s.a ? x.s.bodyA : x.s.b); for (let i = x.s.a; i + 1 < hi; i++) if (T[i].k === 'op' && T[i].v === '(' && T[i + 1].k === 'kw' && T[i + 1].v === 'this') { x.ext = true; break; } }
    return x.ext;
  };
  /**
   * Can the extension method `x` be called on a receiver described by `d`? 2: its `this` type is the receiver's
   * type or one of its declared bases; 1: cannot be told (a type parameter, or a type the repository does not
   * declare on either side); 0: no (its `this` type is declared here and the receiver is not one).
   */
  const extFits = (x, d) => {
    const T = x.f.tokens, open = headOf(x).open; if (open < 0) return 1;
    const close = x.f.match[open]; let e = open + 1, depth = 0;
    for (; e < close; e++) { const t = T[e]; if (t.k !== 'op') continue; if (t.v === '<') depth++; else if (t.v === '>') { if (depth) depth--; } else if ((t.v === ',' || t.v === '=') && !depth) break; else if ((t.v === '(' || t.v === '[') && x.f.match[e] > e) e = x.f.match[e]; }
    const h = typeHead(T, e - 2, open + 1); // the type written before the name of the first parameter
    if (!h) return 1;
    const runtime = !!d.ext && (d.name === '[]' || TYPE_KW.has(d.name)); // an array or a built-in type: never a type declared here
    if (h === OUTSIDE) return d.ext ? 1 : 0;
    if (h.kw) return h.kw === 'object' ? 1 : d.ext ? (d.name === h.kw ? 2 : runtime ? 0 : 1) : 0;
    if (headOf(x).tps.includes(h.name)) return 1;
    if (d.ext) return d.name === h.name ? 2 : runtime && typesNamed.has(h.name) ? 0 : 1;
    if (superNames(d).has(h.name)) return 2;
    if (!typesNamed.has(h.name)) return 1;
    for (const g of d.keys) for (const t of typeOfGroup.get(g) || NONE) if (t.s.modifiers.includes('partial')) return 1; // a generated part may add a base
    return 0;
  };
  /** `name = x => …`: the parser reports no parameters for a lambda with one unparenthesised parameter. It takes exactly one. */
  const oneParam = (x) => {
    if (x.one !== undefined) return x.one;
    const s = x.s, T = x.f.tokens, a = s.bodyA - 1; // the token before the body: the arrow
    return (x.one = s.maxParams === 0 && callable(s.kind) && a > s.a + 1 && T[a].k === 'op' && T[a].v === '=>' && T[a - 1].k === 'id' && T[a - 2].k !== 'id' && !(T[a - 2].k === 'op' && T[a - 2].v === '.'));
  };
  /**
   * Does the declaration accept `args` arguments? Unknown counts, properties and types always pass. `targs` is
   * the number of type arguments the C# call spells out (`F<int>(x)`): only a method with that many generic
   * parameters can be meant (a call without them may still be generic: they are inferred).
   */
  let targs = null;
  const admits = (x, args, viaMember) => {
    const s = x.s;
    if (targs !== null && callable(s.kind) && x.f.lang === 'cs' && headOf(x).gen !== targs) return false;
    if (args == null || s.kind === 'property' || s.kind === 'type') return true;
    if (s.maxParams === 0 && oneParam(x)) return args === 1;
    const k = viaMember && isExt(x) ? args + 1 : args; // an extension method takes its receiver as first argument
    return k >= minOf(x) && k <= s.maxParams;
  };
  /** A type stands for itself and for the constructors that accept the arguments. */
  const withCtors = (res, args, strict) => {
    if (!res || res === AMBIGUOUS || res === SKIP || !res.some(isType)) return res;
    const all = res.slice(), saved = targs; targs = null; // type arguments written at a construction belong to the type
    for (const x of res) {
      if (!isType(x)) continue;
      const g = members.get(x.own); if (!g) continue;
      for (const nm of [x.s.name, 'constructor', '__init__', 'init']) for (const c of g.get(nm) || NONE) if ((c.s.kind === 'ctor' || nm === '__init__') && (!strict || admits(c, args, false)) && !all.includes(c)) all.push(c);
    }
    targs = saved;
    return all;
  };
  /**
   * Rules 3, 4 and 5 over every symbol of that name that `pred` and the arity admit. `from4` skips rule 3.
   * Code that is not test code never resolves to test code by name alone (a build depends on its tests in one
   * direction only), and nothing resolves to a member that is private to another type.
   */
  const byRules = (n, name, args, pred, viaMember, from4) => {
    const all = named.get(name); if (!all) return null;
    const c = []; for (const x of all) if (pred(x) && reachable(n, x) && admits(x, args, viaMember)) c.push(x);
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
    const declared = DECLARED.has(lang), bound = localsOf(f, s), binds = lexical ? bindingsOf(f) : null;
    const braces = []; // C#: is the innermost open brace an object or collection initialiser?
    const inits = [], initOf = new Map(); // … and of which types (`new T { P = 1 }`, `x with { P = 1 }`), when the text says
    const selfDesc = n.decl ? { keys: [n.group], inst: true, name: n.decl.s.name } : null;

    /** `= new Name<…>(…);` after `var x`: the type the variable is built from, when the construction is the whole initialiser. */
    const constructed = (k) => {
      if (!(k + 2 < B && T[k].k === 'op' && T[k].v === '=' && T[k + 1].k === 'kw' && T[k + 1].v === 'new')) return null;
      let j = k + 2, last = -1, arity = 0;
      if (T[j].k === 'kw' && T[j].v === 'global' && T[j + 1].v === '::') j += 2;
      while (j < B && T[j].k === 'id') {
        last = j; arity = 0; j++;
        if (j < B && T[j].k === 'op' && T[j].v === '<') { const g = genericClose(T, j, B); if (g < 0) return null; arity = countTypeArgs(T, match, j, g); j = g + 1; }
        if (j + 1 < B && T[j].k === 'op' && (T[j].v === '.' || T[j].v === '::') && T[j + 1].k === 'id') j++; else break;
      }
      if (last < 0 || j >= B || T[j].k !== 'op') return null;
      if (T[j].v === '[') return extDesc('[]');
      if (T[j].v === '(' && match[j] > j) j = match[j] + 1; else if (T[j].v !== '{') return null;
      if (j < B && T[j].k === 'op' && T[j].v === '{' && match[j] > j) j = match[j] + 1; // an object initialiser
      if (!(j < B && T[j].k === 'op' && (T[j].v === ';' || T[j].v === ')' || T[j].v === ','))) return null; // `new A().Build()` is not an A
      const name = T[last].v, qual = T[last - 1].k === 'op' && T[last - 2].k === 'id' ? T[last - 2].v : null;
      if (isTypeParam(n, name)) return null;
      const r = typesFor(n, name, cs ? arity : undefined, qual, true);
      if (r === AMBIGUOUS) return null;
      const d = r ? descOf(r, true, name) : extDesc(name);
      d.key = arity ? null : BCL[name] || name;
      return d;
    };
    /**
     * Declared types of the parameters and locals of this body: name → description, or null when the body
     * declares the name without a type (var, a lambda parameter) or with two different ones.
     */
    const typesOfLocals = () => {
      const m = new Map();
      // Flow-insensitive: a name declared in two scopes with two repository types is a value of either (the union);
      // one declaration without a type, or of a type from outside, leaves it unknown.
      const put = (name, d) => { if (!m.has(name)) m.set(name, d || null); else { const o = m.get(name); if (o && !sameDesc(o, d)) m.set(name, d ? mergeDesc(o, d) : null); } };
      const open = headOf(n).open;
      if (open >= 0) for (let i = open + 1, close = match[open], d = 0, eq = -1; i <= close; i++) {
        const t = T[i];
        if (i === close || (t.k === 'op' && t.v === ',' && d === 0)) { const e = (eq < 0 ? i : eq) - 1; if (e > open && T[e].k === 'id') put(T[e].v, typeDescAt(n, e - 1, open + 1)); eq = -1; continue; }
        if (t.k !== 'op') continue;
        if ((t.v === '(' || t.v === '[' || t.v === '{') && match[i] > i) i = match[i];
        else if (t.v === '<') d++; else if (t.v === '>') { if (d) d--; }
        else if (t.v === '=' && eq < 0) eq = i;
      }
      for (let i = A; i + 1 < B; i++) {
        const t = T[i], nx = T[i + 1];
        if (nx.k !== 'id') {
          if (t.k === 'op' && t.v === ')' && nx.k === 'op' && nx.v === '=>' && match[i] >= A) for (let k = match[i] + 1; k < i; k++) { // (a, b) => …
            if (T[k].k === 'id' && T[k - 1].k === 'op' && (T[k - 1].v === '(' || T[k - 1].v === ',') && T[k + 1].k === 'op' && (T[k + 1].v === ',' || T[k + 1].v === ')')) put(T[k].v, null);
          }
          continue;
        }
        const n2 = i + 2 < B ? T[i + 2] : null;
        if (n2 && n2.k === 'op' && n2.v === '=>') { put(nx.v, null); continue; } // x => …
        if (t.k === 'id') put(nx.v, NOT_TYPE.has(t.v) ? null : typeDescAt(n, i, A));
        else if (t.k === 'kw') { if (t.v === 'var') put(nx.v, constructed(i + 2)); else if (TYPE_KW.has(t.v)) put(nx.v, typeDescAt(n, i, A)); }
        else if (t.k === 'op' && (t.v === '>' || t.v === ']' || t.v === '?') && n2 && ((n2.k === 'op' && n2.v === '=') || (n2.k === 'kw' && n2.v === 'in'))) put(nx.v, typeDescAt(n, i, A));
      }
      return m;
    };
    let localTypes = null;
    const localType = (v) => (localTypes || (localTypes = typesOfLocals())).get(v) || null;
    /** A property or field of the types around this code, reached without `this.` → description | null | undefined (no such member). */
    const implicitMember = (v) => {
      let d = n.decl ? memberType(n.group, v) : undefined;
      for (let o = n.decl && n.decl.decl; d === undefined && o; o = o.decl) d = memberType(o.own, v);
      return d;
    };
    const stepDesc = (d, name) => { // the type of `d.name`
      if (d.ext) return null;
      let r; for (const g of d.keys) r = mergeDesc(r, memberType(g, name));
      if (r !== undefined) return r;
      let types = null; for (const g of d.keys) for (const x of own(g, name) || NONE) if (isType(x)) (types || (types = [])).push(x);
      return types ? descOf(types, false, name) : null;
    };
    /**
     * Static type of the receiver that ends at T[r] (`x`, `this.a.b`, `Ns.Type.Prop`), from declarations only:
     * a typed parameter or local, a property or field and its declared type, a type name behind its namespace.
     * → description | AMBIGUOUS | null (the text does not say: var, a call in the chain, an unknown name).
     */
    const chainDesc = (r, arity0) => {
      const parts = [];
      for (let q = r; ;) {
        const x = T[q];
        if (x.k !== 'id' && x.k !== 'kw') return null;
        parts.push(q);
        const p = q - 1;
        if (p <= A || T[p].k !== 'op' || (T[p].v !== '.' && T[p].v !== '?.')) break;
        q = p - 1;
        if (T[q].k === 'op' && T[q].v === '!' && q > A) q--;
      }
      parts.reverse();
      const h = T[parts[0]], pre = parts[0] - 1, root = pre > A && T[pre].k === 'op' && T[pre].v === '::' ? T[pre - 1].v : null;
      let d = null, k = 1;
      if (root !== null) { // `global::A.B.C`, `Alias::A.B`: read from the root of a namespace, so neither a local nor a member nor a nested type
        for (k = 0; k < parts.length && !d; k++) {
          const y = T[parts[k]]; if (y.k !== 'id') return null;
          let tail = ''; for (let z = 0; z < k; z++) tail += (z ? '.' : '') + T[parts[z]].v;
          const ty = (typesNamed.get(y.v) || NONE).filter((x) => !x.s.container && (root === 'global' ? (x.ns || '') === tail : !tail || x.ns === tail || (x.ns || '').endsWith(`.${tail}`)) && (!cs || headOf(x).gen === (k === parts.length - 1 && arity0 !== undefined ? arity0 : 0)));
          if (ty.length) d = descOf(sameBuild(ty, f), false, y.v);
        }
      } else if (h.k === 'kw') {
        if (h.v === 'this') d = selfDesc;
        else if (h.v === 'base' || h.v === 'super') { const b = n.decl ? basesOf(n.group) : NONE; d = b.length ? { keys: b, inst: true, name: '' } : null; }
        else if (TYPE_KW.has(h.v) && h.v !== 'var' && h.v !== 'dynamic') return parts.length === 1 ? { ext: true, name: h.v, inst: false } : null; // string.Join(…)
        else return null;
      } else if (bound.has(h.v)) d = localType(h.v);
      else {
        d = implicitMember(h.v);
        if (d && !d.ext && typesNamed.has(h.v)) d = { keys: d.keys, inst: null, name: d.name }; // `Color Color`: the name is the member and the type
        if (d === undefined) { // a type name, possibly behind the namespace or the types it is declared in
          d = null;
          for (k = 0; k < parts.length && !d; k++) {
            const y = T[parts[k]]; if (y.k !== 'id') return null;
            if (!typesNamed.has(cs ? aliasesOf(f).get(y.v) || y.v : y.v)) continue;
            let ty = typesFor(n, y.v, cs ? (k === parts.length - 1 && arity0 !== undefined ? arity0 : 0) : undefined, k > 0 ? T[parts[k - 1]].v : null);
            if (ty === AMBIGUOUS) return AMBIGUOUS;
            if (!ty) continue;
            if (k > 0) { // what is written in front must be where the declaration sits
              let tail = ''; for (let z = 0; z < k; z++) tail += (z ? '.' : '') + T[parts[z]].v;
              ty = ty.filter((x) => { const q = x.s.container ? `${x.ns ? `${x.ns}.` : ''}${x.s.container}` : x.ns || ''; return q === tail || q.endsWith(`.${tail}`); });
              if (!ty.length) return null;
            }
            d = descOf(ty, false, y.v);
          }
        }
      }
      for (; d && k < parts.length; k++) d = stepDesc(d, T[parts[k]].v);
      return d || null;
    };

    // ── Overloads told apart by the written types of the arguments (C#) ─────────────────────────────────
    let callOpen = -1, callVia = false; // the '(' of the call being resolved; is it written on a receiver?
    const keyOf = (d) => (d && d.inst !== false && d.key ? d.key : null);
    const numType = (v) => (/^\d{1,9}$/.test(v) || /^0[xX][0-9a-fA-F]{1,7}$/.test(v) ? 'int' : /^\d+[lL]$/.test(v) ? 'long' : /^\d+[uU]$/.test(v) ? 'uint' : /^(\d+\.\d+|\.\d+)([eE][+-]?\d+)?[dD]?$/.test(v) || /^\d+[dD]$/.test(v) ? 'double' : /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fF]$/.test(v) ? 'float' : /^(\d+\.?\d*|\.\d+)[mM]$/.test(v) ? 'decimal' : null);
    /** The type an argument is written with, as a comparable key, or null when the text does not settle it. */
    const argType = (a, b) => {
      let t = T[a], mod = '';
      if (t.k === 'kw' && (t.v === 'ref' || t.v === 'out' || t.v === 'in')) { mod = t.v === 'in' ? '~' : '&'; if (++a >= b) return null; t = T[a]; }
      const one = b - a === 1; let k = null;
      if (t.k === 'str') {
        const c = t.v[0];
        if (c === "'") k = one ? 'char' : null;
        else { k = 'string'; for (let i = a + 1; i < b && k; i++) { const x = T[i]; if (x.k === 'op' && (x.v === '{' || x.v === '${') && match[i] > i) i = match[i]; else if (!(x.k === 'str' && x.v[0] !== "'") && !(x.k === 'op' && x.v === '+')) k = null; } } // literals, interpolated or joined with +
      } else if (one) {
        if (t.k === 'num') k = numType(t.v);
        else if (t.k === 'kw') k = t.v === 'true' || t.v === 'false' ? 'bool' : null;
        else if (t.k === 'id') k = keyOf(bound.has(t.v) ? localType(t.v) : implicitMember(t.v));
      } else if (b - a === 2 && T[a + 1].k === 'id' && mod === '&') k = keyOf(typeDescAt(n, a, a)); // out T name
      else if (b - a === 2 && t.k === 'op' && t.v === '-' && T[a + 1].k === 'num') k = numType(T[a + 1].v);
      else if (t.k === 'op' && t.v === '(' && match[a] === a + 2 && ((T[a + 1].k === 'kw' && TYPE_KW.has(T[a + 1].v) && T[a + 1].v !== 'var' && T[a + 1].v !== 'dynamic') || (T[a + 1].k === 'id' && BCL[T[a + 1].v] && !typesNamed.has(T[a + 1].v) && !bound.has(T[a + 1].v)))) { // (int)x, (Single)x: a cast binds tighter than any operator after it
        k = BCL[T[a + 1].v] || T[a + 1].v;
        for (let i = a + 3; i < b && k; i++) { const x = T[i]; if (x.k === 'op') { if ((x.v === '(' || x.v === '[') && match[i] > i) i = match[i]; else if (x.v !== '.' && x.v !== '?.' && x.v !== '!') k = null; } else if (x.k !== 'id' && x.k !== 'num' && !(x.k === 'kw' && x.v === 'this')) k = null; }
      }
      else if (t.k === 'kw' && (t.v === 'nameof' || t.v === 'typeof') && T[a + 1].v === '(' && match[a + 1] === b - 1) k = t.v === 'nameof' ? 'string' : 'Type';
      else if (t.k === 'kw' && (t.v === 'unchecked' || t.v === 'checked') && T[a + 1].v === '(' && match[a + 1] === b - 1 && b - a > 3) k = argType(a + 2, b - 1);
      else if (b - a >= 5 && T[b - 1].v === ')' && T[b - 2].v === '(' && T[b - 3].v === 'ToString' && T[b - 4].k === 'op' && (T[b - 4].v === '.' || T[b - 4].v === '?.') && match[b - 2] === b - 1) k = 'string'; // x.ToString() is a string
      else if (t.k === 'id' || (t.k === 'kw' && t.v === 'this')) { // a.b.c: properties and fields with declared types
        let chain = true; for (let i = a + 1; i < b && chain; i++) chain = (i - a) % 2 ? T[i].k === 'op' && T[i].v === '.' : T[i].k === 'id';
        if (chain && (b - a) % 2) {
          k = keyOf(chainDesc(b - 1));
          const last = T[b - 1].v; // the size of a runtime collection is an int whatever it holds
          if (!k && b - a >= 3 && (last === 'Length' || last === 'Count')) { const d = chainDesc(b - 3); if (d && d.ext && d.inst !== false && SIZED[last].has(d.name)) k = 'int'; }
        }
      }
      return k ? mod + k : null;
    };
    /**
     * Among the overloads one receiver offers, C# takes the one whose parameter types are exactly the argument
     * types when there is one (an identity conversion beats every other, ECMA-334 "Better conversion from
     * expression"). So when every argument has a written type and some candidate matches them all, the others
     * are not what the call means. Anything less than that keeps every candidate.
     */
    /**
     * C# writes `ref` and `out` at the call: an argument with one needs a parameter with one, and a `ref` or
     * `out` parameter needs it at the call; and such an argument converts to nothing, so when its type is
     * written (`out uint x`, a typed local) the parameter's type must be that one. Candidates that disagree
     * are not applicable, whatever the receiver.
     */
    const byRef = (res) => {
      if (!cs || callOpen < 0 || res.length < 2) return res;
      const close = match[callOpen], mods = [], keys = [];
      for (let a = callOpen + 1, i = a; i <= close; i++) {
        const t = T[i];
        if (i < close && t.k === 'op' && (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') && match[i] > i) { i = match[i]; continue; }
        if (i < close && !(t.k === 'op' && t.v === ',')) continue;
        if (a >= i) break;
        if (T[a + 1] && T[a + 1].k === 'op' && T[a + 1].v === ':' && a + 1 < i) return res; // a named argument: positions say nothing
        const by = T[a].k === 'kw' && (T[a].v === 'ref' || T[a].v === 'out');
        mods.push(by ? '&' : ''); keys.push(by ? argType(a, i) : null); a = i + 1;
      }
      const ok = res.filter((x) => {
        if (!callable(x.s.kind) && x.s.kind !== 'ctor') return true;
        const pt = paramTypes(x), pm = x.pmods; if (!pm) return true;
        const sh = callVia && isExt(x) ? 1 : 0;
        for (let i = 0; i < mods.length && i + sh < pm.length; i++) {
          if ((pm[i + sh] === '&') !== (mods[i] === '&') && !(mods[i] === '&' && pm[i + sh] === '~')) return false;
          if (keys[i] && pt[i + sh] && pm[i + sh] === '&' && pt[i + sh] !== keys[i]) return false;
        }
        return true;
      });
      return ok.length && ok.length < res.length ? ok : res;
    };
    const exact = (res) => {
      if (!cs || callOpen < 0 || !res || res.length < 2) return res;
      const close = match[callOpen], types = [];
      for (let a = callOpen + 1, i = a; i <= close; i++) {
        const t = T[i];
        if (i < close && t.k === 'op' && (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') && match[i] > i) { i = match[i]; continue; }
        if (i < close && !(t.k === 'op' && t.v === ',')) continue;
        if (i === close && a === i) break; // no arguments, or a trailing comma
        const k = a < i ? argType(a, i) : null;
        if (!k) return res;
        types.push(k); a = i + 1;
      }
      const hit = [];
      for (const x of res) {
        if (!callable(x.s.kind) && x.s.kind !== 'ctor') continue;
        const pt = paramTypes(x), sh = callVia && isExt(x) ? 1 : 0;
        let ok = !!pt && pt.length - sh >= types.length;
        for (let i = 0; ok && i < types.length; i++) { const p = pt[i + sh]; ok = p === types[i] || (p !== null && p === `~${types[i]}`); }
        if (ok) hit.push(x);
      }
      if (!hit.length) return res;
      // Equal conversions: the candidate whose parameters all have an argument beats one that needs a default or a params array.
      const full = hit.filter((x) => paramTypes(x).length - (callVia && isExt(x) ? 1 : 0) === types.length && x.s.maxParams !== Infinity), best = full.length ? full : hit;
      return best.length < res.length ? res.filter((x) => best.includes(x) || (!callable(x.s.kind) && x.s.kind !== 'ctor')) : res;
    };

    const site = (name, ref) => { const a = sites.get(name); if (a) a.push(n.id, ref); else sites.set(name, [n.id, ref]); };
    const emit = (name, line, kind, res, args) => {
      if (res === SKIP) { stats.skipped++; unlinked.set(name, (unlinked.get(name) || 0) + 1); site(name, { name, line, kind, to: NONE, status: 'skipped', args }); return; }
      let to = NONE, status = 'unresolved';
      if (res === AMBIGUOUS) { status = 'ambiguous'; unlinked.set(name, (unlinked.get(name) || 0) + 1); }
      else if (res && res.length) {
        if (kind === 'call' || kind === 'new') res = byRef(res);
        status = 'resolved'; to = res.length > 8 ? [...new Set(res.map((x) => x.id))] : [];
        if (res.length <= 8) for (const x of res) if (!to.includes(x.id)) to.push(x.id);
        for (const id of to) if (id !== n.id && !outSet.has(id)) { outSet.add(id); inn.get(id).add(n.id); stats.edges++; }
      }
      const ref = { name, line, kind, to, status, args };
      list.push(ref); stats[status]++;
      if (kind === 'call' || kind === 'new') site(name, ref);
    };
    let viaInterface = false; // set while the overrides of a declaration are collected
    const pick = (cands, args, kindOk, viaMember) => {
      if (!cands) return null;
      const r = []; for (const x of cands) if (kindOk(x.s.kind) && (!strict || admits(x, args, viaMember)) && (viaInterface || !cs || !explicitImpl(x))) r.push(x);
      return r.length ? r : null;
    };
    const memberKind = (k) => callable(k) || k === 'property';
    const calleeKind = (k) => callable(k) || k === 'property' || (constructs && k === 'type');
    const notSelf = (r) => (r ? some(r.filter((x) => x.id !== n.id && x.s.kind !== 'type' && x.s.kind !== 'ctor' && (viaInterface || !cs || !explicitImpl(x)))) : null);

    /** A member call whose receiver says nothing: rules 4 and 5, nothing for stop-list names. */
    const unknownCall = (name, args, exclude) => {
      if (STOPLIST.has(name)) return SKIP;
      return byRules(n, name, args, (x) => callable(x.s.kind) && x.group !== exclude && !(cs && x.stat && !isExt(x)) && !x.s.isTest, true, true);
    };
    /**
     * Class hierarchy analysis (Dean, Grove, Chambers 1995): a call bound to a declaration that derived types can
     * override may run any of those overrides, so they are targets too. Past `maxDispatch` of them the call
     * keeps its declared target only and the name is counted in `unlinked`: the overrides have callers the graph
     * does not show.
     */
    const cap = (res, extra, name) => {
      if (!extra) return res;
      if (extra.length > maxDispatch) { stats.capped++; unlinked.set(name, (unlinked.get(name) || 0) + 1); return res; }
      return res ? res.concat(extra) : extra;
    };
    const dispatch = (res, name, keep) => {
      let extra = null, seen = null;
      viaInterface = true;
      for (const x of res) {
        if (!overridable(x)) continue;
        const any = !cs || isInterface(x.decl); // an interface member is implemented without `override`
        for (const g of derivedOf(x.group)) {
          if (seen && seen.has(g)) continue;
          (seen || (seen = new Set())).add(g);
          for (const y of keep(own(g, name)) || NONE) if (!y.stat && (any || y.s.modifiers.includes('override')) && !res.includes(y)) (extra || (extra = [])).push(y);
        }
      }
      viaInterface = false;
      return cap(res, extra, name);
    };
    /** The receiver's type declares no such member: it comes from a base outside the repository, and the types deriving from the receiver's may implement it. */
    const below = (keys, name, keep) => {
      let extra = null; const seen = new Set();
      viaInterface = true;
      for (const k of keys) for (const g of derivedOf(k)) {
        if (seen.has(g)) continue;
        seen.add(g);
        for (const y of keep(own(g, name)) || NONE) if (!y.stat) (extra || (extra = [])).push(y);
      }
      viaInterface = false;
      return extra;
    };
    /** A call that can only reach the repository as an extension method: the receiver's type has no member of that name. */
    const extCall = (name, args, d) => {
      const all = named.get(name); if (!all) return null;
      let sure = null, maybe = null;
      for (const x of all) {
        if (!isExt(x) || !reachable(n, x) || !admits(x, args, true)) continue;
        const fit = extFits(x, d);
        if (fit === 2) (sure || (sure = [])).push(x); else if (fit === 1) (maybe || (maybe = [])).push(x);
      }
      if (!sure && !maybe) return null;
      if (!sure && STOPLIST.has(name)) return SKIP;
      const u = usingsOf(f), c = sure || maybe, open = c.filter((x) => !x.ns || x.ns === n.ns || u.has(x.ns) || (n.ns || '').startsWith(`${x.ns}.`));
      const v = open.length ? open : c; // the namespaces this file opens come first; a project file may open others
      if (sure) return v;
      const near = v.filter((x) => x.scope === n.scope); if (near.length) return near;
      return v.length <= maxCandidates ? v : AMBIGUOUS;
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
      let r = exact(keep(n.mem.get(name)) || (implicit ? inherited(n.group, name, keep) : null));
      if (r && declared) r = dispatch(r, name, keep);
      for (let o = n.decl && n.decl.decl; !r && implicit && o; o = o.decl) r = exact(keep(own(o.own, name)) || inherited(o.own, name, keep)); // enclosing types
      if (r) return withCtors(r, args, strict);
      if (cs) {
        // Not a member of any type around the call. C# then leaves three readings: a static method brought in
        // by `using static`, a member inherited from a base outside the repository (which derived types may
        // override), or a delegate held in a field. An instance method of some other type is never one of them.
        const all = named.get(name), u = usingsOf(f); let vis = null;
        for (const x of all || NONE) if (x.stat && callable(x.s.kind) && x.s.container && (n.test || !x.test) && admits(x, args, false) && u.has(`${x.ns ? `${x.ns}.` : ''}${x.s.container}`)) (vis || (vis = [])).push(x);
        if (vis) return vis;
        const sub = n.decl ? below([n.group], name, keep) : null;
        if (sub) return cap(null, sub, name);
        if (STOPLIST.has(name)) return SKIP;
        return n.decl && openBases(n.group) ? byRules(n, name, args, (x) => callable(x.s.kind), false, false) : null;
      }
      if (implicit && STOPLIST.has(name)) return SKIP; // inherited from a type the repository does not declare
      return withCtors(byRules(n, name, args, (x) => callable(x.s.kind) || (constructs && x.s.kind === 'type'), false, false), args, strict);
    };
    const bareUse = (name) => {
      if (lexical) { const r = lexicalName(n, name); return r && r !== EXTERNAL ? some(r.filter((x) => x.id !== n.id)) : null; }
      if (!implicit) return null;
      return notSelf(n.mem.get(name)) || (declared && n.decl && basesOf(n.group).length ? inherited(n.group, name, (c) => (c ? some(c.filter((x) => x.s.kind === 'property')) : null)) : null);
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
      const t0 = T[i];
      let j = i + 1, last = null, head = null, parts = 0, qual = null, arity = 0, rooted = false, written = '';
      if (j + 1 < B && T[j].k === 'kw' && T[j].v === 'global' && T[j + 1].v === '::') { j += 2; rooted = true; }
      while (j < B && T[j].k === 'id') {
        if (!head) head = T[j];
        qual = last ? last.v : null; last = T[j]; parts++; j++; arity = 0; written += (written ? '.' : '') + last.v;
        if (angle && j < B && T[j].k === 'op' && T[j].v === '<') { const g = genericClose(T, j, B); if (g > 0) { arity = countTypeArgs(T, match, j, g); j = g + 1; } else arity = undefined; }
        if (j + 1 < B && T[j].k === 'op' && (T[j].v === '.' || T[j].v === '::') && T[j + 1].k === 'id') j++; else break;
      }
      if (!last) { // new(), new[] { … }, new { … }, new int[n]
        if (!cs || !(j < B && T[j].k === 'op' && T[j].v === '(' && match[j] > j)) return i;
        // C# 9 target-typed `new(…)`: the type is the one the value is declared, assigned or returned as.
        const pv = T[i - 1]; let ty = null, h = null;
        if (pv.k === 'op' && pv.v === '=' && i - 3 >= A && T[i - 2].k === 'id') {
          const b3 = T[i - 3];
          if (b3.k === 'id' || b3.k === 'kw' || (b3.k === 'op' && (b3.v === '>' || b3.v === '?'))) h = typeHead(T, i - 3, A); // T name = new(…)
          else { const d = chainDesc(i - 2); if (d && d !== AMBIGUOUS && !d.ext && d.inst !== false) { ty = []; for (const g of d.keys) for (const x of typeOfGroup.get(g) || NONE) ty.push(x); } } // this.x = new(…)
        } else if ((pv.k === 'kw' && pv.v === 'return') || (pv.k === 'op' && pv.v === '=>' && i === A)) { const k = headOf(n).name; if (k > s.a) h = typeHead(T, k - 1, s.a); } // return new(…)
        if (h && h.name && !NOT_TYPE.has(h.name) && !isTypeParam(n, h.name)) { const r = typesFor(n, h.name, h.arity, h.qual, true); if (r && r !== AMBIGUOUS) ty = r; }
        if (!ty || !ty.length) return i;
        const args = countArgs(T, match, j, lang), b = match[j] + 1;
        if (b < B && T[b].k === 'op' && T[b].v === '{') initOf.set(b, ty);
        callOpen = j; callVia = false;
        emit(ty[0].s.name, t0.l, 'new', exact(withCtors(ty, args, strict)), args);
        return i;
      }
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
      } else {
        res = typesFor(n, name, cs ? arity : undefined, qual);
        // `new A.B.C()` names the type by where it is declared (unless A is a `using` alias); `global::` leaves nothing out.
        if (cs && res && res !== AMBIGUOUS && (rooted || (parts > 1 && !aliasesOf(f).has(head.v)))) res = some(res.filter((x) => { const q = `${x.ns ? `${x.ns}.` : ''}${x.s.qname}`; return q === written || (!rooted && q.endsWith(`.${written}`)); }));
      }
      callOpen = nx && nx.k === 'op' && nx.v === '(' ? j : -1; callVia = false;
      if (cs && kind === 'new' && res && res !== AMBIGUOUS) { const b = callOpen < 0 ? j : match[j] + 1; if (b > 0 && b < B && T[b].k === 'op' && T[b].v === '{') initOf.set(b, res.filter(isType)); }
      if (kind === 'new') emit(name, last.l, kind, exact(withCtors(res, args, strict)), args);
      else if (res) emit(name, last.l, kind, res, null);
      return j - 1;
    };

    const member = (i, t, call, j) => {
      const name = t.v, args = call ? countArgs(T, match, j, lang) : null;
      let r = i - 2, rt = r >= 0 ? T[r] : null, arity0;
      if (rt && rt.k === 'op' && rt.v === '!' && r > 0) rt = T[--r]; // x!.Member
      if (rt && rt.k === 'op' && rt.v === '>' && angle) { const o = genericOpen(T, r, 0); if (o > 0) { arity0 = countTypeArgs(T, match, o, r); r = o - 1; rt = T[r]; } } // Cache<T>.Member
      let mode = 'unknown', types = null, target = null, chained = false, desc = null, fixed = false;
      if (rt && rt.k === 'kw' && (rt.v === 'base' || rt.v === 'super')) mode = 'base';
      else if (rt && (rt.k === 'kw' || rt.k === 'id') && (SELF.has(rt.v) || (py && rt.v === 'cls'))) mode = 'this';
      else if (rt && rt.k === 'op' && rt.v === ')' && py && r >= 2 && T[r - 1].v === '(' && T[r - 2].v === 'super') mode = 'base';
      else if (declared && rt && (rt.k === 'id' || rt.k === 'kw') && r >= A) {
        const d = chainDesc(r, arity0);
        if (d === AMBIGUOUS) mode = 'ambiguous';
        else if (d && d.ext) { if (d.inst === false) mode = 'external'; else { mode = 'ext'; desc = d; } }
        else if (d && d.inst === false) { mode = 'type'; fixed = cs; types = []; for (const g of d.keys) for (const x of typeOfGroup.get(g) || NONE) types.push(x); }
        else if (d) { mode = 'typed'; desc = d; }
      } else if (rt && rt.k === 'id') {
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
        const res = exact(keep(n.mem.get(name)) || inherited(n.group, name, keep));
        if (res) emit(name, t.l, call ? 'call' : 'member', declared ? dispatch(res, name, keep) : res, args);
        else if (!call) return;
        else if (declared && selfDesc) { // inherited from outside the repository (derived types may implement it), or an extension method
          const sub = below(selfDesc.keys, name, keep);
          emit(name, t.l, 'call', sub ? cap(null, sub, name) : extCall(name, args, selfDesc), args);
        } else emit(name, t.l, 'call', unknownCall(name, args, null), args);
      } else if (mode === 'typed') { // a value whose declared type the repository declares: its members, what they are overridden by, extension methods
        const inst = cs && desc.inst === true;
        const keep = call ? (c) => { const q = pick(c, args, memberKind, true); return q && inst ? some(q.filter((x) => !x.stat || isExt(x))) : q; } : notSelf;
        let res = null;
        for (const g of desc.keys) { const q = keep(own(g, name)) || inherited(g, name, keep); if (q) res = res ? res.concat(q.filter((x) => !res.includes(x))) : q; }
        if (res) emit(name, t.l, call ? 'call' : 'member', dispatch(exact(res), name, keep), args);
        else {
          const sub = below(desc.keys, name, keep);
          if (sub) emit(name, t.l, call ? 'call' : 'member', cap(null, sub, name), args);
          else if (call) emit(name, t.l, 'call', extCall(name, args, desc), args);
        }
      } else if (mode === 'ext') { // a value of a type the repository does not declare: only an extension method can be ours
        if (call) emit(name, t.l, 'call', extCall(name, args, desc), args);
      } else if (mode === 'base') { // never the caller's own container: base access is not virtual
        const keep = call ? (c) => pick(c, args, memberKind, true) : notSelf;
        const res = inherited(n.group, name, keep);
        if (res) emit(name, t.l, call ? 'call' : 'member', res, args);
        else if (call) emit(name, t.l, 'call', unknownCall(name, args, n.group), args);
      } else if (mode === 'type') {
        // C#: a call written on a type name reaches static members only.
        const keep = (c) => { if (!c) return null; if (!call) return some(c.filter((x) => x.s.kind !== 'ctor')); const q = pick(c, args, (k) => memberKind(k) || k === 'type', false); return q && fixed ? some(q.filter((x) => x.stat || isType(x))) : q; };
        let res = null;
        for (const g of new Set(types.map((x) => x.own))) { const q = keep(own(g, name)) || inherited(g, name, keep); if (q) res = res ? res.concat(q) : q; }
        if (res) emit(name, t.l, call ? 'call' : res.every(isType) ? 'type' : 'member', call ? withCtors(fixed ? exact(res) : res, args, strict) : res, args);
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
        if (nx.v === '=' && (py ? p.v === '(' || p.v === ',' : (p.v === '{' || p.v === ',') && braces.length > 0 && braces[braces.length - 1])) { // keyword argument, member of the object being initialised
          const ty = cs ? inits[inits.length - 1] : null;
          if (ty) { // `new T { Name = … }` sets T's property
            const props = (c) => (c ? some(c.filter((x) => x.s.kind === 'property' && !explicitImpl(x))) : null); let res = null;
            for (const g of new Set(ty.map((x) => x.own))) { const q = props(own(g, name)) || inherited(g, name, props); if (q) res = res ? res.concat(q) : q; }
            if (res) emit(name, t.l, 'member', res, null);
          }
          return;
        }
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
      callOpen = i + 1; callVia = false;
      emit(t.v === 'this' ? s.name : res.length ? res[0].s.name : 'base', t.l, 'new', res.length ? exact(res) : null, args);
      break;
    }

    for (let i = A; i < B; i++) {
      const t = T[i], k = t.k;
      if (k === 'op') {
        if (cs) {
          if (t.v === '{') {
            braces.push(isInit(i));
            let ty = initOf.get(i) || null;
            if (!ty && i > A + 1 && T[i - 1].k === 'kw' && T[i - 1].v === 'with') { const d = chainDesc(i - 2); if (d && d !== AMBIGUOUS && !d.ext && d.inst !== false) { ty = []; for (const g of d.keys) for (const x of typeOfGroup.get(g) || NONE) ty.push(x); } }
            inits.push(ty);
          } else if (t.v === '}') { braces.pop(); inits.pop(); }
        }
        continue;
      }
      if (k !== 'id' && k !== 'kw') continue;
      const p = i > 0 ? T[i - 1] : null, access = p !== null && p.k === 'op' && (p.v === '.' || p.v === '?.' || p.v === '::' || p.v === '->');
      targs = null;
      if (k === 'kw' && !access) { if (t.v === 'new' && hasNew) i = construct(i); continue; }
      let j = i + 1; // the call parenthesis, past explicit generic arguments: Name<T>(…)
      if (angle && j < B && T[j].k === 'op' && T[j].v === '<') { const g = genericClose(T, j, B); if (g > 0 && g + 1 < B && T[g + 1].k === 'op' && T[g + 1].v === '(') { if (cs) targs = countTypeArgs(T, match, j, g); j = g + 1; } }
      const call = j < B && T[j].k === 'op' && T[j].v === '(' && match[j] > j;
      callOpen = call ? j : -1; callVia = access;
      if (access) member(i, t, call, j); else bare(i, t, call, j);
    }
    targs = null;
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
/**
 * The graph as index arrays (compressed sparse rows, both directions), node order = insertion order of graph.nodes.
 * An edge from a symbol to itself and an edge to something that is not a node are left out, so every measure
 * agrees on what an edge is (buildGraph adds neither; a graph built by hand may hold them).
 */
function arrays(graph) {
  let c = derived.get(graph); if (c) return c;
  const ids = [...graph.nodes.keys()], n = ids.length, pos = new Map();
  for (let i = 0; i < n; i++) pos.set(ids[i], i);
  const outStart = new Int32Array(n + 1), inStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { const s = graph.out.get(ids[i]); if (s) for (const to of s) { const j = pos.get(to); if (j !== undefined && j !== i) { outStart[i + 1]++; inStart[j + 1]++; } } }
  for (let i = 0; i < n; i++) { outStart[i + 1] += outStart[i]; inStart[i + 1] += inStart[i]; }
  const outTo = new Int32Array(outStart[n]), inFrom = new Int32Array(outStart[n]), fill = inStart.slice(0, n);
  for (let i = 0, e = 0; i < n; i++) { const s = graph.out.get(ids[i]); if (s) for (const to of s) { const j = pos.get(to); if (j !== undefined && j !== i) { outTo[e++] = j; inFrom[fill[j]++] = i; } } }
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
    for (const v of frontier) { const s = edges.get(v); if (s) for (const u of s) if (!seen.has(u) && graph.nodes.has(u)) { seen.add(u); next.push(u); } }
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
 *   unlinked     references written with this symbol's name that could not be linked (stop list, ambiguous,
 *                dispatch past the cap).
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
