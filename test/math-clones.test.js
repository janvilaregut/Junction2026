import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/math/lex.js';
import { DEFAULTS, normalize, kgramHashes, winnow, CloneIndex, similarity, duplicationWithin } from '../server/math/clones.js';

// ---- helpers -------------------------------------------------------------------------------------------
// Deterministic "random-looking" streams (mulberry32): the same seed always gives the same tokens.
const rng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ALPHA = ['+', '-', '*', '/', '%', '=', '<', '>', '(', ')', '[', ']', '{', '}', ';', ',', '.', '?', ':', '!', '&', '|', '^', '~'];
const stream = (r, n) => Array.from({ length: n }, () => ALPHA[Math.floor(r() * ALPHA.length)]);
const other = (v) => ALPHA[(ALPHA.indexOf(v) + 1) % ALPHA.length];
/** Operator tokens, one per line, so that a line number is a token index + 1. */
const ops = (values, line = 1) => values.map((v, i) => ({ k: 'op', v, l: line + i }));
const lines = (from, n) => ({ start: from + 1, end: from + n });

/** Two streams that share one run of exactly `len` tokens: the tokens around the run differ, so it is maximal. */
function plant(seed, len) {
  const r = rng(seed), run = stream(r, len), d = stream(r, 150 + Math.floor(r() * 100)), q = stream(r, 150 + Math.floor(r() * 100));
  const dat = 1 + Math.floor(r() * (d.length - 2)), qat = 1 + Math.floor(r() * (q.length - 2));
  const D = [...d.slice(0, dat), ...run, ...d.slice(dat)], Q = [...q.slice(0, qat), ...run, ...q.slice(qat)];
  if (D[dat - 1] === Q[qat - 1]) Q[qat - 1] = other(Q[qat - 1]);
  if (D[dat + len] === Q[qat + len]) Q[qat + len] = other(Q[qat + len]);
  return { D, Q, dat, qat };
}
const { k: K, w: W } = DEFAULTS, T = K + W - 1;

// ---- normalisation -------------------------------------------------------------------------------------
test('DEFAULTS give a guarantee threshold of 40 tokens', () => {
  assert.deepEqual(DEFAULTS, { k: 20, w: 21 });
  assert.equal(T, 40);
  assert.equal(new CloneIndex().t, 40);
});

test('normalize: identifiers, numbers and strings collapse; keywords, operators and directives keep their text; nl is dropped', () => {
  const toks = [{ k: 'kw', v: 'if', l: 1 }, { k: 'op', v: '(', l: 1 }, { k: 'id', v: 'count', l: 1 }, { k: 'op', v: '>=', l: 1 }, { k: 'num', v: '0x1F', l: 1 }, { k: 'op', v: ')', l: 1 },
    { k: 'nl', v: '\n', l: 2 }, { k: 'id', v: 'log', l: 2 }, { k: 'op', v: '(', l: 2 }, { k: 'str', v: '"hi"', l: 2 }, { k: 'op', v: ')', l: 2 }, { k: 'pp', v: '#if DEBUG', l: 3 }];
  assert.deepEqual(normalize(toks), ['if', '(', 'I', '>=', 'N', ')', 'I', '(', 'S', ')', '#if DEBUG']);
  assert.deepEqual(normalize([]), []);
});

test('normalize on real lexer output: comments and layout are already gone, renamed code is equal', () => {
  const a = normalize(tokenize('total = price * qty + 1; // sum\n', 'js'));
  const b = normalize(tokenize('acc=mass*count+250;', 'js'));
  assert.deepEqual(a, ['I', '=', 'I', '*', 'I', '+', 'N', ';']);
  assert.deepEqual(a, b);
  assert.deepEqual(normalize(tokenize('x = y + 1;\nz();', 'js', { nl: true })), ['I', '=', 'I', '+', 'N', ';', 'I', '(', ')', ';']);
  // Built-in type names are keywords: they keep their text, so a changed type is a difference.
  assert.notDeepEqual(normalize(tokenize('int x = a + b;', 'cs')), normalize(tokenize('long x = a + b;', 'cs')));
});

// ---- k-gram hashes -------------------------------------------------------------------------------------
// The definition, written out independently with BigInt: FNV-1a of the token text with an avalanche, then
// H(c1..ck) = Σ ci · b^(k − i + 1) mod 2^32 (Karp-Rabin, second form of section 2.2 of the winnowing paper).
const M32 = 1n << 32n, B = 0x9e3779b1n;
function refTokenHash(s) {
  let h = 0x811c9dc5n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * 0x01000193n) % M32;
  h ^= h >> 16n; h = (h * 0x85ebca6bn) % M32; h ^= h >> 13n; h = (h * 0xc2b2ae35n) % M32; h ^= h >> 16n;
  return h;
}
const refHash = (gram) => Number(gram.reduce((h, s) => ((h + refTokenHash(s)) * B) % M32, 0n));

