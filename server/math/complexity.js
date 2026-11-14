// Structural complexity of one function, measured on its tokens: cyclomatic number, cognitive complexity,
// nesting depth, Halstead's size measures and the maintainability index.
//
// These are MEASUREMENTS, never proofs. They are exact functions of the token stream as this file defines
// them, and every definition is spelled out next to its code, with its source. They say how much control flow
// a function has and how its size compares with published limits; they say nothing about whether the code is
// correct. A low number does not clear a function and a high number does not condemn it: the numbers only
// order where a reader's attention is best spent.
//
// Everything is computed without a compiler, on the lexer's tokens, so four things are approximations of
// what a syntax tree would give and are listed here once (each is explained where it is decided):
//   - `?` is told apart (conditional operator against nullable type, optional member, null-conditional
//     access) by its neighbours and by looking for its matching `:`;
//   - a brace is read as a function body, a block or an initializer from the tokens just before it;
//   - in languages with optional semicolons the end of a statement is inferred from line breaks;
//   - a word the lexer calls a keyword is read as a name where only a name can stand (`promise.catch(…)`, a
//     method `catch(f) { … }`, C# `DateTime when`, Python `case.run()`).
// What the tokens do not show at all: code inside a Python f-string or a C# raw string literal arrives as one
// string token, so a decision written there is not counted (15 of 9,822 functions of the Python 3.15 standard
// library have one).
// Languages: C#, JavaScript/TypeScript and Python are handled in full and tested. Java and the C family share
// the same statement grammar. Go, Kotlin, Rust, Swift, PHP, Dart and Scala are counted by keyword; the arms of
// Kotlin `when` and Rust `match` are not counted individually.
import { matchBrackets } from './lex.js';

// What each limit is and where it comes from. `warn` and `bad` are the largest values still inside a band:
// rate() answers 'warn' above `warn` and 'bad' above `bad`, which is how every source below states its limit
// ("exceeds", "greater than"). The numbers are conventions adopted by their authors, not laws; where a number
// has no published source it says so.
//   cyclomatic  warn 10: McCabe, "A Complexity Measure", IEEE TSE SE-2(4), 1976, proposed 10 as the upper
//               limit for a module; Watson and McCabe, "Structured Testing", NIST Special Publication 500-235,
//               1996, keeps 10, notes that limits as high as 15 have been used, and asks for a written
//               explanation whenever a module exceeds the agreed limit.
//               bad 20: the "11-20 moderate risk, 21-50 high risk" bands of T. McCabe Jr., "Software Quality
//               Metrics to Identify Risk" (2008): a vendor's presentation, not a study.
//   cognitive   warn 15: default of SonarSource rule S3776, which reports functions above 15. A default chosen
//               by the tool's authors; no study behind it is cited by the rule or by Campbell's paper.
//               bad 30: twice the default; our own convention, no published source.
//   nesting     warn 4: default of ESLint's max-depth rule (blocks nested more than 4 deep are reported);
//               pylint's max-nested-blocks default is 5. bad 6: our own convention, no published source.
//   loc         warn 60: Holzmann, "The Power of 10: Rules for Developing Safety-Critical Code", IEEE Computer
//               39(6), 2006, rule 4 (a function fits on one printed page, about 60 lines).
//               bad 150: default of Checkstyle's MethodLength check.
//   params      warn 5: default of pylint's max-args (too-many-arguments, R0913).
//               bad 8: our own convention, no published source.
export const THRESHOLDS = {
  cyclomatic: { warn: 10, bad: 20 },
  cognitive: { warn: 15, bad: 30 },
  nesting: { warn: 4, bad: 6 },
  loc: { warn: 60, bad: 150 },
  params: { warn: 5, bad: 8 },
};

const set = (s) => new Set(s.split(' '));
const isOp = (t, v) => t !== undefined && t.k === 'op' && t.v === v;
const isKw = (t, v) => t !== undefined && t.k === 'kw' && t.v === v;
const round = (x) => Math.round(x * 100) / 100;

const NO_TERNARY = set('py go kt rs scala'); // no `c ? a : b` in these languages
const ARROW = set('cs js ts dart scala php'); // `=>` introduces a lambda body
const SEMI_OPTIONAL = set('js ts go kt swift scala'); // a line break can end a statement
const BRACE_HEAD = set('go rs swift'); // `if cond {`: no parentheses around a condition
// Built-in type names: before a `?` they make a nullable type (`int?`), never the end of a condition. Every other
// keyword there is a value (`this`, `null`) or a contextual keyword used as a name (`from ? from.x : 0`).
const TYPE_KW = set('bool byte char decimal double float int long object sbyte short string uint ulong ushort void boolean');
const EXPR_START = set('( [ { ! - + ~ ++ -- & * < ^ @ ...'); // operators that can begin an operand
const DECL_AFTER = set('= ; , ) { ] }'); // what follows the name in `Type? name`
const STOP_KW = set('if else for foreach while do return break continue case try catch finally where goto using lock');
const TS_TYPE_OP = set('is keyof typeof readonly extends infer asserts in');
// Keywords after which a statement necessarily goes on; any other keyword can be the last token of a statement.
const NO_END_KW = set('new typeof instanceof in of as is from delete void yield else do case throw const let var val function fun func class extends implements export import if for foreach while switch try catch finally async static await public private protected readonly abstract declare satisfies keyof infer with go defer range chan package guard');
const INFIX_KW = set('in of instanceof as is satisfies extends implements else catch finally');
const FN_BEFORE_BRACE = { get: 'cs', set: 'cs', init: 'cs', delegate: 'cs', async: 'dart', const: 'c', override: 'c', final: 'c', noexcept: 'c' };
const ASSIGN = set('= += -= *= /= %= &= |= ^= <<= >>= >>>= **= := ->');
// Keywords that start a new expression, so a run of logical operators cannot continue across them.
const BREAK_KW = set('if else elif elseif for foreach while do switch case return throw raise yield try catch except finally when lambda def function const let break continue goto using lock with assert del pass import from class');
const BODY_START = set('if for foreach while do switch try return throw');
const TYPE_DECL = set('class record struct interface'); // keywords that declare a type when a name follows
const BANG = set('cs ts swift dart kt'); // languages with a postfix `!` (null-forgiving, non-null assertion, force unwrap)
// C#: what can stand before a `when` guard or a pattern combinator, besides a name, a literal or a closing bracket.
const PATTERN_END_KW = set('catch null true false default bool byte char decimal double float int long object sbyte short string uint ulong ushort');
const GROUP_AFTER_KW = set('return yield case when'); // keywords followed by an expression that may start with a group
const HEAD_KW = set('if elif while assert else guard with'); // the same, in languages whose conditions have no parentheses
const GUARD_START = set('( ! - + ~'); // operators that can begin the condition of a `when` guard
const PATTERN_START = set('( { [ < > <= >= - +'); // operators that can begin a pattern after `and` / `or`
// JavaScript: keywords that can name a method (`return() { … }`, `delete(key) { … }`); as statements none of them
// is followed by `( … ) {`.
const JS_METHOD_KW = set('return throw case else do try finally default delete');
// Line-break rule for languages with optional semicolons: two operands on consecutive lines are two statements.
const endsOperand = (p) => p !== undefined && (p.k === 'id' || p.k === 'num' || p.k === 'str' || (p.k === 'op' ? p.v === ')' || p.v === ']' || p.v === '}' || p.v === '++' || p.v === '--' : p.k === 'kw' && !NO_END_KW.has(p.v)));
const startsStatement = (t) => t.k === 'id' || t.k === 'num' || t.k === 'str' || (t.k === 'kw' && !INFIX_KW.has(t.v));

/**
 * What the walkers need to know about single tokens, decided once per call:
 *   tern[i]      1 when the `?` at i is a conditional operator; colon[i] is the index of its `:` and tend[i]
 *                the index where its last operand ends
 *   ternColon[i] 1 when the `:` at i closes a conditional operator
 *   arm[i]       C# switch expression: 1 for the `=>` of an arm, 2 for the `=>` of the discard arm `_ =>`
 *   swx[i]       1 when the `{` at i opens the arms of a C# switch expression
 *   fnBody[i]    1 when the `{` at i is a function body that the token before it does not reveal
 */
