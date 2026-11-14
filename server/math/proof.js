// Proofs that an edit cannot change behaviour. This is the only place Katse says "proved", so the rule of the
// module is: when in doubt, refuse. A missed proof costs a review; a wrong proof costs the product.
//
//   identical   The two versions have the same significant token stream: only comments and layout changed, so
//               the compiler is given the same program (ECMA-262 §12 and C# §6.3: comments and white space
//               separate tokens and are otherwise discarded). In JavaScript, TypeScript and Go a line break can
//               end a statement (automatic semicolon insertion), so line breaks are compared wherever one
//               could: see `breaks` below. Python layout is already tokens. In Kotlin, Swift, Scala and Ruby
//               line structure is compared exactly.
//   alpha       The versions differ only by a consistent, one-to-one renaming of variables that are bound
//               inside the function, with no capture: alpha-conversion preserves meaning (Barendregt, The
//               Lambda Calculus, 1984). Checked syntactically and conservatively, for the brace languages
//               only (JavaScript, TypeScript, C#, Java); every condition is listed at `provesAlpha`.
//
// What a proof here does NOT cover, and the interface must not claim: bugs that were already in the base
// version are preserved, not fixed; code that reads its own source text or line numbers (Function.prototype
// .toString, stack traces, [CallerLineNumber], __LINE__) can observe a layout change; reflection on local
// names cannot be seen; and a change to build configuration in the same pull request can change what a
// preprocessor selects (the caller withdraws the proof in that case).
import { tokenize, isJsLike } from './lex.js';

const ASI = new Set(['js', 'ts', 'go']);            // a line break can end a statement
const LINE_STRICT = new Set(['kt', 'swift', 'scala', 'rb']); // newline-terminated statements: compare line structure exactly
const ALPHA = new Set(['js', 'ts', 'cs', 'java']);
// After one of these a line break never ends anything: the statement cannot be complete yet.
const NEVER_ENDS = new Set(['else', 'do', 'try', 'finally', 'typeof', 'new', 'void', 'delete', 'in', 'of', 'instanceof', 'case', 'extends', 'const', 'var', 'function', 'class', 'import', 'export', 'if', 'for', 'while', 'switch', 'catch', 'with', 'func', 'package', 'type', 'struct', 'interface', 'map', 'chan', 'select', 'range', 'go', 'defer']);
// A token that can only continue the expression before it, never start a statement.
const CONTINUES = new Set(['.', '?.', ',', ';', ')', ']', '}', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||', '??', '?', ':', '*', '%', '|', '&', '^', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**', '**=', '??=', '&&=', '||=', '<<', '>>', '>>>', '=>', ':=']);
const CONTINUES_KW = new Set(['else', 'catch', 'finally', 'in', 'instanceof', 'of', 'as', 'extends', 'implements', 'from']);

/** Tokens without line breaks, plus for each gap whether a significant line break sits in it. */
function stream(text, lang) {
  const raw = tokenize(text, lang, { nl: ASI.has(lang) || LINE_STRICT.has(lang) });
  const T = [], gap = [];
  let nl = false;
  for (const t of raw) {
    if (t.k === 'nl') { nl = true; continue; }
    if (T.length) gap.push(nl && breaks(T[T.length - 1], t, lang));
    T.push(t); nl = false;
  }
  return { T, gap };
}
/**
 * Can a line break between tokens p and n change how the code parses?
 * ECMA-262 §12.10: a semicolon is inserted at a line break when the next token cannot continue the statement,
 * and always after `return`, `throw`, `break`, `continue`, `yield`, before a postfix `++`/`--` and before `=>`.
 * The answer is "no" only when p cannot be the end of a statement, or n can do nothing but continue one. Every
 * other break is kept, so joining or splitting statements that rely on automatic semicolons is never certified.
 * Go inserts a semicolon after any line's final identifier, literal, `)`, `]`, `}`, `++`, `--` or `return`-like
 * keyword, whatever follows: there only p decides.
 */