test('kgramHashes: one hash per k-gram, equal to the polynomial computed from scratch', () => {
  const norm = ['I', '=', 'I', '+', 'N', ';', 'return', 'I', '.', 'I', '(', 'S', ')', ';'];
  for (const k of [1, 2, 3, 5, 14]) {
    const hs = kgramHashes(norm, k);
    assert.equal(hs.length, norm.length - k + 1);
    for (let i = 0; i < hs.length; i++) assert.equal(hs[i], refHash(norm.slice(i, i + k)), `k=${k} i=${i}`);
  }
  // k = 1 by hand: H(c) = c · b mod 2^32.
  assert.equal(kgramHashes(['I'], 1)[0], Number((refTokenHash('I') * B) % M32));
});

test('kgramHashes: rolling equals recomputing, equal k-grams hash equal wherever they are, values are 32-bit', () => {
  const norm = stream(rng(3), 500);
  const hs = kgramHashes(norm, K);
  for (let i = 0; i < hs.length; i += 7) assert.equal(hs[i], kgramHashes(norm.slice(i, i + K), K)[0]);
  const twice = [...norm.slice(100, 100 + K), '~', ...norm.slice(100, 100 + K)], h2 = kgramHashes(twice, K);
  assert.equal(h2[0], h2[K + 1]);
  assert.equal(h2[0], hs[100]);
  for (const h of hs) assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('kgramHashes: empty, shorter than k, exactly k, invalid k', () => {
  assert.equal(kgramHashes([], 20).length, 0);
  assert.equal(kgramHashes(['I', '=', 'N'], 4).length, 0);
  assert.equal(kgramHashes(['I', '=', 'N', ';'], 4).length, 1);
  assert.throws(() => kgramHashes(['I'], 0), RangeError);
  assert.throws(() => kgramHashes(['I'], 1.5), RangeError);
});

// ---- winnowing -----------------------------------------------------------------------------------------
test('winnow: the worked example of the paper (figure 2, windows of four)', () => {
  const hashes = [77, 74, 42, 17, 98, 50, 17, 98, 8, 88, 67, 39, 77, 74, 42, 17, 98];
  const expected = [{ h: 17, i: 3 }, { h: 17, i: 6 }, { h: 8, i: 8 }, { h: 39, i: 11 }, { h: 17, i: 15 }];
  assert.deepEqual(winnow(hashes, 4), expected);
  assert.deepEqual(winnow(hashes, 4, { robust: true }), expected);
});

test('winnow: ties go to the rightmost minimum; robust winnowing keeps the previous choice while it lasts', () => {
  assert.deepEqual(winnow([3, 1, 1, 4], 4), [{ h: 1, i: 2 }]);
  assert.deepEqual(winnow([3, 1, 1, 4], 4, { robust: true }), [{ h: 1, i: 2 }]);
  // All equal: every window's rightmost element is new (Definition 1) against one per window length (Definition 3).
  const flat = [5, 5, 5, 5, 5, 5, 5, 5];
  assert.deepEqual(winnow(flat, 3).map((f) => f.i), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(winnow(flat, 3, { robust: true }).map((f) => f.i), [2, 5]);
  // A new equal minimum enters: taken by Definition 1, ignored by Definition 3 until the old one leaves.
  assert.deepEqual(winnow([9, 2, 9, 2, 9, 9, 9], 3).map((f) => f.i), [1, 3, 6]);
  assert.deepEqual(winnow([9, 2, 9, 2, 9, 9, 9], 3, { robust: true }).map((f) => f.i), [1, 3, 6]);
  // The first window has no predecessor: rightmost minimum in both variants.
  assert.deepEqual(winnow([2, 9, 2, 9, 9], 3).map((f) => f.i), [2]);
  assert.deepEqual(winnow([2, 9, 2, 9, 9], 3, { robust: true }).map((f) => f.i), [2]);
  // Windows of four: (9 5 9 9) → 1; (5 9 9 5) ties, Definition 1 moves to 4, Definition 3 stays on 1; (9 9 5 1) → 5.
  assert.deepEqual(winnow([9, 5, 9, 9, 5, 1, 9, 9, 9], 4).map((f) => f.i), [1, 4, 5]);
  assert.deepEqual(winnow([9, 5, 9, 9, 5, 1, 9, 9, 9], 4, { robust: true }).map((f) => f.i), [1, 5]);
});

test('winnow: empty, shorter than a window, window of one, invalid window', () => {
  assert.deepEqual(winnow([], 4), []);
  assert.deepEqual(winnow([7], 4), [{ h: 7, i: 0 }]);
  assert.deepEqual(winnow([7, 3, 3], 4), [{ h: 3, i: 2 }]); // one partial window: its rightmost minimum
  assert.deepEqual(winnow([4, 2, 6], 1).map((f) => f.i), [0, 1, 2]);
  assert.throws(() => winnow([1, 2], 0), RangeError);
});

test('winnow: every window holds a fingerprint that is its minimum, positions ascend and are unique, density is 2/(w+1)', () => {
  const r = rng(42), hashes = Array.from({ length: 60000 }, () => Math.floor(r() * 2 ** 32));
  for (const robust of [false, true]) {
    const fp = winnow(hashes, W, { robust }), at = new Set(fp.map((f) => f.i));
    assert.equal(at.size, fp.length);
    for (let j = 1; j < fp.length; j++) assert.ok(fp[j].i > fp[j - 1].i);
    for (const f of fp) assert.equal(f.h, hashes[f.i]);
    for (let l = 0; l + W <= hashes.length; l++) {
      let min = Infinity, hit = false;
      for (let i = l; i < l + W; i++) min = Math.min(min, hashes[i]);
      for (let i = l; i < l + W && !hit; i++) hit = at.has(i) && hashes[i] === min;
      assert.ok(hit, `window at ${l} has no selected minimum`);
    }
    assert.ok(Math.abs(fp.length / hashes.length - 2 / (W + 1)) < 0.004, `density ${fp.length / hashes.length}`);
  }
});

test('kgramHashes feed winnowing well: density on random-looking tokens is 2/(w+1)', () => {
  const hs = kgramHashes(stream(rng(7), 120000), K);
  assert.ok(Math.abs(winnow(hs, W).length / hs.length - 2 / (W + 1)) < 0.004);
});

// ---- the guarantee -------------------------------------------------------------------------------------
test('guarantee: a shared run of exactly t tokens is always found, with its exact extent', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { D, Q, dat, qat } = plant(seed, T), ix = new CloneIndex();
    ix.add('noise', ops(stream(rng(seed + 10000), 200)));
    ix.add('d', ops(D), { seed });
    const r = ix.query(ops(Q));
    assert.equal(r.length, 1, `seed ${seed}`);
    assert.equal(r.distinct, 1);
    assert.equal(r[0].id, 'd');
    assert.deepEqual(r[0].meta, { seed });
    assert.equal(r[0].tokens, T);
    assert.equal(r[0].coverage, T / Q.length);
    assert.deepEqual(r[0].spans, [{ a: lines(qat, T), b: lines(dat, T), tokens: T, repetitive: 0 }]);
    assert.equal(r.covered, T);
    assert.equal(r.queryTokens, Q.length);
    assert.equal(r.truncated, false);
  }
});

test('guarantee is tight: a run of t − 1 tokens may be missed, and whatever is reported is still exact', () => {
  let found = 0, missed = 0;
  for (let seed = 1; seed <= 1200; seed++) {
    const { D, Q, dat, qat } = plant(seed, T - 1), ix = new CloneIndex();
    ix.add('d', ops(D));
    assert.equal(ix.query(ops(Q)).length, 0, 'below the default minTokens nothing is reported');
    const r = ix.query(ops(Q), { minTokens: K });
    if (!r.length) { missed++; continue; }
    found++;
    assert.deepEqual(r[0].spans, [{ a: lines(qat, T - 1), b: lines(dat, T - 1), tokens: T - 1, repetitive: 0 }]);
  }
  assert.ok(missed > 0, 't − 1 is below the guarantee: some run must go undetected');
  assert.ok(found > missed, 'most are still found, as a best effort');
});

test('noise threshold: a shared run shorter than k is never reported, whatever minTokens says', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { D, Q } = plant(seed, K - 1), ix = new CloneIndex();
    ix.add('d', ops(D));
    assert.equal(ix.query(ops(Q), { minTokens: 1 }).length, 0);
  }
});

