// Deterministic checks: every expected finding below was worked out by hand from the two versions of the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../server/math/symbols.js';
import { langOf } from '../server/math/lex.js';
import { unresolvedImports, arityMismatches, danglingReferences, testWeakening, practices, runChecks } from '../server/math/checks.js';

// ── a pull request in memory ────────────────────────────────────────────────────────────────────────────────
/** Hunks of `git diff -U0` between two texts (longest common subsequence of lines). */
function hunksOf(a, b) {
  const lines = (s) => { const x = s.split('\n'); if (x[x.length - 1] === '') x.pop(); return x; };
  const A = lines(a), B = lines(b), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = []; let i = 0, j = 0, cur = null;
  const open = () => { if (!cur) { cur = { oi: i, nj: j, removed: [], added: [] }; hunks.push(cur); } return cur; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { cur = null; i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) open().removed.push(A[i++]);
    else open().added.push(B[j++]);
  }
  return hunks.map((h) => ({ oldStart: h.removed.length ? h.oi + 1 : h.oi, oldLines: h.removed.length, newStart: h.added.length ? h.nj + 1 : h.nj, newLines: h.added.length, removed: h.removed, added: h.added }));
}

/** The context runChecks receives, built from the files of the merge base and of the head. `renames` maps new path → old path. */
function pr({ base = {}, head = {}, renames = {}, tree = [], manifests } = {}) {
  const parse = (files) => new Map(Object.entries(files).filter(([p]) => langOf(p)).map(([p, t]) => [p, parseFile(t, p)]));
  const diff = [], moved = new Set(Object.values(renames));
  for (const [p, t] of Object.entries(head)) {
    const old = renames[p] || p;
    if (!(old in base)) diff.push({ path: p, oldPath: p, status: 'added', hunks: hunksOf('', t) });
    else if (old !== p || base[old] !== t) diff.push({ path: p, oldPath: old, status: old !== p ? 'renamed' : 'modified', hunks: hunksOf(base[old], t) });
  }
  for (const [p, t] of Object.entries(base)) if (!(p in head) && !moved.has(p)) diff.push({ path: p, oldPath: p, status: 'deleted', hunks: hunksOf(t, '') });
  for (const f of diff) { f.add = f.hunks.reduce((k, h) => k + h.added.length, 0); f.del = f.hunks.reduce((k, h) => k + h.removed.length, 0); }
  return { head: parse(head), base: parse(base), diff, tree: new Set([...Object.keys(head), ...tree]), manifests };
}
const brief = (list) => list.map((f) => `${f.severity} ${f.id} ${f.file}:${f.line}`).sort();
const src = (...lines) => `${lines.join('\n')}\n`;
const pkg = (json, dir = '') => ({ packageJson: [{ dir, json }] });

test('the test harness produces git -U0 hunks', () => {
  assert.deepEqual(hunksOf('a\nb\nc\n', 'a\nx\nc\nd\n'), [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, removed: ['b'], added: ['x'] },
    { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1, removed: [], added: ['d'] },
  ]);
  assert.deepEqual(hunksOf('a\nb\nc\n', 'a\nc\n'), [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, removed: ['b'], added: [] }]);
});

// ── unresolvedImports ───────────────────────────────────────────────────────────────────────────────────────
test('imports: a relative import of a file that is not in the tree is bad, on the line of the import', () => {
  const c = pr({
    base: { 'src/a.js': src("import { x } from './x.js';", 'export const a = x;') , 'src/x.js': src('export const x = 1;') },
    head: { 'src/a.js': src("import { x } from './x.js';", "import { gone } from './missing.js';", 'export const a = x + gone;'), 'src/x.js': src('export const x = 1;') },
  });
  const f = unresolvedImports(c);
  assert.deepEqual(brief(f), ['bad import.missing-file src/a.js:2']);
  assert.equal(f[0].title, 'Import of a file that does not exist');
  assert.match(f[0].detail, /'\.\/missing\.js'/);
  assert.match(f[0].detail, /src\/missing\.js/);
  assert.equal(f[0].symbol, null);
});

test('imports: an import that was already broken before the pull request is not reported', () => {
  const c = pr({
    base: { 'src/a.js': src("import { gone } from './missing.js';", 'export const a = gone;') },
    head: { 'src/a.js': src("import { gone } from './missing.js';", 'export const a = gone + 1;') },
  });
  assert.deepEqual(unresolvedImports(c), []);
});

test('imports: extensions, a TypeScript source behind a .js specifier, index files, JSON and assets all resolve', () => {
  const c = pr({
    head: {
      'src/a.ts': src("import { b } from './b.js';", "import c from './c';", "import d from './dir';", "import e from './data.json';", "import './style.css';", "import f from './vue';", "import('./lazy.js');", "import g from '../outside/of/repo/../../../../x';"),
      'src/b.ts': src('export const b = 1;'), 'src/c.tsx': src('export default 1;'), 'src/dir/index.mjs': src('export default 1;'), 'src/lazy.js': src('export default 1;'),
    },
    tree: ['src/data.json', 'src/style.css', 'src/vue/index.vue'],
  });
  assert.deepEqual(unresolvedImports(c), []);
});

test('imports: a name the target does not export is bad only when the export list is closed', () => {
  const head = {
    'src/lib.js': src('export const a = 1, b = 2;', 'export function f() {}', 'const hidden = 3;', 'export { hidden as shown };', 'export class K {}'),
    'src/star.js': src("export * from './lib.js';", 'export const own = 1;'),
    'src/cjs.js': src('function p() {}', 'module.exports = { p, q: 1 };', 'module.exports.r = 2;'),
    'src/dyn.js': src('module.exports = make();'),
    'src/use.js': src(
      "import { a, b, f, shown, K } from './lib.js';", // all exported: `b` is the second declarator of one statement
      "import { hidden } from './lib.js';", //            line 2: declared, not exported
      "import { nope } from './star.js';", //             export *: the list is open, nothing can be said
      "const { p, q, r } = require('./cjs.js');",
      "const { s } = require('./cjs.js');", //            line 5: not in module.exports
      "const { t } = require('./dyn.js');", //            module.exports = <call>: open
      "import lib from './lib.js';", //                   line 7: no default export in an ES module
      "import cjs from './cjs.js';", //                   a CommonJS module is its own default
      "const { u: { v } } = require('./cjs.js');", //     nested pattern: not a list of names
    ),
  };
  const f = unresolvedImports(pr({ head }));
  assert.deepEqual(brief(f), ['bad import.missing-export src/use.js:2', 'bad import.missing-export src/use.js:5', 'bad import.missing-export src/use.js:7']);
  assert.match(f.find((x) => x.line === 2).detail, /imports 'hidden' from '\.\/lib\.js', but src\/lib\.js exports only K, a, b, f, shown\./);
  assert.match(f.find((x) => x.line === 7).detail, /'default'/);
});

test('imports: deleting a file or an export that an untouched file still imports is a consequence of the pull request', () => {
  const user = src("import { keep, drop } from './lib.js';", "import { z } from './old.js';", 'export const v = keep + drop + z;');
  const c = pr({
    base: { 'src/user.js': user, 'src/lib.js': src('export const keep = 1;', 'export const drop = 2;'), 'src/old.js': src('export const z = 1;') },
    head: { 'src/user.js': user, 'src/lib.js': src('export const keep = 1;') },
  });
  const f = unresolvedImports(c);
  assert.deepEqual(brief(f), ['bad import.missing-export src/user.js:1', 'bad import.missing-file src/user.js:2']);
  assert.match(f.find((x) => x.id === 'import.missing-file').detail, /src\/old\.js existed at the merge base/);
});

test('imports: a renamed file breaks the importers that still use the old path', () => {
  const user = src("import { z } from './old.js';", 'export const v = z;');
  const lib = src('export const z = 1;');
  const c = pr({ base: { 'src/user.js': user, 'src/old.js': lib }, head: { 'src/user.js': user, 'src/new.js': lib }, renames: { 'src/new.js': 'src/old.js' } });
  assert.deepEqual(brief(unresolvedImports(c)), ['bad import.missing-file src/user.js:1']);
});