function breaks(p, n, lang) {
  if (LINE_STRICT.has(lang)) return true;
  const canEnd = p.k === 'id' || p.k === 'num' || p.k === 'str' || (p.k === 'kw' && !NEVER_ENDS.has(p.v)) || (p.k === 'op' && (p.v === ')' || p.v === ']' || p.v === '}' || p.v === '++' || p.v === '--'));
  if (!canEnd) return false;
  if (lang === 'go') return true;
  if (n.k === 'op' && CONTINUES.has(n.v) && n.v !== '=>') return false; // `=>` after a break is a syntax error: keep it visible
  if (n.k === 'kw' && CONTINUES_KW.has(n.v)) return false;
  return true;
}
const same = (a, b) => a.k === b.k && a.v === b.v;
const where = (t) => `line ${t.l}`;

function firstDifference(A, B) {
  const n = Math.min(A.T.length, B.T.length);
  for (let i = 0; i < n; i++) {
    if (!same(A.T[i], B.T[i])) return { i, text: `${where(B.T[i])}: \`${A.T[i].v.slice(0, 40)}\` became \`${B.T[i].v.slice(0, 40)}\`` };
    if (i < n - 1 && A.gap[i] !== B.gap[i]) return { i, text: `${where(B.T[i])}: a line break after \`${B.T[i].v.slice(0, 30)}\` was ${B.gap[i] ? 'added' : 'removed'} where it can end a statement` };
  }
  if (A.T.length !== B.T.length) return { i: n, text: `${A.T.length < B.T.length ? `${B.T.length - A.T.length} tokens were added` : `${A.T.length - B.T.length} tokens were removed`} at the end` };
  return null;
}

/**
 * proveEquivalent(oldText, newText, lang) → { proved, level, claim, renames, why }
 * level 'identical' | 'alpha' | null. `claim` is a sentence that is literally true; `why` says where the first
 * difference is when nothing is proved.
 */
export function proveEquivalent(oldText, newText, lang, { alpha: allowAlpha = true } = {}) {
  const none = (why) => ({ proved: false, level: null, claim: null, renames: null, why });
  if (!lang) return none('not a language the engine reads');
  let A, B;
  try { A = stream(oldText, lang); B = stream(newText, lang); } catch { return none('could not be tokenised'); }
  if (!A.T.length || !B.T.length) return none(A.T.length === B.T.length ? 'no code on either side' : 'one side has no code');
  const diff = firstDifference(A, B);
  if (!diff) return { proved: true, level: 'identical', claim: 'Same tokens as before: only comments and layout changed, so the compiler is given the same program.', renames: null, why: null };
  const alpha = allowAlpha ? provesAlpha(A, B, lang) : { proved: false, candidate: false };
  if (alpha.proved) {
    const list = alpha.renames.map(([o, n]) => `${o} → ${n}`).join(', ');
    return { proved: true, level: 'alpha', claim: `Identical up to renaming ${alpha.renames.length === 1 ? 'one local variable' : `${alpha.renames.length} local variables`} (${list}): renaming a bound variable consistently, with no capture, cannot change behaviour.`, renames: alpha.renames, why: null };
  }
  return none(alpha.why && alpha.candidate ? alpha.why : diff.text);
}

const TYPE_KW = new Set(['var', 'int', 'string', 'bool', 'double', 'float', 'long', 'char', 'byte', 'object', 'decimal', 'dynamic', 'short', 'uint', 'ulong', 'ushort', 'sbyte', 'boolean', 'final']);
const DYNAMIC = new Set(['eval', 'Function', 'arguments']);