function classify(T, M, lang) {
  const N = T.length, cs = lang === 'cs';
  const C = { T, M, N, lang, cs, py: lang === 'py', tern: new Uint8Array(N), colon: new Int32Array(N), ternColon: new Uint8Array(N), tend: new Int32Array(N), arm: new Uint8Array(N), swx: new Uint8Array(N), fnBody: new Uint8Array(N) };
  const nullable = cs || lang === 'dart';
  const indexed = cs || lang === 'dart' || lang === 'swift'; // languages that write a null-conditional index as `a?[i]`

  // `is Name<…>` ending at the `>` at g: a type test, so a `?` after it tests the result (a nullable type cannot
  // be the operand of `is` with a designation, and `as T<…>?` is never followed by an operand).
  const isTypeTest = (g) => {
    let d = 0, k = g;
    for (; k > 0; k--) {
      const t = T[k];
      if (t.k !== 'op') continue;
      if (t.v === '>') d++;
      else if (t.v === '<') { if (--d === 0) break; }
      else if (t.v !== ',' && t.v !== '.' && t.v !== '?' && t.v !== '[' && t.v !== ']' && t.v !== '(' && t.v !== ')') return false;
    }
    k--;
    while (k > 1 && T[k].k === 'id' && isOp(T[k - 1], '.')) k -= 2;
    return k > 0 && T[k].k === 'id' && isKw(T[k - 1], 'is');
  };
  // TypeScript `T extends U ? X : Y` is a conditional TYPE: it selects a type at compile time and no path at run
  // time. Its condition always holds `extends`, which the condition of a conditional operator cannot (a class
  // expression apart), so an `extends` between the `?` and the start of its expression settles it.
  const conditionalType = (i) => {
    let angle = 0;
    for (let k = i - 1, stop = Math.max(0, i - 64); k >= stop; k--) {
      const t = T[k];
      if (t.k === 'kw') { if (t.v === 'extends') return true; continue; }
      if (t.k !== 'op') continue;
      const v = t.v;
      if (v === ')' || v === ']' || v === '}') { if (M[k] < 0 || M[k] > k) return false; k = M[k]; }
      else if (v === '>') angle++;
      else if (v === '<') { if (angle > 0) angle--; }
      else if (v === '(' || v === '[' || v === '{' || v === ';' || v === '=' || v === '?' || v === ':' || (v === ',' && angle === 0)) return false;
    }
    return false;
  };
  // Local evidence that a `?` can be a conditional operator: an operand ends before it and one starts after it.
  // That already rejects `?.` and `??` (separate tokens), `int?`, `T?)`, `T?,`, `T?>`, `T? =` and `x?: T`.
  const candidate = (i) => {
    const p = T[i - 1], n = T[i + 1];
    if (!p || !n || p.k === 'pp' || n.k === 'pp') return false;
    if (lang === 'ts' && conditionalType(i)) return false;
    if (p.k === 'op') {
      if (p.v === '!') { if (!BANG.has(lang) || !endsOperand(T[i - 2])) return false; } // `x! ? a : b`: a postfix null-forgiving `!` ends an operand
      else if (p.v === '>') { if (!isTypeTest(i - 1)) return false; } // `x is List<int> ? a : b`, against the nullable `List<int>?`
      else if (p.v !== ')' && p.v !== ']' && p.v !== '}' && p.v !== '++' && p.v !== '--') return false;
    }
    else if (p.k === 'kw' && TYPE_KW.has(p.v) && !isKw(T[i - 2], 'is')) return false; // `int?`, `string?` (but `x is int ? a : b`)
    if (n.k === 'op') {
      if (!EXPR_START.has(n.v) && !(n.v === '.' && lang === 'swift')) return false;
      if (n.v === '(' && lang === 'ts' && p.k === 'id' && M[i + 1] > i && isOp(T[M[i + 1] + 1], ':')) { // `{ g?(): void }`
        const pp = T[i - 2];
        if (!pp || isOp(pp, '{') || isOp(pp, ';')) return false; // a member of a type, not an operand
      }
    }
    if (nullable && n.k === 'id' && p.k !== 'num' && p.k !== 'str') { // `Type? name` followed by what only a declaration allows
      const a = T[i + 2];
      if (!a || (a.k === 'op' && DECL_AFTER.has(a.v)) || isKw(a, 'in')) return false;
    }
    return true;
  };
  // `p ? [` is either a null-conditional index (`a?[i]`) or a conditional whose first operand is a collection
  // expression (`n == 0 ? [] : xs`). The tokens around it do not tell; the number of `:` in the expression does.
  const weak = (i) => indexed && isOp(T[i + 1], '[');
  // The `:` that pairs with the `?` at i, or -1. Brackets are skipped whole and inner conditionals pair off
  // first. A candidate without its `:` in the same expression (`a?[i]`, `T? F(int x) { … }`) is not one.
  // mode 0: an inner `p ? [` is an index; mode 1: it is a conditional; mode 2: the others are already decided.
  const colonOf = (i, mode) => {
    let q = 0, angle = 0;
    for (let j = i + 1; j < N; j++) {
      const t = T[j];
      if (t.k === 'kw') { // a statement keyword ends the search; `where T : class` does, a LINQ `where x > 0` does not
        if (STOP_KW.has(t.v) && !(t.v === 'where' && !isOp(T[j + 2], ':'))) return -1;
        continue;
      }
      if (t.k !== 'op') continue;
      const v = t.v;
      if (v === '(' || v === '[' || v === '{' || v === '${') {
        if (M[j] <= j) return -1;
        j = M[j];
        const nx = T[j + 1];
        // A body or block ended, so this was a declaration (`T? F() { … }`); the hole of an interpolated string does not count.
        if (v === '{' && T[M[j] - 1].k !== 'str' && (!nx || nx.k !== 'op' || nx.v === '}')) return -1;
      } else if (v === ')' || v === ']' || v === '}' || v === ';') return -1;
      else if (v === ',') { if (angle === 0) return -1; } // a comma ends the expression, except between generic arguments
      else if (v === '<') { if (T[j - 1].k === 'id') angle++; }
      else if (v === '>') { if (angle > 0) angle--; }
      else if (v === '?') { if (weak(j) ? mode > 0 && candidate(j) : mode === 2 ? C.tern[j] === 1 : candidate(j)) q++; }
      else if (v === ':') { if (format[j] || labelColon[j]) return -1; if (q > 0) q--; else return j; }
    }
    return -1;
  };
  // C#: a `:` at the top level of an interpolation hole starts the format (`{value:N2}`), by the language's own
  // rule that a conditional there must be parenthesized. It never pairs with a `?`.
  const format = new Uint8Array(N);
  if (cs) {
    for (let i = 1; i < N; i++) {
      if (!isOp(T[i], '{') || T[i - 1].k !== 'str' || M[i] < i) continue;
      for (let k = i + 1; k < M[i]; k++) {
        const u = T[k];
        if (u.k !== 'op') continue;
        if ((u.v === '(' || u.v === '[' || u.v === '{') && M[k] > k) k = M[k];
        else if (u.v === ':') { format[k] = 1; break; }
      }
    }
  }
  // The `:` that ends a `case` label never pairs with a `?` inside the label (`case X when a?[0] > 1:`): it is
  // the first `:` outside brackets that the conditionals of the label have not used.
  const labelColon = new Uint8Array(N);
  if (!NO_TERNARY.has(lang)) {
    for (let i = 0; i < N; i++) {
      if (!isKw(T[i], 'case')) continue;
      for (let k = i + 1, q = 0; k < N; k++) {
        const u = T[k];
        if (u.k !== 'op') continue;
        if ((u.v === '(' || u.v === '[' || u.v === '{') && M[k] > k) k = M[k];
        else if (u.v === '?') { if (!weak(k) && candidate(k)) q++; }
        else if (u.v === ':') { if (q > 0) q--; else { labelColon[k] = 1; break; } }
        else if (u.v === ';' || u.v === '{' || u.v === '}' || u.v === ')' || u.v === ']' || u.v === '->' || u.v === '=>') break;
      }
    }
    // Outer conditionals first (text order), each claiming one `:`; two conditionals never share one. A `p ? [`
    // is decided last: it is a conditional only if a `:` is left over for it.
    const claim = (i, c) => { if (c <= 0 || C.ternColon[c]) return false; C.tern[i] = 1; C.colon[i] = c; C.ternColon[c] = 1; return true; };
    const later = [];
    for (let i = 1; i < N - 1; i++) {
      if (!isOp(T[i], '?') || !candidate(i)) continue;
      if (weak(i)) later.push(i);
      else if (!claim(i, colonOf(i, 1))) claim(i, colonOf(i, 0));
    }
    for (const i of later) claim(i, colonOf(i, 2));
    for (let i = N - 1; i > 0; i--) if (C.tern[i]) C.tend[i] = operandEnd(C, C.colon[i] + 1); // rightmost first: inner before outer
  }

  for (let i = 1; i < N; i++) {
    const t = T[i];
    if (t.k !== 'op') continue;
    // C# switch expression `x switch { pattern => value, _ => other }`: one arm per top-level comma.
    if (cs && t.v === '{' && isKw(T[i - 1], 'switch') && M[i] > i) {
      C.swx[i] = 1;
      let start = i + 1, open = true;
      for (let k = i + 1; k < M[i]; k++) {
        const u = T[k];
        if (u.k !== 'op') continue;
        if ((u.v === '(' || u.v === '[' || u.v === '{') && M[k] > k) k = M[k];
        else if (u.v === ',') { start = k + 1; open = true; }
        else if (u.v === '=>' && open) { C.arm[k] = T[start].v === '_' && (k === start + 1 || isKw(T[start + 1], 'when')) ? 2 : 1; open = false; } // `_ when c =>`: the guard is the only decision
      }
    }
    if (t.v !== ')') continue;
    const n = T[i + 1];
    // TypeScript `f(a): Type {`: the brace after a return-type annotation is the body.
    if (lang === 'ts' && isOp(n, ':') && !C.ternColon[i + 1]) { const b = tsBody(C, i + 1); if (b > 0) C.fnBody[b] = 1; }
    // C# `T F<T>(T x) where T : class {` and Java `void f() throws E {`.
    if (((cs && isKw(n, 'where')) || (lang === 'java' && isKw(n, 'throws'))) && !typeHeader(T, i)) {
      for (let k = i + 2; k < N; k++) {
        const u = T[k];
        if (u.k !== 'op') continue;
        if (u.v === '{') { C.fnBody[k] = 1; break; }
        if (u.v === ';' || u.v === '=>' || u.v === '}') break;
        if ((u.v === '(' || u.v === '[') && M[k] > k) k = M[k];
      }
    }
  }
  return C;
}

