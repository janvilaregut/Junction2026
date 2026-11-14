// Deterministic checks on a pull request: statements that are true or false about the code at two commits.
// No statistics, no model, nothing is executed. Every check reads the tokens and symbols of lex.js and
// symbols.js at the merge base and at the head, and reports only what this pull request introduced: something
// on a line it added, or a consequence of something it changed or removed.
//
// Finding: { id, severity, file, line, symbol, title, detail, basis }
//   id        the rule, stable across runs (import.missing-file, arity.mismatch, test.removed, ...)
//   severity  'bad'   the stated fact is itself the defect (the code cannot link, a test is gone, a key is in the source)
//             'warn'  the stated fact is true, but whether it is a defect depends on something not resolved here
//             'info'  a fact worth a reader's eye
//   symbol    id of the innermost symbol at head that contains the line (symbolAt), or null
//   title     at most eight words
//   detail    one sentence with the concrete names and numbers
//   basis     why this is a fact and not an opinion, and what was NOT established
//
// Honesty rule. Nothing here is a proof of correctness or of a bug. A finding states what was read (a name is in
// no export list, no declaration takes that many arguments, a block has no token). There is no type checker here:
// a call is 'bad' only when the text alone binds it to a declaration (an import, the same file, the enclosing
// type); when the text merely ties it to the declaring type by name it is 'warn' and its basis says so; when
// nothing ties it, nothing is reported, because a method of the same name on another type is the norm. Every
// doubt is resolved towards silence, so the absence of findings proves nothing.
// A context object is read once (its indexes are cached on it): build a new one for another pull request.
import path from 'node:path';
import { isJsLike, langOf, signature } from './lex.js';
import { symbolAt, isTestPath } from './symbols.js';

