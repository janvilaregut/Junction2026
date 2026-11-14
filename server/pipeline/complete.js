// The full pipeline owns one wall-clock budget. Models propose; execution supplies evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, sha256, writeJSON, redact, ROOT } from '../util.js';
import { git, out, parseDiff } from '../git.js';
import { within, initialPopulation, priority, execution, TokenBudget } from '../execution.js';
import { resolveProfile } from '../profiles.js';
import { loadContinuation } from './resume.js';
import { applyProposal, deduplicateCandidates } from './proposals.js';
import { getSettings } from '../settings.js';
import { sourceBlocks } from './source-context.js';
import { intentInput, semanticPrompt, normalizeIntent, intentPending } from './intent.js';
import { artifactManifest } from '../integrity.js';
import { models, session, setupCapture, checkpoint, attachSession, providerPreflight, usageTokens } from '../agents.js';
import { blindCopy } from './sandbox.js';
import { analyzeSymbols, reconstructContract, behaviorGroups } from './contract.js';
import { evaluate, runnerQueue, validateAttack, attackOutcome, chooseCandidates, adjudicate, isGrounded } from './evidence.js';
import { harnessPath, harnessContent, scenarioInstructions, materializeScenario } from './messagepack-harness.js';

const ID = ['-c', 'user.name=Katse', '-c', 'user.email=katse@localhost', '-c', 'commit.gpgsign=false'];
const attackContent = a => Object.fromEntries(['hypothesis','scenario','expected','expectations','test','names','files'].filter(k=>k in a).map(k=>[k,a[k]]));
const stripCandidate = c => { const { dir, ...rest } = c; return rest; };
const strategies = ['Minimal targeted repair preserving every unrelated diagnostic', 'Guard syntax-dependent diagnostics explicitly before reporting; retain diagnostics for source-defined symbols', 'Conservative validation with edge-case preservation', 'Alternative control flow with the smallest public surface change'];

export function verifyComplete(args, dependencies) {
  const selected = { ...models(), ...args.options.providers };
  for (const role of ['fast', 'review']) if (!/^google\/[\w.-]+$/.test(selected[role])) throw new Error(`Proveedor no compatible para ${role}`);
  if (selected.diverse !== 'verda-nemotron/nemotron') throw new Error('El proveedor diverso debe ser Verda Nemotron');
  const profile = resolveProfile(args.options);
  return execution.run({ ...execution.getStore(), models: selected, tokenBudget: new TokenBudget(profile.tokenBudget) }, () => executeComplete(args, dependencies));
}