test('imports: a bare package must be a builtin or be declared between the file and the root', () => {
  const head = {
    'package.json': '{}',
    'packages/app/package.json': '{}',
    'packages/app/src/a.ts': src(
      "import fs from 'fs';", "import { test } from 'node:test';", "import p from 'fs/promises';", "import x from 'node:sqlite';",
      "import a from 'declared-here';", "import b from 'declared-at-root';", "import c from '@scope/pkg/deep/file';", "import d from 'only-types';", "import e from '@me/sibling';",
      "import g from '@/components/x';", "import h from '~/y';", "import i from '#internal';", "import j from 'https://esm.sh/x';", "import k from 'utils/helpers';",
      "import bad from 'left-pad-pro';", //        line 15
      "import worse from '@nope/thing/sub';", //   line 16
      "const lazy = require('not-there');", //     line 17
    ),
    'packages/app/src/utils/helpers.ts': src('export default 1;'),
  };
  const manifests = { packageJson: [
    { dir: '', json: { name: 'root', devDependencies: { 'declared-at-root': '1' } } },
    { dir: 'packages/app', json: { name: '@me/app', dependencies: { 'declared-here': '1', '@scope/pkg': '2' }, devDependencies: { '@types/only-types': '1' } } },
    { dir: 'packages/sibling', json: { name: '@me/sibling' } },
  ] };
  const f = unresolvedImports(pr({ head, manifests, tree: ['packages/sibling/package.json'] }));
  assert.deepEqual(brief(f), ['bad import.undeclared-package packages/app/src/a.ts:15', 'bad import.undeclared-package packages/app/src/a.ts:16', 'bad import.undeclared-package packages/app/src/a.ts:17']);
  assert.equal(f[0].title, 'Package not declared');
  assert.match(f.find((x) => x.line === 16).detail, /'@nope\/thing'/);
});

test('imports: packages — nothing is said without a manifest, about an import that was there before, or when a manifest was not read', () => {
  const a0 = src("import x from 'ghost';", 'export default x;'), a1 = src("import x from 'ghost';", "import y from 'phantom';", 'export default x + y;');
  const declared = pkg({ dependencies: {} });
  // `ghost` was imported and undeclared before: only `phantom` is new.
  assert.deepEqual(brief(unresolvedImports(pr({ base: { 'a.js': a0, 'package.json': '{}' }, head: { 'a.js': a1, 'package.json': '{}' }, manifests: declared }))), ['bad import.undeclared-package a.js:2']);
  assert.deepEqual(unresolvedImports(pr({ base: { 'a.js': a0 }, head: { 'a.js': a1 } })), []); // no manifests at all
  assert.deepEqual(unresolvedImports(pr({ base: { 'a.js': a0 }, head: { 'a.js': a1 }, manifests: {} })), []);
  // A package.json sits next to the file but was not handed over: the root manifest alone decides nothing.
  const nested = pr({ head: { 'sub/a.js': a1, 'sub/package.json': '{}', 'package.json': '{}' }, manifests: pkg({ dependencies: {} }) });
  assert.deepEqual(unresolvedImports(nested), []);
});

test('imports: removing a declaration from package.json breaks the files that still import the package', () => {
  const a = src("import x from 'lodash';", 'export default x;');
  const c = pr({
    base: { 'a.js': a, 'package.json': src('{', '  "dependencies": {', '    "lodash": "^4.17.21"', '  }', '}') },
    head: { 'a.js': a, 'package.json': src('{', '  "dependencies": {', '  }', '}') },
    manifests: pkg({ dependencies: {} }),
  });
  const f = unresolvedImports(c);
  assert.deepEqual(brief(f), ['bad import.undeclared-package a.js:1']);
  assert.equal(f[0].title, 'Package no longer declared');
});

test('imports: Python relative imports must exist; unknown top-level packages are a warning', () => {
  const head = {
    'pkg/__init__.py': src('from .core import run', 'VERSION = "1"'),
    'pkg/core.py': src('def run():', '    pass'),
    'pkg/sub/__init__.py': '',
    'pkg/sub/mod.py': src(
      'import os, sys', 'import json as j', 'from collections import OrderedDict', //  standard library
      'from . import sibling', 'from .sibling import thing', 'from .. import core', 'from ..core import run', 'from .. import VERSION', // all there
      'from .nowhere import x', //            line 9: no pkg/sub/nowhere
      'from ..missing.deep import y', //      line 10: no pkg/missing
      'from .. import absent', //             line 11: not a submodule, and pkg/__init__ never mentions it
      'import yaml', 'import requests.adapters', 'from pkg.core import run as r', // declared (alias), declared, a module of this repository
      'import totally_made_up', //            line 15
      'from another_ghost.x import y', //     line 16
    ),
    'pkg/sub/sibling.py': src('thing = 1'),
  };
  const manifests = { pythonRequirements: new Set(['pyyaml', 'requests']) };
  const f = unresolvedImports(pr({ head, manifests }));
  assert.deepEqual(brief(f), [
    'bad import.missing-module pkg/sub/mod.py:10', 'bad import.missing-module pkg/sub/mod.py:11', 'bad import.missing-module pkg/sub/mod.py:9',
    'warn import.unknown-package pkg/sub/mod.py:15', 'warn import.unknown-package pkg/sub/mod.py:16',
  ]);
  // Without any requirements file there is nothing to compare a top-level package with.
  assert.deepEqual(brief(unresolvedImports(pr({ head }))).filter((x) => x.startsWith('warn')), []);
});

test('imports: a C# using for a namespace nobody declares is a warning; known ones are silent', () => {
  const lib = src('namespace Acme.Core.Util {', '  public class Helper { }', '  namespace Deep { public class D { } }', '}');
  const file = src('namespace Acme.Io;', 'public static class Codec { }');
  const before = src('using System;', 'using Ghost.Old;', 'namespace Acme.App {', '  class P { }', '}');
  const after = src(
    'using System;', 'using Ghost.Old;', //             there before: not reported
    'using System.Collections.Generic;', //             framework root
    'using Acme.Core;', //                              a prefix of a declared namespace
    'using Acme.Core.Util.Deep;', //                    nested block namespaces
    'using Acme.Io;', //                                file-scoped namespace
    'using Nerdbank.Streams;', //                       known root
    'using Contoso.Sdk.Models;', //                     PackageReference Contoso.Sdk
    'using static Acme.Io.Codec;', //                   a type inside a declared namespace
    'using H = Acme.Core.Util.Helper;', //              an alias to a type
    'using Imaginary.Library;', //                      line 11
    'using Acme.Core.Nope;', //                         line 12
    'namespace Acme.App {', '  class P { void M() { using var s = Open(); using IDisposable d = handle; } }', '}',
  );
  const c = pr({ base: { 'src/P.cs': before, 'src/Lib.cs': lib, 'src/Io.cs': file }, head: { 'src/P.cs': after, 'src/Lib.cs': lib, 'src/Io.cs': file }, manifests: { csprojPackages: new Set(['Contoso.Sdk']) } });
  const f = unresolvedImports(c);
  assert.deepEqual(brief(f), ['warn import.unknown-namespace src/P.cs:11', 'warn import.unknown-namespace src/P.cs:12']);
  assert.equal(f[0].title, 'Namespace not found in this repository');
});

test('imports: specifiers that are built at run time, guarded, or resolved by a bundler are left alone', () => {
  const c = pr({
    head: {
      'src/a.js': src(
        "import Comp from './Comp';", //                                         Comp.vue: a bundler's extension list decides
        "import gen from './dist/bundle.js';", //                                line 2: an output folder is usually not committed
        "import util from './Utils.js';", //                                     line 3: utils.js exists
        "const lang = require('./locales/' + name);", //                         a concatenation: only its first piece is a literal
        "let opt; try { opt = require('./optional.js'); } catch { opt = null; }", // its failure is caught
        'const mod = await import(`./plugins/${id}.js`);', //                    a template with a hole
      ),
      'src/utils.js': src('export default 1;'),
    },
    tree: ['src/Comp.vue'],
  });
  const f = unresolvedImports(c);
  assert.deepEqual(brief(f), ['bad import.missing-file src/a.js:3', 'warn import.missing-file src/a.js:2']);
  assert.match(f.find((x) => x.line === 3).detail, /src\/utils\.js differs only in letter case/);
  assert.match(f.find((x) => x.line === 2).basis, /output folder, which is why this is a warning/);
});

