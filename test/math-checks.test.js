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
      "const { u: { v } } = require('./cjs.js');", //     line 9: a nested pattern still reads `u`, which is not exported
    ),
  };
  const f = unresolvedImports(pr({ head }));
  assert.deepEqual(brief(f), ['bad import.missing-export src/use.js:2', 'bad import.missing-export src/use.js:5', 'bad import.missing-export src/use.js:7', 'bad import.missing-export src/use.js:9']);
  assert.match(f.find((x) => x.line === 9).detail, /imports 'u' from '\.\/cjs\.js'/);
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

test('imports: C# namespaces — package punctuation, what was imported before, and one finding per namespace', () => {
  const file = (...usings) => src(...usings, 'namespace Acme.App {', '  class P { }', '}');
  const base = { 'src/Old.cs': file('using Legacy.Vendor.Api;') };
  const head = {
    ...base,
    'src/A.cs': file('using ProtoBuf;', 'using Legacy.Vendor.Api;', 'using Made.Up.Space;'), // protobuf-net brings ProtoBuf; Legacy.* compiled before; line 3 is new
    'src/B.cs': file('using Made.Up.Space;'), 'src/C.cs': file('using Made.Up.Space;'),
    'src/D.cs': file('extern alias v2;', 'using v2::Acme.App;', 'using MBrace.FsPickler;'), // an extern alias in front of a declared namespace; FsPickler brings MBrace.FsPickler
  };
  const f = unresolvedImports(pr({ base, head, manifests: { csprojPackages: new Set(['protobuf-net', 'FsPickler']) } }));
  assert.deepEqual(brief(f), ['warn import.unknown-namespace src/A.cs:3']);
  assert.match(f[0].detail, /\(and 2 more files of this pull request\)\.$/);
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
  // Nothing says what `o` is: a method called reconcile on some other object is the norm, not an error.
  assert.deepEqual(arityMismatches(pr({ head })), []);
});

