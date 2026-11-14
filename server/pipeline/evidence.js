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
  if (!result || result.ran === 0 || result.executionComplete === false || !['passed', 'failed', 'harness-incompatible'].includes(result.status)) return 'pending';
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

const uniqueEvidence = evidence => [...new Map(evidence.map(e => [`${e.version}:${e.id}`, e])).values()];
const executed = e => e.ran !== 0 && e.executionComplete !== false && (e.tests || []).length > 0 && ['passed', 'failed', 'harness-incompatible'].includes(e.status);
const testFingerprint = tests => sha256(JSON.stringify(tests.map(t => [t.name, t.outcome, t.error || '']).sort((a, b) => a[0].localeCompare(b[0]))));

// This is an auditable engineering rubric, not a calibrated probability of correctness.
export function confidenceScore({ contract, attacks, originals, baseline, confirmed, verified, findings, pending, support = [] }) {
  const expectations = contract?.expectations || [];
  const weight = e => e.critical ? 3 : 1;
  const failedIds = new Set(confirmed.flatMap(c => c.expectations));
  const supported = expectations.filter(e => isGrounded(e) && verified.has(e.id) && !failedIds.has(e.id));
  const supportWeight = supported.reduce((n, e) => n + weight(e), 0);
  const totalWeight = expectations.reduce((n, e) => n + weight(e), 0);
  const passed = originals.filter(e => executed(e) && e.status === 'passed');
  const suites = passed.filter(e => e.scope === 'relevant-suite');
  const contractRefs = [...new Set([...support.flatMap(s => s.evidence), ...findings.filter(f => ['refuted', 'candidate-only'].includes(f.classification)).flatMap(f => f.outcomes.filter(o => o.version === 'original' && o.outcome === 'passed').map(o => o.evidence))])];
  const validFindings = findings.filter(f => ['refuted', 'candidate-only'].includes(f.classification));
  const risks = new Set(validFindings.map(f => {
    const a = attacks.find(a => a.id === f.attack);
    return a.riskKey || a.mission || [...a.expectations].sort().join(',');
  }));
  // Cached returns are not independent repetitions. Compare the full execution identity.
  const repeats = originals.filter(e => executed(e) && !e.reused && e.codeHash && e.testHash && e.contractHash && e.commands && e.environment);
  const groups = new Map();
  for (const e of repeats) {
    const key = evidenceKey(e) + ':' + testFingerprint(e.tests);
    groups.set(key, [...(groups.get(key) || []), e.id]);
  }
  const repetition = [...groups.values()].find(ids => new Set(ids).size >= 2) || [];
  const components = [
    { id: 'contract', label: 'Cumplimiento del requisito', max: 4, earned: totalWeight ? 4 * supportWeight / totalWeight : 0, expectations: supported.map(e => e.id), evidence: contractRefs, reason: `${supported.length}/${expectations.length} expectativas respaldadas; ponderadas por criticidad.` },
    { id: 'regressions', label: 'Preservación de comportamientos', max: 3, earned: suites.length && baseline?.l2?.suite?.ok && baseline.l2.suite.ran > 0 ? 3 : 0, expectations: [], evidence: suites.map(e => e.id), reason: suites.length ? 'Suite pertinente del original ejecutada; referencia de integración contrastada.' : 'Suite pertinente del original pendiente o con fallos.' },
    { id: 'attacks', label: 'Ataques válidos superados', max: 2, earned: Math.min(2, 2 * risks.size / 3), expectations: [...new Set(validFindings.flatMap(f => f.expectations))], evidence: contractRefs, reason: `${risks.size} grupos de riesgo comprobados; objetivo ${3}. Repeticiones del mismo grupo no suman.` },
    { id: 'reproducibility', label: 'Reproducibilidad', max: 1, earned: repetition.length ? 1 : 0, expectations: [], evidence: repetition, reason: repetition.length ? 'Ejecuciones independientes coinciden con la misma identidad de código, pruebas, contrato, comandos y entorno.' : 'Falta repetición independiente con la misma identidad de ejecución.' },
  ].map(c => ({ ...c, earned: Math.round(c.earned * 100) / 100 }));
  const caps = [];
  const criticalFailure = confirmed.some(c => c.expectations.some(id => expectations.find(e => e.id === id)?.critical));
  const criticalPending = expectations.some(e => e.critical && (!isGrounded(e) || !verified.has(e.id)) && !failedIds.has(e.id));
  if (criticalFailure) caps.push({ max: 2, reason: 'Incumplimiento crítico confirmado en el original.' });
  else if (confirmed.length) caps.push({ max: 4, reason: 'Incumplimiento confirmado en el original.' });
  if (criticalPending) caps.push({ max: 5, reason: 'Expectativas críticas sin evidencia suficiente.' });
  if (pending.length) caps.push({ max: 7, reason: 'Revisión incompleta, ambigua o inestable.' });
  const hasExecution = originals.some(executed) || baseline?.l2?.suite?.ran > 0;
  const raw = Math.floor(components.reduce((n, c) => n + c.earned, 0) + 0.0001);
  const value = hasExecution && expectations.length ? Math.min(raw, ...caps.map(c => c.max)) : null;
  return { version: 1, value, max: 10, label: 'Confianza de revisión', heuristic: true,
    scope: originals.find(e => e.environment?.scope)?.environment.scope || 'Comportamientos del contrato y suite pertinente declarados',
    components, caps, explanation: value === null ? 'No evaluable: falta contrato o ejecución de pruebas.' : 'Rúbrica de evidencia, no probabilidad de ausencia de errores. Más presupuesto puede revelar fallos y reducir la nota.' };
}