/**
 * Where the expression that starts at j ends: at a `;`, a `,`, a closing bracket or the `:` of an enclosing
 * conditional. A conditional operator inside it is jumped over whole (C.tend), so a chain of n conditionals
 * costs n steps and not n squared.
 */
function operandEnd(C, j) {
  const { T, M, N } = C;
  for (let k = j; k < N; k++) {
    const t = T[k];
    if (t.k !== 'op') continue;
    const v = t.v;
    if (v === '(' || v === '[' || v === '{' || v === '${') { if (M[k] < k) return k; k = M[k]; }
    else if (v === ')' || v === ']' || v === '}' || v === ';' || v === ',') return k;
    else if (v === '?') { if (C.tern[k]) k = C.tend[k] - 1; }
    else if (v === ':' && C.ternColon[k]) return k;
  }
  return N;
}

/**
 * Does the `)` at c close the header of a type and not of a function? `record R(int A) {`, a C# 12 primary
 * constructor `class Foo<T>(int a) : Base(a) {`, JavaScript `class A extends mixin(B) {`: the brace that follows
 * holds members, each of which is a function of its own. A type keyword counts only before a name, so the
 * constraint in `void F<T>() where T : class {` does not.
 */
function typeHeader(T, c) {
  for (let k = c - 1, stop = Math.max(0, c - 200); k >= stop; k--) {
    const t = T[k];
    if (t.k === 'op') { if (t.v === ';' || t.v === '{' || t.v === '}') return false; continue; }
    if (t.k === 'kw' && TYPE_DECL.has(t.v)) { const n = T[k + 1]; if (n.k === 'id' || (n.k === 'kw' && (n.v === 'extends' || TYPE_DECL.has(n.v)))) return true; }
  }
  return false;
}

/** Index of the body brace after the TypeScript return type that starts after `colon`, or -1. */
function tsBody(C, colon) {
  const { T, M, N } = C;
  let angle = 0;
  for (let k = colon + 1; k < N; k++) {
    const t = T[k], p = T[k - 1];
    if (t.k !== 'op') continue;
    const v = t.v;
    if (v === '<') angle++;
    else if (v === '>') { if (angle > 0) angle--; }
    else if (v === '(' || v === '[') { if (M[k] < k) return -1; k = M[k]; }
    else if (v === '{') {
      // A brace where a type is still expected (`: {`, `| {`, `<{`) is an object type; after a complete type it is the body.
      const typeExpected = p.k === 'op' ? !(p.v === '>' || p.v === ']' || p.v === ')' || p.v === '}') : p.k === 'kw' && TS_TYPE_OP.has(p.v);
      if (!typeExpected && angle === 0) return k;
      if (M[k] < k) return -1;
      k = M[k];
    } else if (v === '=>') { if (!isOp(p, ')')) return -1; } // `(a): T => …` is an arrow function: its `=>` announces the body
    else if (v === ';' || v === ')' || v === ']' || v === '}' || v === '=' || (v === ',' && angle === 0)) return -1;
  }
  return -1;
}

/**
 * Python: the lexer ends a logical line with `;` unless the line ends with a brace, and so leaves out the `;`
 * after a statement that ends with a dict or set literal (`d = {1: 2}` followed by `for k in d:` arrives as one
 * statement). This puts the missing `;` back: after a `}` that closes a literal, outside every bracket, when the
 * next token is on a later line. A layout brace (an indented block) is the one that follows a `:` on an
 * earlier line and is not inside a literal.
 */
function pyStatementEnds(T) {
  const out = [], layout = []; // per open bracket: is it a layout brace?
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    out.push(t);
    if (t.k !== 'op') continue;
    if (t.v === '(' || t.v === '[') layout.push(false);
    else if (t.v === '{') layout.push(i > 0 && isOp(T[i - 1], ':') && t.l > T[i - 1].l && (layout.length === 0 || layout[layout.length - 1]));
    else if (t.v === ')' || t.v === ']') layout.pop();
    else if (t.v === '}') {
      const n = T[i + 1];
      if (layout.pop() === false && n !== undefined && n.l > t.l && (layout.length === 0 || layout[layout.length - 1])) out.push({ k: 'op', v: ';', l: t.l });
    }
  }
  return out;
}

/**
 * Python: is the `case` at j the label of a match statement? `case` is a soft keyword, so `case.run()`,
 * `case[0] = 1`, `case += 1` and `case = x` are uses of a variable: a label has a pattern and then a `:`
 * outside every bracket, before the logical line ends.
 */
function pyCase(C, j) {
  const { T, M, N } = C, n = T[j + 1];
  if (n.k === 'op' && n.v !== '(' && n.v !== '[' && n.v !== '{' && n.v !== '-' && n.v !== '*') return false;
  for (let k = j + 1; k < N; k++) {
    const t = T[k];
    if (t.k !== 'op') continue;
    if ((t.v === '(' || t.v === '[' || t.v === '{') && M[k] > k) k = M[k];
    else if (t.v === ':') return true;
    else if (t.v === ';' || t.v === '}' || t.v === '=' || ASSIGN.has(t.v)) return false;
  }
  return false;
}

