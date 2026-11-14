// The risk model: how the measurements of one changed function become a colour and a size.
//
//   size   = IMPACT      how much of the repository depends on this function (dependency graph), raised when
//                        the function sits in a domain where a silent bug is expensive (money, auth, data loss)
//   colour = CONFIDENCE  what the mathematics can say about the change itself:
//              proved     a proof that the edit cannot change behaviour (same tokens, or a renaming of locals)
//              cleared    NOT a proof: nothing was flagged, every measurement is under its threshold and the
//                         exposure is low. It only means there is no reason to look here first
//              uncertain  the mathematics cannot decide; this is what the agents and the person are for
//              risky      a deterministic check failed, or the likelihood is high
//   order  = exposure x impact, a review-order index in the spirit of risk exposure (Boehm 1991). It says
//            where to look first. It is not a probability.
//
// Exposure is a log-odds score: a prior plus a weight for each piece of evidence (weights of evidence,
// I. J. Good 1950; the same form as the logistic models of just-in-time defect prediction, Kamei et al. 2013).
// The weights are NOT fitted to this repository: there is no labelled history to fit them on. They encode the
// direction and rough strength reported in the literature (size of the change first: lines added alone ranks
// defect-inducing changes as well as richer models, Zeng et al. 2021), so what can be trusted is the ORDER of
// the nodes, never an absolute chance of a bug. The interface therefore shows bands (low, medium, high), not
// percentages. Signals such as surprise and duplication can only raise exposure; none of them reassures.
// The thresholds are policy, stated here in one place so they can be argued with.

export const POLICY = {
  prior: 0.10,          // starting point of the exposure score before any evidence (a convention, not a measured rate)
  cleared: 0.15,        // below this exposure, with nothing flagged, there is no reason to look here first
  risky: 0.6,           // at or above this exposure a node is red even with no failed check (large, complex and untested together)
  sensitiveFloor: { critical: 0.9, elevated: 0.6 }, // impact floors for domains where a miss is expensive
  exportedFloor: 0.3,   // a public symbol has callers outside the repository that the graph cannot see
};

