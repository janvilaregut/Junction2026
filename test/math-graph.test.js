// The dependency graph and its network measures: every resolution rule on small synthetic repositories in
// C#, JavaScript and Python, and the mathematics (PageRank, reach, percentiles) against values worked by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../server/math/symbols.js';
import { buildGraph, pagerank, reverseReach, forwardReach, centrality, neighbourhood, callSites, STOPLIST } from '../server/math/graph.js';

const repo = (files, opts) => buildGraph(Object.entries(files).map(([p, text]) => parseFile(text, p)), opts);
const uses = (g, id) => [...g.out.get(id)].sort();
const refsOf = (g, id, name) => g.refs.get(id).filter((r) => r.name === name);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ── C# ────────────────────────────────────────────────────────────────────────────────────────────────
const CS = {
  'src/Shop/Cart.cs': `
namespace Shop
{
    public class Cart : Basket
    {
        public int Count { get; set; }
        public Cart() { }
        public Cart(int capacity) { Count = capacity; }
        public int Total() { return Sum(1) + Sum(1, 2) + this.Tax(3) + base.Weight(); }
        private int Sum(int a) { return a; }
        private int Sum(int a, int b) { return a + b; }
        private int Tax(int x) => x * Count;
        public static Cart Make() { return new Cart(5); }
        public override int Weight() { return 1; }
        public int Use() { return Shared(); }
    }
}`,
  'src/Shop/Basket.cs': `
namespace Shop;
public class Basket
{
    public virtual int Weight() { return 0; }
    protected int Shared() { return 2; }
}`,
  'src/Shop/Factory.cs': `
namespace Shop
{
    public static class Factory { public static Cart Create() { return Cart.Make(); } public static int Mode() { return (int)Kind.Big; } }
    public static class Other { public static Cart Create() { return null; } }
    public enum Kind { Small, Big }
    public class User { public Cart Run() { return Factory.Create(); } }
    public partial class Split { public int A() { return B(); } }
    public class Chain : Basket { public Chain() : this(1) { } public Chain(int n) : base() { } }
    public class Init { public int Count { get; set; } public Cart Build() { return new Cart { Count = 3 }; } public int Read() { return Count; } }
}`,
  'src/Shop/Part2.cs': 'namespace Shop { public partial class Split { private int B() { return 1; } } }',
  'src/Tools/A.cs': `
using System.Collections.Generic;
namespace Tools
{
    public class A
    {
        public void Go(Helper h, List<int> list) { h.Assist(1); h.Polish(); h.Rare(); h.Common(); h.ToString(); list.Add(1); }
    }
    public static class Ext { public static int Twist(this string s, int n) { return n; } public static int Plain(string s, int n) { return n; } }
    public class UsesExt { public int Go(string s) { return s.Twist(3) + s.Plain(3); } }
    public class L
    {
        public int Outer(System.Func<int, int> pick)
        {
            int Local(int x) { return x + 1; }
            System.Func<int, int> twice = v => v * 2;
            return Local(1) + pick(2) + twice(3) + Real(4);
        }
        private int Real(int x) { return x; }
        private int Local(int a, int b) { return 0; }
        private int twice(int z) { return z; }
    }
    public class Gen
    {
        public T Make<T>(int n) { return default(T); }
        public int Use(int a, int b, int c, int d) { var m = Make<int>(1); return Count(new Dictionary<int, string>(), 2) + Count(a < b, c > d) + Count(m < 3, 4 > m); }
        private int Count(object a, int b) { return b; }
        private int Count(bool a, bool b, bool c) { return 0; }
    }
}`,
  'src/Tools/B.cs': 'namespace Tools { public class Helper { public void Assist(int n) { } public void Polish() { } } public class Helper2 { public void Assist(int n) { } public void Assist(int a, int b) { } } }',
  'src/Far/C.cs': 'namespace Far { public class X { public void Assist(int n) { } public void Rare() { } public void Common() { } } public class Y { public void Common() { } } public class Z { public void Common() { } } public class W { public void Common() { } } }',
  'src/Util/Same.cs': 'namespace Util { public class P { public int Run() { return Twice(2); } } public static class Q { public static int Twice(int x) { return x * 2; } } }',
  'src/Util/Other.cs': 'namespace Util { public static class R { public static int Twice(int x) { return x; } } }',
};
const cart = (k) => `src/Shop/Cart.cs::Cart.${k}`, fac = (k) => `src/Shop/Factory.cs::${k}`, tool = (k) => `src/Tools/A.cs::${k}`;

test('C# rule 1: same container, overloads chosen by arity, this. and base. calls', () => {
  const g = repo(CS);
  // Sum(1) → the one-parameter overload, Sum(1, 2) → the two-parameter one; base.Weight() is Basket's, never Cart's own override
  assert.deepEqual(uses(g, cart('Total')), ['src/Shop/Basket.cs::Basket.Weight', cart('Sum/1'), cart('Sum/2'), cart('Tax')].sort());
  assert.deepEqual(refsOf(g, cart('Total'), 'Sum').map((r) => [r.args, r.to]), [[1, [cart('Sum/1')]], [2, [cart('Sum/2')]]]);
  assert.ok(!g.out.get(cart('Total')).has(cart('Weight')));
  // a bare call the class does not declare is found in its declared base, across files and namespace styles (block and file-scoped)
  assert.deepEqual(uses(g, cart('Use')), ['src/Shop/Basket.cs::Basket.Shared']);
  // partial class: the other part of the same container, in another file
  assert.deepEqual(uses(g, fac('Split.A')), ['src/Shop/Part2.cs::Split.B']);
});

