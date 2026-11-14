import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { plainReadme, projectContext, changeContext, spotContext } from '../server/context.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-context-'));
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.email', 'test@example.com'); sh(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Ledger\n\n[![build](https://img.example/b.svg)](https://ci.example)\n\nLedger keeps **account balances** and [exports](docs/x.md) them.\n\n```js\nsecret()\n```\n\n| a | b |\n|---|---|\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'pay.js'), '// unrelated\n\n/**\n * Moves money between two accounts.\n * Refuses when the balance is too low.\n */\nfunction transfer(from, to, amount) {\n  if (from.balance < amount) throw new Error("low");\n  from.balance -= amount; to.balance += amount;\n}\n');
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'Start');
  sh(dir, 'checkout', '-q', '-b', 'fix');
  fs.appendFileSync(path.join(dir, 'src', 'pay.js'), 'function audit() { return transfer; }\n');
  sh(dir, 'commit', '-qam', 'Audit every transfer');
  return dir;
}

test('a README is read as plain prose: no badges, links, code or tables', () => {
  const t = plainReadme('# Ledger\n\n[![b](x.svg)](y)\n\nKeeps **balances** and [exports](d.md) them.\n\n```js\nsecret()\n```\n| a | b |\n|---|---|\n<p align="center">hi</p>');
  assert.equal(t, 'Ledger\nKeeps balances and exports them.\nhi');
  assert.ok(plainReadme('word '.repeat(2000)).length <= 1801);
});

test('project, change and spot are told in words', async () => {
  const dir = repo();
  try {
    const project = { id: 'p', name: 'ledger', path: dir, base: 'main' }, pr = { id: 'out:fix', ref: 'fix', branch: 'fix', title: 'Audit every transfer' };
    const p = await projectContext(project);
    assert.match(p.about, /Ledger keeps account balances and exports them\./); assert.ok(!p.about.includes('secret')); assert.deepEqual(p.topLevel, ['README.md', 'src']);
    const c = await changeContext(project, pr);
    assert.equal(c.askedFor.text, 'Audit every transfer'); assert.equal(c.filesChanged, 1); assert.deepEqual(c.touches, ['src/pay.js (1 file)']); assert.match(c.note, /commit messages/);
    const head = sh(dir, 'rev-parse', 'fix');
    const math = { head, nodes: [{ id: 'a', name: 'transfer', qname: 'transfer', file: 'src/pay.js', kind: 'function', start: 7, end: 10, status: 'modified', impactWhy: '1 function depends on it' }, { id: 'b', name: 'audit', qname: 'audit', file: 'src/pay.js', kind: 'function', start: 11, end: 11, status: 'added' }], edges: [{ from: 'b', to: 'a', kind: 'calls' }] };
    const s = await spotContext(project, math, 'a');
    assert.equal(s.itsOwnComment, 'Moves money between two accounts. Refuses when the balance is too low.');
    assert.match(s.code, /^function transfer\(from, to, amount\)/); assert.deepEqual(s.calledBy, ['audit']); assert.deepEqual(s.calls, []);
    assert.deepEqual((await spotContext(project, math, 'b')).calls, ['transfer']);
    await assert.rejects(spotContext(project, math, 'nope'), /Unknown spot/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
