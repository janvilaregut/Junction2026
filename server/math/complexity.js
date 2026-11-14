// Structural complexity of one function, from its tokens. Exact counts over the control-flow model stated
// below, in microseconds. These are facts about the structure of the code. They are not facts about its
// behaviour, and none of them can make a changed function "correct".
//
//   cyclomatic   McCabe (1976): v(G) = e - n + 2 for one entry and one exit, which equals the number of binary
//                decisions + 1. It is the number of linearly independent paths through the function: an upper
//                bound on the tests needed to cover every branch. The count below takes each `if`, loop,
//                `case`, `catch`, ternary and short-circuit operator as one decision (the "extended" count
//                used by most tools; Watson & McCabe, NIST SP 500-235, 1996). Exceptions and early returns are
//                not modelled as edges, so it is exact for this model, not for every possible flow graph.
//   cognitive    Cognitive Complexity (Campbell, SonarSource 2018), approximated from tokens: +1 per break in
//                linear flow, plus the nesting depth for structures that nest, +1 per run of like boolean
//                operators. An approximation: bodies without braces do not raise the nesting level.
//   halstead     Halstead (1977): volume V = N log2(n), difficulty D = (n1/2)(N2/n2), effort E = D V.
//   maintainability  MI = max(0, 100 (171 - 5.2 ln V - 0.23 v(G) - 16.2 ln LOC) / 171)
//                (Oman & Hagemeister 1992; Coleman et al. 1994; normalised to 0..100).
// Size explains much of what these metrics predict (El Emam et al. 2001), so the risk model weighs the size of
// the change first and uses complexity as a second, smaller signal.
import { matchBrackets } from './lex.js';

/** Where a number stops being comfortable. Conventions, not laws: 10 is McCabe's own suggestion (1976), kept
 *  by NIST SP 500-235; 15 is the default limit of Cognitive Complexity in SonarSource's rules; the rest are
 *  the usual lint defaults. They decide amber and red in the interface, nothing else. */
export const THRESHOLDS = {
  cyclomatic: { warn: 10, bad: 20, label: 'Cyclomatic complexity' },
  cognitive: { warn: 15, bad: 30, label: 'Cognitive complexity' },
  nesting: { warn: 4, bad: 6, label: 'Nesting depth' },
  loc: { warn: 60, bad: 150, label: 'Length in lines' },
  params: { warn: 5, bad: 8, label: 'Parameters' },
};

const LOOPS = new Set(['for', 'foreach', 'while', 'loop']);
const NESTERS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'except', 'do', 'loop', 'match']);
const isOp = (t, v) => t && t.k === 'op' && t.v === v;
const isKw = (t, v) => t && (t.k === 'kw' || t.k === 'id') && t.v === v;

/** Is the '?' at index i a conditional operator (and not a nullable type, an optional member or `?[`)? */
function isTernary(T, i) {
  const next = T[i + 1];
  if (!next || isOp(next, ':') || isOp(next, ')') || isOp(next, ',') || isOp(next, '>') || isOp(next, ';') || isOp(next, '=') || isOp(next, ']')) return false; // x?: T, int?), Foo<int?>, int? x;
  let depth = 0, pending = 0;
  for (let j = i + 1; j < T.length; j++) {
    const t = T[j]; if (t.k !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '${') depth++;
    else if (t.v === ')' || t.v === ']' || t.v === '}') { if (--depth < 0) return false; }
    else if (depth === 0) {
      if (t.v === '?') pending++;
      else if (t.v === ':') { if (pending === 0) return true; pending--; }
      else if (t.v === ';' || t.v === ',') return false;
    }
  }
  return false;
}

/**
 * metrics(tokens, lang) → { loc, ntokens, cyclomatic, cognitive, nesting, returns, halstead, maintainability }
 * `tokens` is the token slice of one function declaration; any slice works.
 */