test('guarantee holds for other parameters (k = 5, w = 4, t = 8) and matches extend past the seed in both directions', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const len = seed % 2 ? 8 : 8 + (seed % 37), { D, Q, dat, qat } = plant(seed, len), ix = new CloneIndex({ k: 5, w: 4 });
    assert.equal(ix.t, 8);
    ix.add('d', ops(D));
    const hit = ix.query(ops(Q)).find((m) => m.spans.some((s) => s.tokens === len));
    assert.ok(hit, `seed ${seed}`);
    assert.deepEqual(hit.spans.find((s) => s.tokens === len), { a: lines(qat, len), b: lines(dat, len), tokens: len, repetitive: 0 });
  }
});

test('guarantee under ties: a unit of 12 tokens repeated (not a pure repetition) is found at every alignment, listed as a tiling', () => {
  const unit = ['(', '+', '[', '-', '*', ')', '/', ']', '%', '=', '<', ';']; // period 12 > k/2
  const rep = (n) => Array.from({ length: n }, () => unit).flat();
  const D = ['~', '~', ...rep(5), '?', '?'], Q = [':', ...rep(20), '!'];
  const ix = new CloneIndex();
  ix.add('d', ops(D));
  const r = ix.query(ops(Q));
  assert.equal(r.length, 1);
  assert.equal(r[0].tokens, 240);          // every token of the 20 repetitions lies in some alignment of the 5
  assert.equal(r[0].repetitive, 0);
  assert.deepEqual(r[0].spans, [0, 60, 120, 180].map((at) => ({ a: lines(1 + at, 60), b: lines(2, 60), tokens: 60, repetitive: 0 })));
});

// ---- renamed copies, real code -------------------------------------------------------------------------
const ORIGINAL = `
  let sum = 0;
  for (const item of items) {
    if (item.qty > 0) { sum += item.price * item.qty; } else { skipped.push(item.sku); }
  }
  return round2(sum - discount(items, 0.1));`;
const RENAMED = `
  let acc = 100; // different names, different literals, different layout
  for (const box of boxes) {
    if (box.count > 5) {
      acc += box.mass * box.count;
    } else {
      ignored.push(box.id);
    }
  }
  return trim(acc - tare(boxes, 2.5));`;

