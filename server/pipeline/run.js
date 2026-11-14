// The verification pipeline. Cheap, deterministic stages first; agents only when asked for.
// It never touches the user's branches: everything happens in throw-away trees under the run folder.
import fs from 'node:fs';
import path from 'node:path';
import { run as exec, ROOT, DATA } from '../util.js';
import { out, diff, commits, resolveRef } from '../git.js';
import { fetchRequirement, provenance, requirementIdFrom } from '../requirements.js';
import { areasOf, areaStates } from '../ledger.js';
import { mechanicalGroups, addedTestNames } from './classify.js';
import { detectToolchain } from './toolchain.js';
import { worktree, removeWorktree, mergedTree, overlay, resetTree } from './sandbox.js';
import { runMutation, runRewind, changeGroups } from './mutation.js';
import { availableAgents, buildPrompt, runReplica, preflight } from './replicas.js';
import { withKinds, compareRegions } from './compare.js';
import { judge } from './judge.js';
import { resolveProfile } from '../profiles.js';
import { route } from './lanes.js';

const sec = (ms) => `${Math.round(ms / 1000)} s`;
const matches = (trxName, method) => { const n = trxName.split('(')[0]; return n === method || n.endsWith(`.${method}`) || trxName.includes(method); };
const outcomeOf = (result, method) => {
  const hits = result.tests.filter((t) => matches(t.name, method));
  if (!hits.length) return 'NoEjecutado';
  return hits.some((t) => t.outcome === 'Failed') ? 'Failed' : hits.every((t) => t.outcome === 'Passed') ? 'Passed' : 'NoEjecutado';
};
const testSide = (f) => (f.kind === 'test' || (f.kind === 'derived' && /(^|\/)tests?\//i.test(f.path))) && f.status !== 'deleted';

export function normalizeOptions(o = {}, agentsAvailable = []) {
  const mode = o.mode === 'completo' ? 'completo' : 'rapido';
  const agentsPicked = Array.isArray(o.agents) && o.agents.length > 0;
  let agents = agentsPicked ? o.agents : mode === 'completo' ? ['fast', 'diverse', 'review'] : [];
  agents = agents.filter((id) => agentsAvailable.some((a) => a.id === id)).slice(0, 5);
  return {
    mode, agents, agentsPicked,
    ...resolveProfile(o), profile: resolveProfile(o).id,
    resumeRunId: typeof o.resumeRunId === 'string' && /^[\w.-]+$/.test(o.resumeRunId) ? o.resumeRunId : null,
    controls: !!o.controls,
    privacy: o.privacy || process.env.KATSE_PRIVACY_MODE || 'auto',
    providers: o.providers || {}, concurrency: { models: 2, runners: 1 },
    mutants: Number.isFinite(+o.mutants) ? Math.max(0, Math.min(12, +o.mutants)) : 4,
    crossTests: o.crossTests !== false,
    rewind: o.rewind !== false,
    judge: o.judge !== false,
    agentTimeoutMin: mode === 'completo' ? 3 : Math.max(3, Math.min(45, +o.agentTimeoutMin || 20)),
    keepTrees: !!o.keepTrees,
  };
}

/**
 * Replica budget: n = min(4, 2 + ceil(log2(groups)) + high-risk groups).
 * A group is hand-written code that changes one behaviour (hunks close together in one file).
 * A group is high risk when it touches public surface or silences existing behaviour.
 */
export function replicaBudget(files) {
  const groups = changeGroups(files);
  const risky = groups.filter((g) => g.hunks.some((h) => h.added.some((l) => HIGH_RISK.test(l)) || h.removed.some((l) => /\bthrow\b|Report(Diagnostic)?\(/.test(l))));
  const n = groups.length ? Math.min(4, 2 + Math.ceil(Math.log2(groups.length)) + risky.length) : 0;
  const where = (g) => `${path.basename(g.file)}:${g.start}`;
  const missions = [{ why: 'base', text: 'Solve the requirement in the way you think is best.' }];
  for (const g of groups) missions.push({ why: `grupo ${where(g)}`, text: `Pay special attention to the code around ${g.file} line ${g.start}; consider a different way to solve that part than the obvious one.` });
  for (const g of risky) missions.push({ why: `riesgo ${where(g)}`, text: `Choose the most conservative strategy: change as little existing behaviour as possible around ${g.file} line ${g.start}, and add a test proving that existing behaviour (warnings, errors, results) is preserved.` });
  return { n, groups: groups.length, risky: risky.length, formula: `mín(4, 2 + ceil(log2(${groups.length})) + ${risky.length} de alto riesgo)`, missions: missions.slice(0, n) };
}
const HIGH_RISK = /^\s*public\s+(?:(?:sealed|static|abstract|partial|readonly)\s+)*(class|interface|struct|record|enum)\b|\bcatch\b|#pragma warning disable|\b(drop|ignore|suppress|skip|silenc)\w*/i;

/** Fast look at a PR without running anything: what it is, what would be checked and what would not. */
export async function intake(project, pr) {
  const repo = project.path;
  const baseRef = await resolveRef(repo, project.base);
  const headSha = await out(repo, ['rev-parse', '--verify', `${pr.ref}^{commit}`]);
  const baseSha = await out(repo, ['rev-parse', baseRef]);
  const mergeBase = await out(repo, ['merge-base', baseSha, headSha]);
  const files = withKinds(await diff(repo, mergeBase, headSha));
  const log = await commits(repo, mergeBase, headSha);
  const reqId = pr.requirement || requirementIdFrom(log.map((c) => c.subject).join(' '));
  const [requirement, prov, toolchain] = await Promise.all([
    pr.requirementText ? Promise.resolve({ id: 'user-input', title: 'Requisito aportado', body: String(pr.requirementText), url: null }) : fetchRequirement(project, reqId),
    provenance(repo, log),
    detectToolchain({ repo, sha: headSha, project, changedPaths: files.map((f) => f.path) }),
  ]);
  const totals = { files: files.length, added: files.reduce((n, f) => n + f.add, 0), removed: files.reduce((n, f) => n + f.del, 0) };
  totals.lines = totals.added + totals.removed;
  const kinds = {};
  for (const f of files) { kinds[f.kind] ||= { files: 0, lines: 0 }; kinds[f.kind].files++; kinds[f.kind].lines += f.add + f.del; }
  return { repo, baseRef, baseSha, headSha, mergeBase, files, commits: log, requirement, provenance: prov, toolchain, totals, kinds, groups: mechanicalGroups(files) };
}

export async function verifyBaseline({ project, pr, options, runDir, emit }) {
  const started = Date.now();
  const workDir = options.scratchRoot || runDir;
  fs.mkdirSync(workDir, { recursive: true });
  const art = path.join(runDir, 'artifacts');
  fs.mkdirSync(art, { recursive: true });
  const save = (name, text) => fs.writeFileSync(path.join(art, name), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  const stages = [];
  const trees = [];
  let costUsd = 0;

  async function stage(id, name, fn) {
    const t = Date.now();
    emit({ type: 'stage', id, name, status: 'start' });
    try {
      const r = await fn();
      const ms = Date.now() - t;
      stages.push({ id, name, ms, status: r?.skipped ? 'skip' : 'done' });
      emit({ type: 'stage', id, name, status: r?.skipped ? 'skip' : 'done', ms, detail: r?.detail || '' });
      return r;
    } catch (e) {
      stages.push({ id, name, ms: Date.now() - t, status: 'fail' });
      emit({ type: 'stage', id, name, status: 'fail', detail: e.message });
      throw e;
    }
  }

  const ctx = { options, env: { platform: process.platform, dotnet: null } };
  // Nothing in a verification may change the user's repository. Checked around the whole run.
  const repoBefore = (await exec('git', ['status', '--porcelain'], { cwd: project.path, timeout: 60_000 })).stdout;
  let it;
  try {
    // 0 ── Intake ──────────────────────────────────────────────────────────
    it = await stage('entrada', 'Leer el PR, el requisito y la procedencia', async () => {
      const x = await intake(project, pr);
      return { ...x, detail: `${x.totals.files} ficheros · +${x.totals.added} −${x.totals.removed} · requisito ${x.requirement?.title ? x.requirement.id : 'no encontrado'} · ${x.provenance.status === 'none' ? 'sin prompt guardado' : 'con prompt guardado'}` };
    });
    const { repo, baseRef, baseSha, headSha, files, requirement, toolchain, totals } = it;
    Object.assign(ctx, { files, totals, requirement, provenance: it.provenance, toolchain, groups: it.groups });
    ctx.areas = areaStates(project.id, areasOf(files));
    save('requirement.json', requirement || {});
    save('files.json', files.map((f) => ({ path: f.path, kind: f.kind, reason: f.reason, add: f.add, del: f.del, status: f.status })));

    // 1 ── Level 1: derived files ──────────────────────────────────────────
    await stage('l1', 'Nivel 1 · Ficheros derivados y cambios mecánicos', async () => {
      save('l1.json', it.groups);
      const derived = files.filter((f) => f.kind === 'derived').length;
      if (!derived) return { detail: 'No hay ficheros derivados en este cambio' };
      const g = it.groups;
      return { detail: `${derived} derivados · ${g.reduce((n, x) => n + x.mechanicalLines, 0)} líneas son el mismo cambio repetido · ${g.reduce((n, x) => n + x.anomalies.length, 0)} anomalía(s)` };
    });

    // 2 ── Sandbox: merge + build ──────────────────────────────────────────
    const merged = path.join(workDir, 'merged');
    ctx.merge = await stage('merge', `Mezclar sobre ${project.base} en una copia aislada`, async () => {
      const m = await mergedTree(repo, merged, baseRef, headSha);
      trees.push(merged);
      return { ...m, detail: m.ok ? 'Se mezcla sin conflictos' : `Conflictos: ${m.conflicts.join(', ')}` };
    });

    let baseTree = null;
    const ensureBase = async () => {
      if (!baseTree) { baseTree = path.join(workDir, 'base'); await worktree(repo, baseTree, baseSha); trees.push(baseTree); }
      return baseTree;
    };
    let canRun = ctx.merge.ok && toolchain.kind !== 'none';
    if (ctx.merge.ok) {
      ctx.build = await stage('build', `Compilar (${toolchain.describe})`, async () => {
        if (toolchain.kind === 'none') return { skipped: true, ok: true, detail: 'No se ha detectado cómo compilar' };
        if (toolchain.kind === 'dotnet') ctx.env.dotnet = (await exec('dotnet', ['--version'], { cwd: merged, timeout: 60_000 })).stdout.trim() || null;
        let b = await toolchain.build(merged);
        save('build-merged.log', b.log);
        let note = '';
        if (!b.ok) {
          // Before blaming the PR, check whether the same thing built without it.
          emit({ type: 'log', text: 'No compila con el PR; compruebo si compilaba sin él…' });
          const bt = await ensureBase();
          const bb = await toolchain.build(bt);
          save('build-base.log', bb.log);
          if (!bb.ok) {
            if (toolchain.kind === 'dotnet') {
              // Only a project that already existed and already failed is an environment problem.
              // A project the PR adds, or one that built before, is the PR's responsibility.
              const both = (b.failed || []).filter((p) => (bb.failed || []).includes(p) && fs.existsSync(path.join(bt, p)));
              toolchain.exclude(both, 'no compila en este sandbox ni siquiera sin el PR');
              const mine = (b.failed || []).filter((p) => !both.includes(p));
              b = { ...b, ok: mine.length === 0, failed: mine };
              note = ` · ${both.length} proyecto(s) de test no compilan ni sin el PR y quedan fuera`;
            } else {
              ctx.env.buildBroken = true;
              b = { ...b, ok: true };
              note = ' · el proyecto no compila ni sin el PR: los tests no se ejecutan';
            }
          }
        }
        return { ...b, detail: (b.ok ? `Compila · ${sec(b.ms)}` : 'No compila con el PR, y sin él sí') + note };
      });
      if (ctx.env.buildBroken || (toolchain.kind === 'dotnet' && !toolchain.testProjects.length)) canRun = false;
    }

    // 3 ── Level 2: behaviour ──────────────────────────────────────────────
    const testFiles = files.filter(testSide);
    const newNames = addedTestNames(files.filter((f) => f.kind === 'test'));
    if (canRun && ctx.build.ok) {
      ctx.l2 = await stage('l2', 'Nivel 2 · Tests: rojo antes, verde después', async () => {
        const suite = await toolchain.test(merged, {});
        save('suite-merged.log', suite.log + '\n' + suite.tests.map((t) => `${t.outcome}\t${t.name}`).join('\n'));
        let failing = suite.tests.filter((t) => t.outcome === 'Failed').map((t) => t.name);
        let preexisting = [];
        if (failing.length) {
          emit({ type: 'log', text: `${failing.length} test(s) fallan con el PR; compruebo si ya fallaban en la base…` });
          const bt = await ensureBase();
          const bb = await toolchain.build(bt);
          if (bb.ok) {
            const baseSuite = await toolchain.test(bt, {});
            save('suite-base.log', baseSuite.log + '\n' + baseSuite.tests.map((t) => `${t.outcome}\t${t.name}`).join('\n'));
            const was = new Set(baseSuite.tests.filter((t) => t.outcome === 'Failed').map((t) => t.name));
            preexisting = failing.filter((n) => was.has(n));
            failing = failing.filter((n) => !was.has(n));
          }
        }
        let red = null;
        let redBuilt = true;
        if (newNames.length) {
          emit({ type: 'log', text: `Paso los ${newNames.length} tests nuevos sobre la base, sin el cambio…` });
          const bt = await ensureBase();
          await overlay(bt, headSha, testFiles.map((f) => f.path));
          const rb = await toolchain.build(bt);
          redBuilt = rb.ok;
          let log = rb.log;
          if (rb.ok) { red = await toolchain.test(bt, { names: newNames }); log += '\n' + red.log + '\n' + red.tests.map((t) => `${t.outcome}\t${t.name}`).join('\n'); }
          save('red.log', log);
        }
        const newTests = newNames.map((name) => ({
          name,
          green: outcomeOf(suite, name),
          red: !redBuilt ? 'NoCompila' : red ? outcomeOf(red, name) : 'NoEjecutado',
        }));
        // A new test "fails" with the PR only when it is a new failure, not when the whole class already failed.
        const newFailures = failing.filter((n) => !newNames.some((m) => matches(n, m)));
        const teeth = newTests.filter((t) => t.green === 'Passed' && t.red === 'Failed').length;
        return {
          suite: { ok: suite.ok, ran: suite.ran, passed: suite.passed, failed: suite.failed, skipped: suite.skipped, ms: suite.ms },
          newTests, newFailures, preexisting, redBuilt, teeth,
          detail: `${suite.passed} de ${suite.ran} tests pasan con el PR · ${newNames.length ? `${teeth} de ${newNames.length} tests nuevos fallan sin el cambio y pasan con él` : 'el PR no añade tests'}`,
        };
      });
    } else {
      ctx.l2 = { skipped: true };
    }

    // 4 ── Seeded defects ──────────────────────────────────────────────────
    const l2ok = ctx.l2 && !ctx.l2.skipped && ctx.l2.suite.ok && ctx.l2.suite.ran > 0 && !ctx.l2.newFailures.length;
    ctx.mutation = await stage('mutacion', 'Defectos sembrados en las líneas cambiadas', async () => {
      if (!options.mutants) return { skipped: true, reason: 'Desactivado en esta verificación.', detail: 'Desactivado' };
      if (!l2ok) return { skipped: true, reason: 'No se ejecuta si el PR no compila o rompe tests.', detail: 'No aplicable' };
      const m = await runMutation({ tree: merged, prFiles: files, toolchain, max: options.mutants, emit: (text) => emit({ type: 'log', text }) });
      await resetTree(merged);
      save('mutation.json', m);
      if (!m.mutants.length) return { ...m, skipped: true, reason: 'Ninguna línea cambiada admite un defecto sembrado sencillo.', detail: 'Sin líneas mutables' };
      return { ...m, detail: `${m.killed} de ${m.valid} defectos los detecta algún test${m.survived ? ` · ${m.survived} sobreviven` : ''}` };
    });

    // 4b ── Rewind: take each change out ─────────────────────────────────
    ctx.rewind = await stage('rebobinar', 'Rebobinar: quitar cada cambio y ver si algún test lo nota', async () => {
      if (!options.rewind) return { skipped: true, reason: 'Desactivado en esta verificación.', detail: 'Desactivado', steps: [] };
      if (!l2ok) return { skipped: true, reason: 'No se ejecuta si el PR no compila o rompe tests.', detail: 'No aplicable', steps: [] };
      const r = await runRewind({ tree: merged, prFiles: files, toolchain, max: 6, emit: (text) => emit({ type: 'log', text }) });
      await resetTree(merged);
      save('rewind.json', r);
      if (!r.steps.length) return { ...r, skipped: true, reason: 'No hay cambios de código a mano que quitar.', detail: 'Nada que rebobinar' };
      return { ...r, detail: `${r.needed} de ${r.steps.length} cambios los nota algún test${r.untested ? ` · ${r.untested} no los nota ninguno` : ''}` };
    });

    // 5 ── Level 3: replicas ───────────────────────────────────────────────
    if (options.agents.length && ctx.merge.ok) {
      const presets = await availableAgents();
      // How many replicas, and what each one explores: one base attempt, one per group of changes,
      // and one more per high-risk group (capped). Unless the user picked the agents.
      const budget = replicaBudget(files);
      ctx.budget = budget;
      let wanted = options.agents.map((id) => presets.find((a) => a.id === id)).filter(Boolean);
      if (!options.agentsPicked) wanted = presets.slice(0, budget.n);
      const prompt = buildPrompt({ requirement, provenance: it.provenance, toolchain });
      save('replica-prompt.txt', prompt + `\n\n--- Misiones ---\n${budget.missions.map((m, i) => `${i + 1}. ${m.why}: ${m.text}`).join('\n')}`);
      emit({ type: 'log', text: `Réplicas: ${budget.n} = ${budget.formula}` });
      const srcChanged = files.some((f) => f.kind === 'source');
      ctx.replicas = await stage('l3', `Nivel 3 · ${wanted.length} agentes rehacen el cambio a ciegas`, async () => {
        // Drop agents that cannot answer right now (no quota, no login) before spending minutes on them.
        // When the user did not pick the agents, replace the ones that fail with the next available.
        const dropped = [];
        const agents = [];
        const queue = [...wanted, ...(options.agentsPicked ? [] : presets.filter((a) => !wanted.includes(a)))];
        while (agents.length < wanted.length && queue.length && dropped.length < 8) {
          const batch = queue.splice(0, wanted.length - agents.length);
          const checks = await Promise.all(batch.map((a) => preflight(a)));
          batch.forEach((a, i) => {
            if (checks[i].ok) agents.push(a);
            else { dropped.push({ id: a.id, label: a.label, model: a.model, ok: false, finished: false, status: `no disponible: ${checks[i].why}`, files: [], ms: 0, lines: 0 }); emit({ type: 'log', text: `${a.label}: no disponible (${checks[i].why})` }); }
          });
        }
        if (!agents.length) return Object.assign(dropped, { detail: 'Ningún agente disponible ahora mismo' });
        emit({ type: 'log', text: `Trabajando: ${agents.map((a) => a.label).join(', ')}` });

        // The agents must not see the PR or touch the user's repository. Three layers: a copy without history,
        // the system sandbox, and this before/after check of the original repository.
        const repoState = () => out(repo, ['status', '--porcelain']);
        const before = await repoState();
        const forbidden = [ROOT, DATA];
        const rs = await Promise.all(agents.map(async (agent) => {
          const dir = path.join(workDir, `replica-${agent.id}`);
          trees.push(dir);
          try {
            const mission = budget.missions[agents.indexOf(agent) % budget.missions.length];
            const r = await runReplica({ repo, baseSha, dir, agent, prompt: `${prompt}\n\nYOUR APPROACH: ${mission.text}`, timeoutMs: options.agentTimeoutMin * 60_000, artifacts: art, forbidden });
            r.mission = mission.why;
            r.files = withKinds(r.files);
            emit({ type: 'log', text: `${agent.label}: ${r.finished ? `${r.files.length} ficheros, ${r.lines} líneas en ${sec(r.ms)}` : r.status}` });
            return r;
          } catch (e) {
            emit({ type: 'log', text: `${agent.label}: error (${e.message})` });
            return { id: agent.id, label: agent.label, model: agent.model, ok: false, finished: false, status: `error: ${e.message}`, files: [], ms: 0, lines: 0 };
          }
        }));
        for (const r of rs) costUsd += r.cost || 0;
        const after = await repoState();
        ctx.env.confined = rs.every((r) => r.confined);
        if (after !== before) {
          // An agent escaped its copy. Its work can no longer be called independent: discard all replicas.
          ctx.env.isolationBroken = after.split('\n').filter((l) => l && !before.includes(l)).slice(0, 20);
          save('isolation-broken.txt', `Antes:\n${before}\n\nDespués:\n${after}\n`);
          for (const r of rs) { r.finished = false; r.status = 'descartada: se rompió el aislamiento'; }
          emit({ type: 'log', text: 'Una réplica ha modificado el repositorio original. Se descartan todas.' });
        }

        // A replica only counts if it stands on its own: it changes product code when the PR does,
        // it builds, and its own new tests pass on its own code. Half-finished work is not a second opinion.
        await Promise.all(rs.filter((r) => r.finished).map(async (r) => {
          if (srcChanged && !r.files.some((f) => f.kind === 'source')) { r.status = 'no válida: solo tocó tests o documentación'; return; }
          if (toolchain.kind === 'none' || !canRun) { r.ok = true; r.status = 'sin validar: no hay forma de compilar'; return; }
          const b = await toolchain.build(r.dir);
          if (!b.ok) { r.status = 'no válida: no compila'; save(`replica-${r.id}-build.log`, b.log); return; }
          const names = addedTestNames(r.files.filter((f) => f.kind === 'test'));
          if (!names.length) { r.ok = true; r.status = 'válida · compila, sin tests propios'; r.self = { ran: 0 }; return; }
          const t = await toolchain.test(r.dir, { names });
          save(`replica-${r.id}-self.log`, t.log + '\n' + t.tests.map((x) => `${x.outcome}\t${x.name}`).join('\n'));
          r.self = { ran: t.ran, passed: t.passed, failed: t.failed };
          if (t.ran > 0 && t.failed === 0) { r.ok = true; r.status = `válida · compila y pasa sus ${t.ran} tests`; }
          else r.status = t.ran ? `no válida: ${t.failed} de sus ${t.ran} tests fallan` : 'no válida: sus tests no se ejecutan';
        }));
        for (const r of rs) if (r.finished || r.status.startsWith('no válida')) emit({ type: 'log', text: `${r.label}: ${r.status}` });
        const all = [...rs, ...dropped];
        const okN = all.filter((r) => r.ok).length;
        return Object.assign(all, { detail: `${okN} de ${all.length} réplicas válidas` });
      });
      ctx.compare = compareRegions(files, ctx.replicas);
      save('regions.json', ctx.compare);

      // 5b ── Cross tests ──────────────────────────────────────────────────
      const good = ctx.replicas.filter((r) => r.ok);
      if (options.crossTests && canRun && ctx.build.ok && good.length) {
        ctx.cross = await stage('cruce', 'Tests cruzados entre el PR y las réplicas', async () => {
          const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)); } catch { return null; } };
          const prTests = Object.fromEntries(testFiles.map((f) => [f.path, read(merged, f.path)]).filter(([, c]) => c));
          const theirs = good.map((r) => ({
            r,
            names: addedTestNames(r.files.filter((f) => f.kind === 'test')),
            files: Object.fromEntries(r.files.filter(testSide).map((f) => [f.path, read(r.dir, f.path)]).filter(([, c]) => c)),
          }));
          const put = (dir, map) => { for (const [rel, c] of Object.entries(map)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), c); } };
          const shape = (t, built) => !built ? { status: 'no-compila' } : { status: 'ok', ran: t.ran, passed: t.passed, failed: t.failed, failedNames: t.tests.filter((x) => x.outcome === 'Failed').map((x) => x.name) };

          // A · the PR's new tests against each replica's code (in parallel: separate folders).
          const A = await Promise.all(theirs.map(async ({ r }) => {
            if (!newNames.length) return null;
            put(r.dir, prTests);
            const b = await toolchain.build(r.dir);
            const t = b.ok ? await toolchain.test(r.dir, { names: newNames }) : null;
            save(`cross-${r.id}-prtests.log`, b.log + (t ? '\n' + t.log + '\n' + t.tests.map((x) => `${x.outcome}\t${x.name}`).join('\n') : ''));
            return shape(t, b.ok);
          }));
          // B · each replica's own tests against the PR's code (one at a time: they share the merged tree).
          const B = [];
          for (const { r, names, files: tf } of theirs) {
            if (!names.length || !Object.keys(tf).length) { B.push(null); continue; }
            await resetTree(merged);
            put(merged, tf);
            const b = await toolchain.build(merged);
            const t = b.ok ? await toolchain.test(merged, { names }) : null;
            save(`cross-${r.id}-onpr.log`, b.log + (t ? '\n' + t.log + '\n' + t.tests.map((x) => `${x.outcome}\t${x.name}`).join('\n') : ''));
            B.push(shape(t, b.ok));
          }
          await resetTree(merged);
          const rows = theirs.map(({ r }, i) => ({ replica: r.id, label: r.label, prTestsOnReplica: A[i], replicaTestsOnPr: B[i] }));
          const aOk = rows.filter((x) => x.prTestsOnReplica?.status === 'ok' && x.prTestsOnReplica.failed === 0).length;
          const bOk = rows.filter((x) => x.replicaTestsOnPr?.status === 'ok' && x.replicaTestsOnPr.failed === 0).length;
          return Object.assign(rows, { detail: `${aOk} de ${rows.length} réplicas pasan los tests del PR · el PR pasa los tests de ${bOk} de ${rows.filter((x) => x.replicaTestsOnPr).length} réplicas` });
        });
      }

      // 5c ── Judge ────────────────────────────────────────────────────────
      const open = ctx.compare.regions.filter((r) => (r.kind === 'source' || r.kind === 'config') && (r.verdict === 'divergent' || r.verdict === 'surplus'));
      if (options.judge && open.length) {
        const j = await stage('juez', 'Formular lo que la IA no decide', async () => {
          const crossNotes = (ctx.cross || []).filter((c) => c.prTestsOnReplica?.failedNames?.length)
            .map((c) => `· Con el código de ${c.label}, estos tests del PR fallan: ${c.prTestsOnReplica.failedNames.map((n) => n.split('.').pop()).join(', ')}`).join('\n');
          const res = await judge({ requirement, regions: open, replicas: ctx.replicas, crossNotes, cwd: art });
          costUsd += res.cost || 0;
          return { ...res, detail: res.questions.length ? `${res.questions.length} pregunta(s) para la persona` : res.error || 'Sin preguntas adicionales' };
        });
        ctx.judged = j.questions;
      }
    } else {
      stages.push({ id: 'l3', name: 'Nivel 3 · Réplicas', ms: 0, status: 'skip' });
      emit({ type: 'stage', id: 'l3', name: 'Nivel 3 · Réplicas a ciegas', status: 'skip', detail: options.agents.length ? 'No aplicable' : 'Verificación rápida: sin réplicas' });
    }
  } finally {
    if (!options.keepTrees && it) {
      for (const t of trees) {
        if (t.endsWith('merged') || t.endsWith('base')) await removeWorktree(it.repo, t).catch(() => {});
        else fs.rmSync(t, { recursive: true, force: true });
      }
    }
  }

  const repoAfter = (await exec('git', ['status', '--porcelain'], { cwd: project.path, timeout: 60_000 })).stdout;
  if (repoAfter !== repoBefore && !ctx.env.isolationBroken) {
    ctx.env.repoTouched = repoAfter.split('\n').filter((l) => l && !repoBefore.includes(l)).slice(0, 20);
    save('repo-touched.txt', `Antes:\n${repoBefore}\n\nDespués:\n${repoAfter}\n`);
    emit({ type: 'log', text: `Aviso: el repositorio original ha cambiado durante la verificación (${ctx.env.repoTouched.join(', ')}).` });
  }

  // 6 ── Route ─────────────────────────────────────────────────────────────
  const routed = route(ctx);
  const brief = buildBrief({ project, pr, it, ctx, routed, stages, started, costUsd });
  save('brief.json', brief);
  emit({ type: 'stage', id: 'informe', name: 'Informe listo', status: 'done', ms: 0, detail: `${routed.lane.name} · lees ${routed.residue.lines} de ${it.totals.lines} líneas` });
  return brief;
}

