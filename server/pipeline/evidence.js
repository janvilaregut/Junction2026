import fs from 'node:fs';
import path from 'node:path';
import { sha256, writeJSON, readJSON, run } from '../util.js';
import { Queue } from '../execution.js';

export const runnerQueue = new Queue(1);
export const evidenceKey = ({ codeHash, testHash, contractHash, environment, commands }) => sha256(JSON.stringify({ codeHash, testHash, contractHash, environment, commands }));
export const isGrounded = e => e && e.status !== 'pending' && e.sources?.length > 0;
const harnessFailure = t => /KATSE_HARNESS_INVALID_LIBRARY|Multiple diagnostic descriptors|No test matches|Could not load file or assembly|Test host process crashed/i.test(t.error || '');

export function validateAttack(a, contract, testProjects) {
  if (!a || !a.hypothesis || !a.expected || !a.scenario || !Array.isArray(a.expectations) || !a.expectations.length) throw new Error('attack-schema');
  if (!a.expectations.every(id => isGrounded(contract.expectations.find(e => e.id === id)))) throw new Error('unfounded-expectation');
  if (!Array.isArray(a.files) || !a.files.length || a.files.length > 2) throw new Error('attack-files');
  if (!Array.isArray(a.names) || !a.names.length || a.names.some(n => !/^[\w.]+$/.test(n))) throw new Error('attack-test-names');
  for (const f of a.files) {
    if (!f.path || path.isAbsolute(f.path) || f.path.includes('..') || f.path.includes('\\') || !f.path.endsWith('.cs') || !/Katse/.test(path.basename(f.path))) throw new Error('attack-path');
    if (!testProjects.some(p => f.path.startsWith(path.posix.dirname(p) + '/'))) throw new Error('harness-incompatible');
    if (typeof f.content !== 'string' || f.content.length > 45000) throw new Error('attack-content');
  }
  return a;
}

export function executionStatus(build, result, names = []) {
  if (!build.ok) return build.timedOut ? 'timeout' : 'build-error';
  if (result?.timedOut) return 'timeout';
  if (!result || result.ran === 0) return 'no-tests';
  if (names.some(n => !result.tests.some(t => t.name.includes(n)))) return 'harness-incompatible';
  if (result.executionComplete === false) return 'runner-error';
  if (result.tests.some(harnessFailure)) return 'harness-incompatible';
  if (result.failed > 0) return 'failed';
  return result.ok ? 'passed' : 'runner-error';
}

