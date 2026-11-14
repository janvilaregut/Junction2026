// Consensus verification: N Gemini variants solve the same prompt blind, a heatmap compares them with the PR,
// then they debate in pairs until a consensus emerges. The verdict says whether the PR is in it.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT, readJSON, writeJSON, slug } from '../util.js';
import { git, out, isRepo, defaultBase, resolveRef, commits, parseDiff } from '../git.js';
import { TOP_MODEL, generateJSON, hasKey } from './gemini.js';
import { solve } from './harness.js';
import { buildHeatmap } from './heatmap.js';
import { runDebate } from './debate.js';
import { LANG_NAME, langOf, strings } from './lang.js';

const DIR = path.resolve(DATA, 'consenso'); // absolute even with a relative KATSE_DATA (worktrees, cwd and safePath rely on it)
const STRAGGLER_MS = Number(process.env.KATSE_STRAGGLER_MS || 120_000);
fs.mkdirSync(DIR, { recursive: true });

// Sampling variations of the same top model. Each one is a different "personality".
export const SOLVERS = [
  { id: 'A', name: 'Precise', temperature: 0.2, topP: 0.8, topK: 20, thinkingLevel: 'high', color: '#e3dcf4' },
  { id: 'B', name: 'Steady', temperature: 0.5, topP: 0.9, topK: 40, thinkingLevel: 'medium', color: '#cde4ee' },
  { id: 'C', name: 'Balanced', temperature: 0.9, topP: 0.95, topK: 64, thinkingLevel: 'high', color: '#bfe3d0' },
  { id: 'D', name: 'Curious', temperature: 1.2, topP: 0.97, topK: 100, thinkingLevel: 'medium', color: '#f3e2a6' },
  { id: 'E', name: 'Bold', temperature: 1.5, topP: 0.99, topK: 200, thinkingLevel: 'low', color: '#f2c6d9' },
  { id: 'F', name: 'Skeptic', temperature: 0.7, topP: 0.85, topK: 32, thinkingLevel: 'high', color: '#d8d2c4' },
];
const ADVOCATE = { id: 'PR', name: "PR's advocate", temperature: 0.6, topP: 0.9, topK: 40, thinkingLevel: 'high', color: '#f5f5f7' };

const runs = new Map(); // id → { state, subs:Set }
let lastIdMs = 0;
const fileOf = (id) => path.join(DIR, `${slug(id)}.json`);
const genOf = (a) => ({ temperature: a.temperature, topP: a.topP, topK: a.topK, thinkingLevel: a.thinkingLevel });

function persist(id) {
  const r = runs.get(id);
  if (!r) return;
  clearTimeout(r.t);
  r.t = setTimeout(() => writeJSON(fileOf(id), r.state), 300);
}

function emitter(id) {
  return (e) => {
    const r = runs.get(id);
    const ev = { ...e, at: new Date().toISOString() };
    r.state.events.push(ev);
    for (const fn of r.subs) { try { fn(ev); } catch { /* closed */ } }
    persist(id);
  };
}

