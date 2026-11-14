import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, signature, matchBrackets, langOf } from '../server/math/lex.js';
import { parseFile, symbolAt } from '../server/math/symbols.js';

const kv = (src, lang, o) => tokenize(src, lang, o).map((t) => `${t.k}:${t.v}`).join(' ');

test('comments and layout are not tokens; the same program gives the same signature', () => {
  const a = 'function f(a, b) {\n  // adds\n  return a + b; /* done */\n}';
  const b = 'function f(a,b){return a+b;}';
  assert.equal(signature(tokenize(a, 'js')), signature(tokenize(b, 'js')));
  assert.notEqual(signature(tokenize(a, 'js')), signature(tokenize(b.replace('+', '-'), 'js')));
});

test('JavaScript: template holes are code, regular expressions are not division', () => {
  assert.equal(kv('`x${a + `y${b}`}z`', 'js'), 'str:`x op:${ id:a op:+ str:`y op:${ id:b op:} str:` op:} str:z`');
  assert.equal(kv('r = /a[/]b/g.test(s) ? 1 / 2 : 3', 'js'), 'id:r op:= str:/a[/]b/g op:. id:test op:( id:s op:) op:? num:1 op:/ num:2 op:: num:3');
  assert.equal(kv('return\nx', 'js', { nl: true }), 'kw:return nl:\n id:x');
});

test('C#: verbatim, interpolated and raw strings, directives that matter and directives that do not', () => {
  assert.equal(kv('var s = $"a{b.C(1)}d{{e}}";', 'cs'), 'kw:var id:s op:= str:$"a op:{ id:b op:. id:C op:( num:1 op:) op:} str:d{{e}}" op:;');
  assert.equal(kv('x(@"[47,""" + b + @"""]");', 'cs'), 'id:x op:( str:@"[47,""" op:+ id:b op:+ str:@"""]" op:) op:;');
  assert.equal(kv('#if DEBUG\nint x;\n#endif\n#region r\n#pragma warning disable\n', 'cs'), 'pp:#if DEBUG kw:int id:x op:; pp:#endif');
  assert.equal(kv('List<List<int>> y = a >> 2;', 'cs'), 'id:List op:< id:List op:< kw:int op:> op:> id:y op:= id:a op:> op:> num:2 op:;');
  const t = tokenize('var j = """\n{ "a": 1 }\n""";\nint z;', 'cs');
  assert.equal(t.filter((x) => x.k === 'str').length, 1);
  assert.equal(t.at(-2).v, 'z');
});

test('Python layout becomes braces, so blocks have exact extents', () => {
  assert.equal(kv('def f(a,\n      b):\n    if a:\n        return 1\n    return b\n', 'py'), 'kw:def id:f op:( id:a op:, id:b op:) op:: op:{ kw:if id:a op:: op:{ kw:return num:1 op:; op:} kw:return id:b op:; op:}');
  const f = parseFile('class K:\n    def a(self, x, y=2):\n        return x\n\ndef test_it():\n    assert True\n', 'pkg/test_k.py');
  assert.deepEqual(f.symbols.map((s) => [s.key, s.kind, s.start, s.end, s.minParams, s.maxParams, s.isTest]), [['K', 'type', 1, 3, 0, 0, false], ['K.a', 'method', 2, 3, 1, 2, false], ['test_it', 'function', 5, 6, 0, 0, true]]);
});

test('brackets are matched even when the input is not balanced', () => {
  const t = tokenize('f(a[1], {b: (c)})', 'js'), m = matchBrackets(t);
  assert.equal(m[1], t.length - 1);
  assert.equal(matchBrackets(tokenize('f((a)', 'js'))[1], -1);
});

test('C# symbols: overloads, constructors, expression bodies, properties, interface members, tests', () => {
  const src = `using System;
namespace N.M;
public class A : B {
  public int Count { get; private set; }
  public string Name => _n;
  public A(int x) : base(x) { }
  public void Run(int a, string b = "x") { if (a > 0) Go(); }
  public void Run() => Run(1);
  [Fact] public async Task Works() { await Task.Yield(); }
  int this[int i] => i;
  static readonly Func<int, int> Twice = v => v * 2;
}
public interface I { void Do(int a, params object[] rest); }`;
  const f = parseFile(src, 'src/A.cs');
  assert.equal(f.namespace, 'N.M');
  assert.deepEqual(f.imports.map((i) => i.source), ['System']);
  const by = Object.fromEntries(f.symbols.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by), ['A', 'A.Count', 'A.Name', 'A.A', 'A.Run/2', 'A.Run/0', 'A.Works', 'A.this[]', 'A.Twice', 'I', 'I.Do']);
  assert.equal(by['A.A'].kind, 'ctor');
  assert.deepEqual([by['A.Run/2'].minParams, by['A.Run/2'].maxParams, by['A.Run/2'].paramNames], [1, 2, ['a', 'b']]);
  assert.equal(by['A.Works'].isTest, true);
  assert.equal(by['A.Count'].kind, 'property');
  assert.equal(by['I.Do'].abstract, true);
  assert.equal(by['I.Do'].maxParams, Infinity);
  assert.equal(symbolAt(f, 7).key, 'A.Run/2');
  assert.equal(symbolAt(f, 3).key, 'A');
});

