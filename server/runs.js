// Run registry: starts verifications, keeps their events for live streaming, and persists the result.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, readJSON, writeJSON, slug, sha256 } from './util.js';
import { verify, normalizeOptions } from './pipeline/run.js';
import { availableAgents } from './pipeline/replicas.js';
import { record } from './ledger.js';
import { verifyIntegrity } from './integrity.js';

const live = new Map(); // runId → run
const busy = new Map(); // projectId → runId (one verification per repository at a time)

const dirOf = (projectId, runId) => path.join(DATA, 'runs', projectId, runId);
const indexFile = (projectId) => path.join(DATA, 'runs', projectId, 'index.json');

export function runIndex(projectId) {
  return readJSON(indexFile(projectId), []);
}

/** Latest finished run per PR, newest first. */
export function latestByPr(projectId) {
  const map = {};
  for (const r of runIndex(projectId)) if (!map[r.prId] || map[r.prId].finishedAt < r.finishedAt) map[r.prId] = r;
  return map;
}

export function latestBriefs(projectId) {
  return Object.values(latestByPr(projectId))
    .map((r) => readJSON(path.join(dirOf(projectId, r.runId), 'artifacts', 'brief.json'), null))
    .filter(Boolean);
}

export async function startRun(project, pr, rawOptions, onEvent) {
  if (busy.has(project.id)) throw new Error('Ya hay una verificación en marcha en este proyecto. Espera a que termine.');
  const id = `${slug(pr.branch)}-${Date.now().toString(36)}`;
  // Reserve the project before the first await: two quick requests must not both get past the check.
  busy.set(project.id, id);
  const release = () => { if (busy.get(project.id) === id) busy.delete(project.id); };
  let options, dir;
  try {
    options = normalizeOptions(rawOptions, await availableAgents());
    dir = dirOf(project.id, id);
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) { release(); throw e; }
  const run = { id, projectId: project.id, prId: pr.id, branch: pr.branch, head: pr.sha, status: 'running', startedAt: new Date().toISOString(), options, events: [], listeners: new Set(), dir, brief: null, error: null };
  live.set(id, run);
  const emit = (e) => {
    const ev = { ...e, t: Date.now() };
    run.events.push(ev);
    onEvent?.(ev);
    for (const l of run.listeners) l(ev);
  };
  run.promise = verify({ project, pr, options, runDir: dir, emit })
    .then((brief) => {
      run.brief = brief;
      run.status = 'done';
      const idx = runIndex(project.id);
      idx.push({ runId: id, prId: pr.id, branch: pr.branch, head: brief.pr.head, lane: brief.lane.id, laneName: brief.lane.name, tone: brief.lane.tone, residue: brief.residue.lines, total: brief.totals.lines, questions: brief.questions.length, mode: options.mode, finishedAt: new Date().toISOString() });
      writeJSON(indexFile(project.id), idx);
      record(project.id, { type: 'run', pr: pr.id, head: brief.pr.head, lane: brief.lane.id, mode: options.mode, runId: id, ms: brief.timing.totalMs });
    })
    .catch((e) => { run.status = 'failed'; run.error = e.message; emit({ type: 'error', text: e.message }); })
    .finally(() => {
      run.finishedAt = new Date().toISOString();
      release();
      writeJSON(path.join(dir, 'run.json'), { id, projectId: project.id, prId: pr.id, branch: pr.branch, status: run.status, error: run.error, startedAt: run.startedAt, finishedAt: run.finishedAt, options, events: run.events });
      for (const l of run.listeners) l({ type: 'end', status: run.status });
    });
  return run;
}

export async function waitFor(runId) {
  const run = live.get(runId);
  if (run?.promise) await run.promise;
  return getRun(run.projectId, runId);
}

export function getRun(projectId, runId) {
  if (!/^[\w.-]+$/.test(runId)) throw new Error('Identificador de verificación no válido');
  const l = live.get(runId);
  const dir = dirOf(projectId, runId);
  if (l && l.status === 'running') return { ...l, listeners: undefined, promise: undefined };
  const saved = readJSON(path.join(dir, 'run.json'), null);
  if (!saved) throw new Error('No encuentro esa verificación');
  const brief = readJSON(path.join(dir, 'artifacts', 'brief.json'), null);
  const signoff = readJSON(path.join(dir, 'signoff.json'), null);
  const briefHash = brief ? sha256(JSON.stringify(brief)) : null;
  const signatureValid = signoff && brief ? signoff.briefHash === briefHash && verifyIntegrity(brief, path.join(dir, 'artifacts')).ok : null;
  return { ...saved, dir, brief, signoff, signatureValid, briefHash };
}

export function subscribe(runId, listener) {
  const run = live.get(runId);
  if (!run || run.status !== 'running') return null;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function activeRun(projectId) {
  const id = busy.get(projectId);
  return id ? live.get(id) : null;
}

export function artifact(projectId, runId, name) {
  if (!/^[\w.-]+$/.test(runId) || !/^[\w.-]+$/.test(name)) throw new Error('Nombre no válido');
  const file = path.join(dirOf(projectId, runId), 'artifacts', name);
  if (!fs.existsSync(file)) throw new Error('No existe esa evidencia');
  return fs.readFileSync(file, 'utf8');
}

export function saveSignoff(projectId, runId, signoff) {
  writeJSON(path.join(dirOf(projectId, runId), 'signoff.json'), signoff);
  // A signature belongs to one commit. Remember which, so the list can show it expiring when the branch moves.
  const idx = runIndex(projectId);
  for (const r of idx) if (r.runId === runId) { r.signedBy = signoff.signer; r.signedHead = signoff.head; r.decision = signoff.decision; }
  writeJSON(indexFile(projectId), idx);
}