async function executeComplete(args, { intake, verifyBaseline }) {
  const { project, pr, options, runDir, emit } = args;
  const profile = resolveProfile(options);
  const started = Date.now(), budgetMs = profile.budgetMs;
  const deadline = started + budgetMs, generationEnd = started + budgetMs * 2 / 3, finalEnd = deadline - Math.min(30000, budgetMs / 5);
  const artifacts = path.join(runDir, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const tempRoot = path.join(os.tmpdir(), 'katse', path.basename(runDir)); fs.mkdirSync(tempRoot, { recursive: true });
  const state = { version: 2, contract: null, candidates: [], attacks: [], evidence: [], sessions: [], groups: [], finalMissions: [], pending: [], debate: [], requiredFinalMissions: profile.finalMissions, budget: { profile: profile.id, tokenLimit: profile.tokenBudget, limitMs: budgetMs, generationEnd, finalEnd, deadline, concurrency: { models: 2, runners: 1 }, maxCandidates: profile.initialCandidates + profile.maxDescendants, maxGenerations: profile.maxDescendants ? 2 : 1, formula: 'two independent candidates; additional work only for unresolved risks within profile', priorityFormula: 'R*(1+U+D)/(C*(1+N))', heuristics: true } };
  let it, baseline, baselineTask, resume, original, reviewerDir, complete = false, semantic = null;
  const save = () => writeJSON(path.join(artifacts, 'pipeline.json'), { ...state, candidates: state.candidates.map(stripCandidate) });
  const pending = (where, error) => { const text = redact(error.message || error); if (error.sessionRecord) state.sessions.push(error.sessionRecord); state.pending.push({ where, text }); emit({ type: 'log', text: `${where}: ${text}` }); save(); };
  const recordSession = r => { state.sessions.push({ id: r.id, model: r.model, sessionId: r.sessionId, history: r.history, artifact: r.artifact, ms: r.ms }); save(); return r.result; };
  const call = async opts => recordSession(await session({ artifacts, ...opts }));
  const test = async (v, full = false, force = false) => {
    const r = await evaluate({ version: v, attacks: state.attacks, contract: state.contract, tc: it.toolchain, environment: state.environment, artifacts, emit, full, force, suiteOverlay: [...(state.harness || []), ...(full ? state.suiteOverlay || [] : [])] });
    state.evidence.push(r); save(); return r;
  };

  const coalesce = () => {
    const result = deduplicateCandidates(state.candidates);
    for (const d of result.duplicates) emit({type:'candidate',id:d.id,status:'duplicate',duplicateOf:d.duplicateOf});
    state.deduplication = {distinct:result.distinct,duplicates:state.candidates.filter(c=>c.status==='duplicate').map(c=>({id:c.id,duplicateOf:c.duplicateOf}))}; save();
  };
  const availableModel = requested => requested === models().diverse && state.providers?.available?.diverse === false && state.providers?.available?.fast ? models().fast : requested;
  async function candidate(index, parent = null) {
    const id = `C${index + 1}`, dir = path.join(tempRoot, id), requestedModel = index % 2 ? models().diverse : models().fast, model = availableModel(requestedModel);
    const group = [...state.groups].sort((a, b) => priority(b) - priority(a))[0];
    const c = { id, dir, version: 1, generation: parent ? 2 : 1, parents: parent ? [parent.id] : [], model, requestedModel, modelFallback: model !== requestedModel, group: group?.id, strategy: strategies[index % strategies.length], status: 'pending', reason: parent ? 'Correct observed failures or explore an unresolved decision in a surviving strategy' : 'Independent reconstruction from the historical base', isolation: { base: it.mergeBase, history: 'fresh single commit, no remotes', proposedPatchVisible: false, changedLocationsVisible: true, excerptSelection: 'prior source at changed locations and expressions cited in the requirement', osSandbox: false } };
    state.candidates.push(c); emit({ type: 'candidate', id, status: c.status }); save(); const begin = Date.now();
    try {
      await blindCopy(it.repo, dir, it.mergeBase);
      fs.appendFileSync(path.join(dir,'.git','info','exclude'),'\n.opencode/\n.entire/\n.replica-trx/\n');
      if (parent) await git(dir, ['apply', '--whitespace=nowarn', path.join(artifacts, parent.patch)]);
      const blocks = parent ? sourceBlocks(state.sourceChanges.map(f=>({...f,text:fs.readFileSync(path.join(dir,f.path),'utf8')})), state.requirementContext) : state.baseBlocks;
      const context = JSON.stringify(blocks);
      const feedback = parent ? state.evidence.filter(e => e.version === parent.id).map(e => ({ status: e.status, failures: e.tests?.filter(t => t.outcome === 'Failed'), log: e.log && fs.readFileSync(path.join(artifacts, e.log), 'utf8').slice(-7000) })) : [];
      let result = await session({ dir, artifacts, role: `build-${id}`, model, timeout: 75000, noTools: true, maxOutputTokens: 4096, maxInputTokens: 14000,
        prompt: `Independently solve this contract from PRE-CHANGE source. The proposed patch is hidden. NO tools, commands or full file rewrites. Return at most 4 block replacements as JSON {"summary":"brief","decisions":["brief"],"unresolved":[],"edits":[{"block":"B1","new":"COMPLETE replacement for that block, including its unchanged context lines"}]}. Select only supplied block IDs. Copy unchanged lines within each edited block exactly. Do NOT include block labels in new. Do not invent or edit methods outside these blocks. Return the complete replacement block. Preserve indentation. Strategy: ${c.strategy}. For descendants edit the current parent source. Original requirement (independent of the proposed patch): ${state.requirementContext}\nContract: ${JSON.stringify(state.contract.expectations.map(({testIdeas,symbols,...e})=>e))}\nSource excerpts: ${context}\nParent feedback: ${JSON.stringify(feedback)}${state.newSourcePaths?.length ? `\nFiles that do not exist yet and the change may need to create: ${JSON.stringify(state.newSourcePaths)}. To create one, add an edit {"path":"<that path>","old":"","new":"complete file content"}.` : ''}`, validate: x => typeof x.summary === 'string' && Array.isArray(x.edits) });
      try { applyProposal(dir, result.result.edits, state.sourcePaths, blocks); }
      catch (error) {
        recordSession(result);
        const diagnostics = result.result.edits.map(e=>({path:e.path,old:e.old,count:state.sourcePaths.includes(e.path) && typeof e.old==='string' && fs.existsSync(path.join(dir,e.path)) ? fs.readFileSync(path.join(dir,e.path),'utf8').replaceAll('\r\n','\n').split(e.old.replaceAll('\r\n','\n')).length-1 : null}));
        result = await session({dir,artifacts,role:`build-${id}-repair`,model,timeout:35000,noTools:true,maxOutputTokens:4096,maxInputTokens:18000,
          prompt:`Your proposal was NOT applied: ${error.message}. One correction allowed. Return JSON {"summary":"...","decisions":[],"unresolved":[],"edits":[{"path":"src/...cs","old":"EXACT unique multiline substring","new":"replacement"}]}. No tools. Preserve whitespace. DO NOT join separate EXCERPTS. Include more unchanged context if count>1. Replace invented old substrings with actual source. ${state.newSourcePaths?.length ? `To create a file that does not exist yet (${JSON.stringify(state.newSourcePaths)}), use "old":"" and the complete content as "new". ` : ''}Diagnostics:${JSON.stringify(diagnostics)}\nPrevious proposal:${JSON.stringify(result.result)}\nOriginal requirement:${state.requirementContext}\nActual source excerpts:${context}`,validate:x=>typeof x.summary==='string'&&Array.isArray(x.edits)});
        applyProposal(dir,result.result.edits,state.sourcePaths,blocks);
      }
      c.application = 'Model proposed literal edits; local orchestrator applied and verified unique matches';
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
      // Link the recorded proposal after generation. No capture hooks delay the model request.
      if(state.providers?.tools?.entire !== false) await setupCapture(dir, {manual:true});
      await git(dir, [...ID, 'commit', '-m', `Katse candidate ${id}`]);
      c.capture = state.providers?.tools?.entire === false ? {status:'unavailable',reason:'Entire preflight failed'} : await attachSession(dir, result.sessionId);
      c.commit = await out(dir, ['rev-parse', 'HEAD']);
      c.checkpoint = state.providers?.tools?.entire === false ? {status:'unavailable'} : await checkpoint(dir, c.commit, artifacts, id); c.status = 'built';
    } catch (e) { if (e.sessionRecord) state.sessions.push(e.sessionRecord); c.status = e.name === 'DeadlineError' || /timeout/.test(e.message) ? 'timeout' : 'failed'; c.error = redact(e.message); }
    finally { c.ms = Date.now() - begin; if (group) { group.explored++; group.estimatedMs = (group.estimatedMs + c.ms) / 2; } emit({ type: 'candidate', id, status: c.status, tree: c.tree }); save(); }
  }

  async function attack(mission, index, final = false) {
    const nextAttack = Math.max(0,...[...state.attacks.map(a=>a.id),...fs.readdirSync(artifacts)].map(id=>Number(/^A(\d+)-/.exec(id)?.[1] || 0))) + 1;
    const id = `A${nextAttack}-${index}-${final ? 'final' : 'initial'}`;
    const requestedAttacker = index % 2 ? models().diverse : models().fast, attacker = availableModel(requestedAttacker), defender = availableModel(index % 2 ? models().fast : models().diverse);
    const schema = state.harness?.length ? scenarioInstructions : '{"hypothesis":"possible failing behavior","scenario":"valid input","expected":"required output","expectations":["E1"],"names":["KatseUniqueTest"],"files":[{"path":"tests/.../KatseUniqueTests.cs","content":"complete compilable C# test file"}]}';
    const labels = final && state.frozen?.selected ? index % 2 ? { A: state.frozen.selected, B: 'original' } : { A: 'original', B: state.frozen.selected } : null;
    const patchFor = id => id === 'original' ? state.proposedPatch : fs.readFileSync(path.join(artifacts, state.candidates.find(c => c.id === id).patch), 'utf8');
    const blinded = labels ? `\nAnonymous frozen implementation A:\n${patchFor(labels.A)}\nAnonymous frozen implementation B:\n${patchFor(labels.B)}` : '';
    const allowed = state.contract.expectations.filter(isGrounded);
    const context = `Debate suggestions (hypotheses, not facts): ${JSON.stringify(state.debate).slice(0,6000)}\nUse ONLY supplied context; no tools. Cite ONLY these allowed expectation IDs: ${allowed.map(e => e.id).join(', ')}. Choose one precise scenario and only expectations this test actually checks. Do NOT make assertions about pending/unspecified behaviors. Contract: ${JSON.stringify(allowed)}\nOriginal requirement: ${state.requirementContext}\nTest projects: ${JSON.stringify(it.toolchain.testProjects)}\nExisting test names (avoid repeating their simplest cases): ${JSON.stringify(state.testInventory || [])}. Test conventions and source excerpts: ${state.reviewContext}${blinded}\nExisting attacks (choose a NEW case): ${JSON.stringify(state.attacks.map(a => ({ hypothesis: a.hypothesis, scenario: a.scenario })))}`;
    let a = { id, mission, riskKey: mission, origin: state.debate.length ? 'debate-informed' : 'independent-review', originCandidate: [...new Set(state.debate.filter(d=>d.round==='proposals'&&d.status!=='incomplete').map(d=>d.candidate))].join(', ') || null, final, attacker, requestedAttacker, modelFallback: attacker !== requestedAttacker, defender, labels, status: 'pending' }; state.attacks.push(a); save();
    try {
      const result = await call({ dir: reviewerDir, role: `attack-${id}`, model: attacker, timeout: 45000, noTools: true, maxOutputTokens: 2000,
        prompt: `Design ONE executable adversarial C# test for mission: ${mission}. Use the supplied test conventions. Do not edit or execute anything. Return JSON ${schema}. Use unique file/class/method prefix Katse${id.replace(/-/g, '')}. The expected result must follow the cited contract; NEVER assert outputs based on majority voting or candidate agreement. Use an existing test verifier API exactly as seen in tests. ${context}`, validate: x => { const a = state.harness?.length ? materializeScenario(x,id) : x; validateAttack(a,state.contract,it.toolchain.testProjects); return true; } });
      Object.assign(a, attackContent(state.harness?.length ? materializeScenario(result, id) : result)); validateAttack(a, state.contract, it.toolchain.testProjects);
      const defense = profile.id === 'deep' ? await call({ dir: reviewerDir, role: `defense-${id}`, model: defender, timeout: final ? 40000 : 60000,
        prompt: `Validate the TEST: valid scenario, expectation grounded in contract, executable harness. Admit valid tests even when you expect the implementation to PASS. A hypothesis predicting a bug can be false while the test is useful. Lack of evidence for a bug is NEVER grounds to reject a test; execution must refute it. Reject only invalid input, unsupported expectation, incompatible harness or material requirement ambiguity. You are defending anonymous version ${index % 2 ? 'A' : 'B'}. A failure is NOT evidence until executed. Do not edit. Return {"admit":true|false,"reason":"...","revision":"..."}. ${context}\nAttack: ${JSON.stringify(a)}`, validate: x => typeof x.admit === 'boolean' }) : { admit: true, reason: 'Schema and source references checked locally; semantic validity reviewed at final judgment', mechanism: 'deterministic-provisional-admission' };
      a.defense = defense;
      if (!defense.admit && defense.revision) {
        const revised = await call({ dir: reviewerDir, role: `revise-${id}`, model: attacker, timeout: 40000, prompt: `One permitted revision to this attack. Return ${schema}. Address the defense or return {"withdraw":true}. Do not edit files. ${context}\nAttack:${JSON.stringify(a)}\nDefense:${JSON.stringify(defense)}`, validate: x => x.withdraw === true || (state.harness?.length ? !!x.test : Array.isArray(x.files)) });
        if (revised.withdraw) { a.status = 'withdrawn'; return a; }
        Object.assign(a, attackContent(state.harness?.length ? materializeScenario(revised, id) : revised)); validateAttack(a, state.contract, it.toolchain.testProjects);
        // One revision cannot overrule a substantive requirement dispute by fiat.
        a.status = 'disputed'; a.pendingReason = 'Revised test requires independent adjudication';
      } else a.status = defense.admit ? 'admitted' : 'disputed';
    } catch (e) { if (e.sessionRecord) state.sessions.push(e.sessionRecord); a.status = 'invalid'; a.error = redact(e.message); }
    finally { a.hash = sha256(JSON.stringify({ files: a.files, expectations: a.expectations, contract: state.contract.hash })); writeJSON(path.join(artifacts, `${id}.json`), a); emit({ type: 'attack', id, status: a.status, mission }); save(); }
    return a;
  }

  async function deliberate(afterExecution = false) {
    const built = state.candidates.filter(c => c.status === 'built').slice(0,2);
    if (built.length < 2 || profile.id === 'quick') return;
    if (afterExecution && Date.now() + 18000 >= finalEnd) return;
    const proposals = built.map(c=>({id:c.id,decisions:c.decisions,unresolved:c.unresolved,patch:fs.readFileSync(path.join(artifacts,c.patch),'utf8').slice(0,6500)}));
    const outcomes = afterExecution ? state.evidence.map(e=>({version:e.version,status:e.status,ran:e.ran,failures:e.tests?.filter(t=>t.outcome==='Failed').map(t=>({name:t.name,error:t.error?.slice(0,1200)}))})) : [];
    await Promise.allSettled(built.map(async c=>{
      try {
        const reply = await call({dir:reviewerDir,role:`debate-${afterExecution?'results':'proposals'}-${c.id}`,model:c.model,timeout:25000,noTools:true,maxOutputTokens:1000,
          prompt:`You authored candidate ${c.id}. Cooperatively review the other candidate. The original implementation is hidden. Revise your view when warranted; agreement is not evidence. NO tools. Each field at most 140 characters. Respond compact JSON {"strength":"...","risk":"...","expectation":"E1","scenario":"concrete test idea","revision":"what you would change or why keep"}. Do not invent outcomes. Contract: ${JSON.stringify(state.contract.expectations)}\nCandidates:${JSON.stringify(proposals)}\nActual execution:${JSON.stringify(outcomes).slice(0,7000)}`,validate:x=>typeof x.scenario==='string' && typeof x.revision==='string'});
        state.debate.push({candidate:c.id,model:c.model,round:afterExecution?'results':'proposals',...reply});
        emit({type:'debate',candidate:c.id,round:afterExecution?'results':'proposals',...reply});save();
      } catch(e) { state.debate.push({candidate:c.id,round:afterExecution?'results':'proposals',status:'incomplete',reason:e.message}); }
    }));
  }

  try {
    await within(generationEnd, async () => {
      state.providers = await providerPreflight({allowPartial:true, nemotron: getSettings().models.nemotron}); emit({ type: 'log', text: state.providers.errors?.length ? `Disponibilidad parcial: ${state.providers.errors.join('; ')}. Se conserva el alcance ejecutable y se registra cualquier sustitución de modelo.` : 'Proveedores y herramientas accesibles' }); save();
      it = await intake(project, pr); state.input = { proposed: it.headSha, proposedRef: pr.ref, target: it.baseSha, targetRef: project.base, historicalBase: it.mergeBase, requirement: it.requirement };
      if(options.resumeRunId) { resume = loadContinuation(project.id, options.resumeRunId, state.input, artifacts); state.continuation = {runId:resume.runId,reuse:resume.reuse}; state.attacks = resume.state.attacks.filter(a=>a.status==='admitted' && !resume.state.verdict?.semantic?.invalidAttacks?.some(x=>x.id===a.id)); state.debate = resume.state.debate || []; }
      // Pin input refs even if the user's branches move while agents are working.
      const frozenProject = { ...project, base: it.baseSha }, frozenPr = { ...pr, ref: it.headSha };
      baselineTask = runnerQueue.use(() => verifyBaseline({ ...args, emit: e => { if (e.type === 'stage' && ['l3', 'informe'].includes(e.id)) return; emit(e); }, project: frozenProject, pr: frozenPr, options: { ...options, mutants: profile.id === 'deep' ? options.mutants : 0, rewind: profile.id === 'deep' && options.rewind, mode: 'rapido', agents: [], keepTrees: true, scratchRoot: path.join(tempRoot, 'baseline') } })).then(b => { baseline = b; return b; }).catch(e => pending('baseline', e));
      const contractDir = path.join(tempRoot, 'contract'); await blindCopy(it.repo, contractDir, it.mergeBase);
      reviewerDir = path.join(tempRoot, 'reviewer'); await blindCopy(it.repo, reviewerDir, it.headSha);
      const preparation = await Promise.allSettled([resume ? Promise.resolve(resume.state.contract) : reconstructContract(it, contractDir, artifacts, emit), analyzeSymbols(it, contractDir, artifacts)]);
      const failedPreparation = preparation.find(r=>r.status==='rejected'); if(failedPreparation) throw failedPreparation.reason;
      const [contract, analysis] = preparation.map(r=>r.value);
      state.contract = contract; state.analysis = analysis; state.groups = behaviorGroups(it, analysis, contract); state.budget.initialCandidates = state.groups.length ? profile.initialCandidates : 0;
      state.sourcePaths = it.files.filter(f => f.kind === 'source' && f.path.endsWith('.cs')).map(f=>f.path);
      if (!resume) state.sessions.push(...(contract.sessionRecords || []));
      state.reviewContext = ''; state.baseContext = ''; state.baseBlocks = []; state.testInventory = [];
      state.requirementContext = state.contract.sources.filter(s=>s.kind==='requirement').map(s=>s.text).join('\n').slice(0,12000);
      state.sourceChanges = it.files.filter(f=>f.kind==='source' && f.path.endsWith('.cs')).map(f=>({path:f.path,hunks:f.hunks}));
      // A file the PR creates does not exist at the base: its base text is empty, and agents may create it.
      const baseText = (p) => out(it.repo, ['show', `${it.mergeBase}:${p}`]).catch(() => null);
      const sourceFiles = (await Promise.all(state.sourceChanges.map(async f => ({ ...f, text: await baseText(f.path) })))).map(f => ({ ...f, isNew: f.text === null, text: f.text ?? '' }));
      state.newSourcePaths = sourceFiles.filter(f => f.isNew).map(f => f.path);
      state.baseBlocks = sourceBlocks(sourceFiles,state.requirementContext);
      state.baseContext = JSON.stringify(state.baseBlocks);
      state.harness = String(pr.branch).includes('2283') && it.toolchain.testProjects.some(p => p.endsWith('MessagePack.SourceGenerator.Tests.csproj')) ? [{ path: harnessPath, content: harnessContent }] : [];
      if (state.harness.length) writeJSON(path.join(artifacts, 'harness.json'), state.harness);
      state.proposedPatch = await out(it.repo, ['diff', it.mergeBase, it.headSha, '--', ...it.files.filter(f => f.kind === 'source').map(f => f.path)]);
      fs.writeFileSync(path.join(artifacts, 'original-change.patch'), state.proposedPatch);
      state.intentContext = intentInput(state.contract, state.proposedPatch, state.input);
      state.suiteOverlay = [];
      for (const f of it.files.filter(f => (f.kind === 'test' || f.kind === 'source') && f.status !== 'deleted')) {
        const text = await out(it.repo, ['show', `${it.headSha}:${f.path}`]).catch(() => '');
        if (f.kind === 'test') { state.suiteOverlay.push({ path: f.path, content: text }); state.testInventory.push(...[...text.matchAll(/public\s+(?:async\s+)?(?:Task|void)\s+(\w+)\s*\(/g)].map(m=>m[1])); }
        const lines = text.split('\n');
        if (!(state.harness.length && f.kind === 'test')) state.reviewContext += `\nFILE ${f.path}\n` + (f.kind === 'test' ? text.slice(-28000) : f.hunks.map(h => lines.slice(Math.max(0, h.newStart - 8), h.newStart + h.newLines + 8).join('\n')).join('\n')).slice(0, state.harness.length ? 9000 : 32000);
      }
      state.environment = { platform: process.platform, arch: process.arch, node: process.version, sdk: (await run('dotnet', ['--version'], { cwd: contractDir, timeout: 10000 })).stdout.trim(), projects: it.toolchain.testProjects, scope: 'C# relevant tests, default build configuration', runnerHash: sha256(fs.readFileSync(path.join(ROOT, 'server/pipeline/toolchain.js'))), dependencies: it.headSha };
      original = { id: 'original', dir: path.join(tempRoot, 'baseline/merged'), tree: await out(it.repo, ['rev-parse', `${it.headSha}^{tree}`]), commit: it.headSha };
      save();
      if (resume) for(const previous of resume.state.candidates.filter(c=>c.status==='built')) {
        const dir = path.join(tempRoot,previous.id); await blindCopy(it.repo,dir,it.mergeBase);
        await git(dir,['apply','--whitespace=nowarn',path.join(artifacts,previous.patch)]); await git(dir,['add','-A']);
        const tree = await out(dir,['write-tree']); if(tree!==previous.tree) throw new Error('Continuation candidate hash mismatch');
        await git(dir,[...ID,'commit','-m',`Restore ${previous.id} for continued review`]);
        state.candidates.push({...previous,dir,continuedFrom:resume.runId,restoredFromCommit:previous.commit,commit:await out(dir,['rev-parse','HEAD'])});
      }
      coalesce();
      const existingCount = state.candidates.filter(c=>c.status==='built').length;
      const nextIndex = Math.max(0,...state.candidates.map(c=>Number(c.id.slice(1))));
      const tasks = Array.from({ length: Math.max(0,state.budget.initialCandidates-existingCount) }, (_,i)=>candidate(nextIndex+i));
      if (state.groups.length && profile.id === 'deep') tasks.push(attack('Variants of the reported failure and preservation of unrelated diagnostics', 0));
      if (!state.groups.length) state.pending.push({where:'scope',text:'No executable source changes; only applicable contract and baseline analysis was performed.'});
      const results = await Promise.allSettled(tasks); for (const r of results) if (r.status === 'rejected') pending('initial-generation', r.reason);
      coalesce();
      await deliberate();
      if (state.groups.length && profile.id === 'deep' && !state.attacks.some(a => a.status === 'admitted') && Date.now() + 30000 < generationEnd) {
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
      if (profile.maxDescendants && wantsExploration && survivors.length && Date.now() + 60000 < generationEnd) {
        const descendants = await Promise.allSettled(survivors.slice(0, profile.maxDescendants).map((p, i) => candidate(Math.max(0,...state.candidates.map(c=>Number(c.id.slice(1)))) + i, p)));
        for (const r of descendants) if (r.status === 'rejected') pending('descendant', r.reason);
        coalesce();
        for (const c of state.candidates.filter(c => c.generation === 2 && c.status === 'built')) await test(c);
      }
    });
  } catch (e) { pending('generation', e); }

  // Ensure the baseline process has stopped before sharing its working directory.
  if (baselineTask) await baselineTask;
  if (it && state.contract && original && baseline) {
    try {
      await within(finalEnd, async () => {
        const finalists = chooseCandidates(state.candidates, state.evidence, state.attacks);
        const champion = state.candidates.find(c => c.id === finalists[0]?.id);
        if (champion) champion.final = true; state.frozen = { A: original.tree, B: champion?.tree, selected: champion?.id, contract: state.contract.hash };
        emit({ type: 'log', text: `Comparación final congelada: original y ${champion?.id || 'sin alternativa construida'}` });
        const missions = ['New variants of the original bug, not covered by previous attacks', 'Regression: preserve existing invalid-formatter diagnostics', 'Interaction between generic arity, constraints, nested types and accessibility'];
        await Promise.all(missions.slice(0, profile.finalMissions).map(async (mission, i) => {
          const a = await attack(mission, i + 1, true); state.finalMissions.push({ mission, attack: a.id, complete: a.status === 'admitted', roles: { attacker: a.attacker, defender: a.defender }, labels: a.labels });
        }));
        const originalResult = await test(original, true);
        for (const c of state.candidates.filter(c=>c.status==='built').slice(0,profile.id==='deep'?1:2)) {
          if(Date.now()+20000<finalEnd) await test(c,true);
          else state.pending.push({where:`validation-${c.id}`,text:'Candidate validation was not started: execution budget insufficient'});
        }
        const failures = state.attacks.filter(a => a.status === 'admitted' && attackOutcome(a, originalResult) === 'failed');
        if (failures.length) {
          await test(original, false, true);
          const baseDir = path.join(tempRoot, 'repro-base'); await blindCopy(it.repo, baseDir, it.mergeBase);
          await test({ id: 'historical-base', dir: baseDir, tree: await out(it.repo, ['rev-parse', `${it.mergeBase}^{tree}`]) });
        }
        const unchecked = state.candidates.filter(c=>c.status==='built').slice(0,profile.id==='deep'?1:2).filter(c=>!state.evidence.some(e=>e.version===c.id&&e.scope==='relevant-suite'&&e.executionComplete));
        state.budget.candidateValidation = {complete:unchecked.length===0,pending:unchecked.map(c=>c.id)};
        for(const c of unchecked) if(!state.pending.some(p=>p.where===`validation-${c.id}`)) state.pending.push({where:`validation-${c.id}`,text:'Candidate validation did not complete; the full comparison remains pending'});
        await deliberate(true);
        complete = true;
      });
    } catch (e) { pending('final-attacks', e); }
  }

  try {
    if (state.contract && reviewerDir) await within(deadline - 2000, async () => {
      semantic = await call({ dir: reviewerDir, role: 'semantic-judge', model: models().review, noTools: true, maxOutputTokens: 6000, timeout: Math.min(55000, deadline - Date.now() - 2000),
        prompt: semanticPrompt(state), validate: x => typeof x.explanation === 'string' && Array.isArray(x.intentRows) && Array.isArray(x.ambiguities) && Array.isArray(x.contradictions) });
    });
  } catch (e) { pending('semantic-judge', e); }
  if (state.intentContext) {
    state.intentComparison = normalizeIntent(semantic?.intentRows, state.intentContext, state.contract);
    for (const text of intentPending(state.intentComparison)) state.pending.push({where:'intent', text});
    writeJSON(path.join(artifacts, 'intent-comparison.json'), state.intentComparison);
    emit({type:'intent', status:state.intentComparison.status, rows:state.intentComparison.rows});
  }
  state.verdict = adjudicate({ ...state, baseline, semantic, complete, finalMissions: state.finalMissions, requiredFinalMissions: profile.finalMissions, extraPending: [...state.pending.map(p=>`${p.where}: ${p.text}`), ...state.attacks.filter(a=>a.status==='disputed').map(a=>`${a.id}: disputed`)] });
  state.verdict.auditWarnings.push(...(state.providers?.errors || []).map(e=>`Provider availability: ${e}; any model substitution is recorded and reduces model-family diversity.`));
  state.budget.elapsedMs = Date.now() - started; state.budget.exhausted = !complete && Date.now() >= finalEnd; state.budget.remainingMs = Math.max(0, deadline - Date.now());
  // Include recorded failed attempts and an analyst session whose reviewer timed out.
  const recorded = fs.readdirSync(artifacts).filter(f => f.endsWith('.json')).flatMap(f => {
    try { const r = JSON.parse(fs.readFileSync(path.join(artifacts, f), 'utf8')); const { prompt, result, ...metadata } = r; return r.role && r.model && r.history ? [metadata] : []; } catch { return []; }
  });
  const inheritedSessions = new Set(resume?.state.sessions?.map(s=>s.id) || []);
  state.sessions = [...new Map([...state.sessions, ...recorded.filter(s=>!inheritedSessions.has(s.id))].map(s => [s.id, s])).values()];
  state.budget.tokens = state.sessions.flatMap(s => s.history || []).flatMap(h => h.usage || []).reduce((n, t) => n + usageTokens(t), 0);
  if (resume) state.budget.inheritedTokens = resume.state.budget?.cumulativeTokens ?? resume.state.budget?.tokens ?? 0;
  state.budget.cumulativeTokens = (state.budget.inheritedTokens || 0) + state.budget.tokens;
  state.budget.accounting = execution.getStore().tokenBudget.snapshot();
  state.budget.usageIncomplete = state.budget.accounting.usageIncomplete || state.sessions.some(s => s.error && !s.history?.some(h => h.usage?.length));
  const fallback = { version: 1, createdAt: new Date().toISOString(), project: { id: project.id, name: project.name }, provenance: { status: 'none' }, pr: { id: pr.id, branch: pr.branch, direction: pr.direction, title: pr.title, head: it?.headSha || pr.sha || '', base: project.base, baseSha: it?.baseSha, commits: [] }, totals: it?.totals || { lines: 0, files: 0, added: 0, removed: 0 }, kinds: it?.kinds || {}, files: [], claims: [], questions: [], residue: { lines: it?.totals.lines || 0, total: it?.totals.lines || 0, items: [] }, notChecked: [], rules: { fired: [] }, timing: { stages: [] }, areas: [], toolchain: { kind: it?.toolchain.kind || 'none' }, options, cost: { usd: 0 } };
  const brief = { ...(baseline || fallback), version: 2, contract: state.contract, candidates: state.candidates.map(stripCandidate), attacks: state.attacks, evidence: state.evidence, budget: state.budget, verdict: state.verdict, input: state.input, environment: state.environment, finalMissions: state.finalMissions, analysis: state.analysis, providers: state.providers, continuation: state.continuation, debate: state.debate, intentComparison: state.intentComparison };
  brief.options = options; brief.timing.totalMs = Date.now() - started; brief.pr.base = project.base;
  brief.claims = brief.claims.filter(c => c.id !== 'replicas');
  brief.notChecked = brief.notChecked.filter(c => c.what !== 'Réplicas independientes');
  for (const item of brief.residue.items) item.why = (item.why || []).map(reason => reason.includes('sin réplicas') ? 'zona de código que requiere revisión: las pruebas solo respaldan los comportamientos declarados' : reason);
  brief.claims.push({ id: 'candidates', text: 'Alternativas reconstruidas desde la base', status: state.candidates.some(c => c.status === 'built') ? 'parcial' : 'no-ejecutado', detail: `${state.candidates.filter(c => c.status === 'built').length} alternativas distintas construidas; la comparación se basa en tests ejecutados`, evidence: state.candidates.filter(c => c.patch).map(c => ({ label: c.id, artifact: c.patch })) });
  brief.lane = { id: state.verdict.status === 'request-changes' ? 'devolver' : state.verdict.status === 'ready-for-human' ? 'reproducido' : 'decision', name: state.verdict.label, tone: state.verdict.status === 'request-changes' ? 'no' : state.verdict.status === 'ready-for-human' ? 'ok' : 'warn', summary: state.verdict.label };
  brief.recommendation = { id: state.verdict.status === 'ready-for-human' ? 'lista' : state.verdict.status === 'request-changes' ? 'cambios' : 'insuficiente', lista: state.verdict.status === 'ready-for-human', name: state.verdict.label, why: state.verdict.semantic?.explanation || 'Comprobaciones deterministas y alcance pendiente', text: state.verdict.label };
  brief.notChecked.push(...state.verdict.pending.map(what => ({ what, why: 'Evidencia pendiente del pipeline completo' })));
  brief.claims.push({ id: 'courtroom', text: 'Veredicto basado en ejecución y contrato versionado', status: state.verdict.status === 'ready-for-human' ? 'reproducido' : 'parcial', detail: state.verdict.label, evidence: [{ label: 'Contrato y trazabilidad', artifact: 'pipeline.json' }] });
  brief.binding = sha256(JSON.stringify({ head: brief.pr.head, contract: state.contract?.hash, evidence: state.evidence.map(e => e.id), tests: state.attacks.map(a => a.hash), intent: state.intentComparison }));
  save(); brief.artifactManifest = artifactManifest(artifacts); writeJSON(path.join(artifacts, 'brief.json'), brief); emit({ type: 'judgment', verdict: state.verdict, artifact: 'brief.json' });
  // No active workers remain. Retain candidate repositories with captured checkpoints for audit.
  return brief;
}
