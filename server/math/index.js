// The mathematical pass over a pull request: no model, no execution, about a second.
// It reads both sides of the change straight from git, finds the functions the change touches, and for each
// one collects what can be established without running anything:
//   proofs        the edit cannot change behaviour (same tokens; renaming of locals)            proof.js
//   checks        facts that are true or false (imports resolve, arities match, tests kept)     checks.js
//   measurements  complexity, surprise against the project's own code, duplication, history,
//                 and what depends on it in the dependency graph       complexity/entropy/clones/history/graph.js
// risk.js turns that into a colour (what the mathematics can claim) and a size (what depends on it).
// Whatever stays amber or red is the part worth an agent's time and a person's attention.
import path from 'node:path';
import { DATA, readJSON, writeJSON, sha256 } from '../util.js';
import { git, diff as gitDiff, resolveRef } from '../git.js';
import { classifyFile, mechanicalGroups } from '../pipeline/classify.js';
import { langOf } from './lex.js';
import { parseFile, symbolAt, isTestPath } from './symbols.js';
import { loadSources, readFileAt, readBlobs } from './repo.js';
// Each measurement is its own module. One that fails to load must not take the others down: the pass then
// runs without it and says so in `limits`, instead of the whole graph disappearing.
const MISSING = [];
const part = async (file, fallback) => { try { return await import(file); } catch (e) { MISSING.push(`${file.slice(2, -3)}: ${String(e.message || e).split('\n')[0].slice(0, 120)}`); return fallback; } };
const { metrics, rate } = await part('./complexity.js', { metrics: () => null, rate: () => [] });
const { CloneIndex } = await part('./clones.js', { CloneIndex: null });
const { NgramModel, lexemes, baselineOf, surprise } = await part('./entropy.js', { NgramModel: null });
const { proveEquivalent, classifyChange, sameUsingSet } = await part('./proof.js', { proveEquivalent: () => null, classifyChange: () => ({ kind: 'logic' }), sameUsingSet: () => null });
const { buildGraph, centrality, forwardReach, neighbourhood } = await part('./graph.js', { buildGraph: null });
const { runChecks } = await part('./checks.js', { runChecks: () => [] });
const { fileHistoryStats, selectHistory, changeEntropy } = await part('./history.js', { fileHistoryStats: null, changeEntropy: (files) => ({ bits: 0, normalized: 0, files: files.length, dirs: 0, subsystems: 0 }) });
// The history of a base commit is the same for every branch cut from it: one `git log`, kept.
const HISTORY = new Map();
function historyOf(repo, base) {
  const k = `${repo}\0${base}`;
  if (!HISTORY.has(k)) { HISTORY.set(k, fileHistoryStats(repo, base).catch((e) => { HISTORY.delete(k); throw e; })); if (HISTORY.size > 8) HISTORY.delete(HISTORY.keys().next().value); }
  return HISTORY.get(k);
}
import { verdict, summarize, POLICY, WEIGHTS } from './risk.js';
import { lexicon, decide, merge } from './sensitivity.js';