/**
 * Counts that do not depend on nesting, in one pass: decision points, exits and runs of logical operators.
 *
 * decisions: the predicates of the function. McCabe (1976): the cyclomatic number of a control-flow graph G
 * with E edges, N nodes and one connected component is v(G) = E - N + 2, and for a structured single-entry
 * single-exit function it equals the number of binary decisions plus one. Counted, one each: `if` (an
 * `else if` is counted through its `if`), `elif`, `for`, `foreach`, `while` (a do-while has exactly one
 * `while`, so it is counted once and `do` is not), every `case` label but not `default`, `catch`/`except`,
 * the conditional operator, every short-circuit operator (`&&`, `||`, `??`, their assignment forms, Python
 * `and`/`or`, the C# pattern combinators `and`/`or`), every C# `when` guard and every arm of a C# switch
 * expression except the discard arm (`_ when c =>` decides once, through its guard: `_` matches everything).
 * C# `when`, `and` and `or` are contextual: they count only where a guard or a combinator can stand, so a
 * parameter called `when` decides nothing.
 * Not counted: `?.` and `?[` (the specification of this engine leaves null-conditional access out), `else`,
 * `default`, `finally`, `try`, jumps, Rust's `?` and unconditional `loop`, and TypeScript conditional types
 * (`T extends U ? X : Y` chooses a type, not a path).
 * Over-counted by one, knowingly: an irrefutable `case var x:` or `var x =>` arm (it is a default in all but
 * name, and telling it apart from a constant pattern needs the types).
 *
 * returns: `return`, `throw` and `raise`. In C# `yield return` is not an exit (the iterator goes on) and is
 * left out, `yield break` is one and is counted; an attribute target `[return: …]` is not a statement.
 *
 * sequences: Campbell (2018) adds one to cognitive complexity for each run of like binary logical operators
 * in reading order, parentheses being transparent: `a && b && c` is one run, `a && b || c` two, and
 * `a || (b && c) || d` three (sonar-java's CognitiveComplexityVisitor.flattenLogicalExpression flattens the
 * operator tree through parentheses in the same way). A negated group `!(…)`, an argument list, an index, a parenthesized conditional or `??` expression and
 * any other bracket keep their runs to themselves and do not interrupt the run around them
 * (`x && (c ? a : b) && y` is one run); every new expression starts afresh (after `,` `;` `:` `=` `=>` `??`,
 * the `?` of a conditional, a statement keyword, or a line break that ends a statement where semicolons are
 * optional). The combinators of a C# pattern form runs of their own, apart from the `&&`/`||` around the
 * pattern. `??` is not a logical operator for this count: the paper ignores null-coalescing as shorthand.
 */
function flat(C) {
  const { T, M, N, lang, cs, py } = C;
  const words = py || cs || lang === 'php'; // `and` / `or` spelled out
  const asi = SEMI_OPTIONAL.has(lang), headless = py || BRACE_HEAD.has(lang);
  let decisions = 0, returns = 0, sequences = 0, top = 0;
  const last = [null]; // per open context, the logical operator of the run in progress
  const lastPat = [null]; // per open context, the C# pattern combinator of the run in progress
  const pushed = []; // per open bracket, whether it opened a context of its own
  const reset = () => { last[top] = null; lastPat[top] = null; };
  const open = () => { top++; last[top] = null; lastPat[top] = null; };
  const logical = (v) => { decisions++; if (last[top] !== v) { sequences++; last[top] = v; } lastPat[top] = null; };
  // C# `x is A or B`, `> 0 and < 5`: the combinators of one pattern form their own runs. The pattern is an
  // operand of the boolean expression around it, so it does not interrupt a run of `&&` or `||`
  // (`a && x is A or B && c` is one run of `&&` and one of `or`).
  const combinator = (v) => { decisions++; if (lastPat[top] !== v) { sequences++; lastPat[top] = v; } };
  // A parenthesis is transparent when it only groups operands of the surrounding logical expression:
  // nothing callable or unary before it, nothing binding tighter than `&&` after it, and inside it nothing
  // that binds looser than `||` (`x && (c ? a : b) && y` and `x && (a ?? b) && y` are ONE run around a
  // parenthesized operand that keeps its runs to itself).
  const groups = (j) => {
    const p = T[j - 1], n = T[M[j] + 1];
    if (M[j] < j) return false;
    for (let k = j + 1; k < M[j]; k++) {
      const t = T[k];
      if (t.k === 'kw') { if (py && (t.v === 'if' || t.v === 'else' || t.v === 'lambda' || t.v === 'for')) return false; continue; }
      if (t.k !== 'op') continue;
      const v = t.v;
      if ((v === '(' || v === '[' || v === '{' || v === '${') && M[k] > k) k = M[k];
      else if (v === '?') { if (C.tern[k] || isOp(T[k + 1], ':')) return false; } // not a nullable type: `(x is int? || y)`
      else if (v === '??' || v === '=>' || v === ',' || ASSIGN.has(v)) return false;
    }
    if (p) {
      if (p.k === 'op') { if (!(p.v === '&&' || p.v === '||' || p.v === '(' || p.v === ',' || p.v === '?' || p.v === ':' || p.v === '=>' || p.v === ';' || p.v === '{' || p.v === '[' || p.v === '${' || p.v === '??' || ASSIGN.has(p.v))) return false; }
      // A keyword that takes an expression. Where a condition has no parentheses of its own (Python, Go, Rust,
      // Swift) `if (a and b) and c:` starts with a group; in C-like languages `if (…)` is the whole condition.
      else if (p.k === 'kw') { if (!(GROUP_AFTER_KW.has(p.v) || (words && (p.v === 'and' || p.v === 'or')) || (headless && HEAD_KW.has(p.v)))) return false; }
      else return false; // `f(…)`: a call
    }
    if (!n || (asi && n.l > T[M[j]].l && startsStatement(n))) return true; // the statement ends with the group
    if (n.k === 'op') return n.v === '&&' || n.v === '||' || n.v === ')' || n.v === ';' || n.v === ',' || n.v === '?' || n.v === ':' || n.v === ']' || n.v === '}' || n.v === '{' || n.v === '??' || n.v === '=>';
    return n.k === 'kw' && (n.v === 'else' || (words && (n.v === 'and' || n.v === 'or')) || (py && (n.v === 'if' || n.v === 'for' || n.v === 'as')));
  };
  // C#: `when`, `and` and `or` are contextual keywords and the lexer gives them as keywords everywhere. They
  // are a guard or a combinator only between a finished pattern and the start of what follows; anywhere else
  // (`DateTime when,`, `Schedule(when)`, `or = and;`) they are names and decide nothing.
  const afterPattern = (p) => p !== undefined && (p.k === 'id' || p.k === 'num' || p.k === 'str' || (p.k === 'op' ? p.v === ')' || p.v === ']' || p.v === '}' || p.v === '>' : PATTERN_END_KW.has(p.v)));
  const begins = (n, ops) => n !== undefined && (n.k === 'op' ? ops.has(n.v) : n.k !== 'pp' && !(n.k === 'kw' && INFIX_KW.has(n.v)));
  for (let j = 0; j < N; j++) {
    const t = T[j], v = t.v;
    // Without semicolons a line break between two operands ends the statement, and the run with it.
    if (asi && j > 0 && t.l > T[j - 1].l && endsOperand(T[j - 1]) && startsStatement(t)) reset();
    if (t.k === 'op') {
      switch (v) {
        case '&&': case '||': logical(v); break;
        case '??': case '??=': case '&&=': case '||=': decisions++; reset(); break;
        case '?':
          // Kotlin's elvis `a ?: b` and PHP's short conditional `a ?: b` decide like `??`.
          // Any other `?` (a nullable type `List<int?>`, a null-conditional index `a?[i]`) is part of an operand.
          if (C.tern[j] || ((lang === 'kt' || lang === 'php') && isOp(T[j + 1], ':'))) { decisions++; reset(); }
          break;
        case '=>': if (C.arm[j] === 1) decisions++; reset(); break;
        case '(': if (groups(j)) pushed.push(0); else { pushed.push(1); open(); } break;
        case '[': case '{': case '${': pushed.push(1); open(); break;
        case ')': case ']': case '}': if (pushed.pop() === 1 && top > 0) top--; break;
        default: if (v === ';' || v === ',' || v === ':' || ASSIGN.has(v)) reset();
      }
    } else if (t.k === 'kw') {
      switch (v) {
        case 'if': case 'elif': case 'elseif': case 'for': case 'foreach': case 'while': case 'catch': case 'except': case 'guard':
          decisions++; reset(); break;
        case 'case': {
          const p = T[j - 1], n = T[j + 1];
          reset();
          if (py) { // a soft keyword: only at the start of a statement that has a `:`, and `case _:` is the default
            if (p && !(p.k === 'op' && (p.v === '{' || p.v === ';' || p.v === '}'))) break;
            // `case _ if g:` decides once, through its guard (an `if`, counted as one): `_` matches everything
            if (!n || (n.k === 'id' && n.v === '_' && (isOp(T[j + 2], ':') || isKw(T[j + 2], 'if'))) || !pyCase(C, j)) break;
          } else if (isKw(p, 'goto') || isKw(n, 'class') || isKw(n, 'object')) break; // `goto case 1`, Scala `case class`
          decisions++; break;
        }
        case 'when': // guard of a case, of an arm or of a catch
          if (cs && afterPattern(T[j - 1]) && begins(T[j + 1], GUARD_START)) { decisions++; reset(); }
          break;
        case 'and': case 'or':
          if (!words) break;
          if (!cs) logical(v === 'and' ? '&&' : '||');
          else if (afterPattern(T[j - 1]) && begins(T[j + 1], PATTERN_START)) combinator(v);
          break;
        case 'return': case 'throw': case 'raise': if (!(cs && isKw(T[j - 1], 'yield'))) returns++; reset(); break;
        case 'break': if (cs && isKw(T[j - 1], 'yield')) returns++; reset(); break; // `yield break` ends the iterator
        default: if (BREAK_KW.has(v)) reset();
      }
    }
  }
  return { decisions, returns, sequences };
}