test('C# bare identifiers: a property of the same container is a use, a member of an object being initialised is not', () => {
  const g = repo(CS);
  assert.deepEqual(uses(g, cart('Tax')), [cart('Count')]);
  assert.deepEqual(uses(g, cart('Cart/1')), [cart('Count')]);
  assert.deepEqual(refsOf(g, cart('Tax'), 'Count').map((r) => r.kind), ['member']);
  assert.deepEqual(uses(g, fac('Init.Read')), [fac('Init.Count')]);
  // `new Cart { Count = 3 }`: Count is Cart's, not Init's; the initialiser calls the parameterless constructor
  assert.deepEqual(uses(g, fac('Init.Build')), ['src/Shop/Cart.cs::Cart', cart('Cart/0')]);
});

test('C# construction: the type and only the constructors that admit the arguments', () => {
  const g = repo(CS);
  assert.deepEqual(uses(g, cart('Make')), ['src/Shop/Cart.cs::Cart', cart('Cart/1')]);
  const [r] = refsOf(g, cart('Make'), 'Cart');
  assert.deepEqual([r.kind, r.args, r.status], ['new', 1, 'resolved']);
  // constructor initialisers: `: this(1)` is the other constructor; `: base()` finds no declared constructor and stays unresolved
  assert.deepEqual(uses(g, fac('Chain.Chain/0')), [fac('Chain.Chain/1')]);
  assert.deepEqual(g.refs.get(fac('Chain.Chain/1')).map((x) => [x.name, x.kind, x.status, x.args]), [['base', 'new', 'unresolved', 0]]);
});

test('C# Type.Member resolves inside that type only, even for a stop-list name; an enum member is a use of the type', () => {
  const g = repo(CS);
  assert.ok(STOPLIST.has('Create'));
  assert.deepEqual(uses(g, fac('User.Run')), [fac('Factory.Create')]); // not Other.Create
  assert.deepEqual(uses(g, fac('Factory.Create')), [cart('Make')]);
  assert.deepEqual(uses(g, fac('Factory.Mode')), [fac('Kind')]);
  assert.deepEqual(refsOf(g, fac('Factory.Mode'), 'Kind').map((r) => [r.kind, r.status]), [['type', 'resolved']]);
});

test('C# member calls on an unknown receiver: rule 4 (namespace), rule 5 (anywhere), ambiguity, stop list', () => {
  const g = repo(CS), go = tool('A.Go');
  // h.Assist(1): both one-parameter Assist in namespace Tools; not the two-parameter overload, not Far.X.Assist
  assert.deepEqual([...refsOf(g, go, 'Assist')[0].to].sort(), ['src/Tools/B.cs::Helper.Assist', 'src/Tools/B.cs::Helper2.Assist/1']);
  assert.deepEqual(refsOf(g, go, 'Polish')[0].to, ['src/Tools/B.cs::Helper.Polish']);
  // h.Rare(): nothing in the namespace, one symbol anywhere → rule 5
  assert.deepEqual(refsOf(g, go, 'Rare')[0].to, ['src/Far/C.cs::X.Rare']);
  // h.Common(): four symbols carry the name, more than maxCandidates = 3 → ambiguous, no edge
  assert.deepEqual(refsOf(g, go, 'Common').map((r) => [r.status, r.to]), [['ambiguous', []]]);
  assert.ok(![...g.out.get(go)].some((id) => id.endsWith('.Common')));
  // ToString and Add are on the stop list: no reference, no edge, but the call sites are kept
  assert.equal(refsOf(g, go, 'ToString').length + refsOf(g, go, 'Add').length, 0);
  assert.deepEqual(callSites(g, 'Add'), [{ from: go, file: 'src/Tools/A.cs', line: 7, args: 1, kind: 'call', to: [], status: 'skipped' }]);
  assert.deepEqual([g.unlinked.get('Common'), g.unlinked.get('ToString'), g.unlinked.get('Add')], [1, 1, 1]);
  assert.equal(g.stats.skipped, 2);
  assert.equal(g.stats.ambiguous, 1);
  // with a larger limit the same call links to all four
  const wide = repo(CS, { maxCandidates: 4 });
  assert.equal(refsOf(wide, go, 'Common')[0].to.length, 4);
});

test('C# rule 3: the same file wins over the rest of the namespace', () => {
  const g = repo(CS);
  assert.deepEqual(uses(g, 'src/Util/Same.cs::P.Run'), ['src/Util/Same.cs::Q.Twice']); // not R.Twice in Other.cs
});

test('C# extension methods take their receiver as first argument; a static method is not called through an instance', () => {
  const g = repo(CS), go = tool('UsesExt.Go');
  assert.deepEqual(uses(g, go), [tool('Ext.Twist')]);
  assert.deepEqual(refsOf(g, go, 'Plain').map((r) => [r.status, r.args]), [['unresolved', 1]]);
});