test('renamed copy (type-2 clone) matches completely; a structural change does not', () => {
  const a = tokenize(ORIGINAL, 'js'), b = tokenize(RENAMED, 'js');
  assert.equal(a.length, 59);
  const ix = new CloneIndex();
  ix.add('original', a, { file: 'cart.js' });
  const r = ix.query(b);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'original');
  assert.deepEqual(r[0].meta, { file: 'cart.js' });
  assert.equal(r[0].tokens, a.length);
  assert.equal(r[0].coverage, 1);
  assert.deepEqual(r[0].spans, [{ a: { start: 2, end: 10 }, b: { start: 2, end: 6 }, tokens: a.length, repetitive: 0 }]);
  // `*` became `/` at token 28 of 59: runs of 27 and 31 tokens remain, both shorter than t, so nothing is claimed.
  const changed = tokenize(RENAMED.replace('box.mass * box.count', 'box.mass / box.count'), 'js');
  assert.equal(ix.query(changed).length, 0);
  // `>` became `>=` at token 19: the 40 tokens after it are still a shared run of exactly t, and are reported.
  const tail = ix.query(tokenize(RENAMED.replace('box.count > 5', 'box.count >= 5'), 'js'));
  assert.deepEqual(tail.map((m) => [m.tokens, m.spans]), [[40, [{ a: { start: 4, end: 10 }, b: { start: 4, end: 6 }, tokens: 40, repetitive: 0 }]]]);
});

test('line ranges: the lines where the first and last token of the match start, in the query and in the candidate', () => {
  const block = [
    'const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);', // 26 tokens
    'if (total > limit) {',                                                       //  7
    "  log.warn('over', total);",                                                 //  9
    '  return clamp(total, 0, limit);',                                           // 10
    '}',                                                                          //  1
    'for (const item of items) {',                                                //  8
    '  seen.add(item.sku);',                                                      //  9
    '}',                                                                          //  1   = 71
  ];
  const candidate = ['let ready = [1, 2, 3];', 'ready = ready[0]', ...block, 'throw err;'].join('\n');             // block on lines 3–10
  const query = ['// a comment', 'function g(x) {', '  /* a block', '     comment */', '  check(x)', ...block, 'return 0;'].join('\n'); // lines 6–13
  const ix = new CloneIndex();
  ix.add('c', tokenize(candidate, 'js'));
  const r = ix.query(tokenize(query, 'js'));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].spans, [{ a: { start: 6, end: 13 }, b: { start: 3, end: 10 }, tokens: 71, repetitive: 0 }]);
  assert.equal(r[0].tokens, 71);
});

// ---- hash collisions -----------------------------------------------------------------------------------
test('hash collision: two different k-grams with the same 32-bit hash are not a match', () => {
  const g1 = ['[', '<', '&', '&'], g2 = ['{', '|', ';', '=']; // found by search; the assertion below keeps it honest
  assert.equal(kgramHashes(g1, 4)[0], kgramHashes(g2, 4)[0]);
  assert.notDeepEqual(g1, g2);
  const ix = new CloneIndex({ k: 4, w: 2 });
  assert.equal(ix.add('d', ops(g1)), 1);
  const collide = ix.query(ops(g2), { minTokens: 1 });
  assert.equal(collide.length, 0);
  assert.equal(collide.distinct, 0);
  assert.equal(ix.query(ops(g1), { minTokens: 1 }).length, 1); // the same k-gram is found
  // Longer sequences around the colliding k-grams: still nothing.
  const ix2 = new CloneIndex({ k: 4, w: 2 });
  ix2.add('d', ops(['~', '?', ...g1, '!', ':']));
  assert.equal(ix2.query(ops(['+', '-', ...g2, '*', '/']), { minTokens: 1 }).length, 0);
});

test('hash collision, forced: a posting that points at different tokens is rejected by the token comparison', () => {
  const r = rng(99), D = stream(r, 300), Q = stream(r, 300), ix = new CloneIndex();
  ix.add('d', ops(D));
  const qh = kgramHashes(Q, K);
  for (let i = 0; i < qh.length; i++) ix.postings.set(qh[i], [0, i % (D.length - K + 1)]); // every query k-gram now "collides"
  const res = ix.query(ops(Q), { minTokens: 1 });
  assert.equal(res.length, 0);
  assert.equal(res.covered, 0);
});