/**
 * The part of cognitive complexity that depends on nesting, and the nesting depth, by walking statements.
 *
 * cognitive (G. Ann Campbell, "Cognitive Complexity: a new way of measuring understandability", SonarSource,
 * 2018; rules quoted from version 1.7 of 2023, appendix B):
 *   B1 increments, +1 each: if, else if, else, conditional operator, switch, for, foreach, while, do-while,
 *      catch, goto and break/continue to a label (the runs of logical operators are counted by flat()).
 *   B3 nesting increments, + the current nesting level: if, conditional operator, switch, loops and catch.
 *      `else` and `else if` get none.
 *   B2 the nesting level rises inside if / else if / else, the conditional operator, switch, loops, catch and
 *      inside a function nested in another function (lambda, local function, anonymous method). The outermost
 *      function of the slice and `try` / `finally` do not raise it.
 * Where the paper is silent this follows SonarSource's analyzers: the else of a Python loop or try is an
 * `else` (+1), and comprehensions add nothing. Python `match` and the C# switch expression count as `switch`.
 * Everything inside a conditional operator is one level deeper, its condition included: that is how
 * sonar-java's CognitiveComplexityVisitor.visitConditionalExpression walks it (nesting++ around the whole
 * expression). The part written before the `?` (or, in Python, before the `if`) has already been walked when
 * the operator is seen, so owed() and pyOwed() add what the structures in it are short of.
 * The guard of a `case` label is read like any expression, so a conditional operator in it counts.
 *
 * nesting: the largest number of control structures (if/else chain, loop, switch, try) open around any point.
 * An `else if` continues its chain and does not deepen it; a lambda adds no depth of its own and keeps the
 * depth of the code it is written in. This is what ESLint's max-depth and pylint's max-nested-blocks limit.
 */