export async function evaluate({ version, attacks, contract, tc, environment, artifacts, emit, full = false, force = false, suiteOverlay = [], verifyCode = true }) {
  return runnerQueue.use(async () => {
    if (verifyCode) {
      const tree = await run('git', ['write-tree'], { cwd: version.dir, timeout: 10000 });
      const dirty = await run('git', ['diff', '--quiet'], { cwd: version.dir, timeout: 10000 });
      const extra = await run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: version.dir, timeout: 10000 });
      if (tree.code || tree.stdout.trim() !== version.tree || dirty.code || extra.stdout.split('\n').some(p => /\.(cs|csproj|props|targets)$/.test(p.trim()))) throw new Error(`Code changed after freeze: ${version.id}`);
    }
    const admitted = attacks.filter(a => a.status === 'admitted');
    const names = admitted.flatMap(a => a.names);
    const testHash = sha256(JSON.stringify({ attacks: admitted.map(a => ({ id: a.id, files: a.files, names: a.names })), suiteOverlay }));
    const commands = { build: tc.testProjects.map(p => ['dotnet', 'build', p, '-v', 'q', '-nologo', '-clp:NoSummary']), test: tc.testProjects.map(p => ['dotnet', 'test', p, '--no-build', '-v', 'q', '-nologo', '--results-directory', '.replica-trx', '--logger', `trx;LogFileName=${path.basename(p, '.csproj')}.trx`, ...(full ? [] : ['--filter', names.map(n => `FullyQualifiedName~${n}`).join('|')])]), full };
    const identity = { codeHash: version.tree, testHash, contractHash: contract.hash, environment, commands };
    let cacheKey = evidenceKey(identity), key = force ? `${cacheKey}-repeat-${Date.now()}` : cacheKey, file = path.join(artifacts, `evidence-${key}.json`);
    // .NET restore may resolve different dependency contents. Its cache lookup is
    // deferred until the build has produced the actual project.assets.json files.
    if (tc.kind !== 'dotnet' && !force && fs.existsSync(file)) { const saved = readJSON(file); return { ...saved, version: version.id, reusedFrom: saved.version, reused: true }; }
    const begin = Date.now(); const created = []; const backups = [];
    const rec = { id: key, cacheKey, attempt: force ? 'reproduction' : 'initial', version: version.id, commit: version.commit, workingDirectory: version.dir, ...identity, started: new Date().toISOString(), artifact: `evidence-${key}.json`, attacks: admitted.map(a => a.id), scope: full ? 'relevant-suite' : 'attacks' };
    try {
      for (const f of suiteOverlay) {
        const abs = path.resolve(version.dir, f.path);
        if (!abs.startsWith(path.resolve(version.dir) + path.sep) || !tc.testProjects.some(p => f.path.startsWith(path.posix.dirname(p) + '/'))) throw new Error('harness-incompatible: invalid suite overlay');
        backups.push([abs, fs.existsSync(abs) ? fs.readFileSync(abs) : null]);
        fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content);
      }
      for (const a of admitted) for (const f of a.files) {
        const abs = path.resolve(version.dir, f.path);
        if (!abs.startsWith(path.resolve(version.dir) + path.sep) || fs.existsSync(abs)) throw new Error('harness-incompatible: test would overwrite source');
        fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content); created.push(abs);
      }
      if (!full && names.length === 0) { rec.status = 'no-tests'; rec.tests = []; rec.ran = 0; }
      else {
        const build = await tc.build(version.dir); rec.build = { ok: build.ok, ms: build.ms };
        if (tc.kind === 'dotnet') {
          const dependencies = Object.fromEntries((tc.dependencyFiles || []).filter(p => fs.existsSync(path.join(version.dir, p))).map(p => [p, sha256(fs.readFileSync(path.join(version.dir, p)))]));
          identity.environment = { ...environment, restoredDependencies: dependencies };
          cacheKey = evidenceKey(identity); key = force ? `${cacheKey}-repeat-${Date.now()}` : cacheKey; file = path.join(artifacts, `evidence-${key}.json`);
          Object.assign(rec, identity, { id: key, cacheKey, artifact: `evidence-${key}.json` });
          if (build.ok && Object.keys(dependencies).length && !force && fs.existsSync(file)) { const saved = readJSON(file); return { ...saved, version: version.id, reusedFrom: saved.version, reused: true }; }
        }
        let test;
        if (build.ok) test = await tc.test(version.dir, full ? {} : { names });
        rec.status = executionStatus(build, test, names); rec.ran = test?.ran || 0; rec.tests = test?.tests || [];
        rec.executionComplete = test?.executionComplete === true;
        rec.exitCodes = test?.exitCodes || []; rec.passed = test?.passed || 0; rec.failed = test?.failed || 0;
        fs.writeFileSync(path.join(artifacts, `evidence-${key}.log`), `${build.log}\n${test?.log || ''}`);
        rec.log = `evidence-${key}.log`;
        for (const [i, trx] of (test?.trx || []).entries()) { const name = `evidence-${key}-${i}.trx`; fs.writeFileSync(path.join(artifacts, name), trx); (rec.trx ||= []).push(name); }
      }
    } catch (e) { rec.status = e.name === 'DeadlineError' ? 'timeout' : e.message.startsWith('harness-incompatible') ? 'harness-incompatible' : 'runner-error'; rec.error = e.message; }
    finally { for (const p of created) fs.rmSync(p, { force: true }); for (const [p, data] of backups) if (data === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, data); }
    rec.ms = Date.now() - begin; writeJSON(file, rec); emit?.({ type: 'result', version: rec.version, status: rec.status, evidence: rec.id, ran: rec.ran }); return rec;
  });
}

export function attackOutcome(attack, result) {
  // A malformed scenario must not erase completed tests in the same TRX batch.
  // Incomplete execution, however, remains pending even if a partial TRX exists.
  if (!result || result.executionComplete === false || !['passed', 'failed', 'harness-incompatible'].includes(result.status)) return 'pending';
  const selected = attack.names.flatMap(n => result.tests.filter(t => t.name.includes(n)));
  if (!selected.length || attack.names.some(n => !selected.some(t => t.name.includes(n)))) return 'pending';
  if (selected.some(harnessFailure)) return 'pending';
  return selected.some(t => t.outcome === 'Failed') ? 'failed' : selected.every(t => t.outcome === 'Passed') ? 'passed' : 'pending';
}

