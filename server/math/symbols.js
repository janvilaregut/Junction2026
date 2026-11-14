// Symbols of one source file: the functions, methods, properties and types it declares, with exact token and
// line ranges, plus its imports and exports. Structural parsing over the lexer's tokens (brackets are matched,
// declaration heads are classified); no compiler, so it works on any ref straight from git and in milliseconds.
// What it does not know (overload resolution, inheritance across assemblies) is left unresolved, never guessed.
import { tokenize, matchBrackets, langOf, isJsLike } from './lex.js';

const TYPE_KW = new Set(['class', 'struct', 'interface', 'record', 'enum', 'trait', 'impl', 'protocol', 'extension', 'union', 'object']);
const FN_KW = new Set(['function', 'func', 'fn', 'fun', 'def']);
const CONTROL = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'using', 'lock', 'fixed', 'checked', 'unchecked', 'unsafe', 'when', 'with', 'match', 'select', 'loop', 'synchronized', 'guard', 'defer', 'elif', 'except', 'repeat', 'return', 'throw', 'case', 'default', 'get', 'set', 'init', 'add', 'remove', 'static']);
// Keywords that open a bare block only when nothing follows them (`get { }`, `static { }`); with more tokens they are modifiers.
const ALONE = new Set(['get', 'set', 'init', 'add', 'remove', 'static']);
const TEST_CALL = new Set(['describe', 'it', 'test', 'suite', 'context', 'specify', 'fdescribe', 'fit', 'xdescribe', 'xit']); // not `bench`: a benchmark asserts nothing
const TEST_GROUP = new Set(['describe', 'suite', 'context', 'fdescribe', 'xdescribe']);
const TEST_ATTR = /^(Fact|Theory|Test|TestMethod|TestCase|TestCaseSource|DataTestMethod|InlineData|MemberData|ClassData|CombinatorialData|ParameterizedTest|RepeatedTest)$/;
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|testing)\/|(Tests?|Spec)\.[a-z]+$|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;
const TYPED_BEFORE = new Set(['cs', 'java', 'c', 'dart']); // `Type name`: the parameter name is the last identifier
const ANGLE = new Set(['cs', 'java', 'ts', 'kt', 'c', 'rs', 'swift', 'dart', 'scala']);
const MODIFIER = new Set(['public', 'private', 'protected', 'internal', 'static', 'async', 'export', 'override', 'abstract', 'virtual', 'sealed', 'readonly', 'extern', 'partial', 'final', 'default', 'open', 'pub', 'unsafe', 'new', 'declare', 'suspend', 'inline']);

export const isTestPath = (p) => TEST_PATH.test(String(p));

/**
 * parseFile(text, path) → { path, lang, tokens, match, symbols, imports, exports, namespace, lines }
 * Symbol: { name, qname, kind, container, file, start, end, a, b, bodyA, bodyB, params, minParams, maxParams,
 *           paramNames, modifiers, attrs, exported, isTest, abstract }
 *   kind       'function' | 'method' | 'ctor' | 'property' | 'type'
 *   a, b       token range [a, b) of the whole declaration (attributes and modifiers included)
 *   bodyA/B    token range [bodyA, bodyB) of the body (braces included); equal when there is none
 */