test('C# locals hide members: a local function, a parameter and a delegate variable are not repository symbols', () => {
  const g = repo(CS);
  assert.deepEqual(uses(g, tool('L.Outer')), [tool('L.Real')]);
  assert.deepEqual(g.refs.get(tool('L.Outer')).map((r) => r.name), ['Real']);
});

test('C# argument counts: explicit generic arguments, generic commas, and the ambiguous `a < b, c > d`', () => {
  const g = repo(CS), use = tool('Gen.Use');
  assert.deepEqual(refsOf(g, use, 'Make').map((r) => [r.args, r.to]), [[1, [tool('Gen.Make')]]]);
  // Count(new Dictionary<int, string>(), 2): two arguments · Count(a < b, c > d): unknown, links to every overload
  // · Count(m < 3, 4 > m): a number cannot be a type argument, so two comparisons, two arguments
  assert.deepEqual(callSites(g, 'Count').map((c) => c.args), [2, null, 2]);
  assert.deepEqual(callSites(g, 'Count').map((c) => c.to.length), [1, 2, 1]);
  assert.deepEqual(uses(g, use), [tool('Gen.Count/2'), tool('Gen.Count/3'), tool('Gen.Make')].sort());
});

// ── JavaScript ────────────────────────────────────────────────────────────────────────────────────────
const JS = {
  'src/money.js': `
export function round2(x) { return Math.round(x * 100) / 100; }
export const half = (x) => x / 2;
export default function format(x) { return String(round2(x)); }
`,
  'src/index.js': `
export { round2 as round } from './money.js';
export * from './cart';
`,
  'src/cart.js': `
import { round2, half as halve } from './money.js';
import format from './money.js';
import * as money from './money.js';
import { readFile } from 'node:fs';
export function subtotal(items) { return round2(items.reduce((s, i) => s + i.price, 0)); }
export function total(cart, ...extra) { return halve(subtotal(cart.items)) + money.round2(1) + format(2) + sum(...extra); }
function sum(a, b) { return a + b; }
export function load(p) { return readFile(p); }
export function fmtAll(items) { return items.map(format); }
export function odd() { return round2(1, 2, 3); }
export class Cart {
  constructor(items) { this.items = items; }
  total() { return this.count() + total(this); }
  count() { return this.items.length; }
  static empty() { return new Cart([]); }
}
export class BigCart extends Cart { count() { return super.count() + 1; } }
`,
  'src/app.js': `
import { round, subtotal, Cart } from './index.js';
export function main(items) { const c = new Cart(items); return round(subtotal(items)) + Cart.empty().count(); }
function readFile(p) { return p; }
`,
  'web/a.js': 'function start() { return helper(1) + far(2); }',
  'web/b.js': 'function helper(n) { return n; }',
  'lib/c.js': 'function far(n) { return n; }\nfunction helper(n) { return -n; }',
  'mod/a.js': 'export function go() { return helper(1); }',
  'cjs/util.js': 'function twice(n) { return n * 2; }\nmodule.exports = { twice };',
  'cjs/main.js': "const util = require('./util');\nconst { twice } = require('./util.js');\nfunction run() { return util.twice(1) + twice(2); }\nmodule.exports = run;",
  'test/cart.test.js': `
import { test } from 'node:test';
import { total } from '../src/cart.js';
test('total works', () => { total({ items: [] }); });
`,
};

test('JavaScript rule 2: named, aliased, default and namespace imports; rule 3: same file', () => {
  const g = repo(JS);
  assert.deepEqual(uses(g, 'src/cart.js::subtotal'), ['src/money.js::round2']);
  // halve → half (alias), subtotal (same file), money.round2 (namespace), format (default import), sum (same file)
  assert.deepEqual(uses(g, 'src/cart.js::total'), ['src/cart.js::subtotal', 'src/cart.js::sum', 'src/money.js::format', 'src/money.js::half', 'src/money.js::round2'].sort());
  assert.deepEqual(uses(g, 'src/money.js::format'), ['src/money.js::round2']);
});

test('JavaScript re-exports: `export { a as b } from` and `export * from`, path resolved without its extension', () => {
  const g = repo(JS);
  assert.deepEqual(uses(g, 'src/app.js::main'), ['src/cart.js::Cart', 'src/cart.js::Cart.constructor', 'src/cart.js::Cart.empty', 'src/cart.js::subtotal', 'src/money.js::round2'].sort());
});

test('JavaScript scoping removes candidates: an import bound outside the repository, and a module with no import', () => {
  const g = repo(JS);
  // readFile is node:fs here; the function of that name in src/app.js is not what is called
  assert.deepEqual(uses(g, 'src/cart.js::load'), []);
  assert.deepEqual(g.refs.get('src/cart.js::load').map((r) => [r.name, r.status]), [['readFile', 'unresolved']]);
  assert.equal(g.in.get('src/app.js::readFile').size, 0);
  // mod/a.js is a module (it exports): an undeclared, unimported `helper` is a global, not web/b.js::helper
  assert.deepEqual(g.refs.get('mod/a.js::go').map((r) => [r.name, r.status, r.to]), [['helper', 'unresolved', []]]);
});

test('JavaScript scripts (no import, no export): rule 4 same directory, rule 5 anywhere', () => {
  const g = repo(JS);
  assert.deepEqual(uses(g, 'web/a.js::start'), ['lib/c.js::far', 'web/b.js::helper']); // not lib/c.js::helper
});

