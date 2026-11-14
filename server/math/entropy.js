// Naturalness of code: how surprising a piece of code is to a language model of the repository it lands in
// (what people loosely call its perplexity).
//
// WHAT IT MEASURES. The cross-entropy  H = -(1/N) Σ log2 P(t_i | t_(i-n+1) … t_(i-1))  of a token sequence under
// an n-gram model trained on the project's own tokens, in bits per token (perplexity is 2^H). Low: the project
// writes code like this all the time. High: it does not.
//
// WHAT IT DOES NOT MEASURE. Correctness. Unusual code can be right (a new feature brings new names) and wrong
// code can be perfectly ordinary (a copy-pasted bug scores as natural). Numbers and strings are collapsed to
// one token each, so a wrong constant or a wrong message is invisible here, and so is anything that is wrong
// because it is missing: an absent check has no tokens to be surprised by. The result is a reason to look
// first at one place rather than another. It is never a proof and never, by itself, a clearance.
// Two measurements that keep this honest. On a C# repository of 552,600 tokens (MessagePack-CSharp), the
// share of never-seen tokens in a function explains most of its score (Pearson r = 0.75 over 3,246 functions,
// each scored with its file held out): the number is largely a count of new vocabulary. On a JavaScript demo
// with a seeded defect, the function with the bug (a total that can go negative) scores 4.6 bits per token
// and its fix, which adds the missing clamp, 5.1: the fix is the more surprising of the two.
//
// BASIS. Hindle, Barr, Su, Gabel and Devanbu, "On the Naturalness of Software", ICSE 2012: source code is more
// repetitive than English and an n-gram model captures that regularity. Ray, Hellendoorn, Godhane, Tu,
// Bacchelli and Devanbu, "On the Naturalness of Buggy Code", ICSE 2016: over bug-fix commits of 10 Java
// projects, buggy lines had higher entropy than non-buggy ones and their entropy dropped when the bug was
// fixed. The effect they report is small to moderate (Cohen's d from 0.26 over all the commits they studied,
// up to 30 deleted lines per file, to 0.56 for commits that delete at most two lines) and they warn that it
// gives many false positives and false negatives. They used a cache model ($gram, Tu, Su and Devanbu 2014)
// with a normalisation per syntactic line type; this module is the plain n-gram model, so only the DIRECTION
// of their result is assumed here, not its size.
//
// MODEL. Interpolated Witten-Bell smoothing (Witten and Bell 1991, "The zero-frequency problem", IEEE Trans.
// Information Theory 37(4); interpolated form as in Chen and Goodman 1999, "An empirical study of smoothing
// techniques for language modeling", Computer Speech and Language 13(4)). For k = 1 … n, with h the last k-1
// tokens of the context and h' the same without its oldest token:
//
//     P_0(w)     = 1 / (V + 1)
//     P_k(w | h) = ( c(h w) + T(h) · P_(k-1)(w | h') ) / ( c(h) + T(h) )      when c(h) > 0
//     P_k(w | h) = P_(k-1)(w | h')                                            when c(h) = 0 (context never seen)
//
//   c(h w)  times the n-gram h w was seen          c(h)  Σ_w c(h w): times h was followed by anything
//   T(h)    distinct tokens seen after h           for k = 1: h is empty, c(h) = N tokens, T(h) = V distinct tokens
//
// Every P_k is a proper distribution over the V known tokens plus ONE class that stands for all unseen
// tokens: Σ_w c(h w) = c(h) and Σ_w P_(k-1) = 1 give (c(h) + T(h)) / (c(h) + T(h)) = 1. So no token has
// probability zero, and an unseen token is charged for "something never written here", not for its spelling.
// Each add() is one sequence (one file): n-grams never cross a file boundary and there is no padding, so the
// first token of a sequence is predicted by P_1, the second by P_2, and so on up to P_n.
//
// REFERENCE DISTRIBUTION. A raw number of bits means nothing without the project's own spread, and scoring a
// function under a model that has already seen it understates its entropy. baselineOf() therefore scores each
// function with its whole file taken out of the model (leave-one-file-out). For the same reason a changed file
// should be scored with its base version held out: model.heldOut(baseLexemes, () => model.crossEntropy(...)).
// Measured on the C# repository: scored with their own file still in the model, the 3,246 functions average
// 2.26 bits instead of 4.19 and sit at z = -0.97 on average against the honest baseline, every one of them
// lower than its held-out score. A changed function scored without holding out its base file is biased the
// same way.
//
// LIKE WITH LIKE. The mean over a few tokens spreads more than the mean over a whole function. On the same
// repository, held-out windows of 12 consecutive tokens have a standard deviation of 2.64 bits where whole
// functions have 1.97, and 10.6% of them lie 2 function-level standard deviations above the function mean
// where 3.6% of whole functions do. So a score over a few added lines must not be read against the whole
// function distribution: baselineOf() also keeps the distribution of fragments of 6, 12, 24 … tokens, and
// surprise(bits, baseline, { tokens }) compares a fragment with fragments.
//
// WHAT THE HOLD-OUT DOES NOT REMOVE (all three measured, none corrected here):
//   - Copies. Only the function's own file is taken out. An identical file elsewhere (35 groups of identical
//     files on the C# repository, 4% of its functions) or generated code that repeats a template stays in and
//     makes those functions look natural. That is true of the project, but it lowers the reference: without
//     the generated test resources the mean of that repository is 4.51 bits, not 4.19. The caller decides
//     which functions it offers.
//   - New names shared by the files of one pull request. In the baseline, a name defined in one file and
//     used in another is known when the second is held out; in a pull request scored against the base, a new
//     name is unseen in every file that uses it. Scoring each changed file against the head of the pull
//     request with only that file held out lowered z by up to 0.5 on the JavaScript demo (2.47 to 1.95) and
//     by 0.1 or less on most functions of the C# pull requests.
//   - Model size. The held-out model is smaller than the one that scores new code, and an unseen token costs
//     about log2(N + V) bits: 0.17 bits less per unseen token for the largest file of the C# repository (11%
//     of its tokens), more in a repository of a handful of files.
//
// COST, measured on 552,600 C# tokens (681 files, 126,283 distinct n-grams): training about 40 ms, scoring
// about 0.05 µs per token (0.07 from lexemes, with the string lookups), leave-one-file-out baseline over 500
// functions, fragments included, about 35 ms. On a busy machine these figures were up to three times higher.