/** Weights in nats of log-odds at full strength of each signal (x = 1). Positive raises the likelihood. */
export const WEIGHTS = {
  churn: 1.5,        // size of the change: lines added is the strongest single predictor (Kamei 2013; Zeng et al. 2021)
  complexity: 1.0,   // cyclomatic complexity of the new version (McCabe 1976)
  growth: 0.6,       // complexity added by this change
  surprise: 0.9,     // cross-entropy against the project's own code, in standard deviations (Ray et al. 2016)
  duplication: 0.7,  // share of the function that copies existing code (Juergens et al. 2009)
  history: 0.6,      // how often this file has needed fixes (Kamei 2013 NUC/FIX; Nagappan & Ball 2005)
  diffusion: 0.4,    // how scattered the pull request is (Hassan 2009 entropy)
  untested: 0.8,     // no test reaches it in the dependency graph (after Chianti's affected tests, Ren et al. 2004)
  tested: -0.4,      // tests written with the change reach it: same author, so weak evidence, but better than none
  literals: -1.2,    // only string literals changed (messages, labels)
  warn: 0.8,         // each failed practice check of warning level
  info: 0.2,         // each informational finding
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const pct = (x) => `${Math.round(x * 100)}%`;
export const band = (p) => (p >= POLICY.risky ? 'high' : p >= POLICY.cleared ? 'medium' : 'low');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(x|s|ch|sh)$/.test(w) ? 'es' : 's'}`;

/** Each signal as a value in [0, 1] with the sentence that explains it. Pure: same input, same output. */
export function signals(u, pr = {}) {
  const S = [];
  const add = (id, x, text) => { if (x > 0) S.push({ id, x: clamp01(x), w: WEIGHTS[id], text }); };
  const lines = (u.lines?.added || 0) + (u.lines?.removed || 0);
  add('churn', Math.log2(1 + lines) / Math.log2(1 + 120), `${plural(lines, 'line')} changed`);
  const m = u.metrics?.after, b = u.metrics?.before;
  if (m) {
    add('complexity', ramp(m.cyclomatic, 6, 25), `cyclomatic complexity ${m.cyclomatic}`);
    if (b && m.cyclomatic > b.cyclomatic) add('growth', ramp(m.cyclomatic - b.cyclomatic, 0, 8), `complexity grew ${b.cyclomatic} → ${m.cyclomatic}`);
  }
  if (u.entropy && Number.isFinite(u.entropy.z)) add('surprise', ramp(u.entropy.z, 0.5, 3), Number.isFinite(u.entropy.percentile) ? `more unusual than ${Math.round(u.entropy.percentile * 100)}% of this project's functions` : `${u.entropy.bits.toFixed(1)} bits per token, unusual for this project`);
  if (u.clones && u.clones.coverage > 0) add('duplication', u.clones.idiom ? 0 : ramp(u.clones.coverage, 0.15, 0.8), `${pct(u.clones.coverage)} duplicates existing code`);
  const h = u.history;
  if (h && !h.new && h.commits >= 3) add('history', clamp01(0.5 * ramp(h.fixRatio, 0.15, 0.6) + 0.5 * (h.commitsPct ?? 0)), `${plural(h.fixes, 'fix')} in ${plural(h.commits, 'earlier commit')} to this file`);
  if (pr.files > 1 && Number.isFinite(pr.entropy)) add('diffusion', pr.entropy * ramp(pr.files, 1, 12), `change spread over ${pr.files} files`);
  if (!u.isTest && u.kind !== 'type') {
    const t = u.tests || {};
    if (t.changed > 0) S.push({ id: 'tested', x: 1, w: WEIGHTS.tested, text: `${plural(t.changed, 'test')} written with this change ${t.changed === 1 ? 'reaches' : 'reach'} it` });
    else if (!(t.reachedBy > 0)) add('untested', 1, 'no test reaches it in the dependency graph');
  }
  if (u.change?.kind === 'literals' && u.change.onlyStrings) S.push({ id: 'literals', x: 1, w: WEIGHTS.literals, text: 'only string literals changed' });
  const warn = (u.findings || []).filter((f) => f.severity === 'warn').length, info = (u.findings || []).filter((f) => f.severity === 'info').length;
  if (warn) S.push({ id: 'warn', x: Math.min(warn, 3), w: WEIGHTS.warn, text: `${plural(warn, 'practice check')} failed` });
  if (info) S.push({ id: 'info', x: Math.min(info, 3), w: WEIGHTS.info, text: `${plural(info, 'note')}` });
  return S;
}

/** Exposure of a change: prior and evidence added in log-odds. An ordering score, not a calibrated probability. */
export function likelihood(u, pr) {
  const parts = signals(u, pr);
  const z = logit(POLICY.prior) + parts.reduce((s, p) => s + p.w * p.x, 0);
  return { p: sigmoid(z), logOdds: z, parts: parts.map((p) => ({ ...p, nats: p.w * p.x })).sort((a, b) => Math.abs(b.nats) - Math.abs(a.nats)) };
}

/** Impact of a defect here, in [0, 1]: rank among the repository's functions by what depends on it. */
export function impact(u) {
  const c = u.centrality || {};
  // The cube keeps the middle of the ranking small: the median function gets 0.13, the top 10% 0.73, the top 1% 0.97.
  const rank = Math.max(c.pagerankPct || 0, c.dependentsPct || 0, c.fanInPct || 0);
  let v = Math.pow(rank, 3), why = c.dependents > 0 ? `${plural(c.dependents, 'function')} depend on it (top ${pct(Math.max(0.01, 1 - rank))} of the repository)` : 'nothing else in the repository depends on it';
  if (u.isTest) return { v: 0.12, why: 'a test: it guards code, nothing depends on it', rank };
  if (u.exported && v < POLICY.exportedFloor) { v = POLICY.exportedFloor; if (!(c.dependents > 0)) why = 'public: callers outside this repository cannot be seen'; }
  const floor = POLICY.sensitiveFloor[u.sensitive?.level];
  if (floor && v < floor) { v = floor; why = `${u.sensitive.label}: a silent bug here is expensive${c.dependents > 0 ? `; ${plural(c.dependents, 'function')} depend on it` : ''}`; }
  return { v: clamp01(v), why, rank };
}

