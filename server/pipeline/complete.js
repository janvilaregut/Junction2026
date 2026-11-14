// The full pipeline owns one wall-clock budget. Models propose; execution supplies evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, sha256, writeJSON, redact, ROOT } from '../util.js';
import { git, out, parseDiff } from '../git.js';
import { within, initialPopulation, priority, execution } from '../execution.js';
import { artifactManifest } from '../integrity.js';
import { models, session, setupCapture, checkpoint, providerPreflight, usageTokens } from '../agents.js';
import { blindCopy } from './sandbox.js';
import { analyzeSymbols, reconstructContract, behaviorGroups } from './contract.js';
import { evaluate, runnerQueue, validateAttack, attackOutcome, chooseCandidates, adjudicate, isGrounded } from './evidence.js';
import { harnessPath, harnessContent, scenarioInstructions, materializeScenario } from './messagepack-harness.js';

const ID = ['-c', 'user.name=Katse', '-c', 'user.email=katse@localhost', '-c', 'commit.gpgsign=false'];
const stripCandidate = c => { const { dir, ...rest } = c; return rest; };
const strategies = ['Minimal targeted repair preserving every unrelated diagnostic', 'Explicit symbol matching and generic arity handling', 'Conservative validation with edge-case preservation', 'Alternative control flow with the smallest public surface change'];

export function verifyComplete(args, dependencies) {
  const selected = { ...models(), ...args.options.providers };
  for (const role of ['fast', 'review']) if (!/^google\/[\w.-]+$/.test(selected[role])) throw new Error(`Proveedor no compatible para ${role}`);
  if (selected.diverse !== 'verda-nemotron/nemotron') throw new Error('El proveedor diverso debe ser Verda Nemotron');
  return execution.run({ ...execution.getStore(), models: selected }, () => executeComplete(args, dependencies));
}