function claim(id, text, status, detail, evidence = []) { return { id, text, status, detail, evidence }; }

function buildBrief({ project, pr, it, ctx, routed, stages, started, costUsd }) {
  const { files, totals, requirement, toolchain } = it;
  const { merge, build, l2, mutation, replicas, compare, cross, groups, rewind } = ctx;
  const claims = [];
  const notRun = (why) => ['no-ejecutado', why];

  claims.push(!merge.ok
    ? claim('merge', `Se mezcla limpio sobre ${project.base} y compila`, 'fallo', `Conflictos en ${merge.conflicts.join(', ')}`)
    : toolchain.kind === 'none'
      ? claim('merge', `Se mezcla limpio sobre ${project.base}`, 'reproducido', 'Sin conflictos. No se ha detectado cómo compilar.')
      : claim('merge', `Se mezcla limpio sobre ${project.base} y compila`, build.ok ? 'reproducido' : 'fallo', `${toolchain.describe}${build.ms ? ` · ${sec(build.ms)}` : ''}`, [{ label: 'Registro de compilación', artifact: 'build-merged.log' }]));

  if (l2 && !l2.skipped) {
    const n = l2.newTests.length;
    if (n) {
      const weak = l2.newTests.filter((t) => t.red === 'NoCompila' && t.green === 'Passed').length;
      const unrun = l2.newTests.filter((t) => t.green === 'NoEjecutado').length;
      claims.push(claim('rojo-verde', `Los ${n} tests nuevos fallan sin el cambio y pasan con él`,
        unrun === n ? 'no-ejecutado' : l2.teeth === n ? 'reproducido' : l2.teeth ? 'parcial' : 'fallo',
        `${l2.teeth} de ${n}${unrun ? ` · ${unrun} no se han podido ejecutar en el sandbox` : ''}${weak ? ` · ${weak} no compilan sin el cambio (evidencia más débil que un fallo en ejecución)` : ''}`,
        [{ label: 'Tests nuevos sobre la base', artifact: 'red.log' }, { label: 'Suite con el PR', artifact: 'suite-merged.log' }]));
    } else {
      claims.push(claim('rojo-verde', 'Hay tests nuevos que fallan sin el cambio', files.some((f) => f.kind === 'source') ? 'fallo' : 'no-ejecutado', 'El PR no añade ningún test.'));
    }
    claims.push(claim('suite', `No rompe los tests existentes (${l2.suite.ran} ejecutados)`,
      l2.suite.ran === 0 || (l2.suite.ok === false && l2.suite.failed === 0) ? 'no-ejecutado' : l2.newFailures.length ? 'fallo' : 'reproducido',
      l2.newFailures.length ? `${l2.newFailures.length} fallan con el PR y no en la base` : `${l2.suite.passed} pasan${l2.preexisting.length ? ` · ${l2.preexisting.length} ya fallaban antes del PR` : ''} · ${sec(l2.suite.ms)}`,
      [{ label: 'Suite con el PR', artifact: 'suite-merged.log' }]));
  } else {
    claims.push(claim('suite', 'Tests', ...notRun(toolchain.kind === 'none' ? 'No se ha detectado cómo pasar tests.' : 'El PR no se mezcla o no compila.')));
  }

  const derived = files.filter((f) => f.kind === 'derived');
  if (derived.length) {
    const mech = groups.reduce((n, g) => n + g.mechanicalLines, 0);
    const anom = groups.reduce((n, g) => n + g.anomalies.length, 0);
    const lines = derived.reduce((n, f) => n + f.add + f.del, 0);
    claims.push(claim('derivados', `${derived.length} ficheros derivados son consecuencia mecánica del cambio`,
      anom ? 'parcial' : 'reproducido',
      `${mech} de ${lines} líneas son el mismo bloque repetido${groups[0]?.pattern?.length ? ` («${groups[0].pattern.slice(0, 2).join(' / ')}»)` : ''}${anom ? ` · ${anom} fichero(s) cambian además de otra forma` : ''}${l2 && !l2.skipped && !l2.newFailures.length ? ' · los tests que comparan estos ficheros pasan' : ''}`,
      [{ label: 'Análisis de ficheros derivados', artifact: 'l1.json' }]));
  }

  if (mutation.skipped) claims.push(claim('mutacion', 'Los tests detectarían un defecto en las líneas cambiadas', ...notRun(mutation.reason)));
  else claims.push(claim('mutacion', 'Los tests detectarían un defecto en las líneas cambiadas', !mutation.valid ? 'no-ejecutado' : mutation.survived ? 'parcial' : 'reproducido',
    `${mutation.killed} de ${mutation.valid} defectos sembrados detectados`, [{ label: 'Detalle de mutantes', artifact: 'mutation.json' }]));

  if (rewind && !rewind.skipped) {
    claims.push(claim('rebobinar', 'Cada cambio de código es necesario para algún test', rewind.needed === rewind.steps.length && rewind.steps.length ? 'reproducido' : 'parcial',
      `${rewind.needed} de ${rewind.steps.length} cambios: al quitarlos falla algún test${rewind.untested ? ` · ${rewind.untested} se pueden quitar sin que falle nada` : ''}`,
      [{ label: 'Detalle de rebobinar', artifact: 'rewind.json' }]));
  } else if (rewind?.skipped) {
    claims.push(claim('rebobinar', 'Cada cambio de código es necesario para algún test', 'no-ejecutado', rewind.reason));
  }

  if (compare && compare.n) {
    const code = compare.regions.filter((r) => r.kind === 'source' || r.kind === 'config');
    const agree = code.filter((r) => r.verdict === 'consensus' || r.verdict === 'trivial').length;
    claims.push(claim('replicas', 'Similitud textual de alternativas (no prueba equivalencia)',
      'parcial', `${agree} de ${code.length} zonas de código coinciden en ${compare.n} réplicas válidas`,
      replicas.filter((r) => r.ok).map((r) => ({ label: `Parche de ${r.label}`, artifact: r.patchFile }))));
    if (cross?.length) {
      const a = cross.filter((c) => c.prTestsOnReplica);
      const b = cross.filter((c) => c.replicaTestsOnPr);
      const aOk = a.filter((c) => c.prTestsOnReplica.status === 'ok' && c.prTestsOnReplica.failed === 0).length;
      const bOk = b.filter((c) => c.replicaTestsOnPr.status === 'ok' && c.replicaTestsOnPr.failed === 0).length;
      claims.push(claim('cruce', 'El PR y las réplicas se comportan igual ante los tests del otro',
        aOk === a.length && bOk === b.length ? 'reproducido' : 'parcial',
        `${aOk} de ${a.length} réplicas pasan los tests del PR · el PR pasa los tests de ${bOk} de ${b.length} réplicas`,
        cross.flatMap((c) => [c.prTestsOnReplica && { label: `Tests del PR sobre ${c.label}`, artifact: `cross-${c.replica}-prtests.log` }, c.replicaTestsOnPr && { label: `Tests de ${c.label} sobre el PR`, artifact: `cross-${c.replica}-onpr.log` }].filter(Boolean))));
    }
  } else {
    claims.push(claim('replicas', 'Similitud textual de alternativas (no prueba equivalencia)', ...notRun(ctx.options.agents.length ? `Ninguna réplica válida: ${(replicas || []).map((r) => `${r.label} ${r.status}`).join(' · ').slice(0, 300)}` : 'Verificación rápida: no se han lanzado réplicas.')));
  }

  const kinds = {};
  for (const f of files) { kinds[f.kind] ||= { files: 0, lines: 0 }; kinds[f.kind].files++; kinds[f.kind].lines += f.add + f.del; }

  // Code shown to the reader for each residue item: the PR's own lines for that range.
  for (const item of routed.residue.items) {
    const f = files.find((x) => x.path === item.file);
    const hs = (f?.hunks || []).filter((h) => h.newStart <= item.end && h.newStart + Math.max(h.newLines, 1) - 1 >= item.start);
    item.code = hs.slice(0, 6).map((h) => ({ at: h.newStart, removed: h.removed.slice(0, 40), added: h.added.slice(0, 60) }));
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    project: { id: project.id, name: project.name },
    pr: { id: pr.id, branch: pr.branch, direction: pr.direction, title: pr.title, head: it.headSha, base: project.base, baseSha: it.baseSha, commits: it.commits.map((c) => ({ sha: c.sha.slice(0, 9), subject: c.subject, author: c.author })) },
    requirement: requirement ? { id: requirement.id, title: requirement.title, url: requirement.url, missing: !!requirement.missing, excerpt: (requirement.body || '').slice(0, 700) } : null,
    provenance: { status: it.provenance.status, entireInstalled: it.provenance.entireInstalled, notes: it.provenance.notes, checkpoints: it.provenance.checkpoints.map((c) => ({ commit: c.commit, checkpoint: c.checkpoint, source: c.source })) },
    options: ctx.options,
    totals, kinds,
    files: files.slice(0, 500).map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del, status: f.status })),
    toolchain: { kind: toolchain.kind, describe: toolchain.describe, sdk: ctx.env.dotnet },
    recommendation: routed.recommendation,
    lane: routed.lane,
    rules: routed.rules,
    claims,
    questions: routed.questions,
    residue: routed.residue,
    notChecked: routed.notChecked,
    audit: routed.audit,
    areas: ctx.areas,
    l1: { groups: groups.map((g) => ({ ...g, anomalies: g.anomalies.slice(0, 10) })) },
    l2: l2 && !l2.skipped ? l2 : null,
    mutation: mutation.skipped ? { skipped: true, reason: mutation.reason, mutants: [] } : mutation,
    rewind: ctx.rewind?.skipped ? { skipped: true, reason: ctx.rewind.reason, steps: [] } : ctx.rewind ? { steps: ctx.rewind.steps, total: ctx.rewind.total, needed: ctx.rewind.needed, untested: ctx.rewind.untested } : null,
    budget: ctx.budget || null,
    l3: compare ? {
      n: compare.n, need: compare.need,
      replicas: replicas.map((r) => ({ id: r.id, label: r.label, model: r.model, ok: r.ok, status: r.status, ms: r.ms, lines: r.lines, files: r.files.length, summary: r.summary, decisions: r.decisions, cost: r.cost, patchFile: r.patchFile, self: r.self, confined: r.confined, mission: r.mission })),
      regions: compare.regions.map((r) => ({ id: r.id, file: r.file, kind: r.kind, label: r.label, newStart: r.newStart, newEnd: r.newEnd, lines: r.lines, cells: r.cells, same: r.same, n: r.n, verdict: r.verdict })),
      omissions: compare.omissions,
      cross: cross ? [...cross] : null,
    } : null,
    timing: { totalMs: Date.now() - started, stages },
    cost: { usd: Math.round(costUsd * 1000) / 1000 },
  };
}

export async function verify(args) {
  if (args.options.mode !== 'completo') return verifyBaseline(args);
  const { verifyComplete } = await import('./complete.js');
  return verifyComplete(args, { intake, verifyBaseline });
}