test('JavaScript classes: this., super., new, static members; a bare call never means a method', () => {
  const g = repo(JS);
  // inside the method `total`, `total(this)` is the module function, `this.count()` the method
  assert.deepEqual(uses(g, 'src/cart.js::Cart.total'), ['src/cart.js::Cart.count', 'src/cart.js::total']);
  assert.deepEqual(uses(g, 'src/cart.js::Cart.empty'), ['src/cart.js::Cart', 'src/cart.js::Cart.constructor']);
  assert.deepEqual(uses(g, 'src/cart.js::BigCart.count'), ['src/cart.js::Cart.count']); // super.count(), not itself
});

test('JavaScript: a function passed by name is a use; a lexically bound call links whatever its arity; spread is unknown', () => {
  const g = repo(JS);
  assert.deepEqual(g.refs.get('src/cart.js::fmtAll').map((r) => [r.name, r.kind, r.to]), [['format', 'member', ['src/money.js::format']]]);
  // round2 takes one parameter and is called with three: still that function (JavaScript does not check arity)
  assert.deepEqual(callSites(g, 'round2').filter((c) => c.from === 'src/cart.js::odd').map((c) => [c.args, c.to]), [[3, ['src/money.js::round2']]]);
  assert.deepEqual(callSites(g, 'sum'), [{ from: 'src/cart.js::total', file: 'src/cart.js', line: 7, args: null, kind: 'call', to: ['src/cart.js::sum'], status: 'resolved' }]);
});

test('JavaScript CommonJS: require as a namespace and destructured', () => {
  const g = repo(JS);
  assert.deepEqual(uses(g, 'cjs/main.js::run'), ['cjs/util.js::twice']);
  assert.equal(refsOf(g, 'cjs/main.js::run', 'twice').length, 2);
});

// ── Python ────────────────────────────────────────────────────────────────────────────────────────────
const PY = {
  'pkg/__init__.py': 'from .cart import total\n',
  'pkg/money.py': `
def round2(x):
    return round(x, 2)

class Money:
    def __init__(self, amount):
        self.amount = amount

    def double(self):
        return Money(self.amount * 2)

    def show(self):
        return self.fmt() + str(self.double())

    def fmt(self):
        return round2(self.amount)

class Euro(Money):
    def fmt(self):
        return super().fmt() + 1
`,
  'pkg/cart.py': `
from .money import round2, Money
from . import money as m
import os

def total(items, *rest):
    def helper(x):
        return x
    acc = helper(1)
    return round2(sum(items)) + m.round2(acc) + Money(3).amount + os.getcwd()

def spread(args):
    return total(*args)
`,
  'app.py': `
from pkg import total
from pkg.money import *

def main():
    return total([1]) + round2(2)
`,
};

test('Python: relative imports, a submodule as namespace, self., super(), construction by call, nested def', () => {
  const g = repo(PY);
  assert.deepEqual(uses(g, 'pkg/money.py::Money.double'), ['pkg/money.py::Money', 'pkg/money.py::Money.__init__']);
  assert.deepEqual(uses(g, 'pkg/money.py::Money.show'), ['pkg/money.py::Money.double', 'pkg/money.py::Money.fmt']);
  assert.deepEqual(uses(g, 'pkg/money.py::Money.fmt'), ['pkg/money.py::round2']);
  assert.deepEqual(uses(g, 'pkg/money.py::Euro.fmt'), ['pkg/money.py::Money.fmt']);
  // round2 (imported), m.round2 (submodule), Money(3) (type and __init__); helper is a nested def, sum and os are not the repository's
  assert.deepEqual(uses(g, 'pkg/cart.py::total'), ['pkg/money.py::Money', 'pkg/money.py::Money.__init__', 'pkg/money.py::round2']);
  assert.equal(refsOf(g, 'pkg/cart.py::total', 'round2').length, 2);
  assert.deepEqual(g.refs.get('pkg/cart.py::total').filter((r) => r.status !== 'resolved').map((r) => r.name), ['sum', 'getcwd']);
});

test('Python: a re-export through __init__.py, `import *`, and *args as an unknown argument count', () => {
  const g = repo(PY);
  assert.deepEqual(uses(g, 'app.py::main'), ['pkg/cart.py::total', 'pkg/money.py::round2']);
  assert.deepEqual(callSites(g, 'total').map((c) => [c.from, c.line, c.args]), [['pkg/cart.py::spread', 13, null], ['app.py::main', 6, 1]]);
});

// ── Graph shape ───────────────────────────────────────────────────────────────────────────────────────
test('graph shape: every symbol is a node, in mirrors out, stats count what is there, output is deterministic', () => {
  const g = repo(CS), h = repo(CS);
  assert.equal(g.stats.symbols, g.nodes.size);
  assert.equal(g.nodes.size, 72);
  assert.equal(g.nodes.get('src/Shop/Factory.cs::Kind').kind, 'type');
  let edges = 0;
  for (const [a, set] of g.out) for (const b of set) { edges++; assert.ok(g.in.get(b).has(a)); assert.notEqual(a, b); }
  assert.equal(edges, g.stats.edges);
  let n = 0; for (const list of g.refs.values()) n += list.length;
  assert.equal(n, g.stats.resolved + g.stats.ambiguous + g.stats.unresolved);
  assert.deepEqual(g.byName.get('Twice').map((s) => s.id), ['src/Util/Same.cs::Q.Twice', 'src/Util/Other.cs::R.Twice']);
  assert.equal(g.files.get('src/Shop/Cart.cs').lang, 'cs');
  const flat = (x) => JSON.stringify([[...x.out].map(([k, v]) => [k, [...v]]), [...x.refs], x.stats]);
  assert.equal(flat(g), flat(h));
});

