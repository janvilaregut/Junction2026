import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { proveEquivalent, classifyChange, sameUsingSet } from '../server/math/proof.js';

const proved = (a, b, lang, level) => { const r = proveEquivalent(a, b, lang); assert.equal(r.proved, true, `expected a proof: ${r.why}\n--- old\n${a}\n--- new\n${b}`); if (level) assert.equal(r.level, level); return r; };
const refused = (a, b, lang, why) => { const r = proveEquivalent(a, b, lang); assert.equal(r.proved, false, `UNSOUND: certified a change that is not behaviour-preserving (${r.level}: ${r.claim})\n--- old\n${a}\n--- new\n${b}`); if (why) assert.match(r.why, why); return r; };
/** Run a JavaScript function source on inputs; the result or the error message. */
const run = (src, args, globals = {}) => { try { return JSON.stringify(vm.runInNewContext(`(${src})(...${JSON.stringify(args)})`, { ...globals }) ?? null); } catch (e) { return `throws ${e.constructor.name}`; } };

test('identical: comments, indentation, blank lines and re-wrapping are the same program', () => {
  proved('function f(a, b) {\n  // sum\n  return a + b;\n}', 'function f(a,b){return a+b;}', 'js', 'identical');
  proved('function f(a, b) {\n  return g(a,\n    b);\n}', 'function f(a, b) {\n  return g(\n    a,\n    b\n  );\n}', 'js', 'identical');
  proved('const x = a &&\n  b;', 'const x = a\n  && b;', 'js', 'identical');
  proved('if (a) {\n  b();\n}\nelse {\n  c();\n}', 'if (a) {\n  b();\n} else {\n  c();\n}', 'js', 'identical');
  proved('int F(int a)\n{\n    /* old */\n    return a   +   1;\n}', 'int F(int a) { return a + 1; } // new', 'cs', 'identical');
  // Outside JavaScript, TypeScript and C# nothing is certified, not even a moved comment: the review showed the
  // tokenizer misreads strings, layout or comments in each of the other languages.
  refused('def f(a):\n    # note\n    return a + 1\n', 'def f(a):\n    return a + 1  # moved note\n', 'py', /JavaScript, TypeScript and C# only/);
  refused('x = (1,\n     2)\n', 'x = (1, 2)\n', 'py', /only/);
  refused('int f(int a) {\n  // one\n  return a + 1;\n}', 'int f(int a) { return a + 1; }', 'java', /only/);
  refused('func f() int {\n  // one\n  return 1\n}', 'func f() int {\n  return 1\n}', 'go', /only/);
});

test('identical: a changed token is never the same program', () => {
  refused('function f(a){ return a + 1; }', 'function f(a){ return a - 1; }', 'js');
  refused('function f(a){ return a + 1; }', 'function f(a){ return a + 2; }', 'js');
  refused('function f(a){ return "x"; }', 'function f(a){ return "y"; }', 'js');
  refused('function f(a){ g(); return a; }', 'function f(a){ return a; }', 'js');
  refused('void F() {\n#if DEBUG\n  G();\n#endif\n}', 'void F() {\n#if RELEASE\n  G();\n#endif\n}', 'cs');
  refused('def f(a):\n    if a:\n        g()\n    h()\n', 'def f(a):\n    if a:\n        g()\n        h()\n', 'py', undefined);
});

test('JavaScript: a line break that can end a statement is part of the program (automatic semicolon insertion)', () => {
  const a = 'function f(x) {\n  return x + 1;\n}', b = 'function f(x) {\n  return\n  x + 1;\n}';
  refused(a, b, 'js', /line break/); refused(b, a, 'js');
  assert.notEqual(run(a, [1]), run(b, [1]), 'and they really do differ');
  refused('function f(a, b) {\n  a\n  ++b\n  return [a, b];\n}', 'function f(a, b) {\n  a++\n  b\n  return [a, b];\n}', 'js');
  refused('function f(g) {\n  const a = g\n  (1)\n}', 'function f(g) {\n  const a = g(1)\n}', 'js');           // same tokens, but one of them relies on the break? keep both visible
  refused('function f() {\n  let a = 1\n  let b = 2\n  return a + b\n}', 'function f() {\n  let a = 1 let b = 2\n  return a + b\n}', 'js'); // the second is not even valid
  refused('function f(a) {\n  throw a;\n}', 'function f(a) {\n  throw\n  a;\n}', 'js');
  refused('const f = (a) => a;', 'const f = (a)\n=> a;', 'js');
  refused('function f(c) {\n  while (c) { c--; }\n  g();\n}', 'function f(c) {\n  while (c) { c--; } g();\n}', 'js'); // conservative: after } a break may matter
  refused('func f() int {\n  return 1\n}', 'func f() int {\n  return\n  1\n}', 'go');
});

test('alpha: a consistent renaming of locals is proved, and it really behaves the same', () => {
  const a = 'function total(items) {\n  let sum = 0;\n  for (const it of items) { sum += it.price * it.qty; }\n  return sum;\n}';
  const b = 'function total(items) {\n  let acc = 0;\n  for (const line of items) { acc += line.price * line.qty; }\n  return acc;\n}';
  const r = proved(a, b, 'js', 'alpha');
  assert.deepEqual(r.renames, [['sum', 'acc'], ['it', 'line']]);
  for (const args of [[[]], [[{ price: 2, qty: 3 }]], [[{ price: 1.5, qty: 2 }, { price: 4, qty: 1 }]]]) assert.equal(run(a, args), run(b, args));
  proved('function f(a, b) { return a + b; }', 'function f(x, y) { return x + y; }', 'js', 'alpha'); // JS parameters cannot be named by callers
  proved('const f = (xs) => xs.map((x) => x * 2);', 'const f = (xs) => xs.map((v) => v * 2);', 'js', 'alpha');
  proved('const f = (xs) => xs.map(x => { const d = x * 2; return d; });', 'const f = (xs) => xs.map(y => { const e = y * 2; return e; });', 'js', 'alpha');
  // Not in C#: a local's name reaches run time there with no reflection in sight (see the next tests).
  refused('int F(List<int> xs) { var total = 0; foreach (var x in xs) { total += x; } return total; }', 'int F(List<int> xs) { var sum = 0; foreach (var item in xs) { sum += item; } return sum; }', 'cs');
  refused('string F(int a) { var s = a.ToString(); return $"v={s}"; }', 'string F(int a) { var text = a.ToString(); return $"v={text}"; }', 'cs');
  proved('function f(a: number): number { const t: number = a * 2; return t; }', 'function f(a: number): number { const twice: number = a * 2; return twice; }', 'ts', 'alpha');
});

test('alpha is refused whenever a name could be seen from outside or captured', () => {
  // shorthand property: the name becomes the key
  const a1 = 'function f(a) { const total = a * 2; return { total }; }', b1 = 'function f(a) { const sum = a * 2; return { sum }; }';
  refused(a1, b1, 'js', /shorthand/); assert.notEqual(run(a1, [2]), run(b1, [2]));
  // capture: the new name already means something else
  const a2 = 'function f(a) { const t = a + 1; return t + g; }', b2 = 'function f(a) { const g = a + 1; return g + g; }';
  refused(a2, b2, 'js', /already exists/); assert.notEqual(run(a2, [1], { g: 10 }), run(b2, [1], { g: 10 }));
  // a renamed name that is not bound in the function is a global or a field
  refused('function f(a) { return a + limit; }', 'function f(a) { return a + bound; }', 'js', /not declared inside/);
  // a use outside the scope of the declaration refers to something else
  const a3 = 'function f(c) { if (c) { let x = 1; g(x); } return x; }', b3 = 'function f(c) { if (c) { let y = 1; g(y); } return y; }';
  refused(a3, b3, 'js', /outside the scope/);
  refused('function f(n) { for (let i = 0; i < n; i++) { g(i); } return i; }', 'function f(n) { for (let j = 0; j < n; j++) { g(j); } return j; }', 'js', /outside the scope/);
  // swapping two names is not fresh
  refused('function f(a, b) { return a - b; }', 'function f(b, a) { return b - a; }', 'js');
  refused('function f() { let a = 1, b = 2; return a - b; }', 'function f() { let b = 1, a = 2; return b - a; }', 'js', /already exists|still exists/);
  // member with the same name; destructuring; label; object key
  refused('function f(o) { const size = o.size; return size; }', 'function f(o) { const len = o.len; return len; }', 'js', /member/);
  refused('function f(o) { const { size } = o; return size; }', 'function f(o) { const { len } = o; return len; }', 'js');
  refused('function f(o) { const size = 1; return { size: size }; }', 'function f(o) { const len = 1; return { len: len }; }', 'js', /colon/);
  // two names collapsed into one, one name split in two
  refused('function f(a) { const x = a; const y = a + 1; return x + y; }', 'function f(a) { const z = a; const z = a + 1; return z + z; }', 'js', /two names/);
  refused('function f(a) { const x = a; return x + x; }', 'function f(a) { const y = a; return y + z; }', 'js', /two different names/);
  // dynamic lookup
  refused('function f(a) { const x = a; return eval("x"); }', 'function f(a) { const y = a; return eval("x"); }', 'js', /eval/);
  // template text is not code: the string token changes, so it is not even a renaming
  refused('function f(a) { const x = a; return "x=" + x; }', 'function f(a) { const y = a; return "y=" + y; }', 'js');
  // a template HOLE is code and follows the rename
  proved('function f(a) { const x = a; return `v=${x}`; }', 'function f(a) { const y = a; return `v=${y}`; }', 'js', 'alpha');
});

test('no renaming is certified in C#: names there are part of the contract and reach run time', () => {
  refused('int F(int count) { return count + 1; }', 'int F(int n) { return n + 1; }', 'cs'); // callers can pass it by name
  refused('void F() { var total = 1; G(total: total); }', 'void F() { var sum = 1; G(sum: sum); }', 'cs');
  refused('string F() { var total = 1; return nameof(total); }', 'string F() { var sum = 1; return nameof(sum); }', 'cs');
  refused('object F() { var total = 1; return new { total }; }', 'object F() { var sum = 1; return new { sum }; }', 'cs'); // the anonymous type's member is named after the variable
  refused('void F(string value) { var input = value; ArgumentNullException.ThrowIfNull(input); }', 'void F(string value) { var text = value; ArgumentNullException.ThrowIfNull(text); }', 'cs'); // CallerArgumentExpression: the message names the variable
  refused('int F() { var x = 1; return this.x + x; }', 'int F() { var y = 1; return this.y + y; }', 'cs');
  refused('int F() { return count + 1; }', 'int F() { return total + 1; }', 'cs');
  refused('class C { constructor(private x: number) { this.y = x; } }', 'class C { constructor(private z: number) { this.y = z; } }', 'ts');
});

test('holes found while attacking the module stay closed', () => {
  // `return a > limit;` ends like a generic declaration `List<int> x;` but declares nothing: limit is a field
  refused('bool F(int a) { return a > limit; }', 'bool F(int a) { return a > bound; }', 'cs');
  refused('int F(bool c, int a) { return c ? a : fallback; }', 'int F(bool c, int a) { return c ? a : other; }', 'cs');
  refused('int F() { List<int> xs = Make(); return xs.Count; }', 'int F() { List<int> items = Make(); return items.Count; }', 'cs');
  refused('int F() { int? v = Get(); return v ?? 0; }', 'int F() { int? value = Get(); return value ?? 0; }', 'cs');
  // a call or a condition at the start of a snippet is not a parameter list
  refused('foo(a, b);', 'foo(c, b);', 'js', /not declared inside/);
  refused('if (ready) { go(ready); }', 'if (done) { go(done); }', 'js', /not declared inside/);
  refused('helper(x)\n{ use(x); }', 'helper(y)\n{ use(y); }', 'js');
  // array literals and call arguments are fine; object shorthand inside a call is not
  proved('function f(a) { const x = a + 1; return [a, x, g(a, x, 1)]; }', 'function f(a) { const y = a + 1; return [a, y, g(a, y, 1)]; }', 'js', 'alpha');
  refused('function f(a) { const x = a + 1; return g({ x }); }', 'function f(a) { const y = a + 1; return g({ y }); }', 'js', /shorthand/);
  // the renaming proof can be switched off for text that is not a function
  assert.equal(proveEquivalent('function f(a) { let x = a; return x; }', 'function f(a) { let y = a; return y; }', 'js', { alpha: false }).proved, false);
  // var is function-scoped: a use after its block is the same variable, but the block-scope model refuses (safe side)
  refused('function f() { { var x = 1; } return x; }', 'function f() { { var y = 1; } return y; }', 'js', /outside the scope/);
  // Java parameters cannot be named by callers; C# ones can
  refused('int f(int count) { return count + 1; }', 'int f(int n) { return n + 1; }', 'java', /only/); // -parameters, records and anonymous classes expose names
});

test('renaming is not certified for languages whose scoping the engine does not model', () => {
  refused('def f(a):\n    total = a + 1\n    return total\n', 'def f(a):\n    s = a + 1\n    return s\n', 'py', undefined);
  refused('fn f(a: i32) -> i32 { let t = a + 1; t }', 'fn f(a: i32) -> i32 { let u = a + 1; u }', 'rs');
});

test('differential check: every renaming or re-layout the module certifies behaves identically', () => {
  const base = [
    'function f(a, b) { let r = 0; for (let i = 0; i < a; i++) { r += i * b; } return r; }',
    'function f(a, b) { const xs = [a, b, a + b]; return xs.filter((x) => x > 1).map((x) => x * 2); }',
    'function f(a, b) { if (a > b) { const d = a - b; return d; } else { const d = b - a; return -d; } }',
    'function f(a, b) { let s = ""; for (const c of String(a)) { s = c + s; } return s + b; }',
  ];
  const names = ['r', 'i', 'xs', 'x', 'd', 's', 'c', 'a', 'b'], fresh = ['q1', 'q2', 'q3'];
  let certified = 0, tried = 0;
  for (const src of base) for (const from of names) for (const to of [...fresh, ...names]) {
    if (from === to || !new RegExp(`\\b${from}\\b`).test(src)) continue;
    const renamed = src.replace(new RegExp(`\\b${from}\\b`, 'g'), to); tried++;
    for (const variant of [renamed, renamed.replace(/; /g, ';\n  ').replace(/\{ /g, '{\n  ')]) {
      const r = proveEquivalent(src, variant, 'js');
      if (!r.proved) continue;
      certified++;
      for (const args of [[0, 0], [3, 2], [5, 9], [12, -4]]) assert.equal(run(variant, args), run(src, args), `UNSOUND (${r.level}): ${from} → ${to}\n${src}\n${variant}`);
    }
  }
  assert.ok(tried > 60 && certified > 20, `${certified} certified of ${tried} renamings`);
});

test('classifyChange labels what kind of edit it was; literals are a label, not a proof', () => {
  assert.equal(classifyChange('function f(){ return 1; } // a', 'function f(){ return 1; }', 'js').kind, 'identical');
  assert.equal(classifyChange('function f(){ let a = 1; return a; }', 'function f(){ let b = 1; return b; }', 'js').kind, 'alpha');
  const s = classifyChange('function f(){ throw new Error("bad"); }', 'function f(){ throw new Error("worse"); }', 'js');
  assert.deepEqual([s.kind, s.onlyStrings, s.onlyNumbers], ['literals', true, false]);
  const n = classifyChange('const f = () => 10;', 'const f = () => 12;', 'js');
  assert.deepEqual([n.kind, n.onlyNumbers], ['literals', true]);
  const l = classifyChange('function f(a){ return a; }', 'function f(a){ if (a) { return a; } return 0; }', 'js');
  assert.equal(l.kind, 'logic'); assert.equal(l.changed, 9); // if ( a ) { } return 0 ; inserted
  assert.equal(classifyChange('a b c d', 'a x c d', 'js').changed, 2);
});

test('C# using directives: order does not matter, the set does', () => {
  const a = 'using System;\nusing System.Linq;\nnamespace N { class C { } }', b = 'using System.Linq;\nusing System;\nnamespace N { class C { } }';
  assert.equal(sameUsingSet(a, b).proved, true);
  assert.equal(sameUsingSet(a, 'using System;\nusing System.Text;\nnamespace N { class C { } }').proved, false);
  assert.equal(sameUsingSet(a, 'using System.Linq;\nusing System;\nnamespace N { class D { } }').proved, false);
  assert.equal(sameUsingSet('class C { }', 'class C { }').proved, false, 'nothing to say when there are no usings');
});
