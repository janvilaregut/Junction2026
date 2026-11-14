// Trust ledger: what was signed, by whom, and what escaped afterwards.
// Trust is tracked per area (a folder of the repo) and moves with the track record:
//   prueba (probation) → ganada (earned) after K sign-offs with no escape → retirada (withdrawn) on an escape.
import path from 'node:path';
import { DATA, appendJSONL, readJSONL } from './util.js';

export const K_EARN = 5;
const file = (projectId) => path.join(DATA, 'ledger', `${projectId}.jsonl`);

export const entries = (projectId) => readJSONL(file(projectId));

export function record(projectId, entry) {
  const e = { ...entry, ts: new Date().toISOString() };
  appendJSONL(file(projectId), e);
  return e;
}

/** The area a file belongs to: up to three leading folders (src/Project/Module). */
export function areaOf(p) {
  const segs = p.split('/');
  if (segs.length <= 1) return '(raíz)';
  return segs.slice(0, Math.min(3, segs.length - 1)).join('/');
}

export function areasOf(files) {
  const set = new Set();
  for (const f of files) if (f.kind === 'source' || f.kind === 'config') set.add(areaOf(f.path));
  return [...set].sort();
}

export function areaStates(projectId, areas) {
  const log = entries(projectId);
  const all = new Set(areas || []);
  for (const e of log) for (const a of e.areas || (e.area ? [e.area] : [])) all.add(a);
  return [...all].sort().map((area) => {
    const mine = log.filter((e) => (e.areas || [e.area]).includes(area));
    const escapes = mine.filter((e) => e.type === 'escape');
    const signoffs = mine.filter((e) => e.type === 'signoff');
    const lastEscape = escapes.at(-1)?.ts || '';
    const since = signoffs.filter((e) => e.ts > lastEscape).length;
    let state = 'prueba';
    if (escapes.length && since < K_EARN) state = 'retirada';
    else if (since >= K_EARN) state = 'ganada';
    return {
      area, state, signoffs: signoffs.length, escapes: escapes.length, sinceEscape: since,
      remaining: Math.max(0, K_EARN - since), lastEscape: escapes.at(-1) || null,
    };
  });
}

/** Outcome measures, computed from the ledger and the latest brief of every PR. */
export function metrics(projectId, briefs) {
  const log = entries(projectId);
  const signoffs = log.filter((e) => e.type === 'signoff');
  const escapes = log.filter((e) => e.type === 'escape');
  const lanes = {};
  let read = 0;
  let total = 0;
  let seeded = { total: 0, byTests: 0, routed: 0, escaped: 0 };
  let cost = 0;
  let ms = 0;
  for (const b of briefs) {
    lanes[b.lane.id] = (lanes[b.lane.id] || 0) + 1;
    if (b.lane.id !== 'devolver') read += b.residue.lines;
    total += b.totals.lines;
    cost += b.cost?.usd || 0;
    ms += b.timing?.totalMs || 0;
    for (const m of b.mutation?.mutants || []) {
      if (m.status !== 'detectado' && m.status !== 'sobrevive') continue;
      seeded.total++;
      if (m.status === 'detectado') seeded.byTests++;
      else if (m.inResidue) seeded.routed++;
      else seeded.escaped++;
    }
  }
  const answered = signoffs.flatMap((s) => Object.values(s.answers || {}));
  const acted = answered.filter((a) => a && !/^aceptar/i.test(a)).length;
  // Stability: PRs verified more than once at the same commit should land on the same lane.
  const byHead = {};
  for (const e of log.filter((x) => x.type === 'run')) (byHead[`${e.pr}@${e.head}`] ||= []).push(e.lane);
  const repeated = Object.values(byHead).filter((l) => l.length > 1);
  const stable = repeated.filter((l) => new Set(l).size === 1).length;
  const waits = signoffs.map((s) => s.minutesToSign).filter((n) => typeof n === 'number');
  return {
    changes: briefs.length,
    lanes,
    readRatio: { read, total, pct: total ? Math.round((read / total) * 100) : 0 },
    fullRead: { n: lanes.completa || 0, of: briefs.length },
    seeded,
    findings: { acted, answered: answered.length },
    stability: { stable, repeated: repeated.length },
    signoffs: signoffs.length,
    escapes: escapes.length,
    minutesToSign: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    cost: { usd: Math.round(cost * 100) / 100, minutes: Math.round(ms / 60000) },
  };
}