// ---- query: bookkeeping --------------------------------------------------------------------------------
test('query: sorted by tokens, coverage counts overlaps once, exclude, limit and distinct', () => {
  const r = rng(5), X = stream(r, 60), Y = stream(r, 100), sep = () => stream(r, 30);
  const Q = ['~', ...X, '?', '?', ...Y, '~'];
  const ix = new CloneIndex();
  ix.add('hasX', ops([...sep(), ...X, ...sep()]));
  ix.add('hasY', ops([...sep(), ...Y, ...sep()]));
  ix.add('hasYXtwice', ops([...Y, ...sep(), ...X, ...sep(), ...X, '!']));
  ix.add('nothing', ops(sep()));
  ix.add('tiny', ops(['+']));
  assert.equal(ix.size, 5);
  const res = ix.query(ops(Q));
  assert.deepEqual(res.map((m) => [m.id, m.tokens]), [['hasYXtwice', 160], ['hasY', 100], ['hasX', 60]]);
  assert.equal(res.distinct, 3);
  assert.equal(res.covered, 160);
  assert.equal(res.queryTokens, 164);
  assert.equal(res[0].coverage, 160 / 164);
  // X occurs twice in that candidate (at 130 and at 220): counted once and listed once, with either occurrence;
  // spans come in query order.
  const at = res[0].spans[0].b.start - 1;
  assert.ok(at === 130 || at === 220);
  assert.deepEqual(res[0].spans, [{ a: lines(1, 60), b: lines(at, 60), tokens: 60, repetitive: 0 }, { a: lines(63, 100), b: lines(0, 100), tokens: 100, repetitive: 0 }]);
  assert.deepEqual(res[2].spans, [{ a: lines(1, 60), b: lines(30, 60), tokens: 60, repetitive: 0 }]);

  assert.deepEqual(ix.query(ops(Q), { exclude: new Set(['hasYXtwice']) }).map((m) => m.id), ['hasY', 'hasX']);
  assert.deepEqual(ix.query(ops(Q), { exclude: ['hasYXtwice', 'hasY'] }).map((m) => m.id), ['hasX']);
  assert.deepEqual(ix.query(ops(Q), { minTokens: 61 }).map((m) => [m.id, m.tokens]), [['hasY', 100], ['hasYXtwice', 100]]); // a tie: order of add
  const top = ix.query(ops(Q), { limit: 1 });
  assert.equal(top.length, 1);
  assert.equal(top.distinct, 3); // the caller still learns how many candidates share this code
  assert.equal(top[0].id, 'hasYXtwice');
});

test('query: an idiom repeated in many places shows in distinct; ties keep the order of add', () => {
  const r = rng(8), idiom = stream(r, 50), ix = new CloneIndex();
  const before = other(idiom[0]), after = other(idiom[49]); // delimiters that cannot extend the idiom
  for (let d = 0; d < 25; d++) ix.add(`f${d}`, ops([...stream(r, 20 + d), before, ...idiom, after, ...stream(r, 20)]));
  const res = ix.query(ops([other(before), ...idiom, other(after)]));
  assert.equal(res.distinct, 25);
  assert.deepEqual(res.map((m) => m.id), Array.from({ length: 25 }, (_, d) => `f${d}`));
  assert.ok(res.every((m) => m.tokens === 50 && m.coverage === 50 / 52));
});

test('query: the same input gives the same output, whatever was added before', () => {
  const r = rng(21), X = stream(r, 80), Q = ops(['~', ...X]), D = ops([...X, '?']);
  const one = new CloneIndex(), two = new CloneIndex();
  one.add('d', D);
  two.add('other', ops(stream(r, 500))); two.add('d', D);
  assert.deepEqual([...one.query(Q)], [...two.query(Q)]);
  assert.deepEqual([...one.query(Q)], [...one.query(Q)]);
});

test('empty and tiny inputs', () => {
  const ix = new CloneIndex();
  const none = ix.query(ops(stream(rng(1), 100)));
  assert.deepEqual([...none], []);
  assert.deepEqual([none.distinct, none.queryTokens, none.covered, none.truncated], [0, 100, 0, false]);
  assert.equal(ix.add('empty', []), 0);
  assert.equal(ix.add('short', ops(stream(rng(2), K - 1))), 0);       // below k: no k-gram, never matches
  assert.equal(ix.add('exactlyK', ops(stream(rng(3), K))), 1);        // one k-gram: one fingerprint
  assert.equal(ix.fingerprints, 1);
  const empty = ix.query([]);
  assert.deepEqual([...empty], []);
  assert.deepEqual([empty.distinct, empty.queryTokens, empty.covered], [0, 0, 0]);
  assert.equal(ix.query(ops(stream(rng(2), K - 1)), { minTokens: 1 }).length, 0);
  // A function of exactly k tokens copied whole is below the guarantee but is found when asked for.
  const whole = ix.query(ops(stream(rng(3), K)), { minTokens: K });
  assert.deepEqual(whole.map((m) => [m.id, m.tokens, m.coverage]), [['exactlyK', K, 1]]);
  assert.throws(() => new CloneIndex({ k: 0 }), RangeError);
  assert.throws(() => new CloneIndex({ w: -1 }), RangeError);
});

// ---- repetition and the work budget --------------------------------------------------------------------
const list = (n) => Array.from({ length: n }, (_, i) => [{ k: 'num', v: String(i * 7), l: 1 }, { k: 'op', v: ',', l: 1 }]).flat();
const relined = (toks) => toks.map((t, i) => ({ ...t, l: i + 1 }));

test('pure repetition is not a match: two lists of literals in different surroundings share nothing reportable', () => {
  const r = rng(13), ix = new CloneIndex();
  assert.equal(ix.add('table', relined(list(200))), 0); // nothing but `N ,` repeated: no fingerprint at all
  ix.add('d', relined([...ops(stream(r, 40)), ...list(40), ...ops(stream(r, 40))]));
  const res = ix.query(relined([...ops(stream(r, 30)), ...list(60), ...ops(stream(r, 30))]), { minTokens: K });
  assert.equal(res.length, 0);
});