function structure(C, inBody) {
  const { T, M, lang, cs, py } = C;
  const asi = SEMI_OPTIONAL.has(lang), braceHead = BRACE_HEAD.has(lang), arrow = ARROW.has(lang);
  let cognitive = 0, nesting = 0;
  let lv = 0; // cognitive nesting level (B2)
  let cd = 0; // control structures open around the current token
  let fn = inBody ? 1 : 0; // function bodies open around the current token

  const closeOf = (i, b) => (M[i] > i && M[i] < b ? M[i] : b); // an unclosed block runs to the end of its container
  const walk = (a, b) => { for (let i = a; i < b;) { const n = stmt(i, b); i = n > i ? n : i + 1; } };
  const blockOrStmt = (i, b) => {
    if (i >= b) return i;
    if (isOp(T[i], '{')) { const c = closeOf(i, b); walk(i + 1, c); return c + 1; }
    return stmt(i, b);
  };
  const nested = (i, b) => { lv++; cd++; if (cd > nesting) nesting = cd; const r = blockOrStmt(i, b); lv--; cd--; return r; };
  // A function body raises the level only when it sits inside another function (B2).
  const inFunction = (run) => { const d = fn > 0 ? 1 : 0; lv += d; fn++; const r = run(); fn--; lv -= d; return r; };
  const afterColon = (j) => (py && isOp(T[j], ':') ? j + 1 : j);

  /** Python: the `:` that ends a statement head starting at j (not a lambda's, not one inside brackets), or -1. */
  function pyColon(j, b) {
    let lambdas = 0;
    for (let k = j; k < b; k++) {
      const t = T[k];
      if (t.k === 'kw') { if (t.v === 'lambda') lambdas++; continue; }
      if (t.k !== 'op') continue;
      const v = t.v;
      if ((v === '(' || v === '[' || v === '{') && M[k] > k) k = M[k];
      else if (v === ':') { if (lambdas > 0) lambdas--; else return k; }
      else if (v === ';' || v === '}' || v === ')' || v === ']') return -1;
    }
    return -1;
  }
  /** Scans the head of a statement that starts at j (a condition, a loop header) and returns where its body starts. */
  function head(j, b) {
    if (j >= b) return j;
    if (py) { const k = pyColon(j, b); if (k < 0) return j; scan(j, k, false); return k + 1; }
    if (braceHead) {
      let k = j;
      for (; k < b && !isOp(T[k], '{'); k++) if ((isOp(T[k], '(') || isOp(T[k], '[')) && M[k] > k) k = M[k];
      scan(j, k, false);
      return k;
    }
    if (isOp(T[j], '(') && M[j] > j && M[j] < b) { scan(j + 1, M[j], false); return M[j] + 1; }
    return j;
  }
  /** The first `{` of a declaration that starts at j, before any `;`, or -1. */
  function bodyBrace(j, b) {
    for (let k = j; k < b; k++) {
      const t = T[k];
      if (t.k !== 'op') continue;
      if (t.v === '{') return k;
      if (t.v === ';' || t.v === '}' || t.v === '=>') return -1;
      if ((t.v === '(' || t.v === '[') && M[k] > k) k = M[k];
    }
    return -1;
  }

  function ifStmt(i, b, chained) {
    cognitive += chained ? 1 : 1 + lv; // `else if`: the cost was paid when reading the `if`
    let j = nested(head(i + 1, b), b);
    while (j < b) {
      const e = T[j];
      if (e.k !== 'kw') break;
      if (e.v === 'elif' || e.v === 'elseif') { cognitive++; j = nested(head(j + 1, b), b); continue; }
      if (e.v !== 'else') break;
      if (j + 1 < b && isKw(T[j + 1], 'if')) return ifStmt(j + 1, b, true);
      cognitive++;
      return nested(afterColon(j + 1), b);
    }
    return j;
  }
  function loop(i, b) {
    cognitive += 1 + lv;
    let j = i + 1;
    if (isKw(T[j], 'await')) j++; // `for await (…)`
    j = nested(head(j, b), b);
    if (py && j < b && isKw(T[j], 'else')) { cognitive++; j = nested(afterColon(j + 1), b); } // for … else, while … else
    return j;
  }
  function doStmt(i, b) {
    cognitive += 1 + lv;
    let j = nested(i + 1, b);
    if (j < b && isKw(T[j], 'while')) { j = head(j + 1, b); if (j < b && isOp(T[j], ';')) j++; } // its `while` is not a second loop
    return j;
  }
  function tryStmt(i, b) {
    cd++; if (cd > nesting) nesting = cd;
    let j = afterColon(i + 1);
    if (!py && isOp(T[j], '(') && M[j] > j && M[j] < b) { scan(j + 1, M[j], false); j = M[j] + 1; } // try-with-resources
    j = blockOrStmt(j, b);
    while (j < b && T[j].k === 'kw') {
      const v = T[j].v;
      if (v === 'catch' || v === 'except') {
        cognitive += 1 + lv;
        let k = j + 1;
        if (py) k = head(k, b);
        else {
          if (isOp(T[k], '(') && M[k] > k && M[k] < b) k = M[k] + 1; // the caught type: a declaration
          if (isKw(T[k], 'when') && isOp(T[k + 1], '(') && M[k + 1] > k && M[k + 1] < b) { scan(k + 2, M[k + 1], false); k = M[k + 1] + 1; } // C# exception filter
        }
        lv++; j = blockOrStmt(k, b); lv--;
      } else if (v === 'finally') j = blockOrStmt(afterColon(j + 1), b);
      else if (v === 'else' && py) { cognitive++; lv++; j = blockOrStmt(afterColon(j + 1), b); lv--; }
      else break;
    }
    cd--;
    return j;
  }
  /**
   * `case x:` / `default:` inside a switch body: the label is read as an expression (a guard can hold a
   * conditional operator or a lambda: `case Foo f when (f.A ? x : y):`), what follows is an ordinary statement.
   */
  function label(i, b) {
    if (T[i].v === 'default' && !(isOp(T[i + 1], ':') || isOp(T[i + 1], '->') || isOp(T[i + 1], '=>'))) return simple(i, b); // C# `default(T)`
    if (py) { const k = pyColon(i + 1, b); if (k > 0 && !isOp(T[i + 1], '=')) { scan(i + 1, k, false); return k + 1; } return simple(i, b); }
    for (let k = i + 1; k < b; k++) {
      const t = T[k];
      if (t.k !== 'op') continue;
      if ((t.v === ':' && !C.ternColon[k]) || t.v === '->' || (t.v === '=>' && lang === 'scala')) { scan(i + 1, k, false); return k + 1; }
      if (t.v === ';' || t.v === '{' || t.v === '}') break;
      if ((t.v === '(' || t.v === '[') && M[k] > k) k = M[k];
    }
    return simple(i, b);
  }

  /** One statement starting at i; returns the index after it. */
  function stmt(i, b) {
    const t = T[i];
    if (t.k === 'op') {
      if (t.v === '{') { const c = closeOf(i, b); walk(i + 1, c); return c + 1; }
      if (t.v === ';' || t.v === '}' || t.v === ')' || t.v === ']') return i + 1;
      return simple(i, b);
    }
    if (t.k !== 'kw') return simple(i, b);
    switch (t.v) {
      case 'if': return ifStmt(i, b, false);
      case 'for': case 'foreach': case 'while': case 'loop': case 'guard': return loop(i, b);
      case 'do': return lang === 'swift' ? tryStmt(i, b) : doStmt(i, b); // Swift: `do { } catch { }`
      case 'repeat': return doStmt(i, b);
      case 'try': return tryStmt(i, b);
      case 'switch': case 'select':
        if (cs && isOp(T[i + 1], '{')) break;
        cognitive += 1 + lv;
        return nested(head(i + 1, b), b);
      case 'match': { // Python's soft keyword: a statement only when a block follows its head
        const k = py ? pyColon(i + 1, b) : -1;
        if (k > 0 && isOp(T[k + 1], '{')) { cognitive += 1 + lv; scan(i + 1, k, false); return nested(k + 1, b); }
        break;
      }
      case 'case': case 'default': return label(i, b);
      case 'else': cognitive++; return nested(afterColon(i + 1), b); // an `else` whose `if` is outside the slice
      case 'using': case 'lock': case 'fixed': case 'synchronized': // a guarded statement: no branch, no nesting
        if (isOp(T[i + 1], '(') && M[i + 1] > i && M[i + 1] < b) { scan(i + 2, M[i + 1], false); return blockOrStmt(M[i + 1] + 1, b); }
        break;
      case 'checked': case 'unchecked': case 'unsafe': if (isOp(T[i + 1], '{')) return blockOrStmt(i + 1, b); break;
      case 'with': case 'class': case 'def': {
        if (!py) break;
        const k = pyColon(i + 1, b);
        if (k < 0) break;
        scan(i + 1, k, false); // defaults, bases and context managers belong to the enclosing level
        return t.v === 'def' ? inFunction(() => blockOrStmt(k + 1, b)) : blockOrStmt(k + 1, b);
      }
      case 'async': if (py && i + 1 < b) return stmt(i + 1, b); break;
      case 'func': case 'fn': case 'fun': case 'function': { // languages that announce a function with a keyword
        if (t.v === 'function' && lang !== 'php') break;
        const k = bodyBrace(i + 1, b);
        if (k < 0) break;
        scan(i + 1, k, false);
        const c = closeOf(k, b);
        inFunction(() => walk(k + 1, c));
        return c + 1;
      }
      default:
    }
    return simple(i, b);
  }

  const exprEnd = (j, end) => Math.min(operandEnd(C, j), end);
  /** Python: the end of an expression from j with `pending` conditional expressions still waiting for their `else`. */
  function pyEnd(j, end, pending) {
    for (let k = j; k < end; k++) {
      const t = T[k];
      if (t.k === 'kw') {
        if (t.v === 'if') pending++;
        else if (t.v === 'else') { if (pending === 0) return k; pending--; }
        else if (t.v === 'for') return k; // the comprehension this expression is the element of
        continue;
      }
      if (t.k !== 'op') continue;
      const v = t.v;
      if ((v === '(' || v === '[' || v === '{') && M[k] > k) k = M[k];
      else if (v === ')' || v === ']' || v === '}' || v === ';' || v === ',' || v === ':') return k;
    }
    return end;
  }
  /** Python `a if c else b` has an `else` in the same expression; the filter of a comprehension has none. */
  function pyHasElse(j, end) {
    let inner = 0;
    for (let k = j + 1; k < end; k++) {
      const t = T[k];
      if (t.k === 'kw') {
        if (t.v === 'if') inner++;
        else if (t.v === 'else') { if (inner === 0) return true; inner--; }
        else if (t.v === 'for') return false;
        continue;
      }
      if (t.k !== 'op') continue;
      const v = t.v;
      if ((v === '(' || v === '[' || v === '{') && M[k] > k) k = M[k];
      else if (v === ')' || v === ']' || v === '}' || v === ';' || v === ',' || v === ':') return false;
    }
    return false;
  }
  /**
   * Python writes the first operand of `a if c else b` BEFORE the `if`, so it has been walked one level too
   * low by the time the `if` at j is seen. This counts the conditional expressions inside that operand (they
   * can only stand in brackets), each of which owes one more nesting increment.
   */
  function pyOwed(j, from) {
    let owed = 0;
    for (let k = j - 1; k >= from; k--) {
      const t = T[k];
      if (t.k === 'kw') {
        if (BREAK_KW.has(t.v)) break;
        if (t.v === 'in') { // `for x, y in <operand>` starts the operand; `a in b` is part of it
          let q = k - 1;
          while (q >= from && (T[q].k === 'id' || isOp(T[q], ',') || isOp(T[q], '.') || isOp(T[q], '*') || ((isOp(T[q], ')') || isOp(T[q], ']')) && M[q] >= from))) q = T[q].k === 'op' && M[q] >= 0 && M[q] < q ? M[q] - 1 : q - 1;
          if (q >= from && isKw(T[q], 'for')) break;
        }
        continue;
      }
      if (t.k !== 'op') continue;
      const v = t.v;
      if (v === ')' || v === ']' || v === '}') {
        const o = M[k];
        if (o < from || o > k) break;
        for (let q = o + 1; q < k; q++) if (isKw(T[q], 'if') && pyHasElse(q, k)) owed++;
        k = o;
      } else if (v === '(' || v === '[' || v === '{' || v === ',' || v === ':' || v === ';' || ASSIGN.has(v)) break;
    }
    return owed;
  }
  /**
   * The same for `c ? a : b`: the condition is written before the `?` at j and has been walked one level too
   * low. Every structure in it that takes a nesting increment owes one more: a conditional operator or a C#
   * switch expression (both can only stand in brackets there) and the statements of a lambda body.
   */
  function owed(j, from) {
    let n = 0;
    for (let k = j - 1; k >= from; k--) {
      const t = T[k];
      if (t.k === 'kw') { if (BREAK_KW.has(t.v)) break; continue; }
      if (t.k !== 'op') continue;
      const v = t.v;
      if (v === ')' || v === ']' || v === '}') {
        const o = M[k];
        if (o < from || o > k) break;
        for (let q = o; q < k; q++) {
          const u = T[q];
          if (u.k === 'op') { if (C.tern[q] || C.swx[q]) n++; continue; }
          if (u.k !== 'kw') continue;
          switch (u.v) {
            case 'for': case 'foreach': case 'do': case 'catch': n++; break;
            case 'if': if (!isKw(T[q - 1], 'else')) n++; break;
            case 'switch': if (isOp(T[q + 1], '(')) n++; break; // a switch expression is counted at its brace
            case 'while': if (!(isOp(T[q - 1], '}') && M[q - 1] > 0 && isKw(T[M[q - 1] - 1], 'do'))) n++; break; // not the tail of a do-while
            default:
          }
        }
        k = o;
      } else if (v === '(' || v === '[' || v === '{' || v === '${' || v === ',' || v === ';' || v === ':' || v === '=>' || (v === '?' && C.tern[k]) || ASSIGN.has(v)) break;
    }
    return n;
  }
  /** `new T(args) { … }`: the brace after the `)` at c is an initializer or an anonymous class body, not a function body. */
  function initializer(c) {
    let k = M[c] - 1;
    if (isKw(T[k], 'new')) return true; // target-typed `new(…) { … }`
    if (isOp(T[k], '>')) { let d = 0; for (; k >= 0; k--) { if (isOp(T[k], '>')) d++; else if (isOp(T[k], '<') && --d === 0) break; } k--; }
    if (k < 0 || (T[k].k !== 'id' && T[k].k !== 'kw')) return false;
    k--;
    while (k > 0 && (isOp(T[k], '.') || isOp(T[k], '::')) && T[k - 1].k === 'id') k -= 2;
    return isKw(T[k], 'new');
  }
  /** What the `{` at j opens: 1 a function body, 2 the arms of a C# switch expression, 0 anything else. */
  function brace(j) {
    if (C.fnBody[j]) return 1;
    if (C.swx[j]) return 2;
    const p = T[j - 1];
    if (!p) return 0;
    if (p.k === 'op') {
      if (p.v === '=>') return arrow && !C.arm[j - 1] ? 1 : 0;
      if (p.v === '->') return lang === 'java' ? 1 : 0;
      if (p.v === ')') return initializer(j - 1) || typeHeader(T, j - 1) ? 0 : 1;
      return 0;
    }
    if (p.k === 'kw') { const l = FN_BEFORE_BRACE[p.v]; return l && (l === lang || (l === 'c' && !py)) ? 1 : 0; } // `get {`, `delegate {`, `f() const {`
    return (lang === 'kt' || lang === 'swift') && fn > 0 && p.k === 'id' ? 1 : 0; // trailing lambda
  }
  /** After the function body that closes just before k: does the statement end there (a declaration) or go on (`}.bind(x)`, `});`)? */
  const declEnds = (k, end) => { if (k >= end) return true; const t = T[k]; return t.k === 'op' ? t.v === ';' || t.v === '}' : !(t.k === 'kw' && INFIX_KW.has(t.v) && t.v !== 'else'); };

  /**
   * Walks expression tokens from i. With `st` it is one simple statement and stops after its `;` (or where a
   * line break or a closing bracket ends it); without, it covers exactly [i, end). Conditional operators,
   * lambdas and switch expressions found on the way open a nesting frame that closes where their expression ends.
   */
  function scan(i, end, st) {
    const frames = []; // [end index, level delta, function delta, control-depth delta]
    let depth = 0, j = i;
    walking: for (; j < end; j++) {
      while (frames.length && j >= frames[frames.length - 1][0]) { const f = frames.pop(); lv -= f[1]; fn -= f[2]; cd -= f[3]; }
      const t = T[j];
      if (st && asi && depth === 0 && j > i && t.l > T[j - 1].l && endsOperand(T[j - 1]) && startsStatement(t)) break;
      if (t.k === 'op') {
        const v = t.v;
        if (v === ';') { if (st && depth === 0) { j++; break; } }
        else if (v === '(' || v === '[' || v === '${') depth++;
        else if (v === ')' || v === ']' || v === '}') { if (st && depth === 0) break; depth--; }
        else if (v === '{') {
          const c = M[j] > j && M[j] < end ? M[j] : -1, kind = c < 0 ? 0 : brace(j);
          if (kind === 1) {
            inFunction(() => walk(j + 1, c));
            j = c;
            if (st && depth === 0 && declEnds(c + 1, end)) { j = c + 1; if (j < end && isOp(T[j], ';')) j++; break; }
          } else {
            if (kind === 2) { cognitive += 1 + lv; frames.push([c, 1, 0, 1]); lv++; cd++; if (cd > nesting) nesting = cd; }
            depth++;
          }
        } else if (v === '?') {
          if (C.tern[j]) { cognitive += 1 + lv + owed(j, i); frames.push([exprEnd(C.colon[j] + 1, end), 1, 0, 0]); lv++; }
        } else if ((v === '=>' && arrow && !C.arm[j]) || (v === '->' && lang === 'java')) {
          if (!isOp(T[j + 1], '{')) { const d = fn > 0 ? 1 : 0; frames.push([exprEnd(j + 1, end), d, 1, 0]); lv += d; fn++; } // a block body is handled at its brace
        }
        continue;
      }
      if (t.k !== 'kw') continue;
      switch (t.v) {
        case 'if':
          if (!py) break;
          if (pyHasElse(j, end)) { cognitive += 1 + lv + pyOwed(j, i); frames.push([pyEnd(j + 1, end, 1), 1, 0, 0]); lv++; } // conditional expression
          continue;
        case 'for': if (py) continue; break; // a comprehension: shorthand, no increment
        case 'foreach': case 'while': case 'do': case 'try': case 'guard': case 'repeat': case 'loop': case 'func': case 'fn': case 'fun': break;
        case 'function': if (lang !== 'php') continue; break;
        case 'switch': if (cs && isOp(T[j + 1], '{')) continue; break; // a switch expression: counted at its brace
        case 'using': case 'lock': case 'fixed': case 'synchronized': if (!isOp(T[j + 1], '(')) continue; break;
        case 'else': if (st && depth === 0 && !py) break walking; continue; // belongs to the `if` this statement is the branch of
        case 'lambda': {
          const k = py ? pyColon(j + 1, end) : -1;
          if (k > 0) { const d = fn > 0 ? 1 : 0; frames.push([pyEnd(k + 1, end, 0), d, 1, 0]); lv += d; fn++; j = k; }
          continue;
        }
        case 'goto': cognitive++; continue;
        case 'break': case 'continue': { // a jump to a label (B1); a plain break or continue is free
          const n = T[j + 1];
          if (n && n.l === t.l && (n.k === 'id' || isOp(n, '@') || (n.k === 'num' && lang === 'php'))) cognitive++;
          continue;
        }
        default: continue;
      }
      // A statement keyword in the middle of a statement or inside braces read as an expression (an accessor
      // list, an initializer, a labelled statement, `await foreach`): parse it as the statement it is.
      if (j === i && st) continue; // stmt() already looked at this keyword and sent it here
      const r = stmt(j, end);
      if (st && depth === 0) { j = r; break; }
      j = r - 1;
    }
    while (frames.length) { const f = frames.pop(); lv -= f[1]; fn -= f[2]; cd -= f[3]; }
    return j;
  }
  const simple = (i, b) => scan(i, b, true);

  walk(0, T.length);
  return { cognitive, nesting };
}