export function chooseCandidates(candidates, evidence, attacks) {
  const evaluated = candidates.filter(c => c.status === 'built');
  const scored = evaluated.map(c => {
    const r = [...evidence].reverse().find(e => e.version === c.id);
    const failures = r ? attacks.filter(a => attackOutcome(a, r) === 'failed').length + (['build-error', 'runner-error', 'no-tests', 'timeout'].includes(r.status) ? 100 : 0) : 100;
    const verified = new Set(attacks.filter(a => attackOutcome(a, r) === 'passed').flatMap(a => a.expectations)).size;
    return { ...c, fitness: { failures, verified } };
  });
  scored.sort((a, b) => a.fitness.failures - b.fitness.failures || b.fitness.verified - a.fitness.verified || a.lines - b.lines || a.ms - b.ms);
  if (scored.length < 2) return scored;
  const best = scored[0];
  const second = scored.slice(1).find(c => c.fitness.failures === best.fitness.failures && c.fitness.verified === best.fitness.verified && c.strategy !== best.strategy) || scored[1];
  return [best, second];
}

export function adjudicate({ contract, attacks, evidence, baseline, semantic, complete, finalMissions, candidates, captureRequired = true }) {
  const pending = []; const confirmed = []; const verified = new Set();
  if (!contract?.expectations?.length) pending.push('No testable contract');
  for (const e of contract?.expectations || []) if (e.critical && !isGrounded(e)) pending.push(`${e.id}: expectation pending`);
  const originals = [...new Map(evidence.filter(e => e.version === 'original' && e.contractHash === contract?.hash).map(e => [e.id, e])).values()];
  for (const a of attacks.filter(a => a.status === 'admitted')) {
    if (semantic?.invalidAttacks?.some(x => x.id === a.id)) { pending.push(`${a.id}: semantic reviewer disputes test validity`); continue; }
    const outcomes = originals.filter(e => e.attacks.includes(a.id)).map(e => ({ id: e.id, outcome: attackOutcome(a, e), attempt: e.attempt,
      fingerprint: sha256(JSON.stringify((e.tests || []).filter(t => a.names.some(n => t.name.includes(n))).map(t => [t.name, t.outcome, t.error || '']).sort((x,y) => x[0].localeCompare(y[0])))) }));
    const fail = outcomes.filter(o => o.outcome === 'failed');
    const pass = outcomes.filter(o => o.outcome === 'passed');
    if (fail.length && pass.length || new Set(fail.map(f => f.fingerprint)).size > 1) pending.push(`${a.id}: unstable result`);
    else if (fail.length >= 2 && a.expectations.every(id => isGrounded(contract.expectations.find(e => e.id === id)))) {
      const baseOutcomes = evidence.filter(e => e.version === 'historical-base' && e.contractHash === contract.hash && e.attacks.includes(a.id)).map(e => attackOutcome(a,e));
      confirmed.push({ attack: a.id, expectations: a.expectations, evidence: fail.map(e => e.id), baseOutcomes,
        attribution: baseOutcomes.includes('passed') && !baseOutcomes.includes('failed') ? 'regression-from-base' : baseOutcomes.includes('failed') ? 'pre-existing-or-unfixed-contract-violation' : 'base-comparison-pending' });
    }
    else if (fail.length) pending.push(`${a.id}: failure needs reproduction`);
    else if (pass.length) for (const id of a.expectations) verified.add(id);
    else pending.push(`${a.id}: test not executed`);
  }
  for (const e of contract?.expectations || []) if (e.critical && !verified.has(e.id) && !confirmed.some(c => c.expectations.includes(e.id))) pending.push(`${e.id}: no executable support`);
  if (!baseline?.l2?.suite?.ok || !baseline.l2.suite.ran) pending.push('Baseline/integration suite incomplete');
  if (baseline?.mutation?.valid === 0) pending.push('No valid mutation was executed');
  if (!complete) pending.push('Review budget exhausted or pipeline incomplete');
  if (finalMissions.filter(m => m.complete).length !== 3) pending.push('Final missions incomplete');
  if (!semantic || semantic.ambiguities?.length || semantic.contradictions?.length) pending.push('Semantic review missing or unresolved');
  if (!candidates.some(c => c.final && evidence.some(e => e.version === c.id && e.scope === 'relevant-suite' && e.status === 'passed'))) pending.push('Final candidate full suite incomplete');
  if (captureRequired && !candidates.some(c => c.checkpoint?.status === 'captured')) pending.push('No candidate Entire checkpoint recovered');
  const status = confirmed.length ? 'request-changes' : pending.length ? 'insufficient-evidence' : 'ready-for-human';
  return { status, label: { 'request-changes': 'Pedir cambios', 'insufficient-evidence': 'Evidencia insuficiente', 'ready-for-human': 'Lista para aprobación humana' }[status], confirmed, verified: [...verified], pending, residualRisks: ['Tests cover declared behaviors, not all inputs.', 'Local Windows isolation is a working-copy boundary, not an OS security sandbox.'], semantic };
}
