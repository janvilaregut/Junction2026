// The mathematical pass end to end, on a repository built for the test: a base commit and a pull request
// branch, read from git objects exactly as the server reads a real one. No model, no network, no execution of
// the code under review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-engine-'));
process.env.KATSE_DATA = path.join(tmp, 'data'); // the pass caches its result: keep it out of the project's data
const { analyze } = await import('../server/math/index.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// One file changes only in comments and layout; the other gets a renamed local, a changed constant and two new functions.
const SUM_BASE = `export function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum;
}
`;
const SUM_HEAD = `export function total(items) {
    // the sum of every line
    let sum = 0;
    for (const item of items) {
        sum += item.price * item.qty;
    }
    return sum;
}
`;
const BASE = `export function label(name) {
  const text = String(name).trim();
  return text.toUpperCase();
}

export function discount(amount, code) {
  if (code === 'TEN') return amount * 0.9;
  return amount;
}

export function note(a) {
  return a + 1;
}
`;
const shipping = (name, a, b, c) => `
export function ${name}(order) {
  let weight = 0;
  for (const line of order.lines) {
    if (line.digital) continue;
    weight += line.weight * line.qty;
  }
  const base = weight > ${a} ? 15 : weight > ${b} ? 9 : 4;
  const insured = order.value > ${c} ? base + 6 : base;
  return order.express ? insured * 2 : insured;
}
`;
const HEAD = `export function label(name) {
  const clean = String(name).trim();
  return clean.toUpperCase();
}

export function discount(amount, code) {
  if (code === 'TEN') return amount * 0.8;
  return amount;
}

export function note(a) {
  // one more
  return a + 1;
}
${shipping('shippingEU', 20, 5, 500)}${shipping('shippingUS', 30, 10, 800)}`;

function repository() {
  const dir = path.join(tmp, 'repo'), git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'src/cart.js'), BASE); fs.writeFileSync(path.join(dir, 'src/sum.js'), SUM_BASE); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  fs.writeFileSync(path.join(dir, 'src/cart.js'), HEAD); fs.writeFileSync(path.join(dir, 'src/sum.js'), SUM_HEAD); git('add', '-A'); git('commit', '-q', '-m', 'change');
  return dir;
}

test('engine: a proof needs unchanged surroundings; a renaming, a changed constant and copies inside the pull request are sent on', async () => {
  const m = await analyze({ id: 'engine-test', path: repository(), base: 'main' }, { ref: 'change' }, { force: true, decisions: false });
  assert.equal(m.partial, false, `every stage ran: ${JSON.stringify(m.limits)}`);
  const node = (name) => { const n = m.nodes.find((x) => x.name === name || x.qname === name); assert.ok(n, `${name} is a node (have: ${m.nodes.map((x) => x.name).join(', ')})`); return n; };

  const total = node('total');
  assert.equal(total.verdict, 'proved', 'a comment and new indentation, in a file where nothing else changed: same tokens');
  assert.match(total.claim, /Same tokens/);

  // A renaming is not certified: scope cannot be decided soundly on tokens.
  assert.notEqual(node('label').verdict, 'proved', 'a renamed local is sent on, not proved');
  // A comment-only change is not proved either when the file's declarations changed around it (two functions
  // were added): a proof about a function's text holds only in unchanged surroundings.
  assert.notEqual(node('note').verdict, 'proved', 'the surroundings changed');

  const discount = node('discount');
  assert.notEqual(discount.verdict, 'proved', 'a changed constant changes behaviour');
  assert.notEqual(discount.verdict, 'cleared', 'and no measurement clears it without a test that reaches it');

  // Neither function exists in the base, so the base index cannot know they are copies of each other.
  for (const [name, other] of [['shippingEU', 'shippingUS'], ['shippingUS', 'shippingEU']]) {
    const dup = node(name).evidence.find((e) => e.id === 'dup');
    assert.ok(dup, `${name} is reported as a duplicate`);
    assert.match(dup.detail, new RegExp(`${other}, written in this same pull request`));
    assert.equal(dup.tone, 'bad', 'more than half of it is a copy');
  }
  for (const name of ['total', 'label', 'discount', 'note']) assert.equal(node(name).evidence.find((e) => e.id === 'dup'), undefined, `${name} duplicates nothing`);
});