test('imports: an export list that cannot be closed from the tokens says nothing', () => {
  const head = {
    'src/view.jsx': src('export const A = () => <div>hi</div>;', 'export const B = 1;'), // JSX: brackets cannot be trusted to balance
    'src/tags.js': src('export const C = () => <b>x</b>;'), //                              JSX inside a .js file
    'src/ns.ts': src('export namespace N { export const inner = 1; }', 'export const outer = 2;'), // an export below the top level
    'src/types.d.ts': src('export const declared: number;'), //                             a declaration file
    'src/use.ts': src("import { Z } from './view.jsx';", "import { Y } from './tags.js';", "import { X } from './ns';", "import { W } from './types';"),
  };
  assert.deepEqual(unresolvedImports(pr({ head })), []);
});

test('imports: an undeclared name the repository already lived with is not new; a resolver config in the diff makes it a warning', () => {
  const old = src("import a from '@app/core';", 'export default a;');
  const fresh = src("import b from '@app/feature';", "import * as vscode from 'vscode';", "import c from 'brand-new-thing';", 'export default [b, vscode, c];');
  const base = { 'package.json': '{}', 'src/old.ts': old };
  // `@app/…` was imported, undeclared, before this pull request (a path alias); `vscode` is provided by its host.
  assert.deepEqual(brief(unresolvedImports(pr({ base, head: { ...base, 'src/new.ts': fresh }, manifests: pkg({ dependencies: {} }) }))), ['bad import.undeclared-package src/new.ts:3']);
  const withConfig = unresolvedImports(pr({ base, head: { ...base, 'src/new.ts': fresh, 'tsconfig.json': '{ "compilerOptions": { "paths": {} } }' }, manifests: pkg({ dependencies: {} }) }));
  assert.deepEqual(brief(withConfig), ['warn import.undeclared-package src/new.ts:3']);
  assert.match(withConfig[0].basis, /resolver configuration that may define it as an alias/);
});

test('imports: a Python import inside try is optional, and a module a build tool writes is only a warning', () => {
  const head = { 'pkg/__init__.py': src(
    'try:', '    from ._speedups import fast', 'except ImportError:', '    fast = None', // guarded
    'from ._version import version', //                                                  line 5: setuptools_scm writes it
    'try:', '    import ujson', 'except ImportError:', '    ujson = None', //             guarded
    'import made_up_pkg', //                                                             line 10
  ) };
  const f = unresolvedImports(pr({ head, manifests: { pythonRequirements: new Set(['requests']) } }));
  assert.deepEqual(brief(f), ['warn import.missing-module pkg/__init__.py:5', 'warn import.unknown-package pkg/__init__.py:10']);
});

// ── arityMismatches ─────────────────────────────────────────────────────────────────────────────────────────
test('arity: a new required parameter breaks the unchanged callers that import the function', () => {
  const caller = src("import { price } from './lib.js';", 'export function total(items) {', '  return items.map((i) => price(i)).length;', '}');
  const c = pr({
    base: { 'src/lib.js': src('export function price(item) {', '  return item.p;', '}'), 'src/caller.js': caller },
    head: { 'src/lib.js': src('export function price(item, currency) {', '  return item.p + currency;', '}'), 'src/caller.js': caller },
  });
  const f = arityMismatches(c);
  assert.deepEqual(brief(f), ['bad arity.mismatch src/caller.js:3']);
  assert.equal(f[0].title, 'Call passes 1 argument, function takes 2');
  assert.equal(f[0].symbol, 'src/caller.js::total');
  assert.match(f[0].detail, /price \(src\/lib\.js:1\) takes 2/);
  assert.match(f[0].basis, /imports price from src\/lib\.js/);
});

test('arity: defaults, optional and rest parameters widen what a JavaScript function accepts; too many is only a warning', () => {
  const head = {
    'src/lib.js': src(
      'export function withDefault(a, b = 1) { return a + b; }',
      'export function rest(a, ...more) { return more.length + a; }',
      'export const single = x => x * 2;',
      'export const pair = (a, b) => a + b;',
      'export function viaArguments() { return arguments.length; }',
    ),
    'src/use.js': src(
      "import { withDefault, rest, single, pair, viaArguments } from './lib.js';",
      'withDefault(1); withDefault(1, 2);', //     1 or 2: fine
      'withDefault();', //                         line 3: the required one is missing
      'withDefault(1, 2, 3);', //                  line 4: one too many, which JavaScript ignores
      'rest(1); rest(1, 2, 3, 4);',
      'rest();', //                                line 6
      'single(1);', //                             one unparenthesised parameter is one parameter
      'single();', //                              line 8
      'pair(...args); pair(1, 2);', //             a spread cannot be counted
      'viaArguments(1, 2, 3);', //                 reads `arguments`: any count
    ),
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['bad arity.mismatch src/use.js:3', 'bad arity.mismatch src/use.js:6', 'bad arity.mismatch src/use.js:8', 'warn arity.mismatch src/use.js:4']);
  assert.equal(f.find((x) => x.line === 3).title, 'Call passes 0 arguments, function takes 1-2');
  assert.equal(f.find((x) => x.line === 4).title, 'Call passes 3 arguments, function takes 1-2');
  assert.equal(f.find((x) => x.line === 6).title, 'Call passes 0 arguments, function takes 1+');
  assert.equal(f.find((x) => x.line === 8).title, 'Call passes 0 arguments, function takes 1');
});