/**
 * Alpha-equivalence, checked on tokens. Proved only when ALL of these hold:
 *  1. Same number of tokens, same significant line breaks, and every position that differs holds an identifier
 *     on both sides.
 *  2. The old → new mapping is a function applied at EVERY occurrence, and it is one-to-one.
 *  3. Freshness: no new name occurs anywhere in the old version and no old name survives in the new one, so a
 *     rename cannot capture or be captured by another variable.
 *  4. No occurrence of a renamed name is anything but a plain variable: not a member (after . ?. -> ::), not a
 *     label, object key, named argument or type-annotated member (before ':', unless declared with
 *     let/const/var), not an object or destructuring shorthand ({ x }, { x, …}, { x = 1 }), not inside
 *     nameof(…). String contents are tokens, so a name inside a string or template text is not renamed.
 *  5. Every renamed name is bound INSIDE the snippet by a simple binder, and every occurrence lies in that
 *     binder's scope: `let|const|var x` (JS/TS), `Type x` / `var x` (C#, Java) — scope: the enclosing block —
 *     or a binder inside parentheses (for/foreach/catch/using headers, lambda parameters) — scope: the block
 *     that follows the parentheses. Names bound only by destructuring, function declarations or class
 *     members are refused.
 *  6. The function's own parameters are renamed only where callers cannot bind by name (JavaScript,
 *     TypeScript, Java). In C# a parameter name is part of the call contract (named arguments). TypeScript
 *     constructor parameter properties (private x) are fields: refused.
 *  7. Nothing in the snippet can look a name up dynamically: eval, new Function, `with`, `arguments`.
 */
