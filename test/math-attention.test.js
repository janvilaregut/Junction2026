import test from 'node:test';
import assert from 'node:assert/strict';
import { chunksOf, prior, settle, ration, askModel } from '../server/math/attention.js';

const SRC = `function pay(cart, code) {
  const normalized = normalize(code);
  log.debug('pay', code);

  if (!COUPONS[normalized]) {
    throw new Error('unknown');
  }
  cart.total -= COUPONS[normalized];

  return cart;
}`.split('\n');

test('chunks follow blank lines and cover the function without overlap', () => {
  const c = chunksOf(SRC, 1, SRC.length);
  assert.ok(c.length >= 2);
  assert.equal(c[0].start, 1);
  assert.equal(c[c.length - 1].end, SRC.length);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].start > c[i - 1].end);
});

test('the prior: a changed branch that throws beats braces and imports', () => {
  const hot = prior("if (!COUPONS[x]) {\n  throw new Error('unknown');\n}", 3, 3);
  const cold = prior('import fs from "fs";\n}', 0, 3);
  assert.ok(hot.score > 0.5 && cold.score < 0.1);
  assert.ok(hot.why.includes('branches'));
  // in a brand-new function "changed" says nothing
  assert.ok(prior('const a = 1;', 1, 1, true).score < prior('const a = 1;', 1, 4).score);
});

test('the model decides most of the heat; attention is rationed', () => {
  const s = settle({ prior: 0.2 }, { choice: 'critical', confidence: 0.9, p: { critical: 0.9, relevant: 0.08, filler: 0.02 } });
  assert.equal(s.level, 3);
  assert.equal(settle({ prior: 0.9 }, { choice: 'filler', confidence: 0.95, p: { critical: 0, relevant: 0.05, filler: 0.95 } }).level, 1);
  const all = Array.from({ length: 10 }, (_, i) => ({ heat: 0.9 - i * 0.01, level: 3, changed: 1, allNew: true }));
  ration(all);
  assert.equal(all.filter((c) => c.level === 3).length, 4); // ceil(35 %)
  // a changed chunk of a partly changed function never hides
  const part = [{ heat: 0.9, level: 3 }, { heat: 0.1, level: 1, changed: 1, allNew: false }];
  ration(part);
  assert.equal(part[1].level, 2);
});

test('without a key the model falls back and never throws', async () => {
  const key = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    const r = await askModel([{ key: 'a', name: 'f', changed: 1, marked: 'x' }], { file: 'a.js' }, { fetcher: () => { throw new Error('no network'); } });
    assert.equal(r.status, 'fallback');
    assert.equal(r.reason, 'missing-key');
  } finally { if (key) process.env.GEMINI_API_KEY = key; }
});

test('probabilities from the decision model are kept per chunk', async () => {
  const key = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'test';
  try {
    const fetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'gemini-decision-1');
      assert.deepEqual(Object.keys(body.questions), ['c0']);
      return { ok: true, json: async () => ({ answers: { c0: { choice: 'critical', confidence: 0.8, probabilities: { critical: 0.8, relevant: 0.15, filler: 0.05 } } } }) };
    };
    const r = await askModel([{ key: 'k', name: 'f', changed: 1, marked: '+ x' }], { file: 'a.js' }, { fetcher });
    assert.equal(r.status, 'used');
    assert.equal(r.answers.k.p.relevant, 0.15);
  } finally { if (key) process.env.GEMINI_API_KEY = key; else delete process.env.GEMINI_API_KEY; }
});