test('repetition attached to real code is matched and counted as repetitive', () => {
  const r = rng(14), head = stream(r, 12), ix = new CloneIndex();
  const D = relined([...ops(stream(r, 25)), ...ops(head), ...list(40), ...ops(['?', '?'])]);
  const Q = relined([...ops(stream(r, 33)), ...ops(head), ...list(40), ...ops(['!', '!'])]);
  ix.add('d', D);
  const res = ix.query(Q);
  assert.equal(res.length, 1);
  assert.equal(res[0].tokens, 92);
  assert.equal(res[0].repetitive, 80); // the 40 `N ,` pairs; the 12 tokens in front carry the information
  assert.deepEqual(res[0].spans, [{ a: lines(33, 92), b: lines(25, 92), tokens: 92, repetitive: 80 }]);
});

test('work budget: a query that runs out says truncated and reports only verified matches', () => {
  const r = rng(17), block = stream(r, 100), docs = Array.from({ length: 30 }, () => ops([...stream(r, 10), ...block, ...stream(r, 10)]));
  const full = new CloneIndex(), tight = new CloneIndex({ maxWork: 500 });
  docs.forEach((d, i) => { full.add(`f${i}`, d); tight.add(`f${i}`, d); });
  const Q = ops(['~', ...block, '~']);
  const all = full.query(Q), some = tight.query(Q);
  assert.equal(all.truncated, false);
  assert.equal(all.distinct, 30);
  assert.equal(some.truncated, true);
  assert.ok(some.distinct > 0 && some.distinct < 30);
  for (const m of some) assert.deepEqual(m.spans[0].a, lines(1, 100));
  const self = duplicationWithin(ops([...block, '~', ...block, '?', ...block]), { maxWork: 10 });
  assert.equal(self.truncated, true);
});

// ---- similarity ----------------------------------------------------------------------------------------
test('similarity: hand-checked Jaccard and containment over 2-shingles', () => {
  const a = ops(['(', '+', ')', '*', '[', ']']), b = ops(['(', '+', ')', '*', '[', '-', '{']);
  // A = {(+, +), )*, *[, []}  B = {(+, +), )*, *[, [-, -{}  shared 4, union 7
  assert.deepEqual(similarity(a, b, 2), { jaccard: 4 / 7, containmentA: 4 / 5, containmentB: 4 / 6, identical: false, shared: 4, sizeA: 5, sizeB: 6 });
  assert.deepEqual(similarity(b, a, 2), { jaccard: 4 / 7, containmentA: 4 / 6, containmentB: 4 / 5, identical: false, shared: 4, sizeA: 6, sizeB: 5 });
  assert.deepEqual(similarity(a, a, 2), { jaccard: 1, containmentA: 1, containmentB: 1, identical: true, shared: 5, sizeA: 5, sizeB: 5 });
});

test('similarity: identical means equal normalised sequences, nothing more and nothing less', () => {
  const a = tokenize(ORIGINAL, 'js'), b = tokenize(RENAMED, 'js');
  const s = similarity(a, b);
  assert.equal(s.identical, true); // renamed and re-laid-out: same normalised sequence
  assert.equal(s.jaccard, 1);
  // Sets ignore order and repetition: jaccard 1 without being identical.
  const x = ops(['+', '-', '+', '-', '+']), y = ops(['+', '-', '+', '-', '+', '-', '+']);
  assert.deepEqual(similarity(x, y, 2), { jaccard: 1, containmentA: 1, containmentB: 1, identical: false, shared: 2, sizeA: 2, sizeB: 2 });
  // One changed operator in the middle touches k shingles.
  const c = tokenize(RENAMED.replace('acc - tare', 'acc + tare'), 'js'), t = similarity(a, c);
  assert.equal(t.identical, false);
  assert.equal(t.sizeA - t.shared, 5);
  assert.ok(t.jaccard < 1 && t.jaccard > 0.8);
});

test('similarity: empty and tiny sequences', () => {
  assert.deepEqual(similarity([], []), { jaccard: 1, containmentA: 1, containmentB: 1, identical: true, shared: 0, sizeA: 0, sizeB: 0 });
  assert.deepEqual(similarity([], ops(['+', '-'])), { jaccard: 0, containmentA: 1, containmentB: 0, identical: false, shared: 0, sizeA: 0, sizeB: 1 });
  // Shorter than k: the whole sequence is its one shingle.
  assert.deepEqual(similarity(ops(['+', '-']), ops(['+', '-'])), { jaccard: 1, containmentA: 1, containmentB: 1, identical: true, shared: 1, sizeA: 1, sizeB: 1 });
  assert.equal(similarity(ops(['+', '-']), ops(['+', '*'])).jaccard, 0);
  assert.equal(similarity(ops(['+', '-']), ops(['+', '-', '+', '-', '+', '-'])).jaccard, 0); // a short whole is not a 5-shingle of a longer one
  assert.equal(similarity([{ k: 'nl', v: '\n', l: 1 }], []).identical, true);
  assert.throws(() => similarity([], [], 0), RangeError);
});

