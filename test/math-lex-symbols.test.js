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

// Found by the reviewers of the checks module, who had to work around each of these.
test('imports and exports survive what comes before them', () => {
  const p = parseFile('const a = `${x}`;\nimport b from "./b.js";\nexport const c = 1;', 'a.js');
  assert.deepEqual([p.imports.map((i) => i.source), p.exports], [['./b.js'], ['c']], 'a template hole is a bracket pair, not a closing brace');
  assert.deepEqual(parseFile('export const a = 1, b = 2;', 'x.js').exports, ['a', 'b'], 'every declarator of one export');
  assert.deepEqual(parseFile('export const m: Map<string, number> = new Map(), n = 2;', 'x.ts').exports, ['m', 'n'], 'a comma inside type arguments starts nothing');
  assert.deepEqual(parseFile('export let a = f(1, 2)\nexport const b = [1, 2]', 'x.js').exports, ['a', 'b'], 'without semicolons');
});

test('only a literal names a module', () => {
  assert.deepEqual(parseFile("const l = require('./locales/' + name);", 'a.js').imports, []);
  assert.deepEqual(parseFile('const m = await import(`./plugins/${id}.js`);', 'a.js').imports, []);
  assert.deepEqual(parseFile("const m = await import('./a.js');\nconst n = require(`./b.js`);", 'a.js').imports.map((i) => i.source), ['./a.js', './b.js']);
});

test('the names of an import list, one per entry', () => {
  const names = (src, path = 'x.js') => parseFile(src, path).imports[0].names.map((n) => `${n.imported}>${n.local}`);
  assert.deepEqual(names("const { e, h: { i }, k = 1, ...rest } = require('./n');"), ['e>e', 'h>h', 'k>k'], 'a nested pattern reads h; a default value and a rest element import nothing more');
  assert.deepEqual(names("import { 'kebab-name' as kn, plain, other as o } from './t.js';"), ['kebab-name>kn', 'plain>plain', 'other>o']);
  assert.deepEqual(names("import { type T, type as kind, value } from './t.js';", 'x.ts'), ['T>T', 'type>kind', 'value>value']);
  assert.deepEqual(parseFile('function p() {}\nmodule.exports = { p, q: function () { return helper(1); }, get size() { return 1; }, async run() {}, [key]: 2, ...more };', 'x.js').exports, ['p', 'q', 'size', 'run'], 'the keys of the literal, not every word inside it');
});

test('parameters: markers and pseudo-parameters are not arguments', () => {
  const arity = (src, path) => { const s = parseFile(src, path).symbols[0]; return [s.minParams, s.maxParams]; };
  assert.deepEqual(arity('def f(a, /, b, *, c):\n    pass\n', 'a.py'), [3, 3], 'Python / and bare *');
  assert.deepEqual(arity('def f(a, *args, k=1, **kw):\n    pass\n', 'a.py'), [1, Infinity]);
  assert.deepEqual(arity('function n(this: Foo, a: number, b?: string) {}', 'a.ts'), [1, 2], 'TypeScript this');
  assert.deepEqual(arity("function say(html, who = 'ai', src) {}", 'a.js'), [3, 3], 'a required parameter after a default must still be reached by position');
  assert.equal(parseFile('class C { void M(int a, int b = 2, params int[] rest) { } }', 'a.cs').symbols.find((s) => s.name === 'M').minParams, 1);
});

test('decorators and attributes belong to the declaration', () => {
  const py = parseFile('import pytest\n\n@pytest.mark.skip(reason="later")\n@staticmethod\ndef test_s(a):\n    pass\n\ndef plain():\n    pass\n', 'test_a.py');
  const s = py.symbols.find((x) => x.name === 'test_s');
  assert.deepEqual([s.attrs, s.start, py.tokens[s.a].v], [['pytest.mark.skip', 'staticmethod'], 3, '@'], 'a Python declaration starts at its first decorator');
  assert.deepEqual([py.symbols.find((x) => x.name === 'plain').attrs, py.symbols.find((x) => x.name === 'plain').start], [[], 8]);
  const ts = parseFile('class C {\n  @Input() @Output({ alias: "x" })\n  public static run(a) { }\n}', 'x.ts').symbols.find((x) => x.name === 'run');
  assert.deepEqual([ts.attrs, ts.modifiers], [['Input', 'Output'], ['public', 'static']], 'modifiers are read after the decorators and their arguments');
  const k = parseFile('class K { get size() { return 1; } set size(v) { } get() { } }', 'a.js').symbols;
  assert.deepEqual(k.filter((x) => x.kind !== 'type').map((x) => `${x.name}:${x.modifiers.join()}`), ['size:get', 'size:set', 'get:'], 'accessors are marked; a method called get is not one');
});

test('a benchmark is not a test', () => {
  assert.equal(parseFile('class B { [Benchmark] public void Run() { } [Fact] public void Works() { } }', 'B.cs').symbols.find((s) => s.name === 'Run').isTest, false);
  assert.equal(parseFile('class B { [Benchmark] public void Run() { } [Fact] public void Works() { } }', 'B.cs').symbols.find((s) => s.name === 'Works').isTest, true);
  assert.deepEqual(parseFile("bench('fast', () => { run(); });\ntest('ok', () => { run(); });", 'a.js').symbols.map((s) => s.isTest), [false, true]);
});

test('C# using: directives, not declarations', () => {
  const uses = (src) => parseFile(src, 'x.cs').imports.map((i) => (i.ns ? `${i.ns}=` : '') + i.source);
  assert.deepEqual(uses('using System.Text;\nusing static System.Math;\nusing Json = Newtonsoft.Json;\nnamespace A { using B.C; class K { } }'), ['System.Text', 'System.Math', 'Json=Newtonsoft.Json', 'B.C']);
  assert.deepEqual(uses('class C { void M() { using IDisposable d = x; using var e = y; using (var z = w) { } } }'), [], 'a using declaration in a body imports nothing');
  assert.deepEqual(uses('extern alias v2;\nusing v2::Acme.App;\nusing global::System.IO;'), ['Acme.App', 'System.IO'], 'what precedes :: is an alias qualifier');
});

test('a member of a JavaScript class or object may be called anything', () => {
  const names = (src, path) => parseFile(src, path).symbols.filter((s) => s.kind !== 'type').map((s) => `${s.name}/${s.params}`);
  assert.deepEqual(names('class M { get(k) { return 1; } set(k, v) { } add(x) { } static(x) { } default(x) { } with(x) { } delete(k) { } static { init(); } static create() { } }', 'a.js'), ['get/1', 'set/2', 'add/1', 'static/1', 'default/1', 'with/1', 'delete/1', 'create/0']);
  assert.deepEqual(names('const api = { get(k) { return 1; }, set(k, v) { }, remove(x) { } };', 'a.js'), ['get/1', 'set/2', 'remove/1']);
  // A describe() callback is a function body: its statements are not members.
  assert.deepEqual(names("describe('cart', () => {\n  if (ready) { setup(1); }\n  for (const x of xs) { use(x); }\n  it('adds', () => { run(); });\n});", 'cart.test.js'), ['adds/0']);
  assert.deepEqual(names('interface Shape { default int size() { return 0; } int area(); }', 'Shape.java'), ['size/0', 'area/0']);
  assert.deepEqual(names('class C { void M(int x) { switch (x) { case 1: { A(); break; } default: { B(); break; } } if (x > 0) { C(); } } }', 'C.cs'), ['M/1']);
});
