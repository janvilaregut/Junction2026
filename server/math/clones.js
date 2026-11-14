// Duplicated code, measured: the DRY principle as a number instead of an opinion.
//
// Basis. Schleimer, Wilkerson and Aiken, "Winnowing: Local Algorithms for Document Fingerprinting",
// SIGMOD 2003. Every run of k consecutive tokens (a k-gram) is hashed; out of every window of w consecutive
// k-gram hashes the minimum is kept as a fingerprint. Their two properties, with t = w + k - 1:
//   1. a shared run of at least t tokens (the guarantee threshold) is always detected, and
//   2. nothing shorter than k tokens (the noise threshold) is ever detected, because only k-grams are compared.
// The expected share of positions kept is 2 / (w + 1) (section 3.1 of the paper), which is what makes an index
// of a whole repository small.
//
// What is compared. Tokens are normalised first: every identifier becomes I, every number N, every string S;
// keywords, operators and preprocessor lines keep their text. Comments and layout never reach us (the lexer
// drops them). So a match is a type-1 clone or the identifier-and-literal part of a type-2 clone in the taxonomy
// of Roy and Cordy, "A Survey on Software Clone Detection Research", TR 2007-541, Queen's University, 2007
// (type I: identical but for whitespace, layout and comments; type II: also identifiers, literals and types).
// Built-in type names are keywords here and keep their text, so `int x` and `long x` do NOT match: on types
// this is stricter than type II. Type-3 clones (statements added or removed) are found only as the separate
// runs that survive, and type-4 (same computation, different syntax) not at all.
//
// Why it matters. Juergens, Deissenboeck, Hummel and Wagner, "Do Code Clones Matter?", ICSE 2009: in the
// commercial and open source systems they studied, clones that had been changed inconsistently were frequent
// and a significant number of them were faults. That is evidence about clones in general, not a statement about
// any single span reported here.
//
// One restriction of property 1 that is ours, not the paper's. A k-gram that is only a short unit repeated
// (a period of at most k/2 tokens: `N , N , N , …`, the same short call again and again) is never used as a
// fingerprint. The paper keeps such low-entropy strings and makes them affordable with robust winnowing
// (section 5.1); here they are dropped because after normalisation any list of literals equals any other, so
// the unit that repeats carries less than the noise threshold, and because two such runs match each other at
// every shift. The price, stated exactly: a shared run that is PURELY such a repetition from its first token
// to its last is not detected. Every other shared run of t tokens or more is (proof at CloneIndex).
//
// Idioms. A span says two ranges are equal; it does not say that the equality is news. Code that everybody in a
// repository writes the same way (a null check and an early return, the serialise-then-assert lines of a test,
// the members a template stamps out) matches in dozens of places, and reporting a new function as a copy of one
// of them misleads. The paper names the problem (section 5.2: "a very significant issue in a practical
// copy-detection system is the ability to ignore boiler-plate") and MOSS, the system it describes, answers it
// with a frequency rule: its -m option never reports a passage that appears in more than m programs, and the
// default is m = 10 (usage notes of the MOSS submission script). The same rule is applied here, per token and
// on verified matches only: a query token is COMMON when at least `commonAt` indexed sequences each share with
// the query a run of k tokens or more that contains it. Nothing is hidden: `common` is a count next to `tokens`,
// and tokens − common is the part of a match that is not house style. The count is a lower bound (see query()),
// so code is never called common without that many verified occurrences. Measured on a C# repository where
// each of 1 252 function bodies with a clone was queried against all the others: for 685 of them at least half
// of the best match is common. What frequency cannot see: an idiom that is rare in the indexed repository (an
// Equals preamble written twice, a test scaffold used once before) is not common here and stays a plain match.
//
// Tokens are not text. A span counts normalised tokens, and one token can be a 30-line string literal: two tests
// with the same scaffolding and different inputs match in every token. `sameText` says how much of a match is
// literally the same characters, so that "100% of the tokens" is never read as "the same code".
//
// What a reported span IS: a proof, by token-by-token comparison, that two ranges have the same normalised
// token sequence. Hashes only find candidates; no span is reported on the strength of a hash.
// What it is NOT: proof that the code was copied, that the two ranges compute the same thing (every identifier
// is the same I, so `a - b` and `b - a` are equal here, and so are two different tables of numbers), or that the
// duplication is harmful. And the absence of a span proves only that no shared run of t or more normalised
// tokens, other than a pure repetition, exists against what was indexed (and only when `truncated` is false).

/**
 * k = 20 is the noise threshold. Once names and literals are erased, short stretches of any program look alike
 * (`I . I ( I , I ) ;` is every two-argument call), so a match has to span several statements before it says
 * anything; twenty normalised tokens is two to three ordinary statements.
 * w = 21 gives the guarantee threshold t = w + k - 1 = 40 tokens, about four to six lines of code: every shared
 * run that long is found, and the index keeps an expected 2 / (w + 1) = 1 in 11 positions.
 */
