import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/math/lex.js';
import { NgramModel, PairIndex, lexemes, baselineOf, surprise, hotspots } from '../server/math/entropy.js';

const near = (actual, expected, eps = 1e-12) => assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`);
const prob = (m, context, word) => 2 ** -m.logProb(context, word);
const seq = (s) => s.split(' ');
/** Deterministic pseudo-random integers (Lehmer generator with the MINSTD multiplier 48271): tests must not depend on Math.random. */
const lehmer = (seed) => { let s = seed; return (n) => { s = (s * 48271) % 2147483647; return s % n; }; };

/**
 * The smoothing formula of the module header written the slow, obvious way over string keys, with none of the
 * shortcuts of the implementation: every order is evaluated, in order, from raw counts.
 */
function oracle(seqs, n) {
  const count = new Map(), after = new Map(), types = new Map();
  for (const s of seqs) for (let i = 0; i < s.length; i++) for (let k = 0; k < n && k <= i; k++) {
    const h = s.slice(i - k, i).join(' '), key = `${h}|${s[i]}`;
    if (!count.has(key)) types.set(h, (types.get(h) || 0) + 1);
    count.set(key, (count.get(key) || 0) + 1); after.set(h, (after.get(h) || 0) + 1);
  }
  const V = types.get('') || 0;
  return (context, w) => {
    let p = 1 / (V + 1);
    for (let k = 0; k < n; k++) {
      if (k > context.length) continue;
      const h = context.slice(context.length - k).join(' '), c = after.get(h) || 0;
      if (!c) continue;
      p = ((count.get(`${h}|${w}`) || 0) + types.get(h) * p) / (c + types.get(h));
    }
    return p;
  };
}

// The corpus of the hand computations below: one sequence, a b a b a c.
//   N = 6, V = 3, c(a) = 3, c(b) = 2, c(c) = 1
//   after a: b twice, c once        c(a ·) = 3, T(a) = 2
//   after b: a twice                c(b ·) = 2, T(b) = 1
//   after c: nothing                c(c ·) = 0
//   after a b: a twice              c = 2, T = 1
//   after b a: b once, c once       c = 2, T = 2
const ABABAC = seq('a b a b a c');

test('lexemes: numbers and strings collapse, 0 and 1 stay, line breaks go, the rest is verbatim', () => {
  const t = tokenize('#if DEBUG\nint x = 42 + 0 + 1 + 0x1F + 1.0;\nvar s = "hi" + \'c\';\n#endif', 'cs', { nl: true });
  assert.ok(t.some((x) => x.k === 'nl'));
  assert.deepEqual(lexemes(t), ['#if DEBUG', 'int', 'x', '=', '<num>', '+', '0', '+', '1', '+', '<num>', '+', '<num>', ';', 'var', 's', '=', '<str>', '+', '<str>', ';', '#endif']);
  const plain = tokenize('return a[i] >= 10 ? `x${a}` : null;', 'js');
  const lex = lexemes(plain);
  assert.equal(lex.length, plain.length); // without 'nl' tokens, lexeme i is token i
  assert.deepEqual(lex, ['return', 'a', '[', 'i', ']', '>=', '<num>', '?', '<str>', '${', 'a', '}', '<str>', ':', 'null', ';']);
  assert.deepEqual(lexemes([]), []);
});

test('order 1: unigram probabilities by hand', () => {
  const m = new NgramModel({ n: 1 }).add(ABABAC);
  assert.equal(m.tokens, 6); assert.equal(m.vocabulary, 3);
  // P_1(w) = (c(w) + V · 1/(V+1)) / (N + V) = (c(w) + 3/4) / 9
  near(prob(m, [], 'a'), 3.75 / 9);
  near(prob(m, [], 'b'), 2.75 / 9);
  near(prob(m, [], 'c'), 1.75 / 9);
  near(prob(m, [], 'never'), 0.75 / 9);
  near(prob(m, ['b', 'a'], 'a'), 3.75 / 9); // an order-1 model ignores the context
  near(m.logProb([], 'a'), Math.log2(9 / 3.75));
});

test('order 2: bigram probabilities by hand', () => {
  const m = new NgramModel({ n: 2 }).add(ABABAC);
  // P_2(w | a) = (c(a w) + 2 · P_1(w)) / (3 + 2)
  near(prob(m, ['a'], 'b'), 47 / 90);   // (2 + 2 · 2.75/9) / 5
  near(prob(m, ['a'], 'c'), 5 / 18);    // (1 + 2 · 1.75/9) / 5
  near(prob(m, ['a'], 'a'), 1 / 6);     // (0 + 2 · 3.75/9) / 5
  near(prob(m, ['a'], 'never'), 1 / 30); // (0 + 2 · 0.75/9) / 5
  // P_2(w | b) = (c(b w) + 1 · P_1(w)) / (2 + 1)
  near(prob(m, ['b'], 'a'), 29 / 36);   // (2 + 3.75/9) / 3
  // c was never followed by anything, and 'zz' was never seen: both fall back to P_1
  near(prob(m, ['c'], 'b'), 2.75 / 9);
  near(prob(m, ['zz'], 'b'), 2.75 / 9);
  near(prob(m, [], 'b'), 2.75 / 9);     // no context: the first token of a sequence
  near(prob(m, ['x', 'y', 'a'], 'b'), 47 / 90); // only the last n-1 tokens of the context count
});

test('order 3: trigram probabilities and the cross-entropy of a sequence by hand', () => {
  const m = new NgramModel({ n: 3 }).add(ABABAC);
  near(prob(m, ['a', 'b'], 'a'), 101 / 108); // (2 + 1 · 29/36) / (2 + 1)
  near(prob(m, ['b', 'a'], 'c'), 7 / 18);    // (1 + 2 · 5/18) / (2 + 2)
  near(prob(m, ['b', 'a'], 'b'), 23 / 45);   // (1 + 2 · 47/90) / 4
  near(prob(m, ['b', 'a'], 'a'), 1 / 12);    // (0 + 2 · 1/6) / 4
  near(prob(m, ['b', 'a'], 'never'), 1 / 60); // (0 + 2 · 1/30) / 4
  near(prob(m, ['c', 'a'], 'b'), 47 / 90);   // the context c a was never seen: P_2(b | a)
  near(prob(m, ['a', 'c'], 'b'), 2.75 / 9);  // a c was seen but never followed, and neither was c: P_1(b)

  // a b a b a c under the model: P_1(a) · P_2(b|a) · P_3(a|a b) · P_3(b|b a) · P_3(a|a b) · P_3(c|b a)
  const steps = [5 / 12, 47 / 90, 101 / 108, 23 / 45, 101 / 108, 7 / 18].map((p) => -Math.log2(p));
  const total = steps.reduce((s, b) => s + b, 0);
  const all = m.crossEntropy(ABABAC);
  near(all.total, total); near(all.bits, total / 6); assert.equal(all.tokens, 6); assert.equal(all.unseen, 0);
  // a range keeps its real left context: tokens 2 and 3 are still predicted from a b and b a
  const mid = m.crossEntropy(ABABAC, { from: 2, to: 4 });
  near(mid.total, steps[2] + steps[3]); near(mid.bits, (steps[2] + steps[3]) / 2); assert.equal(mid.tokens, 2);
  const bits = m.tokenBits(ABABAC);
  assert.equal(bits.length, 6); steps.forEach((b, i) => near(bits[i], b));
  near(m.tokenBits(ABABAC, { from: 4 })[1], steps[5]);
});

test('every order gives a proper distribution: the known tokens plus one unseen class add up to 1', () => {
  const corpus = [seq('a b a b a c'), seq('c a b d d a'), seq('b'), seq('d c b a a b c')];
  for (const n of [1, 2, 3, 4, 5]) {
    const m = new NgramModel({ n }); corpus.forEach((s) => m.add(s));
    const contexts = [[], ['a'], ['a', 'b'], ['b', 'a'], ['d', 'd'], ['c'], ['zz'], ['a', 'zz'], ['zz', 'a'], ['c', 'a', 'b'], ['d', 'c', 'b', 'a']];
    for (const ctx of contexts) {
      const sum = ['a', 'b', 'c', 'd', 'some token never seen'].reduce((s, w) => s + prob(m, ctx, w), 0);
      near(sum, 1, 1e-12);
    }
    // and it still does while a file is held out
    m.heldOut(corpus[1], () => { for (const ctx of contexts) near(['a', 'b', 'c', 'd', 'unseen'].reduce((s, w) => s + prob(m, ctx, w), 0), 1, 1e-12); });
  }
});

test('n-grams never cross from one sequence into the next', () => {
  const m = new NgramModel({ n: 2 }).add(['a', 'b']).add(['b', 'a']);
  // N = 4, V = 2, P_1(b) = (2 + 2/3) / 6 = 4/9. After b only a was seen (once): P_2(b | b) = (0 + 1 · 4/9) / (1 + 1)
  near(prob(m, ['b'], 'b'), 2 / 9);
  assert.deepEqual(m.ngrams().map((e) => `${e.gram.join(' ')}=${e.count}`), ['a=2', 'a b=1', 'b=2', 'b a=1']);
  assert.equal(m.size, 4);
});

test('unseen tokens always get a probability, and an empty model claims nothing', () => {
  const m = new NgramModel({ n: 3 }).add(ABABAC);
  const all = m.crossEntropy(seq('x y z'));
  assert.ok(Number.isFinite(all.bits) && all.bits > 0);
  assert.equal(all.unseen, 3);
  near(all.bits, Math.log2(12)); // every token is unseen after an unseen context: P_1(unseen) = 0.75/9 = 1/12
  assert.equal(m.crossEntropy(seq('a x a')).unseen, 1);
  // an unseen token costs more than any seen one in the same context
  assert.ok(m.logProb(['b', 'a'], 'x') > m.logProb(['b', 'a'], 'a'));
  assert.ok(m.logProb(['b', 'a'], 'a') > m.logProb(['b', 'a'], 'b'));

  const empty = new NgramModel();
  assert.equal(empty.tokens, 0); assert.equal(empty.vocabulary, 0);
  assert.equal(empty.logProb(['a'], 'b'), 0); // V = 0: the uniform distribution over V + 1 = 1 class
  const none = m.crossEntropy(ABABAC, { from: 3, to: 3 });
  assert.equal(none.tokens, 0); assert.equal(none.total, 0); assert.ok(Number.isNaN(none.bits)); // nothing to average
  assert.equal(m.crossEntropy(ABABAC, { from: 4, to: 99 }).tokens, 2); // ranges are clamped to the sequence
  assert.equal(m.crossEntropy(ABABAC, { from: 5, to: 2 }).tokens, 0);
  assert.throws(() => new NgramModel({ n: 0 }), RangeError);
  assert.throws(() => new NgramModel({ n: 2.5 }), RangeError);
});

test('remove() exactly undoes add(): the model is identical afterwards', () => {
  const A = [seq('a b a b a c'), seq('c a b d d a')], B = seq('a b a x y a b a c c'), C = seq('x y x y d');
  for (const n of [1, 2, 3, 4]) {
    const m = new NgramModel({ n }); A.forEach((s) => m.add(s));
    const queries = [[[], 'a'], [['a'], 'b'], [['a', 'b'], 'a'], [['b', 'a'], 'x'], [['x', 'y'], 'a'], [['d', 'd'], 'a'], [['a', 'b', 'a'], 'c']];
    const snap = () => ({ grams: m.ngrams(), tokens: m.tokens, vocabulary: m.vocabulary, size: m.size, bits: queries.map(([c, w]) => m.logProb(c, w)), h: m.crossEntropy(B).total });
    const before = snap();
    m.add(B);
    assert.notDeepEqual(snap(), before);
    m.remove(B);
    assert.deepEqual(snap(), before); // counts, N, V and every probability, bit for bit
    // interleaved, in another order, and with a sequence added twice
    m.add(B).add(C).add(B).remove(C).remove(B).remove(B);
    assert.deepEqual(snap(), before);
    // removing everything leaves an empty model
    A.forEach((s) => m.remove(s));
    assert.deepEqual(m.ngrams(), []); assert.equal(m.tokens, 0); assert.equal(m.vocabulary, 0); assert.equal(m.size, 0);
    assert.equal(m.logProb(['a'], 'b'), 0);
  }
});

test('remove() of something that is not in the model throws and changes nothing', () => {
  const m = new NgramModel({ n: 3 }).add(ABABAC).add(seq('c a b'));
  const before = { grams: m.ngrams(), tokens: m.tokens, vocabulary: m.vocabulary, p: m.logProb(['a', 'b'], 'a') };
  const same = () => assert.deepEqual({ grams: m.ngrams(), tokens: m.tokens, vocabulary: m.vocabulary, p: m.logProb(['a', 'b'], 'a') }, before);
  assert.throws(() => m.remove(seq('a b zz')), RangeError); same();       // a token never seen
  assert.throws(() => m.remove(seq('a b a c a')), RangeError); same();    // known tokens, but c a after a b a c was never counted that way
  assert.throws(() => m.remove(seq('a b a b a b a b')), RangeError); same(); // more occurrences than the model holds
  assert.throws(() => m.heldOut(seq('c c c'), () => 1), RangeError); same();
  m.remove(seq('c a b'));
  assert.throws(() => m.remove(seq('c a b')), RangeError);                // already removed once
  assert.deepEqual(m.ngrams(), new NgramModel({ n: 3 }).add(ABABAC).ngrams());
});

test('only whole sequences that were added can be taken out, even when every one of their n-grams is there', () => {
  // The counts alone could not tell: a, b c and a b are all sub-sequences whose n-grams the model holds, but
  // taking them out would leave n-grams whose suffixes are gone, and scoring relies on that never happening.
  const m = new NgramModel({ n: 3 }).add(seq('a b c')).add(seq('c a b c a'));
  const before = { grams: m.ngrams(), tokens: m.tokens, vocabulary: m.vocabulary, bits: m.crossEntropy(seq('a b c a b')).total };
  const same = () => assert.deepEqual({ grams: m.ngrams(), tokens: m.tokens, vocabulary: m.vocabulary, bits: m.crossEntropy(seq('a b c a b')).total }, before);
  for (const part of ['a', 'b c', 'a b', 'c a', 'c a b', 'b c a', 'c a b c', 'a b c a', 'a b c a c']) {
    assert.throws(() => m.remove(seq(part)), RangeError); same();
    assert.throws(() => m.heldOut(seq(part), () => 0), RangeError); same();
  }
  assert.equal(m.heldOut(seq('a b c'), () => m.tokens), 5);
  assert.equal(m.heldOut(m.encode(seq('c a b c a')), () => m.tokens), 3); // encoded or not, it is the same sequence
  // a sequence added twice can be removed twice, and not a third time
  m.add(seq('a b c')).remove(seq('a b c')).remove(seq('a b c'));
  assert.throws(() => m.remove(seq('a b c')), RangeError);
  assert.deepEqual(m.ngrams(), new NgramModel({ n: 3 }).add(seq('c a b c a')).ngrams());
  // the second line of defence, should two sequences ever share a fingerprint: counts never go below zero,
  // and a take that fails half-way puts back what it took
  const again = m.ngrams();
  assert.throws(() => m._take(m.encode(seq('c a b c a c'))), RangeError);
  assert.throws(() => m._take(m.encode(seq('c a c'))), RangeError);
  assert.throws(() => m._take(m.encode(seq('c a b c a b'))), RangeError);
  assert.deepEqual(m.ngrams(), again); assert.equal(m.tokens, 5); assert.equal(m.vocabulary, 3);
});

test('agrees with the formula evaluated naively, through random adds and removes', () => {
  const rnd = lehmer(20261114), alphabet = seq('a b c d e f g h');
  const sentence = () => Array.from({ length: 1 + rnd(40) }, () => alphabet[rnd(1 + rnd(alphabet.length))]);
  for (const n of [1, 2, 3, 4]) {
    const m = new NgramModel({ n }), live = [];
    /** Bits of every token of s by the chain rule over the naive formula. */
    const chain = (P, s) => s.map((w, i) => -Math.log2(P(s.slice(Math.max(0, i - n + 1), i), w)));
    const check = (seqs) => {
      const P = oracle(seqs, n);
      for (let q = 0; q < 60; q++) {
        const ctx = Array.from({ length: rnd(n + 1) }, () => (rnd(12) ? alphabet[rnd(alphabet.length)] : 'zz')), w = rnd(10) ? alphabet[rnd(alphabet.length)] : 'zz';
        near(prob(m, ctx, w), P(ctx, w), 1e-12);
      }
      // a whole sequence, with unseen tokens in the middle: the context has to recover after each of them
      const s = Array.from({ length: 80 }, () => (rnd(5) ? alphabet[rnd(alphabet.length)] : 'zz')), want = chain(P, s);
      const got = m.tokenBits(s);
      want.forEach((b, i) => near(got[i], b, 1e-12));
      near(m.crossEntropy(s).total, want.reduce((x, y) => x + y, 0), 1e-12);
      near(m.crossEntropy(s, { from: 31, to: 57 }).total, want.slice(31, 57).reduce((x, y) => x + y, 0), 1e-12);
      assert.equal(m.crossEntropy(s).unseen, s.filter((w) => !seqs.some((q) => q.includes(w))).length);
    };
    for (let step = 0; step < 220; step++) {
      if (live.length && rnd(3) === 0) m.remove(live.splice(rnd(live.length), 1)[0]);
      else { const s = sentence(); live.push(s); m.add(s); }
      if (step % 20 === 19) check(live);
    }
    // the model built by adding and removing equals the model built from what is left
    const fresh = new NgramModel({ n }); live.forEach((s) => fresh.add(s));
    assert.deepEqual(m.ngrams(), fresh.ngrams());
    assert.equal(m.tokens, fresh.tokens); assert.equal(m.vocabulary, fresh.vocabulary); assert.equal(m.size, fresh.size);
    // leave one out: holding a sequence out equals a model that never had it
    for (let i = 0; i < live.length; i += 7) {
      const rest = live.filter((_, j) => j !== i), P = oracle(rest, n);
      m.heldOut(live[i], () => {
        for (let j = 0; j < live[i].length; j++) near(prob(m, live[i].slice(0, j), live[i][j]), P(live[i].slice(Math.max(0, j - n + 1), j), live[i][j]), 1e-12);
        const got = m.tokenBits(live[i]);
        chain(P, live[i]).forEach((b, j) => near(got[j], b, 1e-12));
      });
    }
    assert.deepEqual(m.ngrams(), fresh.ngrams());
  }
});

test('heldOut() is remove, score, add: same numbers, model restored, read-only inside', () => {
  const files = [seq('if ( a ) { return b ; }'), seq('if ( b ) { return a ; } else { return c ; }'), seq('while ( a ) { b = c ; }'), seq('if ( a ) { return b ; }')];
  const m = new NgramModel({ n: 3 }); files.forEach((f) => m.add(f));
  const before = m.ngrams();
  for (const f of files) {
    const held = m.heldOut(f, (model) => { assert.equal(model, m); return m.crossEntropy(f); });
    m.remove(f); const removed = m.crossEntropy(f); m.add(f);
    assert.deepEqual(held, removed);
    assert.ok(held.bits > m.crossEntropy(f).bits); // a model that has seen the sequence understates its entropy
  }
  assert.deepEqual(m.ngrams(), before);
  // encoded input gives the same numbers as lexemes
  const ids = m.encode(files[1]);
  assert.ok(ids instanceof Int32Array);
  assert.deepEqual(m.crossEntropy(ids, { from: 3, to: 9 }), m.crossEntropy(files[1], { from: 3, to: 9 }));
  assert.deepEqual(m.heldOut(ids, () => m.crossEntropy(ids)), m.heldOut(files[1], () => m.crossEntropy(files[1])));
  assert.deepEqual([...m.encode(seq('if zz ('))].map((x) => x >= 0), [true, false, true]);
  // the model cannot be changed while a file is held out, and it is restored even when the callback throws
  assert.throws(() => m.heldOut(files[0], () => m.add(seq('a'))), /cannot be changed/);
  assert.throws(() => m.heldOut(files[0], () => m.remove(files[1])), /cannot be changed/);
  assert.throws(() => m.heldOut(files[0], () => m.heldOut(files[1], () => 0)), /cannot be changed/);
  assert.throws(() => m.heldOut(files[0], () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(m.ngrams(), before);
  m.add(seq('a')); m.remove(seq('a')); // and it is writable again
  assert.deepEqual(m.ngrams(), before);
});

test('a sentence of the corpus is less surprising than the same tokens shuffled', () => {
  const src = [
    'function total(items) { let sum = 0; for (const item of items) { sum += item.price * item.qty; } return sum; }',
    'function count(items) { let n = 0; for (const item of items) { n += item.qty; } return n; }',
    'function names(items) { const out = []; for (const item of items) { out.push(item.name); } return out; }',
    'function cheapest(items) { let best = null; for (const item of items) { if (best === null || item.price < best.price) { best = item; } } return best; }',
    'function weight(items) { let sum = 0; for (const item of items) { sum += item.weight * item.qty; } return sum; }',
  ].map((s) => lexemes(tokenize(s, 'js')));
  const m = new NgramModel({ n: 3 }); src.forEach((s) => m.add(s));
  const rnd = lehmer(7);
  const shuffled = (s) => { const a = s.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  for (const s of src) {
    const mixed = shuffled(s);
    assert.notDeepEqual(mixed, s);
    assert.ok(m.crossEntropy(s).bits < m.crossEntropy(mixed).bits);
    // and still when the model has never seen the sentence: order is what the model has learnt, not the sentence
    assert.ok(m.heldOut(s, () => m.crossEntropy(s).bits < m.crossEntropy(mixed).bits));
  }
  // The first and the fifth function are the same code but for one name. Held out, each still has its twin in
  // the model, so they are the least surprising two, and the only tokens they bring are their own names.
  const held = src.map((s) => m.heldOut(s, () => m.crossEntropy(s)));
  assert.equal(held[0].unseen, 1); // total
  assert.equal(held[4].unseen, 2); // weight, twice
  for (const i of [1, 2, 3]) assert.ok(held[i].bits > held[0].bits && held[i].bits > held[4].bits);
});

test('baseline: leave-one-file-out statistics on a case worked out by hand', () => {
  // Order 1. Holding out f1 leaves b b b b a a b b: N = 8, V = 2, c(a) = 2, so P(a) = (2 + 2/3) / 10 = 4/15.
  // Holding out f2 is the mirror image: P(b) = 4/15. Holding out f3 leaves a a a a b b b b: P(a) = P(b) = 7/15.
  const f1 = seq('a a a a'), f2 = seq('b b b b'), f3 = seq('a a b b');
  const m = new NgramModel({ n: 1 }); [f1, f2, f3].forEach((f) => m.add(f));
  const files = [{ lex: f1, ranges: [[0, 4]] }, { lex: f2, ranges: [[0, 4]] }, { lex: f3, ranges: [[0, 2], [2, 4], [3, 3]] }];
  const before = m.ngrams();
  const b = baselineOf(m, files);
  const x = Math.log2(15 / 4), y = Math.log2(15 / 7);
  assert.equal(b.n, 4); assert.equal(b.population, 4); // the empty range [3, 3) is not a function
  near(b.mean, (x + y) / 2);
  near(b.sd, (x - y) / Math.sqrt(3)); // deviations ±(x-y)/2 four times: sum of squares (x-y)², divided by n - 1 = 3
  near(b.p50, (x + y) / 2); near(b.p90, x); near(b.p99, x); near(b.min, y); near(b.max, x);
  assert.equal(b.sorted.length, 4); near(b.sorted[0], y); near(b.sorted[3], x);
  assert.deepEqual(m.ngrams(), before); // the model is as it was
  // scoring f1 under the model that has seen it would have said (6 + 2/3) / 14 = 10/21: fewer bits
  near(m.crossEntropy(f1).bits, Math.log2(21 / 10));
  assert.ok(m.crossEntropy(f1).bits < x);
  assert.deepEqual(baselineOf(m, files.map((f) => ({ lex: m.encode(f.lex), ranges: f.ranges }))), b); // encoded files: same baseline
});

test('baseline: mean, sample sd and type-7 quantiles of five different values', () => {
  // Order 1. A background file a×8 b×4 c×2 d×1 and five one-token files a, b, c, d, e (N = 20, V = 5).
  // Holding out the file [w] for w in a..d leaves N = 19, V = 5 and c(w) = 8, 4, 2, 1:  P = (c + 5/6) / 24.
  // Holding out [e] leaves N = 19, V = 4 and e unseen:                                 P = (4/5) / 23.
  const bg = seq('a a a a a a a a b b b b c c d'), ones = ['a', 'b', 'c', 'd', 'e'].map((w) => [w]);
  const m = new NgramModel({ n: 1 }); m.add(bg); ones.forEach((f) => m.add(f));
  assert.equal(m.tokens, 20); assert.equal(m.vocabulary, 5);
  const b = baselineOf(m, [{ lex: bg, ranges: [] }, ...ones.map((lex) => ({ lex, ranges: [[0, 1]] }))]);
  const v = [(8 + 5 / 6) / 24, (4 + 5 / 6) / 24, (2 + 5 / 6) / 24, (1 + 5 / 6) / 24, (4 / 5) / 23].map((p) => -Math.log2(p)); // ascending
  assert.equal(b.n, 5);
  b.sorted.forEach((s, i) => near(s, v[i]));
  const mean = (v[0] + v[1] + v[2] + v[3] + v[4]) / 5;
  near(b.mean, mean);
  near(b.sd, Math.sqrt(v.reduce((s, z) => s + (z - mean) ** 2, 0) / 4));
  near(b.p50, v[2]);                         // h = (5 - 1) · 0.5 = 2
  near(b.p90, v[3] + 0.6 * (v[4] - v[3]));   // h = 3.6
  near(b.p99, v[3] + 0.96 * (v[4] - v[3]));  // h = 3.96
  near(b.min, v[0]); near(b.max, v[4]);
});

test('baseline: deterministic sample above max, files outside the model, nothing to score', () => {
  const rnd = lehmer(99), words = seq('a b c d e f');
  const files = Array.from({ length: 12 }, () => { const lex = Array.from({ length: 30 }, () => words[rnd(words.length)]); return { lex, ranges: [[0, 6], [6, 14], [14, 30]] }; });
  const m = new NgramModel({ n: 3 }); files.forEach((f) => m.add(f.lex));
  const flat = files.flatMap((f) => f.ranges.map((r) => [f, r])); // 36 functions
  const expected = (max) => Array.from({ length: max }, (_, j) => flat[Math.floor(j * 36 / max)]).map(([f, [a, b]]) => m.heldOut(f.lex, () => m.crossEntropy(f.lex, { from: a, to: b }).bits)).sort((p, q) => p - q);
  for (const max of [36, 35, 10, 7, 1]) {
    const b = baselineOf(m, files, { max });
    assert.equal(b.n, max); assert.equal(b.population, 36);
    assert.deepEqual(b.sorted, expected(max));
    assert.deepEqual(baselineOf(m, files, { max }), b); // same input, same baseline
  }
  assert.equal(baselineOf(m, files).n, 36); // under the default cap of 500: every function
  assert.equal(baselineOf(m, files, { max: 1 }).sd, 0);

  assert.throws(() => baselineOf(m, [{ lex: seq('a b zz'), ranges: [[0, 3]] }]), RangeError); // not in the model: no silent in-sample score
  const none = baselineOf(m, [{ lex: files[0].lex, ranges: [] }]);
  const { fragments, ...rest } = none;
  assert.deepEqual(rest, { mean: null, sd: null, n: 0, p50: null, p90: null, p99: null, min: null, max: null, population: 0, sorted: [] });
  assert.deepEqual(fragments, [6, 12, 24, 48, 96, 192].map((tokens) => ({ tokens, n: 0, mean: null, sd: null, sorted: [] })));
  assert.deepEqual(surprise(3, none, { tokens: 20 }), { z: null, percentile: null, window: null, n: 0 });
  // a repository of one file: holding it out leaves nothing to learn from, so nothing is scored
  const lone = new NgramModel().add(seq('a b c'));
  assert.equal(baselineOf(lone, [{ lex: seq('a b c'), ranges: [[0, 3]] }]).n, 0);
  assert.deepEqual(surprise(3, none), { z: null, percentile: null });
});

test('surprise: z against mean and sd, percentile as the share strictly below', () => {
  const baseline = { mean: 4, sd: 2, n: 5, p50: 4, p90: 6.2, p99: 6.92, min: 1, max: 7, sorted: [1, 3, 4, 5, 7] };
  assert.deepEqual(surprise(8, baseline), { z: 2, percentile: 1 });
  assert.deepEqual(surprise(4, baseline), { z: 0, percentile: 0.4 });    // 1 and 3 are below 4; 4 itself is not
  assert.deepEqual(surprise(4.5, baseline), { z: 0.25, percentile: 0.6 });
  assert.deepEqual(surprise(1, baseline), { z: -1.5, percentile: 0 });
  assert.deepEqual(surprise(0, baseline), { z: -2, percentile: 0 });
  assert.deepEqual(surprise(7, baseline), { z: 1.5, percentile: 0.8 });
  // ties: nothing equal to the value counts as below it
  assert.equal(surprise(2, { mean: 2, sd: 1, n: 4, sorted: [2, 2, 2, 3] }).percentile, 0);
  assert.equal(surprise(2.5, { mean: 2, sd: 1, n: 4, sorted: [2, 2, 2, 3] }).percentile, 0.75);
  // undefined cases say so instead of inventing a number
  assert.deepEqual(surprise(NaN, baseline), { z: null, percentile: null });
  assert.deepEqual(surprise(5, null), { z: null, percentile: null });
  assert.deepEqual(surprise(5, { mean: 5, sd: 0, n: 1, sorted: [5] }), { z: null, percentile: 0 });
  assert.deepEqual(surprise(6, { mean: 5, sd: 0, n: 3, sorted: [5, 5, 5] }), { z: null, percentile: 1 });
  // without the sorted values: interpolation between the stored quantiles, flagged as approximate
  const { sorted, ...thin } = baseline;
  assert.deepEqual(surprise(4, thin), { z: 0, percentile: 0.5, approx: true });
  assert.deepEqual(surprise(2.5, thin), { z: -0.75, percentile: 0.25, approx: true }); // halfway between min (0) and p50 (0.5)
  assert.deepEqual(surprise(0.5, thin), { z: -1.75, percentile: 0, approx: true });
  assert.deepEqual(surprise(9, thin), { z: 2.5, percentile: 1, approx: true });
  near(surprise(5.1, thin).percentile, 0.5 + 0.4 * (1.1 / 2.2));
  assert.equal(sorted.length, 5);
});

test('surprise on a real baseline: a held-out function ranks where its entropy puts it', () => {
  const fns = ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => lexemes(tokenize(`function get_${v}(o) { if (o == null) { return null; } return o.${v}; }`, 'js')));
  const odd = lexemes(tokenize('function tangle(o) { return o >>> 3 ^ ~o % 7 | o << 2 & 5; }', 'js'));
  const m = new NgramModel({ n: 3 }); [...fns, odd].forEach((f) => m.add(f));
  const b = baselineOf(m, [...fns, odd].map((lex) => ({ lex, ranges: [[0, lex.length]] })));
  assert.equal(b.n, 7);
  const h = m.heldOut(odd, () => m.crossEntropy(odd).bits);
  near(b.max, h); // the odd one out is the most surprising function of the project
  const s = surprise(h, b);
  near(s.percentile, 6 / 7); assert.ok(s.z > 2);
  near(s.z, (h - b.mean) / b.sd);
  assert.ok(surprise(m.heldOut(fns[0], () => m.crossEntropy(fns[0]).bits), b).z < 0);
});

test('hotspots point at the unusual lines of a function', () => {
  const m = new NgramModel({ n: 3 });
  for (const v of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) m.add(lexemes(tokenize(`function get_${v}(o) {\n  if (o == null) {\n    return null;\n  }\n  return o.${v};\n}`, 'js')));
  const text = 'function get_z(o) {\n  if (o == null) {\n    return null;\n  }\n  o = o >>> 3 ^ ~o % 7 | o << 2;\n  return o.z;\n}';
  const tokens = tokenize(text, 'js'), lex = lexemes(tokens);
  const hs = hotspots(m, lex, tokens, { top: 3, window: 6 });
  assert.equal(hs[0].line, 5); assert.equal(hs[0].endLine, 5);
  assert.equal(hs[0].peak.line, 5);
  assert.equal(hs[0].to - hs[0].from, 6);
  // the window's bits are the mean of its tokens' bits, and the peak is its most surprising token
  const bits = m.tokenBits(lex);
  near(hs[0].bits, [...bits.slice(hs[0].from, hs[0].to)].reduce((s, b) => s + b, 0) / 6);
  near(hs[0].peak.bits, Math.max(...bits.slice(hs[0].from, hs[0].to)));
  assert.equal(lex[hs[0].from + [...bits.slice(hs[0].from, hs[0].to)].indexOf(hs[0].peak.bits)], hs[0].peak.lexeme);
  // most surprising first, and no two windows share a token
  assert.ok(hs.length <= 3 && hs.length >= 2);
  for (let i = 1; i < hs.length; i++) { assert.ok(hs[i].bits <= hs[i - 1].bits); for (let j = 0; j < i; j++) assert.ok(hs[i].from >= hs[j].to || hs[i].to <= hs[j].from); }
  assert.deepEqual(hotspots(m, lex, tokens, { top: 3, window: 6 }), hs); // deterministic

  // tokens lexed with line breaks give the same answer: 'nl' tokens are not lexemes
  const withNl = tokenize(text, 'js', { nl: true });
  assert.ok(withNl.length > tokens.length);
  assert.deepEqual(hotspots(m, lexemes(withNl), withNl, { top: 3, window: 6 }), hs);
  // a range inside a longer sequence: indices stay those of the sequence, and nothing outside is reported
  const part = hotspots(m, lex, tokens, { top: 2, window: 4, from: 12, to: 30 });
  assert.ok(part.length && part.every((h) => h.from >= 12 && h.to <= 30 && h.to - h.from === 4));
  // a range shorter than the window is one window over all of it
  const short = hotspots(m, lex, tokens, { window: 50, from: 3, to: 7 });
  assert.equal(short.length, 1); assert.equal(short[0].from, 3); assert.equal(short[0].to, 7);
  near(short[0].bits, m.crossEntropy(lex, { from: 3, to: 7 }).bits);
  assert.deepEqual(hotspots(m, lex, tokens, { from: 5, to: 5 }), []);
  assert.deepEqual(hotspots(m, lex, tokens, { top: 0 }), []);
  assert.throws(() => hotspots(m, lex, tokens.slice(1)), RangeError); // lexemes and tokens must be the same sequence
});

test('the pair index behaves like a Map, also when probe runs wrap around the end of the table', () => {
  const rnd = lehmer(31337);
  for (const limit of [4, 40]) { // 4 entries keep the table at its 8 slots, where runs wrap all the time; 40 make it grow
    const ix = new PairIndex(8), ref = new Map(), keys = [];
    for (let p = 1; p <= 7; p++) for (let x = -1; x <= 5; x++) keys.push([p, x]);
    for (let step = 0; step < 20000; step++) {
      const [p, x] = keys[rnd(keys.length)], k = `${p},${x}`;
      if (ref.has(k)) { assert.equal(ix.delete(p, x), true); ref.delete(k); }
      else if (ref.size < limit) { ix.set(p, x, step + 1); ref.set(k, step + 1); }
      else assert.equal(ix.delete(p, x), false);
      assert.equal(ix.size, ref.size);
      for (const [q, y] of keys) assert.equal(ix.get(q, y), ref.get(`${q},${y}`) ?? -1);
    }
    assert.equal(ix.cap, limit === 4 ? 8 : 128);
  }
});

test('large inputs: tables grow, nodes are reused, and nothing drifts', () => {
  const rnd = lehmer(5), words = Array.from({ length: 2500 }, (_, i) => `w${i}`);
  const files = Array.from({ length: 24 }, () => Array.from({ length: 800 }, () => words[rnd(1 + rnd(words.length))]));
  const m = new NgramModel({ n: 3 }); files.forEach((f) => m.add(f));
  assert.equal(m.tokens, 19200);
  const flat = (model) => model.ngrams().map((e) => `${e.gram.join(' ')}=${e.count}`).join('\n');
  const size = m.size, grams = flat(m), h = files.map((f) => m.crossEntropy(f).total);
  assert.ok(size > 20000 && m.vocabulary > 1024); // well past the first size of every internal table
  for (let round = 0; round < 3; round++) { for (let i = round; i < files.length; i += 2) m.remove(files[i]); for (let i = round; i < files.length; i += 2) m.add(files[i]); }
  assert.equal(m.size, size); assert.equal(m.tokens, 19200);
  assert.deepEqual(files.map((f) => m.crossEntropy(f).total), h);
  assert.equal(flat(m), grams);
  files.forEach((f) => m.remove(f));
  assert.equal(m.size, 0); assert.equal(m.tokens, 0); assert.equal(m.vocabulary, 0);
});

// ---------------------------------------------------------------------------------------------------------
// Adversarial review: counterexamples and independent re-derivations.
// ---------------------------------------------------------------------------------------------------------

// A 20-token corpus in two files, every count taken by hand:
//   f1 = x = a + b ; y = a + c ; x = b      f2 = y = a + b
//   N = 20, V = 8:  '=' 4,  a 3,  + 3,  b 3,  x 2,  ; 2,  y 2,  c 1                 P_0 = 1/9
//   after '=': a a b a (c = 4, T = 2)      after a: + + + (3, 1)       after +: b c b (3, 2)
//   after b: ';' once, twice last in file (1, 1)      after ';': y x (2, 2)      after y: = = (2, 1)
//   after '= a': + + + (3, 1)     after 'a +': b c b (3, 2)     after '+ b': ';' (1, 1)     after 'b ;': y (1, 1)
//   after 'y =': a a (2, 1)
const F1 = seq('x = a + b ; y = a + c ; x = b'), F2 = seq('y = a + b');

test('review: a 20-token corpus re-derived by hand, as exact fractions', () => {
  const m = new NgramModel({ n: 3 }).add(F1).add(F2);
  assert.equal(m.tokens, 20); assert.equal(m.vocabulary, 8);
  const P = (c, w, num, den) => near(prob(m, c, w), num / den, 1e-12);
  // order 1: (c(w) + 8/9) / 28
  P([], 'a', 5, 36); P([], '=', 11, 63); P([], 'c', 17, 252); P([], 'y', 13, 126); P([], 'never', 2, 63);
  // order 2
  P(['='], 'a', 59, 108);    // (3 + 2 · 5/36) / 6
  P(['='], 'b', 23, 108);    // (1 + 2 · 5/36) / 6
  P(['a'], '+', 113, 144);   // (3 + 1 · 5/36) / 4
  P(['+'], 'b', 41, 90);     // (2 + 2 · 5/36) / 5
  P(['+'], 'c', 143, 630);   // (1 + 2 · 17/252) / 5
  P(['+'], 'never', 4, 315); // (0 + 2 · 2/63) / 5
  P(['b'], ';', 139, 252);   // (1 + 1 · 13/126) / 2: b ends both files, so it was followed only once
  P(['y'], '=', 137, 189);   // (2 + 11/63) / 3
  // order 3
  P(['=', 'a'], '+', 545, 576);     // (3 + 113/144) / 4
  P(['a', '+'], 'b', 131, 225);     // (2 + 2 · 41/90) / 5
  P(['a', '+'], 'c', 458, 1575);    // (1 + 2 · 143/630) / 5
  P(['a', '+'], 'never', 8, 1575);  // (0 + 2 · 4/315) / 5
  P(['+', 'b'], ';', 391, 504);     // (1 + 139/252) / 2
  P(['b', ';'], 'x', 19, 126);      // (0 + 1 · P_2(x | ;)) / 2, P_2(x | ;) = (1 + 2 · 13/126) / 4 = 19/63
  P(['+', 'b'], 'never', 1, 126);   // (0 + (0 + 2/63) / 2) / 2
  P(['y', '='], 'a', 275, 324);     // (2 + 59/108) / 3
  // contexts never seen fall back to the next shorter one
  P(['q', '+'], 'b', 41, 90); P(['c', 'a'], '+', 113, 144); P(['q', 'q'], 'a', 5, 36);
  // P_3(· | a +) written out in full: b 917, c 458, unseen 8, and the six other tokens 4/25 · P_1 = 192, over 1575
  const others = ['x', '=', 'a', '+', ';', 'y'].reduce((t, w) => t + prob(m, ['a', '+'], w), 0);
  near(others, 192 / 1575, 1e-12);
  near(prob(m, ['a', '+'], 'b') + prob(m, ['a', '+'], 'c') + prob(m, ['a', '+'], 'never') + others, 1, 1e-12);

  // f2 scored by the model that holds it, and by the model that does not (f1 alone: N = 15, V = 8)
  const seenP = [13 / 126, 137 / 189, 275 / 324, 545 / 576, 131 / 225];
  const heldP = [17 / 207, 121 / 207, 1501 / 2070, 1682 / 1863, 673 / 1656];
  const got = m.tokenBits(F2); seenP.forEach((p, i) => near(got[i], -Math.log2(p), 1e-12));
  m.heldOut(F2, () => {
    assert.equal(m.tokens, 15); assert.equal(m.vocabulary, 8);
    const out = m.tokenBits(F2); heldP.forEach((p, i) => near(out[i], -Math.log2(p), 1e-12));
    near(m.crossEntropy(F2).total, -Math.log2(heldP.reduce((x, y) => x * y, 1)), 1e-12);
  });
  seenP.forEach((p, i) => assert.ok(p > heldP[i])); // every token of f2 is likelier to the model that has seen f2
  const alone = new NgramModel({ n: 3 }).add(F1);
  assert.deepEqual(m.heldOut(F2, () => m.crossEntropy(F2)), alone.crossEntropy(F2)); // held out = never added, bit for bit
});

test('review: over every context of the 20-token corpus the vocabulary and the unseen class sum to 1', () => {
  const words = [...new Set([...F1, ...F2])], any = [...words, 'never seen'];
  for (const n of [1, 2, 3, 4]) {
    const m = new NgramModel({ n }).add(F1).add(F2);
    const contexts = [[]]; // every context of up to two tokens over the vocabulary and an unseen token, and some longer
    for (const a of any) { contexts.push([a]); for (const b of any) contexts.push([a, b]); }
    contexts.push(['=', 'a', '+'], ['x', '=', 'a'], ['never seen', 'a', '+'], [';', 'y', '=', 'a']);
    const check = (known) => {
      for (const c of contexts) {
        let sum = 0; for (const w of known) { const p = prob(m, c, w); assert.ok(p > 0 && p < 1); sum += p; }
        near(sum + prob(m, c, 'never seen'), 1, 1e-12);
      }
    };
    check(words);
    m.heldOut(F1, () => check([...new Set(F2)])); // with f1 out, c, x and ';' are unseen: they share the one unseen class
    m.heldOut(F2, () => check(words));
    check(words);
  }
});

test('review: adding and removing a large file with new vocabulary leaves every score as it was', () => {
  const rnd = lehmer(424242), words = Array.from({ length: 400 }, (_, i) => `w${i}`);
  const files = Array.from({ length: 30 }, () => Array.from({ length: 300 + rnd(300) }, () => words[rnd(1 + rnd(words.length))]));
  const m = new NgramModel({ n: 3 }); files.forEach((f) => m.add(f));
  const ids = files.map((f) => m.encode(f));
  const snap = () => ({ bits: files.map((f) => Array.from(m.tokenBits(f))), held: files.map((f, i) => m.heldOut(ids[i], () => m.crossEntropy(ids[i]).total)), size: m.size, tokens: m.tokens, vocabulary: m.vocabulary, grams: m.ngrams().length });
  const before = snap();
  // 20,000 tokens, a third of them new to the model, the rest in the model's own order so that n-grams are shared
  const big = Array.from({ length: 20000 }, (_, i) => (i % 3 === 0 ? `new${rnd(900)}` : files[i % 30][i % 300]));
  m.add(big);
  const during = snap();
  assert.ok(during.tokens === before.tokens + 20000 && during.vocabulary > before.vocabulary && during.size > before.size);
  assert.ok(during.bits.every((b, i) => b.some((x, j) => x !== before.bits[i][j]))); // it did change every file's score
  m.remove(big);
  assert.deepEqual(snap(), before); // every token of every file, in and held out: bit for bit
  // the old encodings are still valid, and the removed vocabulary is unseen again
  assert.deepEqual(files.map((f, i) => m.crossEntropy(ids[i]).total), files.map((f) => m.crossEntropy(f).total));
  assert.equal(m.crossEntropy(['new1', 'new2', 'new3']).unseen, 3);
  assert.throws(() => m.remove(big), RangeError);
  // and the other way round: the largest real file out and back in (its nodes are recycled)
  const largest = files.reduce((a, f) => (f.length > a.length ? f : a));
  m.remove(largest);
  assert.notDeepEqual(files.map((f) => Array.from(m.tokenBits(f))), before.bits);
  assert.throws(() => m.heldOut(largest, () => 0), RangeError); // it is not in the model now, so it cannot be held out
  m.add(largest);
  assert.deepEqual(snap(), before);
});

test('review: the baseline is not contaminated: each value is the score under a model that never saw the file', () => {
  const rnd = lehmer(2026), words = seq('if ( ) { } return x y z = ; + call . name');
  const files = Array.from({ length: 9 }, () => { const lex = Array.from({ length: 60 }, () => words[rnd(1 + rnd(words.length))]); return { lex, ranges: [[0, 20], [20, 45], [45, 60]] }; });
  for (const n of [1, 2, 3]) {
    const m = new NgramModel({ n }); files.forEach((f) => m.add(f.lex));
    const b = baselineOf(m, files);
    assert.equal(b.n, 27);
    const honest = [], contaminated = [];
    files.forEach((f, i) => {
      const without = new NgramModel({ n }); files.forEach((g, j) => { if (j !== i) without.add(g.lex); }); // built from scratch, no hold-out involved
      for (const [a, z] of f.ranges) { honest.push(without.crossEntropy(f.lex, { from: a, to: z }).bits); contaminated.push(m.crossEntropy(f.lex, { from: a, to: z }).bits); }
    });
    assert.deepEqual(b.sorted, honest.slice().sort((x, y) => x - y));
    honest.forEach((h, i) => assert.ok(contaminated[i] < h)); // a model that holds the function always scores it lower here
    const mean = honest.reduce((x, y) => x + y, 0) / 27;
    near(b.mean, mean); near(b.sd, Math.sqrt(honest.reduce((x, y) => x + (y - mean) ** 2, 0) / 26));
    // read against the honest baseline, the contaminated scores of the project's own functions look unusually natural
    const zc = contaminated.map((x) => surprise(x, b).z), zh = honest.map((x) => surprise(x, b).z);
    near(zh.reduce((x, y) => x + y, 0), 0, 1e-9);
    assert.ok(zc.reduce((x, y) => x + y, 0) / 27 < [0, -0.1, -1, -3][n]); // -0.21, -1.21 and -3.43 sd on average: the longer the n-gram, the more it memorises
  }
});

test('review: a baseline of identical values has sd exactly 0, not a rounding residue', () => {
  // Counterexample: three identical files. Each function scores 1.4305448882734830 bits, but (v + v + v) / 3 is
  // 1.4305448882734833, which used to leave sd = 2.7e-16: z = -0.82 for the very same value and z = 3.7e13
  // for a value 0.01 bits higher.
  const same = seq('x y z x q y y'), other = seq('p x r y q q z x');
  const m = new NgramModel({ n: 2 }); [same, same.slice(), same.slice(), other].forEach((f) => m.add(f));
  const b = baselineOf(m, [same, same.slice(), same.slice()].map((lex) => ({ lex, ranges: [[0, lex.length]] })));
  assert.equal(b.n, 3); assert.equal(b.sorted[0], b.sorted[2]);
  assert.equal(b.sd, 0);
  assert.deepEqual(surprise(b.sorted[0], b), { z: null, percentile: 0 });
  assert.deepEqual(surprise(b.sorted[0] + 0.01, b), { z: null, percentile: 1 });
  // values that really differ, however little, keep their spread
  const m2 = new NgramModel({ n: 1 }); const g = [seq('a a a b'), seq('a a b b'), seq('a b b b')]; g.forEach((f) => m2.add(f));
  assert.ok(baselineOf(m2, g.map((lex) => ({ lex, ranges: [[0, 4]] }))).sd > 0.01);
});

test('review: fragment statistics of the baseline, worked out by hand', () => {
  // Order 1, so a token costs the same wherever it stands. Three files of 12 tokens: a 15 times, b 21 times.
  //   F1 = a⁶ b⁶ held out leaves a 9, b 15 (N = 24, V = 2):  P(a) = (9 + 2/3) / 26 = 29/78,  P(b) = 47/78
  //   F2 = a⁹ b³ held out leaves a 6, b 18:                  P(a) = 10/39,                   P(b) = 28/39
  //   F3 = b¹²   held out leaves a 15, b 9:                  P(b) = 29/78
  const f1 = seq('a a a a a a b b b b b b'), f2 = seq('a a a a a a a a a b b b'), f3 = seq('b b b b b b b b b b b b');
  const m = new NgramModel({ n: 1 }); [f1, f2, f3].forEach((f) => m.add(f));
  const a1 = Math.log2(78 / 29), b1 = Math.log2(78 / 47), a2 = Math.log2(39 / 10), b2 = Math.log2(39 / 28), b3 = Math.log2(78 / 29);
  // F3's function is its first 11 tokens: one window of 6, the other 5 tokens are dropped, and no window of 12
  const b = baselineOf(m, [{ lex: f1, ranges: [[0, 12]] }, { lex: f2, ranges: [[0, 12]] }, { lex: f3, ranges: [[0, 11]] }]);
  assert.deepEqual(b.fragments.map((f) => [f.tokens, f.n]), [[6, 5], [12, 2], [24, 0], [48, 0], [96, 0], [192, 0]]);
  const six = [a1, b1, a2, (a2 + b2) / 2, b3].sort((x, y) => x - y), twelve = [(a1 + b1) / 2, (9 * a2 + 3 * b2) / 12].sort((x, y) => x - y);
  b.fragments[0].sorted.forEach((v, i) => near(v, six[i]));
  b.fragments[1].sorted.forEach((v, i) => near(v, twelve[i]));
  const mean6 = six.reduce((x, y) => x + y, 0) / 5;
  near(b.fragments[0].mean, mean6); near(b.fragments[0].sd, Math.sqrt(six.reduce((x, y) => x + (y - mean6) ** 2, 0) / 4));
  near(b.fragments[1].mean, (twelve[0] + twelve[1]) / 2); near(b.fragments[1].sd, (twelve[1] - twelve[0]) / Math.SQRT2);
  assert.deepEqual(b.fragments[2], { tokens: 24, n: 0, mean: null, sd: null, sorted: [] });
  // the function-level numbers are untouched by the fragments
  assert.equal(b.n, 3); [(a1 + b1) / 2, (9 * a2 + 3 * b2) / 12, b3].sort((x, y) => x - y).forEach((v, i) => near(b.sorted[i], v));
  // too few fragments of any length to judge a fragment: say so
  assert.deepEqual(surprise(2, b, { tokens: 12 }), { z: null, percentile: null, window: null, n: 0 });
});

test('review: surprise with { tokens } compares a fragment with fragments of the longest usable length', () => {
  const ramp = (n, lo, hi) => Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
  const frag = (tokens, n, mean, sd, sorted) => ({ tokens, n, mean, sd, sorted });
  const baseline = { mean: 4, sd: 2, n: 50, sorted: ramp(50, 1, 7), fragments: [frag(6, 40, 4, 3, ramp(40, 0, 8)), frag(12, 30, 4, 2.5, ramp(30, 0.5, 7.5)), frag(24, 29, 4, 2.2, ramp(29, 1, 7)), frag(48, 0, null, null, [])] };
  assert.deepEqual(surprise(10, baseline), { z: 3, percentile: 1 });                                        // a whole function: against functions
  assert.deepEqual(surprise(10, baseline, { tokens: 6 }), { z: 2, percentile: 1, window: 6, n: 40 });       // the same bits over 6 tokens: only 2 sd
  assert.deepEqual(surprise(10, baseline, { tokens: 11 }), { z: 2, percentile: 1, window: 6, n: 40 });      // 11 tokens: still the 6-token fragments
  assert.deepEqual(surprise(9, baseline, { tokens: 12 }), { z: 2, percentile: 1, window: 12, n: 30 });
  assert.deepEqual(surprise(9, baseline, { tokens: 500 }), { z: 2, percentile: 1, window: 12, n: 30 });     // 29 fragments of 24 are not enough: fall back to 12
  assert.deepEqual(surprise(4, baseline, { tokens: 6 }), { z: 0, percentile: 0.5, window: 6, n: 40 });      // 20 of the 40 values lie below 4
  assert.deepEqual(surprise(1, baseline, { tokens: 13 }), { z: -1.2, percentile: 3 / 30, window: 12, n: 30 });
  for (const tokens of [5, 0, -3, NaN, null]) assert.deepEqual(surprise(9, baseline, { tokens }), { z: null, percentile: null, window: null, n: 0 });
  assert.deepEqual(surprise(NaN, baseline, { tokens: 12 }), { z: null, percentile: null, window: null, n: 0 });
  assert.deepEqual(surprise(9, { mean: 4, sd: 2, n: 50 }, { tokens: 12 }), { z: null, percentile: null, window: null, n: 0 }); // a baseline without fragments
  assert.deepEqual(surprise(9, null, { tokens: 12 }), { z: null, percentile: null, window: null, n: 0 });
  for (const none of [{}, null, undefined, { tokens: undefined }]) assert.deepEqual(surprise(9, baseline, none), { z: 2.5, percentile: 1 });                                   // no `tokens`: the function reference
  assert.deepEqual(surprise(5, { fragments: [frag(6, 30, 5, 0, Array(30).fill(5))] }, { tokens: 6 }), { z: null, percentile: 0, window: 6, n: 30 }); // no spread, no z
});

test('review: a few tokens spread more than a whole function, so only the fragment reference keeps the tails honest', () => {
  // A project of 60 files, each with 4 functions of 96 tokens drawn from one skewed token distribution.
  const rnd = lehmer(1234567), words = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const draw = () => words[Math.min(rnd(words.length), rnd(words.length), rnd(words.length))];
  const files = Array.from({ length: 60 }, () => ({ lex: Array.from({ length: 384 }, draw), ranges: [[0, 96], [96, 192], [192, 288], [288, 384]] }));
  const m = new NgramModel({ n: 3 }); files.forEach((f) => m.add(f.lex));
  const b = baselineOf(m, files.slice(0, 30)); // the reference: the first 30 files
  assert.equal(b.n, 120);
  assert.deepEqual(b.fragments.map((f) => f.n), [1920, 960, 480, 240, 120, 0]);
  // the shorter the fragment, the wider its distribution, and all of them wider than whole functions
  for (let i = 1; i < 5; i++) assert.ok(b.fragments[i - 1].sd > b.fragments[i].sd);
  assert.ok(b.fragments[0].sd > 2 * b.sd && b.fragments[1].sd > 1.5 * b.sd);
  near(b.fragments[4].sd, b.sd, 1e-9); // a fragment of 96 tokens is a whole function here
  // fragments of 12 tokens from the other 30 files, each scored with its own file held out
  const naive = [], matched = [];
  for (const f of files.slice(30)) m.heldOut(f.lex, () => { for (let s = 3; s + 12 <= 384; s += 24) { const bits = m.crossEntropy(f.lex, { from: s, to: s + 12 }).bits; naive.push(surprise(bits, b)); matched.push(surprise(bits, b, { tokens: 12 })); } });
  assert.equal(naive.length, 480); assert.ok(matched.every((x) => x.window === 12 && x.n === 960));
  const share = (v, f) => v.filter(f).length / v.length;
  // against whole functions, ordinary fragments look alarming: more than a quarter of them beyond 2 sd …
  assert.ok(share(naive, (x) => Math.abs(x.z) >= 2) > 0.25);
  // … against fragments of their own length they are what they are: about 5% beyond 2 sd, about half above the median
  assert.ok(share(matched, (x) => Math.abs(x.z) >= 2) < 0.08);
  assert.ok(Math.abs(share(matched, (x) => x.percentile >= 0.5) - 0.5) < 0.08);
  assert.ok(share(matched, (x) => x.percentile >= 0.95) < 0.08);
});

test('review: small edges: 0 bits is +0, and a window that is not a number does not empty the hotspots', () => {
  const empty = new NgramModel();
  assert.ok(Object.is(empty.tokenBits(['a', 'b'])[0], 0)); // it was -0
  assert.ok(Object.is(empty.logProb([], 'a'), 0));
  const m = new NgramModel({ n: 2 }).add(seq('a b a b a c'));
  const tokens = seq('a b zz a').map((v, i) => ({ k: 'id', v, l: i + 1 })), lex = lexemes(tokens);
  const one = hotspots(m, lex, tokens, { top: 1, window: 1 });
  assert.equal(one[0].peak.lexeme, 'zz'); assert.equal(one[0].line, 3);
  assert.deepEqual(hotspots(m, lex, tokens, { top: 1, window: NaN }), one); // it used to return []
  assert.deepEqual(hotspots(m, lex, tokens, { top: 1, window: 0 }), one);
});