// Is the process that owns a persisted 'running' run still alive? (CLI and server share data/consenso.)
const LEGACY_STALE_MS = 15 * 60_000;
function ownerAlive(state, file) {
  if (Number.isInteger(state.pid)) {
    if (state.pid === process.pid) return false; // not in our map: an earlier process that had our pid
    try { process.kill(state.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  // Records written before the pid was stored: alive only while still being written to.
  try { return Date.now() - fs.statSync(file).mtimeMs < LEGACY_STALE_MS; } catch { return false; }
}

export function getConsensus(id) {
  const live = runs.get(id)?.state;
  if (live) return live;
  const file = fileOf(id);
  const state = readJSON(file, null);
  // Persisted as running but its process died (Ctrl-C, restart): report it, without rewriting the file.
  if (state?.status === 'running' && !ownerAlive(state, file)) return { ...state, status: 'interrupted' };
  return state;
}

// Worktree folders left behind by runs whose process died. The folders go now; `git worktree prune`
// at the next run start (on that repo) drops their registrations.
function sweepWorktrees() {
  const wt = path.join(DIR, 'wt');
  let names = [];
  try { names = fs.readdirSync(wt); } catch { return; }
  for (const name of names) {
    if (getConsensus(name)?.status === 'running') continue; // live here or in another process
    try { fs.rmSync(path.join(wt, name), { recursive: true, force: true }); } catch { /* in use: next time */ }
  }
}
sweepWorktrees();

export function listConsensus() {
  const ids = new Set([...runs.keys()]);
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
  return [...ids].map((id) => getConsensus(id)).filter(Boolean)
    .map(({ id, repo, branch, base, status, verdict, createdAt }) => ({ id, repo, branch, base, status, verdict: verdict?.verdict || null, createdAt }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Subscribe to live events. Returns unsubscribe. Past events are not replayed here (read state.events). */
export function subscribeConsensus(id, fn) {
  const r = runs.get(id);
  if (!r) return () => {};
  r.subs.add(fn);
  return () => r.subs.delete(fn);
}

export const isLive = (id) => runs.get(id)?.state.status === 'running';

export async function startConsensus({ repo, branch, base, prompt, agents = 5, lang = 'en' }) {
  lang = langOf(lang);
  const t = strings(lang);
  if (!hasKey()) throw new Error('GEMINI_API_KEY missing in .env');
  if (!repo || !branch) throw new Error('Give a repo and a branch');
  const repoAbs = await isRepo(path.resolve(ROOT, repo));
  if (!repoAbs) throw new Error(`${repo} is not a git repository`);
  const baseName = base || (await defaultBase(repoAbs));
  const baseRef = await resolveRef(repoAbs, baseName);
  const headRef = await resolveRef(repoAbs, branch);
  const mergeBase = await out(repoAbs, ['merge-base', baseRef, headRef]);
  const headSha = await out(repoAbs, ['rev-parse', headRef]);
  if (mergeBase === headSha) throw new Error(`Branch ${branch} has no changes against ${baseName}`);
  const cs = await commits(repoAbs, mergeBase, headRef);
  const requirement = (prompt && prompt.trim()) || cs.map((c) => c.body || c.subject).join('\n\n');

  const n = Math.max(2, Math.min(SOLVERS.length, Number(agents) || 5));
  const solvers = SOLVERS.slice(0, n).map((s) => ({ ...s, model: TOP_MODEL, role: 'solver' }));
  const roster = [...solvers, { ...ADVOCATE, name: t.advocate, model: TOP_MODEL, role: 'advocate' }];
  // Unique (ms suffix, strictly increasing in this process) and within slug()'s 80 chars,
  // so fileOf(id) and wt/<id> never truncate or collide.
  const now = new Date(lastIdMs = Math.max(Date.now(), lastIdMs + 1));
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const suffix = now.getTime().toString(36);
  const id = `${stamp}-${slug(branch).slice(0, 80 - stamp.length - suffix.length - 2).replace(/-+$/, '')}-${suffix}`;
  const state = {
    id, pid: process.pid, repo: repoAbs, branch, base: baseName, mergeBase, head: headSha, prompt: requirement, promptFromCommits: !(prompt && prompt.trim()),
    status: 'running', createdAt: new Date().toISOString(), model: TOP_MODEL, lang,
    agents: roster, solutions: {}, heatmap: null, rounds: [], groups: [], verdict: null, events: [],
  };
  runs.set(id, { state, subs: new Set() });
  const emit = emitter(id);
  emit({ type: 'start', agents: roster, prompt: requirement, repo: repoAbs, branch, base: baseName, model: TOP_MODEL });
  writeJSON(fileOf(id), state); // on disk at once, so another process never sees wt/<id> without its record
  pipeline(state, emit).catch((e) => {
    state.status = 'error';
    state.error = e.message;
    emit({ type: 'error', message: e.message });
  });
  return { id };
}

async function diffs(dir, from, to) {
  const spec = to ? [from, to] : ['--cached', from];
  const ex = ['--', '.', ':(exclude)node_modules', ':(exclude)package-lock.json'];
  const u0 = (await git(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', ...spec, ...ex])).stdout;
  const u3 = (await git(dir, ['diff', '--no-color', '--no-ext-diff', ...spec, ...ex])).stdout;
  const files = (await git(dir, ['diff', '--name-only', ...spec, ...ex])).stdout.split('\n').filter(Boolean);
  const parsed = parseDiff(u0); // counts `-- x` / `++ x` content lines that a prefix test would skip
  const stats = { added: parsed.reduce((n, f) => n + f.add, 0), removed: parsed.reduce((n, f) => n + f.del, 0) };
  return { u0, u3, files, stats };
}

async function pipeline(state, emit) {
  const { repo, mergeBase, head, lang } = state;
  const t = strings(lang);
  const work = path.join(DIR, 'wt', slug(state.id));
  fs.mkdirSync(work, { recursive: true });
  // Drop registrations of worktrees whose folders are gone (e.g. swept after a crash) before adding ours.
  await git(repo, ['worktree', 'prune'], { allowFail: true });

  // The PR itself, defended by its advocate.
  const pr = await diffs(repo, mergeBase, head);
  state.solutions.PR = { agent: 'PR', files: pr.files, summary: t.prSummary, diff: pr.u3, diff0: pr.u0, stats: pr.stats, ok: true };
  emit({ type: 'solution', agent: 'PR', files: pr.files, summary: state.solutions.PR.summary, diff: pr.u3, stats: pr.stats });
  emit({ type: 'agent', agent: 'PR', status: 'done', text: t.defends(pr.files.length) });

  // 1. Resolve: every solver works blind in its own worktree from the merge base.
  emit({ type: 'phase', phase: 'resolver', text: t.phaseSolve(state.agents.length - 1) });
  const solvers = state.agents.filter((a) => a.role === 'solver');
  const worktrees = [];
  // Stragglers: once all but one have finished WITH a solution, the last one gets STRAGGLER_MS more, then it is
  // cut off. Failed solvers do not count, or the only working solver could be cut off.
  const controllers = Object.fromEntries(solvers.map((a) => [a.id, new AbortController()]));
  let finished = 0;
  let succeeded = 0;
  let cutTimer = null;
  const onFinished = (ok) => {
    finished++;
    if (ok) succeeded++;
    if (!cutTimer && succeeded >= Math.max(2, solvers.length - 1) && finished < solvers.length) {
      cutTimer = setTimeout(() => Object.values(controllers).forEach((c) => c.abort()), STRAGGLER_MS);
    }
  };
  try {
    await Promise.all(solvers.map(async (a) => {
      const dir = path.join(work, a.id);
      try {
        await git(repo, ['worktree', 'add', '--detach', '--force', dir, mergeBase]);
        worktrees.push(dir);
        const res = await solve({
          dir, requirement: state.prompt, hintFiles: pr.files, gen: genOf(a), model: a.model,
          signal: controllers[a.id].signal, lang,
          onEvent: (ev) => emit({ type: 'agent', agent: a.id, ...ev }),
        });
        await git(dir, ['add', '-A', '--', '.', ':(exclude)node_modules']);
        const d = await diffs(dir, mergeBase);
        state.solutions[a.id] = { agent: a.id, files: d.files, summary: res.summary, diff: d.u3, diff0: d.u0, stats: d.stats, steps: res.steps, testsRun: res.testsRun, ok: !(res.exhausted && !d.files.length) };
        emit({ type: 'solution', agent: a.id, files: d.files, summary: res.summary, diff: d.u3, stats: d.stats, steps: res.steps });
        emit({ type: 'agent', agent: a.id, status: 'done', text: t.changes(d.files.length) });
      } catch (e) {
        const msg = controllers[a.id].signal.aborted ? t.cutOff : e.message;
        state.solutions[a.id] = { agent: a.id, files: [], summary: '', diff: '', diff0: '', ok: false, error: msg };
        emit({ type: 'agent', agent: a.id, status: 'error', text: msg.slice(0, 160) });
      } finally {
        onFinished(Boolean(state.solutions[a.id]?.ok));
      }
    }));
  } finally {
    clearTimeout(cutTimer);
    for (const dir of worktrees) await git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
    await git(repo, ['worktree', 'prune'], { allowFail: true });
  }

  const candidates = state.agents.filter((a) => state.solutions[a.id]?.ok)
    .map((a) => ({ id: a.id, role: a.role, model: a.model, gen: genOf(a), diff: state.solutions[a.id].diff, summary: state.solutions[a.id].summary }));
  if (candidates.filter((c) => c.role === 'solver').length < 1) throw new Error(t.noSolver);

  // 2. Compare: heatmap zone by zone.
  emit({ type: 'phase', phase: 'comparar', text: t.phaseCompare });
  const files = new Set();
  for (const c of candidates) for (const f of state.solutions[c.id].files) files.add(f);
  const baseCache = {};
  for (const f of files) {
    const r = await git(repo, ['show', `${mergeBase}:${f}`], { allowFail: true });
    baseCache[f] = r.code === 0 ? r.stdout.split('\n') : [];
  }
  const heatmap = buildHeatmap(Object.fromEntries(candidates.map((c) => [c.id, state.solutions[c.id].diff0])), (f) => baseCache[f] || []);
  state.heatmap = heatmap;
  emit({ type: 'heatmap', heatmap });

  // 3. Debate in pairs.
  emit({ type: 'phase', phase: 'debatir', text: t.phaseDebate });
  const { groups, rounds, stance } = await runDebate({
    candidates, heatmap, requirement: state.prompt, lang,
    emit: (e) => { if (e.type === 'groups') state.groups = e.groups; emit(e); },
  });
  state.rounds = rounds;
  state.stance = stance;
  state.groups = groups.map((g) => ({ leader: g.leader, members: [...g.members] }));

  // 4. Verdict.
  emit({ type: 'phase', phase: 'veredicto', text: t.phaseVerdict });
  state.verdict = await verdictOf(state, candidates);
  emit({ type: 'verdict', ...state.verdict });
  state.status = 'done';
  emit({ type: 'done' });
}

async function verdictOf(state, candidates) {
  const t = strings(state.lang);
  const n = candidates.length;
  const sorted = [...state.groups].sort((a, b) => b.members.length - a.members.length);
  const top = sorted[0];
  const tie = sorted.filter((g) => g.members.length === top.members.length).length > 1;
  // The PR is in the consensus only if its own code survived: it leads the group or joined as equivalent, not by conceding.
  // A leader keeps 'own' unless it conceded in a mutual concession, so the PR's stance is read even when it leads.
  const prStance = state.stance?.PR || 'own';
  const prInConsensus = top.members.includes('PR') && prStance !== 'conceded';
  const prConceded = top.members.includes('PR') && prStance === 'conceded';
  const confidence = Math.round((top.members.length / n) * 100) / 100;
  const verdict = tie || confidence < 0.5 ? 'dudoso' : prInConsensus ? 'coincide' : 'difiere';
  const consensusDiff = state.solutions[top.leader]?.diff || '';

  const keyArgs = state.rounds.flatMap((r) => Object.entries(r.arguments || {}).map(([who, a]) => `- ${who} (round ${r.round}): ${a.argument}${a.rival_flaws?.length ? ` | flaws it points out: ${a.rival_flaws.join('; ')}` : ''}`)).slice(0, 16).join('\n');
  const outcome = prInConsensus ? 'the PR is in the majority group with its own code'
    : prConceded ? "the PR's advocate CONCEDED during the debate: the PR's code was rejected by the majority"
      : 'the PR is NOT in the majority group';
  let summary = '';
  let issues = [];
  try {
    const j = await generateJSON({
      model: TOP_MODEL, gen: { temperature: 0.3, thinkingLevel: 'high' },
      system: `You are the rapporteur of a consensus code review. Write in ${LANG_NAME[state.lang]}, clear and brief. Do not invent: use only the material given.`,
      contents: [{ role: 'user', parts: [{ text: `## Requirement\n${state.prompt}\n\n## PR diff\n\`\`\`diff\n${(state.solutions.PR.diff || '').slice(0, 9000)}\n\`\`\`\n\n## Consensus solution (group of ${top.members.join(', ')}, leader ${top.leader})\n\`\`\`diff\n${consensusDiff.slice(0, 9000)}\n\`\`\`\n\n## Debate arguments\n${keyArgs || '(no debate: everyone agreed)'}\n\nOutcome: ${outcome}${tie ? ' (but there is a tie between groups)' : ''}.\nExplain to the person who will decide whether to accept the PR: what it does right, what concrete problems it has against the requirement (if any) and what you would change. If the PR is correct, issues=[].\nJSON: {"summary": "max 80 words", "issues": [{"file": "path", "description": "concrete flaw with an example"}]}` }] }],
    });
    summary = j.summary || '';
    issues = Array.isArray(j.issues) ? j.issues : [];
  } catch (e) {
    summary = t.noSummary(e.message);
  }
  return { verdict, confidence, leader: top.leader, members: top.members, prInConsensus, prConceded, stance: state.stance, groups: state.groups, summary, issues, consensusDiff };
}