async function executeComplete(args, { intake, verifyBaseline }) {
  const { project, pr, options, runDir, emit } = args;
  const started = Date.now(), budgetMs = Math.min(900000, options.budgetMs || 900000);
  const deadline = started + budgetMs, generationEnd = started + budgetMs * 2 / 3, finalEnd = deadline - Math.min(60000, budgetMs / 15);
  const artifacts = path.join(runDir, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const tempRoot = path.join(os.tmpdir(), 'katse', path.basename(runDir)); fs.mkdirSync(tempRoot, { recursive: true });
  const state = { version: 2, contract: null, candidates: [], attacks: [], evidence: [], sessions: [], groups: [], finalMissions: [], pending: [], budget: { limitMs: budgetMs, generationEnd, finalEnd, deadline, concurrency: { models: 2, runners: 1 }, maxCandidates: 6, maxGenerations: 2, formula: 'min(4, 2 + ceil(log2(max(1,G))) + H)', priorityFormula: 'R*(1+U+D)/(C*(1+N))', heuristics: true } };
  let it, baseline, baselineTask, original, reviewerDir, complete = false, semantic = null;
  const save = () => writeJSON(path.join(artifacts, 'pipeline.json'), { ...state, candidates: state.candidates.map(stripCandidate) });
  const pending = (where, error) => { const text = redact(error.message || error); if (error.sessionRecord) state.sessions.push(error.sessionRecord); state.pending.push({ where, text }); emit({ type: 'log', text: `${where}: ${text}` }); save(); };
  const recordSession = r => { state.sessions.push({ id: r.id, model: r.model, sessionId: r.sessionId, history: r.history, artifact: r.artifact, ms: r.ms }); save(); return r.result; };
  const call = async opts => recordSession(await session({ artifacts, ...opts }));
  const test = async (v, full = false, force = false) => {
    const r = await evaluate({ version: v, attacks: state.attacks, contract: state.contract, tc: it.toolchain, environment: state.environment, artifacts, emit, full, force, suiteOverlay: [...(state.harness || []), ...(full ? state.suiteOverlay || [] : [])] });
    state.evidence.push(r); save(); return r;
  };

  async function candidate(index, parent = null) {
    const id = `C${index + 1}`, dir = path.join(tempRoot, id), model = index % 2 ? models().diverse : models().fast;
    const group = [...state.groups].sort((a, b) => priority(b) - priority(a))[0];
    const c = { id, dir, version: 1, generation: parent ? 2 : 1, parents: parent ? [parent.id] : [], model, group: group?.id, strategy: strategies[index % strategies.length], status: 'pending', reason: parent ? 'Correct observed failures or explore an unresolved decision in a surviving strategy' : 'Independent reconstruction from the historical base', isolation: { base: it.mergeBase, history: 'fresh single commit, no remotes', proposedPatchVisible: false, changedLocationsVisible: true, excerptSelection: 'prior source at locations selected from the diff', osSandbox: false } };
    state.candidates.push(c); emit({ type: 'candidate', id, status: c.status }); save(); const begin = Date.now();
    try {
      await blindCopy(it.repo, dir, it.mergeBase); await setupCapture(dir);
      if (parent) await git(dir, ['apply', '--whitespace=nowarn', path.join(artifacts, parent.patch)]);
      const feedback = parent ? state.evidence.filter(e => e.version === parent.id).map(e => ({ status: e.status, failures: e.tests?.filter(t => t.outcome === 'Failed'), log: e.log && fs.readFileSync(path.join(artifacts, e.log), 'utf8').slice(-7000) })) : [];
      const result = await session({ dir, artifacts, role: `build-${id}`, model, timeout: 180000,
        prompt: `Implement the contract in this pre-change repository. You have NOT been given the proposed patch. Change product C# source only, no tests, docs, project/config files or commands. Do not commit. Strategy: ${c.strategy}. Use the supplied base excerpts to avoid broad exploration. At most THREE read/grep calls before applying the edit; reserve tool steps for editing. Do not browse tests. Return {"summary":"...","decisions":["..."],"unresolved":["..."]}.\nContract: ${JSON.stringify({ expectations: state.contract.expectations, sources: state.contract.sources.filter(s => s.kind === 'requirement') })}\nRelevant base excerpts: ${state.baseContext}\nRelevant base symbols: ${JSON.stringify(state.analysis.symbols.map(s => ({file:s.file,name:s.name,start:s.start}))).slice(0, 4000)}\nParent feedback: ${JSON.stringify(feedback)}`, validate: x => typeof x.summary === 'string' });
      recordSession(result); c.session = { id: result.sessionId, artifact: result.artifact }; c.summary = result.result.summary; c.decisions = result.result.decisions; c.unresolved = result.result.unresolved;
      await git(dir, ['add', '-A']);
      const changed = (await out(dir, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      if (changed.some(p => !p.startsWith('src/') || !p.endsWith('.cs'))) throw new Error('Candidate changed paths outside allowed product C# scope');
      const patch = (await git(dir, ['diff', '--cached', '--no-ext-diff', '--binary', 'HEAD'])).stdout;
      if (!patch.trim()) { c.status = 'empty'; return; }
      c.patchHash = sha256(patch); c.patch = `${id}.patch`; fs.writeFileSync(path.join(artifacts, c.patch), patch);
      c.tree = await out(dir, ['write-tree']); c.lines = parseDiff(patch).reduce((n, f) => n + f.add + f.del, 0);
      const duplicate = state.candidates.find(other => other.id !== id && other.tree === c.tree && other.status === 'built');
      if (duplicate) { c.status = 'duplicate'; c.duplicateOf = duplicate.id; return; }
      await git(dir, [...ID, 'commit', '-m', `Katse candidate ${id}`]); c.commit = await out(dir, ['rev-parse', 'HEAD']);
      c.checkpoint = await checkpoint(dir, c.commit, artifacts, id); c.status = 'built';
    } catch (e) { if (e.sessionRecord) state.sessions.push(e.sessionRecord); c.status = e.name === 'DeadlineError' || /timeout/.test(e.message) ? 'timeout' : 'failed'; c.error = redact(e.message); }
    finally { c.ms = Date.now() - begin; if (group) { group.explored++; group.estimatedMs = (group.estimatedMs + c.ms) / 2; } emit({ type: 'candidate', id, status: c.status, tree: c.tree }); save(); }
  }

  async function attack(mission, index, final = false) {
    const id = `A${state.attacks.length + 1}-${index}-${final ? 'final' : 'initial'}`;
    const attacker = index % 2 ? models().diverse : models().fast, defender = index % 2 ? models().fast : models().diverse;
    const schema = state.harness?.length ? scenarioInstructions : '{"hypothesis":"possible failing behavior","scenario":"valid input","expected":"required output","expectations":["E1"],"names":["KatseUniqueTest"],"files":[{"path":"tests/.../KatseUniqueTests.cs","content":"complete compilable C# test file"}]}';
    const labels = final ? index % 2 ? { A: state.frozen.selected, B: 'original' } : { A: 'original', B: state.frozen.selected } : null;
    const patchFor = id => id === 'original' ? state.proposedPatch : fs.readFileSync(path.join(artifacts, state.candidates.find(c => c.id === id).patch), 'utf8');
    const blinded = labels ? `\nAnonymous frozen implementation A:\n${patchFor(labels.A)}\nAnonymous frozen implementation B:\n${patchFor(labels.B)}` : '';
    const allowed = state.contract.expectations.filter(isGrounded);
    const context = `Use ONLY supplied context; no tools. Cite ONLY these allowed expectation IDs: ${allowed.map(e => e.id).join(', ')}. Choose one precise scenario and only expectations this test actually checks. Do NOT make assertions about pending/unspecified behaviors. Contract: ${JSON.stringify(allowed)}\nTest projects: ${JSON.stringify(it.toolchain.testProjects)}\nTest conventions and source excerpts: ${state.reviewContext}${blinded}\nExisting attacks (choose a NEW case): ${JSON.stringify(state.attacks.map(a => ({ hypothesis: a.hypothesis, scenario: a.scenario })))}`;
    let a = { id, mission, final, attacker, defender, labels, status: 'pending' }; state.attacks.push(a); save();
    try {
      const result = await call({ dir: reviewerDir, role: `attack-${id}`, model: attacker, timeout: final ? 65000 : 90000,
        prompt: `Design ONE executable adversarial C# test for mission: ${mission}. Use the supplied test conventions. Do not edit or execute anything. Return JSON ${schema}. Use unique file/class/method prefix Katse${id.replace(/-/g, '')}. The expected result must follow the cited contract; NEVER assert outputs based on majority voting or candidate agreement. Use an existing test verifier API exactly as seen in tests. ${context}`, validate: x => state.harness?.length ? !!x.test : Array.isArray(x.files) });
      Object.assign(a, state.harness?.length ? materializeScenario(result, id) : result); validateAttack(a, state.contract, it.toolchain.testProjects);
      const defense = await call({ dir: reviewerDir, role: `defense-${id}`, model: defender, timeout: final ? 40000 : 60000,
        prompt: `Validate the TEST: valid scenario, expectation grounded in contract, executable harness. Admit valid tests even when you expect the implementation to PASS. A hypothesis predicting a bug can be false while the test is useful. Lack of evidence for a bug is NEVER grounds to reject a test; execution must refute it. Reject only invalid input, unsupported expectation, incompatible harness or material requirement ambiguity. You are defending anonymous version ${index % 2 ? 'A' : 'B'}. A failure is NOT evidence until executed. Do not edit. Return {"admit":true|false,"reason":"...","revision":"..."}. ${context}\nAttack: ${JSON.stringify(a)}`, validate: x => typeof x.admit === 'boolean' });
      a.defense = defense;
      if (!defense.admit && defense.revision) {
        const revised = await call({ dir: reviewerDir, role: `revise-${id}`, model: attacker, timeout: 40000, prompt: `One permitted revision to this attack. Return ${schema}. Address the defense or return {"withdraw":true}. Do not edit files. ${context}\nAttack:${JSON.stringify(a)}\nDefense:${JSON.stringify(defense)}`, validate: x => x.withdraw === true || (state.harness?.length ? !!x.test : Array.isArray(x.files)) });
        if (revised.withdraw) { a.status = 'withdrawn'; return a; }
        Object.assign(a, state.harness?.length ? materializeScenario(revised, id) : revised); validateAttack(a, state.contract, it.toolchain.testProjects);
        // One revision cannot overrule a substantive requirement dispute by fiat.
        a.status = 'disputed'; a.pendingReason = 'Revised test requires independent adjudication';
      } else a.status = defense.admit ? 'admitted' : 'disputed';
    } catch (e) { if (e.sessionRecord) state.sessions.push(e.sessionRecord); a.status = 'invalid'; a.error = redact(e.message); }
    finally { a.hash = sha256(JSON.stringify({ files: a.files, expectations: a.expectations, contract: state.contract.hash })); writeJSON(path.join(artifacts, `${id}.json`), a); emit({ type: 'attack', id, status: a.status, mission }); save(); }
    return a;
  }

  try {
    await within(generationEnd, async () => {
      state.providers = await providerPreflight(); emit({ type: 'log', text: 'Proveedores y herramientas accesibles' }); save();
      it = await intake(project, pr); state.input = { proposed: it.headSha, proposedRef: pr.ref, target: it.baseSha, targetRef: project.base, historicalBase: it.mergeBase, requirement: it.requirement };
      // Pin input refs even if the user's branches move while agents are working.
      const frozenProject = { ...project, base: it.baseSha }, frozenPr = { ...pr, ref: it.headSha };
      baselineTask = runnerQueue.use(() => verifyBaseline({ ...args, emit: e => { if (e.type === 'stage' && ['l3', 'informe'].includes(e.id)) return; emit(e); }, project: frozenProject, pr: frozenPr, options: { ...options, mode: 'rapido', agents: [], keepTrees: true, scratchRoot: path.join(tempRoot, 'baseline') } })).then(b => { baseline = b; return b; }).catch(e => pending('baseline', e));
      const contractDir = path.join(tempRoot, 'contract'); await blindCopy(it.repo, contractDir, it.mergeBase); await setupCapture(contractDir);
      reviewerDir = path.join(tempRoot, 'reviewer'); await blindCopy(it.repo, reviewerDir, it.headSha); await setupCapture(reviewerDir);
      const [contract, analysis] = await Promise.all([reconstructContract(it, contractDir, artifacts, emit), analyzeSymbols(it, contractDir, artifacts)]);
      state.contract = contract; state.analysis = analysis; state.groups = behaviorGroups(it, analysis, contract); state.budget.initialCandidates = initialPopulation(state.groups);
      state.sessions.push(...(contract.sessionRecords || []));
      state.reviewContext = ''; state.baseContext = '';
      for (const f of it.files.filter(f => f.kind === 'source')) {
        const lines = (await out(it.repo, ['show', `${it.mergeBase}:${f.path}`])).split('\n');
        state.baseContext += `\nBASE FILE ${f.path}\n` + f.hunks.map(h => lines.slice(Math.max(0, h.oldStart - 12), h.oldStart + h.oldLines + 12).join('\n')).join('\n').slice(0, 12000);
      }
      state.harness = String(pr.branch).includes('2283') && it.toolchain.testProjects.some(p => p.endsWith('MessagePack.SourceGenerator.Tests.csproj')) ? [{ path: harnessPath, content: harnessContent }] : [];
      if (state.harness.length) writeJSON(path.join(artifacts, 'harness.json'), state.harness);
      state.proposedPatch = await out(it.repo, ['diff', it.mergeBase, it.headSha, '--', ...it.files.filter(f => f.kind === 'source').map(f => f.path)]);
      state.suiteOverlay = [];
      for (const f of it.files.filter(f => f.kind === 'test' || f.kind === 'source')) {
        const text = await out(it.repo, ['show', `${it.headSha}:${f.path}`]);
        if (f.kind === 'test') state.suiteOverlay.push({ path: f.path, content: text });
        const lines = text.split('\n');
        if (!(state.harness.length && f.kind === 'test')) state.reviewContext += `\nFILE ${f.path}\n` + (f.kind === 'test' ? text.slice(-28000) : f.hunks.map(h => lines.slice(Math.max(0, h.newStart - 8), h.newStart + h.newLines + 8).join('\n')).join('\n')).slice(0, state.harness.length ? 9000 : 32000);
      }
      state.environment = { platform: process.platform, arch: process.arch, node: process.version, sdk: (await run('dotnet', ['--version'], { cwd: contractDir, timeout: 10000 })).stdout.trim(), projects: it.toolchain.testProjects, scope: 'C# relevant tests, default build configuration', runnerHash: sha256(fs.readFileSync(path.join(ROOT, 'server/pipeline/toolchain.js'))), dependencies: it.headSha };
      original = { id: 'original', dir: path.join(tempRoot, 'baseline/merged'), tree: await out(it.repo, ['rev-parse', `${it.headSha}^{tree}`]), commit: it.headSha };
      save();
      const tasks = Array.from({ length: state.budget.initialCandidates }, (_, i) => candidate(i));
      if (state.groups.length) tasks.push(attack('Variants of the reported failure and preservation of unrelated diagnostics', 0));
      else state.pending.push({where:'scope',text:'No executable source changes; only applicable contract and baseline analysis was performed.'});
      const results = await Promise.allSettled(tasks); for (const r of results) if (r.status === 'rejected') pending('initial-generation', r.reason);
      if (state.groups.length && !state.attacks.some(a => a.status === 'admitted') && Date.now() + 90000 < generationEnd) {
        const expectation = state.contract.expectations.find(isGrounded);
        if (expectation) await attack(`One minimal executable case for ${expectation.id}: ${expectation.behavior}. No claims about unspecified behavior.`, 10);
      }
      await baselineTask;
      if (!baseline) throw new Error('Baseline unavailable');
      state.input.integrationTree = await out(original.dir, ['rev-parse', 'HEAD^{tree}']);
      if (state.input.integrationTree !== original.tree) {
        // The merge integration is separately covered by baseline. Evaluate proposed commit itself.
        original.dir = path.join(tempRoot, 'original'); await blindCopy(it.repo, original.dir, it.headSha);
      }
      const initial = state.candidates.filter(c => c.status === 'built');
      if (state.attacks.some(a => a.status === 'admitted')) {
        await test(original);
        for (const c of initial) await test(c);
      }
      const survivors = chooseCandidates(initial, state.evidence, state.attacks); state.survivors = survivors.map(c => c.id);
      for (const g of state.groups) {
        const tested = new Set(state.attacks.filter(a => a.status === 'admitted').filter(a => state.evidence.some(e => e.version === 'original' && attackOutcome(a, e) !== 'pending')).flatMap(a => a.expectations));
        g.unverified = g.expectations.filter(id => !tested.has(id)).length / Math.max(1, g.expectations.length);
        const compared = state.attacks.filter(a => a.status === 'admitted');
        g.disagreement = compared.length ? compared.filter(a => new Set(state.evidence.map(e => attackOutcome(a, e)).filter(x => x !== 'pending')).size > 1).length / compared.length : null;
      }
      const wantsExploration = state.groups.some(g => g.unverified > 0 || g.disagreement > 0);
      if (wantsExploration && survivors.length && Date.now() + 60000 < generationEnd) {
        const descendants = await Promise.allSettled(survivors.slice(0, 2).map((p, i) => candidate(state.budget.initialCandidates + i, p)));
        for (const r of descendants) if (r.status === 'rejected') pending('descendant', r.reason);
        for (const c of state.candidates.filter(c => c.generation === 2 && c.status === 'built')) await test(c);
      }
    });
  } catch (e) { pending('generation', e); }

  // Ensure the baseline process has stopped before sharing its working directory.
  if (baselineTask) await baselineTask;
  if (it && state.groups.length && state.contract && original && baseline) {
    try {
      await within(finalEnd, async () => {
        const finalists = chooseCandidates(state.candidates, state.evidence, state.attacks);
        const champion = state.candidates.find(c => c.id === finalists[0]?.id);
        if (!champion) throw new Error('No candidate available for final comparison');
        champion.final = true; state.frozen = { A: original.tree, B: champion.tree, selected: champion.id, contract: state.contract.hash };
        emit({ type: 'log', text: `Comparación final congelada: original y ${champion.id}` });
        const missions = ['New variants of the original bug, not covered by previous attacks', 'Regression: preserve existing invalid-formatter diagnostics', 'Interaction between generic arity, constraints, nested types and accessibility'];
        await Promise.all(missions.map(async (mission, i) => {
          const a = await attack(mission, i + 1, true); state.finalMissions.push({ mission, attack: a.id, complete: a.status === 'admitted', roles: { attacker: a.attacker, defender: a.defender }, labels: a.labels });
        }));
        const originalResult = await test(original, true); await test(champion, true);
        const failures = state.attacks.filter(a => a.status === 'admitted' && attackOutcome(a, originalResult) === 'failed');
        if (failures.length) {
          await test(original, false, true);
          const baseDir = path.join(tempRoot, 'repro-base'); await blindCopy(it.repo, baseDir, it.mergeBase);
          await test({ id: 'historical-base', dir: baseDir, tree: await out(it.repo, ['rev-parse', `${it.mergeBase}^{tree}`]) });
        }
        complete = true;
      });
    } catch (e) { pending('final-attacks', e); }
  }

  try {
    if (state.contract && reviewerDir) await within(deadline - 2000, async () => {
      semantic = await call({ dir: reviewerDir, role: 'semantic-judge', model: models().review, timeout: Math.min(55000, deadline - Date.now() - 2000),
        prompt: `Audit this evidence. Explain in Spanish, at most FIVE concise sentences. Cite artifact names but do not repeat full hashes in prose. A passing attack refutes its hypothesis; it is not a requirement contradiction. Only list material unresolved requirement ambiguities or inconsistent evidence in ambiguities/contradictions. Do NOT decide correctness by votes or textual similarity. Cite artifact IDs, distinguish original-only/candidate-only failures, do not invent test results. Return {"explanation":"...","ambiguities":[],"contradictions":[],"artifactRefs":[],"invalidAttacks":[{"id":"attack identifier if invalid","reason":"..."}]}.\n${JSON.stringify({ contract: state.contract, attacks: state.attacks.map(({ files, ...a }) => a), evidence: state.evidence.map(({ tests, ...e }) => ({ ...e, failures: tests?.filter(t => t.outcome === 'Failed') })), pending: state.pending }).slice(0, 80000)}`, validate: x => typeof x.explanation === 'string' && Array.isArray(x.ambiguities) && Array.isArray(x.contradictions) });
    });
  } catch (e) { pending('semantic-judge', e); }
  state.verdict = adjudicate({ ...state, baseline, semantic, complete, finalMissions: state.finalMissions });
  for (const a of state.attacks.filter(a => a.status === 'disputed')) state.verdict.pending.push(`${a.id}: ${a.status}`);
  for (const p of state.pending) state.verdict.pending.push(`${p.where}: ${p.text}`);
  if (state.verdict.pending.length && state.verdict.status === 'ready-for-human') { state.verdict.status = 'insufficient-evidence'; state.verdict.label = 'Evidencia insuficiente'; }
  state.budget.elapsedMs = Date.now() - started; state.budget.exhausted = !complete && Date.now() >= finalEnd; state.budget.remainingMs = Math.max(0, deadline - Date.now());
  // Include recorded failed attempts and an analyst session whose reviewer timed out.
  const recorded = fs.readdirSync(artifacts).filter(f => f.endsWith('.json')).flatMap(f => {
    try { const r = JSON.parse(fs.readFileSync(path.join(artifacts, f), 'utf8')); const { prompt, result, ...metadata } = r; return r.role && r.model && r.history ? [metadata] : []; } catch { return []; }
  });
  state.sessions = [...new Map([...state.sessions, ...recorded].map(s => [s.id, s])).values()];
  state.budget.tokens = state.sessions.flatMap(s => s.history || []).flatMap(h => h.usage || []).reduce((n, t) => n + usageTokens(t), 0);
  state.budget.usageIncomplete = state.sessions.some(s => s.error && !s.history?.some(h => h.usage?.length));
  const fallback = { version: 1, createdAt: new Date().toISOString(), project: { id: project.id, name: project.name }, provenance: { status: 'none' }, pr: { id: pr.id, branch: pr.branch, direction: pr.direction, title: pr.title, head: it?.headSha || pr.sha || '', base: project.base, baseSha: it?.baseSha, commits: [] }, totals: it?.totals || { lines: 0, files: 0, added: 0, removed: 0 }, kinds: it?.kinds || {}, files: [], claims: [], questions: [], residue: { lines: it?.totals.lines || 0, total: it?.totals.lines || 0, items: [] }, notChecked: [], rules: { fired: [] }, timing: { stages: [] }, areas: [], toolchain: { kind: it?.toolchain.kind || 'none' }, options, cost: { usd: 0 } };
  const brief = { ...(baseline || fallback), version: 2, contract: state.contract, candidates: state.candidates.map(stripCandidate), attacks: state.attacks, evidence: state.evidence, budget: state.budget, verdict: state.verdict, input: state.input, environment: state.environment, finalMissions: state.finalMissions, analysis: state.analysis, providers: state.providers };
  brief.options = options; brief.timing.totalMs = Date.now() - started; brief.pr.base = project.base;
  brief.claims = brief.claims.filter(c => c.id !== 'replicas');
  brief.notChecked = brief.notChecked.filter(c => c.what !== 'Réplicas independientes');
  for (const item of brief.residue.items) item.why = (item.why || []).map(reason => reason.includes('sin réplicas') ? 'zona de código que requiere revisión: las pruebas solo respaldan los comportamientos declarados' : reason);
  brief.claims.push({ id: 'candidates', text: 'Alternativas reconstruidas desde la base', status: state.candidates.some(c => c.status === 'built') ? 'parcial' : 'no-ejecutado', detail: `${state.candidates.filter(c => c.status === 'built').length} alternativas distintas construidas; la comparación se basa en tests ejecutados`, evidence: state.candidates.filter(c => c.patch).map(c => ({ label: c.id, artifact: c.patch })) });
  brief.lane = { id: state.verdict.status === 'request-changes' ? 'devolver' : state.verdict.status === 'ready-for-human' ? 'reproducido' : 'decision', name: state.verdict.label, tone: state.verdict.status === 'request-changes' ? 'no' : state.verdict.status === 'ready-for-human' ? 'ok' : 'warn', summary: state.verdict.label };
  brief.recommendation = { id: state.verdict.status === 'ready-for-human' ? 'lista' : state.verdict.status === 'request-changes' ? 'cambios' : 'insuficiente', lista: state.verdict.status === 'ready-for-human', name: state.verdict.label, why: state.verdict.semantic?.explanation || 'Comprobaciones deterministas y alcance pendiente', text: state.verdict.label };
  brief.notChecked.push(...state.verdict.pending.map(what => ({ what, why: 'Evidencia pendiente del pipeline completo' })));
  brief.claims.push({ id: 'courtroom', text: 'Veredicto basado en ejecución y contrato versionado', status: state.verdict.status === 'ready-for-human' ? 'reproducido' : 'parcial', detail: state.verdict.label, evidence: [{ label: 'Contrato y trazabilidad', artifact: 'pipeline.json' }] });
  brief.binding = sha256(JSON.stringify({ head: brief.pr.head, contract: state.contract?.hash, evidence: state.evidence.map(e => e.id), tests: state.attacks.map(a => a.hash) }));
  save(); brief.artifactManifest = artifactManifest(artifacts); writeJSON(path.join(artifacts, 'brief.json'), brief); emit({ type: 'judgment', verdict: state.verdict, artifact: 'brief.json' });
  // No active workers remain. Retain candidate repositories with captured checkpoints for audit.
  return brief;
}