/**
 * lexemes(tokens) → string[]: what the model sees.
 * Identifiers, keywords, operators and preprocessor lines verbatim; every number becomes '<num>' except the
 * literals 0 and 1 (they are idiom: indices, flags, increments); every string becomes '<str>'; 'nl' tokens are
 * dropped. '<' cannot start an identifier, so the two placeholders never collide with real code.
 * With tokens that hold no 'nl' (the default of tokenize), lexeme i is token i.
 */
export function lexemes(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.k === 'nl') continue;
    out.push(t.k === 'num' ? (t.v === '0' || t.v === '1' ? t.v : '<num>') : t.k === 'str' ? '<str>' : t.v);
  }
  return out;
}

const hash = (p, x) => { let h = Math.imul(p, 0x9E3779B1) + x | 0; h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B); return h ^ (h >>> 13); };

/**
 * (parent node, token id) → child node, for the n-grams of order 2 and up. Open addressing with linear probing
 * over one Int32Array of [parent, token, node] triples: several times faster here than a Map with numeric keys
 * (training on the C# repository: about 40 ms against 200 ms), and with no limit on the size of a packed key.
 * A parent is never node 0 (unigrams are not stored here), so 0 marks an empty slot. Deletion shifts the
 * following entries back (Knuth, TAOCP vol. 3, section 6.4, Algorithm R), so the table holds no tombstones
 * and remove() leaves exactly the entries add() had not made. The table is at most half full.
 * Internal to the model; exported only so its test can drive it at a size where probe runs wrap around.
 */
