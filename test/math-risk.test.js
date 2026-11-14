import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict, likelihood, impact, summarize, POLICY, band } from '../server/math/risk.js';
import { lexicon, merge, words } from '../server/math/sensitivity.js';

const unit = (o = {}) => ({ id: 'f::x', kind: 'function', status: 'modified', isTest: false, exported: false, lines: { added: 4, removed: 1 }, change: { kind: 'logic' }, findings: [], rates: [], metrics: { after: { cyclomatic: 2 }, before: { cyclomatic: 2 } }, centrality: { dependents: 3, pagerankPct: 0.4, dependentsPct: 0.5, fanInPct: 0.3 }, tests: { reachedBy: 2, changed: 0 }, ...o });

test('a proof wins over every measurement, and only a proof says it cannot change behaviour', () => {
  const v = verdict(unit({ proof: { proved: true, level: 'identical', claim: 'Same tokens.' }, lines: { added: 400, removed: 300 }, metrics: { after: { cyclomatic: 60 } } }));
  assert.equal(v.verdict, 'proved'); assert.equal(v.claim, 'Same tokens.'); assert.equal(v.priority, 0);
  // Small, simple, nothing flagged, and a test written with it reaches it: no reason to look here first. Still not a proof.
  const c = verdict(unit({ tests: { reachedBy: 2, changed: 1 } }));
  assert.equal(c.verdict, 'cleared'); assert.match(c.claim, /Not a proof/);
  // The same change with no test written for it stays open: behaviour changed and nothing vouches for it.
  assert.equal(verdict(unit()).verdict, 'uncertain');
});

test('a failed deterministic check is red whatever the exposure, even next to a proof', () => {
  const f = [{ id: 'dangling', severity: 'bad', title: 'Still called, no longer defined', detail: 'foo is still called from 2 places.' }];
  assert.equal(verdict(unit({ findings: f })).verdict, 'risky');
  assert.equal(verdict(unit({ findings: f, proof: { proved: true, level: 'identical', claim: 'x' } })).verdict, 'risky');
  assert.equal(verdict(unit({ findings: f })).claim, 'foo is still called from 2 places.');
});

test('exposure only orders: more evidence of risk never lowers it, and tests written with the change are weak evidence', () => {
  const base = likelihood(unit()).p;
  assert.ok(likelihood(unit({ lines: { added: 80, removed: 10 } })).p > base);
  assert.ok(likelihood(unit({ metrics: { after: { cyclomatic: 22 }, before: { cyclomatic: 4 } } })).p > base);
  assert.ok(likelihood(unit({ tests: { reachedBy: 0, changed: 0 } })).p > base);
  assert.ok(likelihood(unit({ entropy: { bits: 9, z: 2.5 } })).p > base);
  assert.equal(likelihood(unit({ entropy: { bits: 2, z: -2 } })).p, base, 'code that looks usual is not reassurance');
  const withTests = likelihood(unit({ tests: { reachedBy: 2, changed: 1 } })).p;
  assert.ok(withTests < base && withTests > base / 2, 'a test by the same author lowers exposure a little, not a lot');
  assert.equal(band(POLICY.cleared - 0.01), 'low'); assert.equal(band(POLICY.risky), 'high');
});