export const DEFAULTS = { k: 20, w: 21 };

// Comparisons and posting visits one query may spend before it stops and says so (`truncated`). A count, not a
// clock, so that the same input always gives the same output. Measured on a C# repository of 5 928 function
// bodies, each queried against all the others: 96% stayed under 5 000 and none reached 300 000. What gets near
// the limit is a long block repeated hundreds of times in both the query and the index.
const MAX_WORK = 2_000_000;

// A passage shared with this many indexed sequences is common (see "Idioms" above). 10 is the MOSS default for
// its -m option: with the query itself that is 11 occurrences, and MOSS draws the line at "more than m programs".
// It is a convention, not a derived constant: callers with a small repository may want it lower.
const COMMON_AT = 10;

// ---------------------------------------------------------------------------------------------------------
// Normalisation

/**
 * normalize(tokens) → string[]
 * id → 'I', num → 'N', str → 'S'; kw / op / pp keep their text; nl is dropped.
 * (A keyword spelled I, N or S would be read as that class; no language of the lexer has one.)
 */
export function normalize(tokens) {
  const out = [];
  for (const t of tokens) {
    const kind = t.k;
    if (kind === 'nl') continue;
    out.push(kind === 'id' ? 'I' : kind === 'num' ? 'N' : kind === 'str' ? 'S' : String(t.v));
  }
  return out;
}

// A normalised token is two things here: a small integer code that is exact (one code per distinct text, used
// for every comparison that decides a result) and a 32-bit hash of its text (used only to build k-gram hashes,
// so that those depend on the text alone and not on the order in which tokens were first seen).
const mix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
function tokenHash(s) { // FNV-1a over UTF-16 units, then an avalanche so one-character tokens still fill 32 bits
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return mix(h);
}