/**
 * metrics(tokens, lang) → { loc, ntokens, cyclomatic, cognitive, nesting, returns, halstead, maintainability }
 *
 * `tokens` is the token slice of one function declaration (file.tokens.slice(sym.a, sym.b)); any other slice
 * works and is read as what it is: a body alone (starting with `{` or a statement keyword) is taken to be
 * inside a function already, a type is the sum of its members.
 *
 *   loc        lines that hold at least one token. Comment-only and blank lines never count; a string that
 *              spans several lines counts for the line it starts on.
 *   ntokens    tokens in the slice.
 *   cyclomatic McCabe (1976): v(G) = E - N + 2 for the control-flow graph G of the function with its exits
 *              joined in one exit node. Since E - N + 2 = 1 + the sum of (out-degree - 1) over every node
 *              but the exit, it is the number of decisions + 1 (flat() says what a decision is), whatever the returns, breaks
 *              and gotos. It is the number of linearly independent paths through G, the size of a basis
 *              path set: an upper bound on the test cases needed for branch coverage and a lower bound on
 *              the number of paths (McCabe 1976; Watson and McCabe, NIST SP 500-235, 1996). It is NOT the
 *              number of paths, which can be exponential in it, and it does not see data flow. Compound
 *              conditions are counted per condition, as McCabe recommends. A `catch` is one decision
 *              although every call inside the `try` could raise: exception edges are not modelled.
 *   cognitive  Campbell (2018), see structure(). Not counted here, though the paper counts them: recursion
 *              (it needs the call graph) and preprocessor conditionals. The paper's exceptions for
 *              JavaScript wrapper functions and Python decorators are not applied either.
 *   nesting    deepest nesting of control structures, see structure().
 *   returns    `return`, `throw` and `raise` statements in the slice, nested functions included (C#:
 *              `yield break` counts, `yield return` does not; see flat()).
 *   halstead   Halstead, "Elements of Software Science" (1977). Operators are keyword and punctuation tokens,
 *              operands are identifiers, numbers and strings; n1, n2 distinct and N1, N2 total operators and
 *              operands; vocabulary n = n1 + n2; length N = N1 + N2; volume V = N log2 n; difficulty
 *              D = (n1 / 2)(N2 / n2); effort E = D V. Every bracket counts as its own operator (the usual
 *              counting rules pair them), Python's layout arrives as `{`, `}` and `;` operators and
 *              preprocessor lines are neither. Zero wherever a logarithm or a quotient would be undefined.
 *   maintainability  MI = max(0, 100 (171 - 5.2 ln V - 0.23 v(G) - 16.2 ln LOC) / 171): the three-metric
 *              index of Oman and Hagemeister (1992) with the coefficients of Coleman, Ash, Lowther and Oman
 *              (1994), rescaled to 0-100 as Visual Studio does. An empirical regression fitted to
 *              industrial systems of the early 1990s: a ranking aid, not a property of the code. ln of
 *              anything below 1 is taken as 0, so the value is always within 0-100.
 */