test('thresholds: big untested complex change is risky, complexity over the hard limit is risky on its own', () => {
  const big = verdict(unit({ lines: { added: 120, removed: 20 }, metrics: { after: { cyclomatic: 24 }, before: null }, status: 'added', tests: { reachedBy: 0, changed: 0 } }));
  assert.equal(big.verdict, 'risky'); assert.match(big.claim, /High exposure/);
  const cyc = [{ id: 'cyclomatic', label: 'Cyclomatic complexity', value: 31, warn: 10, bad: 20, tone: 'bad' }];
  const over = verdict(unit({ rates: cyc, metrics: { after: { cyclomatic: 31 }, before: { cyclomatic: 12 } } }));
  assert.equal(over.verdict, 'risky'); assert.match(over.claim, /over the limit of 20/);
  // A function that was already that complex and did not grow: the pull request is not blamed for the threshold.
  const old = verdict(unit({ rates: cyc, lines: { added: 1, removed: 1 }, metrics: { after: { cyclomatic: 31 }, before: { cyclomatic: 31 } }, tests: { reachedBy: 3, changed: 1 } }));
  assert.notEqual(old.verdict, 'risky'); assert.doesNotMatch(old.claim, /over the limit/);
  const amber = verdict(unit({ rates: [{ id: 'nesting', label: 'Nesting', value: 5, warn: 4, bad: 6, tone: 'warn' }], metrics: { after: { cyclomatic: 2, nesting: 5 }, before: { cyclomatic: 2, nesting: 3 } } }));
  assert.equal(amber.verdict, 'uncertain');
});

test('impact: rank in the dependency graph, floors for public symbols and expensive domains, tests are small', () => {
  assert.ok(impact(unit({ centrality: { dependents: 90, pagerankPct: 0.99, dependentsPct: 0.99, fanInPct: 0.9 } })).v > 0.9);
  assert.ok(impact(unit({ centrality: { dependents: 0, pagerankPct: 0.1, dependentsPct: 0, fanInPct: 0 } })).v < 0.01);
  assert.equal(impact(unit({ exported: true, centrality: {} })).v, POLICY.exportedFloor);
  assert.equal(impact(unit({ sensitive: { level: 'critical', label: 'Money' }, centrality: {} })).v, POLICY.sensitiveFloor.critical);
  assert.equal(impact(unit({ isTest: true })).v, 0.12);
});

test('removed code is settled only when nothing calls it any more', () => {
  assert.equal(verdict(unit({ status: 'removed', stillUsed: 0 })).verdict, 'cleared');
  assert.equal(verdict(unit({ status: 'removed', stillUsed: 2 })).verdict, 'risky');
});

test('the summary counts lines by what settled them and names where to look first', () => {
  const us = [unit({ id: 'a', proof: { proved: true, claim: 'p' }, lines: { added: 10, removed: 0 } }), unit({ id: 'b', lines: { added: 50, removed: 0 }, tests: { reachedBy: 0, changed: 0 }, centrality: { dependents: 50, pagerankPct: 0.95, dependentsPct: 0.95 } }), unit({ id: 'c' })].map((u) => ({ ...u, ...verdict(u) }));
  const s = summarize(us);
  assert.equal(s.lines.total, 65); assert.equal(s.lines.proved, 10); assert.equal(s.nodes.proved, 1);
  assert.equal(s.first, 'b'); assert.equal(s.open, us.filter((u) => ['uncertain', 'risky'].includes(u.verdict)).length);
  assert.ok(s.settledShare > 0 && s.settledShare < 1);
});

test('sensitivity: the name decides, the body can only make a node elevated, the model can only raise', () => {
  assert.deepEqual(words('applyCouponDiscount_v2/HTTPServer.cs'), ['apply', 'coupon', 'discount', 'v2', 'http', 'server', 'cs']);
  assert.equal(lexicon({ name: 'cartTotal' }).level, 'critical');
  assert.equal(lexicon({ name: 'formatLabel', text: 'return a + b' }).level, 'normal');
  assert.equal(lexicon({ name: 'helper', text: 'const total = price * amount' }).level, 'elevated');
  assert.equal(lexicon({ name: 'helper', text: 'total' }).level, 'normal');
  const lex = lexicon({ name: 'formatLabel' });
  assert.equal(merge(lex, { choice: 'critical', confidence: 0.92 }).level, 'critical');
  assert.equal(merge(lex, { choice: 'critical', confidence: 0.6 }).level, 'normal', 'below the confidence threshold nothing changes');
  assert.equal(merge(lexicon({ name: 'cartTotal' }), { choice: 'routine', confidence: 0.99 }).level, 'critical', 'a model cannot lower the stakes');
});