// ---- duplication inside one function -------------------------------------------------------------------
test('duplicationWithin: a block that appears twice is one pair, earlier range first', () => {
  const r = rng(31), block = stream(r, 50), seq = [...stream(r, 20), ...block, ...stream(r, 35), ...block, ...stream(r, 15)];
  const res = duplicationWithin(ops(seq));
  assert.deepEqual([...res], [{ a: lines(20, 50), b: lines(105, 50), tokens: 50, repetitive: 0 }]);
  assert.deepEqual([res.total, res.duplicated, res.coverage, res.repetitive, res.truncated], [170, 50, 50 / 170, 0, false]);
});

test('duplicationWithin: the guarantee, exactly t and t − 1', () => {
  let missed = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed + 500), block = stream(r, T), pre = stream(r, 40), mid = stream(r, 60), post = stream(r, 40);
    if (pre[39] === mid[59]) mid[59] = other(mid[59]);
    if (mid[0] === post[0]) post[0] = other(post[0]);
    const res = duplicationWithin(ops([...pre, ...block, ...mid, ...block, ...post]));
    assert.deepEqual([...res], [{ a: lines(40, T), b: lines(40 + T + 60, T), tokens: T, repetitive: 0 }], `seed ${seed}`);
    const short = block.slice(1);
    if (pre[39] === mid[59]) mid[59] = other(mid[59]);
    const below = duplicationWithin(ops([...pre, ...short, ...mid, ...short, ...post]), { minTokens: K });
    if (!below.length) missed++; else assert.equal(below[0].tokens, T - 1);
  }
  assert.ok(missed > 0);
});

test('duplicationWithin: a block repeated back to back is cut into disjoint pairs', () => {
  const r = rng(33), A = stream(r, 45), seq = ['~', ...A, ...A, ...A, '?'];
  const res = duplicationWithin(ops(seq));
  // Second and third copy are repeats of something earlier: 90 tokens.
  assert.equal(res.duplicated, 90);
  assert.equal(res.total, 137);
  for (const s of res) { assert.ok(s.a.end < s.b.start, 'ranges are disjoint'); assert.ok(s.tokens >= T); }
  assert.deepEqual(res[0], { a: lines(1, 45), b: lines(46, 45), tokens: 45, repetitive: 0 });
});

test('duplicationWithin: nothing to report', () => {
  const none = duplicationWithin([]);
  assert.deepEqual([...none], []);
  assert.deepEqual([none.total, none.duplicated, none.coverage, none.repetitive, none.truncated], [0, 0, 0, 0, false]);
  assert.equal(duplicationWithin(ops(stream(rng(40), 400))).length, 0);
  assert.equal(duplicationWithin(ops(stream(rng(41), 30))).length, 0);
  // A table of constants repeats, but only a unit below the noise threshold: not a self-clone.
  const table = duplicationWithin(relined(list(500)));
  assert.equal(table.length, 0);
  assert.equal(table.duplicated, 0);
  // A second, partial copy of 25 tokens: below t, so silent by default and found when asked for.
  const A = stream(rng(42), 30);
  assert.equal(duplicationWithin(ops([...A, ...A.slice(0, 25)]), { minTokens: K }).length, 1);
  assert.equal(duplicationWithin(ops([...A, ...A.slice(0, 25)])).length, 0);
  assert.throws(() => duplicationWithin([], { k: 0 }), RangeError);
});

// ---- against brute force -------------------------------------------------------------------------------
// The definition, computed the slow way: every maximal run of equal tokens on every diagonal (no hashing, no
// fingerprints, no shortcuts). Small alphabet and small k, w so that ties, repetition and chance matches abound.
const REF = { k: 6, w: 5 }, REF_T = REF.k + REF.w - 1;

/** Maximal runs of equal tokens between Q and D: [a, b, len] with Q[a..a+len) = D[b..b+len). */
function maximalRuns(Q, D) {
  const runs = [];
  for (let dg = -(D.length - 1); dg < Q.length; dg++) {
    for (let a = Math.max(0, dg); a < Q.length && a - dg < D.length;) {
      let e = a;
      while (e < Q.length && e - dg < D.length && Q[e] === D[e - dg]) e++;
      if (e > a) runs.push([a, a - dg, e - a]);
      a = e + 1;
    }
  }
  return runs;
}
/** True when no k-gram of the run escapes being a unit of at most k/2 tokens repeated. */
function pureRepetition(S, from, len, k) {
  for (let g = from; g + k <= from + len; g++) {
    let periodic = false;
    for (let p = 1; p <= k >> 1 && !periodic; p++) { periodic = true; for (let z = g + p; z < g + k; z++) if (S[z] !== S[z - p]) { periodic = false; break; } }
    if (!periodic) return false;
  }
  return true;
}
/**
 * A sequence built from random stretches, short units repeated, and pieces of a shared pool, some of them with
 * one token changed (a near copy: two runs on the same diagonal, one token apart).
 */