export class PairIndex {
  /** `cap`: initial number of slots, a power of two. Keys: p >= 1, x any int32. */
  constructor(cap = 1 << 12) { this.size = 0; this.cap = cap; this.mask = cap - 1; this.s = new Int32Array(cap * 3); }
  get(p, x) {
    const s = this.s, mask = this.mask;
    for (let h = hash(p, x) & mask; ; h = (h + 1) & mask) {
      const j = h * 3, q = s[j];
      if (q === 0) return -1;
      if (q === p && s[j + 1] === x) return s[j + 2];
    }
  }
  /** Stores a pair that is known to be absent. */
  set(p, x, c) {
    if ((this.size + 1) * 2 > this.cap) this.grow();
    const s = this.s, mask = this.mask;
    let h = hash(p, x) & mask; while (s[h * 3] !== 0) h = (h + 1) & mask;
    s[h * 3] = p; s[h * 3 + 1] = x; s[h * 3 + 2] = c; this.size++;
  }
  delete(p, x) {
    const s = this.s, mask = this.mask;
    let i = hash(p, x) & mask;
    for (; ; i = (i + 1) & mask) { const q = s[i * 3]; if (q === 0) return false; if (q === p && s[i * 3 + 1] === x) break; }
    for (let j = (i + 1) & mask; s[j * 3] !== 0; j = (j + 1) & mask) {
      const k = hash(s[j * 3], s[j * 3 + 1]) & mask; // where the entry at j wants to be
      if (i <= j ? (i < k && k <= j) : (i < k || k <= j)) continue; // between the hole and j: it stays reachable
      s[i * 3] = s[j * 3]; s[i * 3 + 1] = s[j * 3 + 1]; s[i * 3 + 2] = s[j * 3 + 2]; i = j;
    }
    s[i * 3] = 0; this.size--;
    return true;
  }
  grow() {
    const old = this.s; this.cap *= 2; this.mask = this.cap - 1;
    const s = this.s = new Int32Array(this.cap * 3), mask = this.mask;
    for (let j = 0; j < old.length; j += 3) {
      if (old[j] === 0) continue;
      let h = hash(old[j], old[j + 1]) & mask; while (s[h * 3] !== 0) h = (h + 1) & mask;
      s[h * 3] = old[j]; s[h * 3 + 1] = old[j + 1]; s[h * 3 + 2] = old[j + 2];
    }
  }
}

const grown = (a, n) => { const b = new Int32Array(n); b.set(a); return b; };

/** Identity of a sequence of token ids: its length and two different 32-bit hashes (FNV-1a and a Murmur3-style mix). */
function fingerprint(w) {
  let a = 0x811C9DC5 | 0, b = w.length | 0;
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    a = Math.imul(a ^ x, 0x01000193);
    b ^= Math.imul(x, 0xCC9E2D51); b = (b << 13) | (b >>> 19); b = Math.imul(b, 5) + 0xE6546B64 | 0;
  }
  return `${w.length}:${a >>> 0}:${b >>> 0}`;
}

/**
 * N-gram language model with interpolated Witten-Bell smoothing (formula in the header).
 *
 * The counts live in a trie. Node 0 is the empty context; a node of depth d is one d-gram. Per node:
 *   cnt    times this n-gram was seen: c(h w), read from the node of h w
 *   ctx    times it was followed by another token: c(h), read from the node of h
 *   types  distinct tokens that followed it: T(h)
 * Because whole sequences are added and removed, every suffix of a stored n-gram is stored with at least the
 * same count; scoring relies on that to stop looking up longer n-grams once a shorter one is missing. To keep
 * it true the model remembers which sequences it holds (by fingerprint) and refuses to take out any other.
 *
 * Token ids from encode() belong to this model only. Underscored members are internal.
 */
export class NgramModel {
  constructor({ n = 3 } = {}) {
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new RangeError('NgramModel: n must be an integer from 1 to 16');
    this.n = n;
    this._ids = new Map();              // lexeme → token id
    this._names = [];                   // token id → lexeme
    this._uni = new Int32Array(1024);   // token id → its unigram node
    this._index = new PairIndex();      // (node, token id) → child node, orders 2..n
    this._nodes = 1;                    // nodes handed out so far; node 0 is the empty context
    this._free = [];                    // nodes given back by remove()
    this._cnt = new Int32Array(4096); this._ctx = new Int32Array(4096); this._types = new Int32Array(4096);
    this._par = new Int32Array(4096); this._wrd = new Int32Array(4096); // parent node and last token of each node
    this._seqs = new Map();             // fingerprint of each sequence in the model → how many times it was added
    this._held = false;
  }

  /** V: distinct tokens currently in the model. */
  get vocabulary() { return this._types[0]; }
  /** N: tokens currently in the model. */
  get tokens() { return this._ctx[0]; }
  /** Distinct n-grams of every order currently stored. */
  get size() { return this._types[0] + this._index.size; }

  _node(parent, word) {
    let c = this._free.pop();
    if (c === undefined) {
      if (this._nodes === this._cnt.length) for (const k of ['_cnt', '_ctx', '_types', '_par', '_wrd']) this[k] = grown(this[k], this._nodes * 2);
      c = this._nodes++;
    }
    this._par[c] = parent; this._wrd[c] = word; // its counts are zero: new, or given back at zero
    return c;
  }