export function metrics(tokens, lang) {
  const all = tokens || [];
  let T = [];
  const lines = new Set(), operators = new Set(), operands = new Set();
  let N1 = 0, N2 = 0;
  for (const t of all) {
    if (t.k === 'nl') continue;
    lines.add(t.l);
    if (t.k === 'kw' || t.k === 'op') { N1++; operators.add(t.v); } else if (t.k !== 'pp') { N2++; operands.add(t.v); }
    T.push(t);
  }
  const ntokens = T.length; // the tokens given; the walkers below may read a repaired copy
  if (lang === 'py') T = pyStatementEnds(T);
  // A keyword used as a name is a name:
  //   - after a member access (`promise.catch(…)`, `re.match(…)`, `x.default`);
  //   - JavaScript: as the key of an object literal (`{ for: id, if: cond }`; `default:` stays a label);
  //   - JavaScript: as the name of a method. `return(v) { … }`, `delete(key) { … }` are declarations because
  //     the statement is never followed by `( … ) {`; `catch (e) {` is a clause exactly when the block that
  //     closes just before it belongs to a `try`, and a method (`catch(onRejected) { … }`) otherwise; after
  //     `get`, `set`, `static` or `async` any keyword before `(` is a name;
  //   - C#: as an attribute target (`[return: NotNullIfNotNull("x")]` returns nothing).
  const jsLike = lang === 'js' || lang === 'ts', M = matchBrackets(T);
  for (let i = 0; i < T.length; i++) {
    const t = T[i], p = T[i - 1], n = T[i + 1];
    if (t.k !== 'kw') continue;
    let name = false;
    if (p !== undefined && p.k === 'op') {
      name = p.v === '.' || p.v === '?.' || p.v === '::'
        || (jsLike && (p.v === '{' || p.v === ',') && t.v !== 'default' && isOp(n, ':'))
        || (lang === 'cs' && p.v === '[' && isOp(n, ':'));
    }
    if (!name && jsLike && isOp(n, '(') && M[i + 1] > i) {
      if (isKw(p, 'get') || isKw(p, 'set') || isKw(p, 'static') || isKw(p, 'async')) name = t.v !== 'function'; // `get if() { … }`
      else if (t.v === 'catch') name = p !== undefined && !(isOp(p, '}') && (M[i - 1] <= 0 || isKw(T[M[i - 1] - 1], 'try'))); // a slice cut before the `try` keeps the clause
      else name = JS_METHOD_KW.has(t.v) && isOp(T[M[i + 1] + 1], '{');
    }
    if (name) T[i] = { k: 'id', v: t.v, l: t.l };
  }
  const C = classify(T, M, lang);
  const { decisions, returns, sequences } = flat(C);
  const inBody = T.length > 0 && ((isOp(T[0], '{') && M[0] === T.length - 1) || (T[0].k === 'kw' && BODY_START.has(T[0].v)));
  const s = structure(C, inBody);
  const n1 = operators.size, n2 = operands.size, vocabulary = n1 + n2, length = N1 + N2;
  const volume = vocabulary > 1 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  const loc = lines.size, cyclomatic = decisions + 1;
  const mi = (171 - 5.2 * Math.log(Math.max(volume, 1)) - 0.23 * cyclomatic - 16.2 * Math.log(Math.max(loc, 1))) * 100 / 171;
  return {
    loc, ntokens, cyclomatic, cognitive: s.cognitive + sequences, nesting: s.nesting, returns,
    halstead: { n1, n2, N1, N2, vocabulary, length, volume: round(volume), difficulty: round(difficulty), effort: round(difficulty * volume) },
    maintainability: round(Math.max(0, Math.min(100, mi))),
  };
}

const NUMERIC = ['loc', 'ntokens', 'cyclomatic', 'cognitive', 'nesting', 'returns'];
const HALSTEAD = ['n1', 'n2', 'N1', 'N2', 'vocabulary', 'length', 'volume', 'difficulty', 'effort'];

/**
 * compare(before, after) → the same shape as metrics(), each value being after minus before, plus
 * { added, removed }. `before` null is a new function and `after` null a deleted one: the missing side
 * counts as zero for every size and complexity, and `maintainability` is null because an index of nothing
 * is not defined. A delta states how the measurement moved; it does not say the change is better or worse.
 */
export function compare(before, after) {
  const d = (a, b) => round((a || 0) - (b || 0));
  const out = { added: !before, removed: !after };
  for (const k of NUMERIC) out[k] = d(after?.[k], before?.[k]);
  out.halstead = {};
  for (const k of HALSTEAD) out.halstead[k] = d(after?.halstead?.[k], before?.halstead?.[k]);
  out.maintainability = before && after ? d(after.maintainability, before.maintainability) : null;
  return out;
}

const RATED = [['cyclomatic', 'Cyclomatic complexity'], ['cognitive', 'Cognitive complexity'], ['nesting', 'Nesting depth'], ['loc', 'Lines of code'], ['params', 'Parameters']];

/**
 * rate(m, params) → [{ id, label, value, warn, bad, tone }] for cyclomatic, cognitive, nesting, loc and params.
 * tone is 'bad' when value > bad, 'warn' when value > warn, else 'ok'. It places a measurement against the
 * conventions in THRESHOLDS and nothing more: 'ok' is not a statement that the function is correct or safe.
 * `params` is the declared parameter count (symbol.params); anything that is not a finite number counts as 0.
 */
export function rate(m, params) {
  const values = { ...m, params: Number.isFinite(params) ? params : 0 };
  return RATED.map(([id, label]) => {
    const { warn, bad } = THRESHOLDS[id], value = values[id] ?? 0;
    return { id, label, value, warn, bad, tone: value > bad ? 'bad' : value > warn ? 'warn' : 'ok' };
  });
}