class Coder {
  constructor() { this.ids = new Map([['I', 0], ['N', 1], ['S', 2]]); this.hash = [tokenHash('I'), tokenHash('N'), tokenHash('S')]; }
  code(text) {
    let c = this.ids.get(text);
    if (c === undefined) { c = this.hash.length; this.ids.set(text, c); this.hash.push(tokenHash(text)); }
    return c;
  }
  /**
   * Lexer tokens → { n, codes, lines, texts }: the same mapping as normalize(), as integers, with each token's
   * line and, when `keep` is set, its own text (what normalisation erased; only sameText reads it).
   */
  encode(tokens, keep = false) {
    const m = tokens.length, codes = new Int32Array(m), lines = new Int32Array(m), texts = keep ? new Array(m) : null;
    let n = 0;
    for (let i = 0; i < m; i++) {
      const t = tokens[i], kind = t.k;
      if (kind === 'nl') continue;
      codes[n] = kind === 'id' ? 0 : kind === 'num' ? 1 : kind === 'str' ? 2 : this.code(String(t.v));
      if (keep) texts[n] = typeof t.v === 'string' ? t.v : String(t.v);
      lines[n++] = t.l;
    }
    if (n === m) return { n, codes, lines, texts };
    if (keep) texts.length = n;
    return { n, codes: codes.slice(0, n), lines: lines.slice(0, n), texts };
  }
  /** Already normalised strings → codes (for kgramHashes). */
  encodeNorm(norm) {
    const codes = new Int32Array(norm.length);
    for (let i = 0; i < norm.length; i++) codes[i] = this.code(String(norm[i]));
    return codes;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Hashing and selection

const BASE = 0x9e3779b1; // any odd multiplier works modulo 2^32; this one spreads bits well

/**
 * Rolling hash of every k-gram, modulo 2^32 (Karp and Rabin 1987, as given in section 2.2 of the winnowing
 * paper, in its second form where every token is multiplied by the base at least once so that the last token
 * also reaches the high bits):
 *   H(c1..ck) = c1·b^k + c2·b^(k-1) + … + ck·b          H(c2..ck+1) = ((H(c1..ck) − c1·b^k) + ck+1) · b
 * Equal k-grams always get equal hashes; different k-grams may collide, which is why nothing is ever reported
 * from a hash alone.
 */
function roll(codes, n, k, table) {
  const m = n - k + 1;
  if (m <= 0) return new Uint32Array(0);
  const out = new Uint32Array(m);
  let bk = 1, h = 0;
  for (let i = 0; i < k; i++) { bk = Math.imul(bk, BASE); h = Math.imul((h + table[codes[i]]) | 0, BASE); }
  out[0] = h;
  for (let i = 1; i < m; i++) {
    h = Math.imul((h - Math.imul(table[codes[i - 1]], bk) + table[codes[i + k - 1]]) | 0, BASE);
    out[i] = h;
  }
  return out;
}

const posInt = (v, name) => { if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${v}`); return v; };
const posIntOrInf = (v, name) => (v === Infinity ? v : posInt(v, name));

/**
 * kgramHashes(norm, k) → Uint32Array of length max(0, norm.length − k + 1)
 * The rolling hash of the k-gram that starts at each index of a normalised token array (see normalize()).
 */
export function kgramHashes(norm, k = DEFAULTS.k) {
  posInt(k, 'k');
  const coder = new Coder(), codes = coder.encodeNorm(norm);
  return roll(codes, codes.length, k, coder.hash);
}

/** Positions selected by winnowing, ascending. The loop of figure 5 of the paper. */
function select(hashes, w, robust) {
  const n = hashes.length, out = [];
  if (!n) return out;
  if (n < w) { // shorter than one window: see winnow()
    let m = n - 1;
    for (let i = n - 2; i >= 0; i--) if (hashes[i] < hashes[m]) m = i;
    out.push(m);
    return out;
  }
  let min = -1; // position of the hash selected by the previous window
  for (let r = w - 1; r < n; r++) { // window [r − w + 1, r]
    const l = r - w + 1;
    if (min < l) { // it left the window (or this is the first one): rescan right to left for the rightmost minimum
      min = r;
      for (let i = r - 1; i >= l; i--) if (hashes[i] < hashes[min]) min = i;
      out.push(min);
    } else if (robust ? hashes[r] < hashes[min] : hashes[r] <= hashes[min]) { min = r; out.push(min); }
  }
  return out;
}

/**
 * winnow(hashes, w, { robust = false }) → [{ h, i }], i ascending; i is the k-gram start index.
 *
 * Default, Definition 1 of the paper (winnowing): the minimum of every window of w consecutive hashes, the
 * rightmost one on ties, each selected position recorded once. This rule is local: what a window selects
 * depends on that window alone, so two documents that share a window select the same position in it (Lemma 1
 * of the paper: any local algorithm finds every match of at least t).
 * robust: true, Definition 3 (robust winnowing, section 5.1): on a tie the hash selected by the previous window
 * is kept while it is still in the window. No longer local: two documents select the same hash VALUE in a shared
 * window but possibly at different positions. In exchange a run of one repeated k-gram costs one fingerprint
 * per window instead of one per position.
 *
 * Either way every window of w consecutive hashes contains a selected position that holds its minimum, which
 * is all CloneIndex relies on. One addition to the paper: a sequence shorter than one window (0 < length < w)
 * is treated as a single window, so that a function too short for the guarantee can still be found when it is
 * copied whole. That only adds fingerprints; the guarantee speaks of runs of t tokens or more and is untouched.
 */
export function winnow(hashes, w = DEFAULTS.w, { robust = false } = {}) {
  posInt(w, 'w');
  return select(hashes, w, robust).map((i) => ({ h: hashes[i], i }));
}

/**
 * Marks the k-grams that are only a short unit repeated: some period p ≤ k/2 holds across the whole k-gram
 * (token[z] = token[z − p]), so the unit occurs at least twice in it. A property of the k tokens alone, hence
 * the same verdict wherever that k-gram occurs. Uint8Array over k-gram start positions.
 */
function repetitiveKgrams(codes, n, k) {
  const out = new Uint8Array(Math.max(0, n - k + 1));
  for (let p = 1; p <= k >> 1; p++) {
    const need = k - p; // equalities in a row that make the k-gram ending here periodic
    for (let z = p, run = 0; z < n; z++) {
      if (codes[z] !== codes[z - p]) run = 0;
      else if (++run >= need) out[z - k + 1] = 1;
    }
  }
  return out;
}

/** Prefix sums over tokens of "lies in a repetitive k-gram": sum[e] − sum[a] counts them in [a, e). */
function repetitiveSums(codes, n, k) {
  const kg = repetitiveKgrams(codes, n, k), sum = new Int32Array(n + 1);
  for (let z = 0, until = 0; z < n; z++) {
    if (z < kg.length && kg[z]) until = z + k;
    sum[z + 1] = sum[z] + (z < until ? 1 : 0);
  }
  return sum;
}

/** Fingerprint positions of one sequence: robust winnowing over the k-grams that are not pure repetition. */
function fingerprints(codes, n, k, w, hs) {
  const kg = repetitiveKgrams(codes, n, k);
  if (!kg.includes(1)) return select(hs, w, true);
  const v = new Float64Array(hs);
  for (let i = 0; i < v.length; i++) if (kg[i]) v[i] = Infinity; // never the minimum of a window that has anything else
  return select(v, w, true).filter((p) => !kg[p]);
}

// ---------------------------------------------------------------------------------------------------------
// Matching

/**
 * One seed (query k-gram i, document k-gram p with the same hash) → the maximal verified match through it.
 * `diag` remembers, per diagonal (query index − document index, offset by `base` to keep documents apart),
 * where the last verified match ended in the query, so that a match is extended once however many seeds fall
 * inside it.
 * Returns [a, e, b] (query range [a, e), document start b), or null when the pair was already covered or the
 * two k-grams differ (a hash collision). `cost.work` counts the token comparisons.
 */
function extend(qc, qn, dc, dn, i, p, k, diag, base, cost) {
  const dg = base + i - p, done = diag.get(dg);
  // Covered: inside the last match of this diagonal, or straddling the mismatch that ended it (cannot be equal).
  if (done !== undefined && i < done) return null;
  for (let x = 0; x < k; x++) if (qc[i + x] !== dc[p + x]) { cost.work += x + 1; return null; }
  let a = i, b = p, e = i + k, f = p + k;
  while (a > 0 && b > 0 && qc[a - 1] === dc[b - 1]) { a--; b--; }
  while (e < qn && f < dn && qc[e] === dc[f]) { e++; f++; }
  cost.work += e - a;
  diag.set(dg, e);
  return [a, e, b];
}

/**
 * A subset of the spans [a, e, b] that covers everything they cover, in the range that counts (side 0: the
 * query range [a, e); side 1: the later range [b, b + e − a)). Longest first, a span is taken when it covers a
 * position no longer span did, so the longest evidence is always listed; then spans that the others make
 * redundant are dropped again, shortest first. `count` is a zeroed scratch array and is zeroed again on return.
 * Returns { kept, covered, repetitive, common }: positions covered, and how many of them `sum` marks repetitive
 * and `com` (optional, like `sum`) marks common.
 */
function cover(spans, side, count, sum, any, com) {
  const from = (s) => (side ? s[2] : s[0]), len = (s) => s[1] - s[0];
  spans.sort((x, y) => len(y) - len(x) || x[0] - y[0] || x[2] - y[2]);
  const kept = [], drop = new Set();
  let covered = 0, repetitive = 0, common = 0;
  for (const s of spans) { // count[z]: how many kept spans cover z
    const lo = from(s), hi = lo + len(s);
    let fresh = 0;
    for (let z = lo; z < hi; z++) if (!count[z]) fresh++;
    if (!fresh) continue;
    for (let z = lo; z < hi; z++) if (!count[z]++) { repetitive += sum[z + 1] - sum[z]; if (com) common += com[z + 1] - com[z]; if (any) any[z] = 1; }
    kept.push(s); covered += fresh;
  }
  for (let j = kept.length - 1; j >= 1; j--) { // shortest first (kept is sorted longest first); never the longest
    const lo = from(kept[j]), hi = lo + len(kept[j]);
    let spare = true;
    for (let z = lo; z < hi && spare; z++) spare = count[z] > 1;
    if (!spare) continue;
    for (let z = lo; z < hi; z++) count[z]--;
    drop.add(kept[j]);
  }
  for (const s of kept) count.fill(0, from(s), from(s) + len(s));
  return { kept: drop.size ? kept.filter((s) => !drop.has(s)) : kept, covered, repetitive, common };
}

/**
 * How much of a match is the same TEXT, not only the same normalised tokens: over the query tokens of the span
 * [a, e) aligned with the candidate from b, [characters in tokens whose text is identical on both sides,
 * characters in all of them]. Token text is compared as strings; comments and layout never reach us.
 */
function sameText(qt, dt, a, e, b) {
  let same = 0, all = 0;
  for (let z = a, y = b; z < e; z++, y++) {
    const v = qt[z], len = v.length;
    all += len;
    if (v === dt[y]) same += len;
  }
  return [same, all];
}

/**
 * Prefix sums over query tokens of "common": sum[e] − sum[a] counts the tokens of [a, e) that lie in a verified
 * match (k tokens or more, whatever minTokens is) with at least `at` different candidates. Each candidate counts
 * once per token however many of its matches cover it.
 */
function commonSums(cands, n, at) {
  const sum = new Int32Array(n + 1);
  let matched = 0;
  for (const c of cands) if (c.spans.length || c.rest) matched++;
  if (matched < at) return sum; // fewer candidates than the threshold: no token can reach it
  const step = new Int32Array(n + 1); // difference array: +1 where a candidate starts covering, −1 where it stops
  for (const c of cands) {
    if (!c.spans.length && !c.rest) continue;
    const list = c.rest ? c.spans.concat(c.rest) : c.spans;
    if (list.length > 1) list.sort((x, y) => x[0] - y[0]); // by start, so that the union is one sweep (cover() re-sorts)
    let end = 0;
    for (const s of list) {
      const lo = s[0] > end ? s[0] : end;
      if (s[1] > lo) { step[lo]++; step[s[1]]--; end = s[1]; }
    }
  }
  for (let z = 0, shared = 0; z < n; z++) { shared += step[z]; sum[z + 1] = sum[z] + (shared >= at ? 1 : 0); }
  return sum;
}

const span = (s, la, lb, sum, side) => {
  const n = s[1] - s[0], at = side ? s[2] : s[0];
  return { a: { start: la[s[0]], end: la[s[1] - 1] }, b: { start: lb[s[2]], end: lb[s[2] + n - 1] }, tokens: n, repetitive: sum[at + n] - sum[at] };
};

/**
 * An index of token sequences (function bodies, usually) that answers: where else does this code occur?
 *
 * The index keeps, for each added sequence, the fingerprints selected by robust winnowing among its k-grams
 * that are not pure repetition. A query looks up EVERY k-gram of the queried sequence, not only its own
 * fingerprints. The guarantee then has a short proof that does not depend on how ties are broken:
 *   Let the query and an indexed sequence D share a run of at least t = w + k − 1 normalised tokens, and let
 *   at least one k-gram g of the run not be a pure repetition. Inside D the run holds at least w consecutive
 *   k-grams, so some full window of w consecutive k-grams lies inside the run and contains g. add() selected a
 *   minimal non-repetitive k-gram of that window: a position p inside the run. The query holds the very same
 *   k-gram at the aligned position, the same k-gram has the same hash, and the query looks all of its k-grams
 *   up: the pair is found, compared token by token, and extended in both directions until the tokens differ
 *   or a sequence ends.
 * So: every shared run of t or more tokens is reported with its full extent, unless it is a pure repetition
 * (a unit of at most k/2 tokens repeated from its first token to its last), or the query ran out of its work
 * budget, in which case the result says `truncated`. Runs of k to t − 1 tokens are reported when a fingerprint
 * happens to fall inside them (ask with minTokens < t to see those: best effort, not a guarantee). Nothing
 * shorter than k can be found.
 */
export class CloneIndex {
  /**
   * opts: { k, w, maxWork, commonAt }: see DEFAULTS; maxWork bounds the comparisons one query may spend;
   * commonAt (default 10, Infinity to switch it off) is how many indexed sequences must share a passage for it
   * to count as common.
   */
  constructor(opts = {}) {
    this.k = posInt(opts.k ?? DEFAULTS.k, 'k');
    this.w = posInt(opts.w ?? DEFAULTS.w, 'w');
    this.t = this.w + this.k - 1; // guarantee threshold
    this.maxWork = opts.maxWork ?? MAX_WORK;
    this.commonAt = posIntOrInf(opts.commonAt ?? COMMON_AT, 'commonAt');
    this.docs = [];               // { id, meta, n, codes, lines, texts }
    this.postings = new Map();    // k-gram hash → [doc, position, doc, position, …]
    this.coder = new Coder();
    this.tokens = 0;              // normalised tokens added
    this.fingerprints = 0;        // positions stored
    this.longest = 0;             // longest sequence added
    this.slot = new Int32Array(0); // scratch of query(): per document, 1 + its place among the candidates met so far
  }

  get size() { return this.docs.length; }

  /**
   * add(id, tokens, meta = {}) → number of fingerprints stored for this sequence.
   * `tokens` are lexer tokens; `meta` is returned untouched with every match (file, name, lines: the caller's).
   * A sequence shorter than k tokens, or one that is a pure repetition, stores nothing and can never match
   * (returns 0). Ids are not checked for uniqueness: adding the same id twice makes two candidates.
   * Every added sequence is one candidate and counts once in `distinct` and towards `common`. Sequences are
   * taken to be separate pieces of code: if a function is added together with a function nested inside it, one
   * place in the source counts twice.
   */
  add(id, tokens, meta = {}) {
    const { n, codes, lines, texts } = this.coder.encode(tokens, true), d = this.docs.length, k = this.k;
    this.docs.push({ id, meta, n, codes, lines, texts });
    this.tokens += n;
    if (n > this.longest) this.longest = n;
    if (n < k) return 0;
    const hs = roll(codes, n, k, this.coder.hash), sel = fingerprints(codes, n, k, this.w, hs);
    for (const p of sel) {
      const list = this.postings.get(hs[p]);
      if (list) list.push(d, p); else this.postings.set(hs[p], [d, p]);
    }
    this.fingerprints += sel.length;
    return sel.length;
  }

  /**
   * query(tokens, { exclude = new Set(), minTokens = t, limit = Infinity, commonAt = this.commonAt })
   *   → [{ id, meta, tokens, coverage, repetitive, common, sameText,
   *        spans: [{ a: { start, end }, b: { start, end }, tokens, repetitive, common, sameText }] }]
   *     sorted by tokens descending (ties: order of add), with these properties on the array:
   *       distinct     candidates matched, before `limit` is applied
   *       queryTokens  normalised length of the query
   *       covered      query tokens that lie in a match with at least one candidate
   *       common       how many of the covered tokens are common (below)
   *       truncated    true when the work budget ran out: what is listed is verified, but more may exist
   *
   * exclude    ids to ignore (the function's own previous version, its enclosing function, …): a Set, any
   *            iterable of ids, or one id as a string. Excluded sequences match nothing and count nowhere.
   * minTokens  shortest match counted; values below k behave as k. Default: the guarantee threshold t.
   * commonAt   a query token is COMMON when at least this many candidates each share with the query a run of k
   *            tokens or more that contains it (every such run is compared token by token, like a span).
   *            `common` (per span, per candidate, on the array) is how many of the tokens counted there are
   *            common: code written the same way in that many places is house style, an idiom or a template,
   *            and tokens − common is what is left of a match once it is set aside. The count of candidates is
   *            exact for shared runs of t tokens or more and a lower bound below t (a shorter run is seen only
   *            when a fingerprint falls in it) and when `truncated`: `common` can understate, never overstate.
   *            `distinct` is NOT a substitute: a long function with ten unrelated clones in ten places has
   *            distinct = 10 and common = 0.
   * sameText   (per span, and per candidate over its listed spans) the share, 0 to 1, of the matched text that
   *            is literally the same: characters of the query tokens whose own text equals the aligned
   *            candidate token, over the characters of all query tokens of the span. 1 is a verbatim copy (a
   *            type-1 clone); lower means names or literals differ under the normalisation. It exists because a
   *            token is not a fixed amount of code: two tests that differ only in a 30-line string literal match
   *            in every token, and one token of that match is most of the function (measured on a real pair:
   *            49 of 49 tokens covered, sameText 0.21). It measures text, not meaning: a renamed variable lowers
   *            it and a changed `<` to `<=` cannot occur inside a span at all.
   * Per candidate: `tokens` is the number of query tokens covered by verified matches of at least minTokens
   * with that candidate (overlaps counted once), `coverage` is tokens / queryTokens, and each span is one
   * maximal match: `a` its line range in the query, `b` in the candidate, `tokens` its length. Lines are the
   * lines on which the first and the last token of the match START. `repetitive` (per span and per candidate)
   * is how many of those query tokens lie in a stretch of the query that is only a unit of at most k/2 tokens
   * repeated across at least k tokens: a list of literals matches any other list of literals, so
   * tokens − repetitive is the part of a match that carries information. When matches with one candidate
   * overlap in the query, only a covering subset is listed (the longest always is), and when the candidate
   * holds the same code more than once, one occurrence is; so the list can be shorter than the number of
   * matches. `tokens` and `coverage` are unaffected.
   *
   * Establishes: every listed span is identical in its normalised tokens on both sides (compared, not hashed),
   * and, when `truncated` is false, every shared run of at least max(minTokens, t) tokens with a non-excluded
   * candidate that is not a pure repetition is counted in that candidate's `tokens`; every token counted in
   * `common` lies in verified shared runs with at least commonAt candidates.
   * Does not establish: copying, semantic equality, anything about shorter runs that are not listed, or that a
   * token NOT counted as common is rare (below t the count of candidates is a lower bound).
   */
  query(tokens, { exclude = new Set(), minTokens = this.t, limit = Infinity, commonAt = this.commonAt } = {}) {
    // NaN would make every length comparison false and return "no clones" for any input: refuse it instead.
    if (typeof minTokens !== 'number' || Number.isNaN(minTokens)) throw new RangeError(`minTokens must be a number, got ${minTokens}`);
    posIntOrInf(commonAt, 'commonAt');
    const q = this.coder.encode(tokens, true), n = q.n, k = this.k, qc = q.codes;
    const out = [];
    out.distinct = 0; out.queryTokens = n; out.covered = 0; out.common = 0; out.truncated = false;
    if (n < k) return out;
    // A bare string is one id, not an iterable of its characters (which would silently exclude nothing).
    const min = Math.max(minTokens, k), skip = exclude instanceof Set ? exclude : new Set(typeof exclude === 'string' ? [exclude] : exclude);
    const hs = roll(qc, n, k, this.coder.hash), docs = this.docs, cands = [], cost = { work: 0 };
    const diag = new Map(), room = n + this.longest + 1; // one map for all candidates: key = candidate · room + diagonal
    if (this.slot.length < docs.length) this.slot = new Int32Array(docs.length + (docs.length >> 2));
    const slot = this.slot;
    try {
      scan: for (let i = 0; i < hs.length; i++) {
        const list = this.postings.get(hs[i]);
        if (!list) continue;
        cost.work += list.length >> 1;
        if (cost.work > this.maxWork) { out.truncated = true; break; }
        for (let j = 0; j < list.length; j += 2) {
          const d = list[j], doc = docs[d];
          let c;
          if (slot[d]) c = cands[slot[d] - 1];
          else { cands.push(c = { d, base: cands.length * room + doc.n, off: skip.size > 0 && skip.has(doc.id), spans: [], rest: null, best: null, kept: null, result: null }); slot[d] = cands.length; }
          if (c.off) continue;
          const p = list[j + 1], dc = doc.codes, best = c.best;
          if (best !== null && i >= best[0] && i + k <= best[1]) {
            // The seed lies inside the longest match found so far with this document, query range [a1, e1). If the
            // match through this seed reached past e1, the tokens at e1 on this diagonal would be equal, and likewise
            // just before a1. When both pairs differ (or do not exist) that match lies inside [a1, e1): it can add
            // no coverage, so it is not extended. (Blocks repeated on both sides produce many of these.)
            const r = best[1], l = best[0] - 1, pr = p + (r - i), pl = p - (i - l);
            if (!(r < n && pr < doc.n && qc[r] === dc[pr]) && !(l >= 0 && pl >= 0 && qc[l] === dc[pl])) continue;
          }
          const m = extend(qc, n, dc, doc.n, i, p, k, diag, c.base, cost);
          if (m) {
            if (m[1] - m[0] >= min) c.spans.push(m); else (c.rest ??= []).push(m); // too short to list, still an occurrence
            if (best === null || m[1] - m[0] > best[1] - best[0]) c.best = m;
          }
          if (cost.work > this.maxWork) { out.truncated = true; break scan; }
        }
      }
    } finally { for (const c of cands) slot[c.d] = 0; }
    const found = cands.filter((c) => c.spans.length);
    if (!found.length) return out;
    const sum = repetitiveSums(qc, n, k), com = commonSums(cands, n, commonAt), count = new Int32Array(n), any = new Uint8Array(n);
    for (const c of found) {
      const doc = this.docs[c.d], { kept, covered, repetitive, common } = cover(c.spans, 0, count, sum, any, com);
      kept.sort((x, y) => x[0] - y[0] || x[2] - y[2]);
      c.kept = kept;
      c.result = { id: doc.id, meta: doc.meta, tokens: covered, coverage: covered / n, repetitive, common, sameText: 1, spans: null };
    }
    found.sort((x, y) => y.result.tokens - x.result.tokens || x.d - y.d);
    out.distinct = found.length;
    for (let z = 0; z < n; z++) if (any[z]) { out.covered++; out.common += com[z + 1] - com[z]; }
    for (let j = 0; j < found.length && j < limit; j++) { // spans are spelled out only for the results that are returned
      const c = found[j], doc = this.docs[c.d];
      let same = 0, all = 0;
      c.result.spans = c.kept.map((s) => {
        const [sm, al] = sameText(q.texts, doc.texts, s[0], s[1], s[2]);
        same += sm; all += al;
        return { ...span(s, q.lines, doc.lines, sum, 0), common: com[s[1]] - com[s[0]], sameText: al ? sm / al : 1 };
      });
      if (all) c.result.sameText = same / all;
      out.push(c.result);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Two versions of one function, and one function against itself

/**
 * similarity(a, b, k = 5) → { jaccard, containmentA, containmentB, identical, sameShape, shared, sizeA, sizeB }
 * Resemblance and containment of Broder, "On the resemblance and containment of documents", Compression and
 * Complexity of Sequences 1997, computed exactly (no sampling) over the SETS of normalised k-shingles
 * (k consecutive normalised tokens) of two token arrays:
 *   jaccard = |A ∩ B| / |A ∪ B|     containmentA = |A ∩ B| / |A| (how much of a is in b)     containmentB likewise
 * sizeA, sizeB and shared are |A|, |B| and |A ∩ B|. A sequence shorter than k counts as one shingle, itself,
 * so two tiny functions still compare; an empty one has no shingles (two empty sequences: jaccard 1; the empty
 * set is contained in anything: containment 1).
 * sameShape is true exactly when the two normalised token SEQUENCES are equal: the two versions differ at most
 * in comments, layout, identifier names and literal values (a type-2 clone of the whole). It says nothing about
 * behaviour: `return a - b` and `return b - a` have the same shape, and so do a timeout of 10 and one of 1000.
 * identical is true exactly when the token texts themselves are equal, one by one (a type-1 clone of the whole):
 * the two versions differ at most in comments, whitespace and line breaks. That is as close to "the same code"
 * as tokens can say, and still not a proof of equal behaviour where a line break is syntax (JavaScript inserts
 * a semicolon after a `return` at the end of a line; the lexer does not keep line breaks).
 * identical implies sameShape; jaccard = 1 implies neither (sets ignore order and repetition).
 * Until this field was split, `identical` meant what sameShape means now, and a caller read it as "equivalent".
 */
export function similarity(a, b, k = 5) {
  posInt(k, 'k');
  const coder = new Coder(), A = coder.encode(a, true), B = coder.encode(b, true);
  const wide = coder.hash.length > 0xffff, sa = shingles(A, k, wide), sb = shingles(B, k, wide);
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  const union = sa.size + sb.size - shared;
  let sameShape = A.n === B.n;
  for (let i = 0; sameShape && i < A.n; i++) sameShape = A.codes[i] === B.codes[i];
  let identical = sameShape;
  for (let i = 0; identical && i < A.n; i++) identical = A.texts[i] === B.texts[i];
  return {
    jaccard: union ? shared / union : 1,
    containmentA: sa.size ? shared / sa.size : 1,
    containmentB: sb.size ? shared / sb.size : 1,
    identical, sameShape, shared, sizeA: sa.size, sizeB: sb.size,
  };
}

/** The set of k-shingles of an encoded sequence, each as an exact key (one UTF-16 unit per token code). */
function shingles({ n, codes }, k, wide) {
  const set = new Set();
  if (!n) return set;
  if (wide) { // more distinct token texts than a UTF-16 unit can name: spell the codes out
    if (n < k) set.add(codes.join(','));
    for (let i = 0; i + k <= n; i++) set.add(codes.subarray(i, i + k).join(','));
    return set;
  }
  let text = '';
  for (let i = 0; i < n; i += 8192) text += String.fromCharCode.apply(null, codes.subarray(i, Math.min(n, i + 8192)));
  if (n < k) set.add(text);
  for (let i = 0; i + k <= n; i++) set.add(text.substr(i, k));
  return set;
}

/**
 * duplicationWithin(tokens, { k, w, minTokens = w + k − 1, maxWork })
 *   → [{ a: { start, end }, b: { start, end }, tokens, repetitive }] sorted by tokens descending, with on the array:
 *       total       normalised length of the sequence
 *       duplicated  tokens that lie in a later copy of some earlier, disjoint range of at least minTokens, counted once
 *       coverage    duplicated / total (0 for an empty sequence)
 *       repetitive  how many of the duplicated tokens lie in a stretch that is only a short unit repeated
 *       truncated   true when the work budget ran out: what is listed is verified, but more may exist
 *
 * Self-clones: pairs of DISJOINT ranges of one token sequence, `a` before `b`, whose normalised tokens are
 * identical (compared, not hashed). Same guarantee and same exceptions as CloneIndex: every maximal such match
 * of at least t = w + k − 1 tokens that is not a pure repetition is found (the later copy holds a full window,
 * hence a fingerprint, and every k-gram is looked up). When a block is repeated back to back (A A A …) the run
 * matches itself one block later and that match overlaps itself: if the block has at least minTokens, the pair
 * listed is the first block against the second and every later copy counts in `duplicated`. Only a covering
 * subset of the pairs is listed (the longest always is).
 * Does not establish that the repetition is avoidable or a defect.
 */
export function duplicationWithin(tokens, opts = {}) {
  const k = posInt(opts.k ?? DEFAULTS.k, 'k'), w = posInt(opts.w ?? DEFAULTS.w, 'w');
  const min = Math.max(opts.minTokens ?? w + k - 1, k), maxWork = opts.maxWork ?? MAX_WORK;
  const coder = new Coder(), { n, codes, lines } = coder.encode(tokens);
  const out = [];
  out.total = n; out.duplicated = 0; out.coverage = 0; out.repetitive = 0; out.truncated = false;
  if (n < 2 * min) return out; // two disjoint ranges of min tokens do not fit
  const hs = roll(codes, n, k, coder.hash), at = new Map();
  for (const p of fingerprints(codes, n, k, w, hs)) { const list = at.get(hs[p]); if (list) list.push(p); else at.set(hs[p], [p]); }
  const diag = new Map(), pairs = [], later = [], cost = { work: 0 }; // pairs to list; ranges that are later copies
  scan: for (let i = 0; i < hs.length; i++) {
    const list = at.get(hs[i]);
    if (!list) continue;
    cost.work += list.length;
    if (cost.work > maxWork) { out.truncated = true; break; }
    for (const p of list) {
      if (p <= i) continue; // `a` is the earlier range; (p, i) is the same match seen from the other side
      const m = extend(codes, n, codes, n, i, p, k, diag, 0, cost);
      if (m) {
        // len > gap: the run overlaps its own copy, i.e. a block of `gap` tokens repeated back to back. A disjoint
        // pair inside it is at most one block long, so the block itself has to reach minTokens; then the first
        // block against the second is the pair to show, and everything from the second block on is a later copy.
        const gap = m[2] - m[0], len = m[1] - m[0];
        if (Math.min(len, gap) >= min) { pairs.push(len > gap ? [m[0], m[0] + gap, m[2]] : m); later.push([m[2], m[2] + len]); }
      }
      if (cost.work > maxWork) { out.truncated = true; break scan; }
    }
  }
  if (!pairs.length) return out;
  const sum = repetitiveSums(codes, n, k);
  later.sort((x, y) => x[0] - y[0]);
  let end = 0;
  for (const [from, to] of later) {
    const lo = Math.max(from, end);
    if (to > lo) { out.duplicated += to - lo; out.repetitive += sum[to] - sum[lo]; end = to; }
  }
  out.coverage = out.duplicated / n;
  for (const s of cover(pairs, 1, new Int32Array(n), sum, null).kept) out.push(span(s, lines, lines, sum, 1));
  return out;
}