  /** Lexemes [lo, hi) as token ids; unknown lexemes get a new id when `intern`, -1 otherwise. */
  _encode(lex, lo, hi, intern) {
    if (lex instanceof Int32Array) return lo === 0 && hi === lex.length ? lex : lex.subarray(lo, hi);
    const out = new Int32Array(hi - lo), ids = this._ids;
    for (let i = lo; i < hi; i++) {
      let id = ids.get(lex[i]);
      if (id === undefined) {
        if (intern) {
          id = this._names.length; ids.set(lex[i], id); this._names.push(lex[i]);
          if (id === this._uni.length) this._uni = grown(this._uni, id * 2);
          this._uni[id] = this._node(0, id);
        } else id = -1;
      }
      out[i - lo] = id;
    }
    return out;
  }

  /**
   * encode(lex) → Int32Array of token ids, -1 for a lexeme the model has never been given. Every method that
   * takes lexemes also takes this array, which saves the string lookups when one file is scored many times.
   * Encode after training: a lexeme that is unknown now stays -1 in the array even if it is added later.
   */
  encode(lex) { return this._encode(lex, 0, lex.length, false); }

  _writable() { if (this._held) throw new Error('NgramModel: the model cannot be changed inside heldOut()'); }

  /** Counts one sequence (a file). Returns the model. */
  add(lex) {
    this._writable();
    const w = this._encode(lex, 0, lex.length, true), n = this.n, index = this._index, uni = this._uni, W = this._names.length;
    if (lex === w) for (let i = 0; i < w.length; i++) if (!(w[i] >= 0 && w[i] < W)) throw new RangeError('NgramModel.add: token id out of range');
    let cnt = this._cnt, ctx = this._ctx, types = this._types;
    const path = new Int32Array(n); // path[k]: node of the k tokens before the current one
    for (let i = 0; i < w.length; i++) {
      const x = w[i];
      for (let k = i < n - 1 ? i : n - 1; k >= 0; k--) { // longest first, so path[k + 1] can be overwritten in place
        const p = path[k]; let c;
        if (k === 0) c = uni[x];
        else if ((c = index.get(p, x)) < 0) { c = this._node(p, x); index.set(p, x, c); cnt = this._cnt; ctx = this._ctx; types = this._types; }
        if (cnt[c]++ === 0) types[p]++;
        ctx[p]++;
        if (k + 1 < n) path[k + 1] = c;
      }
    }
    const f = fingerprint(w); this._seqs.set(f, (this._seqs.get(f) || 0) + 1);
    return this;
  }

  /** The fingerprint of a sequence that is in the model; throws for any other, before anything is touched. */
  _member(w) {
    const f = fingerprint(w);
    if (!this._seqs.has(f)) throw new RangeError('NgramModel: that sequence is not in the model, nothing was removed');
    return f;
  }

  /**
   * Takes the counts of one sequence out without touching the index. Returns the nodes it decremented.
   * _member() has already vouched for the sequence; should two sequences ever share a fingerprint, the counts
   * themselves are the second check: a count that would go below zero undoes the whole call.
   */
  _take(w) {
    const n = this.n, index = this._index, uni = this._uni, W = this._names.length, cnt = this._cnt, ctx = this._ctx, types = this._types;
    const nodes = new Int32Array(w.length * n), path = new Int32Array(n);
    let m = 0, ok = true;
    scan: for (let i = 0; i < w.length; i++) {
      const x = w[i];
      if (!(x >= 0 && x < W)) { ok = false; break; }
      for (let k = i < n - 1 ? i : n - 1; k >= 0; k--) {
        const p = path[k], c = k === 0 ? uni[x] : index.get(p, x);
        if (c < 0 || cnt[c] === 0) { ok = false; break scan; }
        if (--cnt[c] === 0) types[p]--;
        ctx[p]--;
        nodes[m++] = c;
        if (k + 1 < n) path[k + 1] = c;
      }
    }
    const taken = nodes.subarray(0, m);
    if (!ok) { this._give(taken); throw new RangeError('NgramModel: that sequence is not in the model, nothing was removed'); }
    return taken;
  }

  /** Puts back what _take() took. */
  _give(nodes) {
    const cnt = this._cnt, ctx = this._ctx, types = this._types, par = this._par;
    for (let j = 0; j < nodes.length; j++) { const c = nodes[j], p = par[c]; if (cnt[c]++ === 0) types[p]++; ctx[p]++; }
  }