export function parseFile(text, path, lang = langOf(path)) {
  const tokens = lang ? tokenize(text, lang) : [];
  const match = matchBrackets(tokens);
  const file = { path, lang, tokens, match, symbols: [], imports: [], exports: [], namespace: null, lines: String(text ?? '').split('\n').length };
  if (!lang) return file;
  const T = tokens, N = T.length, js = isJsLike(lang), testFile = isTestPath(path);
  const op = (i, v) => i >= 0 && i < N && T[i].k === 'op' && T[i].v === v;
  const kw = (i, v) => i >= 0 && i < N && T[i].k === 'kw' && T[i].v === v;
  const word = (i) => (i >= 0 && i < N && (T[i].k === 'id' || T[i].k === 'kw') ? T[i].v : null);
  const skip = (i) => (T[i].k === 'op' && (T[i].v === '(' || T[i].v === '[' || T[i].v === '{' || T[i].v === '${') && match[i] > i ? match[i] : i);

  /** Indices of the head's top-level tokens (bracket groups collapsed to their opening bracket). */
  const top = (a, b) => { const r = []; for (let i = a; i < b; i++) { r.push(i); i = skip(i); } return r; };
  /** The identifier just before index i, stepping back over one generic argument list `<...>`. */
  const nameBefore = (i, lo) => {
    let j = i - 1;
    if (op(j, '>') && ANGLE.has(lang)) { let d = 0; for (; j >= lo; j--) { if (op(j, '>')) d++; else if (op(j, '<')) { d--; if (!d) break; } } j--; }
    return j >= lo && (T[j].k === 'id' || T[j].k === 'kw') ? j : -1;
  };
  function params(open) {
    const close = match[open]; const names = []; let min = 0, max = 0, lastRequired = 0;
    if (close < 0 || close === open + 1) return { params: 0, minParams: 0, maxParams: 0, paramNames: names };
    let seg = [], angle = 0;
    const flush = () => {
      if (!seg.length) return;
      // Not parameters: Python's `/` and bare `*` markers, and TypeScript's `this` pseudo-parameter (a type annotation for `this`).
      if ((lang === 'py' && seg.length === 1 && (op(seg[0], '/') || op(seg[0], '*'))) || (lang === 'ts' && !names.length && kw(seg[0], 'this'))) { seg = []; return; }
      const eq = seg.findIndex((i) => op(i, '=')), body = eq < 0 ? seg : seg.slice(0, eq);
      const ids = body.filter((i) => T[i].k === 'id' || (T[i].k === 'kw' && (T[i].v === 'self' || T[i].v === 'this')));
      const rest = body.some((i) => op(i, '...') || kw(i, 'params') || (lang === 'py' && op(i, '*')) || (lang === 'py' && op(i, '**')));
      const optional = eq >= 0 || (js && body.some((i, k) => op(i, '?') && body[k + 1] != null && op(body[k + 1], ':')));
      const colon = body.findIndex((i) => op(i, ':'));
      let name = null;
      if (ids.length) name = TYPED_BEFORE.has(lang) || lang === 'go' && false ? T[ids[ids.length - 1]].v : colon > 0 ? word(body[colon - 1]) || T[ids[0]].v : lang === 'go' ? T[ids[0]].v : TYPED_BEFORE.has(lang) ? T[ids[ids.length - 1]].v : T[ids[0]].v;
      if (body.length && op(body[0], '{') || op(body[0], '[') && js) name = null; // destructuring: no single name
      if (lang === 'py' && (name === 'self' || name === 'cls') && !names.length && !max) { seg = []; return; }
      names.push(name); max++; if (!optional && !rest) { min++; lastRequired = names.length; } if (rest) max = Infinity;
      seg = [];
    };
    for (let i = open + 1; i < close; i++) {
      if (ANGLE.has(lang)) { if (op(i, '<')) angle++; else if (op(i, '>') && angle) angle--; }
      if (op(i, ',') && !angle) { flush(); continue; }
      seg.push(i); i = skip(i);
    }
    flush();
    // JavaScript and TypeScript bind arguments by position only, so a required parameter after one with a default
    // still has to be reached: `f(a, b = 1, c)` needs three arguments. Languages with named arguments count.
    return { params: names.length, minParams: js ? lastRequired : min, maxParams: max, paramNames: names };
  }
  const attrsOf = (a, b) => { // C#/Java/TS/Python attributes and decorators in front of a declaration
    const names = [];
    for (let i = a; i < b; i++) {
      if (op(i, '[') && lang === 'cs' && match[i] > i) { for (let j = i + 1; j < match[i]; j++) { if (T[j].k === 'id' && (op(j - 1, '[') || op(j - 1, ','))) names.push(T[j].v.replace(/Attribute$/, '')); j = skip(j); } i = match[i]; continue; }
      if (op(i, '@') && word(i + 1)) { // @name, @a.b.name, @name(args): the dotted name, then its arguments are skipped
        let j = i + 1; const parts = [T[j].v];
        while (op(j + 1, '.') && word(j + 2)) { parts.push(T[j + 2].v); j += 2; }
        names.push(parts.join('.'));
        if (op(j + 1, '(') && match[j + 1] > j) j = match[j + 1];
        i = j; continue;
      }
      if (T[i].k === 'kw' || T[i].k === 'id') break;
    }
    return names;
  };
  /** The first token of a declaration after its attributes and decorators. */
  const afterAttrs = (a, b) => {
    let i = a;
    while (i < b) {
      if (op(i, '[') && lang === 'cs' && match[i] > i) i = match[i] + 1;
      else if (op(i, '@') && word(i + 1)) { let j = i + 1; while (op(j + 1, '.') && word(j + 2)) j += 2; if (op(j + 1, '(') && match[j + 1] > j) j = match[j + 1]; i = j + 1; }
      else if (lang === 'py' && op(i, ';')) i++; // the end of a decorator's line
      else break;
    }
    return i;
  };

  function add(sym, ctx, a, b, bodyA, bodyB, open, single = null) {
    const attrs = attrsOf(a, b), mods = [];
    for (let i = afterAttrs(a, b); i < Math.min(b, bodyA > a ? bodyA : b); i++) {
      const w = word(i);
      if (w && MODIFIER.has(w)) mods.push(w);
      else if (js && (w === 'get' || w === 'set') && word(i + 1)) mods.push(w); // an accessor: `get size() {…}` is read like a property, not called
      if (op(i, '(')) break; i = skip(i);
    }
    const chain = ctx.chain || [];
    const p = open != null && open >= 0 ? params(open) : single ? { params: 1, minParams: 1, maxParams: 1, paramNames: [single] } : { params: 0, minParams: 0, maxParams: 0, paramNames: [] };
    const exported = mods.includes('export') || mods.includes('public') || mods.includes('pub') || (lang === 'go' && /^[A-Z]/.test(sym.name)) || (lang === 'py' && !sym.name.startsWith('_'));
    const s = {
      name: sym.name, qname: [...chain, sym.name].join('.'), kind: sym.kind, container: chain.length ? chain.join('.') : null, file: path,
      start: T[a].l, end: T[Math.max(a, b - 1)].l, a, b, bodyA, bodyB, ...p, modifiers: mods, attrs, exported,
      isTest: !!sym.isTest || attrs.some((x) => TEST_ATTR.test(x)) || (lang === 'py' && /^test_/.test(sym.name)) || (testFile && sym.kind !== 'type' && (lang === 'go' ? /^Test/.test(sym.name) : false)),
      abstract: bodyA === bodyB, ns: ctx.ns || file.namespace || null,
    };
    file.symbols.push(s);
    return s;
  }

  /** What the block opened at `open` is, judged from the tokens of its head [a, open). */
  function classify(a, open, ctx) {
    let h = top(a, open);
    // Attributes and decorators belong to the declaration but say nothing about its shape.
    while (h.length && ((op(h[0], '[') && lang === 'cs') || op(h[0], '@'))) { if (op(h[0], '@')) { h.shift(); if (h.length && word(h[0])) h.shift(); while (h.length && op(h[0], '.')) { h.shift(); h.shift(); } if (h.length && op(h[0], '(')) h.shift(); if (lang === 'py' && h.length && op(h[0], ';')) h.shift(); } else h.shift(); }
    if (lang === 'py' && h.length && op(h[h.length - 1], ':')) h.pop();
    if (!h.length) return { kind: 'block' };
    const first = h[0], last = h[h.length - 1];
    const firstParen = h.findIndex((i) => op(i, '('));
    const eqAt = h.findIndex((i) => op(i, '='));
    const find = (pred) => h.findIndex(pred);
    const nsAt = find((i) => kw(i, 'namespace') || (lang === 'rs' && kw(i, 'mod')) || (lang === 'ts' && kw(i, 'module') && T[i + 1]?.k === 'id'));
    if (nsAt >= 0 && (firstParen < 0 || nsAt < firstParen)) return { kind: 'ns', name: h.slice(nsAt + 1).filter((i) => T[i].k === 'id' || T[i].k === 'str').map((i) => T[i].v.replace(/['"]/g, '')).join('.') };
    const typeAt = find((i) => (T[i].k === 'kw' || T[i].k === 'id') && TYPE_KW.has(T[i].v) && !op(i - 1, '.') && !op(i - 1, ':') && !(T[i].v === 'object' && lang !== 'kt' && lang !== 'scala') && !(T[i].v === 'record' && lang !== 'cs' && lang !== 'java') && !(T[i].v === 'union' && lang !== 'c' && lang !== 'rs'));
    if (typeAt >= 0 && (firstParen < 0 || typeAt < firstParen) && (eqAt < 0 || typeAt < eqAt || js)) {
      let name = null;
      if (lang === 'go') name = word(h[typeAt - 1]);
      else if (lang === 'rs' && T[h[typeAt]].v === 'impl') { const forAt = find((i) => kw(i, 'for')); name = word(h[(forAt >= 0 ? forAt : typeAt) + 1]); }
      else for (let k = typeAt + 1; k < h.length; k++) { if (T[h[k]].k === 'id') { name = T[h[k]].v; break; } if (T[h[k]].k === 'kw' && !MODIFIER.has(T[h[k]].v) && !TYPE_KW.has(T[h[k]].v)) break; }
      if (!name && eqAt > 0) name = word(h[eqAt - 1]);
      return name ? { kind: 'type', name } : { kind: 'block' };
    }
    const fnAt = find((i) => T[i].k === 'kw' && FN_KW.has(T[i].v));
    const assigned = () => { // `name = …`, `name: …`, `exports.name = …`
      const at = find((i) => op(i, '=') || op(i, ':') || op(i, ':='));
      if (at > 0) { const w = nameBefore(h[at], a); if (w >= 0) return T[w].v; }
      return null;
    };
    if (fnAt >= 0 && (firstParen < 0 || fnAt < firstParen || eqAt >= 0)) {
      let k = fnAt + 1;
      if (lang === 'go' && h[k] != null && op(h[k], '(')) k++; // receiver
      while (h[k] != null && (op(h[k], '*') || kw(h[k], 'async'))) k++;
      const named = h[k] != null && (T[h[k]].k === 'id' || (T[h[k]].k === 'kw' && !FN_KW.has(T[h[k]].v))) && !op(h[k], '(') ? T[h[k]].v : null;
      const name = named || assigned() || (find((i) => kw(i, 'default')) >= 0 ? 'default' : null);
      const open2 = h.slice(k).find((i) => op(i, '('));
      return name ? { kind: 'fn', name, open: open2 } : { kind: 'block' };
    }
    if (op(last, '=>')) { // arrow function with a block body
      const name = assigned();
      const arrowParams = h.length >= 2 && op(h[h.length - 2], ')') ? match[h[h.length - 2]] : h.length >= 2 && op(h[h.length - 2], '(') ? h[h.length - 2] : -1;
      const open2 = h.slice().reverse().find((i) => op(i, '(') && i < last && (eqAt < 0 || i > h[eqAt]));
      const bare = open2 == null && arrowParams < 0 && h.length >= 2 && T[h[h.length - 2]].k === 'id' ? T[h[h.length - 2]].v : null; // name = x => { … }
      if (name) return { kind: 'fn', name, open: open2 ?? arrowParams, single: bare };
      return { kind: 'block' };
    }
    // A JavaScript class body or object literal holds members, never statements, and a member may be called
    // anything: `get(key) {…}`, `set(k, v) {…}`, `delete(k) {…}`, `with(x) {…}`. (A describe() callback is scanned as
    // a group but is an ordinary function body: statements there stay statements.)
    const member = js && (ctx.kind === 'obj' || (ctx.kind === 'type' && !ctx.group));
    const javaDefault = lang === 'java' && kw(first, 'default') && h.length > 2; // `default int size() {…}` in an interface
    if (T[first].k === 'kw' && CONTROL.has(T[first].v) && !(ALONE.has(T[first].v) && h.length > 1) && !javaDefault && !(member && firstParen === 1)) return { kind: 'block' };
    if (firstParen >= 0 && (eqAt < 0 || eqAt > firstParen)) {
      if (js && ctx.kind !== 'type' && ctx.kind !== 'obj') return { kind: 'block' }; // `name(args) {` is only a declaration inside a class or an object
      if (lang === 'py' || lang === 'go' || lang === 'rs' || lang === 'kt' || lang === 'swift' || lang === 'php') return { kind: 'block' }; // these always use a keyword
      const open2 = h[firstParen];
      if (kw(open2 - 1, 'operator') || kw(nameBefore(open2, a) - 1, 'operator')) return { kind: 'fn', name: 'operator' + (T[open2 - 1].k === 'op' ? T[open2 - 1].v : ''), open: open2 };
      const at = nameBefore(open2, a);
      if (at < 0) return { kind: 'block' };
      const name = T[at].v;
      if (T[at].k === 'kw' && !(member && at === first) && (CONTROL.has(name) || ['new', 'typeof', 'sizeof', 'nameof', 'await', 'base', 'this', 'function', 'super'].includes(name))) return { kind: 'block' };
      if (op(at - 1, '.') && !js) { // explicit interface implementation: IFoo.Bar(...)
        return { kind: 'fn', name, open: open2 };
      }
      if (op(at - 1, '.') || kw(at - 1, 'new')) return { kind: 'block' };
      return { kind: 'fn', name, open: open2, ctor: ctx.kind === 'type' && (name === ctx.name || name === 'constructor' || name === 'init') };
    }
    if (js && (op(last, '=') || op(last, ':') || kw(last, 'default') || op(last, '('))) { // object literal that may hold methods
      const name = op(last, '=') || op(last, ':') ? word(nameBefore(last, a)) : 'default';
      return name ? { kind: 'obj', name } : { kind: 'block' };
    }
    if ((lang === 'cs' || lang === 'kt' || lang === 'swift') && ctx.kind === 'type' && eqAt < 0) { // property or indexer with accessors
      if (T[last].k === 'id') return { kind: 'prop', name: T[last].v };
      if (op(last, '[') && kw(last - 1, 'this')) return { kind: 'prop', name: 'this[]' };
    }
    return { kind: 'block' };
  }

  /** A statement that ends in ';' with no block: an abstract or interface method, or an expression-bodied member. */
  function bodiless(a, end, ctx) {
    if (a >= end) return;
    const h = top(a, end);
    let s = 0; while (s < h.length && ((op(h[s], '[') && lang === 'cs') || op(h[s], '@'))) s += op(h[s], '@') ? 2 : 1;
    const hh = h.slice(s); if (!hh.length) return;
    if (kw(hh[0], 'namespace') && lang === 'cs') { file.namespace = hh.slice(1).filter((i) => T[i].k === 'id').map((i) => T[i].v).join('.'); return; }
    if (T[hh[0]].k === 'kw' && (CONTROL.has(T[hh[0]].v) && !['static'].includes(T[hh[0]].v) || ['import', 'using', 'package', 'export', 'from', 'use'].includes(T[hh[0]].v)) && !(js && kw(hh[0], 'export'))) return;
    const arrow = hh.findIndex((i) => op(i, '=>'));
    const eqAt = hh.findIndex((i) => op(i, '='));
    const firstParen = hh.findIndex((i) => op(i, '('));
    if (arrow > 0) {
      const before = hh.slice(0, arrow);
      if (eqAt >= 0 && eqAt < arrow) { // name = (args) => expr   |   name = arg => expr
        const at = nameBefore(hh[eqAt], a); if (at < 0 || op(at - 1, '.') && !js) return;
        const open = before.slice(eqAt + 1).find((i) => op(i, '('));
        const lastB = before[before.length - 1], bare = open == null && T[lastB].k === 'id' && lastB !== at ? T[lastB].v : null; // name = x => expr
        add({ name: T[at].v, kind: ctx.kind === 'type' ? 'method' : 'function' }, ctx, a, end + 1, hh[arrow] + 1, end, open ?? -1, bare);
        return;
      }
      if (ctx.kind !== 'type' || js) return;
      const pAt = before.findIndex((i) => op(i, '('));
      if (pAt >= 0) { const at = nameBefore(before[pAt], a); if (at >= 0 && !op(at - 1, '.')) add({ name: T[at].v, kind: T[at].v === ctx.name ? 'ctor' : 'method' }, ctx, a, end + 1, hh[arrow] + 1, end, before[pAt]); return; }
      const lastB = before[before.length - 1];
      if (T[lastB].k === 'id') add({ name: T[lastB].v, kind: 'property' }, ctx, a, end + 1, hh[arrow] + 1, end, -1);
      else if (op(lastB, '[') && kw(lastB - 1, 'this')) add({ name: 'this[]', kind: 'property' }, ctx, a, end + 1, hh[arrow] + 1, end, -1);
      return;
    }
    if (ctx.kind === 'type' && firstParen > 0 && eqAt < 0 && !js && lang !== 'py') { // declaration without a body
      const at = nameBefore(hh[firstParen], a);
      if (at < 0 || op(at - 1, '.') || kw(at - 1, 'new') || (T[at].k === 'kw' && CONTROL.has(T[at].v))) return;
      if (hh.some((i) => kw(i, 'return') || kw(i, 'throw') || kw(i, 'delegate') || kw(i, 'event'))) return;
      add({ name: T[at].v, kind: T[at].v === ctx.name ? 'ctor' : 'method' }, ctx, a, end + 1, end, end, hh[firstParen]);
    }
  }

  /** `describe('x', () => {…})`, `it('y', async () => {…})`, `router.get('/p', (req, res) => {…})`: a named callback. */
  function namedCallback(a, open, ctx) {
    if (!js || match[open] < 0) return false;
    let root = word(a); if (!root || (T[a].k === 'kw' && !TEST_CALL.has(root))) return false;
    for (let i = a + 1; i < open; i++) if (!(op(i, '.') || T[i].k === 'id' || T[i].k === 'kw')) return false;
    if (T[open + 1]?.k !== 'str') return false;
    const close = match[open]; let body = -1, popen = -1;
    for (let i = open + 1; i < close; i++) { if (op(i, '{') && (op(i - 1, '=>') || op(i - 1, ')'))) { body = i; break; } if (op(i, '(')) { popen = i; i = match[i] > i ? match[i] : i; continue; } i = skip(i); }
    if (body < 0 || match[body] < 0) return false;
    const label = T[open + 1].v.replace(/^[`'"]|[`'"]$/g, '').slice(0, 80);
    const callee = T.slice(a, open).map((t) => t.v).join('');
    const isTest = TEST_CALL.has(root);
    if (TEST_GROUP.has(root)) { scan(body + 1, match[body], { kind: 'type', name: label, chain: [...(ctx.chain || []), label], group: true, ns: ctx.ns }); return true; }
    add({ name: isTest ? label : `${callee} ${label}`, kind: 'function', isTest }, ctx, a, close + 1, body, match[body] + 1, popen);
    return true;
  }

  function scan(lo, hi, ctx) {
    let i = lo, stmt = lo;
    while (i < hi) {
      const t = T[i];
      if (t.k === 'pp') { if (stmt === i) stmt = i + 1; i++; continue; }
      if (t.k === 'op') {
        if (t.v === '(' && match[i] > i) {
          if (namedCallback(stmt, i, ctx)) { i = match[i] + 1; if (op(i, ';')) i++; stmt = i; continue; }
          i = match[i] + 1; continue;
        }
        if ((t.v === '[' || t.v === '${') && match[i] > i) { i = match[i] + 1; continue; }
        if (t.v === '{') {
          const close = match[i] > i ? match[i] : Math.max(i, hi - 1); // an unclosed block runs to the end of its container
          const d = classify(stmt, i, ctx), chain = ctx.chain || [];
          if (d.kind === 'ns') scan(i + 1, close, { kind: 'ns', name: d.name, chain, ns: [ctx.ns, d.name].filter(Boolean).join('.') });
          else if (d.kind === 'type') { add({ name: d.name, kind: 'type' }, ctx, stmt, close + 1, i, close + 1, -1); scan(i + 1, close, { kind: 'type', name: d.name, chain: [...chain, d.name], ns: ctx.ns }); }
          else if (d.kind === 'obj') scan(i + 1, close, { kind: 'obj', name: d.name, chain: [...chain, d.name], ns: ctx.ns });
          else if (d.kind === 'fn') add({ name: d.name, kind: d.ctor ? 'ctor' : ctx.kind === 'type' || ctx.kind === 'obj' ? 'method' : 'function' }, ctx, stmt, close + 1, i, close + 1, d.open ?? -1, d.single || null);
          else if (d.kind === 'prop') add({ name: d.name, kind: 'property' }, ctx, stmt, close + 1, i, close + 1, -1);
          i = close + 1;
          // `const f = () => {…};`, `x: function () {…},` and `{ get; } = value;` end here.
          if (op(i, '=') && d.kind === 'prop') { while (i < hi && !op(i, ';')) i = skip(i) + 1; }
          if (op(i, ';') || (op(i, ',') && ctx.kind === 'obj')) i++;
          if (d.kind !== 'block' || op(i - 1, ';') || ctx.kind !== 'file' || !js) stmt = i; else stmt = i;
          continue;
        }
        if (t.v === ';' && lang === 'py' && op(stmt, '@')) { i++; continue; } // a decorator's line: it belongs to the def or class that follows
        if (t.v === ';') { bodiless(stmt, i, ctx); stmt = i + 1; }
        else if (t.v === ',' && ctx.kind === 'obj') stmt = i + 1;
        else if (t.v === '}') stmt = i + 1;
        else if (t.v === ':' && lang === 'cs' && ctx.kind === 'type' && i === stmt + 1 && T[stmt].k === 'kw') stmt = i + 1; // not a label; keep heads clean
      }
      i++;
    }
  }
  scan(0, N, { kind: 'file', name: null, chain: [] });

  // Overloads share a qualified name: tell them apart by arity, then by order.
  const seen = new Map();
  for (const s of file.symbols) { const k = s.qname; seen.set(k, (seen.get(k) || 0) + 1); }
  const used = new Map();
  for (const s of file.symbols) {
    if (seen.get(s.qname) > 1 && s.kind !== 'type') {
      let k = `${s.qname}/${s.params}`; const n = (used.get(k) || 0) + 1; used.set(k, n);
      s.key = n > 1 ? `${k}#${n}` : k;
    } else s.key = s.qname;
    s.id = `${path}::${s.key}`;
  }
  readImports(file);
  return file;
}

/** Imports and exports, read from the file's top-level statements. */
function readImports(file) {
  const { tokens: T, match, lang } = file, N = T.length;
  const op = (i, v) => i >= 0 && i < N && T[i].k === 'op' && T[i].v === v;
  const kw = (i, v) => i >= 0 && i < N && T[i].k === 'kw' && T[i].v === v;
  const str = (i) => (i >= 0 && i < N && T[i].k === 'str' ? T[i].v.replace(/^[`'"]|[`'"]$/g, '') : null);
  const js = isJsLike(lang);
  let depth = 0;
  const isWord = (i) => i >= 0 && i < N && (T[i].k === 'id' || T[i].k === 'kw');
  const group = (i) => ((op(i, '{') || op(i, '(') || op(i, '[') || op(i, '${')) && match[i] > i ? match[i] : i);
  /** The entries of `{ a, b as c, d: e, 'x-y' as z, h: { nested }, k = 1, type T, ...rest, get m() {…} }`, one per top-level comma. */
  const names = (a, b) => {
    const out = [];
    for (let i = a + 1; i < b;) {
      let end = i; while (end < b && !op(end, ',')) end = group(end) + 1;
      let j = i;
      const rest = op(j, '...');
      if (isWord(j) && T[j].v === 'type' && j + 1 < end && (isWord(j + 1) || T[j + 1].k === 'str') && T[j + 1].v !== 'as') j++; // `type T`: a type-only entry
      while (isWord(j) && ['get', 'set', 'async', 'static'].includes(T[j].v) && j + 1 < end && (isWord(j + 1) || op(j + 1, '*'))) j++; // a method of an object literal
      if (op(j, '*')) j++;
      if (!rest && j < end && (isWord(j) || T[j].k === 'str')) {
        const imported = T[j].k === 'str' ? str(j) : T[j].v; let local = imported;
        if ((kw(j + 1, 'as') || op(j + 1, ':')) && j + 2 < end && (isWord(j + 2) || T[j + 2].k === 'str')) local = T[j + 2].k === 'str' ? str(j + 2) : T[j + 2].v;
        out.push({ imported, local });
      }
      i = end + 1;
    }
    return out;
  };
  for (let i = 0; i < N; i++) {
    const t = T[i];
    if (t.k === 'op') { if (t.v === '{' || t.v === '(' || t.v === '[' || t.v === '${') depth++; else if (t.v === '}' || t.v === ')' || t.v === ']') depth--; } // `${` opens a template hole that `}` closes
    if (js) {
      // Only a literal specifier names a module: `require('./locales/' + name)` and import(`./plugins/${id}.js`) are left unresolved.
      if (t.k === 'id' && t.v === 'require' && op(i + 1, '(') && str(i + 2) != null && op(i + 3, ')')) {
        const imp = { source: str(i + 2), line: t.l, names: [], default: null, ns: null };
        if (op(i - 1, '=')) { if (op(i - 2, '}') && match[i - 2] >= 0) imp.names = names(match[i - 2], i - 2); else if (T[i - 2]?.k === 'id') imp.ns = imp.default = T[i - 2].v; }
        file.imports.push(imp); continue;
      }
      if (t.k === 'kw' && t.v === 'import' && depth === 0) {
        if (op(i + 1, '(')) { if (str(i + 2) != null && (op(i + 3, ')') || op(i + 3, ','))) file.imports.push({ source: str(i + 2), line: t.l, names: [], default: null, ns: null, dynamic: true }); continue; }
        const imp = { source: null, line: t.l, names: [], default: null, ns: null };
        let j = i + 1;
        for (; j < N && !op(j, ';') && T[j].l <= t.l + 40; j++) {
          if (T[j].k === 'str') { imp.source = str(j); break; }
          if (op(j, '{') && match[j] > j) { imp.names.push(...names(j, match[j])); j = match[j]; continue; }
          if (op(j, '*') && kw(j + 1, 'as')) { imp.ns = T[j + 2]?.v; j += 2; continue; }
          if (T[j].k === 'id' && !imp.default && !kw(j - 1, 'as')) imp.default = T[j].v;
        }
        if (imp.source != null) file.imports.push(imp);
        i = j; continue;
      }
      if (t.k === 'kw' && t.v === 'export' && depth === 0) {
        let j = i + 1;
        if (kw(j, 'default')) { file.exports.push('default'); j++; }
        while (kw(j, 'async') || kw(j, 'declare') || kw(j, 'abstract')) j++;
        if (op(j, '*')) { let k = j; while (k < N && T[k].k !== 'str' && !op(k, ';')) k++; if (str(k) != null) file.imports.push({ source: str(k), line: t.l, names: [], default: null, ns: '*', reexport: true }); continue; }
        if (op(j, '{') && match[j] > j) {
          const list = names(j, match[j]); file.exports.push(...list.map((n) => n.local));
          if (kw(match[j] + 1, 'from') && str(match[j] + 2) != null) file.imports.push({ source: str(match[j] + 2), line: t.l, names: list, default: null, ns: null, reexport: true });
          continue;
        }
        if (kw(j, 'function') || kw(j, 'class') || kw(j, 'const') || kw(j, 'let') || kw(j, 'var') || kw(j, 'enum') || kw(j, 'interface') || kw(j, 'type') || kw(j, 'namespace')) {
          let k = j + 1; if (op(k, '*')) k++;
          if (T[k]?.k === 'id') file.exports.push(T[k].v);
          else if (op(k, '{') && match[k] > k) file.exports.push(...names(k, match[k]).map((n) => n.local));
          if (kw(j, 'const') || kw(j, 'let') || kw(j, 'var')) { // the other declarators: `export const a = 1, b = 2`
            const STOP = new Set(['export', 'import', 'const', 'let', 'var', 'class', 'if', 'for', 'while', 'return', 'switch', 'try', 'throw', 'do']);
            for (let m = group(k) + 1; m < N && !op(m, ';') && !(T[m].k === 'kw' && STOP.has(T[m].v)); m = group(m) + 1) {
              if (!op(m, ',')) continue;
              if (T[m + 1]?.k === 'id' && (op(m + 2, '=') || op(m + 2, ':') || op(m + 2, ',') || op(m + 2, ';') || m + 2 >= N)) file.exports.push(T[m + 1].v);
              else if (op(m + 1, '{') && match[m + 1] > m && op(match[m + 1] + 1, '=')) file.exports.push(...names(m + 1, match[m + 1]).map((n) => n.local));
            }
          }
        }
        continue;
      }
      if ((t.k === 'id' || t.k === 'kw') && (t.v === 'exports' || (t.v === 'module' && op(i + 1, '.') && T[i + 2]?.v === 'exports')) && depth === 0 && !op(i - 1, '.')) {
        const j = t.v === 'module' ? i + 3 : i + 1;
        if (op(j, '.') && T[j + 1]?.k === 'id') file.exports.push(T[j + 1].v);
        else if (op(j, '=') && op(j + 1, '{') && match[j + 1] > j) file.exports.push(...names(j + 1, match[j + 1]).map((n) => n.imported));
        else if (op(j, '=') && T[j + 1]?.k === 'id') file.exports.push('default', T[j + 1].v);
      }
      continue;
    }
    if (lang === 'cs' && t.k === 'kw' && t.v === 'using' && !op(i + 1, '(') && !kw(i + 1, 'var') && (i === 0 || op(i - 1, ';') || op(i - 1, '{') || op(i - 1, '}') || T[i - 1].k === 'pp' || kw(i - 1, 'global'))) {
      let j = i + 1, parts = [], alias = null, generic = false, wordBefore = false; if (kw(j, 'static')) j++;
      for (; j < N && !op(j, ';'); j++) {
        const isName = T[j].k === 'id' || T[j].k === 'kw';
        // `using IDisposable d = x;` inside a body declares a variable: two names in a row, or more than one name
        // before `=`, is never a using directive.
        if (generic) continue; // the type arguments of an aliased generic type: the alias points at the type before them
        if ((isName && wordBefore) || (op(j, '=') && (alias != null || parts.length !== 1))) { parts = []; break; }
        wordBefore = isName;
        if (op(j, '=')) { alias = parts.join('.'); parts = []; }
        else if (isName) parts.push(T[j].v);
        else if (alias != null && op(j, '<')) generic = true;
        else if (op(j, '::')) parts = []; // `v2::Acme.App`, `global::System`: what precedes `::` is an alias qualifier, not part of the namespace
        else if (!op(j, '.')) { parts = []; break; }
      }
      if (parts.length && op(j, ';')) file.imports.push({ source: parts.join('.'), line: t.l, names: [], default: null, ns: alias });
      i = j; continue;
    }
    if (lang === 'py' && t.k === 'kw' && (t.v === 'import' || t.v === 'from') && (i === 0 || op(i - 1, ';') || op(i - 1, '{') || op(i - 1, '}'))) {
      let j = i + 1, src = '';
      if (t.v === 'from') { for (; j < N && !kw(j, 'import') && !op(j, ';'); j++) src += T[j].v; j++; }
      const imp = { source: src, line: t.l, names: [], default: null, ns: null };
      let cur = '';
      for (; j < N && !op(j, ';'); j++) {
        if (op(j, '(') || op(j, ')')) continue;
        if (op(j, ',')) { if (cur) (t.v === 'from' ? imp.names.push({ imported: cur, local: cur }) : file.imports.push({ source: cur, line: t.l, names: [], default: null, ns: cur.split('.')[0] })); cur = ''; continue; }
        if (kw(j, 'as') && T[j + 1]) { if (t.v === 'from') imp.names.push({ imported: cur, local: T[j + 1].v }); else file.imports.push({ source: cur, line: t.l, names: [], default: null, ns: T[j + 1].v }); cur = ''; j++; continue; }
        cur += T[j].v;
      }
      if (cur) (t.v === 'from' ? imp.names.push({ imported: cur, local: cur }) : file.imports.push({ source: cur, line: t.l, names: [], default: null, ns: cur.split('.')[0] }));
      if (t.v === 'from') file.imports.push(imp);
      i = j; continue;
    }
    if ((lang === 'java' || lang === 'kt' || lang === 'scala' || lang === 'dart') && t.k === 'kw' && t.v === 'import' && depth === 0) {
      let j = i + 1, src = ''; for (; j < N && !op(j, ';') && T[j].l === t.l; j++) src += T[j].k === 'str' ? str(j) : T[j].v;
      file.imports.push({ source: src.replace(/^static/, ''), line: t.l, names: [], default: null, ns: null }); i = j; continue;
    }
    if (lang === 'go' && t.k === 'kw' && t.v === 'import') {
      const end = op(i + 1, '(') && match[i + 1] > i ? match[i + 1] : i + 3;
      for (let j = i + 1; j <= end && j < N; j++) if (T[j].k === 'str') file.imports.push({ source: str(j), line: T[j].l, names: [], default: null, ns: T[j - 1]?.k === 'id' ? T[j - 1].v : str(j).split('/').pop() });
      i = end; continue;
    }
  }
}

/** The innermost declared function, method or property that contains a line; a type if nothing smaller does. */
export function symbolAt(file, line) {
  let best = null;
  for (const s of file.symbols) {
    if (line < s.start || line > s.end) continue;
    if (!best) { best = s; continue; }
    const tighter = s.end - s.start <= best.end - best.start;
    if ((best.kind === 'type' && s.kind !== 'type') || (tighter && !(s.kind === 'type' && best.kind !== 'type'))) best = s;
  }
  return best;
}

/** Body tokens of a symbol (for metrics, fingerprints and proofs). */
export const bodyTokens = (file, s) => file.tokens.slice(s.bodyA, s.bodyB);
export const declTokens = (file, s) => file.tokens.slice(s.a, s.b);