function messy(r, pool) {
  const out = [], small = ['+', '-', '*', '('];
  for (let part = 0, parts = 3 + Math.floor(r() * 6); part < parts; part++) {
    const kind = r();
    if (kind < 0.3) for (let j = 5 + Math.floor(r() * 25); j > 0; j--) out.push(small[Math.floor(r() * small.length)]);
    else if (kind < 0.5) { const unit = Array.from({ length: 1 + Math.floor(r() * 8) }, () => small[Math.floor(r() * 3)]); for (let j = 2 + Math.floor(r() * 9); j > 0; j--) out.push(...unit); }
    else {
      const from = Math.floor(r() * 8), piece = pool[Math.floor(r() * pool.length)].slice(from, from + 12 + Math.floor(r() * 30));
      if (r() < 0.5) piece[Math.floor(r() * piece.length)] = '~';
      out.push(...piece);
    }
  }
  return out;
}

test('query agrees with brute force: coverage per candidate, order, and every listed span is a maximal run', () => {
  let candidates = 0, spans = 0;
  for (let seed = 1; seed <= 250; seed++) {
    const r = rng(seed * 7919), pool = Array.from({ length: 4 }, () => stream(r, 45).map((v) => ['+', '-', '*', '(', ')', ';'][ALPHA.indexOf(v) % 6]));
    const docs = Array.from({ length: 5 }, () => messy(r, pool)), Q = messy(r, pool), ix = new CloneIndex(REF);
    docs.forEach((D, d) => ix.add(d, ops(D)));
    const res = ix.query(ops(Q));
    assert.equal(res.truncated, false);
    const expected = [], all = new Set();
    docs.forEach((D, d) => {
      const covered = new Set();
      for (const [a, b, len] of maximalRuns(Q, D)) if (len >= REF_T && !pureRepetition(Q, a, len, REF.k)) for (let z = a; z < a + len; z++) { covered.add(z); all.add(z); }
      if (covered.size) expected.push([d, covered.size]);
    });
    expected.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    assert.deepEqual(res.map((m) => [m.id, m.tokens]), expected, `seed ${seed}`);
    assert.equal(res.distinct, expected.length);
    assert.equal(res.covered, all.size);
    for (const m of res) {
      const D = docs[m.id], seen = new Set();
      candidates++;
      for (const s of m.spans) {
        const a = s.a.start - 1, b = s.b.start - 1;
        spans++;
        assert.ok(s.tokens >= REF_T);
        assert.deepEqual(Q.slice(a, a + s.tokens), D.slice(b, b + s.tokens));
        assert.ok(a === 0 || b === 0 || Q[a - 1] !== D[b - 1], 'maximal on the left');
        assert.ok(a + s.tokens === Q.length || b + s.tokens === D.length || Q[a + s.tokens] !== D[b + s.tokens], 'maximal on the right');
        assert.ok(!pureRepetition(Q, a, s.tokens, REF.k));
        for (let z = a; z < a + s.tokens; z++) seen.add(z);
      }
      assert.equal(seen.size, m.tokens, 'the listed spans cover exactly what is counted');
      assert.equal(m.coverage, m.tokens / Q.length);
    }
  }
  assert.ok(candidates > 300 && spans > candidates, `the comparison must not be vacuous: ${candidates} candidates, ${spans} spans`);
});

test('duplicationWithin agrees with brute force: the duplicated tokens, and every listed pair is disjoint and identical', () => {
  let nonEmpty = 0, overlapping = 0;
  for (let seed = 1; seed <= 250; seed++) {
    const r = rng(seed * 104729), pool = Array.from({ length: 2 }, () => stream(r, 45).map((v) => ['+', '-', '*', '(', ')', ';'][ALPHA.indexOf(v) % 6]));
    const S = [...messy(r, pool), ...messy(r, pool)], res = duplicationWithin(ops(S), REF);
    assert.equal(res.truncated, false);
    const later = new Set();
    for (let d = 1; d < S.length; d++) {
      for (let a = 0; a + d < S.length;) {
        let e = a;
        while (e + d < S.length && S[e] === S[e + d]) e++;
        const len = e - a;
        if (Math.min(len, d) >= REF_T && !pureRepetition(S, a, len, REF.k)) { if (len > d) overlapping++; for (let z = a + d; z < a + d + len; z++) later.add(z); }
        a = e + 1;
      }
    }
    assert.equal(res.duplicated, later.size, `seed ${seed}`);
    assert.equal(res.total, S.length);
    assert.equal(res.coverage, later.size / S.length);
    if (later.size) nonEmpty++;
    assert.equal(res.length > 0, later.size > 0);
    for (let j = 0; j < res.length; j++) {
      const s = res[j], a = s.a.start - 1, b = s.b.start - 1;
      assert.ok(s.tokens >= REF_T && a + s.tokens <= b, 'long enough and disjoint');
      assert.deepEqual(S.slice(a, a + s.tokens), S.slice(b, b + s.tokens));
      for (let z = b; z < b + s.tokens; z++) assert.ok(later.has(z));
      if (j) assert.ok(res[j - 1].tokens >= s.tokens, 'longest first');
    }
  }
  assert.ok(nonEmpty > 100 && overlapping > 10, `the comparison must not be vacuous: ${nonEmpty} with duplication, ${overlapping} back-to-back runs`);
});