// ── Reach ─────────────────────────────────────────────────────────────────────────────────────────────
// a → b → c → a is a cycle; d → a enters it; c → e leaves it; f calls only itself; lone touches nothing.
const LOOP = { 'loop.js': `
function a() { b(); }
function b() { c(); }
function c() { a(); e(); }
function d() { a(); }
function e() {}
function f() { f(); }
function lone() {}
` };
const id = (n) => `loop.js::${n}`;

test('reach: cycles and strongly connected components, both directions, depth limit', () => {
  const g = repo(LOOP);
  assert.deepEqual([...reverseReach(g, id('e'))], [id('c'), id('b'), id('a'), id('d')]); // breadth-first from e
  assert.deepEqual([...forwardReach(g, id('d'))].sort(), ['a', 'b', 'c', 'e'].map(id));
  assert.deepEqual([...reverseReach(g, id('a'))].sort(), ['b', 'c', 'd'].map(id)); // the start is excluded even inside a cycle
  assert.deepEqual([...reverseReach(g, id('a'), { maxDepth: 1 })].sort(), ['c', 'd'].map(id));
  assert.deepEqual([...forwardReach(g, id('a'), { maxDepth: 2 })].sort(), ['b', 'c'].map(id));
  assert.equal(forwardReach(g, id('lone')).size, 0);
  assert.equal(reverseReach(g, 'nowhere::x').size, 0);
  // recursion is recorded as a reference but is not an edge
  assert.equal(g.out.get(id('f')).size, 0);
  assert.deepEqual(g.refs.get(id('f')).map((r) => [r.status, r.to]), [['resolved', [id('f')]]]);
});

test('reach: includeTests filters test code out of the result', () => {
  const g = repo(JS);
  assert.deepEqual([...reverseReach(g, 'src/cart.js::sum')].sort(), ['src/cart.js::Cart.total', 'src/cart.js::total', 'test/cart.test.js::total works']);
  assert.deepEqual([...reverseReach(g, 'src/cart.js::sum', { includeTests: false })].sort(), ['src/cart.js::Cart.total', 'src/cart.js::total']);
});

// ── PageRank ──────────────────────────────────────────────────────────────────────────────────────────
test('pagerank: the hand-solved four-node graph, to 1e-6', () => {
  // A → B, A → C, B → C, C → A, D → C; d = 0.85, n = 4, no dangling node. With t = (1 - d) / 4 = 0.0375:
  //   rD = t                                   (nobody uses D)
  //   rA = t + d·rC        rB = t + d·rA/2      rC = t + d·(rA/2 + rB + rD)
  // Substituting: rC = 0.10125 + 0.78625·rA, so rA = 0.1235625 + 0.6683125·rA, rA = 0.1235625 / 0.3316875.
  const g = repo({ 'pr.js': 'function A() { B(); C(); }\nfunction B() { C(); }\nfunction C() { A(); }\nfunction D() { C(); }\n' });
  const r = pagerank(g), a = 0.1235625 / 0.3316875;
  close(r.get('pr.js::A'), a);
  close(r.get('pr.js::B'), 0.0375 + 0.425 * a);
  close(r.get('pr.js::C'), 0.10125 + 0.78625 * a);
  close(r.get('pr.js::D'), 0.0375);
  close(r.get('pr.js::A'), 0.3725269, 1e-6); // the decimals, as a check on the algebra above
  close(r.get('pr.js::C'), 0.3941493, 1e-6);
  close([...r.values()].reduce((x, y) => x + y, 0), 1, 1e-12);
  assert.ok(r.residual < 1e-9);
  assert.deepEqual([...r.keys()], ['pr.js::A', 'pr.js::B', 'pr.js::C', 'pr.js::D']); // node order of the graph
});

test('pagerank: a dangling node hands its rank to everyone uniformly', () => {
  // A → B → C, C uses nothing. With k = (1 - d)/3 + d·rC/3: rA = k, rB = k(1 + d), rC = k(1 + d + d²),
  // and the three sum to 1, so k = 1 / (3 + 2d + d²) = 1 / 5.4225.
  const g = repo({ 'chain.js': 'function A() { B(); }\nfunction B() { C(); }\nfunction C() {}\n' });
  const r = pagerank(g), k = 1 / 5.4225;
  close(r.get('chain.js::A'), k, 1e-12);
  close(r.get('chain.js::B'), k * 1.85, 1e-12);
  close(r.get('chain.js::C'), k * 2.5725, 1e-12);
  assert.equal(r.sweeps, 1); // no cycle: forward substitution is exact
  // damping 0: everyone gets 1/n
  for (const v of pagerank(g, { damping: 0 }).values()) close(v, 1 / 3, 1e-12);
});