export const VERSION = 3; // part of the cache key: raise it whenever a measurement or the model changes
const MAX_UNITS = 44, MAX_CONTEXT = 22;
// A call that can fail a test: assert/expect/should/verify/ensure/check families, and the Roslyn verifier runs (VerifyCS.Test.RunDefaultAsync).
// Things a function can do that no static graph can follow, per language. A changed function that does one of
// them gets a note: what it reaches cannot be established (reflection is where published call graphs miss edges).
const DYNAMIC_LOOKUP = /\b(eval\s*\(|new\s+Function\s*\(|Reflect\.|require\s*\(\s*[^'"`)\s]|import\s*\(\s*[^'"`)\s]|Type\.GetType\s*\(|Activator\.CreateInstance|\.GetMethod\s*\(|\.GetProperty\s*\(|\.Invoke\s*\(|MethodInfo\b|getattr\s*\(|setattr\s*\(|__import__\s*\(|importlib\.|Class\.forName\s*\()/;
// A line that exists to stop bad input or a broken state. Losing one is exactly what an approver must see.
const GUARD = /\b(throw\b|raise\b|assert\w*\s*[(.]|ArgumentNullException|ArgumentException|ArgumentOutOfRange|ThrowIf\w*\s*\(|invariant\s*\(|Guard\.|Debug\.Assert|Contract\.Requires|panic\s*\(|Objects\.requireNonNull)/;
// Files that decide how the same source text is compiled.
const BUILD_CONFIG = { cs: /(\.csproj|\.props|\.targets|(^|\/)Directory\.Build\.[a-z]+|(^|\/)global\.json)$/i, js: /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|babel\.config\.[cm]?js|\.babelrc(\.json)?|\.swcrc|webpack\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s)$/i };
const ASSERT = /^(assert|expect|should|verify|ensure|check|must|throws|rejects|is|ok|equal|deepequal|strictequal|tobe|toequal|rundefaultasync|runasync|verifyanalyzerasync|verifycodefixasync)/i;

/** The methods behind the colours, for the interface's legend and the report. */
export const METHODS = [
  { id: 'identical', level: 'proof', name: 'Token equality', basis: 'Comments and layout are not part of the program: equal token streams compile to the same program.' },
  { id: 'alpha', level: 'proof', name: 'Alpha-equivalence', basis: 'Renaming a bound variable consistently, without capture, preserves meaning (lambda calculus; Barendregt 1984).' },
  { id: 'checks', level: 'fact', name: 'Deterministic checks', basis: 'Imports resolve, call arities match, nothing removed is still called, no test was deleted or disabled.' },
  { id: 'graph', level: 'measure', name: 'Dependency graph', basis: 'Who uses whom, by name; rank by use relations (Inoue et al. 2003) and what can reach a function (after Chianti, Ren et al. 2004). Network measures on dependency graphs predict defect-prone code (Zimmermann & Nagappan 2008). An estimate: published call graphs miss 10 to 15% of targets (Feldthaus et al. 2013).' },
  { id: 'complexity', level: 'measure', name: 'Cyclomatic complexity', basis: 'Number of linearly independent paths through a function (McCabe 1976).' },
  { id: 'entropy', level: 'measure', name: 'Naturalness', basis: 'Cross-entropy under an n-gram model of this repository; buggy lines are on average more surprising (Hindle et al. 2012; Ray et al. 2016).' },
  { id: 'clones', level: 'measure', name: 'Duplication', basis: 'Winnowing fingerprints guarantee every shared run above a length is found (Schleimer, Wilkerson & Aiken 2003).' },
  { id: 'history', level: 'measure', name: 'Change history', basis: 'Size, spread and past fixes of a change predict defects (Kamei et al. 2013; Hassan 2009).' },
  { id: 'risk', level: 'policy', name: 'Risk = likelihood × impact', basis: 'Evidence added in log-odds (Good 1950); weights from the literature, not fitted to this repository.' },
];

// Parsed files are shared between analyses: most blobs are the same on both sides of a change and between branches.
const PARSED = new Map();
function parsed(f) {
  const k = `${f.sha}:${f.path}`; let p = PARSED.get(k);
  if (!p) { p = parseFile(f.text, f.path, f.lang); p.text = f.text; p.sha = f.sha; PARSED.set(k, p); if (PARSED.size > 30_000) PARSED.delete(PARSED.keys().next().value); }
  return p;
}
const BASES = new Map(); // per merge base and language set: language model, baseline, clone index
const RESULTS = new Map();

const linesOf = (text, a, b) => text.split('\n').slice(a - 1, b).join('\n');
const short = (s) => s.name.length > 28 ? s.name.slice(0, 27) + '…' : s.name;
const timed = async (stages, name, fn) => { const t = performance.now(); try { return await fn(); } finally { stages[name] = Math.round(performance.now() - t); } };

async function baseModels(key, baseFiles, stages) {
  let m = BASES.get(key);
  if (m) return m;
  m = { model: null, baseline: null, clones: null };
  if (NgramModel) await timed(stages, 'entropy', () => {
    const model = new NgramModel({ n: 3 }), files = [];
    for (const f of baseFiles.values()) {
      const lex = lexemes(f.tokens); model.add(lex);
      // Function ranges in lexeme coordinates: lexemes() drops only 'nl' tokens, and the engine never emits them here.
      files.push({ lex, ranges: f.symbols.filter((s) => s.kind !== 'type' && s.bodyB - s.bodyA >= 12).map((s) => [s.a, s.b]) });
    }
    m.model = model; m.baseline = baselineOf(model, files, { max: 500 });
  }).catch(() => {});
  if (CloneIndex) await timed(stages, 'clones', () => {
    const ix = new CloneIndex();
    for (const f of baseFiles.values()) for (const s of f.symbols) if (s.kind !== 'type' && s.bodyB - s.bodyA >= 40) ix.add(s.id, f.tokens.slice(s.bodyA, s.bodyB), { file: f.path, name: s.qname, start: s.start, test: s.isTest });
    m.clones = ix;
  }).catch(() => {});
  BASES.set(key, m); if (BASES.size > 6) BASES.delete(BASES.keys().next().value);
  return m;
}

/** Lines of a hunk list, as sets of new-side and old-side line numbers. */
function changedLines(f) {
  const added = new Set(), removed = new Set();
  for (const h of f.hunks) { for (let i = 0; i < h.added.length; i++) added.add(h.newStart + i); for (let i = 0; i < h.removed.length; i++) removed.add(h.oldStart + i); }
  return { added, removed };
}
/** Tokens of a file that are outside every function body: imports, fields, signatures, type headers. */
function skeleton(f) {
  const inBody = new Uint8Array(f.tokens.length);
  for (const s of f.symbols) if (s.kind !== 'type') for (let i = s.bodyA; i < s.bodyB; i++) inBody[i] = 1;
  let out = '', line = -1;
  for (let i = 0; i < f.tokens.length; i++) if (!inBody[i]) { const t = f.tokens[i]; out += (t.l !== line ? '\n' : ' ') + t.v; line = t.l; }
  return out;
}
const assertions = (tokens) => { let n = 0; for (let i = 0; i < tokens.length - 1; i++) if ((tokens[i].k === 'id' || tokens[i].k === 'kw') && ASSERT.test(tokens[i].v) && (tokens[i + 1].v === '(' || tokens[i + 1].v === '.' || tokens[i + 1].v === '<')) n++; return n; };

/**
 * analyze(project, pr) → { head, base, ms, summary, nodes, edges, methods, stages, limits }
 * Read-only and deterministic for a given pair of commits; cached in memory and on disk by those commits.
 */
export async function analyze(project, pr, { force = false, decisions = true } = {}) {
  const repo = project.path, t0 = performance.now();
  const baseRef = await resolveRef(repo, project.base);
  const head = (await git(repo, ['rev-parse', '--verify', `${pr.ref}^{commit}`])).stdout.trim();
  const mb = (await git(repo, ['merge-base', baseRef, head], { allowFail: true })).stdout.trim() || (await git(repo, ['rev-parse', baseRef])).stdout.trim();
  const key = sha256(`${VERSION}:${mb}:${head}`).slice(0, 20), file = path.join(DATA, 'math', project.id, `${key}.json`);
  if (!force) {
    const hit = RESULTS.get(key) || readJSON(file, null);
    if (hit && hit.version === VERSION && !hit.partial) { RESULTS.set(key, hit); return { ...hit, cached: true }; }
  }
  const stages = {}, limits = MISSING.map((m) => `A measurement is unavailable (${m}).`);
  const guard = (name, fn, fallback = null) => { const t = performance.now(); try { return fn(); } catch (e) { limits.push(`${name} could not run: ${String(e.message || e).slice(0, 120)}`); return fallback; } finally { stages[name] = (stages[name] || 0) + Math.round(performance.now() - t); } };

  const diffFiles = await timed(stages, 'diff', () => gitDiff(repo, mb, head));
  const allPaths = new Set(diffFiles.map((f) => f.path));
  const kindOf = (p) => classifyFile(p, allPaths).kind;
  const code = diffFiles.filter((f) => !f.binary && langOf(f.path) && ['source', 'test'].includes(kindOf(f.path)));
  const langs = new Set(code.map((f) => langOf(f.path))); if (langs.has('js')) langs.add('ts'); if (langs.has('ts')) langs.add('js');

  // Both sides of the change, from git objects. Unchanged blobs are parsed once.
  const [hs, bs] = langs.size ? await timed(stages, 'read', () => Promise.all([loadSources(repo, head, { only: langs }), loadSources(repo, mb, { only: langs })])) : [{ files: [], tree: [] }, { files: [], tree: [] }];
  if (hs.truncated) limits.push('Very large repository: only part of it was read, so dependency counts are lower bounds.');
  const headFiles = new Map(), baseFiles = new Map();
  await timed(stages, 'parse', () => { for (const f of hs.files) headFiles.set(f.path, parsed(f)); for (const f of bs.files) baseFiles.set(f.path, parsed(f)); });

  const manifests = langs.size ? await timed(stages, 'manifests', () => manifestsOf(repo, hs.tree)).catch(() => ({})) : {};
  const graph = buildGraph ? guard('graph', () => buildGraph([...headFiles.values()])) : null;
  const models = await baseModels(`${mb}:${[...langs].sort().join(',')}`, baseFiles, stages);
  const hist = fileHistoryStats ? await timed(stages, 'history', async () => selectHistory(await historyOf(repo, mb), code.map((f) => (f.status === 'renamed' && f.oldPath ? { path: f.path, oldPath: f.oldPath } : f.path)))).catch((e) => { limits.push(`history could not run: ${e.message.slice(0, 100)}`); return new Map(); }) : new Map();
  const spread = guard('spread', () => changeEntropy(diffFiles.filter((f) => !f.binary && kindOf(f.path) !== 'derived').map((f) => ({ path: f.path, add: f.add, del: f.del }))), { bits: 0, normalized: 0, files: diffFiles.length, dirs: 0, subsystems: 0 });
  // How often this file changes, against every file of the repository that has history (not against the pull request's own files).
  const histAll = fileHistoryStats ? await historyOf(repo, mb).then((all) => [...all.values()].map((h) => h.commits).filter((n) => n > 0).sort((a, b) => a - b)).catch(() => []) : [];

  // ── Units: every function the change touches, on either side ─────────────────────────────────────────
  const units = [], unitBySymbol = new Map();
  for (const f of code) {
    const H = f.status === 'deleted' ? null : headFiles.get(f.path), B = f.status === 'added' ? null : baseFiles.get(f.status === 'renamed' && f.oldPath ? f.oldPath : f.path);
    const { added, removed } = changedLines(f), lang = langOf(f.path), isTestFile = kindOf(f.path) === 'test' || isTestPath(f.path);
    const baseByKey = new Map((B?.symbols || []).map((s) => [s.key, s]));
    const touched = new Map(); // head symbol → { head, base, added, removed }
    const loose = { added: 0, removed: 0 };
    const slot = (hsym, bsym) => { const k = hsym || bsym; if (!touched.has(k)) touched.set(k, { head: hsym, base: bsym, added: 0, removed: 0 }); return touched.get(k); };
    if (H) for (const l of added) { const s = symbolAt(H, l); if (s && s.kind !== 'type') slot(s, baseByKey.get(s.key)).added++; else loose.added++; }
    if (B) for (const l of removed) {
      const s = symbolAt(B, l);
      if (!s || s.kind === 'type') { loose.removed++; continue; }
      const now = H?.symbols.find((x) => x.key === s.key);
      if (now) slot(now, s).removed++; else slot(null, s).removed++;
    }
    for (const t of touched.values()) {
      const s = t.head || t.base, src = t.head ? H : B;
      const u = {
        id: s.id, name: short(s), qname: s.qname, kind: s.kind, file: f.path, lang, start: s.start, end: s.end,
        status: !t.head ? 'removed' : t.base ? 'modified' : 'added', isTest: s.isTest || (isTestFile && s.kind !== 'type'), helper: !s.isTest && isTestFile, exported: s.exported,
        lines: { added: t.added, removed: t.removed }, findings: [], _h: t.head, _b: t.base, _H: H, _B: B,
      };
      const headText = t.head ? linesOf(H.text, t.head.start, t.head.end) : '', baseText = t.base ? linesOf(B.text, t.base.start, t.base.end) : '';
      if (t.head && t.base) {
        u.proof = guard('proofs', () => proveEquivalent(baseText, headText, lang));
        u.change = u.proof?.proved ? { kind: u.proof.level } : guard('proofs', () => classifyChange(baseText, headText, lang), { kind: 'logic' });
      } else u.change = { kind: 'logic' };
      if (t.head) {
        const after = guard('metrics', () => metrics(H.tokens.slice(t.head.a, t.head.b), lang)), before = t.base ? guard('metrics', () => metrics(B.tokens.slice(t.base.a, t.base.b), lang)) : null;
        if (after) { u.metrics = { after, before }; u.rates = guard('metrics', () => rate(after, t.head.params), []); }
        if (u.isTest) { // a test may delegate its checks to a helper in the same file: follow its calls two levels down
          const seen = new Set([t.head.key]); let n = 0, frontier = [t.head];
          for (let depth = 0; depth < 3 && frontier.length; depth++) {
            const next = [];
            for (const sym of frontier) {
              const body = H.tokens.slice(sym.bodyA, sym.bodyB); n += assertions(body);
              for (let i = 0; i < body.length - 1; i++) if (body[i].k === 'id' && body[i + 1].v === '(') for (const callee of H.symbols) if (callee.name === body[i].v && callee.kind !== 'type' && !seen.has(callee.key)) { seen.add(callee.key); next.push(callee); }
            }
            frontier = next;
          }
          u.assertions = n;
        }
      }
      const mine = f.hunks.filter((h) => (t.head && h.newStart <= t.head.end && h.newStart + Math.max(h.newLines, 1) - 1 >= t.head.start) || (t.base && h.oldStart <= t.base.end && h.oldStart + Math.max(h.oldLines, 1) - 1 >= t.base.start));
      const addedText = mine.flatMap((h) => h.added), removedText = mine.flatMap((h) => h.removed);
      u.excerpt = addedText.join('\n').slice(0, 400);
      if (!u.isTest && t.head) {
        const lost = removedText.filter((l) => GUARD.test(l)).length - addedText.filter((l) => GUARD.test(l)).length;
        if (t.base && lost > 0) u.findings.push({ id: 'guard-removed', severity: 'warn', title: lost === 1 ? 'A guard was removed' : `${lost} guards were removed`, detail: `${lost === 1 ? 'A line that threw or asserted was' : `${lost} lines that threw or asserted were`} removed from this function and not replaced.`, line: t.head.start, basis: 'Counted on the removed and added lines of the diff.' });
        if (addedText.some((l) => DYNAMIC_LOOKUP.test(l))) u.findings.push({ id: 'dynamic-lookup', severity: 'info', title: 'Dynamic lookup', detail: 'The added code looks something up at run time (reflection, eval or a computed import): what it reaches cannot be seen in the dependency graph.', line: t.head.start, basis: 'Matched on the added lines.' });
        if (t.base && s.exported && s.kind !== 'property') {
          const sigOf = (F, sym) => F.tokens.slice(sym.a, sym.bodyA > sym.a ? sym.bodyA : sym.b).filter((x) => x.k !== 'nl').map((x) => x.v).join(' ');
          if (sigOf(H, t.head) !== sigOf(B, t.base)) u.findings.push({ id: 'signature-changed', severity: 'warn', title: 'Public signature changed', detail: `The signature of ${s.qname} changed and it is public: callers outside this repository cannot be seen.`, line: t.head.start, basis: 'Token comparison of the declaration before and after.' });
        }
      }
      units.push(u); unitBySymbol.set(s.id, u);
    }
    // What changed outside every function: imports, fields, signatures of types.
    if ((loose.added || loose.removed) && H && B) {
      const a = skeleton(B), b = skeleton(H);
      if (a !== b) {
        const u = { id: `${f.path}::(declarations)`, name: 'declarations', qname: `${path.basename(f.path)} · declarations`, kind: 'type', file: f.path, lang, start: 1, end: 1, status: 'modified', isTest: isTestFile, helper: isTestFile, exported: false, lines: loose, findings: [], declarations: true };
        u.proof = lang === 'cs' ? guard('proofs', () => { const r = sameUsingSet(B.text, H.text); return r?.proved ? { ...r, level: 'identical' } : null; }) : null;
        if (!u.proof) u.proof = guard('proofs', () => proveEquivalent(a, b, lang, { alpha: false })); // a skeleton is not a function: only token equality applies
        u.change = u.proof?.proved ? { kind: 'identical' } : guard('proofs', () => classifyChange(a, b, lang), { kind: 'logic' });
        units.push(u);
      }
    } else if ((loose.added || loose.removed) && H && !B && !touched.size) {
      units.push({ id: `${f.path}::(declarations)`, name: 'declarations', qname: `${path.basename(f.path)} · declarations`, kind: 'type', file: f.path, lang, start: 1, end: 1, status: 'added', isTest: isTestFile, helper: isTestFile, exported: false, lines: loose, findings: [], declarations: true, change: { kind: 'logic' } });
    }
  }
  // A function removed in one place and added, token for token, in another was moved, not changed.
  guard('proofs', () => {
    const gone = units.filter((u) => u.status === 'removed' && u._b), sig = (F, s) => F.tokens.slice(s.a, s.b).map((t) => t.v).join('\u0001');
    const bySig = new Map(gone.map((u) => [sig(u._B, u._b), u]));
    for (const u of units) if (u.status === 'added' && u._h && u._h.bodyB - u._h.bodyA > 6) {
      const from = bySig.get(sig(u._H, u._h)); if (!from || from.moved) continue;
      from.moved = true; u.status = 'modified'; u.lines.removed += from.lines.removed;
      u.proof = { proved: true, level: 'identical', claim: `Same tokens as the function removed from ${path.basename(from.file)}: moved, not changed.` }; u.change = { kind: 'identical' };
    }
  });
  // A proof that the text is the same program holds for one way of compiling it. If this pull request also
  // changes how the code is compiled, the proof is withdrawn wherever that could matter.
  const buildChanged = (re) => diffFiles.filter((f) => re.test(f.path)).map((f) => path.basename(f.path));
  const csBuild = buildChanged(BUILD_CONFIG.cs), jsBuild = buildChanged(BUILD_CONFIG.js);
  for (const u of units) {
    if (!u.proof?.proved) continue;
    const why = u.lang === 'cs' && csBuild.length && u._H?.tokens.some((t) => t.k === 'pp') ? csBuild : (u.lang === 'js' || u.lang === 'ts') && jsBuild.length ? jsBuild : null;
    if (!why) continue;
    u.proof = null; u.change = { kind: 'logic' };
    u.findings.push({ id: 'proof-withdrawn', severity: 'warn', title: 'Proof withdrawn', detail: `The text of this function did not change in a way that matters, but ${why.slice(0, 2).join(' and ')} did: the same text may now compile differently${u.lang === 'cs' ? ' (this file has preprocessor conditions)' : ''}.`, line: u.start, basis: 'A token-equality proof assumes the same build configuration.' });
  }
  if (csBuild.length || jsBuild.length) limits.push(`This pull request changes build configuration (${[...csBuild, ...jsBuild].slice(0, 3).join(', ')}): its effect on the program is not modelled.`);
  const live = units.filter((u) => !u.moved);

  // ── Facts and measurements per unit ─────────────────────────────────────────────────────────────────
  const cent = graph ? guard('graph', () => centrality(graph, { exactFor: new Set(live.map((u) => u.id)) })) : null;
  const changedTests = live.filter((u) => u.isTest && u.status !== 'removed' && graph?.nodes.has(u.id));
  const reachOfTest = new Map();
  if (graph) guard('graph', () => { for (const t of changedTests) reachOfTest.set(t.id, forwardReach(graph, t.id)); });
  const findings = guard('checks', () => {
    const r = runChecks({ head: headFiles, base: baseFiles, diff: diffFiles, tree: new Set(hs.tree.map((f) => f.path)), manifests, graph });
    return Array.isArray(r) ? r : r?.findings || [];
  }, []);
  for (const f of findings) {
    let u = (f.symbol && unitBySymbol.get(f.symbol)) || live.find((x) => x.file === f.file && x.declarations) || null;
    if (!u && f.symbol && graph?.nodes.has(f.symbol)) { // a consequence in code the pull request did not touch
      const s = graph.nodes.get(f.symbol);
      u = { id: s.id, name: short(s), qname: s.qname, kind: s.kind, file: s.file, lang: langOf(s.file), start: s.start, end: s.end, status: 'affected', isTest: s.isTest, exported: s.exported, lines: { added: 0, removed: 0 }, findings: [], change: { kind: 'logic' } };
      units.push(u); live.push(u); unitBySymbol.set(s.id, u);
    }
    if (!u) u = live.find((x) => x.file === f.file) || null;
    if (u) u.findings.push({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, line: f.line, basis: f.basis });
  }
  for (const u of live) {
    const H = u._H, s = u._h;
    if (s && H && models.model && models.baseline && !u.proof?.proved) guard('entropy', () => {
      const lex = lexemes(H.tokens);
      const score = () => {
        if (u.status === 'added') { const r = models.model.crossEntropy(lex, { from: s.a, to: s.b }); return { bits: r.total, n: r.tokens, whole: true }; }
        // Only the tokens on lines this pull request added, each with its real left context.
        const f = code.find((x) => x.path === u.file), set = changedLines(f).added; let bits = 0, n = 0;
        let i = s.a; while (i < s.b) { if (!set.has(H.tokens[i].l)) { i++; continue; } let j = i; while (j < s.b && set.has(H.tokens[j].l)) j++; const r = models.model.crossEntropy(lex, { from: i, to: j }); bits += r.total; n += r.tokens; i = j; }
        return { bits, n, whole: false };
      };
      // The model was trained on the base, which holds the old version of this very file: score with it held out,
      // or the function would look more usual than it is to a project that has never seen it.
      const B = u._B, held = B && typeof models.model.heldOut === 'function';
      const r = held ? models.model.heldOut(lexemes(B.tokens), score) : score();
      if (r.n >= 12) {
        const b = r.bits / r.n;
        // A handful of added lines is compared with fragments of that length, not with whole functions (short samples spread more).
        const sp = r.whole ? surprise(b, models.baseline) : surprise(b, models.baseline, { tokens: r.n });
        if (sp && Number.isFinite(sp.z)) u.entropy = { bits: b, tokens: r.n, z: sp.z, percentile: sp.percentile, window: sp.window ?? null };
      }
    });
    if (s && H && models.clones && !u.proof?.proved && s.bodyB - s.bodyA >= 40) guard('clones', () => {
      const q = (F, sym) => models.clones.query(F.tokens.slice(sym.bodyA, sym.bodyB), { exclude: new Set([u._b?.id, s.id].filter(Boolean)) });
      const now = q(H, s), was = u._b ? q(u._B, u._b) : [];
      const top = now.find((m) => !m.meta?.test || u.isTest);
      if (!top) return;
      const before = was.find((m) => m.id === top.id)?.coverage || 0; // only what this pull request introduced
      const coverage = Math.max(0, top.coverage - before);
      if (coverage > 0) u.clones = { coverage, tokens: top.tokens, where: `${path.basename(top.meta.file)}:${top.spans?.[0]?.b?.start ?? top.meta.start}`, name: top.meta.name, idiom: (now.distinct ?? now.length) > 8 };
    });
    const c = cent?.get(u.id);
    if (c) { u.centrality = c; u.tests = { reachedBy: c.testedBy || 0, changed: changedTests.filter((t) => t.id !== u.id && reachOfTest.get(t.id)?.has(u.id)).length }; }
    else if (u._b && graph) u.centrality = { fanIn: 0, fanOut: 0, dependents: 0, testedBy: 0, pagerankPct: 0, dependentsPct: 0, fanInPct: 0 };
    const h = hist.get(u.file);
    if (h) u.history = { ...h, commitsPct: histAll.length ? histAll.filter((x) => x <= h.commits).length / histAll.length : 0 };
    if (u.status === 'removed') u.stillUsed = u.findings.filter((x) => /dangling|still/i.test(x.id + x.title)).length;
    u.sensitive = lexicon({ name: u.qname, container: '', file: u.file, text: u.excerpt || '' });
  }
  // The decision model may raise the stakes of a node (never lower them, never touch its colour).
  let routing = { status: 'skipped', model: 'gemini-decision-1', reason: 'not asked' };
  if (decisions) {
    const ask = live.filter((u) => !u.proof?.proved && !u.isTest && u.status !== 'removed' && u.excerpt).sort((a, b) => (b.lines.added + b.lines.removed) - (a.lines.added + a.lines.removed)).slice(0, 16);
    routing = await timed(stages, 'decisions', () => decide(ask.map((u) => ({ id: u.id, name: u.qname, file: u.file, excerpt: u.excerpt.slice(0, 300) }))));
    routing.adopted = [];
    for (const u of ask) { const m = merge(u.sensitive, routing.answers[u.id]); if (m.source === 'decision') routing.adopted.push(u.id); u.sensitive = m; }
  }

  const prStats = { files: spread.files, entropy: spread.normalized, bits: spread.bits, dirs: spread.dirs, subsystems: spread.subsystems, linesAdded: diffFiles.reduce((n, f) => n + f.add, 0), linesDeleted: diffFiles.reduce((n, f) => n + f.del, 0) };
  for (const u of live) {
    if (u.isTest && u.status !== 'removed' && !u.proof?.proved) { // a test is evidence, not product code: what matters is that it asserts something
      const bad = u.findings.filter((f) => f.severity === 'bad'), warn = u.findings.filter((f) => f.severity === 'warn');
      const v = bad.length ? 'risky' : warn.length || (!u.assertions && !u.helper) ? 'uncertain' : 'cleared';
      Object.assign(u, { verdict: v, tone: { risky: 'bad', uncertain: 'warn', cleared: 'ok' }[v], likelihood: v === 'cleared' ? 0.05 : v === 'risky' ? 0.7 : 0.3, impact: 0.12, impactWhy: 'a test: it guards code, nothing depends on it', rank: 0, parts: [],
        claim: bad.length ? bad[0].detail : warn.length ? warn[0].detail : u.helper ? 'Support code of the tests: it runs only under test, nothing shipped depends on it.' : u.assertions ? `A test with ${u.assertions} ${u.assertions === 1 ? 'check' : 'checks'} that can fail. It is evidence about other code, not product code.` : 'A test with no call that can fail it proves nothing.',
        evidence: [...[...bad, ...warn].slice(0, 2).map((f) => ({ id: 'check:' + f.id, label: 'Check', value: f.title, tone: f.severity === 'bad' ? 'bad' : 'warn', detail: f.detail })), ...(u.helper ? [] : [{ id: 'assert', label: 'Checks', value: String(u.assertions || 0), tone: u.assertions ? 'ok' : 'bad', detail: 'Calls that can fail the test (assert, expect, verify…).' }]), { id: 'change', label: 'Change', value: `${u.lines.added + u.lines.removed} lines`, tone: 'ok', detail: '' }] });
      u.priority = u.likelihood * u.impact;
    } else Object.assign(u, verdict(u, prStats));
  }

  // ── Files that are not code ──────────────────────────────────────────────────────────────────────────
  const extra = [];
  const group = (id, name, kind, files, v, claim, detail) => extra.push({ id, name, qname: name, kind, file: files[0].path, files: files.map((f) => f.path), start: 0, end: 0, status: 'modified', verdict: v, tone: { proved: 'ok', cleared: 'ok', uncertain: 'warn', risky: 'bad' }[v], claim, likelihood: v === 'proved' ? 0 : v === 'cleared' ? 0.05 : 0.3, impact: 0.1, impactWhy: detail, priority: v === 'uncertain' ? 0.03 : 0, lines: { added: files.reduce((n, f) => n + f.add, 0), removed: files.reduce((n, f) => n + f.del, 0) }, evidence: [{ id: 'kind', label: 'Kind', value: detail, tone: v === 'uncertain' ? 'warn' : 'ok', detail: claim }], findings: [], parts: [] });
  const docs = diffFiles.filter((f) => kindOf(f.path) === 'doc');
  if (docs.length) group('doc', docs.length === 1 ? path.basename(docs[0].path) : `${docs.length} docs`, 'doc', docs, 'proved', 'Documentation is not compiled: it cannot change what the program does.', 'documentation');
  const groups = guard('generated', () => mechanicalGroups(diffFiles), []) || [];
  const grouped = new Set();
  for (const g of groups) {
    const fs = diffFiles.filter((f) => kindOf(f.path) === 'derived' && (f.path.startsWith(g.dir + '/') || path.dirname(f.path) === g.dir));
    fs.forEach((f) => grouped.add(f.path));
    // The files that received exactly the repeated edit are settled together; the ones that deviate are what a person looks at.
    const oddPaths = new Set(g.anomalies.map((a) => a.path)), same = fs.filter((f) => !oddPaths.has(f.path)), odd = fs.filter((f) => oddPaths.has(f.path));
    if (same.length) group(`gen:${g.dir}`, `${same.length} generated`, 'generated', same, 'cleared', `${same.length} generated files received exactly the same ${g.pattern.length}-line edit and nothing else. Not a proof that the generator is right.`, 'generated files');
    if (odd.length) group(`gen:odd:${g.dir}`, odd.length === 1 ? short({ name: path.basename(odd[0].path) }) : `${odd.length} generated differ`, 'generated', odd, 'uncertain', `${odd.length === 1 ? 'This generated file changes' : `${odd.length} generated files change`} more than the edit repeated in the other ${same.length}: ${g.anomalies.slice(0, 2).map((a) => `${path.basename(a.path)} (+${a.added.length} −${a.removed.length} extra)`).join(', ')}.`, 'generated, deviates');
  }
  const loneGen = diffFiles.filter((f) => kindOf(f.path) === 'derived' && !grouped.has(f.path));
  if (loneGen.length) group('gen', loneGen.length === 1 ? path.basename(loneGen[0].path) : `${loneGen.length} generated`, 'generated', loneGen, 'uncertain', 'Generated from another file: regenerate it to confirm it matches its source.', 'generated file');
  const config = diffFiles.filter((f) => kindOf(f.path) === 'config' || (!langOf(f.path) && !['doc', 'derived', 'config'].includes(kindOf(f.path))) || f.binary);
  for (const f of config.slice(0, 3)) group(`cfg:${f.path}`, path.basename(f.path), 'config', [f], 'uncertain', 'A build or configuration file: its effect on the program is not modelled.', f.binary ? 'binary file' : 'configuration');
  if (config.length > 3) group('cfg', `${config.length - 3} more config`, 'config', config.slice(3), 'uncertain', 'Build or configuration files: their effect on the program is not modelled.', 'configuration');

  // ── What is drawn: the changed functions, and the neighbours that explain why they matter ───────────
  const order = [...live].sort((a, b) => ({ risky: 0, uncertain: 1, cleared: 2, proved: 3 }[a.verdict] - { risky: 0, uncertain: 1, cleared: 2, proved: 3 }[b.verdict]) || b.priority - a.priority || b.impact - a.impact);
  const shown = order.slice(0, MAX_UNITS), hidden = order.slice(MAX_UNITS);
  if (hidden.length) limits.push(`${hidden.length} more changed ${hidden.length === 1 ? 'function is' : 'functions are'} not drawn (${hidden.filter((u) => u.verdict === 'proved' || u.verdict === 'cleared').length} settled); ${hidden.length === 1 ? 'it is' : 'they are'} counted in the totals.`);
  const ids = new Set(shown.map((u) => u.id));
  let ctxIds = [], edges = [];
  if (graph) guard('graph', () => {
    const score = new Map(); if (cent) for (const [id, c] of cent) score.set(id, c.pagerank || 0);
    const nb = neighbourhood(graph, shown.filter((u) => graph.nodes.has(u.id)).map((u) => u.id), { depth: 1, max: MAX_CONTEXT, score });
    ctxIds = nb.nodes.filter((id) => !ids.has(id) && graph.nodes.get(id)?.kind !== 'type');
    const keep = new Set([...ids, ...ctxIds]);
    edges = nb.edges.filter(([a, b]) => keep.has(a) && keep.has(b) && a !== b).map(([a, b]) => ({ from: a, to: b, kind: graph.nodes.get(a)?.isTest ? 'tests' : 'calls' }));
  });
  // Tests are evidence, not the thing under review: many settled tests of one file are drawn as one node.
  const fold = (list, isCtx) => {
    const byFile = new Map();
    for (const x of list) { const k = x.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(x); }
    const out = new Map(); // member id → group id
    for (const [f, xs] of byFile) if (xs.length >= (isCtx ? 2 : 3)) for (const x of xs) out.set(x.id, `tests:${isCtx ? 'ctx:' : ''}${f}`);
    return out;
  };
  const settledTests = shown.filter((u) => u.isTest && !u.declarations && (u.verdict === 'cleared' || u.verdict === 'proved'));
  const ctxTests = graph ? ctxIds.map((id) => graph.nodes.get(id)).filter((s) => s?.isTest) : [];
  const groupOf = new Map([...fold(settledTests, false), ...fold(ctxTests.map((s) => ({ id: s.id, file: s.file })), true)]);
  const folded = new Map();
  for (const [id, gid] of groupOf) { if (!folded.has(gid)) folded.set(gid, []); folded.get(gid).push(id); }
  edges = [...new Map(edges.map((e) => ({ ...e, from: groupOf.get(e.from) || e.from, to: groupOf.get(e.to) || e.to })).filter((e) => e.from !== e.to).map((e) => [`${e.from}>${e.to}`, e])).values()];
  const pub = (u) => ({
    id: u.id, name: u.name, qname: u.qname, kind: u.isTest && u.kind !== 'type' ? 'test' : u.kind, file: u.file, start: u.start, end: u.end, status: u.status,
    verdict: u.verdict, tone: u.tone, claim: u.claim, likelihood: round(u.likelihood), impact: round(u.impact), priority: round(u.priority), impactWhy: u.impactWhy,
    lines: u.lines, evidence: u.evidence, findings: u.findings, parts: (u.parts || []).slice(0, 6).map((p) => ({ id: p.id, text: p.text, nats: round(p.nats) })),
    metrics: u.metrics?.after ? { cyclomatic: u.metrics.after.cyclomatic, cognitive: u.metrics.after.cognitive, nesting: u.metrics.after.nesting, loc: u.metrics.after.loc, before: u.metrics.before ? u.metrics.before.cyclomatic : null } : null,
    sensitive: u.sensitive?.level !== 'normal' ? u.sensitive : null, proof: u.proof?.proved ? { level: u.proof.level, renames: u.proof.renames || null } : null,
    centrality: u.centrality ? { fanIn: u.centrality.fanIn, dependents: u.centrality.dependents, testedBy: u.centrality.testedBy, unlinked: u.centrality.unlinked || 0 } : null,
  });
  const groupNodes = [...folded].map(([gid, ids]) => {
    const ctx = gid.startsWith('tests:ctx:'), file = gid.slice(ctx ? 10 : 6), us = ids.map((id) => unitBySymbol.get(id)).filter(Boolean);
    const checks = us.reduce((n, u) => n + (u.assertions || 0), 0), added = us.reduce((n, u) => n + u.lines.added, 0), removed = us.reduce((n, u) => n + u.lines.removed, 0);
    return { id: gid, name: `${ids.length} tests`, qname: `${path.basename(file)} · ${ids.length} tests`, kind: 'test', file, start: 1, end: 1, status: ctx ? 'context' : 'added', verdict: ctx ? 'context' : 'cleared', tone: ctx ? 'no' : 'ok', members: ids.length,
      claim: ctx ? `${ids.length} existing tests that reach the changed code. This pull request did not change them.` : `${ids.length} tests written with this change, with ${checks} ${checks === 1 ? 'check' : 'checks'} that can fail. They are evidence about other code, not product code.`,
      likelihood: ctx ? 0 : 0.05, impact: ctx ? 0.1 : 0.14, priority: 0, lines: { added, removed }, findings: [], parts: [],
      evidence: ctx ? [] : [{ id: 'assert', label: 'Checks', value: String(checks), tone: checks ? 'ok' : 'bad', detail: 'Calls that can fail a test (assert, expect, verify…).' }, { id: 'change', label: 'Change', value: `${added + removed} lines`, tone: 'ok', detail: '' }] };
  });
  const nodes = [...shown.filter((u) => !groupOf.has(u.id)).map(pub), ...groupNodes, ...extra, ...ctxIds.filter((id) => !groupOf.has(id)).map((id) => {
    const s = graph.nodes.get(id), c = cent?.get(id) || {};
    const rank = Math.max(c.pagerankPct || 0, c.dependentsPct || 0, c.fanInPct || 0);
    return { id, name: short(s), qname: s.qname, kind: s.isTest ? 'test' : s.kind, file: s.file, start: s.start, end: s.end, status: 'context', verdict: 'context', tone: 'no', claim: s.isTest ? 'A test this pull request did not change.' : 'Not changed by this pull request. Shown because it uses, or is used by, code that was.', likelihood: 0, impact: round(s.isTest ? 0.08 : Math.pow(rank, 3)), priority: 0, lines: { added: 0, removed: 0 }, evidence: [], findings: [], parts: [], centrality: { fanIn: c.fanIn || 0, dependents: c.dependents || 0, testedBy: c.testedBy || 0 } };
  })];

  const all = [...live, ...extra];
  const summary = summarize(all, prStats);
  summary.routing = { status: routing.status, model: routing.model, ms: routing.ms || 0, adopted: routing.adopted || [], reason: routing.reason || null, authority: routing.authority };
  summary.graph = graph ? { symbols: graph.stats?.symbols ?? graph.nodes.size, edges: graph.stats?.edges ?? 0, files: headFiles.size } : null;
  summary.baseline = models.baseline ? { mean: round(models.baseline.mean), sd: round(models.baseline.sd), n: models.baseline.n } : null;
  summary.policy = POLICY; summary.weights = WEIGHTS;
  const result = { version: VERSION, partial: MISSING.length > 0 || limits.some((l) => / could not run: /.test(l)), key, head, base: mb, ms: Math.round(performance.now() - t0), stages, summary, nodes, edges, methods: METHODS, limits: [...new Set(limits)],
    files: diffFiles.map((f) => ({ path: f.path, kind: kindOf(f.path), add: f.add, del: f.del, status: f.status })) };
  RESULTS.set(key, result); if (RESULTS.size > 40) RESULTS.delete(RESULTS.keys().next().value);
  if (!result.partial) try { writeJSON(file, result); } catch { /* the cache is a convenience */ }
  return result;
}
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);

/** package.json files and package references at a ref, for the import checks. One batch read from git objects. */
export async function manifestsOf(repo, tree) {
  const out = { packageJson: [], csprojPackages: new Set(), pythonRequirements: new Set() };
  const pick = (re, max) => tree.filter((f) => re.test(f.path) && !/(^|\/)node_modules\//.test(f.path) && f.size < 300_000).slice(0, max);
  const pkgs = pick(/(^|\/)package\.json$/, 12), projs = pick(/\.(csproj|props|targets)$/, 80), reqs = pick(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/, 6);
  const blobs = await readBlobs(repo, [...pkgs, ...projs, ...reqs].map((f) => f.sha));
  for (const f of pkgs) { try { out.packageJson.push({ dir: path.dirname(f.path) === '.' ? '' : path.dirname(f.path), json: JSON.parse(blobs.get(f.sha)) }); } catch { /* unreadable manifest */ } }
  for (const f of projs) for (const m of (blobs.get(f.sha) || '').matchAll(/<(?:PackageReference|PackageVersion)\s+(?:Include|Update)="([^"]+)"/g)) out.csprojPackages.add(m[1]);
  for (const f of reqs) for (const m of (blobs.get(f.sha) || '').matchAll(/^\s*["']?([A-Za-z0-9_.-]+)\s*(?:[=<>~!\[]|["']|$)/gm)) out.pythonRequirements.add(m[1].toLowerCase());
  return out;
}

/** The code of one node on both sides of the change, with the signatures around it: what an agent needs to rebuild it. */
export async function nodeSource(project, pr, id) {
  const r = await analyze(project, pr);
  const n = r.nodes.find((x) => x.id === id);
  if (!n) throw new Error('Unknown node');
  const repo = project.path;
  const head = await readFileAt(repo, r.head, n.file), base = await readFileAt(repo, r.base, n.file);
  const H = head != null ? parseFile(head, n.file) : null, B = base != null ? parseFile(base, n.file) : null;
  const key = id.split('::')[1];
  const hs = H?.symbols.find((s) => s.key === key), bs = B?.symbols.find((s) => s.key === key);
  const neighbours = r.edges.filter((e) => e.from === id || e.to === id).map((e) => { const o = r.nodes.find((x) => x.id === (e.from === id ? e.to : e.from)); return o ? { name: o.qname, file: o.file, relation: e.from === id ? 'calls' : e.kind === 'tests' ? 'tested by' : 'called by' } : null; }).filter(Boolean);
  return { node: n, lang: langOf(n.file), head: hs ? linesOf(head, hs.start, hs.end) : null, base: bs ? linesOf(base, bs.start, bs.end) : null, signature: hs ? linesOf(head, hs.start, hs.start) : null, neighbours, fileHead: head };
}
