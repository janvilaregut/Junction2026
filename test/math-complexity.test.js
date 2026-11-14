import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/math/lex.js';
import { metrics, compare, rate, THRESHOLDS } from '../server/math/complexity.js';

const m = (src, lang) => metrics(tokenize(src, lang), lang);

test('straight-line code has one path', () => {
  const r = m('function f(a, b) { const c = a + b; return c; }', 'js');
  assert.equal(r.cyclomatic, 1); assert.equal(r.cognitive, 0); assert.equal(r.nesting, 0); assert.equal(r.returns, 1); assert.equal(r.loc, 1);
});

test('cyclomatic: every decision adds one path (if, else if, loops, case, catch, ternary, && || ??)', () => {
  assert.equal(m('function f(a){ if (a) { x(); } else if (b) { y(); } else { z(); } }', 'js').cyclomatic, 3);
  assert.equal(m('function f(xs){ for (const x of xs) { while (x) { x--; } } }', 'js').cyclomatic, 3);
  assert.equal(m('function f(a){ do { a--; } while (a > 0); }', 'js').cyclomatic, 2, 'do-while is one decision, not two');
  assert.equal(m('function f(a){ switch (a) { case 1: case 2: return 1; default: return 0; } }', 'js').cyclomatic, 3);
  assert.equal(m('function f(a){ try { g(); } catch (e) { h(); } finally { k(); } }', 'js').cyclomatic, 2);
  assert.equal(m('function f(a, b){ return a && b || c ? 1 : a ?? 2; }', 'js').cyclomatic, 5);
});

test('cyclomatic: things that look like decisions and are not', () => {
  assert.equal(m('function f(a){ return a?.b?.c; }', 'js').cyclomatic, 1, 'optional chaining');
  assert.equal(m('function f(a?: number, b?: string): void { g(a, b); }', 'ts').cyclomatic, 1, 'optional parameters');
  assert.equal(m('void F(int? a, List<int?> b) { int? c = null; G(a, b, c); }', 'cs').cyclomatic, 1, 'nullable types');
  assert.equal(m('void F() { var s = "if (a && b) while"; /* if (x) */ G(s); }', 'cs').cyclomatic, 1, 'keywords inside strings and comments');
  assert.equal(m('int F(int x) => x switch { 1 => 10, 2 => 20, _ => 0 };', 'cs').cyclomatic, 3, 'switch expression: each arm but the discard');
  assert.equal(m('void F(object o) { try { G(); } catch (Exception e) when (e is X) { H(); } }', 'cs').cyclomatic, 3, 'catch and its when guard');
});

test('Python reads like the others: elif, and/or, except, comprehensions', () => {
  const src = 'def f(xs, a):\n    if a and xs:\n        return [x for x in xs if x]\n    elif not a or xs:\n        return 1\n    try:\n        g()\n    except ValueError:\n        return 2\n    return 0\n';
  const r = m(src, 'py');
  assert.equal(r.cyclomatic, 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1); // if, and, for, if (comprehension), elif, or, except
  assert.equal(r.returns, 4);
});

test('cognitive complexity: nesting costs more than sequence (Campbell 2018)', () => {
  // if (+1) { for (+2) { if (+3) } }  = 6
  assert.equal(m('function f(a, xs){ if (a) { for (const x of xs) { if (x) { g(); } } } }', 'js').cognitive, 6);
  // three ifs in a row: +1 +1 +1 = 3
  assert.equal(m('function f(a, b, c){ if (a) { g(); } if (b) { g(); } if (c) { g(); } }', 'js').cognitive, 3);
  // else if and else add one each, without the nesting bonus: if +1, else if +1, else +1 = 3
  assert.equal(m('function f(a, b){ if (a) { g(); } else if (b) { h(); } else { k(); } }', 'js').cognitive, 3);
  // a run of the same operator counts once; a change of operator counts again
  assert.equal(m('function f(a, b, c){ return a && b && c; }', 'js').cognitive, 1);
  assert.equal(m('function f(a, b, c){ return a && b || c; }', 'js').cognitive, 2);
  // a lambda raises the level: if inside it is +1 +1
  assert.equal(m('function f(xs){ return xs.map((x) => { if (x) { return 1; } return 0; }); }', 'js').cognitive, 2);
});

test('nesting depth counts control structures, not lambdas or object literals', () => {
  assert.equal(m('function f(a){ if (a) { while (a) { if (a) { g({ k: { v: 1 } }); } } } }', 'js').nesting, 3);
  assert.equal(m('void F() { foreach (var x in xs) { if (x) { G(); } } }', 'cs').nesting, 2);
  assert.equal(m('function f(a){ if (a) return 1; return 0; }', 'js').nesting, 0, 'a body without braces opens no block');
});

test('Halstead and maintainability on a hand-counted function', () => {
  // tokens: function f ( a ) { return a + a ; }  → operators: function ( ) { return + ; } (8 kinds, 8 uses); operands: f a (2 kinds; f×1, a×3)
  const r = m('function f(a) { return a + a; }', 'js');
  assert.deepEqual([r.halstead.n1, r.halstead.n2, r.halstead.N1, r.halstead.N2], [8, 2, 8, 4]);
  assert.ok(Math.abs(r.halstead.volume - 12 * Math.log2(10)) < 1e-9);
  assert.ok(Math.abs(r.halstead.difficulty - (8 / 2) * (4 / 2)) < 1e-9);
  assert.ok(r.maintainability > 0 && r.maintainability <= 100);
  assert.deepEqual(m('', 'js').halstead.volume, 0);
});

test('rate and compare', () => {
  const big = m('function f(a){' + ' if (a) { g(); }'.repeat(22) + ' }', 'js');
  const rows = Object.fromEntries(rate(big, 6).map((r) => [r.id, r.tone]));
  assert.equal(big.cyclomatic, 23);
  assert.deepEqual(rows, { cyclomatic: 'bad', cognitive: 'warn', nesting: 'ok', loc: 'ok', params: 'warn' });
  assert.equal(rate(big, Infinity).find((r) => r.id === 'params').tone, 'bad');
  const d = compare(m('function f(a){ return a; }', 'js'), m('function f(a){ if (a) { return a; } return 0; }', 'js'));
  assert.equal(d.cyclomatic, 1); assert.equal(d.isNew, false);
  assert.equal(compare(null, big).cyclomatic, 23);
  assert.equal(THRESHOLDS.cyclomatic.warn, 10);
});