test('pagerank: equals a plain power iteration on a graph with cycles and dangling nodes', () => {
  // 40 functions; function i calls three others chosen by a fixed Lehmer sequence (exact in doubles); every fifth calls nothing.
  let seed = 7; const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  let src = '';
  for (let i = 0; i < 40; i++) { const calls = i % 5 === 4 ? [] : [rnd(40), rnd(40), rnd(40)]; src += `function f${i}() { ${calls.map((j) => `f${j}();`).join(' ')} }\n`; }
  const g = repo({ 'rand.js': src }), ids = [...g.nodes.keys()], n = ids.length, d = 0.85;
  let r = new Map(ids.map((x) => [x, 1 / n]));
  for (let it = 0; it < 400; it++) {
    const next = new Map(ids.map((x) => [x, 0])); let dangling = 0;
    for (const u of ids) { const out = g.out.get(u); if (!out.size) dangling += r.get(u); else for (const v of out) next.set(v, next.get(v) + r.get(u) / out.size); }
    for (const v of ids) next.set(v, (1 - d) / n + d * (next.get(v) + dangling / n));
    r = next;
  }
  const fast = pagerank(g, { iterations: 400, tol: 1e-14 });
  for (const x of ids) close(fast.get(x), r.get(x), 1e-9);
  assert.ok(fast.residual < 1e-9);
});

test('pagerank: includeTests false ranks production code only', () => {
  const g = repo(JS), r = pagerank(g, { includeTests: false });
  assert.equal(r.get('test/cart.test.js::total works'), 0);
  close([...r.values()].reduce((x, y) => x + y, 0), 1, 1e-12);
  assert.ok(pagerank(g).get('test/cart.test.js::total works') > 0);
});

// ── Centrality ────────────────────────────────────────────────────────────────────────────────────────
test('centrality: fan-in, fan-out, dependents, instability and tied percentiles on the loop graph', () => {
  const g = repo(LOOP), c = centrality(g), of = (n) => c.get(id(n));
  assert.equal(c.mode, 'exact');
  //            a  b  c  d  e  f  lone
  // fanIn      2  1  1  0  1  0  0      (a ← c, d · b ← a · c ← b · e ← c)
  // fanOut     1  1  2  1  0  0  0
  // dependents 3  3  3  0  4  0  0      (the cycle a, b, c reaches itself; d reaches all of it; all four reach e)
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'lone'].map((n) => of(n).fanIn), [2, 1, 1, 0, 1, 0, 0]);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'lone'].map((n) => of(n).fanOut), [1, 1, 2, 1, 0, 0, 0]);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'lone'].map((n) => of(n).dependents), [3, 3, 3, 0, 4, 0, 0]);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'lone'].map((n) => of(n).testedBy), [0, 0, 0, 0, 0, 0, 0]);
  // Martin's instability Ce / (Ca + Ce); undefined (null) for a symbol with no coupling at all
  close(of('a').instability, 1 / 3, 1e-12); close(of('c').instability, 2 / 3, 1e-12);
  assert.equal(of('d').instability, 1); assert.equal(of('e').instability, 0); assert.equal(of('lone').instability, null);
  // Percentiles over the 7 symbols, (mean rank - 1) / 6. fanIn sorted: 0 0 0 1 1 1 2
  //   the three zeros share ranks 1..3 → mean 2 → 1/6 · the three ones share 4..6 → mean 5 → 4/6 · the two → rank 7 → 1
  for (const n of ['d', 'f', 'lone']) close(of(n).fanInPct, 1 / 6, 1e-12);
  for (const n of ['b', 'c', 'e']) close(of(n).fanInPct, 4 / 6, 1e-12);
  assert.equal(of('a').fanInPct, 1);
  // dependents sorted: 0 0 0 3 3 3 4 → the same pattern
  for (const n of ['d', 'f', 'lone']) close(of(n).dependentsPct, 1 / 6, 1e-12);
  for (const n of ['a', 'b', 'c']) close(of(n).dependentsPct, 4 / 6, 1e-12);
  assert.equal(of('e').dependentsPct, 1);
  // pagerank is the production-only ranking, and its percentile orders the same way
  const pr = pagerank(g, { includeTests: false });
  assert.equal(of('e').pagerank, pr.get(id('e')));
  assert.ok(of('d').pagerankPct < of('b').pagerankPct);
});

test('centrality: tests are counted apart, types and test code are not ranked, unlinked names are reported', () => {
  const g = repo(JS), c = centrality(g);
  const total = c.get('src/cart.js::total');
  // total ← Cart.total (production) and ← the test; main → Cart.empty/Cart only, so one production dependent
  assert.deepEqual([total.fanIn, total.directTests, total.dependents, total.testedBy], [1, 1, 1, 1]);
  const round2 = c.get('src/money.js::round2');
  // round2 ← format, subtotal, total, odd, main directly; fmtAll and Cart.total reach it through them
  assert.deepEqual([round2.fanIn, round2.dependents, round2.testedBy, round2.directTests], [5, 7, 1, 0]);
  assert.equal(c.get('src/cart.js::Cart').pagerankPct, null); // a type
  assert.equal(c.get('test/cart.test.js::total works').dependentsPct, null); // test code
  assert.equal(c.get('test/cart.test.js::total works').fanOut, 1);
  // `Cart.empty().count()`: count on an unknown receiver is on the stop list, so both count methods have a lower-bound fan-in
  assert.equal(c.get('src/cart.js::Cart.count').unlinked, 1);
  assert.equal(c.get('src/cart.js::BigCart.count').unlinked, 1);
  assert.equal(round2.unlinked, 0);
});