test('arity: a call bound to something else in the file is not a call to the changed function', () => {
  const head = {
    'src/lib.js': src('export function reconcile(a, b) { return a + b; }'),
    'src/param.js': src("import { other } from './lib.js';", 'export function run(reconcile) {', '  return reconcile(1);', '}'), // a parameter of that name
    'src/elsewhere.js': src("import { reconcile } from 'some-package';", 'export const v = reconcile(1);'), //                    imported from another module
    'src/local.js': src('export function run() {', '  const reconcile = (x) => x;', '  return reconcile(1);', '}'), //             a local variable
    'src/member.js': src('export function run(o) {', '  return o.reconcile(1);', '}'), //                                        a method of an unknown receiver
  };
  const f = arityMismatches(pr({ head }));
  // Only the method call on an unknown receiver remains, and only as a name-only warning.
  assert.deepEqual(brief(f), ['warn arity.mismatch src/member.js:2']);
  assert.match(f[0].basis, /Not established: that the call resolves to it, because the receiver's type is not resolved/);
});

test('arity: C# overloads, optional and params parameters, and extension methods are counted conservatively', () => {
  const head = {
    'src/Calc.cs': src(
      'namespace N {',
      '  public class Calc {',
      '    public int Scale(int a) { return a; }',
      '    public int Scale(int a, int b, int c) { return a + b + c; }',
      '    public int Flex(int a, int b = 0, params int[] rest) { return a + b; }',
      '    public int Use() {',
      '      var x = Scale(1) + Scale(1, 2, 3);', //    both overloads
      '      x += Scale(1, 2);', //                     line 8: neither overload takes 2
      '      x += Flex(1) + Flex(1, 2) + Flex(1, 2, 3, 4, 5);',
      '      x += Flex();', //                          line 10: below the minimum
      '      x += Flex(b: 2, a: 1);', //                named arguments are still two arguments
      '      return x;',
      '    }',
      '  }',
      '  public static class Ext {',
      '    public static int Twice(this Calc c, int k) { return k * 2; }',
      '    public static int Go(Calc c) { return c.Twice(3) + Ext.Twice(c, 3); }', // receiver written or not
      '  }',
      '}',
    ),
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['bad arity.mismatch src/Calc.cs:10', 'bad arity.mismatch src/Calc.cs:8']);
  assert.equal(f.find((x) => x.line === 8).title, 'Call passes 2 arguments, no overload takes 2');
  assert.equal(f.find((x) => x.line === 10).title, 'Call passes 0 arguments, function takes 1+');
  assert.equal(f.find((x) => x.line === 8).symbol, 'src/Calc.cs::Calc.Use');
});

test('arity: without a binding only the name matches, and that is a warning backed by what matched before', () => {
  const user = src('namespace N {', '  public class User {', '    public void Go(Engine e, Other o) {', '      e.Ignite(1, 2);', '    }', '  }', '}');
  const engine = (sig) => src('namespace N {', '  public class Engine {', `    public void Ignite(${sig}) { }`, '  }', '}');
  const c = pr({ base: { 'Engine.cs': engine('int a, int b'), 'User.cs': user }, head: { 'Engine.cs': engine('int a, int b, int c'), 'User.cs': user } });
  const f = arityMismatches(c);
  assert.deepEqual(brief(f), ['warn arity.mismatch User.cs:4']);
  assert.equal(f[0].title, 'Call passes 2 arguments, function takes 3');
  assert.match(f[0].basis, /one at the merge base did/);
  // The same call inside a class that inherits from a type outside the repository cannot be bound either: its base may declare Ignite.
  const derived = (sig) => src('namespace N {', '  public class Rocket : ExternalBase {', `    public void Ignite(${sig}) { }`, '    public void Launch() { Ignite(1, 2); }', '  }', '}');
  const d = pr({ base: { 'Rocket.cs': derived('int a, int b') }, head: { 'Rocket.cs': derived('int a, int b, int c') } });
  assert.deepEqual(brief(arityMismatches(d)), ['warn arity.mismatch Rocket.cs:4']);
  // With every base type in the repository the same call is bound, and bad.
  const closed = (sig) => src('namespace N {', '  public class Base { }', '  public class Rocket : Base {', `    public void Ignite(${sig}) { }`, '    public void Launch() { Ignite(1, 2); }', '  }', '}');
  const e = pr({ base: { 'Rocket.cs': closed('int a, int b') }, head: { 'Rocket.cs': closed('int a, int b, int c') } });
  assert.deepEqual(brief(arityMismatches(e)), ['bad arity.mismatch Rocket.cs:5']);
});

test('arity: nothing is said about ubiquitous names, names shared with a type, local functions or unchanged functions', () => {
  const cs = (body) => src('namespace N {', '  public class A {', ...body, '  }', '}');
  // `Add` is on the stoplist.
  assert.deepEqual(arityMismatches(pr({ head: { 'A.cs': cs(['    public void Add(int a, int b) { }', '    public void M() { Add(1); }']) } })), []);
  // A local function of the same name exists somewhere: the symbol table does not know its arity.
  assert.deepEqual(arityMismatches(pr({ head: { 'A.cs': cs(['    public void Compute(int a, int b) { }', '    public void M() { int Compute(int x) { return x; } Compute(1); }']) } })), []);
  // A class called Widget and a method called Widget: `Widget(` may be either.
  assert.deepEqual(arityMismatches(pr({ head: { 'a.py': src('class Widget:', '    pass', 'def make():', '    return Widget(1, 2)'), 'b.py': src('def Widget(a):', '    return a') } })), []);
  // The function did not change and the call was already wrong: not this pull request's doing.
  const old = src('function f(a, b) { return a + b; }', 'export const v = f(1);');
  assert.deepEqual(arityMismatches(pr({ base: { 'a.js': old }, head: { 'a.js': `${old}export const w = 2;\n` } })), []);
});

test('arity: Python counts self, defaults, the / and * markers and *args correctly', () => {
  const head = {
    'm.py': src(
      'def plain(a, b):', '    return a', //                              1-2
      'def marked(a, /, b, *, c=1):', '    return a', //                   3-4: two positional, c by keyword
      'def anything(*args, **kw):', '    return 0', //                     5-6
      'class K:', //                                                       7
      '    def method(self, x):', '        return self.method(x)', //      8-9: bound call with one argument
      '    def broken(self):', '        return self.method()', //          10-11: too few
      'plain(1, 2)', //                                                    12
      'plain(1)', //                                                       13: TypeError at run time
      'marked(1, 2)', 'marked(1, 2, c=3)', //                              14-15
      'anything()', 'anything(1, 2, 3)', //                                16-17
      'plain(*pair)', //                                                   18: star arguments cannot be counted
    ),
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['bad arity.mismatch m.py:11', 'bad arity.mismatch m.py:13']);
  assert.equal(f.find((x) => x.line === 13).title, 'Call passes 1 argument, function takes 2');
  assert.equal(f.find((x) => x.line === 11).title, 'Call passes 0 arguments, function takes 1');
});

test('arity: JavaScript parameters the body tests for absence are optional, and error-path tests are wrong on purpose', () => {
  const head = {
    'src/lib.js': src(
      'export function withOptions(a, options) {', '  options = options || {};', '  return a + options.x;', '}', // 1-2 in practice
      'export function strict(a, b) {', '  return a + b;', '}',
    ),
    'test/lib.test.js': src(
      "import { strict, withOptions } from '../src/lib.js';",
      "test('errors', () => {",
      '  assert.throws(() => strict(1));', //         expects the error
      '  expect(() => strict()).toThrow();', //       expects the error
      '  withOptions(1);', //                         the body handles a missing `options`
      '  strict(1);', //                              line 6
      '});',
    ),
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['bad arity.mismatch test/lib.test.js:6']);
  assert.equal(f[0].title, 'Call passes 1 argument, function takes 2');
});

test('arity: what can and cannot be bound — interfaces, reassigned members, a field of the same name', () => {
  const cs = (...types) => src('namespace N {', ...types, '}');
  // An interface from outside adds no member an unqualified call could find: the call is still bound.
  const disposable = cs('  public class Res : IDisposable {', '    public void Dispose() { }', '    void Step(int a, int b) { }', '    void Go() { Step(1); }', '  }');
  assert.deepEqual(brief(arityMismatches(pr({ head: { 'Res.cs': disposable } }))), ['bad arity.mismatch Res.cs:5']);
  // IOException is a class despite its first letter: its members are not in this repository.
  const derived = cs('  public class Oops : IOException {', '    void Step(int a, int b) { }', '    void Go() { Step(1); }', '  }');
  assert.deepEqual(brief(arityMismatches(pr({ head: { 'Oops.cs': derived } }))), ['warn arity.mismatch Oops.cs:4']);
  // A field called Tick exists somewhere: `Tick(` may invoke it, so only the name-only warning is left.
  const field = cs('  public class A {', '    void Tick(int a) { }', '    void Go() { Tick(); }', '  }', '  public class Info {', '    static readonly MethodInfo Tick = null;', '  }');
  assert.deepEqual(brief(arityMismatches(pr({ head: { 'A.cs': field } }))), ['warn arity.mismatch A.cs:4']);
  // this.render2 is reassigned in the constructor: the method declaration is not what the call reaches.
  const js = src('export class W {', '  constructor(o) { this.render2 = o.render2; }', '  render2(a, b) { return a + b; }', '  go() { return this.render2(1); }', '}');
  assert.deepEqual(arityMismatches(pr({ head: { 'w.js': js } })), []);
  // Without the reassignment the same call is bound to the class's own method.
  assert.deepEqual(brief(arityMismatches(pr({ head: { 'w.js': js.replace('this.render2 = o.render2;', '') } }))), ['bad arity.mismatch w.js:4']);
});

// ── danglingReferences ──────────────────────────────────────────────────────────────────────────────────────
test('dangling: a removed function that an importer still calls is bad, at each call site', () => {
  const user = src("import { keep, legacyRound } from './lib.js';", 'export function total(x) {', '  // legacyRound(x) in a comment does not count', "  const label = 'legacyRound(x)';", '  return keep(legacyRound(x)) + label.length;', '}');
  const c = pr({
    base: { 'src/lib.js': src('export function keep(a) { return a; }', 'export function legacyRound(a) { return Math.round(a); }'), 'src/user.js': user },
    head: { 'src/lib.js': src('export function keep(a) { return a; }'), 'src/user.js': user },
  });
  const f = danglingReferences(c);
  assert.deepEqual(brief(f), ['bad dangling.call src/user.js:5']);
  assert.equal(f[0].title, 'Still called, no longer defined');
  assert.match(f[0].detail, /legacyRound \(src\/lib\.js:2 at the merge base\)/);
  assert.equal(f[0].symbol, 'src/user.js::total');
});

test('dangling: a function that moved, whose file was renamed, or that is still defined in another form is not dangling', () => {
  const user = src("import { helper } from './lib.js';", 'export const v = helper(1);');
  const helper = 'export function helper(a) { return a; }';
  // Moved to another file: still declared at head (the stale import is the import check's business).
  assert.deepEqual(danglingReferences(pr({ base: { 'src/lib.js': src(helper), 'src/user.js': user }, head: { 'src/lib.js': src('export const z = 1;'), 'src/moved.js': src(helper), 'src/user.js': user } })), []);
  // The whole file was renamed.
  assert.deepEqual(danglingReferences(pr({ base: { 'src/lib.js': src(helper), 'src/user.js': user }, head: { 'src/renamed.js': src(helper), 'src/user.js': user }, renames: { 'src/renamed.js': 'src/lib.js' } })), []);
  // Still exported, now as a wrapped constant the symbol table does not list as a function.
  assert.deepEqual(danglingReferences(pr({ base: { 'src/lib.js': src(helper), 'src/user.js': user }, head: { 'src/lib.js': src('export const helper = memo(impl);'), 'src/user.js': user } })), []);
  // Renamed for real, with a caller left behind: that one is dangling.
  const f = danglingReferences(pr({ base: { 'src/lib.js': src(helper), 'src/user.js': user }, head: { 'src/lib.js': src('export function helperV2(a) { return a; }'), 'src/user.js': user } }));
  assert.deepEqual(brief(f), ['bad dangling.call src/user.js:2']);
});

test('dangling: in C# an unqualified call inside a closed type is bad, a call on a receiver is a warning', () => {
  const cls = (members) => src('namespace N {', '  public class Service {', ...members, '  }', '}');
  const other = src('namespace N {', '  public class Client {', '    public int Call(Service s) { return s.Normalize(1); }', '  }', '}');
  const c = pr({
    base: { 'Service.cs': cls(['    internal int Normalize(int a) { return a; }', '    public int Run() { return Normalize(2); }']), 'Client.cs': other },
    head: { 'Service.cs': cls(['    public int Run() { return Normalize(2); }']), 'Client.cs': other },
  });
  const f = danglingReferences(c);
  assert.deepEqual(brief(f), ['bad dangling.call Service.cs:3', 'warn dangling.call Client.cs:3']);
  assert.match(f.find((x) => x.severity === 'warn').basis, /library method of the same name would still resolve/);
});

test('dangling: a name-only call must have been able to reach the removed declaration', () => {
  const cls = (members) => src('namespace N {', '  public class Service {', ...members, '  }', '}');
  const client = (call) => src('namespace N {', '  public class Client {', `    public int Call(Service s) { return ${call}; }`, '  }', '}');
  const run = (decl, call) => brief(danglingReferences(pr({ base: { 'Service.cs': cls([`    ${decl}`]), 'Client.cs': client(call) }, head: { 'Service.cs': cls(['    public int Other() { return 0; }']), 'Client.cs': client(call) } })));
  // A private method was never reachable from another type: that call is somebody else's Normalize.
  assert.deepEqual(run('private int Normalize(int a) { return a; }', 's.Normalize(1)'), []);
  // A static method is reached through the name of its type, not through another receiver …
  assert.deepEqual(run('public static int Normalize(int a) { return a; }', 'Math.Normalize(1)'), []);
  assert.deepEqual(run('public static int Normalize(int a) { return a; }', 'Service.Normalize(1)'), ['warn dangling.call Client.cs:3']);
  // … and with a number of arguments the removed declaration accepted.
  assert.deepEqual(run('public int Normalize(int a) { return a; }', 's.Normalize(1, 2, 3)'), []);
  // When the type itself left the repository, `Type.name(…)` belongs to another library's type of that name.
  const shim = src('namespace Shims {', '  public static class Assert {', '    public static void Equal(object a, object b) { }', '  }', '}');
  const user = src('namespace T {', '  public class Tests {', '    public void M() { Assert.Equal(1, 1); }', '  }', '}');
  assert.deepEqual(danglingReferences(pr({ base: { 'Shim.cs': shim, 'src/User.cs': user }, head: { 'src/User.cs': user } })), []);
  // In JavaScript a function its module never exported was reachable only inside its file.
  const js = (lib) => ({ 'src/lib.js': lib, 'src/other.js': src('export const v = localHelper(1);') });
  assert.deepEqual(danglingReferences(pr({ base: js(src('function localHelper(a) { return a; }', 'export const z = localHelper(2);')), head: js(src('export const z = 2;')) })), []);
});

test('dangling: at most ten call sites are reported for one removed name', () => {
  const calls = Array.from({ length: 14 }, (_, i) => `export const v${i} = obsoleteThing(${i});`);
  const lib = (extra) => src(...extra, ...calls);
  const f = danglingReferences(pr({ base: { 'a.js': lib(['function obsoleteThing(a) { return a; }']) }, head: { 'a.js': lib(['// gone']) } }));
  assert.equal(f.length, 10);
  assert.ok(f.every((x) => x.severity === 'bad' && x.id === 'dangling.call'));
  assert.deepEqual(f.map((x) => x.line), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('dangling: built-ins, star imports and modules with an open export list are not taken as broken', () => {
  // A local stand-in for a runtime global is removed: the calls now reach the global.
  assert.deepEqual(danglingReferences(pr({ base: { 'a.js': src('function fetch(u) { return u; }', "export const v = fetch('x');") }, head: { 'a.js': src("export const v = fetch('x');") } })), []);
  // `from lib import *`: the name may still arrive through the star.
  const star = danglingReferences(pr({ base: { 'lib.py': src('def helper_fn(a):', '    return a'), 'use.py': src('from lib import *', 'x = helper_fn(1)') }, head: { 'lib.py': src('VALUE = 1'), 'use.py': src('from lib import *', 'x = helper_fn(1)') } }));
  assert.deepEqual(brief(star), ['warn dangling.call use.py:2']);
  // The module now re-exports another one wholesale: its export list is open.
  const user = src("import { gadget } from './lib.js';", 'export const v = gadget(1);');
  const open = danglingReferences(pr({ base: { 'src/lib.js': src('export function gadget(a) { return a; }'), 'src/user.js': user }, head: { 'src/lib.js': src("export * from './impl.js';"), 'src/impl.js': src('export const other = 1;'), 'src/user.js': user } }));
  assert.deepEqual(brief(open), ['warn dangling.call src/user.js:2']);
});

// ── testWeakening ───────────────────────────────────────────────────────────────────────────────────────────
const xunit = (...members) => src('using Xunit;', 'namespace T {', '  public class CalcTests {', ...members, '  }', '}');
const fact = (name, ...body) => ['    [Fact]', `    public void ${name}() {`, ...body.map((l) => `      ${l}`), '    }'];

test('tests: a deleted test is bad; a moved, renamed or rewritten-in-place test is not', () => {
  const a = fact('Adds', 'Assert.Equal(3, Calc.Add(1, 2));'), b = fact('Subtracts', 'Assert.Equal(1, Calc.Sub(3, 2));', 'Assert.NotEqual(0, Calc.Sub(3, 2));');
  const removed = testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a, ...b) }, head: { 'tests/CalcTests.cs': xunit(...a) } }));
  assert.deepEqual(brief(removed), ['bad test.removed tests/CalcTests.cs:7']);
  assert.match(removed[0].detail, /Test CalcTests\.Subtracts \(tests\/CalcTests\.cs:8 at the merge base\) is no longer in the file/);
  assert.equal(removed[0].symbol, 'tests/CalcTests.cs::CalcTests');

  // Moved to another file of the suite under the same class and name.
  const moved = pr({ base: { 'tests/CalcTests.cs': xunit(...a, ...b) }, head: { 'tests/CalcTests.cs': xunit(...a), 'tests/MoreCalcTests.cs': xunit(...b) } });
  assert.deepEqual(testWeakening(moved), []);
  // Renamed, body untouched.
  const renamed = pr({ base: { 'tests/CalcTests.cs': xunit(...a, ...b) }, head: { 'tests/CalcTests.cs': xunit(...a, ...fact('SubtractsTwoNumbers', 'Assert.Equal(1, Calc.Sub(3, 2));', 'Assert.NotEqual(0, Calc.Sub(3, 2));')) } });
  assert.deepEqual(testWeakening(renamed), []);
  // Renamed and edited in place: compared with its successor, which lost an assertion.
  const rewritten = pr({ base: { 'tests/CalcTests.cs': xunit(...a, ...b) }, head: { 'tests/CalcTests.cs': xunit(...a, ...fact('SubtractsTwoNumbers', 'Assert.Equal(1, Calc.Sub(3, 2));')) } });
  assert.deepEqual(brief(testWeakening(rewritten)), ['warn test.assertions-removed tests/CalcTests.cs:8']);
  // The whole file deleted.
  const gone = testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a) }, head: {} }));
  assert.deepEqual(brief(gone), ['bad test.removed tests/CalcTests.cs:4']); // its declaration starts at the [Fact] attribute
  assert.equal(gone[0].symbol, null);
  // The whole file renamed: the tests survive under the same names.
  assert.deepEqual(testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a, ...b) }, head: { 'tests/ArithmeticTests.cs': xunit(...a, ...b) }, renames: { 'tests/ArithmeticTests.cs': 'tests/CalcTests.cs' } })), []);
});