const TONE = { proved: 'ok', cleared: 'ok', uncertain: 'warn', risky: 'bad' };

/**
 * verdict(u, pr) → { verdict, claim, likelihood, impact, priority, evidence[], reasons[] }
 * `claim` is the one sentence the interface shows; it never says more than the level it belongs to.
 */
export function verdict(u, pr = {}) {
  const L = likelihood(u, pr), I = impact(u);
  const bad = (u.findings || []).filter((f) => f.severity === 'bad');
  // A threshold counts against THIS change only if the change is what crossed it: a function that was already
  // too complex and did not grow is context for the reviewer, not something the pull request did.
  const was = u.metrics?.before, now = u.metrics?.after;
  const rates = (u.rates || []).filter((r) => !was || !now || !(r.id in was) || now[r.id] > was[r.id]);
  const overBad = rates.filter((r) => r.tone === 'bad'), over = rates.filter((r) => r.tone !== 'ok');
  let v, claim;
  if (u.proof?.proved && !bad.length) { v = 'proved'; claim = u.proof.claim; }
  else if (bad.length) { v = 'risky'; claim = bad[0].detail || bad[0].title; }
  else if (u.status === 'removed') {
    v = u.stillUsed ? 'risky' : 'cleared';
    claim = u.stillUsed ? `Removed, but still called from ${plural(u.stillUsed, 'place')}.` : 'Removed, and nothing in the repository calls it any more.';
  }
  else if (L.p >= POLICY.risky || overBad.length) { v = 'risky'; claim = overBad.length && L.p < POLICY.risky ? `${overBad[0].label} ${overBad[0].value} is over the limit of ${overBad[0].bad}.` : `High exposure: ${L.parts.filter((p) => p.nats > 0).slice(0, 2).map((p) => p.text).join('; ')}.`; }
  else if (u.sensitive?.level === 'critical') { v = 'uncertain'; claim = `${u.sensitive.label}: a silent bug here is expensive, so a small change still gets a second look. Nothing was flagged.`; }
  else if (L.p < POLICY.cleared && !over.length && !(u.findings || []).some((f) => f.severity === 'warn')) { v = 'cleared'; claim = `Nothing flagged: ${L.parts.filter((p) => p.nats < 0).map((p) => p.text)[0] || 'a small, simple change'}; every measurement under its threshold. Not a proof.`; }
  else { v = 'uncertain'; claim = over.length ? `${over[0].label} ${over[0].value} is over ${over[0].warn}; behaviour changed and the mathematics cannot vouch for it.` : `Behaviour changed and the mathematics cannot vouch for it: ${L.parts.filter((p) => p.nats > 0).slice(0, 2).map((p) => p.text).join('; ') || 'not enough evidence'}.`; }
  return { verdict: v, tone: TONE[v], claim, likelihood: L.p, exposure: band(L.p), parts: L.parts, impact: I.v, impactWhy: I.why, rank: I.rank, priority: v === 'proved' ? 0 : L.p * I.v, evidence: evidence(u, L, I, v) };
}