export function adjudicate({ contract, attacks = [], evidence = [], baseline, semantic, complete, finalMissions = [], candidates = [], captureRequired = true, requiredFinalMissions = 3, extraPending = [] }) {
  const pending = [...extraPending], confirmed = [], findings = [], auditWarnings = [];
  const verified = new Set(); const support = [];
  if (!contract?.expectations?.length) pending.push('No testable contract');
  for (const ambiguity of contract?.ambiguities || []) pending.push(`Contract ambiguity unresolved: ${typeof ambiguity === 'string' ? ambiguity : JSON.stringify(ambiguity)}`);
  for (const e of contract?.expectations || []) if (e.critical && !isGrounded(e)) pending.push(`${e.id}: expectation pending`);
  const currentEvidence = uniqueEvidence(evidence.filter(e => e.contractHash === contract?.hash));
  const originals = currentEvidence.filter(e => e.version === 'original');
  for (const a of attacks) {
    const outcomes = currentEvidence.filter(e => e.attacks?.includes(a.id)).map(e => ({
      version: e.version, evidence: e.id, artifact: e.artifact || `evidence-${e.id}.json`, outcome: attackOutcome(a, e), attempt: e.attempt, reused: !!e.reused,
    }));
    const f = { attack: a.id, hypothesis: a.hypothesis, scenario: a.scenario, expected: a.expected, agent: a.attacker || a.agent, originCandidate: a.originCandidate || a.candidate,
      expectations: a.expectations || [], sources: (a.expectations || []).flatMap(id => contract?.expectations?.find(e => e.id === id)?.sources || []),
      classification: 'pending', outcomes, evidence: outcomes.map(o => o.evidence), reason: '' };
    findings.push(f);
    const invalid = semantic?.invalidAttacks?.find(x => x.id === a.id);
    if (a.status !== 'admitted' || invalid) {
      f.classification = a.status === 'invalid' || invalid ? 'invalid-test' : 'pending';
      f.reason = invalid?.reason || a.error || a.pendingReason || `Attack ${a.status}`;
      if (invalid) pending.push(`${a.id}: semantic reviewer disputes test validity`);
      continue;
    }
    if (!a.expectations?.length || !a.expectations.every(id => isGrounded(contract?.expectations?.find(e => e.id === id)))) {
      f.classification = 'invalid-test'; f.reason = 'Expected outcome lacks an independent grounded source';
      pending.push(`${a.id}: ungrounded expectation`); continue;
    }
    const originalOutcomes = originals.filter(e => e.attacks?.includes(a.id)).map(e => ({ id: e.id, outcome: attackOutcome(a, e), attempt: e.attempt,
      fingerprint: testFingerprint((e.tests || []).filter(t => a.names.some(n => t.name.includes(n)))) }));
    const fail = originalOutcomes.filter(o => o.outcome === 'failed');
    const independentFailures = fail.filter(o => !originals.find(e => e.id === o.id)?.reused);
    const pass = originalOutcomes.filter(o => o.outcome === 'passed');
    if (fail.length && pass.length || new Set(fail.map(x => x.fingerprint)).size > 1) {
      pending.push(`${a.id}: unstable result`); f.classification = 'unstable'; f.reason = 'Original executions disagree; no defect confirmed.';
    } else if (independentFailures.length >= 2) {
      const baseOutcomes = outcomes.filter(o => o.version === 'historical-base').map(o => o.outcome);
      const attribution = baseOutcomes.includes('passed') && !baseOutcomes.includes('failed') ? 'regression-from-base' : baseOutcomes.includes('failed') ? 'pre-existing-or-unfixed-contract-violation' : 'base-comparison-pending';
      confirmed.push({ attack: a.id, expectations: a.expectations, evidence: independentFailures.map(e => e.id), baseOutcomes, attribution });
      f.classification = 'confirmed-original'; f.attribution = attribution; f.reason = 'Grounded original failure reproduced in separate executions.';
    } else if (fail.length) {
      pending.push(`${a.id}: failure needs reproduction`); f.classification = 'original-failure-unconfirmed'; f.reason = 'Original failure needs an independent reproduction.';
    } else if (pass.length) {
      for (const id of a.expectations) verified.add(id);
      f.classification = outcomes.some(o => !['original', 'historical-base'].includes(o.version) && o.outcome === 'failed') ? 'candidate-only' : 'refuted';
      f.reason = f.classification === 'candidate-only' ? 'The original passes; a candidate failure does not condemn it.' : 'The original passes this grounded scenario; the allegation was not reproduced.';
    } else { pending.push(`${a.id}: test not executed`); f.reason = 'No complete original execution for this scenario.'; }
  }
  // Existing tests count only through an explicit source-backed mapping. A suite
  // total is not evidence that any particular contract expectation was checked.
  for (const expectation of contract?.expectations || []) {
    if (!isGrounded(expectation) || !expectation.existingTests?.length) continue;
    const names = expectation.existingTests.filter(name => typeof name === 'string' && /^[\w.]+$/.test(name));
    if (names.length !== expectation.existingTests.length) continue;
    const refs = [];
    const groundedNames = names.every(name => {
      const short = name.split('.').at(-1);
      const source = expectation.sources.some(ref => (ref.quote || '').includes(short) && contract.sources?.some(s => s.id === ref.id && s.kind === 'test' && s.text.includes(ref.quote)));
      if (!source) return false;
      const observations = originals.filter(e => executed(e) && e.scope === 'relevant-suite').flatMap(e => (e.tests || []).filter(t => t.name === name || t.name.endsWith('.' + name)).map(t => ({ outcome: t.outcome, evidence: e.id })));
      if (!observations.length || observations.some(t => t.outcome !== 'Passed')) return false;
      refs.push(...observations.map(t => t.evidence)); return true;
    });
    if (groundedNames) { verified.add(expectation.id); support.push({ expectation: expectation.id, tests: names, evidence: [...new Set(refs)], source: 'existing-tests' }); }
  }
  for (const c of confirmed) for (const id of c.expectations) verified.delete(id);
  if (!verified.size && !confirmed.length) pending.push('No contract behavior has executable support');
  for (const e of contract?.expectations || []) if (e.critical && !verified.has(e.id) && !confirmed.some(c => c.expectations.includes(e.id))) pending.push(`${e.id}: no executable support`);
  if (!baseline?.l2?.suite?.ok || !baseline.l2.suite.ran) pending.push('Baseline/integration suite incomplete');
  if (!originals.some(e => executed(e) && e.scope === 'relevant-suite' && e.status === 'passed') || originals.some(e => e.scope === 'relevant-suite' && e.status === 'failed')) pending.push('Original relevant suite incomplete or failing');
  if (!complete) pending.push('Review budget exhausted or pipeline incomplete');
  if (finalMissions.filter(m => m.complete).length < requiredFinalMissions) pending.push('Final missions incomplete');
  if (!semantic || semantic.ambiguities?.length || semantic.contradictions?.length) pending.push('Semantic review missing or unresolved');
  // Candidate quality and provenance are recorded separately from the original's correctness.
  if (!candidates.some(c => c.final && currentEvidence.some(e => e.version === c.id && e.scope === 'relevant-suite' && e.status === 'passed'))) auditWarnings.push('Final candidate did not complete a passing relevant suite; this alone does not invalidate the original.');
  if (captureRequired && !candidates.some(c => c.checkpoint?.status === 'captured')) auditWarnings.push('No candidate Entire checkpoint recovered.');
  if (baseline?.mutation?.valid === 0) auditWarnings.push('No valid mutation was executed; attack sensitivity remains unmeasured.');
  const status = confirmed.length ? 'request-changes' : pending.length ? 'insufficient-evidence' : 'ready-for-human';
  const score = confidenceScore({ contract, attacks, originals, baseline, confirmed, verified, findings, pending, support });
  return { status, label: { 'request-changes': 'Pedir cambios', 'insufficient-evidence': 'Evidencia insuficiente', 'ready-for-human': 'Lista para aprobación humana' }[status],
    confirmed, verified: [...verified], pending: [...new Set(pending)], findings, support, score, auditWarnings,
    residualRisks: ['Tests cover declared behaviors, not all inputs.', 'Local Windows isolation is a working-copy boundary, not an OS security sandbox.'], semantic };
}