test('tests: a test that reappears with the same body in another class of the diff was moved, not removed', () => {
  const cls = (name, ...members) => src('using Xunit;', 'namespace T {', `  public class ${name} {`, ...members, '  }', '}');
  const works = ['Assert.Equal(3, Calc.Add(1, 2));', 'Assert.Equal(5, Calc.Add(2, 3));'];
  const c = pr({
    base: { 'tests/ATests.cs': cls('ATests', ...fact('Works', ...works), ...fact('Stays', 'Assert.True(true);')) },
    head: { 'tests/ATests.cs': cls('ATests', ...fact('Stays', 'Assert.True(true);')), 'tests/BTests.cs': cls('BTests', ...fact('WorksForSmallNumbers', ...works)) },
  });
  assert.deepEqual(testWeakening(c), []);
  // With a different body it is a removal: nothing shows the new test stands in for the old one.
  const d = pr({
    base: { 'tests/ATests.cs': cls('ATests', ...fact('Works', ...works), ...fact('Stays', 'Assert.True(true);')) },
    head: { 'tests/ATests.cs': cls('ATests', ...fact('Stays', 'Assert.True(true);')), 'tests/BTests.cs': cls('BTests', ...fact('Other', 'Assert.Equal(1, Calc.Add(1, 0));')) },
  });
  assert.deepEqual(brief(testWeakening(d)), ['bad test.removed tests/ATests.cs:4']); // the hunk starts after the [Fact] line both tests share
});