/** The rows a person sees for a node: at most six, each a fact with its colour. */
export function evidence(u, L, I, v) {
  const rows = [];
  const row = (id, label, value, tone, detail) => rows.push({ id, label, value, tone, detail });
  if (u.proof?.proved) row('proof', 'Proof', u.proof.level === 'alpha' ? 'renaming only' : 'same tokens', 'ok', u.proof.claim);
  for (const f of (u.findings || []).filter((x) => x.severity !== 'info').slice(0, 2)) row('check:' + f.id, 'Check', f.title, f.severity === 'bad' ? 'bad' : 'warn', f.detail);
  const c = u.centrality || {};
  row('impact', 'Depends on it', c.dependents > 0 ? `${c.dependents} · top ${pct(Math.max(0.01, 1 - I.rank))}` : 'nothing', I.v >= 0.6 ? 'warn' : 'ok', I.why);
  if (v !== 'proved') {
    const lines = (u.lines?.added || 0) + (u.lines?.removed || 0), m = u.metrics?.after, b = u.metrics?.before;
    if (m) { const grew = (u.rates || []).filter((r) => !b || !(r.id in b) || m[r.id] > b[r.id]); row('change', 'Change', `${lines} lines · complexity ${b && b.cyclomatic !== m.cyclomatic ? `${b.cyclomatic} → ` : ''}${m.cyclomatic}`, grew.some((r) => r.tone === 'bad') ? 'bad' : grew.some((r) => r.tone === 'warn') || lines > 60 || m.cyclomatic > 20 ? 'warn' : 'ok', `Cyclomatic complexity: the number of independent paths through the function (McCabe 1976).${b && b.cyclomatic === m.cyclomatic && m.cyclomatic > 20 ? ' It was already this complex before the change.' : ''}`); }
    if (u.entropy && Number.isFinite(u.entropy.z)) row('surprise', 'Unusual', Number.isFinite(u.entropy.percentile) ? `${u.entropy.bits.toFixed(1)} bits · above ${Math.round(u.entropy.percentile * 100)}%` : `${u.entropy.bits.toFixed(1)} bits per token`, u.entropy.z >= 2 ? 'warn' : 'ok', 'How unusual these tokens are for this project: cross-entropy under an n-gram model of the repository, compared with its own functions (Hindle et al. 2012; Ray et al. 2016). Mostly new vocabulary. Unusual is not wrong, and usual is not right: this can only raise attention.');
    if (u.clones && u.clones.coverage >= 0.15 && !u.clones.idiom) row('dup', 'Duplicate', `${pct(u.clones.coverage)} · ${u.clones.where || 'elsewhere'}`, u.clones.coverage >= 0.5 ? 'bad' : 'warn', 'Token runs that also exist elsewhere (winnowing fingerprints, Schleimer et al. 2003).');
    if (!u.isTest && u.kind !== 'type') { const t = u.tests || {}; row('tests', 'Tests', t.changed ? `${t.changed} written with it` : t.reachedBy ? `${t.reachedBy} reach it` : 'none reach it', t.changed || t.reachedBy ? 'ok' : 'warn', 'Tests that can reach this function through the static dependency graph. Reaching is not asserting; a test written with the change shares its author; and a test that drives the code through a framework or reflection is not seen here.'); }
  }
  return rows.slice(0, 6);
}

/** The pull request as a whole: what share is settled by mathematics and where the rest is. */
export function summarize(units, pr = {}) {
  const by = { proved: 0, cleared: 0, uncertain: 0, risky: 0 }, lines = { proved: 0, cleared: 0, uncertain: 0, risky: 0, total: 0 };
  let none = 1, expected = 0, top = null;
  for (const u of units) {
    const n = (u.lines?.added || 0) + (u.lines?.removed || 0);
    by[u.verdict]++; lines[u.verdict] += n; lines.total += n;
    if (u.verdict !== 'proved') { none *= 1 - u.likelihood * u.impact; expected += u.likelihood * u.impact; }
    if (u.verdict !== 'proved' && u.verdict !== 'cleared' && (!top || u.priority > top.priority)) top = u;
  }
  const open = by.uncertain + by.risky, settled = lines.proved + lines.cleared;
  const score = 1 - none; // probability that at least one impactful defect is present, under independence
  const level = by.risky > 0 && score >= 0.5 ? 'high' : open === 0 ? 'low' : score >= 0.25 || by.risky > 0 ? 'medium' : 'low';
  return {
    nodes: by, lines, open, settledShare: lines.total ? settled / lines.total : 1,
    risk: { level, score, expected, note: 'A summary of exposure x impact over the open nodes, for comparing pull requests. Not a calibrated probability.' },
    first: top ? top.id : null, pr,
  };
}