export function metrics(tokens, lang) {
  const T = tokens.filter((t) => t.k !== 'nl'), N = T.length, m = matchBrackets(T), py = lang === 'py', cs = lang === 'cs';
  let cyclomatic = 1, cognitive = 0, nesting = 0, returns = 0;
  const lines = new Set(), ops = new Map(), operands = new Map();
  // Blocks opened by a control structure, a lambda or a nested function raise the nesting level.
  const stack = []; let level = 0, pendingControl = null, lastBool = null, paren = 0;
  const doBlocks = new Set(); // index of the '}' that closes a `do` body: its `while` is the same decision
  const switchExpr = new Set(); // C# switch expressions: `x switch { a => 1, _ => 2 }`
  for (let i = 0; i < N; i++) {
    const t = T[i], prev = T[i - 1], next = T[i + 1];
    lines.add(t.l);
    if (t.k === 'id' || t.k === 'num' || t.k === 'str') operands.set(t.v, (operands.get(t.v) || 0) + 1);
    else ops.set(t.v, (ops.get(t.v) || 0) + 1);
    if (t.k === 'kw' || (t.k === 'id' && (t.v === 'elif' || t.v === 'except' || t.v === 'foreach' || t.v === 'match' || t.v === 'loop'))) {
      const v = t.v;
      if (v === 'return' || v === 'throw' || v === 'raise') returns++;
      if (v === 'if' || v === 'elif') {
        cyclomatic++;
        const elseIf = v === 'elif' || isKw(prev, 'else');
        cognitive += elseIf ? 1 : 1 + level; pendingControl = 'if';
      } else if (v === 'else') {
        if (!isKw(next, 'if')) { cognitive++; pendingControl = 'else'; }
      } else if (LOOPS.has(v)) {
        if (v === 'while' && isOp(prev, '}') && doBlocks.has(i - 1)) { /* the tail of do { } while (...): already counted */ }
        else { cyclomatic++; cognitive += 1 + level; pendingControl = v; }
      } else if (v === 'do' && !py) { cognitive += 1 + level; pendingControl = 'do'; cyclomatic++; }
      else if (v === 'case') { if (!(py && !isOp(T[i - 1], ';') && !isOp(T[i - 1], '{') && i > 0)) cyclomatic++; }
      else if (v === 'catch' || v === 'except') { cyclomatic++; cognitive += 1 + level; pendingControl = 'catch'; }
      else if (v === 'switch' || v === 'match') {
        if (cs && isOp(next, '{')) switchExpr.add(i + 1); // a switch expression: its arms are counted when the block is read
        else { cognitive += 1 + level; pendingControl = 'switch'; }
      } else if (v === 'when' && cs) cyclomatic++;
      else if (v === 'goto') cognitive++;
      else if ((v === 'and' || v === 'or') && py) { cyclomatic++; if (lastBool !== v) { cognitive++; lastBool = v; } }
      else if ((v === 'function' || v === 'lambda') && i > 0) pendingControl = pendingControl || 'fn'; // a nested function
      continue;
    }
    if (t.k !== 'op') continue;
    const v = t.v;
    if (v === '&&' || v === '||' || v === '??') { cyclomatic++; if (lastBool !== v) { cognitive++; lastBool = v; } }
    else if (v === '?' && isTernary(T, i)) { cyclomatic++; cognitive += 1 + level; }
    else if (v === '(' || v === '[') paren++;
    else if (v === ')' || v === ']') paren = Math.max(0, paren - 1);
    else if (v === ';' || v === '}' || v === '{') lastBool = null;
    if (v === '{' || v === '${') {
      const lambda = isOp(prev, '=>') || (py && pendingControl === 'fn');
      const kind = v === '${' ? null : switchExpr.has(i) ? 'switchexpr' : pendingControl && pendingControl !== 'fn' ? pendingControl : lambda || pendingControl === 'fn' ? 'fn' : null;
      if (kind === 'switchexpr') { // each arm except the discard is a decision
        const close = m[i] > i ? m[i] : N; let d = 0, arms = 0, discard = false;
        for (let j = i + 1; j < close; j++) { const x = T[j]; if (x.k === 'op') { if (x.v === '(' || x.v === '[' || x.v === '{') d++; else if (x.v === ')' || x.v === ']' || x.v === '}') d--; else if (x.v === '=>' && d === 0) { arms++; if (T[j - 1]?.v === '_') discard = true; } } }
        cyclomatic += Math.max(0, arms - (discard ? 1 : 0)); cognitive += 1 + level;
      }
      const nests = kind && kind !== 'switchexpr' && (NESTERS.has(kind) || kind === 'else' || kind === 'fn' || kind === 'if');
      stack.push({ nests: !!nests, kind }); if (nests) { level++; if (kind !== 'fn') nesting = Math.max(nesting, stack.filter((s) => s.nests && s.kind !== 'fn').length); }
      pendingControl = null;
    } else if (v === '}') {
      const top = stack.pop();
      if (top?.nests) level = Math.max(0, level - 1);
      if (top?.kind === 'do') doBlocks.add(i);
    } else if (v === ';' && paren === 0 && pendingControl !== 'do') pendingControl = null; // `if (x) return;` has no block to nest in
  }
  const n1 = ops.size, n2 = operands.size, N1 = [...ops.values()].reduce((a, b) => a + b, 0), N2 = [...operands.values()].reduce((a, b) => a + b, 0);
  const vocabulary = n1 + n2, length = N1 + N2, volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0, difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  const loc = lines.size;
  const maintainability = loc > 0 && volume > 0 ? Math.max(0, Math.min(100, (100 * (171 - 5.2 * Math.log(volume) - 0.23 * cyclomatic - 16.2 * Math.log(loc))) / 171)) : 100;
  return { loc, ntokens: N, cyclomatic, cognitive, nesting, returns, halstead: { n1, n2, N1, N2, vocabulary, length, volume, difficulty, effort: difficulty * volume }, maintainability };
}

/** After minus before, per metric; `before` may be null for a new function. */
export function compare(before, after) {
  const d = {};
  for (const k of ['loc', 'ntokens', 'cyclomatic', 'cognitive', 'nesting', 'returns', 'maintainability']) d[k] = after[k] - (before ? before[k] : 0);
  d.volume = after.halstead.volume - (before ? before.halstead.volume : 0);
  d.isNew = !before;
  return d;
}

/** Each measurement against its threshold: [{ id, label, value, warn, bad, tone }]. */
export function rate(m, params = 0) {
  const row = (id, value) => { const t = THRESHOLDS[id]; return { id, label: t.label, value, warn: t.warn, bad: t.bad, tone: value > t.bad ? 'bad' : value > t.warn ? 'warn' : 'ok' }; };
  return [row('cyclomatic', m.cyclomatic), row('cognitive', m.cognitive), row('nesting', m.nesting), row('loc', m.loc), row('params', Number.isFinite(params) ? params : THRESHOLDS.params.bad + 1)];
}