test('tests: fewer assertion calls in a test that exists on both sides is a warning with both counts', () => {
  const before = src("import { test } from 'node:test';", "test('adds', () => {", '  expect(add(1, 2)).toBe(3);', '  expect(add(0, 0)).toBe(0);', '  assert.equal(add(-1, 1), 0);', '});', "test('keeps', (t) => {", '  t.is(1, 1);', '});');
  const after = src("import { test } from 'node:test';", "test('adds', () => {", '  expect(add(1, 2)).toBe(3);', '});', "test('keeps', (t) => {", '  t.is(1, 1);', '  t.deepEqual([1], [1]);', '});');
  const f = testWeakening(pr({ base: { 'test/add.test.js': before }, head: { 'test/add.test.js': after } }));
  assert.deepEqual(brief(f), ['warn test.assertions-removed test/add.test.js:2']);
  assert.equal(f[0].title, 'Assertions removed');
  assert.match(f[0].detail, /Test adds makes 1 assertion call at head, down from 3 at the merge base\./);
});

test('tests: a test that gains a skip marker is bad, in every dialect', () => {
  const a = fact('Adds', 'Assert.Equal(3, Calc.Add(1, 2));');
  const skipped = ['    [Fact(Skip = "flaky")]', ...a.slice(1)], ignored = ['    [Fact, Ignore("later")]', ...a.slice(1)];
  const cs1 = testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a) }, head: { 'tests/CalcTests.cs': xunit(...skipped) } }));
  assert.deepEqual(brief(cs1), ['bad test.disabled tests/CalcTests.cs:4']);
  assert.match(cs1[0].detail, /Test CalcTests\.Adds .* gained Skip = "flaky"/);
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a) }, head: { 'tests/CalcTests.cs': xunit(...ignored) } }))), ['bad test.disabled tests/CalcTests.cs:4']);
  // Already skipped before, or a brand-new test written as skipped: nothing that ran stops running.
  assert.deepEqual(testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...skipped) }, head: { 'tests/CalcTests.cs': xunit(...skipped, ...fact('New', 'Assert.True(true);')) } })), []);
  assert.deepEqual(testWeakening(pr({ base: { 'tests/CalcTests.cs': xunit(...a) }, head: { 'tests/CalcTests.cs': xunit(...a, '    [Fact(Skip = "todo")]', '    public void Later() { }') } })), []);

  const js = (lines) => src("describe('cart', () => {", ...lines, '});');
  const one = "  it('adds', () => { expect(1).toBe(1); });", two = "  it('removes', () => { expect(2).toBe(2); });";
  const base = { 'test/cart.test.js': js([one, two]) };
  assert.deepEqual(brief(testWeakening(pr({ base, head: { 'test/cart.test.js': js([one.replace('it(', 'it.skip('), two]) } }))), ['bad test.disabled test/cart.test.js:2']);
  assert.deepEqual(brief(testWeakening(pr({ base, head: { 'test/cart.test.js': js([one, two.replace('it(', 'xit(')]) } }))), ['bad test.disabled test/cart.test.js:3']);
  // A group switched off takes its two tests with it; a test replaced by a todo is reported once.
  const group = testWeakening(pr({ base, head: { 'test/cart.test.js': js([one, two]).replace("describe('cart'", "describe.skip('cart'") } }));
  assert.deepEqual(brief(group), ['bad test.disabled test/cart.test.js:1']);
  assert.match(group[0].detail, /the 2 tests of that group/);
  assert.deepEqual(brief(testWeakening(pr({ base, head: { 'test/cart.test.js': js([one, "  it.todo('removes');"]) } }))), ['bad test.disabled test/cart.test.js:3']);
  // A new placeholder for a test that never existed weakens nothing.
  assert.deepEqual(testWeakening(pr({ base, head: { 'test/cart.test.js': js([one, two, "  it.todo('empties');", "  it.skip('new one', () => {});"]) } })), []);

  const py = (dec) => src('import pytest', ...dec, 'def test_adds():', '    assert add(1, 2) == 3');
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/test_add.py': py([]) }, head: { 'tests/test_add.py': py(['@pytest.mark.skip(reason="later")']) } }))), ['bad test.disabled tests/test_add.py:2']);
  assert.deepEqual(testWeakening(pr({ base: { 'tests/test_add.py': py([]) }, head: { 'tests/test_add.py': py(['@pytest.mark.parametrize("a", [1])']) } })), []);
});

test('tests: an edited expectation is information only when non-test source changes too', () => {
  const t = (expected, name = 'café') => src("test('totals', () => {", `  assert.equal(total(cart), ${expected});`, `  assert.equal(label(cart), '${name}');`, '  assert.ok(cart);', '});');
  const lib0 = src('export const total = (c) => c.sum;'), lib1 = src('export const total = (c) => c.sum * 2;');
  const f = testWeakening(pr({ base: { 'test/t.test.js': t(18), 'src/lib.js': lib0 }, head: { 'test/t.test.js': t(36), 'src/lib.js': lib1 } }));
  assert.deepEqual(brief(f), ['info test.expectation-changed test/t.test.js:2']);
  assert.equal(f[0].title, 'An existing expectation was changed');
  assert.match(f[0].detail, /changed from 18 to 36/);
  // The same edit in a pull request that touches only the test says nothing about the source.
  assert.deepEqual(testWeakening(pr({ base: { 'test/t.test.js': t(18), 'src/lib.js': lib0 }, head: { 'test/t.test.js': t(36), 'src/lib.js': lib0 } })), []);
  // A string expectation, and an untouched one next to it.
  const g = testWeakening(pr({ base: { 'test/t.test.js': t(18), 'src/lib.js': lib0 }, head: { 'test/t.test.js': t(18, 'té'), 'src/lib.js': lib1 } }));
  assert.deepEqual(brief(g), ['info test.expectation-changed test/t.test.js:3']);
  assert.match(g[0].detail, /from 'café' to 'té'/);
});