  /**
   * Exactly undoes one add() of the same sequence: afterwards every count, N, V and every probability are what
   * they were before that add(), whatever was added or removed in between. Throws, leaving the model
   * untouched, when the sequence is not one that was added and is still in. Returns the model.
   */
  remove(lex) {
    this._writable();
    const w = this._encode(lex, 0, lex.length, false), f = this._member(w), nodes = this._take(w);
    const left = this._seqs.get(f) - 1; if (left) this._seqs.set(f, left); else this._seqs.delete(f);
    const cnt = this._cnt, par = this._par, wrd = this._wrd;
    // An n-gram that reached zero leaves the index. Its children reached zero in this same call (a child is
    // never counted more often than its parent), so no live entry is left pointing at a node that is reused.
    for (let j = 0; j < nodes.length; j++) {
      const c = nodes[j];
      if (cnt[c] === 0 && par[c] > 0) { this._index.delete(par[c], wrd[c]); par[c] = -1; this._free.push(c); }
    }
    return this;
  }

  /**
   * heldOut(lex, fn) → what fn(model) returns, computed with the counts of `lex` taken out of the model, which
   * are put back afterwards. The same numbers as remove(lex), fn(), add(lex), at a fraction of the cost: the
   * counts drop to zero in place and an n-gram with count zero is scored exactly like one that is absent.
   * `lex` must be a sequence that was added (throws otherwise). fn must be synchronous: the counts are back
   * as soon as it returns. The model is read-only inside fn.
   */
  heldOut(lex, fn) {
    this._writable();
    const w = this._encode(lex, 0, lex.length, false); this._member(w);
    const nodes = this._take(w);
    this._held = true;
    try { return fn(this); } finally { this._held = false; this._give(nodes); }
  }

  /** Σ bits of tokens [from, to) of the encoded sequence w, earlier tokens being context. Fills out[i - from] when given. */
  _score(w, from, to, out) {
    const n = this.n, index = this._index, uni = this._uni, W = this._names.length, cnt = this._cnt, ctx = this._ctx, types = this._types;
    let path = new Int32Array(n).fill(-1), next = new Int32Array(n).fill(-1); // path[k]: node of the last k tokens, -1 when unseen
    path[0] = next[0] = 0;
    const p0 = 1 / (types[0] + 1);
    let total = 0;
    for (let i = Math.max(0, from - n + 1); i < to; i++) {
      const x = w[i];
      let p = p0, seen = x >= 0 && x < W;
      for (let k = 0; k < n; k++) {
        const h = path[k];
        if (h < 0 || ctx[h] === 0) { for (let j = k + 1; j < n; j++) next[j] = -1; break; } // context never followed by anything: so are the longer ones
        let c = -1, cc = 0;
        if (seen) {
          c = k === 0 ? uni[x] : index.get(h, x);
          if (c < 0 || (cc = cnt[c]) === 0) { c = -1; cc = 0; seen = false; } // unseen at this order: unseen at every longer one
        }
        const t = types[h];
        p = (cc + t * p) / (ctx[h] + t);
        if (k + 1 < n) next[k + 1] = c;
      }
      if (i >= from) { const b = p < 1 ? -Math.log2(p) : 0; total += b; if (out) out[i - from] = b; } // p = 1 only in an empty model: 0 bits, not -0
      const s = path; path = next; next = s;
    }
    return total;
  }

  _range(lex, from, to) {
    const b = Math.max(0, Math.min(lex.length, Math.floor(to))), a = Math.max(0, Math.min(b, Math.floor(from)));
    const lo = Math.max(0, a - this.n + 1); // the context is all that is needed from before `from`
    return { w: this._encode(lex, lo, b, false), a: a - lo, b: b - lo };
  }

  /**
   * logProb(context, word) → bits = -log2 P_n(word | last n-1 tokens of context), always finite and >= 0.
   * `context` is an array of lexemes, oldest first; a shorter context uses the lower-order distribution.
   * An empty model has the single class "unseen", so it answers 0 bits for anything: check `tokens` first.
   */
  logProb(context, word) {
    const c = this.n > 1 ? Array.from(context || []).slice(1 - this.n) : [];
    const w = this._encode([...c, word], 0, c.length + 1, false);
    return this._score(w, c.length, c.length + 1, null);
  }

  /** tokenBits(lex, { from, to }) → Float64Array with the bits of each token in [from, to). */
  tokenBits(lex, { from = 0, to = lex.length } = {}) {
    const { w, a, b } = this._range(lex, from, to), out = new Float64Array(b - a);
    this._score(w, a, b, out);
    return out;
  }