test('centrality: bit-row propagation equals a breadth-first search from every node; the sampled fallback is exact where asked', () => {
  let seed = 11; const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const files = { 'a/x.js': '', 'a/y.js': '', 'test/z.test.js': '' };
  // 90 functions over two script files and 10 tests; each calls up to three others, so there are cycles and shared callees.
  for (let i = 0; i < 90; i++) { const calls = []; for (let k = rnd(4); k > 0; k--) calls.push(rnd(90)); files[i % 2 ? 'a/x.js' : 'a/y.js'] += `function f${i}() { ${calls.map((j) => `f${j}();`).join(' ')} }\n`; }
  for (let i = 0; i < 10; i++) files['test/z.test.js'] += `test('t${i}', () => { f${rnd(90)}(); f${rnd(90)}(); });\n`;
  const g = repo(files), c = centrality(g);
  assert.equal(c.mode, 'exact');
  assert.ok(g.stats.edges > 100);
  const isTest = (x) => g.nodes.get(x).isTest;
  for (const x of g.nodes.keys()) {
    const up = [...reverseReach(g, x)];
    assert.equal(c.get(x).dependents, up.filter((u) => !isTest(u)).length, x);
    assert.equal(c.get(x).dependents, reverseReach(g, x, { includeTests: false }).size, x);
    assert.equal(c.get(x).testedBy, up.filter(isTest).length, x);
  }
  // no room for the bit rows: exact for the ids asked for and for the sample, unknown elsewhere
  const asked = ['a/x.js::f1', 'a/y.js::f2', 'a/x.js::f89'], s = centrality(g, { exactFor: new Set(asked), maxBytes: 0 });
  assert.equal(s.mode, 'sampled');
  assert.ok(s.sample > 0);
  for (const x of asked) { assert.equal(s.get(x).dependents, c.get(x).dependents); assert.equal(s.get(x).testedBy, c.get(x).testedBy); assert.ok(s.get(x).dependentsPct >= 0 && s.get(x).dependentsPct <= 1); }
  for (const [x, v] of s) { if (v.dependents !== null) assert.equal(v.dependents, c.get(x).dependents); assert.equal(v.fanIn, c.get(x).fanIn); }
});

test('centrality: an empty graph and a single symbol', () => {
  assert.equal(centrality(repo({})).size, 0);
  assert.equal(pagerank(repo({})).size, 0);
  const c = centrality(repo({ 'one.js': 'function only() {}\n' })).get('one.js::only');
  assert.deepEqual([c.fanIn, c.fanOut, c.dependents, c.testedBy, c.pagerank, c.pagerankPct, c.instability], [0, 0, 0, 0, 1, 0.5, null]);
});

// ── Neighbourhood ─────────────────────────────────────────────────────────────────────────────────────
test('neighbourhood: callers and callees up to depth, the highest-scored first, at most max extra nodes', () => {
  const g = repo(LOOP);
  // around a: callers c, d and callee b
  const one = neighbourhood(g, [id('a')]);
  assert.deepEqual(one.nodes[0], id('a'));
  assert.deepEqual([...one.nodes].sort(), ['a', 'b', 'c', 'd'].map(id));
  // every edge among the kept nodes: a→b, b→c, c→a, d→a (c→e is left out with e)
  assert.deepEqual(one.edges.map((e) => e.join('>')).sort(), [`${id('a')}>${id('b')}`, `${id('b')}>${id('c')}`, `${id('c')}>${id('a')}`, `${id('d')}>${id('a')}`].sort());
  // depth 2 reaches e through c
  assert.deepEqual([...neighbourhood(g, [id('a')], { depth: 2 }).nodes].sort(), ['a', 'b', 'c', 'd', 'e'].map(id));
  // max 2 with the default score (number of direct users): b and c have one user, d has none; ties break by id
  assert.deepEqual(neighbourhood(g, [id('a')], { max: 2 }).nodes, [id('a'), id('b'), id('c')]);
  assert.deepEqual(neighbourhood(g, [id('a')], { max: 0 }), { nodes: [id('a')], edges: [] });
  // an explicit score decides instead
  const score = new Map([[id('d'), 9], [id('c'), 5], [id('b'), 1]]);
  assert.deepEqual(neighbourhood(g, [id('a')], { max: 2, score }).nodes, [id('a'), id('d'), id('c')]);
  // the budget is shared across depths and growth continues only from kept nodes: with max 1 nothing at depth 2 is added
  assert.deepEqual(neighbourhood(g, [id('a')], { depth: 2, max: 1, score }).nodes, [id('a'), id('d')]);
  // unknown ids are ignored, duplicates collapse, an isolated node has no neighbours
  assert.deepEqual(neighbourhood(g, ['nope', id('lone'), id('lone')]), { nodes: [id('lone')], edges: [] });
});