test('tests: data rows removed from a parameterised test are a warning', () => {
  const theory = (rows) => xunit(...rows.map((r) => `    [InlineData(${r})]`), '    [Theory]', '    public void Scales(int a) { Assert.True(a > 0); }');
  const f = testWeakening(pr({ base: { 'tests/CalcTests.cs': theory([1, 2, 3]) }, head: { 'tests/CalcTests.cs': theory([1]) } }));
  assert.deepEqual(brief(f), ['warn test.cases-removed tests/CalcTests.cs:4']);
  assert.match(f[0].detail, /1 data row at head, down from 3/);
});

// ── practices ───────────────────────────────────────────────────────────────────────────────────────────────
test('practices: an empty catch is a warning; a catch that rethrows, logs, or was already empty is not', () => {
  const cs = (...body) => src('namespace N {', '  public class Io {', '    public void Run() {', ...body, '    }', '  }', '}');
  const empty = ['      try { Go(); }', '      catch (IOException) { }'], commented = ['      try { Go(); }', '      catch (IOException)', '      {', '        // nothing to do', '      }'];
  const rethrow = ['      try { Go(); }', '      catch (IOException) { throw; }'], logged = ['      try { Go(); }', '      catch (IOException e) { Log(e); }'];
  const plain = ['      Go();'];
  const f = practices(pr({ base: { 'src/Io.cs': cs(...plain) }, head: { 'src/Io.cs': cs(...empty) } }));
  assert.deepEqual(brief(f), ['warn practice.error-swallowed src/Io.cs:5']);
  assert.equal(f[0].title, 'Error swallowed');
  assert.match(f[0].detail, /has no code, so what it catches \(IOException\) is discarded in Io\.Run/);
  assert.equal(f[0].symbol, 'src/Io.cs::Io.Run');
  assert.deepEqual(brief(practices(pr({ base: { 'src/Io.cs': cs(...plain) }, head: { 'src/Io.cs': cs(...commented) } }))), ['warn practice.error-swallowed src/Io.cs:5']);
  assert.deepEqual(practices(pr({ base: { 'src/Io.cs': cs(...plain) }, head: { 'src/Io.cs': cs(...rethrow) } })), []);
  assert.deepEqual(practices(pr({ base: { 'src/Io.cs': cs(...plain) }, head: { 'src/Io.cs': cs(...logged) } })), []);
  // Already empty: a new line elsewhere in the method, or a comment added inside it, introduces nothing.
  assert.deepEqual(practices(pr({ base: { 'src/Io.cs': cs(...empty) }, head: { 'src/Io.cs': cs('      Prepare();', ...empty) } })), []);
  assert.deepEqual(practices(pr({ base: { 'src/Io.cs': cs(...empty) }, head: { 'src/Io.cs': cs('      try { Go(); }', '      catch (IOException) { /* fine */ }') } })), []);
  // Emptied by deleting its only statement: a consequence of a removal.
  const emptied = practices(pr({ base: { 'src/Io.cs': cs('      try { Go(); }', '      catch (IOException e)', '      {', '        Log(e);', '      }') }, head: { 'src/Io.cs': cs('      try { Go(); }', '      catch (IOException e)', '      {', '      }') } }));
  assert.deepEqual(brief(emptied), ['warn practice.error-swallowed src/Io.cs:5']);
});

test('practices: except-pass and an empty promise handler are swallowed errors too', () => {
  const py = practices(pr({ head: { 'src/job.py': src('def run():', '    try:', '        go()', '    except ValueError:', '        pass', '    try:', '        go()', '    except Exception as e:', '        log(e)', '    try:', '        go()', '    except: pass') } }));
  assert.deepEqual(brief(py), ['warn practice.error-swallowed src/job.py:12', 'warn practice.error-swallowed src/job.py:4']);
  const js = practices(pr({ head: { 'src/net.js': src('export function ping() {', '  return fetch(url).catch(() => {});', '}', 'export function pong() {', '  return fetch(url).catch((e) => { report(e); });', '}', 'export function pang() {', '  try { go(); } catch { }', '}') } }));
  assert.deepEqual(brief(js), ['warn practice.error-swallowed src/net.js:2', 'warn practice.error-swallowed src/net.js:8']);
});

test('practices: credentials by format or by name are bad; placeholders, references and test files are not', () => {
  const lines = [
    'const awsKey = "AKIAJ5Q7R2D9K4M8N3P6";', //                                  1 AWS access key id
    'const docs = "AKIAIOSFODNN7EXAMPLE";', //                                    the documentation sample
    'const password = "changeme";', 'const apiKey = "<token>";', //                placeholders
    'const secret = "s3cr3t-9f8a7b6c5d4e";', //                                    5 a literal with digits, named secret
    'const apiKey2 = { api_key: "k_9a8b7c6d5e4f3a2b" };', //                       6 a property named api_key
    'const tokenType = "identifier";', 'const nextToken = "whitespace";', //       lexer vocabulary, not credentials
    'const passwordField = "user-password-1";', //                                 the name does not end in a secret word
    'const privateKeyPath = "certs/server.key";', 'const privateKey = "certs/server.key";', // paths
    'const token = process.env.TOKEN;', 'const secretEnv = "MY_SECRET_NAME";', //  references
    'const header = "-----BEGIN RSA PRIVATE KEY-----";', //                        a header alone is what PEM-handling code looks like
    'const pem = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA7bq2n3k9x8v1c5z4m6l0p2o9i8u7y6t5r4e3w2q1";', // 15 key material after the header
    'const auth = "Bearer abcdef0123456789abcdef0123456789";', //                  16 a bearer token
    'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";', // 17
    'const password2 = "correct horse battery staple";', //                        a sentence, not a generated value
    'const PublicKeyToken = "b03f5f7f11d50a3a";', 'const nextPageToken = "abc123def456";', // an assembly identity and a paging cursor
  ];
  const f = practices(pr({ head: { 'src/config.js': src(...lines), 'test/config.test.js': src(...lines) } }));
  assert.deepEqual(brief(f), [1, 15, 16, 17, 5, 6].map((l) => `bad practice.secret src/config.js:${l}`).sort());
  assert.ok(f.every((x) => x.title === 'Secret in the source'));
  // The value is never echoed in full.
  assert.ok(!f.some((x) => x.detail.includes('s3cr3t-9f8a7b6c5d4e') || x.detail.includes('AKIAJ5Q7R2D9K4M8N3P6')));
  assert.match(f.find((x) => x.line === 5).detail, /assigns a string literal to secret: s3cr… \(19 characters\)/);
  // Configuration files are read line by line.
  const env = practices(pr({ head: { 'deploy/.env': src('PORT=8080', 'API_KEY=9f8a7b6c5d4e3f2a1b0c', 'DB_PASSWORD=changeme'), 'deploy/.env.example': src('API_KEY=9f8a7b6c5d4e3f2a1b0c') } }));
  assert.deepEqual(brief(env), ['bad practice.secret deploy/.env:2']);
});

test('practices: debug output is reported in library code, not in entry points, scripts or files that already print', () => {
  const head = {
    'src/lib.js': src('export function f(x) {', "  console.log('x', x);", '  debugger;', '  console.error(x);', '  return x;', '}'),
    'scripts/build.js': src("console.log('building');"),
    'src/cli.js': src("console.log('usage');"),
    'src/Lib.cs': src('namespace N {', '  public class Lib {', '    public void M() { Console.WriteLine("x"); Debug.WriteLine("y"); }', '  }', '}'),
    'src/Program.cs': src('namespace N {', '  public class Program {', '    public static void Main(string[] args) { Console.WriteLine("hello"); }', '  }', '}'),
    'pkg/mod.py': src('def f(x):', '    print(x)', '    return x'),
    'pkg/tool.py': src('def main():', '    print("ok")', 'if __name__ == "__main__":', '    main()'),
  };
  const f = practices(pr({ head }));
  assert.deepEqual(brief(f), ['info practice.debug-output pkg/mod.py:2', 'info practice.debug-output src/Lib.cs:3', 'info practice.debug-output src/lib.js:2', 'info practice.debug-output src/lib.js:3']);
  assert.equal(f.find((x) => x.file === 'src/lib.js' && x.line === 3).title, 'Debugger statement left in the code');
  // A module that already logged to the console keeps doing so: that is its convention, not a leftover.
  const before = src('export function f(x) {', "  console.log('start');", '  return x;', '}'), after = src('export function f(x) {', "  console.log('start');", "  console.log('end');", '  return x;', '}');
  assert.deepEqual(practices(pr({ base: { 'src/lib.js': before }, head: { 'src/lib.js': after } })), []);
});