  /**
   * crossEntropy(lex, { from, to }) → { bits, tokens, total, unseen }
   *   total   Σ -log2 P(t_i | previous n-1 tokens) over i in [from, to); tokens before `from` are context only
   *   tokens  N = to - from (after clamping to the sequence)
   *   bits    total / N, bits per token; NaN for an empty range (there is nothing to average)
   *   unseen  how many of the N tokens the model has never seen anywhere (new names, mostly): they are the
   *           most expensive tokens, so this says how much of the number is just new vocabulary
   * Establishes how predictable these tokens are for the model as it is now: if the sequence itself is in the
   * model the number is biased low (use heldOut). Says nothing about whether the code is correct.
   */
  crossEntropy(lex, { from = 0, to = lex.length } = {}) {
    const { w, a, b } = this._range(lex, from, to), tokens = b - a, W = this._names.length;
    const total = tokens ? this._score(w, a, b, null) : 0;
    let unseen = 0;
    for (let i = a; i < b; i++) { const x = w[i]; if (!(x >= 0 && x < W) || this._cnt[this._uni[x]] === 0) unseen++; }
    return { bits: tokens ? total / tokens : NaN, tokens, total, unseen };
  }

  /** Every stored n-gram with its count, [{ gram: string[], count }] in a canonical order. For tests and debugging. */
  ngrams() {
    const out = [], cnt = this._cnt, par = this._par, wrd = this._wrd, names = this._names, s = this._index.s;
    for (let id = 0; id < names.length; id++) if (cnt[this._uni[id]] > 0) out.push({ gram: [names[id]], count: cnt[this._uni[id]] });
    for (let j = 0; j < s.length; j += 3) {
      const c = s[j + 2];
      if (s[j] === 0 || cnt[c] === 0) continue;
      const gram = []; for (let q = c; q !== 0; q = par[q]) gram.push(names[wrd[q]]);
      out.push({ gram: gram.reverse(), count: cnt[c] });
    }
    const keyed = out.map((e) => [e.gram.join('\u0001'), e]);
    return keyed.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((k) => k[1]);
  }
}