export function provesAlpha(A, B, lang) {
  const no = (why, candidate = true) => ({ proved: false, why, candidate });
  if (!ALPHA.has(lang)) return no('renaming is only certified for JavaScript, TypeScript, C# and Java', false);
  const T = A.T, U = B.T, n = T.length;
  if (n !== U.length) return no('the token count changed', false);
  const map = new Map(), inv = new Map();
  let differs = 0;
  for (let i = 0; i < n; i++) {
    if (i < n - 1 && A.gap[i] !== B.gap[i]) return no('a significant line break changed', false);
    if (same(T[i], U[i])) continue;
    if (T[i].k !== 'id' || U[i].k !== 'id') return no(`${where(U[i])}: \`${T[i].v.slice(0, 30)}\` became \`${U[i].v.slice(0, 30)}\`, which is not a renaming`, false);
    differs++;
    if (map.has(T[i].v) && map.get(T[i].v) !== U[i].v) return no(`\`${T[i].v}\` is renamed to two different names`);
    if (inv.has(U[i].v) && inv.get(U[i].v) !== T[i].v) return no(`two names are renamed to \`${U[i].v}\``);
    map.set(T[i].v, U[i].v); inv.set(U[i].v, T[i].v);
  }
  if (!differs) return no('no difference', false);
  const js = isJsLike(lang);
  // 2. applied at every occurrence; 3. freshness; 7. dynamic lookup
  for (let i = 0; i < n; i++) {
    const t = T[i], u = U[i];
    if (t.k === 'id' && map.has(t.v) && u.v !== map.get(t.v)) return no(`\`${t.v}\` is renamed in some places and not in others`);
    if (t.k === 'id' && inv.has(t.v)) return no(`the new name \`${t.v}\` already exists in the old version: the renaming could capture it`);
    if (u.k === 'id' && map.has(u.v)) return no(`the old name \`${u.v}\` still exists in the new version`);
    if ((t.k === 'id' || t.k === 'kw') && (DYNAMIC.has(t.v) || (t.v === 'with' && js))) return no(`the function uses \`${t.v}\`, which can look names up at run time`);
  }
  // Blocks: for every token the chain of enclosing brace blocks, and the first parenthesis group of the snippet (its own parameters).
  const open = [], blockOf = new Int32Array(n).fill(-1), endOf = new Map(), parenOf = new Int32Array(n).fill(-1), parenEnd = new Map();
  const pst = [];
  for (let i = 0; i < n; i++) {
    const t = T[i];
    blockOf[i] = open.length ? open[open.length - 1] : -1; parenOf[i] = pst.length ? pst[pst.length - 1] : -1;
    if (t.k !== 'op') continue;
    if (t.v === '{' || t.v === '${') open.push(i);
    else if (t.v === '}') { const o = open.pop(); if (o != null) endOf.set(o, i); }
    else if (t.v === '(' || t.v === '[') pst.push(i);
    else if (t.v === ')' || t.v === ']') { const o = pst.pop(); if (o != null) parenEnd.set(o, i); }
  }
  // The function's own parameter list: the first top-level `name ( … )` that is followed by a body, an arrow or a
  // return type. A call or an `if (…)` at the start of the snippet is not a signature, so nothing in it is a binder.
  let sig = -1; for (let i = 0; i < n; i++) if (T[i].k === 'op' && T[i].v === '(' && blockOf[i] === -1 && parenOf[i] === -1) { sig = i; break; } else if (T[i].k === 'op' && (T[i].v === '{' || T[i].v === '=')) break;
  let sigEnd = sig >= 0 ? parenEnd.get(sig) ?? -1 : -1;
  const CONTROL = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'fixed', 'return', 'await', 'new', 'typeof', 'sizeof', 'throw', 'with']);
  const named = sig > 0 && (T[sig - 1].k === 'id' || (T[sig - 1].k === 'kw' && !CONTROL.has(T[sig - 1].v)) || (T[sig - 1].k === 'op' && T[sig - 1].v === '>'));
  const after = sigEnd >= 0 ? T[sigEnd + 1] : null;
  if (!named || !after || !(after.k === 'op' && (after.v === '{' || after.v === '=>' || after.v === ':')) && !(after.k === 'kw' && (after.v === 'throws' || after.v === 'where'))) { sig = -1; sigEnd = -1; }
  // In JavaScript `name(x)` + line break + `{ … }` is a call followed by a block, not a method: without the
  // `function` keyword a signature must have its brace on the same line.
  if (sig >= 0 && js && A.gap[sigEnd] && !T.slice(0, sig).some((t) => t.k === 'kw' && t.v === 'function')) { sig = -1; sigEnd = -1; }
  const inside = (i, a, b) => i > a && i < b;
  const is = (i, v) => i >= 0 && i < n && T[i].k === 'op' && T[i].v === v;
  const kw = (i, v) => i >= 0 && i < n && T[i].k === 'kw' && T[i].v === v;

  for (const name of map.keys()) {
    const at = []; for (let i = 0; i < n; i++) if (T[i].k === 'id' && T[i].v === name) at.push(i);
    const scopes = []; // [from, to): token ranges where a binder of this name is in scope
    for (const i of at) {
      if (i === 0) return no(`\`${name}\` is the first token of the snippet: it is being declared here, not used`);
      // 4. plain variable only
      if (is(i - 1, '.') || is(i - 1, '?.') || is(i - 1, '->') || is(i - 1, '::')) return no(`\`${name}\` is also used as a member name`);
      const declared = (js && (kw(i - 1, 'let') || kw(i - 1, 'const') || kw(i - 1, 'var')));
      if (is(i + 1, ':') && !declared && !(js && inside(i, sig, sigEnd) && parenOf[i] === sig)) return no(`\`${name}\` appears before a colon (a label, key or named argument)`);
      const hole = is(i - 1, '{') && T[i - 2]?.k === 'str' && lang === 'cs'; // an interpolation hole, not a shorthand
      if ((is(i - 1, '{') || is(i - 1, ',')) && (is(i + 1, '}') || is(i + 1, ',') || is(i + 1, '=')) && !hole && blockOf[i] !== -1 && !(parenOf[i] > blockOf[i])) return no(`\`${name}\` appears as a shorthand property or in a destructuring pattern`);
      if (kw(i - 2, 'nameof') && is(i - 1, '(')) return no(`\`${name}\` is read by nameof`);
      // 5./6. binders
      const inSig = sig >= 0 && inside(i, sig, sigEnd);
      if (inSig && parenOf[i] === sig && (is(i - 1, '(') || is(i - 1, ',') || T[i - 1].k === 'id' || T[i - 1].k === 'kw' || is(i - 1, '>') || is(i - 1, ']') || is(i - 1, '?') || is(i - 1, '...')) && (is(i + 1, ',') || is(i + 1, ')') || is(i + 1, '=') || is(i + 1, ':') || is(i + 1, '?'))) {
        if (!js && lang !== 'java') return no(`\`${name}\` is a parameter: in this language callers can pass it by name`);
        if (js && T[i - 1].k === 'kw' && ['public', 'private', 'protected', 'readonly'].includes(T[i - 1].v)) return no(`\`${name}\` is a constructor parameter property, so it is also a field`);
        scopes.push([sig, n]); continue;
      }
      const simple = js ? declared : (T[i - 1].k === 'id' || (T[i - 1].k === 'kw' && TYPE_KW.has(T[i - 1].v)) || ((is(i - 1, '>') || is(i - 1, ']') || is(i - 1, '?')) && (is(i + 1, '=') || is(i + 1, ';') || kw(i + 1, 'in') || is(i + 1, ')') || is(i + 1, ',')) && typeStartsStatement(T, i - 1)));
      const lambdaParam = (is(i + 1, '=>') && !is(i - 1, '.')) || (parenOf[i] >= 0 && is((parenEnd.get(parenOf[i]) ?? -2) + 1, '=>') && (is(i - 1, '(') || is(i - 1, ',')) && (is(i + 1, ')') || is(i + 1, ',')));
      if (simple || lambdaParam) {
        const p = parenOf[i];
        if (p >= 0 && p > blockOf[i]) { // bound inside parentheses: in scope there and in the block right after them
          const close = parenEnd.get(p) ?? -1;
          const after = is(close + 1, '=>') ? close + 2 : close + 1;
          if (close < 0 || !is(after, '{')) { if (lambdaParam && close >= 0) { scopes.push([p, exprEnd(T, after, n)]); continue; } return no(`\`${name}\` is bound in parentheses that no block follows`); }
          scopes.push([p, (endOf.get(after) ?? n) + 1]);
        } else if (lambdaParam && is(i + 1, '=>')) { // x => …
          scopes.push([i, is(i + 2, '{') ? (endOf.get(i + 2) ?? n) + 1 : exprEnd(T, i + 2, n)]);
        } else {
          const b = blockOf[i];
          if (b === -1) return no(`\`${name}\` is declared outside any block of the function`);
          scopes.push([b, (endOf.get(b) ?? n) + 1]);
        }
      }
    }
    if (!scopes.length) return no(`\`${name}\` is not declared inside this function by a simple declaration (it may be a field, a global or a destructured name)`);
    for (const i of at) if (!scopes.some(([a, b]) => i >= a && i < b)) return no(`\`${name}\` is used at ${where(T[i])} outside the scope of its declaration: it refers to something else there`);
  }
  return { proved: true, renames: [...map.entries()], why: null, candidate: true };
}
/**
 * `List<int> x`, `int[] x`, `int? x`: the token before x closes a type. That is a declaration only when the type
 * expression begins where a statement or a header begins; `return a > x;` and `c ? x : y` end the same way and
 * are not declarations.
 */