// ── Details: parser gaps worked around, and scoping facts that remove candidates ──────────────────────
test('C# details: a one-parameter lambda field, a using alias, new global::, a nested type before its namesakes', () => {
  const g = repo({ 'src/Edge/E.cs': `
using V = Edge.Verifier<Edge.Thing>;
namespace Edge
{
    public class Thing
    {
        private static readonly System.Func<int, int> twice = t => t * 2;
        public int Go() { return twice(4) + V.Check(1) + new global::Edge.Thing().Size(); }
        public int Size() { return Inner.Depth(); }
        private static class Inner { public static int Depth() { return 1; } }
    }
    public class Other { private static class Inner { public static int Depth() { return 2; } } }
    public static class Verifier<T> { public static int Check(int n) { return n; } }
}` });
  const e = (k) => `src/Edge/E.cs::${k}`;
  // `twice = t => …` takes one parameter, so twice(4) is admitted
  assert.equal(g.nodes.get(e('Thing.twice')).maxParams, 1);
  assert.deepEqual(uses(g, e('Thing.Go')), [e('Thing'), e('Thing.Size'), e('Thing.twice'), e('Verifier.Check')]);
  assert.deepEqual(callSites(g, 'Thing'), [{ from: e('Thing.Go'), file: 'src/Edge/E.cs', line: 8, args: 0, kind: 'new', to: [e('Thing')], status: 'resolved' }]);
  // Inner means Thing.Inner inside Thing, not Other.Inner
  assert.deepEqual(uses(g, e('Thing.Size')), [e('Thing.Inner.Depth')]);
});

test('JavaScript details: destructured parameters are locals, an object key is not a use, a shorthand is', () => {
  const g = repo({
    's/a.js': 'function run({ act, end }, [first]) { act(1); first(2); return wrap({ helper: 1, act: 2 }); }\nfunction wrap(o) { return o; }\nfunction helper() {}\nfunction pack() { return { helper }; }\n',
    's/b.js': 'function act(n) { return n; }\nfunction first(n) { return n; }\n',
  });
  // s/a.js is a script, so rule 4 would reach s/b.js: only scoping keeps act and first out
  assert.deepEqual(uses(g, 's/a.js::run'), ['s/a.js::wrap']);
  assert.deepEqual(g.refs.get('s/a.js::run').map((r) => r.name), ['wrap']);
  assert.deepEqual(uses(g, 's/a.js::pack'), ['s/a.js::helper']);
});

test('Python details: a keyword argument is not a use of the function of that name', () => {
  const g = repo({ 'k/m.py': 'def size(x):\n    return x\n\ndef build(size=1):\n    return size\n\ndef call():\n    return build(size=3)\n' });
  assert.deepEqual(uses(g, 'k/m.py::call'), ['k/m.py::build']);
  assert.deepEqual(uses(g, 'k/m.py::build'), []);
  assert.equal(g.in.get('k/m.py::size').size, 0);
});

test('test code: a helper in a test file is neither a production dependent nor a test case', () => {
  const g = repo({
    'lib/core.js': 'export function core() { return 1; }\n',
    'test/helpers.js': "import { core } from '../lib/core.js';\nexport function setup() { return core(); }\n",
    'test/core.test.js': "import { setup } from './helpers.js';\ntest('uses setup', () => { setup(); });\n",
  });
  const c = centrality(g).get('lib/core.js::core');
  // core ← setup (declared in a test file, not a test case) ← the test
  assert.deepEqual([c.fanIn, c.directTests, c.dependents, c.testedBy], [0, 0, 0, 1]);
  assert.deepEqual([...reverseReach(g, 'lib/core.js::core')], ['test/helpers.js::setup', 'test/core.test.js::uses setup']);
  assert.equal(reverseReach(g, 'lib/core.js::core', { includeTests: false }).size, 0);
});

test('JavaScript details: the parameter of `f = x => …` is a local, and the measures accept a graph built by hand', () => {
  const g = repo({ 'v/a.js': 'function x() {}\nconst inc = x => x + 1;\nconst twice = y => { return inc(y) + inc(y); };\n' });
  assert.deepEqual(uses(g, 'v/a.js::inc'), []); // `x` is the lambda's own parameter, not the function x
  assert.deepEqual(uses(g, 'v/a.js::twice'), ['v/a.js::inc']);
  // only nodes, out and in are needed by pagerank, reach, centrality and neighbourhood
  const node = (name) => [name, { id: name, name, kind: 'function', isTest: false, file: 'h.js' }];
  const h = { nodes: new Map(['p', 'q', 'r'].map(node)), out: new Map([['p', new Set(['q'])], ['q', new Set(['r'])], ['r', new Set()]]), in: new Map([['p', new Set()], ['q', new Set(['p'])], ['r', new Set(['q'])]]) };
  close(pagerank(h).get('r'), 2.5725 / 5.4225, 1e-12); // the chain solved by hand above
  assert.deepEqual([...reverseReach(h, 'r')], ['q', 'p']);
  assert.deepEqual(['p', 'q', 'r'].map((k) => centrality(h).get(k).dependents), [0, 1, 2]);
  assert.deepEqual(neighbourhood(h, ['q']), { nodes: ['q', 'r', 'p'], edges: [['q', 'r'], ['p', 'q']] });
  assert.deepEqual(callSites(h, 'q'), []);
});