test('practices: markers and switched-off checks are read from comments, never from strings or identifiers', () => {
  const head = {
    'src/a.ts': src(
      'export function f(x: number) {',
      '  // TODO: handle negatives', //                                 2
      "  const label = 'TODO list'; const XXX = 1;", //                 a string and an identifier
      '  // eslint-disable-next-line no-console', //                    4
      '  // @ts-ignore', //                                             5
      "  const note = '@ts-ignore is bad';",
      '  return x; /* FIXME later */', //                               7
      '}',
    ),
    'src/B.cs': src(
      '#pragma warning disable CS1591, CS0168', //                      1
      '#nullable disable', //                                           2
      'namespace N {',
      '  public class B {',
      '    [SuppressMessage("Style", "IDE0051")]', //                   5
      '    void M() { } // HACK', //                                    6
      '  }',
      '}',
      '#pragma warning restore CS1591',
    ),
    'pkg/c.py': src('import os  # noqa: F401', 'x = compute()  # type: ignore[arg-type]', 'y = "# noqa"', '# XXX revisit'),
  };
  const f = practices(pr({ head }));
  assert.deepEqual(brief(f), [
    'info practice.unfinished-marker pkg/c.py:4', 'info practice.unfinished-marker src/B.cs:6', 'info practice.unfinished-marker src/a.ts:2', 'info practice.unfinished-marker src/a.ts:7',
    'warn practice.check-disabled pkg/c.py:1', 'warn practice.check-disabled pkg/c.py:2', 'warn practice.check-disabled src/B.cs:1', 'warn practice.check-disabled src/B.cs:2', 'warn practice.check-disabled src/B.cs:5',
    'warn practice.check-disabled src/a.ts:4', 'warn practice.check-disabled src/a.ts:5',
  ]);
  assert.match(f.find((x) => x.file === 'src/B.cs' && x.line === 1).detail, /#pragma warning disable CS1591, CS0168/);
  assert.equal(f.find((x) => x.id === 'practice.check-disabled').title, 'A check was switched off');
  assert.equal(f.find((x) => x.id === 'practice.unfinished-marker').title, 'Unfinished marker');
});

test('practices: type-safety escapes and sleeps on added lines are information', () => {
  const head = {
    'src/a.ts': src(
      'export async function f(x: unknown, y: any) {', //                       1 `: any`
      '  const a = x as any;', //                                               2
      '  const b = (x as unknown as string).length;', //                        3
      '  const c = maybe!.value;', //                                           4
      '  if (!a && a !== b) return;', //                                        prefix ! and !== are not escapes
      '  await new Promise((r) => setTimeout(r, 500));', //                     6
      '  await delay(100);', //                                                 7
      '}',
    ),
    'src/B.cs': src(
      'namespace N {',
      '  public class B {',
      '    public string M(object o, string? s) {',
      '      dynamic d = o;', //                                                4
      '      var t = s!.Trim() + ((string)(object)o);', //                      5 two escapes on one line
      '      if (!ready || a != b) Thread.Sleep(100);', //                      6 a sleep; neither `!` is postfix
      '      return t;',
      '    }',
      '  }',
      '}',
    ),
    'pkg/c.py': src('import time', 'def f():', '    time.sleep(1)'),
  };
  const f = practices(pr({ head }));
  assert.deepEqual(brief(f), [
    'info practice.sleep pkg/c.py:3', 'info practice.sleep src/B.cs:6', 'info practice.sleep src/a.ts:6', 'info practice.sleep src/a.ts:7',
    'info practice.type-escape src/B.cs:4', 'info practice.type-escape src/B.cs:5', 'info practice.type-escape src/a.ts:1', 'info practice.type-escape src/a.ts:2', 'info practice.type-escape src/a.ts:3', 'info practice.type-escape src/a.ts:4',
  ]);
  assert.match(f.find((x) => x.file === 'src/B.cs' && x.line === 5).detail, /the null-forgiving operator !, a cast through object/);
});

test('practices: only lines the pull request wrote — untouched, moved and re-indented lines are silent', () => {
  const before = src('export function f(x) {', '  // TODO: old marker', '  const y = x as_any;', '  return y;', '}');
  // The marker line is re-indented and a new line is added: only the new line is the pull request's.
  const after = src('export function f(x) {', '    // TODO: old marker', '  const y = x as_any;', '  // FIXME: new marker', '  return y;', '}');
  assert.deepEqual(brief(practices(pr({ base: { 'src/a.js': before }, head: { 'src/a.js': after } }))), ['info practice.unfinished-marker src/a.js:4']);
  // Deleted files and test files are not read at all.
  assert.deepEqual(practices(pr({ base: { 'src/a.js': before }, head: {} })), []);
  assert.deepEqual(practices(pr({ head: { 'test/a.test.js': src("test('x', () => {", '  // TODO', '  console.log(1);', '});') } })), []);
});

// ── runChecks ───────────────────────────────────────────────────────────────────────────────────────────────
test('runChecks: every finding once, bad before warn before info, then by file and line', () => {
  const head = {
    'src/b.js': src("import { nope } from './lib.js';", 'export function g() {', '  // TODO later', '  return nope;', '}'),
    'src/a.js': src("import x from './missing.js';", 'export function f() {', '  try { x(); } catch { }', "  console.log('f');", '}'),
    'src/lib.js': src('export const yes = 1;'),
  };
  const c = pr({ head });
  const r = runChecks(c);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.findings.map((f) => `${f.severity} ${f.id} ${f.file}:${f.line}`), [
    'bad import.missing-file src/a.js:1',
    'bad import.missing-export src/b.js:1',
    'warn practice.error-swallowed src/a.js:3',
    'info practice.debug-output src/a.js:4',
    'info practice.unfinished-marker src/b.js:3',
  ]);
  for (const f of r.findings) {
    assert.deepEqual(Object.keys(f), ['id', 'severity', 'file', 'line', 'symbol', 'title', 'detail', 'basis']);
    assert.ok(f.title.split(/\s+/).length <= 8, f.title);
    assert.ok(f.detail.length > 0 && f.basis.length > 0);
  }
  assert.equal(r.findings[2].symbol, 'src/a.js::f');
  // Deterministic: the same context, and an equal one, give the same list.
  assert.deepEqual(runChecks(c), r);
  assert.deepEqual(runChecks(pr({ head })), r);
});

test('runChecks: malformed input never throws, and a failing check is recorded instead of hidden', () => {
  for (const bad of [undefined, null, 42, 'x', [], {}, { head: 1, base: 'x', diff: 7, tree: 9, manifests: 3 }, { diff: [null, 5, { path: 3 }, { path: 'a.js', hunks: 'no' }, { path: 'b.js', hunks: [null, { added: 5 }] }] }]) {
    assert.deepEqual(runChecks(bad), { findings: [], errors: [] });
  }
  // A parsed file whose tokens cannot be read: the checks that touch it fail, the others still answer.
  const c = pr({ head: { 'src/a.js': src("import x from './missing.js';", 'export const v = x;') } });
  const broken = { path: 'src/broken.js', lang: 'js', match: [], symbols: [], imports: [], exports: [], get tokens() { throw new Error('unreadable'); } };
  c.head.set('src/broken.js', broken);
  c.diff.push({ path: 'src/broken.js', oldPath: 'src/broken.js', status: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, added: ['x'], removed: [] }] });
  const r = runChecks(c);
  assert.deepEqual(r.findings.map((f) => f.id), ['import.missing-file']);
  assert.deepEqual(r.errors.map((e) => e.check), ['practices']);
  assert.match(r.errors[0].message, /unreadable/);
});