function typeStartsStatement(T, j) {
  let d = 0, k = j;
  for (; k >= 0; k--) {
    const t = T[k];
    if (t.k === 'id' || (t.k === 'kw' && TYPE_KW.has(t.v))) continue;
    if (t.k !== 'op') break;
    if (t.v === '>' || t.v === ']') d++;
    else if (t.v === '<' || t.v === '[') { if (--d < 0) break; }
    else if (t.v === '.' || t.v === '?' || (t.v === ',' && d > 0)) continue;
    else break;
  }
  if (d !== 0) return false;
  const first = T[k + 1], before = T[k];
  if (!first || !(first.k === 'id' || first.k === 'kw')) return false;
  if (!before) return true;
  if (before.k === 'op') return before.v === ';' || before.v === '{' || before.v === '}' || (before.v === '(' && k > 0 && T[k - 1].k === 'kw' && ['for', 'foreach', 'using', 'catch', 'fixed'].includes(T[k - 1].v));
  return before.k === 'kw' && ['out', 'const', 'readonly', 'static', 'using', 'final', 'var'].includes(before.v);
}
/** End of the expression that starts at i: the first , ; or closing bracket at depth 0. */
function exprEnd(T, i, n) {
  let d = 0;
  for (let j = i; j < n; j++) {
    const t = T[j]; if (t.k !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') d++;
    else if (t.v === ')' || t.v === ']' || t.v === '}') { if (d === 0) return j; d--; }
    else if ((t.v === ',' || t.v === ';') && d === 0) return j;
  }
  return n;
}

/**
 * classifyChange(oldText, newText, lang) → { kind, changed, total, onlyStrings, onlyNumbers }
 * kind: 'identical' | 'alpha' | 'literals' | 'logic'. `changed` is the size of the token edit (insertions plus
 * deletions). 'literals' is a LABEL for the risk model (only literal values differ), never a proof: a changed
 * number is a changed behaviour.
 */
export function classifyChange(oldText, newText, lang) {
  let A, B;
  try { A = stream(oldText, lang); B = stream(newText, lang); } catch { return { kind: 'logic', changed: 0, total: 0, onlyStrings: false, onlyNumbers: false }; }
  const T = A.T, U = B.T, total = Math.max(T.length, U.length);
  const p = proveEquivalent(oldText, newText, lang);
  if (p.proved) return { kind: p.level, changed: p.level === 'identical' ? 0 : p.renames.length, total, onlyStrings: false, onlyNumbers: false };
  if (T.length === U.length) {
    let str = 0, num = 0, other = 0;
    for (let i = 0; i < T.length; i++) if (!same(T[i], U[i])) { if (T[i].k === 'str' && U[i].k === 'str') str++; else if (T[i].k === 'num' && U[i].k === 'num') num++; else other++; }
    if (!other && str + num > 0 && A.gap.every((g, i) => g === B.gap[i])) return { kind: 'literals', changed: 2 * (str + num), total, onlyStrings: num === 0, onlyNumbers: str === 0 };
  }
  return { kind: 'logic', changed: editSize(T, U), total, onlyStrings: false, onlyNumbers: false };
}
/** Insertions plus deletions between two token arrays: common prefix and suffix first, then an LCS on the middle. */
function editSize(T, U) {
  let a = 0; while (a < T.length && a < U.length && same(T[a], U[a])) a++;
  let b = 0; while (b < T.length - a && b < U.length - a && same(T[T.length - 1 - b], U[U.length - 1 - b])) b++;
  const X = T.slice(a, T.length - b), Y = U.slice(a, U.length - b);
  if (!X.length || !Y.length) return X.length + Y.length;
  if (X.length * Y.length > 4_000_000) return X.length + Y.length; // too large to align cheaply: an upper bound
  let prev = new Uint32Array(Y.length + 1), cur = new Uint32Array(Y.length + 1);
  for (let i = 1; i <= X.length; i++) { for (let j = 1; j <= Y.length; j++) cur[j] = same(X[i - 1], Y[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); [prev, cur] = [cur, prev]; }
  return X.length + Y.length - 2 * prev[Y.length];
}

/**
 * sameUsingSet(oldText, newText) for C# files → { proved, claim }.
 * Proved when the files differ only in the ORDER (or repetition) of the using directives at the top of the
 * file: the order of using directives has no effect in C# (the set of imported namespaces is what binds
 * names). Directives inside namespace blocks, and `extern alias`, are compared as ordinary code. Never use
 * this for JavaScript or Python, where importing has side effects and order matters.
 */
export function sameUsingSet(oldText, newText) {
  const split = (text) => {
    const T = tokenize(text, 'cs'), usings = new Set(); let i = 0;
    while (i < T.length) {
      let j = i; if (T[j].k === 'kw' && T[j].v === 'global') j++;
      if (!(T[j] && T[j].k === 'kw' && T[j].v === 'using') || (T[j + 1] && T[j + 1].k === 'op' && T[j + 1].v === '(')) break;
      let k = j; while (k < T.length && !(T[k].k === 'op' && T[k].v === ';')) k++;
      if (k >= T.length) break;
      usings.add(T.slice(i, k).map((t) => t.v).join(' ')); i = k + 1;
    }
    return { usings, rest: T.slice(i).map((t) => `${t.k}:${t.v}`).join('\u0001') };
  };
  let a, b; try { a = split(oldText); b = split(newText); } catch { return { proved: false, claim: null }; }
  const equal = a.usings.size === b.usings.size && [...a.usings].every((u) => b.usings.has(u));
  if (equal && a.rest === b.rest && a.usings.size) return { proved: true, claim: 'Only the order of the using directives changed: in C# that order has no effect on what the names mean.' };
  return { proved: false, claim: null };
}