test('JavaScript and TypeScript symbols, imports and exports', () => {
  const src = `import {a as b, c} from './x';
import D, * as ns from "y";
const {q, w: e} = require('../z');
export default class Foo extends Bar<T> {
  constructor(private x: number) { super(); }
  async load<T>(id: string, opts?: Opts): Promise<T> { return f(id); }
  static of = (a: number, ...rest: number[]) => { return new Foo(a); };
}
export const add = (a: number, b = 1) => a + b;
export function* gen() { yield 1; }
const api = { run(x) { return x; }, stop: function () {}, go: async (y) => { return y; } };
describe('cart', () => { it('adds', () => { expect(1).toBe(1); }); });
if (x) { y(); }`;
  const f = parseFile(src, 'src/foo.ts');
  assert.deepEqual(f.symbols.map((s) => s.key), ['Foo', 'Foo.constructor', 'Foo.load', 'Foo.of', 'add', 'gen', 'api.run', 'api.stop', 'api.go', 'cart.adds']);
  assert.deepEqual(f.exports, ['default', 'Foo', 'add', 'gen']);
  assert.deepEqual(f.imports.map((i) => [i.source, i.default, i.ns, i.names.map((n) => `${n.imported}>${n.local}`).join('+')]), [['./x', null, null, 'a>b+c>c'], ['y', 'D', 'ns', ''], ['../z', null, null, 'q>q+w>e']]);
  const by = Object.fromEntries(f.symbols.map((s) => [s.key, s]));
  assert.deepEqual([by['Foo.load'].minParams, by['Foo.load'].maxParams], [1, 2]);
  assert.equal(by['Foo.of'].maxParams, Infinity);
  assert.equal(by['cart.adds'].isTest, true);
  assert.equal(by.add.exported, true);
});

test('bugs the dependency-graph review found in this extractor stay fixed', () => {
  const keys = (src, p) => parseFile(src, p).symbols.map((s) => s.key);
  // a declaration that starts with `static` is a declaration; a bare accessor or static block is not
  assert.deepEqual(keys('class A { static int F(int x) { return x; } int G() { return 1; } static A() { } int P { get { return 1; } set { } } }', 'a.cs'), ['A', 'A.F', 'A.G', 'A.A', 'A.P']);
  assert.deepEqual(keys('final class U { static int twice(int x) { return 2 * x; } }', 'U.java'), ['U', 'U.twice']);
  assert.deepEqual(keys('static int helper(int n) { return n; }', 'h.c'), ['helper']);
  assert.deepEqual(keys('class K { static { init(); } static make() { return new K(); } get size() { return 1; } }', 'k.js'), ['K', 'K.make', 'K.size']);
  // `object? a` is a nullable type, not an optional parameter; TypeScript's `a?: T` is optional
  const f = parseFile('class A { void F(object? a, int b) { } void G(int a, int b = 2, params int[] r) { } }', 'a.cs').symbols;
  assert.deepEqual([f[1].minParams, f[1].maxParams, f[2].minParams, f[2].maxParams], [2, 2, 1, Infinity]);
  assert.deepEqual(parseFile('function f(a: number, b?: string) { }', 'f.ts').symbols.map((s) => [s.minParams, s.maxParams]), [[1, 2]]);
  // a lambda with one bare parameter has one parameter
  assert.deepEqual(parseFile('const inc = x => x + 1;\nconst run = y => { return y; };', 'a.js').symbols.map((s) => [s.key, s.params, s.paramNames]), [['inc', 1, ['x']], ['run', 1, ['y']]]);
  assert.deepEqual(parseFile('class A { static readonly System.Func<int, int> twice = t => t * 2; }', 'a.cs').symbols.map((s) => [s.key, s.params]), [['A', 0], ['A.twice', 1]]);
  // block namespaces are recorded like file-scoped ones
  assert.deepEqual(parseFile('namespace N.M { class A { void F() { } } namespace Inner { class B { } } }', 'ns.cs').symbols.map((s) => [s.key, s.ns]), [['A', 'N.M'], ['A.F', 'N.M'], ['B', 'N.M.Inner']]);
  assert.equal(parseFile('namespace N;\nclass A { void F() { } }', 'ns.cs').symbols[1].ns, 'N');
  // an alias to a generic type is an alias
  assert.deepEqual(parseFile('using V = N.Verifier<N.Thing, int>;\nusing W = N.Plain;\nusing System;\nclass A { }', 'al.cs').imports.map((i) => [i.ns, i.source]), [['V', 'N.Verifier'], ['W', 'N.Plain'], [null, 'System']]);
});

test('files the engine does not read as code have no language', () => {
  assert.equal(langOf('README.md'), null);
  assert.equal(langOf('a/b/C.CS'), 'cs');
  assert.equal(parseFile('# hi', 'README.md').symbols.length, 0);
});