const px = path.posix;
const SEVERITY = { bad: 0, warn: 1, info: 2 };
const ID = /^[A-Za-z_$][\w$]*$/;
const lazy = (fn) => { let v, done = false; return () => { if (!done) { v = fn(); done = true; } return v; }; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const family = (lang) => (isJsLike(lang) ? 'js' : lang);
const isOpTok = (t, v) => !!t && t.k === 'op' && t.v === v;
const isWord = (t) => !!t && (t.k === 'id' || t.k === 'kw');
/** A whole string literal without its quotes, or null for a piece of a template or interpolated string. */
const unquote = (v) => { const m = /^[@$A-Za-z]{0,3}("""|'''|"|'|`)([\s\S]*)\1$/.exec(v); return m ? m[2] : null; };

// ───────────────────────────────────────────────────────────── context

const PREP = new WeakMap();
/** Normalises the context once and holds the indexes the checks share. Tolerates missing or malformed parts. */
function prep(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  if (PREP.has(c)) return PREP.get(c);
  const asMap = (m) => (m instanceof Map ? m : new Map());
  const head = asMap(c.head), base = asMap(c.base);
  const diff = (Array.isArray(c.diff) ? c.diff : []).filter((f) => f && typeof f.path === 'string' && !f.binary).map((f) => ({
    path: f.path, oldPath: typeof f.oldPath === 'string' && f.oldPath ? f.oldPath : f.path, status: f.status || 'modified',
    hunks: (Array.isArray(f.hunks) ? f.hunks : []).filter(Boolean).map((h) => ({ oldStart: +h.oldStart || 0, oldLines: +h.oldLines || 0, newStart: +h.newStart || 0, newLines: +h.newLines || 0, added: Array.isArray(h.added) ? h.added : [], removed: Array.isArray(h.removed) ? h.removed : [] })),
  }));
  const tree = c.tree instanceof Set ? c.tree : new Set(Array.isArray(c.tree) ? c.tree.map((x) => (typeof x === 'string' ? x : x && x.path)).filter(Boolean) : head.keys());
  const byPath = new Map(diff.map((f) => [f.path, f]));
  const added = new Map(), moved = new Map(), EMPTY = new Map(), NONE = new Set();
  const byName = (files) => lazy(() => { const m = new Map(); for (const F of files.values()) for (const s of (F && F.symbols) || []) { const a = m.get(s.name); if (a) a.push(s); else m.set(s.name, [s]); } return m; });
  const P = {
    head, base, diff, tree, byPath, manifests: c.manifests && typeof c.manifests === 'object' ? c.manifests : {},
    /** The same file at the merge base: { path, F }, or null when the pull request added it. */
    baseOf(file) { const d = byPath.get(file); if (d && d.status === 'added') return null; const p = d ? d.oldPath : file, F = base.get(p); return F ? { path: p, F } : null; },
    /** Lines the pull request added to a file: Map<line at head, text>. */
    added(file) {
      if (added.has(file)) return added.get(file);
      const d = byPath.get(file); if (!d || d.status === 'deleted') return EMPTY;
      const m = new Map(); for (const h of d.hunks) h.added.forEach((text, k) => m.set(h.newStart + k, String(text)));
      added.set(file, m); return m;
    },
    /** Added lines whose text also left the same file (re-indented or moved): not new content. */
    moved(file) {
      if (moved.has(file)) return moved.get(file);
      const d = byPath.get(file); if (!d) return NONE;
      const norm = (s) => String(s).trim().replace(/\s+/g, ' '), pool = new Map(), out = new Set();
      for (const h of d.hunks) for (const r of h.removed) { const k = norm(r); if (k) pool.set(k, (pool.get(k) || 0) + 1); }
      for (const [line, text] of P.added(file)) { const k = norm(text), n = pool.get(k); if (n > 0) { out.add(line); pool.set(k, n - 1); } }
      moved.set(file, out); return out;
    },
    headNames: byName(head), baseNames: byName(base),
    sideHead: lazy(() => sideOf(tree, head)),
    // The tree at the merge base is the tree at head with the diff undone.
    sideBase: lazy(() => { const t = new Set(tree); for (const d of diff) { if (d.status !== 'deleted') t.delete(d.path); } for (const d of diff) { if (d.status !== 'added') t.add(d.oldPath); } return sideOf(t, base); }),
    closed: new Map(),
    // Source files of a language family that are in the tree but were not handed over parsed (too large, skipped
    // folder, file limit): a declaration may hide there, so "declared nowhere" cannot be said for that family.
    unread: (() => { const memo = new Map(); return (fam) => { if (!memo.has(fam)) { let n = 0; for (const f of tree) { const l = langOf(f); if (l && family(l) === fam && !head.has(f)) n++; } memo.set(fam, n); } return memo.get(fam); }; })(),
    // `global using static X;` anywhere makes the members of X visible, unqualified, in every C# file.
    globalStatic: lazy(() => { for (const F of head.values()) { if (!F || F.lang !== 'cs') continue; const T = F.tokens; for (let i = 0; i + 2 < T.length; i++) if (T[i].k === 'kw' && T[i].v === 'global' && T[i + 1].v === 'using' && T[i + 2].v === 'static') return true; } return false; }),
    lowerTree: lazy(() => { const m = new Map(); for (const f of tree) m.set(f.toLowerCase(), f); return m; }),
    globalUsingAdded: lazy(() => diff.some((d) => /\.cs$/i.test(d.path) && d.hunks.some((h) => h.added.some((l) => /^\s*global\s+using\b/.test(String(l)))))),
    // `declare module 'name'` (TypeScript ambient modules, wildcards included): specifiers the repository itself gives a meaning.
    ambient: lazy(() => {
      const out = [];
      for (const F of head.values()) {
        if (!F || F.lang !== 'ts' || !Array.isArray(F.tokens)) continue;
        const T = F.tokens;
        for (let i = 0; i + 2 < T.length; i++) if (T[i].v === 'declare' && T[i + 1].v === 'module' && T[i + 2].k === 'str') { const name = unquote(T[i + 2].v); if (name) out.push(new RegExp(`^${name.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)); }
      }
      return out;
    }),
  };
  // Does the pull request change code that is not a test? (An edited expectation only matters next to that.)
  P.changesSource = lazy(() => diff.some((d) => langOf(d.path) && !isTestFile(P, d) && d.hunks.some((h) => h.added.length || h.removed.length)));
  PREP.set(c, P);
  return P;
}

function sideOf(tree, files) {
  return {
    tree, files,
    dirs: lazy(() => { const d = new Set(); for (const p of tree) { let i = p.lastIndexOf('/'); while (i > 0) { const dir = p.slice(0, i); if (d.has(dir)) break; d.add(dir); i = dir.lastIndexOf('/'); } } return d; }),
    // Every path up to the first dot of its file name: `a/index` for a/index.vue, `pkg/mod` for pkg/mod.cpython-312.so.
    stems: lazy(() => { const s = new Set(); for (const p of tree) { const slash = p.lastIndexOf('/'), dot = p.indexOf('.', slash + 1); if (dot > slash + 1) s.add(p.slice(0, dot)); } return s; }),
  };
}

const isTestFile = (P, d) => isTestPath(d.path) || isTestPath(d.oldPath) || !!(P.head.get(d.path) || P.base.get(d.oldPath))?.symbols?.some((s) => s.isTest);

/** A finding. `symbol` is the innermost symbol at head around the line, unless the caller names one (or null). */
function mk(P, id, severity, file, line, title, detail, basis, sym) {
  const F = P.head.get(file), s = sym !== undefined ? sym : F && line > 0 ? symbolAt(F, line) : null;
  return { id, severity, file, line: line > 0 ? line : 1, symbol: s ? s.id : null, title, detail, basis };
}

/** Index of the first token on or after a line (tokens are in line order). */
function firstAt(F, line) {
  const T = F.tokens; let lo = 0, hi = T.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid].l < line) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The innermost symbol whose declaration contains token i. */
function ownerOf(F, i) {
  let best = null;
  for (const s of F.symbols) if (s.a <= i && i < s.b && (!best || s.b - s.a <= best.b - best.a)) best = s;
  return best;
}

// ───────────────────────────────────────────────────────────── imports

const JS_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.d.ts'];
// TypeScript's ESM convention: the specifier names the file that will exist after compilation.
const TS_FOR = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'], '.jsx': ['.tsx'] };
const OUTSIDE = Symbol('outside the repository');

/** The file a relative specifier denotes in a tree: its path, null when there is none, OUTSIDE when it leaves the repository. */
function resolveJs(side, from, spec) {
  let p = px.normalize(px.join(px.dirname(from), spec.replace(/[?#].*$/, '')));
  if (p === '..' || p.startsWith('../')) return OUTSIDE;
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '.') p = '';
  const { tree } = side;
  if (p) {
    if (tree.has(p)) return p;
    for (const e of JS_EXT) if (tree.has(p + e)) return p + e;
    const ext = px.extname(p);
    if (TS_FOR[ext]) for (const e of TS_FOR[ext]) { const q = p.slice(0, -ext.length) + e; if (tree.has(q)) return q; }
  }
  const dir = p ? `${p}/` : '';
  for (const e of JS_EXT) if (tree.has(`${dir}index${e}`)) return `${dir}index${e}`;
  if (tree.has(`${dir}package.json`)) return `${dir}package.json`;
  // Comp.vue for './Comp', index.svelte for './dir': a bundler's extension list decides, and a file of that name is there.
  if (side.stems().has(`${dir}index`)) return `${dir}index.*`;
  if (p && side.stems().has(p)) return `${p}.*`;
  return null;
}

const EXPORTS = new WeakMap();
/**
 * The export list of a JavaScript or TypeScript module, read from its tokens: { names, open, esm, cjs }.
 * `open` means the list cannot be closed from this file alone (export *, module.exports = <expression>, a spread,
 * exports handed to another function, a declaration file). Any doubt adds a name or sets `open`: the list may
 * contain too much, never too little, so "not exported" is only ever said of a name that truly is not there.
 */
function jsExports(F) {
  if (EXPORTS.has(F)) return EXPORTS.get(F);
  // JSX is not tokenised as such, so brackets inside it cannot be trusted to balance: such a file's list stays open.
  const T = F.tokens, M = F.match, names = new Set(), r = { names, open: /\.d\.[cm]?ts$|\.[jt]sx$/.test(F.path), esm: false, cjs: false };
  const op = (i, v) => isOpTok(T[i], v), word = (i) => (isWord(T[i]) ? T[i].v : null);
  const strip = (v) => v.replace(/^[`'"]|[`'"]$/g, '');
  const list = (a, b) => { // { x, y as z, type T }: the last word of each entry is the exported name
    let last = null;
    for (let k = a + 1; k < b; k++) { if (op(k, ',')) { if (last) names.add(last); last = null; } else if (word(k)) last = word(k); else if (T[k].k === 'str') last = strip(T[k].v); }
    if (last) names.add(last);
  };
  let depth = 0;
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.k === 'op') {
      if (t.v === '{' || t.v === '(' || t.v === '[' || t.v === '${') depth++; else if (t.v === '}' || t.v === ')' || t.v === ']') depth--;
      else if ((t.v === '<' && op(i + 1, '/')) || (t.v === '/' && op(i + 1, '>'))) r.open = true; // a JSX tag in a .js file
      continue;
    }
    if (t.k === 'kw' && t.v === 'export' && depth !== 0 && !op(i - 1, '.')) { r.open = true; continue; } // inside a namespace, or the depth is off
    if (t.k === 'kw' && t.v === 'export' && depth === 0 && !op(i - 1, '.')) {
      r.esm = true;
      let j = i + 1;
      if (word(j) === 'default') { names.add('default'); continue; }
      if (word(j) === 'type' && (op(j + 1, '{') || op(j + 1, '*'))) j++;
      if (op(j, '*')) { if (word(j + 1) === 'as' && word(j + 2)) names.add(word(j + 2)); else r.open = true; continue; }
      if (op(j, '{')) { if (M[j] > j) list(j, M[j]); else r.open = true; continue; }
      while (['declare', 'abstract', 'async'].includes(word(j))) j++;
      const w = word(j);
      if (w === 'function') { let k = j + 1; if (op(k, '*')) k++; if (word(k)) names.add(word(k)); else r.open = true; continue; }
      if (['class', 'interface', 'enum', 'type', 'namespace', 'module'].includes(w)) { if (word(j + 1)) names.add(word(j + 1)); else r.open = true; continue; }
      if (w === 'const' || w === 'let' || w === 'var') {
        let k = j + 1;
        if (word(k) === 'enum') { if (word(k + 1)) names.add(word(k + 1)); else r.open = true; continue; }
        for (;;) { // declarators, separated by commas at the statement's own depth
          if ((op(k, '{') || op(k, '[')) && M[k] > k) { for (let q = k + 1; q < M[k]; q++) if (word(q)) names.add(word(q)); k = M[k] + 1; }
          else if (word(k)) { names.add(word(k)); k++; }
          else break;
          let end = false;
          for (; k < T.length; k++) {
            const u = T[k];
            if (u.k === 'kw' && (u.v === 'export' || (u.v === 'import' && !op(k + 1, '(') && !op(k + 1, '.')))) { end = true; break; }
            if (u.k !== 'op') continue;
            if ((u.v === '(' || u.v === '[' || u.v === '{' || u.v === '${') && M[k] > k) { k = M[k]; continue; }
            if (u.v === ',') break;
            if (u.v === ';' || u.v === ')' || u.v === ']' || u.v === '}') { end = true; break; }
          }
          if (end || k >= T.length) break;
          k++;
        }
        continue;
      }
      r.open = true; // export = x, export as namespace X, export import a = b
      continue;
    }
    if ((t.v === 'exports' || t.v === 'module') && (t.k === 'id' || t.k === 'kw') && !op(i - 1, '.')) {
      let j = i;
      if (t.v === 'module') {
        if (!(op(i + 1, '.') && word(i + 2) === 'exports')) {
          // `register(module)`, `const m = module`: whoever receives the module object can add exports. Reading a
          // property (module.id) or comparing it (require.main === module, typeof module) cannot.
          const cmp = (u) => !!u && u.k === 'op' && ['===', '==', '!==', '!='].includes(u.v);
          if (!op(i + 1, '.') && !cmp(T[i - 1]) && !cmp(T[i + 1]) && word(i - 1) !== 'typeof') r.open = true;
          continue;
        }
        j = i + 2;
      }
      r.cjs = true;
      if (op(j + 1, '.') && word(j + 2)) names.add(word(j + 2));
      else if (op(j + 1, '=') && op(j + 2, '{') && M[j + 2] > j + 2) {
        let first = true;
        for (let k = j + 3; k < M[j + 2]; k++) {
          const u = T[k];
          if (first) {
            if (isOpTok(u, '...') || isOpTok(u, '[')) r.open = true;
            else if (u.k === 'str') names.add(strip(u.v));
            else if (isWord(u)) { names.add(u.v); if (['async', 'get', 'set'].includes(u.v) && word(k + 1)) names.add(word(k + 1)); }
            first = false;
          }
          if (u.k === 'op' && (u.v === '(' || u.v === '[' || u.v === '{' || u.v === '${') && M[k] > k) k = M[k];
          else if (isOpTok(u, ',')) first = true;
        }
      } else r.open = true; // module.exports = factory(), exports[key] = …, Object.assign(exports, …)
    }
  }
  if (depth !== 0) r.open = true;
  EXPORTS.set(F, r);
  return r;
}

// https://nodejs.org/api/module.html#modulebuiltinmodules, without the ones that only exist behind `node:`.
const NODE_BUILTINS = new Set('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(' '));
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies'];
// Modules the host program provides: never in a manifest.
const HOST_PROVIDED = new Set(['bun', 'k6', 'vscode', 'atom']);
/** The package a bare specifier names (`@scope/pkg/sub` → `@scope/pkg`), or null when it is not a package name (aliases like `@/x`, `~/x`, `#internal`). */
const packageOf = (spec) => { const m = /^(@[a-z0-9][a-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*|[A-Za-z0-9][A-Za-z0-9._~-]*)(\/|$)/.exec(spec); return m ? m[1] : null; };

/**
 * Is a package declared for a file? true / false, or null when it cannot be decided (no manifest was read for
 * that folder, or one on the way to the root was not read). A manifest in any folder above the file counts:
 * Node resolves a bare specifier by walking up the node_modules of every ancestor.
 */
function packageDeclared(P, file, pkg, ts) {
  const list = Array.isArray(P.manifests.packageJson) ? P.manifests.packageJson.filter((m) => m && typeof m.dir === 'string') : [];
  if (!list.length) return null;
  const known = new Map(list.map((m) => [m.dir === '.' ? '' : m.dir.replace(/^\.\/|\/$/g, ''), m.json]));
  const types = `@types/${pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg}`;
  const declares = (j) => j.name === pkg || DEP_FIELDS.some((f) => { const v = j[f]; return Array.isArray(v) ? v.includes(pkg) : !!v && typeof v === 'object' && (Object.hasOwn(v, pkg) || (ts && Object.hasOwn(v, types))); });
  let dir = px.dirname(file), seen = 0;
  for (;;) {
    const d = dir === '.' ? '' : dir;
    if (known.has(d)) { const j = known.get(d); if (!j || typeof j !== 'object') return null; seen++; if (declares(j)) return true; }
    else if (P.tree.has(d ? `${d}/package.json` : 'package.json')) return null;
    if (!d) break;
    dir = px.dirname(d);
  }
  if (!seen) return null;
  return list.some((m) => m.json && m.json.name === pkg); // a workspace package of this repository is installed by linking
}

/** A bare specifier whose first segment is a folder or file next to a manifest (or under its src/) is a path alias, not a package. */
function looksLikeAlias(P, file, pkg) {
  const seg = pkg.split('/')[0], H = P.sideHead();
  for (let dir = px.dirname(file); ; dir = px.dirname(dir)) {
    const d = dir === '.' ? '' : `${dir}/`;
    for (const root of [d, `${d}src/`]) if (H.dirs().has(root + seg) || H.stems().has(root + seg)) return true;
    if (!d) return false;
  }
}

/** Is token i inside a try block (at most four brackets up)? An import there is guarded: its failure is handled. */
function inTry(F, i) {
  const T = F.tokens;
  for (let hops = 0; hops < 4; hops++) {
    const g = enclosingOpen(F, i); if (g < 0) return false;
    if (isOpTok(T[g], '{') && T[g - 1] && ((T[g - 1].k === 'kw' && T[g - 1].v === 'try') || (isOpTok(T[g - 1], ':') && T[g - 2] && T[g - 2].k === 'kw' && T[g - 2].v === 'try'))) return true;
    i = g;
  }
  return false;
}

/**
 * Is the require( or import( at token i evaluated only under a condition: `cond ? require(x) : y`, `a && require(x)`,
 * `if (exists) x = require(…)`? Looks back to the start of the statement; any doubt answers yes.
 */
function conditionalAt(F, i) {
  const T = F.tokens, M = F.match;
  for (let j = i - 1, n = 0; j >= 0 && n < 60; j--, n++) {
    const t = T[j];
    if (t.k === 'kw') {
      if (t.v === 'if' || t.v === 'else' || t.v === 'case') return true;
      if (['const', 'let', 'var', 'function', 'class', 'import', 'export'].includes(t.v)) return false; // the statement starts here
    } else if (t.k === 'op') {
      if (t.v === ';' || t.v === '}') return false;
      if (t.v === '?' || t.v === '&&' || t.v === '||' || t.v === '??') return true;
      if (t.v === '{') { const p = T[j - 1], q = isOpTok(p, ')') && M[j - 1] > 0 ? T[M[j - 1] - 1] : null; return !!p && ((p.k === 'kw' && p.v === 'else') || (!!q && q.k === 'kw' && q.v === 'if')); }
      if (t.v === ')' && M[j] >= 0 && M[j] < j) { const q = T[M[j] - 1]; if (q && q.k === 'kw' && q.v === 'if') return true; j = M[j]; }
    }
  }
  return false;
}

/**
 * The string token that carries an import's specifier: { partial, guarded, conditional, named }.
 * `partial`: it is not the whole specifier (`require('./dir/' + name)`, a template with holes): symbols.js records
 * the first piece as the source, and nothing can be resolved from a piece. `guarded`: the import is in a try block,
 * or it is a dynamic import whose promise has a .catch handler. `conditional`: a require or dynamic import that
 * runs only under a condition (see conditionalAt). `named`: the clause holds string names (`import { 'a-b' as c }`),
 * which symbols.js does not read as names, so its list of imported names cannot be used.
 */
function specifierShape(F, imp) {
  const T = F.tokens; let named = false;
  for (let i = firstAt(F, imp.line), n = 0; i < T.length && n < 200; i++, n++) {
    const t = T[i];
    if ((t.k === 'kw' && (t.v === 'import' || t.v === 'export')) || (t.k === 'id' && t.v === 'require')) named = false; // another statement begins
    if (t.k !== 'str') continue;
    const whole = unquote(t.v);
    if ((whole == null ? t.v.slice(1) : whole) !== imp.source) { named = true; continue; }
    const call = isOpTok(T[i - 1], '(') && isWord(T[i - 2]) && (T[i - 2].v === 'require' || T[i - 2].v === 'import');
    if (!call && !(isWord(T[i - 1]) && (T[i - 1].v === 'from' || T[i - 1].v === 'import'))) continue; // the same text elsewhere on the line: existsSync('./x') ? require('./x') : …
    const close = call ? F.match[i - 1] : -1;
    const caught = close > 0 && isOpTok(T[close + 1], '.') && !!T[close + 2] && T[close + 2].v === 'catch';
    return { partial: whole == null || (isOpTok(T[i - 1], '(') && !isOpTok(T[i + 1], ')')), guarded: inTry(F, i) || caught, conditional: call && conditionalAt(F, i - 2), named };
  }
  return { partial: false, guarded: false, conditional: false, named: false };
}

/** TypeScript's `import x = require('./y')` binds the module object: it needs no default export. */
function importEquals(F, imp) {
  const T = F.tokens;
  for (let i = firstAt(F, imp.line); i < T.length && T[i].l === imp.line; i++) if (T[i].k === 'kw' && T[i].v === 'import' && isOpTok(T[i + 2], '=')) return true;
  return false;
}

/**
 * unresolvedImports(ctx) → Finding[]
 *
 * Establishes, for imports this pull request added or broke:
 *   import.missing-file       bad   JS/TS: a relative specifier that names no file in the tree at head (the path, the
 *                                   usual extensions, a TypeScript source for a .js specifier, /index.*); warn when
 *                                   the path points into an output folder (dist, build, generated, ...) or when the
 *                                   require or dynamic import runs only under a condition (`exists ? require(x) : {}`)
 *   import.missing-export     bad   JS/TS: a name imported from a repository module whose export list is closed
 *                                   (see jsExports) and does not contain it
 *   import.undeclared-package bad   JS/TS: a bare package that is neither a Node builtin nor declared in a
 *                                   package.json between the file and the repository root, and that no file imported
 *                                   at the merge base; warn when the diff also edits a resolver configuration
 *   import.missing-module     bad   Python: a relative import of a module that is not in the tree; warn for a name
 *                                   build tools write (_version, *_pb2)
 *   import.unknown-package    warn  Python: a top-level package that is not standard library, not a module of this
 *                                   repository and not in requirements/pyproject
 *   import.unknown-namespace  warn  C#: a using whose namespace no file declares, with no framework root and no
 *                                   PackageReference sharing its first segment
 * "Introduced" means: the problem holds at head and the same import did not have the same problem at the merge base.
 * Left alone: imports inside a try block and dynamic imports with a .catch handler (their failure is handled),
 * packages required only under a condition, specifiers built at run time, specifiers that look like path aliases
 * or that a `declare module` of the repository names, import clauses with string names, the usings of generator
 * output (*.g.cs, *.generated.cs, *.Designer.cs), and C# namespaces some file already imported at the merge base.
 * Does not establish: that a declared package exists in a registry, that tsconfig paths or bundler aliases are
 * honoured, or anything about imports built at run time.
 * The undeclared-package rule is the deterministic guard against hallucinated dependencies: in 576,000 code
 * samples from 16 models, 5.2% (commercial) to 21.7% (open source) of the packages named did not exist
 * (Spracklen, Wijewickrama, Sakib, Maiti, Viswanath & Jadliwala, "We Have a Package for You! A Comprehensive
 * Analysis of Package Hallucinations by Code Generating LLMs", USENIX Security 2025).
 */
export function unresolvedImports(ctx) {
  const P = prep(ctx), out = [];
  const H = P.sideHead(), B = P.sideBase();
  const hasImportMap = ['deno.json', 'deno.jsonc', 'import_map.json', 'importmap.json'].some((f) => P.tree.has(f));
  // Declarations this pull request removed from a package.json: Map<dir, Set<package>>.
  const dropped = new Map();
  for (const d of P.diff) if (px.basename(d.oldPath) === 'package.json') {
    const dir = px.dirname(d.oldPath) === '.' ? '' : px.dirname(d.oldPath), set = dropped.get(dir) || new Set();
    for (const h of d.hunks) for (const r of h.removed) { const m = /^\s*"((?:@[^"/]+\/)?[^"/]+)"\s*:\s*"/.exec(r); if (m) set.add(m[1]); }
    dropped.set(dir, set);
  }
  const wasDropped = (file, pkg) => { for (const [dir, set] of dropped) if (set.has(pkg) && (!dir || file.startsWith(`${dir}/`))) return true; return false; };
  // Package names and scopes that files at the merge base imported although no manifest (as read at head) declares them.
  const undeclaredBefore = lazy(() => {
    const set = new Set();
    for (const [bp, BF] of P.base) {
      if (!BF || !isJsLike(BF.lang)) continue;
      for (const im of BF.imports || []) { const q = typeof im.source === 'string' ? packageOf(im.source) : null; if (q && !NODE_BUILTINS.has(q) && packageDeclared(P, bp, q, BF.lang === 'ts') === false) { set.add(q); if (q[0] === '@') set.add(q.split('/')[0]); } }
    }
    return set;
  });
  const aliasConfigTouched = P.diff.some((d) => /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|(vite|webpack|rollup|babel|next|nuxt)\.config\.[cm]?[jt]s|\.babelrc)$/.test(d.path));

  const namespacesSeen = new Map();
  for (const file of [...P.head.keys()].sort()) { // in path order, so the result does not depend on how the map was filled
    const F = P.head.get(file);
    if (!F || !Array.isArray(F.imports) || !F.imports.length) continue;
    const bv = P.baseOf(file), inDiff = P.byPath.has(file);
    if (isJsLike(F.lang)) {
      for (const imp of F.imports) {
        const spec = imp.source; if (typeof spec !== 'string' || !spec) continue;
        const before = bv ? bv.F.imports.filter((x) => x.source === spec) : [];
        const shape = specifierShape(F, imp);
        if (shape.partial) continue;
        if (/^\.\.?(\/|$)/.test(spec)) {
          const names = Array.isArray(imp.names) ? imp.names : [];
          const r = resolveJs(H, file, spec);
          if (r === OUTSIDE) continue;
          const rb = before.length ? resolveJs(B, bv.path, spec) : undefined;
          if (r === null) {
            if ((before.length && rb === null) || shape.guarded) continue; // it pointed nowhere before this pull request as well, or its failure is caught
            const want = px.normalize(px.join(px.dirname(file), spec.replace(/[?#].*$/, '')));
            const built = /(^|\/)(dist|build|out|generated|__generated__|gen|\.next|target|bin|obj)\//.test(`${want}/`); // output folders are usually not committed
            const twin = [want, ...JS_EXT.map((e) => want + e)].map((q) => P.lowerTree().get(q.toLowerCase())).find(Boolean);
            // A require that runs only under a condition (`exists ? require('./local') : {}`) is how optional, uncommitted files are loaded.
            const soft = built || shape.conditional;
            out.push(mk(P, 'import.missing-file', soft ? 'warn' : 'bad', file, imp.line, 'Import of a file that does not exist',
              `${file} imports '${spec}', but no file answers to ${want} at head${typeof rb === 'string' ? ` (${rb} existed at the merge base and this pull request removed or renamed it)` : twin ? ` (${twin} differs only in letter case, which a case-sensitive file system does not forgive)` : ''}.`,
              `The specifier was resolved against the complete file list of the head commit: the path itself, the JavaScript and TypeScript extensions and an index file. Not established: ${built ? 'that the file is missing after a build; the path points into an output folder, which is why this is a warning' : shape.conditional ? 'that the import is ever evaluated; it runs only under a condition, which is why this is a warning' : 'a file generated at build time and never committed'}.`));
            continue;
          }
          const target = P.head.get(r); if (!target || !isJsLike(target.lang)) continue;
          const ex = jsExports(target); if (ex.open || !ex.names.size) continue;
          const wanted = !shape.named && names.every((n) => ID.test(n.imported) && ID.test(n.local)) ? names.map((n) => n.imported) : []; // a nested destructuring pattern or string names are not a list of names
          if (imp.default && imp.default !== 'type' && !imp.ns && ex.esm && !ex.cjs && !importEquals(F, imp)) wanted.push('default'); // `import type {…}` (Flow) has no default binding
          for (const name of new Set(wanted)) {
            if (ex.names.has(name) || (name === 'default' && ex.cjs)) continue;
            const had = before.some((x) => (name === 'default' ? x.default && !x.ns : (x.names || []).some((y) => y.imported === name)));
            if (had) { // was the same name already missing at the merge base?
              const tb = typeof rb === 'string' ? P.base.get(rb) : null, eb = tb && isJsLike(tb.lang) ? jsExports(tb) : null;
              if (rb === null || (eb && !eb.open && eb.names.size && !eb.names.has(name))) continue;
            }
            const shown = [...ex.names].sort();
            out.push(mk(P, 'import.missing-export', 'bad', file, imp.line, 'Imported name is not exported',
              `${file} imports '${name}' from '${spec}', but ${r} exports only ${shown.slice(0, 8).join(', ')}${shown.length > 8 ? ` and ${shown.length - 8} more` : ''}.`,
              'Every export statement of the target was read from its tokens and none re-exports another module wholesale, so its export list is closed and the name is not in it. Not established: exports added at run time.'));
          }
          continue;
        }
        // A bare specifier: a package, unless it is a builtin, a URL-like scheme, an alias or an optional require.
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) || hasImportMap || shape.guarded || shape.conditional) continue;
        const pkg = packageOf(spec); if (!pkg || NODE_BUILTINS.has(pkg) || HOST_PROVIDED.has(pkg) || P.ambient().some((re) => re.test(spec))) continue;
        if (packageDeclared(P, file, pkg, F.lang === 'ts') !== false || looksLikeAlias(P, file, pkg)) continue;
        const was = !!bv && bv.F.imports.some((x) => typeof x.source === 'string' && packageOf(x.source) === pkg);
        const removed = was && wasDropped(file, pkg);
        // The repository already imported this undeclared name (or this undeclared scope) before the pull request:
        // an alias or a transitive dependency it has been living with, not something introduced here.
        if (!removed && (was || !inDiff || undeclaredBefore().has(pkg) || (pkg[0] === '@' && undeclaredBefore().has(pkg.split('/')[0])))) continue;
        out.push(mk(P, 'import.undeclared-package', aliasConfigTouched ? 'warn' : 'bad', file, imp.line, removed ? 'Package no longer declared' : 'Package not declared',
          `${file} imports '${spec}', but no package.json between it and the repository root lists '${pkg}' in dependencies, devDependencies, peerDependencies or optionalDependencies${removed ? '; this pull request removed the declaration' : ''}.`,
          `The manifests were read at head and the package name was looked up exactly; it is not a Node builtin and no file imported it at the merge base. Nothing guarantees an undeclared package is installed. Not established: whether another dependency happens to bring it in, or whether a package of that name exists in the registry at all (Spracklen et al. 2025 measure how often a model invents one)${aliasConfigTouched ? '; this pull request also edits a resolver configuration that may define it as an alias, which is why this is a warning' : ''}.`));
      }
    } else if (F.lang === 'py' && inDiff) pyImports(P, file, F, bv, out);
    else if (F.lang === 'cs' && inDiff) csUsings(P, file, F, bv, out, namespacesSeen);
  }
  return out;
}

// Top-level modules of the CPython standard library (sys.stdlib_module_names, public names, 3.8 to 3.14).
const PY_STDLIB = new Set('__future__ abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii binhex bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch formatter fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev parser pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios test textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo'.split(' '));
// Import names that differ from the name of the distribution that provides them.
const PY_ALIAS = { yaml: 'pyyaml', cv2: 'opencv-python', sklearn: 'scikit-learn', skimage: 'scikit-image', pil: 'pillow', bs4: 'beautifulsoup4', dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'pyjwt', serial: 'pyserial', attr: 'attrs', openssl: 'pyopenssl', crypto: 'pycryptodome', git: 'gitpython', magic: 'python-magic', docx: 'python-docx', pptx: 'python-pptx', fitz: 'pymupdf', mysqldb: 'mysqlclient', psycopg2: 'psycopg2-binary', zmq: 'pyzmq', usb: 'pyusb', pkg_resources: 'setuptools', jose: 'python-jose', multipart: 'python-multipart', telegram: 'python-telegram-bot', discord: 'discord-py', dns: 'dnspython', slugify: 'python-slugify', faiss: 'faiss-cpu', mpl_toolkits: 'matplotlib', wx: 'wxpython', gi: 'pygobject', markdown_it: 'markdown-it-py', typing_extensions: 'typing-extensions' };
const pyNorm = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');

/** The module a Python import names, as a path stem in the repository: { stem, relative }, or null above the root. */
function pyModule(from, source) {
  const dots = /^\.*/.exec(source)[0].length, rest = source.slice(dots).split('.').filter(Boolean);
  if (!dots) return { stem: rest.join('/'), relative: false };
  let dir = px.dirname(from); if (dir === '.') dir = '';
  for (let i = 1; i < dots; i++) { if (!dir) return null; dir = px.dirname(dir); if (dir === '.') dir = ''; }
  return { stem: [dir, ...rest].filter(Boolean).join('/'), relative: true };
}
const pyIs = (m, target) => !!m && !!m.stem && [`${m.stem}.py`, `${m.stem}/__init__.py`].some((p) => target === p || (!m.relative && target.endsWith(`/${p}`)));

function pyImports(P, file, F, bv, out) {
  const H = P.sideHead(), B = P.sideBase();
  const exists = (side, stem) => !stem || side.stems().has(stem) || side.dirs().has(stem);
  const reqs = P.manifests.pythonRequirements instanceof Set ? new Set([...P.manifests.pythonRequirements].map(pyNorm)) : new Set();
  const local = lazy(() => { const s = new Set(); for (const p of P.tree) for (const seg of p.replace(/\.pyi?$/, '').split('/')) s.add(seg); return s; });
  for (const imp of F.imports) {
    const src = imp.source; if (typeof src !== 'string' || !src) continue;
    const before = !!bv && bv.F.imports.some((x) => x.source === src);
    let at = firstAt(F, imp.line); while (isOpTok(F.tokens[at], '{') && F.tokens[at].l === imp.line) at++; // the block's own opening brace sits on its first line
    if (at < F.tokens.length && inTry(F, at)) continue; // try: import x / except ImportError: an optional import, handled
    if (src[0] === '.') {
      const m = pyModule(file, src); if (!m) continue;
      const mb = before ? pyModule(bv.path, src) : null;
      if (/[^.]/.test(src)) { // from .mod import x
        if (exists(H, m.stem) || (before && mb && !exists(B, mb.stem))) continue;
        const built = /(^|\/)(_?version|_build\w*|_?generated\w*|\w+_pb2(_grpc)?)$/.test(m.stem); // written by setuptools_scm, protoc and the like
        out.push(mk(P, 'import.missing-module', built ? 'warn' : 'bad', file, imp.line, 'Import of a module that does not exist',
          `${file} imports '${src}', but neither ${m.stem}.py nor a package ${m.stem}/ is in the tree at head.`,
          `A relative import names a path inside the repository and the complete file list of the head commit has neither the module nor a package of that name. Not established: ${built ? 'that it is missing after a build; the name is one build tools generate, which is why this is a warning' : 'modules created at build or run time'}.`));
        continue;
      }
      // from . import a, b: each name is a submodule or something the package's __init__ defines
      const init = P.head.get(m.stem ? `${m.stem}/__init__.py` : '__init__.py');
      for (const n of imp.names) {
        if (!ID.test(n.imported) || exists(H, [m.stem, n.imported].filter(Boolean).join('/'))) continue;
        if (!init || init.tokens.some((t) => (t.k === 'id' && (t.v === n.imported || t.v === '__getattr__')) || isOpTok(t, '*'))) continue;
        if (before && bv.F.imports.some((x) => x.source === src && x.names.some((y) => y.imported === n.imported))) continue;
        out.push(mk(P, 'import.missing-module', 'bad', file, imp.line, 'Import of a module that does not exist',
          `${file} imports '${n.imported}' from its package, but there is no ${[m.stem, n.imported].filter(Boolean).join('/')}.py and ${init.path} never mentions that name.`,
          'The complete file list of the head commit has no such submodule and the package initialiser, read token by token, neither defines nor imports the name. Not established: names injected at run time.'));
      }
      continue;
    }
    const top = src.split('.')[0], norm = pyNorm(top);
    if (before || !reqs.size || PY_STDLIB.has(top) || local().has(top)) continue;
    const alias = PY_ALIAS[top.toLowerCase()];
    if ([...reqs].some((r) => r === norm || r === alias || r.startsWith(`${norm}-`) || r.endsWith(`-${norm}`) || r === `py${norm}` || (alias && r.startsWith(alias)))) continue;
    out.push(mk(P, 'import.unknown-package', 'warn', file, imp.line, 'Package not in the requirements',
      `${file} imports '${top}', which is not in the standard library, not a module of this repository and not listed in requirements or pyproject.`,
      'The name was compared with the standard-library module list, every folder and module name in the tree and the declared requirements. Not established: that it is missing, because a distribution may install a module under another name; this is why it is a warning.'));
  }
}

// Namespace roots that come with the SDK or with packages too common to need a declaration in this repository.
const CS_ROOTS = new Set('System Microsoft Windows Xunit NUnit Newtonsoft FluentAssertions Moq NSubstitute Shouldly AutoFixture Bogus Castle Serilog NLog log4net AutoMapper MediatR Polly Dapper Grpc Google Amazon Azure BenchmarkDotNet Humanizer StackExchange Npgsql MySql Oracle MongoDB RabbitMQ Swashbuckle FluentValidation Autofac Ninject Quartz Hangfire CommandLine Spectre Nerdbank Xamarin Android Java Foundation UIKit CoreGraphics ObjCRuntime UnityEngine UnityEditor Unity Godot Mono Internal Cysharp'.split(' '));

function csNamespaces(P) {
  if (P.namespaces) return P.namespaces;
  const set = new Set();
  for (const F of P.head.values()) {
    if (!F || F.lang !== 'cs') continue;
    const T = F.tokens, M = F.match, stack = [];
    for (let i = 0; i < T.length; i++) {
      if (T[i].k !== 'kw' || T[i].v !== 'namespace') continue;
      let j = i + 1, name = '';
      while (T[j] && (T[j].k === 'id' || isOpTok(T[j], '.'))) name += T[j++].v;
      if (!name) continue;
      while (stack.length && stack[stack.length - 1].end < i) stack.pop();
      const full = stack.length ? `${stack[stack.length - 1].name}.${name}` : name;
      if (isOpTok(T[j], '{') && M[j] > j) stack.push({ name: full, end: M[j] });
      for (let k = full.length; k > 0; k = full.lastIndexOf('.', k - 1)) set.add(full.slice(0, k));
    }
  }
  return (P.namespaces = set);
}

function csUsings(P, file, F, bv, out, seen) {
  // A package id and the namespace it brings differ in punctuation and case (protobuf-net → ProtoBuf): compare letters and digits only.
  const flat = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const packages = P.manifests.csprojPackages instanceof Set ? [...P.manifests.csprojPackages].map((p) => [flat(String(p).split('.')[0]), flat(p)]) : [];
  const isType = (n) => (P.headNames().get(n) || []).some((s) => s.kind === 'type');
  if (!P.usedBefore) { P.usedBefore = new Set(); for (const B of P.base.values()) if (B && B.lang === 'cs') for (const im of B.imports || []) if (typeof im.source === 'string') P.usedBefore.add(im.source.replace(/^global\./, '')); }
  if (/\.(g|g\.i|generated|designer)\.cs$/i.test(file)) return; // generator output: its usings are the generator's, and it is compiled where the generator ran
  for (const imp of F.imports) {
    let ns = imp.source; if (typeof ns !== 'string' || !ns) continue;
    if (bv && bv.F.imports.some((x) => x.source === ns)) continue;
    const at = symbolAt(F, imp.line); if (at && at.kind !== 'type') continue; // a using statement inside a body, not a directive
    ns = ns.replace(/^global\./, '');
    // `using alias::Name.Space;` (extern alias): symbols.js joins the alias with a dot; the namespace is what follows it.
    const T = F.tokens; for (let i = firstAt(F, imp.line); i < T.length && T[i].l === imp.line; i++) if (isOpTok(T[i], '::') && T[i - 1] && T[i - 1].k === 'id' && ns.startsWith(`${T[i - 1].v}.`)) { ns = ns.slice(T[i - 1].v.length + 1); break; }
    const parts = ns.split('.'), spaces = csNamespaces(P), root = flat(parts[0]), all = flat(ns);
    if (CS_ROOTS.has(parts[0]) || spaces.has(ns) || P.usedBefore.has(ns)) continue; // declared here, a framework root, or already imported somewhere before this pull request
    if (root.length >= 3 && packages.some(([first, whole]) => first === root || whole.startsWith(root) || root.startsWith(whole) || (whole.length >= 5 && all.includes(whole)))) continue; // FsPickler brings MBrace.FsPickler
    // using static N.Type; and using X = N.Type; name a type: its namespace is what must exist
    let typed = isType(parts[0]);
    for (let k = parts.length - 1; k >= 1 && !typed; k--) typed = spaces.has(parts.slice(0, k).join('.')) && isType(parts[k]);
    if (typed) continue;
    const first = seen.get(ns);
    if (first) { first.n++; first.f.detail = first.f.detail.replace(/( \(and \d+ more files? of this pull request\))?\.$/, ` (and ${plural(first.n, 'more file')} of this pull request).`); continue; } // one finding per namespace
    const f = mk(P, 'import.unknown-namespace', 'warn', file, imp.line, 'Namespace not found in this repository',
      `${file} adds 'using ${ns};', but no file at head declares the namespace ${ns} or one below it, no file imported it at the merge base, and no PackageReference matches '${parts[0]}'.`,
      'Every namespace declaration in the C# files at head was read, and the package references of the project files were compared with its first segment. Not established: that it does not exist, because a package that another package depends on, a referenced assembly or generated code can declare it; this is why it is a warning.');
    seen.set(ns, { f, n: 0 });
    out.push(f);
  }
}

// ───────────────────────────────────────────────────────────── calls

// Names so common that a same-named method on a library type is the rule: counting arguments against the
// repository's declarations says nothing about a call to them.
const UBIQUITOUS = new Set(`toString ToString equals Equals hashCode GetHashCode GetType ReferenceEquals MemberwiseClone Finalize Deconstruct PrintMembers HasFlag
  constructor init main Main run Run get Get set Set add Add remove Remove push pop shift unshift map filter reduce forEach find findIndex some every includes indexOf slice splice join split
  replace trim keys values entries has delete clear Clear then catch finally next done call apply bind emit on off once send write Write read Read open Open close Close log error warn info debug
  test it describe expect require resolve reject parse Parse stringify format Format toJSON valueOf length size Count Contains contains start Start stop Stop update Update create Create
  Invoke invoke BeginInvoke EndInvoke execute Execute handle Handle render setState compare Compare CompareTo compareTo copy Copy clone Clone load Load save Save flush Flush reset Reset
  validate Validate build Build process Process append Append AppendLine insert Insert print println printf sleep exit min max abs sum len str int float list dict range type isinstance super
  setup teardown setUp tearDown configure Configure ToArray ToList Select Where Any All First FirstOrDefault Single SingleOrDefault Last OrderBy GroupBy Concat Skip Take Distinct Aggregate
  Sum Min Max TryGetValue ContainsKey GetEnumerator MoveNext AddRange Substring IndexOf StartsWith EndsWith Split Join Trim Replace GetValue SetValue GetAwaiter GetResult ConfigureAwait Wait
  ReadAsync WriteAsync FlushAsync Dispose dispose DisposeAsync CopyTo CopyToAsync Seek SetLength TryParse ToUpper ToLower Equals Reverse Sort sort reverse concat match exec item Item
  notify notifyAll wait getClass finalize hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString`.split(/\s+/).filter(Boolean)); // the last line: members every Java or JavaScript object inherits
const skipName = (n) => typeof n !== 'string' || n.length < 3 || UBIQUITOUS.has(n) || /^__\w+__$/.test(n) || !ID.test(n);

// Names a JavaScript runtime or Python itself defines: a call to one resolves whether or not the repository declares it.
const JS_GLOBALS = new Set('fetch setTimeout setInterval setImmediate clearTimeout clearInterval clearImmediate queueMicrotask requestAnimationFrame cancelAnimationFrame requestIdleCallback structuredClone atob btoa alert confirm prompt parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape eval Symbol BigInt String Number Boolean Array Object Date RegExp Error Promise Map Set WeakMap WeakSet Proxy Reflect URL URLSearchParams Blob File FormData Headers Request Response AbortController TextEncoder TextDecoder beforeEach afterEach beforeAll afterAll before after'.split(' '));
const PY_BUILTINS = new Set('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip'.split(' '));

const CHECKED = new Set(['js', 'py', 'cs', 'java']); // language families whose call and binding rules are modelled here
const ANGLE = new Set(['cs', 'java', 'ts']);
const FN_KW = new Set(['function', 'def', 'func', 'fn', 'fun']);
// Keywords after which `name(` is an expression in C# and Java; after any other keyword or an identifier it is a declaration.
const EXPR_KW = new Set(['return', 'throw', 'await', 'yield', 'in', 'is', 'as', 'not', 'and', 'or', 'when', 'else', 'case', 'out', 'ref', 'do', 'assert', 'instanceof']);
// Keywords after which `name(` declares something in JavaScript, TypeScript and Python.
const DECL_KW = new Set(['class', 'get', 'set', 'static', 'async', 'public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare']);
const BIND_KW = new Set(['const', 'let', 'var', 'function', 'class', 'def', 'as', 'for', 'global', 'nonlocal', 'catch', 'del', 'lambda']);
const STATEMENT_KW = new Set(['const', 'let', 'var', 'function', 'class', 'return', 'if', 'for', 'while', 'export', 'def']);

/** Every identifier occurrence of the wanted names at head, in one pass over all tokens: Map<name, [{ F, i }]>. */
function occurrences(P, wanted) {
  const out = new Map(); for (const n of wanted) out.set(n, []);
  if (!wanted.size) return out;
  for (const F of P.head.values()) {
    if (!F || !CHECKED.has(family(F.lang))) continue;
    const T = F.tokens;
    for (let i = 0; i < T.length; i++) { const t = T[i]; if (t.k === 'id' && wanted.has(t.v)) out.get(t.v).push({ F, i }); }
  }
  return out;
}

/** The '(' that makes token i a call or a declaration head: right after it, or after one generic argument list. -1 if none. */
function callOpen(F, i) {
  const T = F.tokens, M = F.match; let j = i + 1;
  if (isOpTok(T[j], '(')) return M[j] > j ? j : -1;
  if (!isOpTok(T[j], '<') || !ANGLE.has(F.lang)) return -1;
  let depth = 0;
  for (let n = 0; j < T.length && n < 48; j++, n++) {
    const t = T[j];
    if (t.k === 'op') { if (t.v === '<') depth++; else if (t.v === '>') { if (!--depth) break; } else if (!',.[]?():'.includes(t.v) && t.v !== '::') return -1; }
    else if (t.k !== 'id' && t.k !== 'kw') return -1;
  }
  return depth === 0 && isOpTok(T[j + 1], '(') && M[j + 1] > j + 1 ? j + 1 : -1;
}

/** Top-level arguments of the call opened at `open`; -1 when the count is not exact (a spread, or '<' and '>' that may be a generic argument list holding commas). */
function argCount(F, open) {
  const T = F.tokens, M = F.match, close = M[open];
  if (close < 0) return -1;
  if (close === open + 1) return 0;
  let n = 1, lt = false, gt = false;
  for (let i = open + 1; i < close; i++) {
    const t = T[i]; if (t.k !== 'op') continue;
    if ((t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') && M[i] > i) { i = M[i]; continue; }
    if (t.v === ',') { if (i < close - 1) n++; }
    else if (t.v === '...') return -1;
    else if ((t.v === '*' || t.v === '**') && F.lang === 'py' && (i === open + 1 || isOpTok(T[i - 1], ','))) return -1;
    else if (t.v === '<') lt = true;
    else if (t.v === '>') gt = true;
  }
  return lt && gt && n > 1 && ANGLE.has(F.lang) ? -1 : n;
}

/**
 * What an identifier occurrence is, judged from its neighbours:
 *   decl    the name of a declaration the symbol table knows
 *   hidden  a declaration the symbol table does not have (nested or local function, delegate, signature without a body)
 *   call    name(args): { open, recv (the token before the dot, or null), owner, body }
 *   new     new name(args)
 *   ref     the name used without calling it
 *   skip    a call in a place whose binding is not modelled (field initialisers, attribute arguments)
 */
function occurrenceKind(F, i, name) {
  const T = F.tokens, M = F.match, prev = T[i - 1], fam = family(F.lang), owner = ownerOf(F, i);
  if (owner && owner.name === name && i < owner.bodyA) return { kind: 'decl', owner };
  const open = callOpen(F, i), pk = prev ? prev.k : '', pv = prev ? prev.v : '';
  const body = !!owner && owner.kind !== 'type' && i >= owner.bodyA && i < owner.bodyB;
  if (open < 0) return { kind: 'ref', owner, body };
  if (pk === 'kw' && FN_KW.has(pv)) return { kind: 'hidden' };
  if (pk === 'op' && (pv === '.' || pv === '?.' || pv === '::' || pv === '->')) return { kind: 'call', open, recv: T[i - 2] || { k: 'op', v: '' }, owner, body };
  if (pk === 'kw' && pv === 'new') return { kind: 'new', open };
  const after = T[M[open] + 1];
  const declares = isOpTok(after, '{') || isOpTok(after, '=>') || (!!after && after.k === 'kw' && (after.v === 'where' || after.v === 'throws'));
  if (fam === 'cs' || fam === 'java') {
    if (declares) return { kind: 'hidden' };
    const typeLike = pk === 'id' || (pk === 'kw' && !EXPR_KW.has(pv)) || (pk === 'op' && (pv === '>' || pv === ']' || pv === '?' || pv === '*'));
    if (!body) return { kind: typeLike ? 'hidden' : 'skip' };
    if (pk === 'id' || (pk === 'kw' && !EXPR_KW.has(pv))) return { kind: 'hidden' };
    return { kind: 'call', open, recv: null, owner, body };
  }
  if (pk === 'kw' && DECL_KW.has(pv)) return { kind: 'hidden' };
  if (fam === 'js' && isOpTok(after, '{')) return { kind: 'hidden' }; // name(a) { … }: a method the symbol table did not record
  if (owner && owner.kind === 'type' && !(pk === 'op' && !';{}*?'.includes(pv))) return { kind: 'hidden' }; // a signature in a class or interface body
  return { kind: 'call', open, recv: null, owner, body };
}

const THROW_WORD = /^(throws|throwsAsync|rejects|toThrow|toThrowError|raises|assertRaises|assertRaisesRegex|assert_raises)$/;
/** Is token i inside something that expects an error: assert.throws(() => f()), expect(() => f()).toThrow(), with pytest.raises(E): f()? */
function expectsThrow(F, i) {
  const T = F.tokens, M = F.match;
  for (let hops = 0; hops < 6; hops++) {
    const g = enclosingOpen(F, i); if (g < 0) return false;
    const callee = T[g - 1], close = M[g];
    if (isOpTok(T[g], '(') && callee && callee.k === 'id') {
      if (THROW_WORD.test(callee.v)) return true;
      if (callee.v === 'expect' && close > 0) for (let k = close + 1; k < close + 8 && T[k] && (isOpTok(T[k], '.') || isWord(T[k])); k++) if (THROW_WORD.test(T[k].v)) return true;
    }
    if (isOpTok(T[g], '{') && isOpTok(callee, ':') && isOpTok(T[g - 2], ')') && M[g - 2] > 0 && T[M[g - 2] - 1] && THROW_WORD.test(T[M[g - 2] - 1].v)) return true; // with pytest.raises(E):
    i = g;
  }
  return false;
}

/** `Type name` at the level of a type body in C# or Java: a field or event of that name, which `name(` would invoke. */
function fieldLike(x) {
  if (x.o.kind !== 'ref' || (x.o.owner && x.o.owner.kind !== 'type')) return false;
  const p = x.F.tokens[x.i - 1];
  return !!p && (p.k === 'id' || (p.k === 'kw' && !EXPR_KW.has(p.v)) || (p.k === 'op' && (p.v === '>' || p.v === ']' || p.v === '?')));
}

/** The opening bracket that encloses token i, looking back at most `max` tokens. -1 at the top level. */
function enclosingOpen(F, i, max = 400) {
  const T = F.tokens, M = F.match;
  for (let j = i - 1, n = 0; j >= 0 && n < max; n++) {
    const t = T[j];
    if (t.k === 'op') {
      if ((t.v === ')' || t.v === ']' || t.v === '}') && M[j] >= 0 && M[j] < j) { j = M[j] - 1; continue; }
      if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') return j;
    }
    j--;
  }
  return -1;
}

/** Could this occurrence bind the name locally (parameter, variable, destructuring target, assignment)? Errs towards yes. 'import' for an import clause. */
function binderKind(F, i) {
  const T = F.tokens, M = F.match, prev = T[i - 1], next = T[i + 1];
  if (prev && prev.k === 'op' && (prev.v === '.' || prev.v === '?.')) return null;
  for (let j = i - 1; j >= 0 && i - j < 80; j--) { // inside an import statement?
    const u = T[j];
    if (u.k === 'kw' && (u.v === 'import' || (u.v === 'from' && F.lang === 'py'))) return 'import';
    // A statement ends at ';', and without semicolons at the specifier string or the next statement keyword.
    if (u.k === 'str' || (u.k === 'op' && (u.v === ';' || u.v === '}' || u.v === ')')) || (u.k === 'kw' && STATEMENT_KW.has(u.v))) break;
  }
  if (prev && prev.k === 'kw' && BIND_KW.has(prev.v)) return 'local';
  if (next && next.k === 'op' && (next.v === '=>' || next.v === '=' || next.v === ':=')) return 'local';
  if (next && next.k === 'kw' && (next.v === 'in' || next.v === 'of')) return 'local';
  for (let j = i, hops = 0; hops < 4; hops++) { // a parameter list or a destructuring pattern around it
    const g = enclosingOpen(F, j); if (g < 0) return null;
    const after = T[M[g] + 1], before = T[g - 1];
    if (T[g].v === '(') {
      if (before && before.k === 'kw' && ['if', 'while', 'switch', 'for', 'with', 'elif', 'return', 'await', 'typeof'].includes(before.v)) return null;
      if (isOpTok(after, '=>') || isOpTok(after, '{') || (before && before.k === 'kw' && (before.v === 'function' || before.v === 'catch'))) return 'local';
      if (T[g - 2] && T[g - 2].k === 'kw' && FN_KW.has(T[g - 2].v)) return 'local';
      if (isOpTok(next, ':') || isOpTok(next, '?')) return 'local'; // a typed parameter
      return null;
    }
    if (T[g].v === '${') return null;
    if ((before && before.k === 'kw' && ['const', 'let', 'var'].includes(before.v)) || isOpTok(after, '=')) return 'local';
    j = g;
  }
  return null;
}

/** Names in the base list of a type declaration (generic arguments and namespaces dropped). */
function basesOf(F, s) {
  const T = F.tokens, M = F.match, out = []; let angle = 0, seen = false;
  for (let i = s.a; i < s.bodyA; i++) {
    const t = T[i];
    if (t.k === 'op') {
      if (t.v === '(' && F.lang === 'py' && M[i] > i) { for (let j = i + 1; j < M[i]; j++) { if (T[j].k === 'id' && !isOpTok(T[j + 1], '=') && !isOpTok(T[j + 1], '.') && !isOpTok(T[j - 1], '=')) out.push(T[j].v); if ((isOpTok(T[j], '(') || isOpTok(T[j], '[')) && M[j] > j) j = M[j]; } i = M[i]; continue; }
      if ((t.v === '(' || t.v === '[') && M[i] > i) { i = M[i]; continue; }
      if (t.v === '<') angle++; else if (t.v === '>') angle = Math.max(0, angle - 1); else if (t.v === ':' && !angle && F.lang !== 'py') seen = true;
      continue;
    }
    if (t.k === 'kw' && (t.v === 'extends' || t.v === 'implements')) { seen = true; continue; }
    if (t.k === 'kw' && t.v === 'where') break;
    if (seen && !angle && t.k === 'id' && !isOpTok(T[i + 1], '.')) out.push(t.v);
  }
  return out;
}

/** class, struct, interface, record or enum: the keyword a type was declared with. */
function typeKeyword(F, s) {
  for (let i = s.a; i < s.bodyA; i++) { const t = F.tokens[i]; if (t.k === 'kw' && (t.v === 'class' || t.v === 'struct' || t.v === 'interface' || t.v === 'enum')) return t.v; }
  return 'class';
}

/**
 * Can a member reach this type only from declarations in the repository? True when every type it inherits members
 * from is declared here, all the way up. In C# an interface gives its implementers no member that an unqualified
 * call could find, and only the first entry of a class's base list can be a class, so there the question is only
 * about that first entry: it must be declared in the repository, or be an interface (declared as one here, or named
 * I + capital + lower-case letter, the .NET naming rule CA1715, when it is declared elsewhere). Everywhere else
 * (Java default methods, Python and JavaScript mixins) every base counts.
 */
function closedHierarchy(P, name) {
  if (P.closed.has(name)) return P.closed.get(name);
  P.closed.set(name, true); // a cycle closes on itself
  const types = (P.headNames().get(name) || []).filter((s) => s.kind === 'type');
  const declared = (n) => (P.headNames().get(n) || []).filter((s) => s.kind === 'type');
  const ok = types.length > 0 && types.every((s) => {
    const F = P.head.get(s.file), bases = basesOf(F, s).filter((b) => b !== 'object' && b !== 'Object');
    if (F.lang !== 'cs') return bases.every((b) => closedHierarchy(P, b));
    const kw = typeKeyword(F, s);
    if (kw === 'struct' || kw === 'enum' || !bases.length) return true;
    if (kw === 'interface') return bases.every((b) => closedHierarchy(P, b));
    const first = declared(bases[0]);
    if (!first.length) return /^I[A-Z][a-z]/.test(bases[0]);
    return first.every((b) => typeKeyword(P.head.get(b.file), b) === 'interface') || closedHierarchy(P, bases[0]);
  });
  P.closed.set(name, ok);
  return ok;
}

/** Is every entry of every base list, all the way up, a type declared in the repository (interfaces included)? */
function onlyRepositoryBases(P, name, seen = new Set()) {
  if (seen.has(name)) return true;
  seen.add(name);
  const types = (P.headNames().get(name) || []).filter((s) => s.kind === 'type');
  return types.length > 0 && types.every((s) => basesOf(P.head.get(s.file), s).every((b) => b === 'object' || onlyRepositoryBases(P, b, seen)));
}

const STATIC_IMPORT = new WeakMap();
/** `using static` or `import static` in a file: unqualified names may come from another type. */
function hasStaticImport(F) {
  if (STATIC_IMPORT.has(F)) return STATIC_IMPORT.get(F);
  const T = F.tokens; let r = false;
  for (let i = 0; i + 1 < T.length && !r; i++) r = T[i].k === 'kw' && (T[i].v === 'using' || T[i].v === 'import') && T[i + 1].k === 'kw' && T[i + 1].v === 'static';
  STATIC_IMPORT.set(F, r);
  return r;
}

/** Decorators written above a Python declaration (symbols.js starts the declaration at `def`): [{ name, line }]. */
function pyDecorators(F, s) {
  const T = F.tokens, M = F.match, out = [];
  let i = s.a - 1;
  while (i > 0 && isOpTok(T[i], ';')) {
    let k = i - 1;
    while (k >= 0) { const u = T[k]; if (u.k === 'op') { if ((u.v === ')' || u.v === ']') && M[k] >= 0 && M[k] < k) { k = M[k] - 1; continue; } if (u.v === ';' || u.v === '{' || u.v === '}') break; } k--; }
    const st = k + 1; if (!isOpTok(T[st], '@')) break;
    let name = ''; for (let q = st + 1; q < i && (isWord(T[q]) || isOpTok(T[q], '.')); q++) name += T[q].v;
    out.push({ name, line: T[st].l });
    i = st - 1;
  }
  return out;
}
// Decorators that leave the call signature as written.
const PLAIN_DECORATOR = new Set(['staticmethod', 'classmethod', 'abstractmethod', 'abc.abstractmethod', 'override', 'typing.override', 'final', 'typing.final', 'lru_cache', 'functools.lru_cache', 'cache', 'functools.cache']);

/**
 * The parameters of a JavaScript function as written, in order: [{ name, optional, rest }] (name is null for a
 * destructuring pattern), or null when the parameter list is not the parenthesised group right before the body.
 * symbols.js gives the number of parameters without a default, not where they stand: in
 * `function say(html, who = 'ai', src)` the second one is optional and the third is not.
 */
function jsParamList(F, s) {
  const T = F.tokens, M = F.match;
  let close = -1;
  if (isOpTok(T[s.bodyA], '{') && isOpTok(T[s.bodyA - 1], ')')) close = s.bodyA - 1; // function f(a, b) {   |   name(a, b) {
  else if (isOpTok(T[s.bodyA - 1], '=>')) { // (a, b) => …   |   a => …
    if (isOpTok(T[s.bodyA - 2], ')')) close = s.bodyA - 2;
    else if (T[s.bodyA - 2] && T[s.bodyA - 2].k === 'id') return [{ name: T[s.bodyA - 2].v, optional: false, rest: false }];
  }
  const open = close > 0 ? M[close] : -1;
  if (open < s.a || open >= close) return null;
  const out = [];
  const seg = (a, b) => {
    if (a >= b) return; // a trailing comma
    const rest = isOpTok(T[a], '...'), at = rest ? a + 1 : a;
    let optional = false;
    for (let k = a; k < b; k++) { if ((isOpTok(T[k], '(') || isOpTok(T[k], '[') || isOpTok(T[k], '{')) && M[k] > k) k = M[k]; else if (isOpTok(T[k], '=')) optional = true; }
    if (isOpTok(T[at + 1], '?')) optional = true; // Flow: `name?: Type`
    out.push({ name: T[at] && T[at].k === 'id' ? T[at].v : null, optional, rest });
  };
  let start = open + 1;
  for (let i = open + 1; i < close; i++) { if ((isOpTok(T[i], '(') || isOpTok(T[i], '[') || isOpTok(T[i], '{') || isOpTok(T[i], '${')) && M[i] > i) i = M[i]; else if (isOpTok(T[i], ',')) { seg(start, i); start = i + 1; } }
  seg(start, close);
  return out;
}

/**
 * The smallest number of arguments a plain JavaScript function can be called with before its body goes wrong, read
 * from the body. The language lets every trailing argument be left out and code relies on it, so a parameter
 * counts as required only when
 *   - it has no default and is not a rest parameter, and
 *   - the body needs its value: reads a property of it, indexes it, calls it, spreads it into an array or a call,
 *     iterates it, destructures it, interpolates it, or uses it in arithmetic, and
 *   - the body never gives it a way out: no test for absence (!p, typeof p, p ||, p ??, p == …, p ? …, p?., p &&,
 *     if (p), switch (p), p instanceof), no assignment to it, no handing it to another call before the first such
 *     use (that callee may be the guard), and no other binding of the same name inside the body (a callback
 *     parameter that shadows it).
 * The result is the position of the last such parameter. It is a reading of the text, not data flow: a guard on
 * another parameter (an early return) is not seen, so a call may be reported that the code survives.
 */
function jsNeededArity(F, s, ps) {
  const T = F.tokens, at = new Map();
  ps.forEach((p, k) => { if (p.name && !p.optional && !p.rest) at.set(p.name, k); });
  const needed = ps.map((p) => !p.optional && !p.rest && !p.name), tested = ps.map(() => false); // a destructured parameter needs a value
  const ARITH = new Set(['+', '-', '*', '/', '%', '**']), EQ = new Set(['===', '==', '!==', '!=']);
  const WAY_OUT = new Set(['||', '??', '?', '?.', '&&', '||=', '??=', '&&=', '=', ...EQ]);
  for (let i = s.bodyA; i < s.bodyB && at.size; i++) {
    const k = T[i].k === 'id' ? at.get(T[i].v) : undefined;
    if (k === undefined || tested[k]) continue;
    const p = T[i - 1], n = T[i + 1], pv = p && p.k === 'op' ? p.v : '', nv = n && n.k === 'op' ? n.v : '', pk = p && p.k === 'kw' ? p.v : '';
    if (pv === '.' || pv === '?.') continue; // a property of that name
    if (nv === ':' && (pv === '{' || pv === ',')) continue; // an object key
    if (pv === '!' || pk === 'typeof' || WAY_OUT.has(nv) || EQ.has(pv) || (n && n.k === 'kw' && n.v === 'instanceof')
      || (pv === '(' && nv === ')' && T[i - 2] && T[i - 2].k === 'kw' && ['if', 'while', 'switch'].includes(T[i - 2].v))
      || binderKind(F, i) === 'local') { tested[k] = true; continue; }
    if ((pv === '(' || pv === ',') && (nv === ')' || nv === ',')) { if (!needed[k]) tested[k] = true; continue; } // handed on as it is
    const spreadIntoObject = pv === '...' && isOpTok(T[enclosingOpen(F, i)], '{'); // { ...undefined } is {}
    const destructured = pv === '=' && (isOpTok(T[i - 2], '}') || isOpTok(T[i - 2], ']'));
    const forIn = pk === 'in' && (() => { const g = enclosingOpen(F, i); return g > 0 && T[g - 1].k === 'kw' && T[g - 1].v === 'for'; })(); // for (k in undefined) runs zero times; `k in undefined` throws
    if (nv === '.' || nv === '[' || nv === '(' || (pv === '...' && !spreadIntoObject) || pv === '${' || ARITH.has(nv) || ARITH.has(pv) || pk === 'of' || (pk === 'in' && !forIn) || destructured) needed[k] = true;
  }
  for (let k = ps.length - 1; k >= 0; k--) if (needed[k] && !tested[k]) return k + 1;
  return 0;
}

/**
 * How many arguments a declared function or method accepts: { lo, hi }, or null when that cannot be read exactly
 * (then nothing is said about calls to that name). Corrects what symbols.js counts differently: a single arrow
 * parameter without parentheses, TypeScript's `this` parameter, Python's '/' and '*' markers, a C# extension
 * method's receiver, JavaScript functions that read `arguments`, JavaScript accessors (get/set), and JavaScript
 * parameters the body does not need (see jsNeededArity).
 */
function arityOf(F, s) {
  if (!F || (s.kind !== 'function' && s.kind !== 'method')) return null;
  let lo = s.minParams, hi = s.maxParams;
  if (!Number.isInteger(lo) || !(hi >= lo)) return null;
  const T = F.tokens, M = F.match, fam = family(F.lang), op = (i, v) => isOpTok(T[i], v);
  if (fam === 'js') {
    const arrow = s.bodyA - 1;
    if (op(arrow, '=>')) {
      const p = arrow - 1;
      if (T[p] && T[p].k === 'id' && (op(p - 1, '=') || op(p - 1, ':') || (T[p - 1] && T[p - 1].v === 'async'))) lo = hi = 1;
      else { // the parameters must be the one parenthesised group right after the '=' (or the ':' of a property)
        let anchor = -1, colon = -1; const groups = [];
        for (let i = s.a; i < arrow; i++) {
          const u = T[i]; if (u.k !== 'op') continue;
          if ((u.v === '(' || u.v === '[' || u.v === '{') && M[i] > i) { if (u.v === '(') groups.push(i); i = M[i]; continue; }
          if (u.v === '=') { anchor = i; groups.length = 0; } else if (u.v === ':' && colon < 0 && anchor < 0) { colon = i; groups.length = 0; }
        }
        if (anchor < 0) anchor = colon;
        const start = anchor + 1 + (T[anchor + 1] && T[anchor + 1].v === 'async' ? 1 : 0);
        if (anchor < 0 || groups.length !== 1 || groups[0] !== start) return null;
      }
    }
    // `get name() { return fn; }`: `x.name(1)` calls what the accessor returns, not the accessor.
    for (let i = s.a; i < s.bodyA; i++) if (T[i].k === 'id' && T[i].v === s.name && op(i + 1, '(')) { if (T[i - 1] && (T[i - 1].v === 'get' || T[i - 1].v === 'set') && T[i - 1].k !== 'op') return null; break; }
    if (F.lang === 'ts' && s.paramNames && s.paramNames[0] === 'this') { lo = Math.max(0, lo - 1); hi -= 1; }
    let variadic = false;
    for (let i = s.bodyA; i < s.bodyB; i++) if (T[i].k === 'id' && T[i].v === 'arguments') { lo = 0; hi = Infinity; variadic = true; break; }
    // Plain JavaScript: the minimum is what the body needs (TypeScript keeps the declared minimum: there a missing
    // argument is a compile error).
    if (F.lang === 'js' && !variadic && lo > 0) { const ps = jsParamList(F, s); lo = ps ? Math.min(jsNeededArity(F, s, ps), hi) : 0; }
  } else if (fam === 'py') {
    let open = -1; for (let i = s.a; i < Math.min(s.b, s.a + 6); i++) if (T[i].k === 'kw' && T[i].v === 'def' && op(i + 2, '(')) { open = i + 2; break; }
    if (open < 0 || M[open] < 0) return null;
    if (pyDecorators(F, s).some((d) => !PLAIN_DECORATOR.has(d.name))) return null; // a decorator may replace the function by anything
    lo = hi = 0;
    let start = open + 1, first = true;
    const seg = (a, b) => {
      if (a >= b) return;
      const one = b - a === 1, t = T[a];
      if (one && isOpTok(t, '/')) return; // PEP 570 marker
      if (isOpTok(t, '*')) { if (!one) hi = Infinity; return; } // bare '*' is the PEP 3102 marker; *args takes the rest
      if (isOpTok(t, '**')) { hi = Infinity; return; }
      const self = first && s.container && (t.v === 'self' || t.v === 'cls'); first = false;
      if (self) return;
      hi++; let dflt = false; for (let k = a; k < b; k++) { if ((op(k, '(') || op(k, '[') || op(k, '{')) && M[k] > k) k = M[k]; else if (op(k, '=')) dflt = true; }
      if (!dflt) lo++;
    };
    for (let i = open + 1; i < M[open]; i++) { if ((op(i, '(') || op(i, '[') || op(i, '{')) && M[i] > i) i = M[i]; else if (op(i, ',')) { seg(start, i); start = i + 1; } }
    seg(start, M[open]);
  } else if (fam === 'cs' && isExtension(F, s)) lo = Math.max(0, lo - 1); // the receiver is the first parameter, written or not
  return { lo, hi };
}

const EXTENSION = new WeakMap();
/** A C# extension method: its first parameter is `this T x`. */
function isExtension(F, s) {
  let v = EXTENSION.get(s);
  if (v === undefined) {
    const T = F.tokens; v = false;
    if (F.lang === 'cs') for (let i = s.a; i < s.bodyA; i++) if (T[i].k === 'id' && T[i].v === s.name) { const o = callOpen(F, i); if (o > 0) { v = !!T[o + 1] && T[o + 1].k === 'kw' && T[o + 1].v === 'this'; break; } }
    EXTENSION.set(s, v);
  }
  return v;
}

/**
 * Could this call reach that declaration at all? Exact language rules, read from the declaration's own modifiers:
 *   C#, Java  a private member is reachable only from inside its type (or a type nested in it);
 *   C#        a static method that is not an extension method is reachable through a receiver only when the
 *             receiver is the name of its type (an instance cannot be used to call it);
 *   JS, TS    a top-level function its module does not export is reachable only from its own file.
 * `F` is the file of the declaration, `here` the path of the calling file on the same side (head or merge base).
 */
function reachable(x, s, F, here) {
  const fam = family(F.lang), o = x.o, mods = s.modifiers || [];
  const inType = o.owner ? (o.owner.kind === 'type' ? o.owner.qname : o.owner.container) : null;
  if ((fam === 'cs' || fam === 'java') && s.container) {
    if (mods.includes('private') && !mods.includes('protected') && !(inType && (inType === s.container || inType.startsWith(`${s.container}.`)))) return false;
    if (fam === 'cs' && mods.includes('static') && o.recv && !(o.recv.k === 'id' && o.recv.v === s.container.split('.').pop()) && !isOpTok(o.recv, '>') && !isExtension(F, s)) return false;
  }
  if (fam === 'js' && !s.container && !o.recv && here !== s.file) { const ex = jsExports(F); if (!ex.open && !ex.names.has(s.name)) return false; }
  return true;
}
const showRange = (r) => (r.hi === Infinity ? `${r.lo}+` : r.lo === r.hi ? `${r.lo}` : `${r.lo}-${r.hi}`);

/** Does `import … from source` in `from` reach one of the target files under the wanted name, directly or through re-exports? */
function jsReaches(side, from, source, want, name, targets, depth = 0) {
  const r = resolveJs(side, from, source);
  if (typeof r !== 'string') return null;
  if (targets.has(r)) return want === name ? r : null;
  const X = side.files.get(r);
  if (!X || !isJsLike(X.lang) || depth >= 3) return null;
  for (const imp of X.imports || []) {
    if (!imp.reexport || typeof imp.source !== 'string') continue;
    const via = imp.ns === '*' ? want : ((imp.names || []).find((n) => n.local === want) || {}).imported;
    const hit = via ? jsReaches(side, r, imp.source, via, name, targets, depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * Which declarations a call binds to, read from the text alone.
 *   { syms, how }  the call binds to these declarations (a subset of `decls`)
 *   'foreign'      the name is bound to something else in this file (another import, a parameter, a variable)
 *   null           not decided: only the name matches
 * `decls` are the declarations of the name on `side` (head for arity, merge base for a removed function); `here`
 * is the path of F on that side. A call is bound when
 *   JS/TS/Python  it is unqualified and the file declares the name at its top level or imports it from the module
 *                 that declares it (re-exports followed), with no local binding of the name around the call; or it
 *                 goes through a namespace import of that module; or through this/self inside the declaring class;
 *   C#/Java       it is unqualified (or base./super./this.) inside a type whose whole inheritance chain is declared
 *                 in the repository, in a file without static imports, with no variable of that name in the member:
 *                 then the name can only resolve to a repository declaration, all of which are in `decls`.
 *                 Not bound: `this.Name(…)` in C# when the type or a base implements an interface the repository
 *                 does not declare (`this.` also finds extension methods, and libraries extend their own interfaces:
 *                 LINQ on IEnumerable<T>) or when the pull request added a using directive to the file or a global
 *                 using anywhere (extension methods come into scope through usings); a call inside a C# partial type that has a single part in the repository
 *                 (the other part is then written by a source generator at build time); a call inside a Java
 *                 anonymous class (it sees the members of the type it extends first).
 *                 What remains unexcluded for a bound C# call, and is said in the finding: an extension method on
 *                 object or on a type parameter (`this.` calls only), and a part added by a source generator.
 * In JavaScript and Python a call on this/self is not bound when the class is decorated, handed to a function or has
 * its prototype touched in the file (a mixin may supply or replace the method), or when the name is assigned anywhere.
 */
function bindCall(P, side, here, F, x, name, decls, sites, needClosed) {
  const T = F.tokens, fam = family(F.lang), o = x.o;
  const member = o.owner && o.owner.kind !== 'type' ? o.owner : null;
  if (fam === 'cs' || fam === 'java') {
    const rk = o.recv && o.recv.k === 'kw' ? o.recv.v : null;
    if (o.recv && rk !== 'this' && rk !== 'base' && rk !== 'super') return null;
    if (!member || !member.container || hasStaticImport(F) || (fam === 'cs' && P.globalStatic()) || P.unread(fam)) return null;
    const chain = member.container.split('.');
    if (!chain.every((c) => closedHierarchy(P, c))) return null;
    if (fam === 'cs' && rk === 'this') { // `this.` also finds extension methods: they come into scope through a using directive
      if (!onlyRepositoryBases(P, chain[chain.length - 1])) return null;
      const bv = P.baseOf(F.path), had = new Set(bv ? (bv.F.imports || []).map((im) => im.source) : []);
      if (!bv || (F.imports || []).some((im) => !had.has(im.source)) || P.globalUsingAdded()) return null; // a using this pull request added may bring one
    }
    if (fam === 'cs' && chain.some((c) => { const parts = (P.headNames().get(c) || []).filter((t) => t.kind === 'type' && (t.modifiers || []).includes('partial')); return parts.length === 1; })) return null;
    if (fam === 'java' && inAnonymousClass(F, x.i, member)) return null;
    for (const y of sites) if (y.F === F && y.o.kind === 'ref' && y.i >= member.a && y.i < member.b && !isOpTok(T[y.i - 1], '.')) return 'foreign'; // a local, a parameter or a method group of that name
    // What the text cannot exclude for this binding, said in the finding.
    const partial = fam === 'cs' && chain.some((c) => (P.headNames().get(c) || []).some((t) => t.kind === 'type' && (t.modifiers || []).includes('partial')));
    const residual = [fam === 'cs' && rk === 'this' ? 'an extension method that a library already in scope declares on object or on a type parameter' : '', partial ? 'another part of this partial type written by a source generator' : ''].filter(Boolean).join(', or ');
    return { syms: decls, how: `${rk ? `a call on ${rk}` : 'an unqualified call'} inside ${member.container}, which inherits members only from types declared in this repository`, residual };
  }
  if (o.recv) {
    const rv = o.recv.v;
    if (rv === 'this' || rv === 'self' || rv === 'cls') {
      if (!member || !member.container) return null;
      const syms = decls.filter((s) => s.file === here && s.container === member.container);
      if (!syms.length) return null;
      const cn = member.container.split('.').pop();
      if (needClosed && !closedHierarchy(P, cn)) return null;
      const cls = F.symbols.find((s) => s.kind === 'type' && s.qname === member.container);
      for (const y of sites) if (y.F === F && y.o.kind === 'ref' && isOpTok(T[y.i + 1], '=')) return 'foreign'; // this.name = …, K.prototype.name = …: the member is assigned
      if (cls && (((cls.attrs || []).length) || (fam === 'py' && pyDecorators(F, cls).length))) return null; // a decorator may add or replace members
      for (let i = 0; i < T.length; i++) { // K.prototype, Object.assign(K, …), mixin(K): members may come from elsewhere
        if (T[i].k !== 'id' || T[i].v !== cn) continue;
        const pv = T[i - 1] && T[i - 1].k === 'op' ? T[i - 1].v : '', nv = T[i + 1] && T[i + 1].k === 'op' ? T[i + 1].v : '';
        if ((nv === '.' && T[i + 2] && (T[i + 2].v === 'prototype' || T[i + 2].v === '__dict__')) || ((pv === '(' || pv === ',') && (nv === ')' || nv === ','))) return null;
      }
      return { syms, how: `a call on ${rv} inside ${member.container}, which declares it` };
    }
    if (o.recv.k !== 'id' || isOpTok(T[x.i - 3], '.')) return null;
    const top = decls.filter((s) => !s.container), targets = new Set(top.map((s) => s.file));
    for (const imp of F.imports || []) {
      if (typeof imp.source !== 'string') continue;
      let hit = null;
      if (fam === 'js' && imp.ns === rv) hit = jsReaches(side, here, imp.source, name, name, targets);
      else if (fam === 'py') {
        const mods = []; if (imp.ns === rv && (imp.source === rv || !imp.source.includes('.') || imp.source.split('.')[0] !== rv)) mods.push(imp.source);
        for (const n of imp.names || []) if (n.local === rv) mods.push(`${imp.source}${imp.source.endsWith('.') ? '' : '.'}${n.imported}`);
        for (const m of mods) { const pm = pyModule(here, m); hit = hit || (pyUnique(side, pm) && [...targets].find((t) => pyIs(pm, t))) || null; }
      }
      if (hit) return { syms: top.filter((s) => s.file === hit), how: `a call through ${rv}, which this file imports from ${hit}` };
    }
    return null;
  }
  // Unqualified. Is the name bound to something local around the call?
  const scope = (() => { let best = null; for (const s of F.symbols) if (s.kind !== 'type' && s.a <= x.i && x.i < s.b && (!best || s.b - s.a > best.b - best.a)) best = s; return best; })();
  for (const y of sites) {
    if (y.F !== F || y.o.kind !== 'ref') continue;
    const inScope = scope && y.i >= scope.a && y.i < scope.b, fileLevel = !y.o.owner || y.o.owner.kind === 'type';
    if ((inScope || fileLevel) && binderKind(F, y.i) === 'local') return 'foreign';
  }
  const top = decls.filter((s) => !s.container), targets = new Set(top.map((s) => s.file));
  let importsIt = false;
  for (const imp of F.imports || []) {
    if (typeof imp.source !== 'string') continue;
    const n = (imp.names || []).find((y) => y.local === name);
    if (!n && imp.default !== name && imp.ns !== name) continue;
    importsIt = true;
    if (!n) continue;
    const pm = fam === 'py' ? pyModule(here, imp.source) : null;
    const hit = fam === 'js' ? jsReaches(side, here, imp.source, n.imported, name, targets) : (n.imported === name && pyUnique(side, pm) && [...targets].find((t) => pyIs(pm, t))) || null;
    if (hit) return { syms: top.filter((s) => s.file === hit), how: `this file imports ${name} from ${hit}`, source: imp.source };
  }
  if (importsIt) return 'foreign'; // the name is imported from somewhere else
  for (const imp of fam === 'py' ? F.imports || [] : []) { // from x import *: the name may come from there, and from the declaring module it does
    if (typeof imp.source !== 'string' || !(imp.names || []).some((n) => n.imported === '*')) continue;
    const pm = pyModule(here, imp.source);
    return [...targets].some((t) => pyIs(pm, t)) ? { tie: `this file star-imports the module that declares ${name}` } : null;
  }
  const own = top.filter((s) => s.file === here);
  if (own.length) return { syms: own, how: `${name} is declared at the top level of the same file` };
  return null;
}

/**
 * Does an absolute Python import name exactly one module of the tree? `from utils import f` reaches a/utils.py only
 * if no other utils.py (or utils package) exists: which one Python loads depends on sys.path, which is not in the text.
 */
function pyUnique(side, pm) {
  if (!pm || !pm.stem) return false;
  if (pm.relative) return true;
  if (!side.pyCount) side.pyCount = new Map();
  let n = side.pyCount.get(pm.stem);
  if (n === undefined) { n = 0; for (const p of side.tree) if (pyIs(pm, p)) n++; side.pyCount.set(pm.stem, n); }
  return n === 1;
}

/** Is token i inside the body of a Java anonymous class (`new Type(…) { … }`) within this member? */
function inAnonymousClass(F, i, member) {
  const T = F.tokens, M = F.match;
  for (let g = enclosingOpen(F, i), hops = 0; g > member.bodyA && hops < 12; g = enclosingOpen(F, g), hops++) {
    if (!isOpTok(T[g], '{') || !isOpTok(T[g - 1], ')') || M[g - 1] < 0) continue;
    let j = M[g - 1] - 1;
    if (isOpTok(T[j], '>')) { let depth = 0; for (; j >= 0; j--) { if (isOpTok(T[j], '>')) depth++; else if (isOpTok(T[j], '<') && !--depth) break; } j--; }
    while (j >= 0 && (T[j].k === 'id' || isOpTok(T[j], '.'))) j--;
    if (j >= 0 && T[j].k === 'kw' && T[j].v === 'new') return true;
  }
  return false;
}

/** The type a C# extension method extends: the last type name before its first parameter's name. */
function extendedType(F, s) {
  const T = F.tokens, M = F.match;
  for (let i = s.a; i < s.bodyA; i++) {
    if (T[i].k !== 'id' || T[i].v !== s.name) continue;
    const o = callOpen(F, i); if (o < 0) continue;
    const ids = []; let angle = 0;
    for (let k = o + 1; k < M[o] && !(isOpTok(T[k], ',') && !angle); k++) { if (isOpTok(T[k], '<')) angle++; else if (isOpTok(T[k], '>')) angle--; else if (T[k].k === 'id' && !angle) ids.push(T[k].v); }
    return ids.length >= 2 ? ids[ids.length - 2] : null;
  }
  return null;
}

/** A type name and every type declared in the repository that inherits from it (three levels down), by simple name. */
function withSubtypes(P, name) {
  if (!P.derived) { // base name → names of the types whose base list has it
    P.derived = new Map();
    for (const F of P.head.values()) for (const t of (F && F.symbols) || []) if (t.kind === 'type') for (const b of basesOf(F, t)) (P.derived.get(b) || P.derived.set(b, new Set()).get(b)).add(t.name);
  }
  if (!P.subtypes) P.subtypes = new Map();
  let out = P.subtypes.get(name);
  if (out) return out;
  out = new Set([name]); let layer = [name];
  for (let depth = 0; depth < 3 && layer.length; depth++) { const next = []; for (const b of layer) for (const d of P.derived.get(b) || []) if (!out.has(d)) { out.add(d); next.push(d); } layer = next; }
  P.subtypes.set(name, out);
  return out;
}

/**
 * The type names the text gives an identifier where it is declared: `Type name` (C#, Java: parameters, locals,
 * fields, properties), `name: Type` (TypeScript, Python), `name = new Type(…)`, `name = Type(…)`. A qualified type
 * (`Outer.Nested name`, `new Outer.Nested(…)`) gives its last segment. Looked up in the member around the call and
 * at the level of a type body in the same file; nothing is inferred.
 */
const DECLARED = new WeakMap();
function declaredTypes(F, name, member) {
  let memo = DECLARED.get(F); if (!memo) DECLARED.set(F, (memo = new Map()));
  const key = `${member ? member.a : -1}\u0001${name}`;
  if (memo.has(key)) return memo.get(key);
  const T = F.tokens, out = new Set();
  memo.set(key, out);
  const look = (i) => {
    const p = T[i - 1], n = T[i + 1];
    if (p && p.k === 'id') out.add(p.v); // `Type name`, and `Outer.Nested name`: the last segment is the type
    else if (isOpTok(p, '?') && T[i - 2] && T[i - 2].k === 'id') out.add(T[i - 2].v);
    else if (isOpTok(p, '>') || (isOpTok(p, '?') && isOpTok(T[i - 2], '>'))) { // Generic<…> name
      let k = isOpTok(p, '>') ? i - 1 : i - 2, depth = 0;
      for (let steps = 0; k >= 0 && steps < 60; k--, steps++) { if (isOpTok(T[k], '>')) depth++; else if (isOpTok(T[k], '<') && !--depth) break; }
      if (k > 0 && T[k - 1].k === 'id') out.add(T[k - 1].v);
    }
    if (isOpTok(n, ':') && T[i + 2] && T[i + 2].k === 'id') out.add(T[i + 2].v);
    if (isOpTok(n, '=')) {
      const a = T[i + 2], b = T[i + 3];
      if (a && a.k === 'kw' && a.v === 'new' && b && b.k === 'id') { let k = i + 3; while (isOpTok(T[k + 1], '.') && T[k + 2] && T[k + 2].k === 'id') k += 2; out.add(T[k].v); } // new Outer.Nested(…) constructs a Nested
      else if (a && a.k === 'id' && isOpTok(b, '(')) out.add(a.v);
    }
  };
  if (member) for (let i = member.a; i < member.b; i++) if (T[i].k === 'id' && T[i].v === name) look(i);
  for (let i = 0; i < T.length; i++) { // fields and properties: declared outside every member body
    if (T[i].k !== 'id' || T[i].v !== name || (member && i >= member.a && i < member.b)) continue;
    const owner = ownerOf(F, i);
    if (!owner || owner.kind === 'type' || (owner.name === name && i < owner.bodyA)) look(i);
  }
  return out;
}

/**
 * Evidence, in the calling file, that a call whose binding is not decided is at least about a given declaration.
 * There is no type checker here, so `x.name(…)` is tied to a declaration of `name` only when the text says what x is:
 *   - the call is unqualified (or on this/self/base) inside the declaring type or a subtype of it;
 *   - the receiver is the name of the declaring type or object (`Codec.name(…)`, `api.name(…)`);
 *   - the receiver is declared with the declaring type or a subtype (see declaredTypes);
 *     in JavaScript and Python both need the calling file to bind that name to the repository (see boundInRepo);
 *   - for a C# extension method: the receiver is declared with the extended type, and that type is declared in the
 *     repository (a library may give its own types a method of any name, which is why polyfills exist).
 * For a removed declaration (`gone`) two more things must hold, or the name may simply belong to someone else now:
 * its declaring type is still there at head (in the same file, or as another part of a partial type), and that
 * type inherits members only from the repository (closedHierarchy), so that no library base class can supply the
 * method. Without such evidence nothing is reported: a same-named method elsewhere is the norm.
 * tieIndex prepares the declarations of one name (type name → declarations it can stand for); tiedDecls answers
 * for one call.
 */
function tieIndex(P, decls, fileOf, gone) {
  const index = new Map(), typesNamed = (n) => (P.headNames().get(n) || []).filter((t) => t.kind === 'type');
  if (gone && !P.headPath) { P.headPath = new Map(); for (const d of P.diff) if (d.status !== 'added') P.headPath.set(d.oldPath, d.status === 'deleted' ? null : d.path); }
  const survives = (s, F) => { // the declaring type or object of a removed member, at head
    const hp = P.headPath.has(s.file) ? P.headPath.get(s.file) : s.file, H = hp ? P.head.get(hp) : null;
    if (H && H.symbols.some((t) => t.qname === s.container || t.container === s.container)) return true;
    const was = F.symbols.find((t) => t.kind === 'type' && t.qname === s.container);
    return !!was && was.modifiers.includes('partial') && typesNamed(was.name).some((t) => t.modifiers.includes('partial'));
  };
  for (const s of decls) {
    if (!s.container) continue;
    const F = fileOf(s), ext = isExtension(F, s);
    const typeName = ext ? extendedType(F, s) : s.container.split('.').pop();
    if (!typeName || (ext && !typesNamed(typeName).length)) continue;
    if (gone && ((!ext && !survives(s, F)) || !closedContainer(P, typeName))) continue;
    for (const t of withSubtypes(P, typeName)) (index.get(t) || index.set(t, []).get(t)).push(s);
  }
  return index;
}
/** closedHierarchy for a container that may be an object literal: an object has no base to inherit from. */
const closedContainer = (P, name) => !(P.headNames().get(name) || []).some((t) => t.kind === 'type') || closedHierarchy(P, name);
const containerType = (F, s) => (isExtension(F, s) ? extendedType(F, s) : s.container ? s.container.split('.').pop() : null);
/**
 * JavaScript and Python have no nominal types: `api.load(…)` or `new Client().send(…)` is about the repository's
 * `api` or `Client` only if the calling file binds that name to a repository declaration: it declares it itself, or
 * imports it from a repository module that declares or re-exports it. A same-named object from a package is not it.
 */
function boundInRepo(side, F, here, t) {
  const declares = (X) => !!X && (X.symbols || []).some((s) => (s.kind === 'type' && s.name === t) || s.container === t);
  if (declares(F)) return true;
  for (const imp of F.imports || []) {
    if (typeof imp.source !== 'string') continue;
    const n = (imp.names || []).find((y) => y.local === t);
    if (!n && imp.default !== t && imp.ns !== t) continue;
    let R = null;
    if (isJsLike(F.lang)) { const r = resolveJs(side, here, imp.source); R = typeof r === 'string' ? side.files.get(r) : null; }
    else { const pm = pyModule(here, imp.source); if (pyUnique(side, pm)) for (const [path, X] of side.files) if (pyIs(pm, path)) { R = X; break; } }
    return !!R && (declares(R) || (R.imports || []).some((im) => im.reexport || (!isJsLike(R.lang) && (im.names || []).some((y) => y.local === t || y.imported === '*'))));
  }
  return false;
}
function tiedDecls(index, fileOf, x, side, here) {
  if (!index.size) return [];
  const o = x.o; let types = [];
  const inside = !o.recv || (o.recv.k === 'kw' && /^(this|base|self|super|cls)$/.test(o.recv.v));
  if (inside) { const inType = o.owner ? (o.owner.kind === 'type' ? o.owner.qname : o.owner.container) : null; if (inType) types.push(...inType.split('.')); }
  else if (o.recv.k === 'id') {
    types.push(o.recv.v, ...declaredTypes(x.F, o.recv.v, o.owner && o.owner.kind !== 'type' ? o.owner : null));
    const fam = family(x.F.lang);
    if (fam === 'js' || fam === 'py') types = types.filter((t) => index.has(t) && boundInRepo(side, x.F, here, t));
  }
  const out = new Set();
  for (const t of types) for (const s of index.get(t) || []) if (!(inside && isExtension(fileOf(s), s))) out.add(s); // an extension method needs a receiver
  return [...out];
}

/**
 * arityMismatches(ctx) → Finding[]
 *
 * For every function or method this pull request added, or whose accepted argument count it changed, reads every
 * call of that name at head and reports the calls whose argument count no declaration accepts (arity.mismatch).
 *   bad   the call binds to the declaration by the text alone (see bindCall) and passes a count it does not accept.
 *         In JavaScript and TypeScript only too few arguments are bad (a required parameter stays undefined);
 *         too many is warn, because the language ignores them.
 *   warn  the binding is not decided, but the text ties the call to the declaring type (see tieIndex: the receiver
 *         is declared with that type, or the call sits inside it) and none of its declarations accepts the count.
 *         Types are matched by simple name, so this stays a warning. A call with no such tie is not reported at
 *         all: a method of the same name on some other type is the norm, not an error.
 * Which names: every function or method the pull request added or whose accepted count it changed, and every
 * repository function called on a line the pull request added. A call on a line the pull request did not add is
 * reported only when the declaration changed and one at the merge base accepted its count: the mismatch is then a
 * consequence of the change. Counting is conservative: optional, default, rest and
 * params parameters widen the accepted range, a JavaScript parameter counts as required only when the body needs
 * its value and never tests it for absence (see arityOf), an extension method accepts its receiver either way,
 * calls with a spread and calls inside an assertion that expects an error are skipped, and a name is skipped
 * entirely when it is on the ubiquitous-name list, when a type or property shares it, when any declaration of it
 * cannot be counted, or when a declaration the symbol table does not have (local function, delegate) exists.
 * A field of the same name leaves at most the warning.
 * Does not establish: argument types, overload resolution by type, or anything about constructors (`new X(...)`).
 */
export function arityMismatches(ctx) {
  const P = prep(ctx), out = [];
  const changed = new Set();
  for (const d of P.diff) {
    if (d.status === 'deleted') continue;
    const F = P.head.get(d.path); if (!F || !CHECKED.has(family(F.lang))) continue;
    const bv = P.baseOf(d.path), old = new Map(); if (bv) for (const s of bv.F.symbols) old.set(s.key, s);
    for (const s of F.symbols) {
      if ((s.kind !== 'function' && s.kind !== 'method') || s.isTest || skipName(s.name)) continue;
      const b = old.get(s.key);
      if (b) { const now = arityOf(F, s), was = arityOf(bv.F, b); if (now && was && now.lo === was.lo && now.hi === was.hi) continue; }
      changed.add(`${family(F.lang)}\u0001${s.name}`);
    }
  }
  // Calls this pull request wrote: a name called on a line it added is examined too, whatever happened to the
  // declaration (a model that invents a signature calls an existing function with the wrong number of arguments).
  const declChanged = new Set(changed);
  for (const d of P.diff) {
    if (d.status === 'deleted') continue;
    const F = P.head.get(d.path); if (!F || !CHECKED.has(family(F.lang))) continue;
    const T = F.tokens, fam = family(F.lang), moved = P.moved(d.path);
    for (const h of d.hunks) {
      if (!h.added.length) continue;
      for (let i = firstAt(F, h.newStart); i < T.length && T[i].l < h.newStart + h.added.length; i++) {
        const t = T[i];
        if (t.k !== 'id' || !(isOpTok(T[i + 1], '(') || (isOpTok(T[i + 1], '<') && ANGLE.has(F.lang))) || moved.has(t.l) || skipName(t.v)) continue;
        const k = `${fam}\u0001${t.v}`;
        if (!changed.has(k) && (P.headNames().get(t.v) || []).some((s) => s.kind === 'function' || s.kind === 'method')) changed.add(k);
      }
    }
  }
  if (!changed.size) return out;
  const occ = occurrences(P, new Set([...changed].map((k) => k.split('\u0001')[1])));
  const side = P.sideHead();
  for (const key of [...changed].sort()) {
    const [fam, name] = key.split('\u0001');
    const inFam = (files) => (s) => { const F = files.get(s.file); return !!F && family(F.lang) === fam; };
    const all = (P.headNames().get(name) || []).filter(inFam(P.head));
    if (all.some((s) => s.kind !== 'function' && s.kind !== 'method')) continue; // `name(` may construct a type or invoke a property
    const range = new Map(all.map((s) => [s, arityOf(P.head.get(s.file), s)]));
    if ([...range.values()].some((r) => !r)) continue;
    const sites = (occ.get(name) || []).filter((x) => family(x.F.lang) === fam).map((x) => ({ F: x.F, i: x.i, o: occurrenceKind(x.F, x.i, name) }));
    if (sites.some((x) => x.o.kind === 'hidden')) continue;
    // A field of the same name somewhere: `name(` inside its type may invoke the field, so no call is taken as bound.
    const hasField = (fam === 'cs' || fam === 'java') && sites.some(fieldLike);
    const wasRanges = lazy(() => (P.baseNames().get(name) || []).filter(inFam(P.base)).map((s) => arityOf(P.base.get(s.file), s)).filter(Boolean));
    const fileOf = (s) => P.head.get(s.file), ties = lazy(() => tieIndex(P, all, fileOf, false));
    const inFile = new Map(); for (const x of sites) (inFile.get(x.F) || inFile.set(x.F, []).get(x.F)).push(x);
    const ranges = [...range.values()], found = [];
    for (const x of sites) {
      if (x.o.kind !== 'call') continue;
      const n = argCount(x.F, x.o.open); if (n < 0) continue;
      if (ranges.every((r) => n >= r.lo && n <= r.hi)) continue; // every declaration of the name accepts it: nothing to say, whatever it binds to
      if ((fam === 'js' || fam === 'py') && expectsThrow(x.F, x.i)) continue; // a test of the error path passes the wrong arguments on purpose
      let b = bindCall(P, side, x.F.path, x.F, x, name, all, inFile.get(x.F), false);
      if (b === 'foreign') continue;
      const tie = b && b.tie ? all.filter((s) => !s.container) : null;
      if (hasField || (b && b.tie)) b = null;
      const matchedBefore = wasRanges().some((r) => n >= r.lo && n <= r.hi);
      // Not bound: only the declarations the text ties this call to and that it can reach (see tieIndex, reachable).
      // A library base class of the declaring type may supply another overload, unless the count matched before.
      const cands = b ? b.syms : tie || tiedDecls(ties(), fileOf, x, side, x.F.path).filter((s) => reachable(x, s, fileOf(s), x.F.path) && (matchedBefore || closedContainer(P, containerType(fileOf(s), s))));
      if (!cands.length) continue;
      const rs = cands.map((s) => range.get(s));
      // A Python method may also be called on the class with the instance passed explicitly.
      if (rs.some((r, k) => n >= r.lo && n <= r.hi + (fam === 'py' && cands[k].container && x.o.recv ? 1 : 0))) continue;
      const line = x.F.tokens[x.i].l, fresh = P.added(x.F.path).has(line) && !P.moved(x.F.path).has(line);
      if (!fresh && !(matchedBefore && declChanged.has(key))) continue; // neither written by this pull request nor a consequence of a declaration it changed
      const tooMany = rs.every((r) => n > r.hi);
      if (!b && fam === 'js' && tooMany) continue;
      const severity = !b ? 'warn' : fam === 'js' && tooMany ? 'warn' : 'bad';
      const one = cands.length === 1 ? cands[0] : null;
      const title = one ? `Call passes ${plural(n, 'argument')}, function takes ${showRange(range.get(one))}` : `Call passes ${plural(n, 'argument')}, no overload takes ${n}`;
      const decl = one ? `${one.qname} (${one.file}:${one.start}) takes ${showRange(range.get(one))}` : `its ${cands.length} declarations take ${[...new Set(rs.map(showRange))].sort().join(', ')}`;
      const detail = `${name}(…) at ${x.F.path}:${line} passes ${plural(n, 'argument')}, but ${decl}${fam === 'js' && tooMany ? '; JavaScript drops the extra ones silently' : ''}.`;
      const basis = b
        ? `The call binds to the declaration by the text alone (${b.how}); both counts are read from the tokens${x.F.lang === 'js' && !tooMany ? ', and the function body uses the missing parameter without testing it for absence' : ''}${matchedBefore && !fresh ? '; a declaration at the merge base accepted this count' : ''}. Not established: argument types${b.residual ? `, or ${b.residual}` : ''}.`
        : `The receiver is declared in this file with the type that declares ${name} (or the call sits inside that type), and ${cands.length === 1 ? 'that declaration does not accept' : `none of its ${cands.length} declarations there accepts`} ${plural(n, 'argument')}${matchedBefore ? '; one at the merge base did' : ''}. Not established: the binding itself; types are matched by their simple name, without a type checker, which is why this is a warning.`;
      found.push({ sev: SEVERITY[severity], f: mk(P, 'arity.mismatch', severity, x.F.path, line, title, detail, basis) });
    }
    pushCapped(out, found);
  }
  return out;
}

/** At most ten findings for one name, the bound ones first; when more exist each one says how many. */
function pushCapped(out, found) {
  found.sort((a, b) => a.sev - b.sev || (a.f.file < b.f.file ? -1 : a.f.file > b.f.file ? 1 : a.f.line - b.f.line));
  for (const { f } of found.slice(0, 10)) { if (found.length > 10) f.detail = `${f.detail.replace(/\.$/, '')} (one of ${found.length} such calls; the first 10 are listed).`; out.push(f); }
}

/**
 * danglingReferences(ctx) → Finding[]
 *
 * A function or method that was declared at the merge base in a file this pull request touched, whose name no
 * file declares at head any more (as a function, method, property, type, variable or local function), and that
 * is still called at head: `name(` in the token stream, so comments and strings do not count (dangling.call).
 *   bad   the call binds to the removed declaration by the text alone (see bindCall): the name resolves to nothing.
 *   warn  the binding is not decided, but the call could have reached the removed declaration (see reachable),
 *         passes a number of arguments it accepted, and the text ties it to the declaring type (see tieIndex). A call
 *         with no such tie is not reported: a library method of the same name would still resolve.
 * At most 10 call sites per removed name. A function that was moved or whose file was renamed is still declared
 * and is not reported.
 * Does not establish: uses that are not calls (a function passed by name), or calls built from strings.
 */
export function danglingReferences(ctx) {
  const P = prep(ctx), out = [];
  const gone = new Map(); // family + name → declarations at the merge base
  for (const d of P.diff) {
    if (d.status === 'added') continue;
    const B = P.base.get(d.oldPath); if (!B || !CHECKED.has(family(B.lang))) continue;
    for (const s of B.symbols) {
      if ((s.kind !== 'function' && s.kind !== 'method') || s.isTest || skipName(s.name) || P.headNames().has(s.name)) continue;
      if ((isJsLike(B.lang) && JS_GLOBALS.has(s.name)) || (B.lang === 'py' && PY_BUILTINS.has(s.name))) continue; // removing a local stand-in leaves the built-in
      if ((s.modifiers || []).includes('override') || (s.attrs || []).includes('Override')) continue; // the member it overrode is still there
      const k = `${family(B.lang)}\u0001${s.name}`;
      if (gone.has(k)) gone.get(k).push(s); else gone.set(k, [s]);
    }
  }
  if (!gone.size) return out;
  const occ = occurrences(P, new Set([...gone.keys()].map((k) => k.split('\u0001')[1])));
  const side = P.sideBase();
  for (const key of [...gone.keys()].sort()) {
    const [fam, name] = key.split('\u0001'), decls = gone.get(key);
    const sites = (occ.get(name) || []).filter((x) => family(x.F.lang) === fam).map((x) => ({ F: x.F, i: x.i, o: occurrenceKind(x.F, x.i, name) }));
    // Still defined in a form the symbol table does not record: a local function, a variable or field of that name, an export.
    const stillDefined = sites.some((x) => {
      if (x.o.kind === 'hidden' || x.o.kind === 'decl') return true;
      if (x.o.kind !== 'ref' || (x.o.owner && x.o.owner.kind !== 'type')) return false;
      if (fam === 'cs' || fam === 'java') return fieldLike(x);
      return binderKind(x.F, x.i) === 'local' || (fam === 'js' && jsExports(x.F).names.has(name));
    });
    if (stillDefined) continue;
    // Python: every name a module imports is a name it provides. If the module that declared the function now
    // imports that name, or star-imports anything, `from module import name` may still resolve.
    if (fam === 'py' && decls.some((s) => {
      const d = P.diff.find((q) => q.oldPath === s.file), H = d && d.status !== 'deleted' ? P.head.get(d.path) : null;
      return !!H && (H.imports || []).some((im) => (im.names || []).some((n) => n.local === name || n.imported === '*') || im.ns === name);
    })) continue;
    const fileOf = (s) => P.base.get(s.file), ties = lazy(() => tieIndex(P, decls, fileOf, true));
    const inFile = new Map(); for (const x of sites) (inFile.get(x.F) || inFile.set(x.F, []).get(x.F)).push(x);
    const found = [];
    for (const x of sites) {
      if (x.o.kind !== 'call') continue;
      const bv = P.baseOf(x.F.path), here = bv ? bv.path : x.F.path;
      let b = bindCall(P, side, here, x.F, x, name, decls, inFile.get(x.F), true);
      if (b === 'foreign') continue;
      let tied = !!(b && b.tie);
      if (tied) b = null;
      if (b && b.source && fam === 'js') { // the module is still there: if its export list is open, the name may still come out of it
        const rh = resolveJs(P.sideHead(), x.F.path, b.source), TH = typeof rh === 'string' ? P.head.get(rh) : null;
        if (TH && isJsLike(TH.lang) && jsExports(TH).open) { b = null; tied = true; }
      }
      if (!b && !tied) { // not bound: could this call have reached a removed declaration, with this many arguments, and does the text tie it to its type?
        const n = argCount(x.F, x.o.open);
        const could = tiedDecls(ties(), fileOf, x, side, here).filter((s) => { const D = fileOf(s), r = arityOf(D, s); return reachable(x, s, D, here) && (!r || n < 0 || (n >= r.lo && n <= r.hi + (fam === 'py' ? 1 : 0))); });
        if (!could.length) continue;
      }
      const line = x.F.tokens[x.i].l, was = decls[0], severity = b ? 'bad' : 'warn';
      const basis = b
        ? `The call binds to the removed declaration by the text alone (${b.how}), and no source file read at head declares anything named ${name}. Not established: a declaration produced by a code generator at build time${b.residual ? `, or ${b.residual}` : ''}.`
        : `A function named ${name} was declared at the merge base and no source file read at head declares that name; the text ties this call to it (the receiver is declared with its type, the call sits inside that type, or the file imports the name from its module) and passes a number of arguments it accepted. Not established: the binding itself; types are matched by their simple name, and a library method of the same name would still resolve, which is why this is a warning.`;
      found.push({ sev: SEVERITY[severity], f: mk(P, 'dangling.call', severity, x.F.path, line, 'Still called, no longer defined',
        `${name}(…) is called at ${x.F.path}:${line}, but ${was.qname} (${was.file}:${was.start} at the merge base) was removed and nothing named ${name} is declared at head.`, basis) });
    }
    pushCapped(out, found);
  }
  return out;
}

// ───────────────────────────────────────────────────────────── tests

const JS_TEST_WORD = new Set(['it', 'test', 'describe', 'context', 'suite', 'specify']);
const T_ASSERT = new Set('is not deepEqual notDeepEqual equal notEqual strictEqual notStrictEqual deepStrictEqual same notSame ok notOk true false truthy falsy throws throwsAsync notThrows notThrowsAsync rejects doesNotThrow doesNotReject match notMatch regex notRegex like assert pass fail snapshot ifError'.split(' '));

/** Does token i start an assertion? Assert.X(, expect(, assert( / assert.x(, assertEquals(, should, t.is(, verify(, pytest.raises(. */
function isAssertion(F, i) {
  const T = F.tokens, t = T[i], v = t.v, n = T[i + 1], p = T[i - 1];
  const nv = n && n.k === 'op' ? n.v : '', pv = p && p.k === 'op' ? p.v : '';
  if (t.k === 'kw') return v === 'assert';
  if (t.k !== 'id') return false;
  if (v === 'expect') return nv === '(';
  if (v === 'assert') return (nv === '(' || nv === '.' || nv === '!') && pv !== '.';
  if (/^[A-Za-z]*Assert$/.test(v)) return nv === '.';
  if (/^assert[A-Z_]\w*$/.test(v)) return nv === '(' || nv === '!';
  if (v === 'should' || v === 'Should') return true;
  if (/^Should[A-Z]\w*$/.test(v) || /^[Vv]erify\w*$/.test(v)) {
    if (nv === '(' || nv === '<') return true;
    // `new VerifyCS.Test { … }.RunAsync()`: the Roslyn test harness runs its comparison when the built object is run.
    if (nv !== '.' || !p || p.k !== 'kw' || p.v !== 'new') return false;
    let j = i + 1; const M = F.match;
    while (isOpTok(T[j], '.') && isWord(T[j + 1])) j += 2;
    if (isOpTok(T[j], '(') && M[j] > j) j = M[j] + 1;
    if (isOpTok(T[j], '{') && M[j] > j) j = M[j] + 1;
    return isOpTok(T[j], '.') && !!T[j + 1] && /^Run\w*$/.test(T[j + 1].v) && isOpTok(T[j + 2], '(');
  }
  if (v === 't') return nv === '.' && !!T[i + 2] && T_ASSERT.has(T[i + 2].v) && isOpTok(T[i + 3], '(');
  if (v === 'raises' || v === 'warns') return pv === '.' && !!T[i - 2] && T[i - 2].v === 'pytest';
  return false;
}

/**
 * The assertions in a symbol's body: [{ i, end, line, constant }] with [i, end) the token span of the whole chained
 * call or assert statement. `constant`: its arguments are literals only (assert.ok(true), Assert.True(true),
 * expect(1).toBe(1), assert True), so it cannot fail whatever the code under test does; `fail` calls are not
 * constant in that sense, they always fail when reached.
 */
function assertionsOf(F, s) {
  const T = F.tokens, M = F.match, out = [];
  for (let i = s.bodyA; i < s.bodyB; i++) {
    if (!isAssertion(F, i)) continue;
    let j = i + 1;
    if (T[i].k === 'kw') { while (j < s.bodyB && !isOpTok(T[j], ';')) { if (T[j].k === 'op' && (T[j].v === '(' || T[j].v === '[' || T[j].v === '{') && M[j] > j) j = M[j]; j++; } }
    else while (j < s.bodyB) {
      const u = T[j]; if (u.k !== 'op') break;
      if ((u.v === '(' || u.v === '[') && M[j] > j) { j = M[j] + 1; continue; }
      if (u.v === '.' || u.v === '?.') { j++; if (isWord(T[j])) j++; continue; }
      if (u.v === '!') { j++; continue; }
      if (u.v === '<') { const o = callOpen(F, j - 1); if (o > 0) { j = M[o] + 1; continue; } }
      break;
    }
    let constant = true, args = 0;
    for (let k = i + 1; k < j && constant; k++) {
      const u = T[k];
      if (u.k === 'num' || (u.k === 'str' && unquote(u.v) != null)) args++;
      else if (isWord(u)) { if (/^(true|false|null|undefined|None|True|False)$/.test(u.v)) args++; else if (!isOpTok(T[k - 1], '.') || /^fail/i.test(u.v)) constant = false; }
      else if (u.k !== 'op' || !'(),.!'.includes(u.v)) constant = false;
    }
    // `x.should.equal(1)`, `x.Should().Be(1)`: the subject stands before the span, so the span alone says nothing.
    out.push({ i, end: j, line: T[i].l, constant: constant && args > 0 && !/^fail/i.test(T[i].v) && !isOpTok(T[i - 1], '.') });
    i = j - 1;
  }
  return out;
}

const BALANCED = new WeakMap();
/** Do all brackets of a file pair up? False for a file cut in the middle of a block or of a string. */
function balanced(F) {
  let v = BALANCED.get(F);
  if (v === undefined) { v = true; const T = F.tokens, M = F.match; for (let i = 0; i < T.length && v; i++) if (T[i].k === 'op' && '()[]{}'.includes(T[i].v) && T[i].v.length === 1 && M[i] < 0) v = false; BALANCED.set(F, v); }
  return v;
}

const REAL_TEST_ATTR = /^(Fact|Theory|Test|TestMethod|TestCase|TestCaseSource|DataTestMethod|InlineData|MemberData|ClassData|CombinatorialData|ParameterizedTest|RepeatedTest)$/;
/** A benchmark (BenchmarkDotNet's [Benchmark], bench(…)): symbols.js marks it like a test, but removing one removes no check. */
const isBenchmark = (F, s) => ((s.attrs || []).includes('Benchmark') && !(s.attrs || []).some((a) => REAL_TEST_ATTR.test(a))) || (isJsLike(F.lang) && !!F.tokens[s.a] && F.tokens[s.a].v === 'bench');

/**
 * A test that is switched off from the inside: { line, text } or null.
 *   - JavaScript: the options of the call say so, `test('name', { skip: true }, fn)` (node:test; also `todo`), with a
 *     literal true or a reason string; a condition (`skip: process.platform === 'win32'`) is not unconditional and is left alone;
 *   - any language: the first statement of the body leaves the test: a bare `return`, `t.skip(…)`/`this.skip()`,
 *     pytest.skip(…), self.skipTest(…), raise SkipTest, Assert.Skip/Ignore/Inconclusive(…).
 */
function innerSkip(F, s) {
  const T = F.tokens, M = F.match;
  if (isJsLike(F.lang)) {
    let o = -1; for (let i = s.a; i < Math.min(s.bodyA, s.a + 8); i++) if (isOpTok(T[i], '(')) { o = i; break; }
    if (o >= 0 && T[o + 1] && T[o + 1].k === 'str' && isOpTok(T[o + 2], ',') && isOpTok(T[o + 3], '{') && M[o + 3] > o + 3) {
      for (let k = o + 4; k < M[o + 3]; k++) {
        const u = T[k];
        if ((u.k === 'op' && (u.v === '(' || u.v === '[' || u.v === '{' || u.v === '${')) && M[k] > k) { k = M[k]; continue; }
        if (!isWord(u) || (u.v !== 'skip' && u.v !== 'todo') || !isOpTok(T[k + 1], ':') || !(isOpTok(T[k - 1], '{') || isOpTok(T[k - 1], ','))) continue;
        const v = T[k + 2], end = T[k + 3];
        if (v && (isOpTok(end, ',') || isOpTok(end, '}')) && ((isWord(v) && v.v === 'true') || (v.k === 'str' && unquote(v.v) != null))) return { line: u.l, text: `{ ${u.v}: ${clip(v.v, 40)} }` };
      }
    }
  }
  if (s.bodyB - s.bodyA < 2 || !isOpTok(T[s.bodyA], '{')) return null;
  let k = s.bodyA + 1;
  if (F.lang === 'py' && T[k] && T[k].k === 'str' && isOpTok(T[k + 1], ';')) k += 2; // a docstring
  const t = T[k], n = T[k + 1]; if (!t) return null;
  if (t.k === 'kw' && t.v === 'return' && (isOpTok(n, ';') || isOpTok(n, '}'))) return { line: t.l, text: 'a bare return as its first statement' };
  const call = (...words) => words.every((w, q) => T[k + 2 * q] && T[k + 2 * q].v === w && (q === words.length - 1 ? isOpTok(T[k + 2 * q + 1], '(') : isOpTok(T[k + 2 * q + 1], '.')));
  if (isJsLike(F.lang) && isWord(t) && isOpTok(n, '.') && T[k + 2] && (T[k + 2].v === 'skip' || T[k + 2].v === 'todo') && isOpTok(T[k + 3], '(') && (t.v === 'this' || (s.paramNames || []).includes(t.v))) return { line: t.l, text: `${t.v}.${T[k + 2].v}() as its first statement` };
  if (F.lang === 'py' && (call('pytest', 'skip') || call('self', 'skipTest') || (t.v === 'raise' && n && /SkipTest$/.test(n.v)) || (t.v === 'raise' && n && n.v === 'unittest' && T[k + 3] && T[k + 3].v === 'SkipTest'))) return { line: t.l, text: 'a skip as its first statement' };
  if ((F.lang === 'cs' || F.lang === 'java') && (call('Assert', 'Skip') || call('Assert', 'Ignore') || call('Assert', 'Inconclusive'))) return { line: t.l, text: `${t.v}.${T[k + 2].v}() as its first statement` };
  return null;
}

/** `.only` markers in a JavaScript test file: it.only(, describe.only(, fit(, fdescribe(, { only: true }. [{ line, kind, label }] */
function jsOnlys(F) {
  const T = F.tokens, M = F.match, out = [];
  const label = (i) => (T[i] && T[i].k === 'str' ? T[i].v.replace(/^[`'"]|[`'"]$/g, '').slice(0, 80) : null);
  for (let i = 0; i < T.length; i++) {
    const t = T[i]; if (!isWord(t) || !isOpTok(T[i + 1], '(')) continue;
    if (/^f(it|describe|context)$/.test(t.v) && !isOpTok(T[i - 1], '.')) { const l = label(i + 2); if (l != null) out.push({ line: t.l, kind: t.v, label: l }); continue; }
    if (t.v === 'only' && isOpTok(T[i - 1], '.')) {
      let r = i - 2; while (r >= 2 && isOpTok(T[r - 1], '.') && isWord(T[r - 2])) r -= 2;
      const l = label(i + 2);
      if (T[r] && JS_TEST_WORD.has(T[r].v) && !isOpTok(T[r - 1], '.') && l != null) out.push({ line: t.l, kind: `${T[r].v}.only`, label: l });
      continue;
    }
    if (JS_TEST_WORD.has(t.v) && !isOpTok(T[i - 1], '.') && label(i + 2) != null && isOpTok(T[i + 3], ',') && isOpTok(T[i + 4], '{') && M[i + 4] > 0) {
      for (let k = i + 5; k < M[i + 4]; k++) if (isWord(T[k]) && T[k].v === 'only' && isOpTok(T[k + 1], ':') && T[k + 2] && T[k + 2].v === 'true' && (isOpTok(T[k - 1], '{') || isOpTok(T[k - 1], ','))) { out.push({ line: T[k].l, kind: `${t.v}(…, { only: true })`, label: label(i + 2) }); break; }
    }
  }
  return out;
}

/** Skip markers on a declaration: xUnit Skip =, [Ignore], @Disabled, @Ignore, @pytest.mark.skip, @unittest.skip. [{ line, text }] */
function skipMarks(F, s) {
  const T = F.tokens, M = F.match, out = [];
  if (F.lang === 'py') { for (const d of pyDecorators(F, s)) if (/(^|\.)skip$/.test(d.name)) out.push({ line: d.line, text: `@${d.name}` }); return out; }
  const end = s.bodyA > s.a ? s.bodyA : s.b;
  for (let i = s.a; i < end; i++) {
    const t = T[i];
    if (isOpTok(t, '[') && F.lang === 'cs' && M[i] > i) {
      for (let j = i + 1; j < M[i]; j++) {
        if (T[j].k !== 'id') continue;
        if (T[j].v === 'Skip' && isOpTok(T[j + 1], '=')) out.push({ line: T[j].l, text: `Skip = ${T[j + 2] && T[j + 2].k === 'str' ? clip(T[j + 2].v, 50) : '…'}` });
        else if (/^(Ignore|Ignored|Disabled)(Attribute)?$/.test(T[j].v) && (isOpTok(T[j - 1], '[') || isOpTok(T[j - 1], ',') || isOpTok(T[j - 1], '.'))) out.push({ line: T[j].l, text: `[${T[j].v}]` });
      }
      i = M[i]; continue;
    }
    if (isOpTok(t, '@') && isWord(T[i + 1])) { if (/^(Disabled|Ignore)$/.test(T[i + 1].v)) out.push({ line: t.l, text: `@${T[i + 1].v}` }); i++; if (isOpTok(T[i + 1], '(') && M[i + 1] > i) i = M[i + 1]; continue; }
    if (isWord(t)) break; // past the attributes
  }
  return out;
}

/** Skip markers in a JavaScript test file: it.skip(, describe.skip(, xit(, xdescribe(, it.todo(. [{ line, kind, label, group }] */
function jsSkips(F) {
  const T = F.tokens, out = [];
  const label = (i) => (T[i] && T[i].k === 'str' ? T[i].v.replace(/^[`'"]|[`'"]$/g, '').slice(0, 80) : null);
  for (let i = 0; i < T.length; i++) {
    const t = T[i]; if (t.k !== 'id' || !isOpTok(T[i + 1], '(')) continue;
    if (/^x(it|test|specify|describe|context)$/.test(t.v) && !isOpTok(T[i - 1], '.')) { const l = label(i + 2); if (l != null) out.push({ line: t.l, kind: t.v, label: l, group: /describe|context/.test(t.v) }); continue; }
    if ((t.v !== 'skip' && t.v !== 'todo') || !isOpTok(T[i - 1], '.')) continue;
    let r = i - 2; while (r >= 2 && isOpTok(T[r - 1], '.') && isWord(T[r - 2])) r -= 2; // it.concurrent.skip → it
    const root = T[r] && isWord(T[r]) ? T[r].v : '', l = label(i + 2);
    if (JS_TEST_WORD.has(root) && !isOpTok(T[r - 1], '.') && l != null) out.push({ line: t.l, kind: `${root}.${t.v}`, label: l, group: root === 'describe' || root === 'context' || root === 'suite' });
  }
  return out;
}

/**
 * testWeakening(ctx) → Finding[]
 *
 * Facts about the tests in files the diff touches, comparing test symbols at the merge base and at head:
 *   test.removed             bad   a test declared at the merge base that is gone at head. Not reported when the
 *                                  same qualified name survives in another file (moved) or an identical copy of it
 *                                  remains, when a test that is new in the changed files has its name (class
 *                                  renamed) or its body (test renamed), or when its declaration line was rewritten
 *                                  in place into a new test (renamed and edited: the two are then compared as one).
 *   test.disabled            bad   a test or test class that exists on both sides and gained a skip marker, a skip
 *                                  option or a first statement that leaves it (see innerSkip), or whose method is
 *                                  still declared but lost its test attribute
 *   test.only                warn  a JavaScript test or group newly marked .only (fit, fdescribe, { only: true }):
 *                                  the runner then leaves the other tests out
 *   test.assertions-removed  warn  a test on both sides whose body makes fewer assertion calls than before; an
 *                                  assertion over literals only (assert.ok(true)) does not count, on either side
 *   test.cases-removed       warn  a parameterised test on both sides with fewer data rows (InlineData, TestCase, DataRow)
 *   test.expectation-changed info  an assertion of an existing test that kept its shape and changed a string or
 *                                  number literal, in a pull request that also changes non-test source
 * Benchmarks ([Benchmark], bench(…)) are not tests here: removing one removes no check.
 * Does not establish: that a remaining assertion still checks the same thing, that a removed assertion mattered,
 * or that a test is run by the build. Counting assertion calls is a count of calls, not of what they verify.
 * Not detected: conditional skips, #if around a test, a test class made abstract. When the head file no longer
 * parses (its brackets do not balance, and did at the merge base) no test of it is reported as removed.
 */
export function testWeakening(ctx) {
  const P = prep(ctx), out = [];
  const testsOf = (F) => (F ? F.symbols.filter((s) => s.isTest && s.kind !== 'type' && !isBenchmark(F, s)) : []);
  const everywhere = lazy(() => {
    const m = new Map(), tally = (files, k) => { for (const F of files.values()) for (const s of testsOf(F)) { const e = m.get(s.qname) || [0, 0]; e[k]++; m.set(s.qname, e); } };
    tally(P.base, 0); tally(P.head, 1); return m;
  });
  const sig = (F, s) => signature(F.tokens.slice(s.bodyA, s.bodyB));
  // Tests that are new at head (their qualified name is more frequent at head than at the merge base) in the files
  // of the diff: their bodies, and their bare names (a test keeps its name when its class is renamed).
  const arrivals = lazy(() => {
    const bodies = new Set(), names = new Set();
    for (const d of P.diff) { const H = d.status === 'deleted' ? null : P.head.get(d.path); for (const s of testsOf(H)) { const g = everywhere().get(s.qname); if (g && g[1] > g[0]) { names.add(s.name); if (s.bodyB - s.bodyA >= 6) bodies.add(sig(H, s)); } } }
    return { bodies, names };
  });
  // Every test at head by qualified name, to tell a removed copy from a removed test.
  const atHead = lazy(() => { const m = new Map(); for (const F of P.head.values()) for (const s of testsOf(F)) (m.get(s.qname) || m.set(s.qname, []).get(s.qname)).push([F, s]); return m; });
  const rows = (s) => s.attrs.filter((a) => /^(InlineData|TestCase|DataRow)$/.test(a)).length;

  for (const d of P.diff) {
    const B = d.status === 'added' ? null : P.base.get(d.oldPath), H = d.status === 'deleted' ? null : P.head.get(d.path);
    if (H && isJsLike(H.lang) && testsOf(H).length) { // .only, in a new file as well: it changes which tests run
      const before = new Map(); for (const m of B ? jsOnlys(B) : []) { const k = `${m.kind}\u0001${m.label}`; before.set(k, (before.get(k) || 0) + 1); }
      for (const m of jsOnlys(H)) {
        const k = `${m.kind}\u0001${m.label}`; if (before.get(k) > 0) { before.set(k, before.get(k) - 1); continue; }
        out.push(mk(P, 'test.only', 'warn', d.path, m.line, 'Test run restricted by .only',
          `${m.kind} on '${clip(m.label)}' at ${d.path}:${m.line} tells the runner to run only what is marked, which leaves the other tests out.`,
          'The marker is in the tokens at head and not at the merge base. Not established: that the runner honours it (Mocha, Jest and Vitest do; node:test only under --test-only).'));
      }
    }
    if (!B) continue;
    const bt = testsOf(B), ht = testsOf(H);
    if (!bt.length) continue;
    const file = H ? d.path : d.oldPath;
    const headByKey = new Map(ht.map((s) => [s.key, s]));
    // Pair each test with itself on the other side: by key, then in order among those that share a name
    // (an overload key changes when a sibling of the same name appears or goes).
    const pairs = [], paired = new Set(), pairedBase = new Set();
    for (const sb of bt) { const sh = headByKey.get(sb.key); if (sh && !paired.has(sh)) { pairs.push([sb, sh]); paired.add(sh); pairedBase.add(sb); } }
    for (const sb of bt) {
      if (pairedBase.has(sb)) continue;
      const sh = ht.find((s) => s.qname === sb.qname && !paired.has(s));
      if (sh) { pairs.push([sb, sh]); paired.add(sh); pairedBase.add(sb); }
    }

    // Skip markers, first: a test turned into it.todo() is reported once, as disabled.
    const disabled = new Set();
    if (H && isJsLike(H.lang)) {
      const before = new Map(); for (const m of jsSkips(B)) { const k = `${m.kind}\u0001${m.label}`; before.set(k, (before.get(k) || 0) + 1); }
      for (const m of jsSkips(H)) {
        const k = `${m.kind}\u0001${m.label}`; if (before.get(k) > 0) { before.set(k, before.get(k) - 1); continue; }
        const hit = m.group ? bt.filter((s) => s.qname.startsWith(`${m.label}.`) || s.qname.includes(`.${m.label}.`)) : bt.filter((s) => s.name === m.label);
        if (!hit.length) continue; // a new test written as skipped weakens nothing that existed
        for (const s of hit) disabled.add(s.qname);
        out.push(mk(P, 'test.disabled', 'bad', file, m.line, 'Test disabled',
          `${m.kind}('${clip(m.label)}') at ${file}:${m.line} switches off ${m.group ? `the ${plural(hit.length, 'test')} of that group, which ran` : 'a test that ran'} at the merge base.`,
          'The skip marker is in the tokens at head and not at the merge base, and a test with that name exists at the merge base. Not established: why it was disabled.'));
      }
    } else if (H) {
      const baseSyms = new Map(B.symbols.map((s) => [s.key, s]));
      for (const sh of H.symbols) {
        if (!sh.isTest && sh.kind !== 'type') continue;
        const marks = skipMarks(H, sh); if (!marks.length) continue;
        const sb = baseSyms.get(sh.key) || (pairs.find((p) => p[1] === sh) || [])[0];
        if (!sb || sb.kind !== sh.kind || skipMarks(B, sb).length) continue;
        if (sh.kind === 'type' && !bt.some((s) => s.container === sb.qname || String(s.container).startsWith(`${sb.qname}.`))) continue;
        disabled.add(sh.qname);
        out.push(mk(P, 'test.disabled', 'bad', file, marks[0].line, 'Test disabled',
          `${sh.kind === 'type' ? 'Test class' : 'Test'} ${sh.qname} at ${file}:${marks[0].line} gained ${marks[0].text} and no longer runs.`,
          'The skip marker is in the declaration at head and not in the same declaration at the merge base. Not established: why it was disabled.'));
      }
    }

    // Tests that are gone. A head file whose brackets no longer balance (and did at the merge base) does not parse:
    // the symbols after the break are lost, so "gone" cannot be told from "unreadable" and nothing is said.
    const unreadable = !!H && !balanced(H) && balanced(B);
    const fresh = ht.filter((s) => !paired.has(s));
    const lineOf = (F, s, k) => F.tokens[Math.min(Math.max(k, s.a), F.tokens.length - 1)].l;
    for (const sb of bt) {
      if (pairedBase.has(sb) || disabled.has(sb.qname) || unreadable) continue;
      const g = everywhere().get(sb.qname), body = sig(B, sb);
      if (g && g[1] >= g[0]) continue; // the same test lives on in another file
      const twins = atHead().get(sb.qname) || [];
      if (twins.some(([F, s]) => sig(F, s) === body)) continue; // one copy of a duplicated test went; an identical one remains
      if ((sb.bodyB - sb.bodyA >= 6 && arrivals().bodies.has(body)) || arrivals().names.has(sb.name)) continue; // renamed, or moved to a class of another name
      if (H) { // rewritten in place: a hunk replaces its declaration line with the declaration line of a new test
        const a0 = sb.start, a1 = lineOf(B, sb, sb.bodyA);
        const h = d.hunks.find((x) => x.oldLines > 0 && x.newLines > 0 && x.oldStart <= a1 && x.oldStart + x.oldLines - 1 >= a0);
        const sh = h ? fresh.find((s) => !paired.has(s) && s.start <= h.newStart + h.newLines - 1 && lineOf(H, s, s.bodyA) >= h.newStart) : null;
        if (sh) { pairs.push([sb, sh]); paired.add(sh); pairedBase.add(sb); continue; }
      }
      const kept = H ? H.symbols.find((s) => s.qname === sb.qname && s.kind === sb.kind && !s.isTest && s.params === sb.params) : null;
      if (kept) { // the method is still there, without what made it a test
        const lost = sb.attrs.filter((a) => REAL_TEST_ATTR.test(a));
        out.push(mk(P, 'test.disabled', 'bad', file, kept.start, 'Test disabled',
          `${sb.qname} at ${file}:${kept.start} is still declared but ${lost.length ? `lost [${lost.join('], [')}]` : 'is no longer marked as a test'}, so the test runner no longer runs it.`,
          'The declaration exists on both sides; at the merge base it carried a test attribute and at head it carries none. Not established: why.', kept));
        continue;
      }
      const cut = H ? d.hunks.find((x) => x.oldStart <= sb.end && x.oldStart + Math.max(x.oldLines, 1) - 1 >= sb.start) : null;
      const extra = H && fresh.length ? `; the file gains ${plural(fresh.filter((s) => !paired.has(s)).length, 'other new test')}` : '';
      out.push(mk(P, 'test.removed', 'bad', file, H ? Math.max(1, cut ? cut.newStart : 1) : sb.start, 'Test removed',
        `Test ${sb.qname} (${d.oldPath}:${sb.start} at the merge base) ${H ? 'is no longer in the file' : 'was deleted with its file'} and ${twins.length ? 'the test of that name that remains at head has a different body' : 'no test of that name exists at head'}${extra}.`,
        'A test with this name is declared at the merge base and is gone at head; no test that is new in the changed files has its name or its body, and none replaced its declaration line. Not established: whether another test covers the same behaviour.',
        (H && H.symbols.find((s) => s.kind === 'type' && s.qname === sb.container)) || null)); // the class it was in, never a neighbouring test
    }

    // Tests on both sides.
    for (const [sb, sh] of pairs) {
      if (!disabled.has(sh.qname)) { // switched off from the inside: a skip option, or a first statement that leaves the test
        const m = innerSkip(H, sh);
        if (m && !innerSkip(B, sb)) {
          disabled.add(sh.qname);
          out.push(mk(P, 'test.disabled', 'bad', file, m.line, 'Test disabled',
            `Test ${sh.qname} at ${file}:${m.line} gained ${m.text} and no longer runs its checks.`,
            'The marker is in the test at head and not in the same test at the merge base. Not established: why it was disabled.'));
        }
      }
      const allB = assertionsOf(B, sb), allH = assertionsOf(H, sh);
      const ab = allB.filter((a) => !a.constant), ah = allH.filter((a) => !a.constant), hollow = allH.length - ah.length;
      if (ah.length < ab.length) out.push(mk(P, 'test.assertions-removed', 'warn', file, sh.start, 'Assertions removed',
        `Test ${sh.qname} makes ${plural(ah.length, 'assertion call')} at head, down from ${ab.length} at the merge base${hollow ? ` (not counting ${plural(hollow, 'assertion')} over literals only, which cannot fail)` : ''}.`,
        'Assertion calls (Assert.*, expect(, assert, should, t.is(, verify() were counted in the test body on both sides; an assertion whose arguments are all literals is not counted on either side. Not established: that the removed ones were not moved into a helper, or that the remaining ones are weaker.'));
      if (rows(sh) < rows(sb)) out.push(mk(P, 'test.cases-removed', 'warn', file, sh.start, 'Test cases removed',
        `Test ${sh.qname} has ${plural(rows(sh), 'data row')} at head, down from ${rows(sb)} at the merge base.`,
        'InlineData, TestCase and DataRow attributes were counted on the declaration on both sides. Not established: whether the removed rows were redundant.'));
      if (!P.changesSource() || !ab.length || !ah.length) continue;
      // An expectation that kept its shape and changed a literal.
      const shape = (F, a) => { const lits = [], T = F.tokens; let sh2 = ''; for (let i = a.i; i < a.end; i++) { if (T[i].k === 'str' || T[i].k === 'num') { lits.push(T[i].v); sh2 += '\u0002'; } else sh2 += T[i].v; sh2 += '\u0001'; } return { shape: sh2, lits, key: lits.join('\u0001'), line: a.line }; };
      const was = new Map(), now = new Map();
      for (const a of ab) { const x = shape(B, a); if (x.lits.length) (was.get(x.shape) || was.set(x.shape, []).get(x.shape)).push(x); }
      for (const a of ah) { const x = shape(H, a); if (x.lits.length) (now.get(x.shape) || now.set(x.shape, []).get(x.shape)).push(x); }
      let shown = 0;
      for (const [k, hs] of now) {
        const bs = was.get(k); if (!bs) continue;
        const left = bs.filter((x) => !hs.some((y) => y.key === x.key)), right = hs.filter((y) => !bs.some((x) => x.key === y.key));
        for (let q = 0; q < Math.min(left.length, right.length) && shown < 3; q++, shown++) {
          const at = left[q].lits.findIndex((v, n) => v !== right[q].lits[n]);
          out.push(mk(P, 'test.expectation-changed', 'info', file, right[q].line, 'An existing expectation was changed',
            `In test ${sh.qname} an assertion kept its form but its literal changed from ${clip(left[q].lits[at], 40)} to ${clip(right[q].lits[at], 40)}.`,
            'The assertion has the same tokens on both sides except for this literal, and the pull request also changes non-test source. Not established: which of the two values is right.'));
        }
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── practices

// The name must END in the secret word. `secretKey` is a secret; `tokenKey` and `passwordKey` name the key a
// token or password is stored under (a storage or header name), so `key` is accepted only after `secret`.
const SECRET_NAME = /(?:password|passwd|token|api[_-]?key|private[_-]?key|secret(?:[_-]?key)?)(?:[_-]?(?:value|string|str))?\d*$/i;
// Folders and files of test data: a password there is a fixture, not a credential of the product.
const TEST_DATA = /(^|\/)(fixtures?|__fixtures__|mocks?|__mocks__|testdata|test-data|e2e|cypress|playwright|stories|\.storybook)\/|\.(stories|mock|fixture|cy)\.[a-z]+$/i;
// PublicKeyToken identifies a .NET assembly; cancellation, continuation and paging tokens are not credentials.
const NOT_SECRET = /public[_-]?key|cancellation|continuation|page[_-]?token|next[_-]?token|sync[_-]?token/i;
const SECRET_FORMAT = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JSON Web Token'],
  [/\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/, 'a bearer token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bsk_live_[0-9A-Za-z]{16,}\b/, 'a Stripe live key'],
];
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PLACEHOLDER = /change[_-]?me|placeholder|example|sample|dummy|fake|redacted|your[_-]|insert|replace|todo|fixme|xxxx|\*\*\*|\.\.\.|[<>{}]|%s|^\$[A-Za-z_]|^%\w+%$|^(env|vault|secret|ssm|file|op|ref)[:.]|^(.)\1+$/i; // wording, template holes, references to where the value lives

/**
 * Could this literal be a credential? Deliberately narrow, because the finding is 'bad': no white space, no
 * placeholder wording, not a path, URL, dotted or colon-separated key, not the name of an environment variable
 * (ALL_CAPS), and not plain words (letters of any alphabet with - or _ only): a value assigned to a secret-named
 * variable must carry at least one digit or other symbol, which every generated key does.
 */
function credentialLike(v) {
  if (v.length < 8 || /\s/.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^(https?:|file:|\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(v) || /\.(pem|key|json|txt|ya?ml|crt|cer|pfx|p12|env|ini|cfg|conf|xml)$/i.test(v)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(v) || /^\p{L}+([_-]\p{L}+)*$/u.test(v)) return false; // letters of any alphabet: 'Contraseña' is a word, not a key
  if (/^[A-Za-z_][\w-]*([.:][A-Za-z_][\w-]*)+$/.test(v) && !/\d/.test(v)) return false;
  return true;
}
const mask = (v) => `${v.slice(0, 4)}… (${v.length} characters)`;

/** Credentials on one added line by their format alone: { what, shown } or null. `next` is the following added line. */
function formatSecret(text, next) {
  if (text.length > 4000) return null;
  for (const [re, what] of SECRET_FORMAT) {
    const m = re.exec(text); if (!m) continue;
    const v = m[1] || m[0];
    if (/EXAMPLE/i.test(v) || PLACEHOLDER.test(v) || (m[1] && !(/\d/.test(v) && /[A-Za-z]/.test(v)))) continue;
    return { what, shown: mask(v) };
  }
  const pem = PEM.exec(text);
  // A header alone is what PEM-handling code looks like; key material after it is a key.
  if (pem && (/(\\n|\\r|\s)[A-Za-z0-9+/]{24,}/.test(text.slice(pem.index + pem[0].length)) || /^\s*["'`]?[A-Za-z0-9+/=]{40,}(\\n)?["'`]?\s*[+,]?\s*$/.test(next || ''))) return { what: 'a private key', shown: pem[0] };
  return null;
}

/** Empty error handlers in a token range: catch blocks with no token, promise .catch handlers with an empty body, Python except: pass. */
function swallows(F, a = 0, b = F.tokens.length) {
  const T = F.tokens, M = F.match, out = [], op = (i, v) => i < b && isOpTok(T[i], v);
  for (let i = a; i < b; i++) {
    const t = T[i]; if (t.k !== 'kw') continue;
    if (t.v === 'catch') {
      if (isOpTok(T[i - 1], '.')) { // promise.catch(() => {})
        const o = i + 1, c = op(o, '(') ? M[o] : -1;
        if (c > o && isOpTok(T[c - 1], '}') && M[c - 1] === c - 2 && (isOpTok(T[c - 3], '=>') || isOpTok(T[c - 3], ')'))) out.push({ i, line: t.l, end: T[c].l, type: '', what: 'The .catch() handler' });
        continue;
      }
      let j = i + 1, type = '';
      if (op(j, '(') && M[j] > j) { type = T.slice(j + 1, M[j]).map((x) => x.v).join(' '); j = M[j] + 1; }
      if (T[j] && T[j].k === 'kw' && T[j].v === 'when' && op(j + 1, '(') && M[j + 1] > j) j = M[j + 1] + 1;
      if (op(j, '{') && M[j] === j + 1) out.push({ i, line: t.l, end: T[j + 1].l, type, what: 'The catch block' });
    } else if (t.v === 'except' && F.lang === 'py') {
      let j = i + 1, type = '';
      while (j < b && j < i + 40 && !op(j, ':')) { if ((op(j, '(') || op(j, '[')) && M[j] > j) { type += `${T.slice(j, M[j] + 1).map((x) => x.v).join('')} `; j = M[j] + 1; } else type += `${T[j++].v} `; }
      if (!op(j, ':')) continue;
      let k = j + 1; const close = op(k, '{') && M[k] > k ? M[k++] : -1, stop = close >= 0 ? close : b;
      let empty = true, any = false;
      for (; k < stop; k++) { const u = T[k]; if (isOpTok(u, ';')) { if (close < 0) break; continue; } if ((u.k === 'kw' && u.v === 'pass') || isOpTok(u, '...')) { any = true; continue; } empty = false; break; }
      if (empty && any) out.push({ i, line: t.l, end: T[Math.min(k, T.length - 1)].l, type: type.trim(), what: 'The except block' });
    }
  }
  return out;
}

function debugAt(F, i) {
  const T = F.tokens, t = T[i], n = (k) => T[i + k], op = (k, v) => isOpTok(T[i + k], v);
  if (t.k !== 'id') return null;
  const dotted = isOpTok(T[i - 1], '.') || isOpTok(T[i - 1], '?.');
  if (isJsLike(F.lang)) {
    if (t.v === 'console' && !dotted && op(1, '.') && n(2) && /^(log|debug|trace)$/.test(n(2).v) && op(3, '(')) return `console.${n(2).v}`;
    if (t.v === 'debugger' && !dotted && !(n(1) && n(1).k === 'op' && '(.=:,'.includes(n(1).v))) return 'debugger';
  } else if (F.lang === 'cs') {
    if ((t.v === 'Console' || t.v === 'Debug') && op(1, '.') && n(2) && /^Write(Line)?$/.test(n(2).v) && op(3, '(')) return `${t.v}.${n(2).v}`;
  } else if (F.lang === 'py') {
    if ((t.v === 'print' || t.v === 'breakpoint') && !dotted && op(1, '(')) return t.v;
  } else if (F.lang === 'java') {
    if (t.v === 'System' && op(1, '.') && n(2) && n(2).v === 'out' && op(3, '.') && n(4) && /^print(ln|f)?$/.test(n(4).v)) return `System.out.${n(4).v}`;
  }
  return null;
}

const SCRIPT_DIR = /(^|\/)(bin|scripts?|tools?|cli|examples?|samples?|demos?|sandbox|playground|benchmarks?|bench|perf)\//i;
/** Code whose job is to write to the console: a program entry point or a script. */
function isProgram(F, firstLine) {
  if (SCRIPT_DIR.test(F.path) || /^#!/.test(firstLine || '')) return true;
  const name = px.basename(F.path), T = F.tokens;
  if (F.lang === 'cs') return /^Program\.cs$/i.test(name) || T.some((t, i) => t.k === 'id' && t.v === 'Main' && isOpTok(T[i + 1], '('));
  if (F.lang === 'py') return /^(__main__|manage|setup|conftest|fabfile|noxfile|tasks)\.py$/.test(name) || T.some((t) => t.k === 'id' && t.v === '__name__');
  if (F.lang === 'java') return F.symbols.some((s) => s.name === 'main');
  return /^(cli|bin)\.[cm]?[jt]sx?$/.test(name);
}

function sleepAt(F, i) {
  const T = F.tokens, t = T[i], op = (k, v) => isOpTok(T[i + k], v);
  if (t.k === 'id' && /^[Ss]leep$/.test(t.v) && op(1, '(')) {
    if ((isOpTok(T[i - 1], '.') || isOpTok(T[i - 1], '::')) && T[i - 2] && /^(Thread|time|thread)$/.test(T[i - 2].v)) return `${T[i - 2].v}.${t.v}`;
    if (F.lang === 'py' && !isOpTok(T[i - 1], '.') && (F.imports || []).some((m) => m.source === 'time' && (m.names || []).some((n) => n.local === 'sleep'))) return 'time.sleep';
  }
  if (t.k === 'kw' && t.v === 'await') {
    const a = T[i + 1], b = T[i + 2]; if (!a) return null;
    if (a.v === 'Task' && op(2, '.') && T[i + 3] && T[i + 3].v === 'Delay' && op(4, '(')) return 'await Task.Delay';
    if (!isJsLike(F.lang)) return null;
    if (a.v === 'new' && b && b.v === 'Promise' && op(3, '(') && F.match[i + 3] > 0 && F.match[i + 3] - i < 40) { for (let k = i + 4; k < F.match[i + 3]; k++) if (T[k].k === 'id' && T[k].v === 'setTimeout') return 'await new Promise(… setTimeout …)'; }
    if (a.k === 'id' && op(2, '(') && /^(setTimeout|sleep|delay|wait|pause)$/i.test(a.v)) return `await ${a.v}`;
  }
  return null;
}

function escapeAt(F, i) {
  const T = F.tokens, t = T[i], p = T[i - 1], n = T[i + 1], lang = F.lang;
  if (lang === 'ts' && t.k === 'kw' && p) {
    if (t.v === 'any') { if (p.k === 'kw' && p.v === 'as') return 'as any'; if (isOpTok(p, ':')) return ': any'; if (isOpTok(p, '<') && isOpTok(n, '>')) return '<any>'; }
    if (t.v === 'unknown' && p.v === 'as' && n && n.v === 'as') return 'as unknown as';
  }
  if (lang === 'cs') {
    if (t.k === 'kw' && t.v === 'dynamic' && n && (n.k === 'id' || (n.k === 'op' && '>,[])?'.includes(n.v)))) return 'dynamic';
    if (isOpTok(t, '(') && isOpTok(p, ')') && n && n.k === 'kw' && n.v === 'object' && isOpTok(T[i + 2], ')')) return 'a cast through object';
    if (t.k === 'id' && t.v === 'Unsafe' && isOpTok(n, '.') && T[i + 2] && T[i + 2].v === 'As') return 'Unsafe.As';
  }
  if ((lang === 'cs' || lang === 'ts') && isOpTok(t, '!') && p && n) { // postfix '!': an operand ends before it and none starts after it
    const ends = p.k === 'id' || p.k === 'str' || p.k === 'num' || (p.k === 'op' && (p.v === ')' || p.v === ']')) || (p.k === 'kw' && /^(this|null|default|base|true|false)$/.test(p.v));
    const goesOn = n.k === 'op' && ['.', ';', ')', ',', ']', '[', '?.', '??', '}', ':', '?', '==', '!=', '=>'].includes(n.v);
    if (ends && goesOn) return lang === 'cs' ? 'the null-forgiving operator !' : 'the non-null assertion !';
  }
  return null;
}

// Each directive is matched where its tool reads it: a preprocessor directive opens its line, an ESLint or
// TypeScript directive opens its comment. The same words in the middle of a sentence are prose about the directive.
const SWITCHED_OFF = [
  [/^\s*#\s*pragma\s+warning\s+disable\b[ \t]*([\w, ]*)/, ['cs', 'c'], (m) => `#pragma warning disable${m[1].trim() ? ` ${m[1].trim()}` : ''}`],
  [/^\s*#\s*nullable\s+disable\b/, ['cs'], () => '#nullable disable'],
  [/(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?\b[ \t]*[\w@/, -]*)/, ['js', 'ts'], (m) => m[1].trim()],
  [/(?:\/\/|\/\*)\s*(@ts-(?:ignore|nocheck))\b/, ['js', 'ts'], (m) => m[1]],
  [/#\s*noqa\b(?::\s*[\w, ]+)?/i, ['py'], (m) => m[0]],
  [/#\s*type:\s*ignore\b(\[[\w, -]+\])?/, ['py'], (m) => m[0]],
  [/#\s*pylint:\s*disable\b(=[\w, -]+)?/, ['py'], (m) => m[0]],
  [/\/\/\s*nolint\b/, ['go'], (m) => m[0]],
];

/**
 * practices(ctx) → Finding[]
 *
 * Only what this pull request wrote, in source files that are not tests: a line it added that did not merely move
 * within the file (same text removed elsewhere in the same file).
 *   practice.error-swallowed   warn  an empty catch block (comments are not code), an empty promise .catch handler,
 *                                    Python `except: pass`, when the enclosing symbol has more of them than at the base
 *   practice.secret            bad   a credential by its format (AWS access key id, JSON Web Token, bearer token,
 *                                    GitHub/Slack/Google/Stripe key, private key with key material), or a literal that
 *                                    looks generated assigned to a name ending in password, secret, token, api key or
 *                                    private key (not in fixture, mock, e2e or story files). Format rules also run on
 *                                    added lines of configuration files. No secret rule runs on documentation,
 *                                    example, sample or template files, which show what a key looks like.
 *   practice.debug-output      info  console.log/debug/trace and `debugger`, Console.Write(Line)/Debug.Write(Line),
 *                                    print(/breakpoint(, System.out.print* outside entry points, scripts and files
 *                                    that already printed at the merge base
 *   practice.unfinished-marker info  TODO, FIXME, HACK or XXX that opens a comment or carries a colon or an owner
 *                                    (`// TODO fix`, `TODO:`, `FIXME(ana)`), not the word inside a sentence
 *   practice.check-disabled    warn  #pragma warning disable, #nullable disable (opening their line), eslint-disable,
 *                                    @ts-ignore, @ts-nocheck (opening their comment), # noqa, # type: ignore,
 *                                    # pylint: disable, [SuppressMessage], @SuppressWarnings
 *   practice.type-escape       info  `as any`, `: any`, `as unknown as`, `dynamic`, a cast through object, Unsafe.As,
 *                                    the postfix `!` of C# and TypeScript
 *   practice.sleep             info  Thread.Sleep, time.sleep, an awaited bare timeout
 * Does not establish: that a credential is live (only that the text has its form or its name), that a swallowed
 * error matters, or that a marker is not deliberate. These are facts about the text, not judgements of the design.
 */
export function practices(ctx) {
  const P = prep(ctx), out = [];
  for (const d of P.diff) {
    if (d.status === 'deleted' || isTestFile(P, d)) continue;
    const file = d.path, A = P.added(file), moved = P.moved(file), F = P.head.get(file);
    const live = (l) => A.has(l) && !moved.has(l);
    const seen = new Set();
    const add = (id, severity, line, title, detail, basis) => { const k = `${id}\u0001${line}`; if (seen.has(k)) return; seen.add(k); out.push(mk(P, id, severity, file, line, title, detail, basis)); };
    const secret = (line, what, shown) => add('practice.secret', 'bad', line, 'Secret in the source', `${file}:${line} contains ${what}: ${shown}.`,
      'The added line matches the published format of that credential. Not established: that it is live; a revoked or sample key has the same form.');
    if (/\.(md|mdx|rst|txt|adoc|html?)$/i.test(file)) continue; // prose
    // Documentation and sample files show what a key looks like: no secret rule there. Every other rule still applies.
    const sample = /(example|sample|template)/i.test(px.basename(file)) || /(^|\/)(docs?|examples?|samples?)\//i.test(file);
    if (!sample) for (const [line, text] of A) { if (moved.has(line)) continue; const s = formatSecret(text, A.get(line + 1)); if (s) secret(line, s.what, s.shown); }

    if (!F || !F.lang) { // configuration and data files: names and values on the raw line
      if (sample || !/\.(env|json|ya?ml|toml|ini|properties|cfg|conf|config|tfvars)$|(^|\/)\.env[^/]*$/i.test(file) || /(^|\/)(package-lock\.json|[^/]*\.lock|[^/]*lock\.ya?ml)$/.test(file)) continue;
      for (const [line, text] of A) {
        if (moved.has(line) || text.length > 1000) continue;
        const m = /(?:^|[\s"'{,;])["']?([A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',;#]{8,})/.exec(text);
        if (m && !TEST_DATA.test(file) && SECRET_NAME.test(m[1]) && !NOT_SECRET.test(m[1]) && credentialLike(m[2]) && (!/token/i.test(m[1]) || (/\d/.test(m[2]) && /[A-Za-z]/.test(m[2])))) add('practice.secret', 'bad', line, 'Secret in the source',
          `${file}:${line} sets ${m[1]} to a literal value: ${mask(m[2])}.`, 'The key is named as a secret and its value is a literal with digits or symbols, not a placeholder or a reference. Not established: that it is a live credential.');
      }
      continue;
    }

    const T = F.tokens, bv = P.baseOf(file);
    const op = (i, v) => isOpTok(T[i], v);

    // Lines that lie inside a multi-line string: nothing on them is a comment.
    const inString = new Set();
    for (const t of T) if (t.k === 'str' && t.v.includes('\n')) { let n = 0; for (const ch of t.v) if (ch === '\n') inString.add(t.l + ++n); }
    /** The part of an added line that is not a token: comments and inert directives, exactly what the lexer drops. */
    const nonCode = (line, text) => {
      if (inString.has(line) || text.length > 2000) return ''; // a line that long is data or generated, not something a person annotated
      let rest = '', cur = 0;
      for (let i = firstAt(F, line); i < T.length && T[i].l === line; i++) { // the gaps between consecutive tokens
        let v = T[i].v; const nl = v.indexOf('\n'); if (nl >= 0) v = v.slice(0, nl);
        if (!v || (F.lang === 'py' && T[i].k === 'op' && (v === '{' || v === '}' || v === ';'))) continue; // layout tokens have no text
        const at = text.indexOf(v, cur); if (at < 0) continue;
        rest += `${text.slice(cur, at)} `; cur = at + v.length;
      }
      return rest + text.slice(cur);
    };
    for (const [line, text] of A) {
      if (moved.has(line)) continue;
      const rest = nonCode(line, text); if (!rest.trim()) continue;
      // A marker opens a comment (`// TODO fix`, `# FIXME`, ` * XXX`) or carries a colon or an owner (`TODO:`, `TODO(ana)`);
      // the same word inside a sentence ("the list of TODO, FIXME markers") is prose.
      const mk2 = /(?:^|\/\/+|\/\*+|#+|<!--|--)[\s*!]*@?(TODO|FIXME|HACK|XXX)\b(?![-,])|\b(TODO|FIXME|HACK|XXX)(?=\s*[:(])/.exec(rest);
      const mark = mk2 ? [mk2[0], mk2[1] || mk2[2]] : null, markAt = mk2 ? rest.indexOf(mark[1], mk2.index) : 0;
      if (mark) add('practice.unfinished-marker', 'info', line, 'Unfinished marker', `${file}:${line} adds a ${mark[1]} comment: "${clip(rest.slice(markAt).trim(), 80)}".`,
        'The marker is in a comment on a line this pull request added. Not established: whether the work it names is in scope.');
      for (const [re, langs, show] of SWITCHED_OFF) {
        const m = langs.includes(F.lang) ? re.exec(rest) : null;
        if (m) add('practice.check-disabled', 'warn', line, 'A check was switched off', `${file}:${line} adds ${show(m)}.`,
          'The directive is on a line this pull request added and tells a compiler, linter or type checker to stop reporting. Not established: whether the silenced report was a false alarm.');
      }
    }

    // Error handlers that hold no code, where the enclosing symbol has more of them than before.
    const cuts = d.hunks.filter((h) => h.removed.length && !h.added.length).map((h) => h.newStart);
    for (const c of swallows(F)) {
      let touched = cuts.some((l) => l >= c.line && l < c.end);
      for (let l = c.line; l <= c.end && !touched; l++) touched = live(l);
      if (!touched) continue;
      const s = ownerOf(F, c.i), sb = s && bv ? bv.F.symbols.find((x) => x.key === s.key) : null;
      const now = s ? swallows(F, s.a, s.b).length : swallows(F).length;
      const was = !bv ? 0 : s ? (sb ? swallows(bv.F, sb.a, sb.b).length : 0) : swallows(bv.F).length;
      if (now <= was) continue;
      add('practice.error-swallowed', 'warn', c.line, 'Error swallowed', `${c.what} at ${file}:${c.line} has no code, so ${c.type ? `what it catches (${clip(c.type, 50)})` : 'any error'} is discarded${s ? ` in ${s.qname}` : ''}.`,
        `The handler body holds no token (comments are not code), and ${s ? 'the symbol' : 'the file'} has ${now} such ${now === 1 ? 'handler' : 'handlers'} at head against ${was} at the merge base. Not established: whether ignoring the error is intended.`);
    }

    const program = lazy(() => isProgram(F, A.get(1)) || (!!bv && bv.F.tokens.some((_, i) => debugAt(bv.F, i))));
    const escapes = new Map();
    for (let i = 0; i < T.length; i++) {
      const t = T[i], line = t.l; if (!live(line)) continue;
      if (t.k === 'str') { // a literal assigned to a name that says it is a secret
        const v = unquote(t.v); if (v == null || !(op(i - 1, '=') || op(i - 1, ':') || op(i - 1, ':='))) continue;
        let nt = T[i - 2], name = null;
        if (nt && nt.k === 'str') name = unquote(nt.v);
        else if (op(i - 2, ']') && T[i - 3] && T[i - 3].k === 'str') name = unquote(T[i - 3].v);
        else if (isWord(nt)) name = op(i - 3, ':') && isWord(T[i - 4]) ? T[i - 4].v : nt.v; // name: Type = "…"
        if (!name || sample || TEST_DATA.test(file) || !SECRET_NAME.test(name) || NOT_SECRET.test(name) || !credentialLike(v)) continue;
        if (/token\d*$/i.test(name) && !(/\d/.test(v) && /[A-Za-z]/.test(v))) continue; // "token" also names lexer and paging tokens
        add('practice.secret', 'bad', line, 'Secret in the source', `${file}:${line} assigns a string literal to ${name}: ${mask(v)}.`,
          'The name says the value is a secret and the value is a literal with digits or symbols, not a placeholder, a path or a reference. Not established: that it is a live credential.');
        continue;
      }
      const dbg = debugAt(F, i);
      if (dbg && !program()) { add('practice.debug-output', 'info', line, dbg === 'debugger' || dbg === 'breakpoint' ? 'Debugger statement left in the code' : 'Debug output left in the code', `${file}:${line} adds ${dbg}${dbg === 'debugger' ? '' : '(…)'} to code that is not a program entry point or a script.`,
        'The call is on an added line, the file has no entry point and did not print at the merge base. Not established: that the output is unwanted.'); continue; }
      const sl = sleepAt(F, i);
      if (sl) { add('practice.sleep', 'info', line, 'Waiting by sleeping', `${file}:${line} adds ${sl}${sl.endsWith(')') ? '' : '(…)'} outside test code.`,
        'The call is on an added line of a non-test file. Not established: that a fixed delay is wrong here; it usually stands in for waiting on a condition.'); continue; }
      const esc = escapeAt(F, i);
      if (esc) { const e = escapes.get(line) || escapes.set(line, new Map()).get(line); e.set(esc, (e.get(esc) || 0) + 1); continue; }
      if (t.k === 'id' && /^(Unconditional)?SuppressMessage(Attribute)?$/.test(t.v) && F.lang === 'cs' && (op(i - 1, '[') || op(i - 1, ',') || op(i - 1, ':') || op(i - 1, '.'))) add('practice.check-disabled', 'warn', line, 'A check was switched off', `${file}:${line} adds [${t.v}${T[i + 2] && T[i + 2].k === 'str' && T[i + 4] && T[i + 4].k === 'str' ? `(${T[i + 2].v}, ${clip(T[i + 4].v, 50)})` : ''}].`,
        'The attribute is on a line this pull request added and tells the analyzers to stop reporting. Not established: whether the silenced report was a false alarm.');
      else if (t.k === 'id' && t.v === 'SuppressWarnings' && op(i - 1, '@')) add('practice.check-disabled', 'warn', line, 'A check was switched off', `${file}:${line} adds @SuppressWarnings.`,
        'The annotation is on a line this pull request added and tells the compiler to stop reporting. Not established: whether the silenced report was a false alarm.');
    }
    for (const [line, kinds] of escapes) {
      const what = [...kinds].map(([k, n]) => (n > 1 ? `${k} (${n} times)` : k)).join(', ');
      add('practice.type-escape', 'info', line, 'Type-safety escape added', `${file}:${line} adds ${what}.`,
        'The construct is on an added line and tells the type checker to accept something it cannot verify. Not established: that the value is wrong at run time.');
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── all of them

const CHECKS = [['unresolvedImports', unresolvedImports], ['arityMismatches', arityMismatches], ['danglingReferences', danglingReferences], ['testWeakening', testWeakening], ['practices', practices]];

/**
 * runChecks(ctx) → { findings, errors }
 * Every finding of every check, de-duplicated, sorted by severity (bad, warn, info), then file, line and rule.
 * Never throws: a check that fails contributes nothing and is named in `errors` ([{ check, message }]), so a
 * missing finding can be told apart from a check that did not run.
 */
export function runChecks(ctx) {
  const findings = [], errors = [], seen = new Set();
  for (const [name, fn] of CHECKS) {
    let list = [];
    try { list = fn(ctx) || []; } catch (e) { errors.push({ check: name, message: String((e && e.message) || e).slice(0, 300) }); }
    for (const f of list) { const k = [f.id, f.file, f.line, f.detail].join('\u0001'); if (!seen.has(k)) { seen.add(k); findings.push(f); } }
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || cmp(a.file, b.file) || a.line - b.line || cmp(a.id, b.id) || cmp(a.detail, b.detail));
  return { findings, errors };
}
