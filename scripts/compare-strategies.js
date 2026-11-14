// A budget-matched local experiment. Results measure this case, never universal superiority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, readJSON, writeJSON } from '../server/util.js';
import { listProjects, findPullRequest } from '../server/projects.js';
import { intake } from '../server/pipeline/run.js';
import { blindCopy } from '../server/pipeline/sandbox.js';
import { git, out } from '../server/git.js';
import { within } from '../server/execution.js';
import { session, setupCapture, models, usageTokens } from '../server/agents.js';
import { validateAttack, evaluate, attackOutcome } from '../server/pipeline/evidence.js';
import { harnessPath, harnessContent, scenarioInstructions, materializeScenario } from '../server/pipeline/messagepack-harness.js';

const [runId, rawBudget] = process.argv.slice(2);
if (!runId) throw new Error('Usage: node scripts/compare-strategies.js <completed-run-id> [budgetMs=240000]');
const project = listProjects().find(p => fs.existsSync(path.join(DATA, 'runs', p.id, runId, 'artifacts/pipeline.json')));
if (!project) throw new Error('No local project contains this run.');
const prior = readJSON(path.join(DATA, 'runs', project.id, runId, 'artifacts/pipeline.json'));
if (!prior?.contract) throw new Error('This run has no reviewed contract');
const pr = await findPullRequest(project, 'in:ju26-issue-2283'); const it = await intake(project, pr);
if (it.headSha !== prior.input.proposed || it.mergeBase !== prior.input.historicalBase) throw new Error('References changed; comparison would be invalid');
const budgetMs = Math.max(60000, Math.min(900000, Number(rawBudget) || 240000));
const dir = path.join(DATA, 'evaluation', `comparison-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
const report = { budgetMsPerStrategy: budgetMs, original: it.headSha, contractHash: prior.contract.hash, commonSetup: 'Both use the same independently reviewed contract; its creation cost is excluded equally.', observations: [], limitation: 'One paired case, no statistical claim of superiority. Different generated tests need source review.' };
const rawDiff = await out(it.repo, ['diff', it.mergeBase, it.headSha, '--', ...it.files.filter(f => f.kind === 'source').map(f => f.path)]);
const priorTestSources = [];
for (const f of it.files.filter(f => f.kind === 'test')) priorTestSources.push({path:f.path, source:(await out(it.repo, ['show', `${it.headSha}:${f.path}`])).slice(-36000)});
for (const strategy of ['direct-diff', 'reconstruction']) {
  const start = Date.now(); const observation = { strategy, limitMs: budgetMs, sessions: [], tests: [], results: [], pending: [] };
  report.observations.push(observation);
  try {
    await within(start + budgetMs, async () => {
      const work = path.join(os.tmpdir(), 'katse', path.basename(dir), strategy);
      await blindCopy(it.repo, work, strategy === 'reconstruction' ? it.mergeBase : it.headSha); await setupCapture(work);
      let context = rawDiff;
      const ask = async (role, prompt, timeout, model = models().fast) => {
        let r;
        try { r = await session({ dir: work, artifacts: dir, role, model, prompt, timeout }); }
        catch (e) { if (e.sessionRecord) observation.sessions.push(e.sessionRecord); throw e; }
        observation.sessions.push({ id: r.id, ms: r.ms, history: r.history }); return r.result;
      };
      if (strategy === 'reconstruction') {
        await ask('build-experiment', `Reimplement this requirement from the base. You cannot see the proposed patch. Only edit product C# source, no config or tests. Finish with {"summary":"..."}. Contract:${JSON.stringify(prior.contract.expectations)} Requirement:${JSON.stringify(it.requirement)}`, Math.min(100000, budgetMs / 2));
        await git(work, ['add', '-A']); context = await out(work, ['diff', '--cached']);
      }
      const grounded = prior.contract.expectations.filter(e => e.status !== 'pending');
      const proposal = await ask(`attack-experiment-${strategy}`, `NO tools. Inspect this ${strategy === 'direct-diff' ? 'proposed patch' : 'independent alternative'} and propose ONE executable regression test. ${scenarioInstructions}. Ground assertions only in these allowed expectations:${JSON.stringify(grounded)}\nPatch:${context.slice(0, 18000)}`, Math.min(60000, budgetMs / 3));
      const attack = validateAttack(materializeScenario({ ...proposal, id: 'experiment', status: 'admitted' }, 'Experiment'), prior.contract, it.toolchain.testProjects);
      observation.tests.push(attack);
      const originalDir = path.join(work, '..', `${strategy}-original`); await blindCopy(it.repo, originalDir, it.headSha);
      const opts = { version: { id: 'original', tree: await out(it.repo, ['rev-parse', `${it.headSha}^{tree}`]), dir: originalDir }, attacks: [attack], contract: prior.contract, tc: it.toolchain, environment: prior.environment, artifacts: dir, suiteOverlay: [{ path: harnessPath, content: harnessContent }] };
      const first = await evaluate(opts); observation.results.push(first);
      if (attackOutcome(attack, first) === 'failed') observation.results.push(await evaluate({ ...opts, force: true }));
      observation.usefulExecutedTests = attackOutcome(attack, first) === 'pending' ? 0 : first.ran;
      observation.reproducibleFailureCandidates = observation.results.filter(r => attackOutcome(attack, r) === 'failed').length >= 2 ? 1 : 0;
      observation.refutedAllegations = attackOutcome(attack, first) === 'passed' ? 1 : 0;
      const sourceReview = await ask('semantic-experiment', `No tools. Independently review whether this test uses a valid harness and a correct expectation grounded in the sources, and whether it adds a behavior or edge case beyond the supplied existing test sources. Renaming types is NOT novelty. If source context is missing, novel must be false. Return {"valid":true|false,"novel":true|false,"explanation":"..."}. Contract:${JSON.stringify(prior.contract.expectations)}\nTest:${JSON.stringify(attack)}\nObserved results:${JSON.stringify(observation.results.map(r => ({ status: r.status, tests: r.tests })))}\nHarness semantics:${scenarioInstructions}\nExisting test context:${JSON.stringify(priorTestSources)}`, 60000, models().review);
      observation.sourceReview = sourceReview;
      observation.confirmedFailures = sourceReview.valid === true ? observation.reproducibleFailureCandidates : 0;
      observation.falsePositives = sourceReview.valid === false && observation.reproducibleFailureCandidates ? 1 : 0;
      observation.additionalUsefulTests = sourceReview.valid === true && sourceReview.novel === true ? observation.usefulExecutedTests : 0;
    });
  } catch (e) { observation.pending.push(e.message); }
  observation.ms = Date.now() - start;
  observation.tokens = observation.sessions.flatMap(s => s.history || []).flatMap(h => h.usage || []).reduce((n, t) => n + usageTokens(t), 0);
  writeJSON(path.join(dir, 'comparison.json'), report);
  console.log(JSON.stringify({ strategy, ms: observation.ms, tests: observation.usefulExecutedTests || 0, tokens: observation.tokens, pending: observation.pending }));
}
console.log(dir);