test('arity: an unbound call is reported only when the text says what its receiver is, and then as a warning', () => {
  const head = {
    'src/widget.js': src('export class Widget {', '  spin(turns, speed) { return turns * speed; }', '}'),
    'src/use.js': src(
      "import { Widget } from './widget.js';",
      'export function a() { const w = new Widget(); return w.spin(1); }', //  line 2: w = new Widget()
      'export function b(thing) { return thing.spin(1); }', //                   nothing says what `thing` is
      'export function c(wheel) { const w = wheel; return w.spin(1); }', //      nor here: no type is written
    ),
    'src/typed.ts': src("import { Widget } from './widget.js';", 'export function d(w: Widget) { return w.spin(1); }'), // line 2: w: Widget
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['warn arity.mismatch src/typed.ts:2', 'warn arity.mismatch src/use.js:2']);
  assert.equal(f[0].title, 'Call passes 1 argument, function takes 2');
  assert.match(f[0].basis, /The receiver is declared in this file with the type that declares spin/);
  assert.match(f[0].basis, /Not established: the binding itself/);
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
  assert.match(f[0].basis, /one at the merge base did/); // `Engine e` is written in the parameter list: that is the tie
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

test('arity: a JavaScript parameter is required only when the body needs it; error-path tests are wrong on purpose', () => {
  const head = {
    'src/lib.js': src(
      'export function withOptions(a, options) {', '  options = options || {};', '  return a + options.x;', '}', // tested for absence: 1-2
      'export function strict(a, b) {', '  return a + b;', '}', //                                             both are operands: 2
      'export const passOn = (files, opts) => build(files, opts);', //                                         only handed on: the callee decides
      'export function reads(a, cfg) {', '  return a + cfg.depth;', '}', //                                    cfg is dereferenced: 2
      'export function unused(a, later) {', '  return a * 2;', '}', //                                         `later` is never used: 1-2
      'export function pattern(a, { x }) {', '  return a + x;', '}', //                                        a destructured parameter needs a value: 2
    ),
    'test/lib.test.js': src(
      "import { strict, withOptions, passOn, reads, unused, pattern } from '../src/lib.js';",
      "test('errors', () => {",
      '  assert.throws(() => strict(1));', //         expects the error
      '  expect(() => strict()).toThrow();', //       expects the error
      '  withOptions(1); passOn(1); unused(1);', //   all fine
      '  strict(1);', //                              line 6
      '  reads(1);', //                               line 7
      '  pattern(1);', //                             line 8
      '});',
    ),
  };
  const f = arityMismatches(pr({ head }));
  assert.deepEqual(brief(f), ['bad arity.mismatch test/lib.test.js:6', 'bad arity.mismatch test/lib.test.js:7', 'bad arity.mismatch test/lib.test.js:8']);
  assert.equal(f[0].title, 'Call passes 1 argument, function takes 2');
  // TypeScript keeps the declared minimum: there the compiler rejects the call whatever the body does.
  const ts = { 'src/lib.ts': src('export const passOn = (files: string[], opts: object) => build(files, opts);', 'export const v = passOn([]);') };
  assert.deepEqual(brief(arityMismatches(pr({ head: ts }))), ['bad arity.mismatch src/lib.ts:2']);
});

test('arity: what can and cannot be bound — interfaces, reassigned members, a field of the same name', () => {
  const cs = (...types) => src('namespace N {', ...types, '}');
  // An interface from outside adds no member an unqualified call could find: the call is still bound.
  const disposable = cs('  public class Res : IDisposable {', '    public void Dispose() { }', '    void Step(int a, int b) { }', '    void Go() { Step(1); }', '  }');
  assert.deepEqual(brief(arityMismatches(pr({ head: { 'Res.cs': disposable } }))), ['bad arity.mismatch Res.cs:5']);
  // IOException is a class despite its first letter: it may supply a Step(int) of its own, so nothing is said.
  const derived = cs('  public class Oops : IOException {', '    void Step(int a, int b) { }', '    void Go() { Step(1); }', '  }');
  assert.deepEqual(arityMismatches(pr({ head: { 'Oops.cs': derived } })), []);
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
  // An override that goes away leaves the member it overrode; a type with a library base class may inherit the method.
  assert.deepEqual(run('public override int Normalize(int a) { return a; }', 's.Normalize(1)'), []);
  const derived = (members) => src('namespace N {', '  public class Service : LibraryBase {', ...members, '  }', '}');
  assert.deepEqual(danglingReferences(pr({ base: { 'Service.cs': derived(['    public int Normalize(int a) { return a; }']), 'Client.cs': client('s.Normalize(1)') }, head: { 'Service.cs': derived(['    public int Other() { return 0; }']), 'Client.cs': client('s.Normalize(1)') } })), []);
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
    "const options = { apiKey: '{env:GEMINI_API_KEY}', token: '$GITHUB_TOKEN', secret: 'vault:kv/data/app#key1' };", // where the value lives, not the value
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
  assert.deepEqual(r.errors.map((e) => e.check), ['arityMismatches', 'practices']); // both read the tokens of every file in the diff
  assert.match(r.errors[0].message, /unreadable/);
});

// ── counterexamples from the adversarial review ─────────────────────────────────────────────────────────────
// Each case below broke an earlier version of the module (a false finding, or a planted defect that went unseen).

test('review/arity: a default in the middle of a JavaScript parameter list is a position, not a count', () => {
  // Found on this repository's own history: `function say(html, who = 'ai', src)` called as say(x) was reported
  // "takes 2-3". symbols.js counts two parameters without a default; the second position is the optional one.
  const lib = src("export function say(html, who = 'ai', src) {", "  return html.trim() + who + (src ? src : '');", '}');
  const use = (call) => src("import { say } from './lib.js';", 'export const a = 1;', call);
  const c = (call) => pr({ base: { 'lib.js': lib, 'u.js': use('') }, head: { 'lib.js': lib, 'u.js': use(call) } });
  assert.deepEqual(brief(arityMismatches(c("export const b = say('hi');"))), []); // html is the only parameter the body needs
  const f = arityMismatches(c('export const b = say();'));
  assert.deepEqual(brief(f), ['bad arity.mismatch u.js:3']);
  assert.match(f[0].detail, /passes 0 arguments, but say \(lib\.js:1\) takes 1-3/);
  // A required parameter after a default one keeps its position: c is the third.
  const c2 = pr({
    base: { 'a.js': src('export function calc(a) { return a; }', 'export const z = calc(1);') },
    head: { 'a.js': src('export function calc(a, b = 1, c) { return a + b + c.x; }', 'export const z = calc(1);') },
  });
  assert.match(arityMismatches(c2)[0].detail, /passes 1 argument, but calc \(a\.js:1\) takes 3/);
});

test('review/arity: what "the body needs the parameter" means in JavaScript, case by case', () => {
  // calc gains a second parameter b and its only caller still passes one argument.
  const run = (body, params = 'a, b') => brief(arityMismatches(pr({
    base: { 'a.js': src('export function calc(a) { return a; }', 'export const z = calc(1);') },
    head: { 'a.js': src(`export function calc(${params}) { ${body} }`, 'export const z = calc(1);') },
  })));
  const BAD = ['bad arity.mismatch a.js:2'];
  // The body goes wrong on undefined: these are reported.
  for (const body of ['return a + b.x;', 'return b[0];', 'return b(a);', 'return a * b;', 'return [...b];', 'return g(...b);',
    'for (const x of b) g(x); return a;', 'const { x } = b; return x;', 'return `${a}-${b}`;', 'return a in b;']) assert.deepEqual(run(body), BAD, body);
  assert.deepEqual(run('return x;', 'a, { x }'), BAD); // a destructured parameter cannot be left out
  // The language or the body gives undefined a way out: silent.
  for (const body of ['return { ...b, a };', 'for (const k in b) g(k); return a;', 'return g(a, b);', 'return b;', 'this.b = b; return a;',
    'if (!b) return a; return b.x;', "if (typeof b === 'undefined') return a; return b.x;", 'const o = b || {}; return o.x;', 'return (b ?? {}).x;',
    'return b?.x;', 'return b ? b.x : a;', 'return b && b.x;', 'if (b) return b.x; return a;', 'if (b == null) return a; return b.x;',
    'if (undefined === b) return a; return b.x;', 'b = normalise(b); return b.x;', 'b ||= {}; return b.x;', 'assertPresent(b); return b.x;',
    'if (!Array.isArray(b)) return a; return b[0];', 'if (b instanceof Map) return b.size; return a;', 'return a > b ? a : 0;',
    'switch (b) { case 1: return a; default: return b.x; }', 'return a.b.x + this.b.y;', 'return { b: a.x };']) assert.deepEqual(run(body), [], body);
  // Another binding of the same name inside the body is not the parameter.
  for (const body of ['return [a].map((b) => b.x);', 'return [a].map(({ b }) => b.x);', 'try { g(); } catch (b) { return b.message; } return a;',
    'function h(b) { return b.x; } return h(a);', 'return [a].map((q) => { const b = q; return b.x; });']) assert.deepEqual(run(body), [], body);
  // Declared optional.
  assert.deepEqual(run('return a + b.x;', 'a, b = {}'), []);
  assert.deepEqual(run('return a + b.length;', 'a, ...b'), []);
  assert.deepEqual(run('return a + b.x;', 'a, b?: Opts'), []); // Flow
  assert.deepEqual(run('return arguments.length + b.x;'), []);
});

test('review/arity: a call the pull request wrote is checked against a function it did not touch', () => {
  // A model that invents a signature calls an existing function with the wrong number of arguments.
  const lib = src('export function calc(a, b) { return a.x + b.x; }');
  const u0 = src("import { calc } from './lib.js';", 'export const a = calc({ x: 1 }, { x: 2 });');
  const c = (...added) => pr({ base: { 'lib.js': lib, 'u.js': u0 }, head: { 'lib.js': lib, 'u.js': u0 + src(...added) } });
  const f = arityMismatches(c('export const b = calc({ x: 1 });'));
  assert.deepEqual(brief(f), ['bad arity.mismatch u.js:3']);
  assert.equal(f[0].title, 'Call passes 1 argument, function takes 2');
  assert.match(f[0].basis, /this file imports calc from lib\.js/);
  assert.deepEqual(brief(arityMismatches(c('export const b = calc({ x: 1 }, { x: 3 });'))), []);
  assert.deepEqual(brief(arityMismatches(c('export const b = calc({ x: 1 }, { x: 3 }, 9);'))), ['warn arity.mismatch u.js:3']); // JavaScript drops the extra one
  assert.deepEqual(brief(arityMismatches(c('export const b = calc(...args);', 'export const d = [1].map(calc);', 'assert.throws(() => calc());'))), []);
  // A whole new file is all added lines.
  const n = pr({ base: { 'lib.js': lib }, head: { 'lib.js': lib, 'v.js': src("import { calc } from './lib.js';", 'export const z = calc({ x: 1 });') } });
  assert.deepEqual(brief(arityMismatches(n)), ['bad arity.mismatch v.js:2']);
  // A wrong call that was already there, in a file the pull request edits elsewhere, is not this pull request's.
  const old = src("import { calc } from './lib.js';", 'export const b = calc({ x: 1 });');
  assert.deepEqual(brief(arityMismatches(pr({ base: { 'lib.js': lib, 'u.js': old }, head: { 'lib.js': lib, 'u.js': old + 'export const c = 1;\n' } }))), []);
  // Nor is a call that only moved inside its file.
  const m0 = src("import { calc } from './lib.js';", 'export const a = 1;', 'export const b = calc({ x: 1 });'), m1 = src("import { calc } from './lib.js';", 'export const b = calc({ x: 1 });', 'export const a = 1;');
  assert.deepEqual(brief(arityMismatches(pr({ base: { 'lib.js': lib, 'u.js': m0 }, head: { 'lib.js': lib, 'u.js': m1 } }))), []);
  // Python and C#.
  const py = pr({
    base: { 'pkg/lib.py': src('def calc(a, b):', '    return a + b'), 'pkg/u.py': src('from .lib import calc', 'A = calc(1, 2)') },
    head: { 'pkg/lib.py': src('def calc(a, b):', '    return a + b'), 'pkg/u.py': src('from .lib import calc', 'A = calc(1, 2)', 'B = calc(1)', 'C = calc(1, b=2)', 'D = calc(*args)') },
  });
  assert.deepEqual(brief(arityMismatches(py)), ['bad arity.mismatch pkg/u.py:3']);
  const cs = (...added) => pr({
    base: { 'U.cs': src('namespace N;', 'public class U {', '  int Own(int a) => a;', '  int Run() { return Own(1); }', '}') },
    head: { 'U.cs': src('namespace N;', 'public class U {', '  int Own(int a) => a;', '  int Run() { return Own(1); }', ...added, '}') },
  });
  assert.deepEqual(brief(arityMismatches(cs('  int Run2() { return Own(1, 2); }'))), ['bad arity.mismatch U.cs:5']);
  assert.deepEqual(brief(arityMismatches(cs('  int Run2() { return Own(a: 1); }', '  int Run3(System.Func<int, int, int> Own) { return Own(1, 2); }'))), []);
});

test('review/arity: an accessor is not the function it returns, and inherited member names are never counted', () => {
  // `get merge3() { return fn; }` is recorded as a method with no parameters; x.merge3(1) calls what it returns.
  const c = pr({
    base: { 'a.js': src('export class K {', '  merge3(a) { return a.x; }', '  run() { return this.merge3({ x: 1 }); }', '}') },
    head: { 'a.js': src('export class K {', '  get merge3() { return (a) => a.x; }', '  run() { return this.merge3({ x: 1 }); }', '}') },
  });
  assert.deepEqual(brief(runChecks(c).findings), []);
  // Java: notify() is Object.notify(); a class that declares its own notify(String) does not change that.
  const j = pr({
    base: { 'A.java': src('package n;', 'public class A {', '  void run() { notify(); }', '}') },
    head: { 'A.java': src('package n;', 'public class A {', '  void run() { notify(); }', '  void notify(String m) { }', '}') },
  });
  assert.deepEqual(brief(arityMismatches(j)), []);
});

test('review/arity: in JavaScript a receiver is tied to a repository object only when the file binds it there', () => {
  const lib = src('export const api = { loadTree(id, opts) { return id + opts.depth; } };', 'export class Client { sendMail(msg, to) { return msg.body + to.id; } }');
  const c = (head, ...added) => pr({ base: { 'lib.js': lib, 'u.js': src(head, 'export const a = 1;') }, head: { 'lib.js': lib, 'u.js': src(head, 'export const a = 1;', ...added) } });
  const calls = ['export const b = api.loadTree(1);', 'const c = new Client();', 'export const d = c.sendMail({ body: 1 });'];
  const f = arityMismatches(c("import { api, Client } from './lib.js';", ...calls));
  assert.deepEqual(brief(f), ['warn arity.mismatch u.js:3', 'warn arity.mismatch u.js:5']);
  assert.match(f[0].basis, /Not established: the binding itself/);
  // The same names from a package, from a local factory, or as a parameter are other objects: nothing is said.
  assert.deepEqual(brief(arityMismatches(c("import { api, Client } from 'some-sdk';", ...calls))), []);
  assert.deepEqual(brief(arityMismatches(c('const api = makeApi();', calls[0]))), []);
  assert.deepEqual(brief(arityMismatches(c('const noop = 0;', 'export const b = (api) => api.loadTree(1);'))), []);
});

test('review/arity: a qualified type gives its last segment (new Outer.Nested() is a Nested)', () => {
  // Found on the C# history: `MessagePackSerializer.NonGeneric s = new MessagePackSerializer.NonGeneric()` tied the
  // receiver to the outer type, whose Serialize overloads take fewer arguments than NonGeneric.Serialize.
  const lib = (extra) => src('namespace N;', 'public class Outer {', `  public int Pack(int a${extra}) => a;`, '  public class Nested {', '    public int Pack(int a, int b, int c) => a;', '  }', '}');
  const use = src('namespace N;', 'public class U {', '  private Outer.Nested s = new Outer.Nested();', '  int Run() { return s.Pack(1, 2, 3); }', '}');
  const c = pr({ base: { 'Lib.cs': lib(''), 'U.cs': use }, head: { 'Lib.cs': lib(', int b = 0'), 'U.cs': use } });
  assert.deepEqual(brief(arityMismatches(c)), []); // Nested.Pack takes 3; Outer.Pack (1-2) is not what s is
});

test('review/binding: C# this. also finds extension methods, so it binds only where none can apply', () => {
  const a = (cls, usings, body) => src(...usings, 'namespace N;', cls, ...body, '}');
  const gone = (cls = 'public class A {', before = [], after = []) => pr({
    base: { 'A.cs': a(cls, before, ['  public void Run() { this.Dump(); }', '  public void Dump() { }']) },
    head: { 'A.cs': a(cls, after, ['  public void Run() { this.Dump(); }']) },
  });
  // Nothing can supply Dump: no base, no interface from outside, no new using.
  assert.deepEqual(brief(danglingReferences(gone())), ['bad dangling.call A.cs:3']);
  // The pull request adds a using: an extension method Dump may come with it.
  assert.deepEqual(brief(danglingReferences(gone('public class A {', [], ['using Lib.Extensions;']))), ['warn dangling.call A.cs:4']);
  // The type implements an interface of a library: the library may extend it (LINQ on IEnumerable<T>).
  assert.deepEqual(brief(danglingReferences(gone('public class A : System.Collections.IEnumerable {'))), ['warn dangling.call A.cs:3']);
  // An unqualified call never reaches an extension method: an interface from outside does not matter there.
  const un = pr({
    base: { 'A.cs': src('namespace N;', 'public class A : System.IDisposable {', '  public void Run() { Dump(); }', '  public void Dump() { }', '}') },
    head: { 'A.cs': src('namespace N;', 'public class A : System.IDisposable {', '  public void Run() { Dump(); }', '}') },
  });
  assert.deepEqual(brief(danglingReferences(un)), ['bad dangling.call A.cs:3']);
});

test('review/binding: a partial type with one part in the repository, and a Java anonymous class, are not closed', () => {
  const part = (mod) => pr({
    base: { 'A.cs': src('namespace N;', `public ${mod}class A {`, '  void Run() { Helper(1); }', '  void Helper(int x) { }', '}'), 'B.cs': src('namespace N;', 'public class B { }') },
    head: { 'A.cs': src('namespace N;', `public ${mod}class A {`, '  void Run() { Helper(1); }', '}'), 'B.cs': src('namespace N;', 'public class B { }') },
  });
  assert.deepEqual(brief(danglingReferences(part(''))), ['bad dangling.call A.cs:3']);
  // partial, and no other part in the repository: the other part is written by a source generator at build time.
  const w = danglingReferences(part('partial '));
  assert.deepEqual(brief(w), ['warn dangling.call A.cs:3']);
  assert.match(w[0].basis, /Not established: the binding itself/);
  // partial with a second part in the repository: split by hand, bound as usual.
  const two = pr({
    base: { 'A.cs': src('namespace N;', 'public partial class A {', '  void Run() { Helper(1); }', '  void Helper(int x) { }', '}'), 'A.More.cs': src('namespace N;', 'public partial class A { int more; }') },
    head: { 'A.cs': src('namespace N;', 'public partial class A {', '  void Run() { Helper(1); }', '}'), 'A.More.cs': src('namespace N;', 'public partial class A { int more; }') },
  });
  assert.deepEqual(brief(danglingReferences(two)), ['bad dangling.call A.cs:3']);
  // Java: inside `new Thread() { … }` an unqualified name is looked up in Thread first.
  const java = (call) => pr({
    base: { 'A.java': src('package n;', 'public class A {', `  Object r() { ${call} }`, '  void helper(int x) { }', '}') },
    head: { 'A.java': src('package n;', 'public class A {', `  Object r() { ${call} }`, '}') },
  });
  assert.deepEqual(brief(danglingReferences(java('helper(1); return null;'))), ['bad dangling.call A.java:3']);
  assert.deepEqual(brief(danglingReferences(java('return new Thread() { public void run() { helper(1); } };'))), ['warn dangling.call A.java:3']);
});

test('review/binding: Python — an absolute import binds only when one module answers to it', () => {
  const c = (extra) => pr({
    base: { 'a/utils.py': src('def helper(x):', '    return x'), 'b/main.py': src('from utils import helper', 'def go():', '    return helper(1)'), ...extra },
    head: { 'a/utils.py': src('def helper(x, y):', '    return x + y'), 'b/main.py': src('from utils import helper', 'def go():', '    return helper(1)'), ...extra },
  });
  assert.deepEqual(brief(arityMismatches(c({}))), ['bad arity.mismatch b/main.py:3']);
  // A second utils.py next to the caller: which one `from utils import` loads depends on sys.path.
  assert.deepEqual(brief(arityMismatches(c({ 'b/utils.py': src('from a.utils import *') }))), []);
});

test('review/dangling: a name its module still provides, or that a mixin may supply, is not taken as gone', () => {
  // Python: every imported name is a name the module provides.
  const m0 = src('def helper(x):', '    return x', 'KEEP = 1'), u = src('from m import helper', 'T = helper(1)');
  const py = (m1) => brief(danglingReferences(pr({ base: { 'm.py': m0, 'u.py': u }, head: { 'm.py': m1, 'u.py': u } })));
  assert.deepEqual(py(src('KEEP = 1')), ['bad dangling.call u.py:2']);
  assert.deepEqual(py(src('from lib import helper', 'KEEP = 1')), []);
  assert.deepEqual(py(src('from lib import *', 'KEEP = 1')), []);
  assert.deepEqual(py(src('helper = make_helper()', 'KEEP = 1')), []);
  // JavaScript: the prototype is touched in the file, so the method may come from the mixin.
  const k = (tail) => pr({
    base: { 'm.js': src('export class K {', '  helper(x) { return x; }', '  run() { return this.helper(1); }', '}') },
    head: { 'm.js': src('export class K {', '  run() { return this.helper(1); }', '}', ...tail) },
  });
  assert.deepEqual(brief(danglingReferences(k([]))), ['bad dangling.call m.js:2']);
  assert.deepEqual(brief(danglingReferences(k(['Object.assign(K.prototype, mixin);']))), ['warn dangling.call m.js:2']);
  assert.deepEqual(brief(danglingReferences(k(['applyMixins(K, [Helpers]);']))), ['warn dangling.call m.js:2']);
  assert.deepEqual(brief(danglingReferences(k(['K.prototype.helper = function (x) { return x; };']))), []); // declared again
});

test('review/imports: export lists that cannot be closed, string names, and Flow type imports', () => {
  const c = (target, imp, path = 'src/t.js') => brief(unresolvedImports(pr({
    base: { 'src/a.js': src('export const a = 1;'), [path]: target }, head: { 'src/a.js': src(imp, 'export const a = 1;'), [path]: target },
  })));
  // The module object is handed to a function: whoever receives it can add exports.
  assert.deepEqual(c(src('module.exports = { p };', 'register(module);'), "const { zz } = require('./t.js');"), []);
  // Comparing or reading it cannot: the list stays closed.
  assert.deepEqual(c(src('module.exports = { p };', 'if (require.main === module) main();'), "const { zz } = require('./t.js');"), ['bad import.missing-export src/a.js:1']);
  // `import { 'kebab-name' as kn }`: symbols.js reads `as` and `kn` as imported names; the clause is left alone.
  assert.deepEqual(c(src('const p = 1;', "export { p as 'kebab-name' };"), "import { 'kebab-name' as kn } from './t.js';"), []);
  // Flow: `import type { T }` has no default binding, though symbols.js records `type` as one.
  assert.deepEqual(c(src('export const p = 1;'), "import type { T } from './t.js';"), ['bad import.missing-export src/a.js:1']); // T itself is not exported: one finding, not two
  assert.deepEqual(c(src('export const p = 1;', 'export type T = number;'), "import type { T } from './t.js';"), []);
});

test('review/imports: a conditional require is a warning, a caught dynamic import is optional, ambient modules resolve', () => {
  const a0 = { 'src/a.js': src('export const a = 1;') };
  const c = (line) => pr({ base: a0, head: { 'src/a.js': src(line, 'export const a = 1;') }, manifests: pkg({ name: 'app' }), tree: ['package.json'] });
  // The file is loaded only if it exists: its absence from the tree is expected.
  const w = unresolvedImports(c("const cfg = fs.existsSync('./local.js') ? require('./local.js') : {};"));
  assert.deepEqual(brief(w), ['warn import.missing-file src/a.js:1']);
  assert.match(w[0].basis, /runs only under a condition/);
  assert.deepEqual(brief(unresolvedImports(c("const cfg = require('./local.js');"))), ['bad import.missing-file src/a.js:1']);
  assert.deepEqual(brief(unresolvedImports(c("if (process.env.X) { require('./local.js'); }"))), ['warn import.missing-file src/a.js:1']);
  // Packages: a failure that is handled is an optional dependency.
  assert.deepEqual(brief(unresolvedImports(c("const x = await import('optional-dep').catch(() => null);"))), []);
  assert.deepEqual(brief(unresolvedImports(c("const x = has ? require('optional-dep') : null;"))), []);
  assert.deepEqual(brief(unresolvedImports(c("const x = await import('required-dep');"))), ['bad import.undeclared-package src/a.js:1']);
  // TypeScript: `declare module 'name'` in the repository gives the specifier a meaning.
  const ts = (decl) => pr({
    base: { 'src/a.ts': src('export const a = 1;'), 'src/types.d.ts': decl },
    head: { 'src/a.ts': src("import { x } from 'virtual-config';", "import logo from 'assets/logo.svg';", 'export const a = x;'), 'src/types.d.ts': decl },
    manifests: pkg({ name: 'app' }), tree: ['package.json'],
  });
  assert.deepEqual(brief(unresolvedImports(ts(src("declare module 'virtual-config' { export const x: number; }", "declare module '*.svg' { const u: string; export default u; }")))), []);
  assert.deepEqual(brief(unresolvedImports(ts(src('export {};')))), ['bad import.undeclared-package src/a.ts:1', 'bad import.undeclared-package src/a.ts:2']);
});

test('review/tests: a benchmark is not a test, and a test that lost its attribute is disabled, not removed', () => {
  // Found on the C# history: 33 [Benchmark] methods deleted with their file were reported as removed tests.
  const bench = src('using BenchmarkDotNet.Attributes;', 'public class Tests {', '  [Benchmark]', '  public void Serialize1() { Run(); }', '  [Benchmark]', '  public void Serialize2() { Run(); }', '}');
  assert.deepEqual(brief(testWeakening(pr({ base: { 'benchmark/Tests.cs': bench }, head: {} }))), []);
  assert.deepEqual(brief(testWeakening(pr({ base: { 'benchmark/Tests.cs': bench }, head: { 'benchmark/Tests.cs': bench.replace(/  \[Benchmark\]\n  public void Serialize2.*\n/, '') } }))), []);
  // [Fact] removed, method kept: the method is still in the file, so "removed" would be false. It no longer runs.
  const t0 = src('using Xunit;', 'public class ATests {', '  [Fact]', '  public void Works() { Assert.True(F.Ok()); }', '  [Fact]', '  public void Other() { Assert.True(F.Ok()); }', '}');
  const f = testWeakening(pr({ base: { 'tests/ATests.cs': t0 }, head: { 'tests/ATests.cs': t0.replace('  [Fact]\n', '') } }));
  assert.deepEqual(brief(f), ['bad test.disabled tests/ATests.cs:3']);
  assert.match(f[0].detail, /ATests\.Works at tests\/ATests\.cs:3 is still declared but lost \[Fact\]/);
  assert.equal(f[0].symbol, 'tests/ATests.cs::ATests.Works');
});

test('review/tests: a test switched off from the inside is disabled; a conditional skip is not', () => {
  const t0 = src("import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { f } from '../src/f.js';", '', "test('adds', () => {", '  assert.equal(f(1), 2);', '});', '', "test('zero', () => {", '  assert.equal(f(0), 1);', '});');
  const run = (head) => brief(testWeakening(pr({ base: { 'test/f.test.js': t0 }, head: { 'test/f.test.js': head } })));
  const opt = (o) => t0.replace("test('zero', () => {", `test('zero', ${o}, () => {`);
  assert.deepEqual(run(opt('{ skip: true }')), ['bad test.disabled test/f.test.js:9']); // node:test options
  assert.deepEqual(run(opt("{ skip: 'flaky on CI' }")), ['bad test.disabled test/f.test.js:9']);
  assert.deepEqual(run(opt('{ todo: true }')), ['bad test.disabled test/f.test.js:9']);
  assert.deepEqual(run(opt('{ skip: false, timeout: 100 }')), []);
  assert.deepEqual(run(opt("{ skip: process.platform === 'win32' }")), []); // a condition, not a switch
  assert.deepEqual(run(t0.replace("test('zero', () => {", "test('zero', (t) => {\n  t.skip('later');")), ['bad test.disabled test/f.test.js:10']);
  assert.deepEqual(run(t0.replace("test('zero', () => {", "test('zero', () => {\n  return;")), ['bad test.disabled test/f.test.js:10']);
  assert.deepEqual(run(t0.replace("test('zero', () => {", "test('zero', (t) => {\n  if (!process.env.CI) return t.skip('later');")), []);
  // C# and Python: the first statement leaves the test.
  const cs0 = src('using Xunit;', 'public class FTests {', '  [Fact]', '  public void Adds()', '  {', '    Assert.Equal(2, F.Add(1));', '  }', '}');
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/FTests.cs': cs0 }, head: { 'tests/FTests.cs': cs0.replace('  {\n', '  {\n    return;\n') } }))), ['bad test.disabled tests/FTests.cs:6']);
  const py0 = src('import pytest', '', 'def test_adds():', '    assert add(1) == 2');
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/test_f.py': py0 }, head: { 'tests/test_f.py': py0.replace('    assert', "    pytest.skip('later')\n    assert") } }))), ['bad test.disabled tests/test_f.py:4']);
});

test('review/tests: .only leaves the other tests out, in an existing file and in a new one', () => {
  const t0 = src("import { test } from 'node:test';", "import assert from 'node:assert/strict';", '', "test('adds', () => {", '  assert.equal(1 + 1, 2);', '});', '', "test('zero', () => {", '  assert.equal(0 + 1, 1);', '});');
  const f = testWeakening(pr({ base: { 'test/f.test.js': t0 }, head: { 'test/f.test.js': t0.replace("test('zero'", "test.only('zero'") } }));
  assert.deepEqual(brief(f), ['warn test.only test/f.test.js:8']);
  assert.match(f[0].basis, /node:test only under --test-only/);
  assert.deepEqual(brief(testWeakening(pr({ base: {}, head: { 'test/g.test.js': t0.replace("test('zero'", "test.only('zero'") } }))), ['warn test.only test/g.test.js:8']);
  assert.deepEqual(brief(testWeakening(pr({ base: { 'test/f.test.js': t0 }, head: { 'test/f.test.js': t0.replace("test('zero', () => {", "test('zero', { only: true }, () => {") } }))), ['warn test.only test/f.test.js:8']);
  // Already there before the pull request: not new.
  const o = t0.replace("test('zero'", "test.only('zero'");
  assert.deepEqual(brief(testWeakening(pr({ base: { 'test/f.test.js': o }, head: { 'test/f.test.js': o + '// more\n' } }))), []);
});

test('review/tests: an assertion over literals cannot fail and does not count; the Roslyn harness does', () => {
  const t0 = src("import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { f } from '../src/f.js';", '', "test('zero', () => {", '  assert.equal(f(0), 1);', '});');
  const run = (line) => testWeakening(pr({ base: { 'test/f.test.js': t0 }, head: { 'test/f.test.js': t0.replace('  assert.equal(f(0), 1);', line) } }));
  // The failing assertion replaced by one that cannot fail: the count of real assertions went from 1 to 0.
  const f = run('  assert.ok(true);');
  assert.deepEqual(brief(f), ['warn test.assertions-removed test/f.test.js:5']);
  assert.match(f[0].detail, /makes 0 assertion calls at head, down from 1 at the merge base \(not counting 1 assertion over literals only, which cannot fail\)/);
  assert.deepEqual(brief(run('  assert.equal(1, 1);')), ['warn test.assertions-removed test/f.test.js:5']);
  assert.deepEqual(brief(run('  assert.deepEqual([f(0)], [1]);')), []); // as many real assertions as before
  assert.deepEqual(brief(run('  assert.fail("unreachable");')), []); // fail always fails when reached: it is a check
  // Found on the C# history: VerifyCS.VerifyCodeFixAsync(a, b) rewritten as `new VerifyCS.Test { … }.RunAsync()`
  // was reported as "0 assertion calls, down from 1". Running the built harness is the assertion.
  const cs = (body) => src('using Xunit;', 'public class ATests {', '  [Fact]', '  public async Task Fixes()', '  {', ...body, '  }', '}');
  const before = cs(['    await VerifyCS.VerifyCodeFixAsync(input, output);']);
  const after = cs(['    await new VerifyCS.Test', '    {', '      TestCode = input,', '      FixedCode = output,', '    }.RunAsync();']);
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/ATests.cs': before }, head: { 'tests/ATests.cs': after } }))), []);
  // Reading a property of a fresh harness object asserts nothing.
  const prop = cs(['    var refs = new VerifyCS.Test().ReferenceAssemblies;']);
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/ATests.cs': before }, head: { 'tests/ATests.cs': prop } }))), ['warn test.assertions-removed tests/ATests.cs:3']);
});

test('review/practices: names that hold a key name, words of any alphabet, fixtures and templates', () => {
  const c = (file, ...lines) => brief(practices(pr({ base: { [file]: src('export const a = 1;') }, head: { [file]: src('export const a = 1;', ...lines) } })));
  // tokenKey / passwordKey name the key a token is stored under; secretKey is a secret.
  assert.deepEqual(c('src/a.js', "const tokenKey = 'auth_token_v2';", "const PASSWORD_KEY = 'pwd.v1.store';", "const refreshTokenKey = 'app:refresh2';"), []);
  assert.deepEqual(c('src/a.js', "const secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY';"), ['bad practice.secret src/a.js:2']);
  // A translated label is a word, whatever its alphabet.
  assert.deepEqual(c('src/a.js', "const m = { password: 'Contraseña', token: 'Жетон-доступа' };"), []);
  // Test data.
  assert.deepEqual(c('fixtures/users.js', "export const u = { password: 'S3cret-pass!' };"), []);
  assert.deepEqual(c('src/__mocks__/api.js', "export const u = { apiKey: 'k3y-12345-abc' };"), []);
  assert.deepEqual(c('src/users.js', "export const u = { password: 'S3cret-pass!' };"), ['bad practice.secret src/users.js:2']);
  // A file named *Template* shows what a key looks like (no secret rule) but is code like any other.
  assert.deepEqual(c('src/emailTemplate.js', "const apiKey = 'k3y-12345-abc';", 'try { a(); } catch { }', "console.log('x');"), ['info practice.debug-output src/emailTemplate.js:4', 'warn practice.error-swallowed src/emailTemplate.js:3']);
});

test('review/practices: a directive or a marker is read where its tool reads it, not in a sentence about it', () => {
  const js = (...lines) => brief(practices(pr({ base: { 'src/a.js': src('export const a = 1;') }, head: { 'src/a.js': src('export const a = 1;', ...lines) } })));
  // Found on this repository's history: the comment that documents these rules was reported by them.
  assert.deepEqual(js('// practice.check-disabled: #pragma warning disable, eslint-disable, @ts-ignore, @ts-nocheck', '// the list of TODO, FIXME markers is read elsewhere', '// matches XXX-prefixed names'), []);
  assert.deepEqual(js('// eslint-disable-next-line no-console', '/* eslint-disable */', 'a(); // eslint-disable-line', '// @ts-ignore'), ['warn practice.check-disabled src/a.js:2', 'warn practice.check-disabled src/a.js:3', 'warn practice.check-disabled src/a.js:4', 'warn practice.check-disabled src/a.js:5']);
  assert.deepEqual(js('/* eslint-enable */'), []);
  assert.deepEqual(js('// TODO: later', '// FIXME(ana) soon', 'a(); // HACK around the cache', '/** XXX */', '/*', ' * TODO finish', ' */'), ['info practice.unfinished-marker src/a.js:2', 'info practice.unfinished-marker src/a.js:3', 'info practice.unfinished-marker src/a.js:4', 'info practice.unfinished-marker src/a.js:5', 'info practice.unfinished-marker src/a.js:7']);
  const cs = (...lines) => brief(practices(pr({ base: { 'src/A.cs': src('namespace N;', 'public class A { }') }, head: { 'src/A.cs': src('namespace N;', ...lines, 'public class A { }') } })));
  assert.deepEqual(cs('// see #pragma warning disable above', '// and #nullable disable too'), []);
  assert.deepEqual(cs('#pragma warning disable CS8618', '  #nullable disable'), ['warn practice.check-disabled src/A.cs:2', 'warn practice.check-disabled src/A.cs:3']);
  assert.deepEqual(cs('#pragma warning restore CS8618'), []);
});

test('review/imports: the usings of generator output are the generator\'s', () => {
  const g = src('using TempProject.MyEnum;', 'namespace Formatters { class F { } }');
  const c = (file) => brief(unresolvedImports(pr({ base: { 'src/A.cs': src('namespace N;', 'class A { }') }, head: { 'src/A.cs': src('namespace N;', 'class A { }'), [file]: g } })));
  assert.deepEqual(c('tests/Resources/Formatters.MyEnumFormatter.g.cs'), []);
  assert.deepEqual(c('tests/Resources/Formatters.cs'), ['warn import.unknown-namespace tests/Resources/Formatters.cs:1']);
});

test('review/tests: a head file that no longer parses says nothing about removed tests', () => {
  // Found while planting defects: a cut in the middle of a block made every later test "removed" (17 false findings).
  const t0 = src('using Xunit;', 'public class ATests {', '  [Fact]', '  public void One() { Assert.True(F.Ok()); }', '  [Fact]', '  public void Two() { Assert.True(F.Ok()); }', '  [Fact]', '  public void Three() { Assert.True(F.Ok()); }', '}');
  const broken = t0.replace('  public void One() { Assert.True(F.Ok()); }', '  public void One() { Assert.True(F.Ok(); ');
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/ATests.cs': t0 }, head: { 'tests/ATests.cs': broken } }))), []);
  // The same edit with its brackets intact removes exactly the test it deletes.
  const cut = t0.replace('  [Fact]\n  public void Two() { Assert.True(F.Ok()); }\n', '');
  // (the hunk is -6,2 +5,0: the second [Fact] line is common to both sides, so the cut sits after head line 5)
  assert.deepEqual(brief(testWeakening(pr({ base: { 'tests/ATests.cs': t0 }, head: { 'tests/ATests.cs': cut } }))), ['bad test.removed tests/ATests.cs:5']);
});