/** Sample quantile by linear interpolation between order statistics (type 7 of Hyndman and Fan 1996, the default of R and NumPy). */
function quantile(sorted, q) {
  const h = (sorted.length - 1) * q, lo = Math.floor(h), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Fragment lengths, in tokens, for which baselineOf() keeps a reference distribution, and how many fragments a
 * length needs before surprise() will use it (below that a standard deviation is mostly noise: its standard
 * error is about sd / sqrt(2(n - 1)), 13% at n = 30).
 */
const FRAGMENTS = [6, 12, 24, 48, 96, 192], MIN_FRAGMENTS = 30;

/**
 * { n, mean, sd } of values sorted ascending; sd is the sample standard deviation (divisor n - 1).
 * When every value is the same to within rounding, sd is exactly 0: summing n equal numbers and dividing by n
 * need not give the number back, and the residue (about 1e-16) would otherwise pass for a spread.
 */
function moments(sorted) {
  const n = sorted.length;
  if (!n) return { n: 0, mean: null, sd: null };
  let sum = 0; for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;
  if (n < 2 || sorted[n - 1] - sorted[0] <= 1e-12 * Math.max(1, Math.abs(mean))) return { n, mean, sd: 0 };
  let ss = 0; for (let i = 0; i < n; i++) ss += (sorted[i] - mean) * (sorted[i] - mean);
  return { n, mean, sd: Math.sqrt(ss / (n - 1)) };
}

/**
 * baselineOf(model, files, { max = 500 }) → { mean, sd, n, p50, p90, p99, min, max, population, sorted, fragments }
 * The project's own distribution of function-level cross-entropy, leave-one-file-out.
 *   files       [{ lex, ranges: [[a, b), …] }]: the lexemes of a file that IS in the model (lex may also be
 *               model.encode(lex)) and the lexeme ranges of its functions. Throws if a file is not in the model.
 *   population  functions offered (non-empty ranges); n of them were scored. Above `max`, a systematic sample:
 *               functions number floor(j · population / max), j = 0 … max-1, in the order given, so the same
 *               input always gives the same baseline.
 *   mean, sd    of the n values; sd is the sample standard deviation (divisor n - 1), 0 when n = 1 or when all
 *               values are equal
 *   p50 …       type-7 quantiles; sorted is the n values in ascending order, kept for exact percentiles
 *   fragments   [{ tokens: L, n, mean, sd, sorted }] for L = 6, 12, 24, 48, 96, 192: the same statistics for the
 *               mean bits per token of L consecutive tokens, taken from the same functions under the same
 *               hold-out (each function cut into windows of L from its first token, the remainder dropped).
 *               It is the reference for a score over part of a function: see surprise().
 * For each file its counts are taken out, its functions are scored with their real left context, and the
 * counts are put back, so no function is scored by a model that was trained on its own file. A file whose
 * removal leaves the model empty is skipped (nothing to compare it with). With n = 0 every statistic is null.
 *
 * What it does not control for: copies of the function in other files, which stay in the model; and which
 * functions are offered (generated code and tests pull the mean down). See the header for the sizes measured.
 */
export function baselineOf(model, files, { max = 500 } = {}) {
  const all = [];
  files.forEach((f, fi) => {
    for (const r of f.ranges || []) { const b = Math.min(f.lex.length, r[1]), a = Math.max(0, r[0]); if (b > a) all.push([fi, a, b]); }
  });
  const cap = Math.max(1, Math.floor(max));
  const pick = all.length > cap ? Array.from({ length: cap }, (_, j) => all[Math.floor(j * all.length / cap)]) : all;
  const values = [], parts = FRAGMENTS.map(() => []);
  for (let i = 0; i < pick.length;) {
    const fi = pick[i][0]; let j = i; while (j < pick.length && pick[j][0] === fi) j++;
    const ids = model.encode(files[fi].lex);
    model.heldOut(ids, () => {
      if (model.tokens === 0) return;
      for (let k = i; k < j; k++) {
        const bits = model.tokenBits(ids, { from: pick[k][1], to: pick[k][2] }), len = bits.length;
        let total = 0; for (let q = 0; q < len; q++) total += bits[q]; // the same additions, in the same order, as crossEntropy
        values.push(total / len);
        for (let r = 0; r < FRAGMENTS.length && FRAGMENTS[r] <= len; r++) {
          const L = FRAGMENTS[r];
          for (let s = 0; s + L <= len; s += L) { let u = 0; for (let q = s; q < s + L; q++) u += bits[q]; parts[r].push(u / L); }
        }
      }
    });
    i = j;
  }
  const sorted = values.slice().sort((x, y) => x - y), { n, mean, sd } = moments(sorted);
  const fragments = FRAGMENTS.map((L, r) => { const so = Array.from(new Float64Array(parts[r]).sort()); return { tokens: L, ...moments(so), sorted: so }; });
  if (!n) return { mean: null, sd: null, n: 0, p50: null, p90: null, p99: null, min: null, max: null, population: all.length, sorted, fragments };
  return {
    mean, sd, n,
    p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p99: quantile(sorted, 0.99),
    min: sorted[0], max: sorted[n - 1], population: all.length, sorted, fragments,
  };
}

/** Share of the ascending values strictly below x. */
function below(sorted, x) {
  let lo = 0, hi = sorted.length; // first index whose value is not below x
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  return lo / sorted.length;
}

/**
 * surprise(bits, baseline) → { z, percentile }                               a whole function
 * surprise(bits, baseline, { tokens }) → { z, percentile, window, n }        `tokens` tokens of a function
 *   z           (bits - mean) / sd: distance from the project's mean in its own standard deviations;
 *               null when it is undefined (no baseline, fewer than two values, or sd = 0)
 *   percentile  share of the reference strictly below `bits`, from 0 to 1 (0.97: more surprising than 97% of
 *               it). Exact when the baseline carries its `sorted` values; otherwise interpolated linearly
 *               between min, p50, p90, p99 and max, and the result has approx: true.
 * Without `tokens` the reference is the baseline's whole functions: use it for a score over a whole function.
 * With `tokens` (the number of tokens the score was averaged over, e.g. the added lines of a function) the
 * reference is the baseline's fragments of `window` tokens, the longest length kept that is not above `tokens`
 * and has at least 30 fragments; n is how many. Fragments shorter than the score spread more, so this errs
 * towards a smaller |z|, never a larger one. When no length qualifies (fewer than 6 tokens, or a project too
 * small to have 30 fragments of any length) z and percentile are null and window is null: there is nothing
 * honest to compare with. The reference fragments are contiguous; a score summed over several separate runs
 * of lines varies a little less, which errs the same way.
 *
 * Establishes where this code stands in the project's own distribution, nothing else. z is NOT a p-value:
 * the entropies are right-skewed, not normal (on the C# repository: skewness 0.6, and 3.5% of functions
 * above mean + 2 sd where a normal distribution has 2.3%), so read tail shares from `percentile`. With few
 * values z is itself uncertain (the standard error of sd is about sd / sqrt(2(n - 1)): 13% at n = 30). A
 * high value means unusual for this project; it does not mean wrong, and a low value does not mean right.
 */
export function surprise(bits, baseline, options) {
  const tokens = options ? options.tokens : undefined;
  if (tokens !== undefined) {
    let ref = null;
    if (Number.isFinite(bits) && tokens >= 1) for (const f of (baseline && baseline.fragments) || []) if (f.tokens <= tokens && f.n >= MIN_FRAGMENTS && (!ref || f.tokens > ref.tokens)) ref = f;
    if (!ref) return { z: null, percentile: null, window: null, n: 0 };
    return { z: ref.sd > 0 ? (bits - ref.mean) / ref.sd : null, percentile: below(ref.sorted, bits), window: ref.tokens, n: ref.n };
  }
  if (!Number.isFinite(bits) || !baseline || !(baseline.n > 0)) return { z: null, percentile: null };
  const z = baseline.n > 1 && baseline.sd > 0 ? (bits - baseline.mean) / baseline.sd : null;
  const s = baseline.sorted;
  if (s && s.length) return { z, percentile: below(s, bits) };
  const knots = [[baseline.min, 0], [baseline.p50, 0.5], [baseline.p90, 0.9], [baseline.p99, 0.99], [baseline.max, 1]].filter((k) => Number.isFinite(k[0]));
  if (!knots.length) return { z, percentile: null };
  let percentile = bits > knots[knots.length - 1][0] ? 1 : 0;
  for (let i = 1; i < knots.length && bits > knots[0][0]; i++) {
    const [x0, q0] = knots[i - 1], [x1, q1] = knots[i];
    if (bits <= x1) { percentile = x1 > x0 ? q0 + (q1 - q0) * (bits - x0) / (x1 - x0) : q0; break; }
  }
  return { z, percentile, approx: true };
}

/**
 * hotspots(model, lex, tokens, { top = 5, window = 8, from = 0, to = lex.length })
 *   → [{ line, endLine, from, to, bits, peak: { line, lexeme, bits } }], most surprising first
 * The `top` non-overlapping windows of `window` consecutive tokens with the highest mean bits per token inside
 * [from, to), so the interface can point at the unusual lines of a function. `tokens` are the lexer tokens
 * that `lex` was made from (they carry the lines; 'nl' tokens are ignored); `from`/`to` are lexeme indices and
 * tokens before `from` serve as context. `peak` is the single most surprising token of the window. A range
 * shorter than `window` gives one window over all of it. Ties go to the earlier window.
 * It ranks places inside one function. It does not say that any of them is wrong, or even unusual in absolute
 * terms: compare `bits` with the baseline for that.
 */
export function hotspots(model, lex, tokens, { top = 5, window = 8, from = 0, to = lex.length } = {}) {
  const lines = [];
  for (const t of tokens) if (t.k !== 'nl') lines.push(t.l);
  if (lines.length !== lex.length) throw new RangeError('hotspots: lex and tokens do not line up');
  const b = Math.max(0, Math.min(lex.length, Math.floor(to))), a = Math.max(0, Math.min(b, Math.floor(from))), n = b - a;
  if (!n || top < 1) return [];
  const bits = model.tokenBits(lex, { from: a, to: b }), w = Math.max(1, Math.min(Math.floor(window) || 1, n)); // a window that is not a number counts as 1
  const pre = new Float64Array(n + 1); // prefix sums: each window is one subtraction, with no drift
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + bits[i];
  const cands = [];
  for (let s = 0; s + w <= n; s++) cands.push([(pre[s + w] - pre[s]) / w, s]);
  cands.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const out = [];
  for (const [mean, s] of cands) {
    if (out.length >= top) break;
    if (out.some((o) => Math.abs(o.from - a - s) < w)) continue;
    let pk = s; for (let i = s + 1; i < s + w; i++) if (bits[i] > bits[pk]) pk = i;
    out.push({ line: lines[a + s], endLine: lines[a + s + w - 1], from: a + s, to: a + s + w, bits: mean, peak: { line: lines[a + pk], lexeme: lex[a + pk], bits: bits[pk] } });
  }
  return out;
}
