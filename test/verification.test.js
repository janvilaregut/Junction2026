import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue, within, remaining, initialPopulation, priority } from '../server/execution.js';
import { run, sha256 } from '../server/util.js';
import { userMessages, parseObject, session, usageTokens } from '../server/agents.js';
import { validateContract, contractHash, behaviorGroups } from '../server/pipeline/contract.js';
import { evidenceKey, executionStatus, validateAttack, evaluate, attackOutcome, adjudicate, chooseCandidates } from '../server/pipeline/evidence.js';
import { artifactManifest, verifyIntegrity } from '../server/integrity.js';
import { parseTrx } from '../server/pipeline/toolchain.js';
import { materializeScenario } from '../server/pipeline/messagepack-harness.js';
import { blindCopy, assertScratch } from '../server/pipeline/sandbox.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'katse-test-'));
const contract = () => validateContract({ expectations: [{ behavior: 'Preserve diagnostic', status: 'documented', sources: [{ id: 'issue', quote: 'preserve diagnostic' }] }] }, [{ id: 'issue', text: 'Must preserve diagnostic' }]);
const attack = () => ({ id: 'A1', status: 'admitted', hypothesis: 'diagnostic missing', scenario: 'invalid source', expected: 'diagnostic', expectations: ['E1'], names: ['KatseDiagnostic'], files: [{ path: 'tests/Test/KatseDiagnostic.cs', content: 'test source' }] });
const result = (version = 'original', failed = false) => ({ id: Math.random().toString(), version, contractHash: contract().hash, attacks: ['A1'], status: failed ? 'failed' : 'passed', tests: [{ name: 'KatseDiagnostic', outcome: failed ? 'Failed' : 'Passed' }], scope: 'relevant-suite' });
const judgeInput = () => ({ contract: contract(), attacks: [attack()], evidence: [result(), result('C1')], baseline: { l2: { suite: { ok: true, ran: 170 } } }, semantic: { ambiguities: [], contradictions: [] }, complete: true, finalMissions: [1, 2, 3].map(() => ({ complete: true })), candidates: [{ id: 'C1', final: true, checkpoint: { status: 'captured' } }] });

test('initial population stays bounded; engineering priority favors untested risk', () => {
  assert.equal(initialPopulation([]), 0); assert.equal(initialPopulation([{ risk: 1 }]), 2); assert.equal(initialPopulation(Array(30).fill({ risk: 3 })), 4);
  assert.ok(priority({ risk: 3, unverified: 1, estimatedMs: 1000, explored: 0 }) > priority({ risk: 1, unverified: 0, estimatedMs: 1000, explored: 2 }));
});

test('queue limits concurrency and releases slots after rejection', async () => {
  const q = new Queue(2); let active = 0, peak = 0;
  await Promise.allSettled(Array.from({ length: 8 }, (_, i) => q.use(async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 5)); active--; if (i === 3) throw new Error('expected'); })));
  assert.equal(peak, 2); assert.equal(q.active, 0);
});

test('fractional phase budgets produce valid integer AbortSignal timeouts', () => {
  within(Date.now() + 1000 / 3, () => { const ms = remaining(1000); assert.ok(Number.isInteger(ms)); assert.doesNotThrow(() => AbortSignal.timeout(ms)); });
});

test('deadline terminates a real child process', async () => {
  const start = Date.now(); await assert.rejects(within(start + 150, () => run(process.execPath, ['-e', 'setInterval(()=>{},1000)'])) , { name: 'DeadlineError' });
  assert.ok(Date.now() - start < 5000);
});

test('only user messages become original prompts (JSON and JSONL)', () => {
  const exportDoc = { messages: [{ info: { role: 'user', id: 'u' }, parts: [{ type: 'text', text: 'fix bug' }] }, { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'everything is correct' }] }] };
  assert.deepEqual(userMessages(JSON.stringify(exportDoc)).map(p => p.text), ['fix bug']);
  assert.deepEqual(userMessages('{"role":"user","content":"hello"}\n{"role":"assistant","content":"no"}').map(p => p.text), ['hello']);
});

test('unsupported source quote becomes pending; changes invalidate contract hash', () => {
  const c = contract(); const h = c.hash; c.expectations[0].behavior = 'new'; assert.notEqual(contractHash(c), h);
  const bad = validateContract({ expectations: [{ status: 'documented', sources: [{ id: 'issue', quote: 'fabricated quote' }] }] }, c.sources);
  assert.equal(bad.expectations[0].status, 'pending');
});

test('zero tests, compilation failures, missing names and runner errors never pass', () => {
  assert.equal(executionStatus({ ok: true }, { ran: 0, tests: [] }), 'no-tests');
  assert.equal(executionStatus({ ok: false }), 'build-error');
  assert.equal(executionStatus({ ok: true }, { ran: 1, tests: [], ok: true }, ['Required']), 'harness-incompatible');
  assert.equal(executionStatus({ ok: true }, { ran: 1, tests: [], executionComplete: false }), 'runner-error');
});

test('cache key binds code, tests, contract, commands and environment', () => {
  const x = { codeHash: 'a', testHash: 'b', contractHash: 'c', environment: { sdk: '8' }, commands: ['test'] };
  for (const k of Object.keys(x)) assert.notEqual(evidenceKey(x), evidenceKey({ ...x, [k]: 'changed' }));
});

test('attack cannot overwrite source or cite an ungrounded expectation', () => {
  assert.equal(validateAttack(attack(), contract(), ['tests/Test/Test.csproj']).id, 'A1');
  assert.throws(() => validateAttack({ ...attack(), files: [{ path: '../evil.cs', content: 'x' }] }, contract(), ['tests/Test/Test.csproj']));
  assert.throws(() => validateAttack({ ...attack(), expectations: ['E99'] }, contract(), ['tests/Test/Test.csproj']));
});

test('runner retains executable failure, never touches code, and supports exact cache reuse', async () => {
  const dir = temp(); const art = temp(); let builds = 0;
  const tc = { testProjects: ['tests/Test/Test.csproj'], build: async () => { builds++; return { ok: true, log: 'build', ms: 1 }; }, test: async () => ({ ok: false, failed: 1, ran: 1, executionComplete: true, tests: [{ name: 'KatseDiagnostic', outcome: 'Failed' }], log: 'test', trx: ['<TestRun/>'] }) };
  const opts = { version: { id: 'original', tree: 'abc', dir }, attacks: [attack()], contract: contract(), tc, environment: {}, artifacts: art, verifyCode: false };
  const first = await evaluate(opts); const second = await evaluate(opts);
  assert.equal(first.status, 'failed'); assert.equal(second.reused, true); assert.equal(builds, 1); assert.ok(!fs.existsSync(path.join(dir, attack().files[0].path)));
  const repeated = await evaluate({ ...opts, force: true }); assert.notEqual(first.id, repeated.id); assert.equal(builds, 2);
});

test('judge rejects only reproducible original violations; candidate-only failure cannot reject original', () => {
  const x = judgeInput(); assert.equal(adjudicate(x).status, 'ready-for-human');
  x.evidence.push(result('C2', true)); assert.equal(adjudicate(x).status, 'ready-for-human');
  x.evidence = [result('original', true), result('original', true)]; assert.equal(adjudicate(x).status, 'request-changes');
});

test('false allegation is disproved by execution; unstable and incomplete evidence remain pending', () => {
  const x = judgeInput(); assert.equal(adjudicate(x).confirmed.length, 0);
  x.evidence.push(result('original', true)); assert.equal(adjudicate(x).status, 'insufficient-evidence');
  const y = judgeInput(); y.complete = false; assert.equal(adjudicate(y).status, 'insufficient-evidence');
  const z = judgeInput(); z.semantic.ambiguities = ['unclear requirement']; assert.equal(adjudicate(z).status, 'insufficient-evidence');
});

test('duplicates are not selected and selection uses behavior before patch size', () => {
  const c = [{ id: 'C1', status: 'built', lines: 10, ms: 2, strategy: 'a' }, { id: 'C2', status: 'duplicate', lines: 1 }, { id: 'C3', status: 'built', lines: 1, strategy: 'b' }];
  const chosen = chooseCandidates(c, [result('C1'), result('C3', true)], [attack()]); assert.equal(chosen[0].id, 'C1'); assert.ok(!chosen.find(x => x.id === 'C2'));
});

test('invalid JSON gets at most one format correction; quota is not retried', async () => {
  const dir = temp(); let calls = 0;
  const opts = { dir, artifacts: dir, role: 'test', model: 'mock', prompt: 'test', execute: async () => { calls++; return { code: 0, stdout: '{"type":"text","part":{"text":"invalid"}}', stderr: '', ms: 1 }; } };
  await assert.rejects(session(opts)); assert.equal(calls, 2);
  calls = 0; await assert.rejects(session({ ...opts, execute: async () => { calls++; return { code: 1, stdout: '', stderr: '429 quota exhausted', ms: 1 }; } }), /quota/); assert.equal(calls, 1);
  assert.deepEqual(parseObject('```json\n{"valid":true}\n```'), { valid: true });
});

test('artifact or contract changes invalidate signatures', () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'test.cs'), 'a'); const brief = { version: 2, contract: contract(), artifactManifest: artifactManifest(dir) };
  assert.equal(verifyIntegrity(brief, dir).ok, true); fs.writeFileSync(path.join(dir, 'test.cs'), 'b'); assert.equal(verifyIntegrity(brief, dir).ok, false);
});

test('cached failures are one execution, never a reproduction', () => {
  const x = judgeInput(); const failed = result('original', true); x.evidence = [failed, { ...failed, reused: true }];
  assert.equal(adjudicate(x).status, 'insufficient-evidence'); assert.equal(adjudicate(x).confirmed.length, 0);
});

test('TRX preserves failure details and distinguishes harness errors', () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'test.trx'), '<TestRun><UnitTestResult testName="First" outcome="Passed" /><UnitTestResult testName="A" outcome="Failed"><Output><ErrorInfo><Message>Multiple diagnostic descriptors with ID</Message></ErrorInfo></Output></UnitTestResult><UnitTestResult testName="B" outcome="Passed" /></TestRun>');
  const tests = parseTrx(dir); assert.equal(tests.length, 3); assert.match(tests[1].error, /Multiple/);
  assert.equal(executionStatus({ ok: true }, { tests, failed: 1, ran: 2 }), 'harness-incompatible');
  assert.equal(executionStatus({ ok: true }, { timedOut: true, ran: 0 }), 'timeout');
});

test('modified working code invalidates a frozen evaluation before using cache', async () => {
  const dir = temp(); await run('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'source.cs'), 'before'); await run('git', ['add', 'source.cs'], { cwd: dir });
  const tree = (await run('git', ['write-tree'], { cwd: dir })).stdout.trim(); fs.writeFileSync(path.join(dir, 'source.cs'), 'after');
  await assert.rejects(evaluate({ version: { id: 'original', dir, tree }, attacks: [], contract: contract(), tc: {}, environment: {}, artifacts: temp() }), /Code changed after freeze/);
});

test('blind copies preserve ignored tracked files and executable modes without remotes', async () => {
  const dir = temp(), copy = path.join(temp(), 'copy');
  await run('git', ['init', '-q'], { cwd: dir }); fs.writeFileSync(path.join(dir, '.gitignore'), 'source.cs\n'); fs.writeFileSync(path.join(dir, 'source.cs'), 'source');
  await run('git', ['add', '-f', '-A'], { cwd: dir }); await run('git', ['update-index', '--chmod=+x', '--', 'source.cs'], { cwd: dir });
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { cwd: dir });
  const expected = (await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir })).stdout.trim();
  await blindCopy(dir, copy, 'HEAD');
  assert.equal((await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: copy })).stdout.trim(), expected);
  assert.equal((await run('git', ['remote'], { cwd: copy })).stdout.trim(), '');
  assert.equal((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: copy })).stdout.trim(), '1');
});

test('scenario adapter quotes inputs and rejects unsupported harness modes', () => {
  const a = materializeScenario({ test: { kind: 'analyzer', source: 'public string x = "value";' } }, 'A-1');
  assert.equal(a.names[0], 'KatseA1'); assert.match(a.files[0].content, /""value""/);
  assert.throws(() => materializeScenario({ test: { kind: 'shell', source: 'anything' } }, 'x'), /schema/);
});

test('model scenario cannot overwrite orchestrator identity or risk provenance', () => {
  const a = materializeScenario({ id: 'forged', attacker: 'someone-else', riskKey: 'new-risk', originCandidate: 'C99', test: { kind: 'analyzer', source: 'class A {}' } }, 'A-2');
  for (const key of ['id', 'attacker', 'riskKey', 'originCandidate']) assert.equal(a[key], undefined);
  assert.deepEqual(a.names, ['KatseA2']);
});

test('one invalid harness preserves other completed attacks without turning invalid input into a bug', () => {
  const r = { status: 'harness-incompatible', executionComplete: true, tests: [
    { name: 'KatseDiagnostic', outcome: 'Passed' },
    { name: 'KatseInvalid', outcome: 'Failed', error: 'KATSE_HARNESS_INVALID_LIBRARY: CS0102' },
    { name: 'KatseBug', outcome: 'Failed', error: 'Expected diagnostic was absent' },
  ] };
  assert.equal(attackOutcome(attack(), r), 'passed');
  assert.equal(attackOutcome({ names: ['KatseInvalid'] }, r), 'pending');
  assert.equal(attackOutcome({ names: ['KatseBug'] }, r), 'failed');
  assert.equal(attackOutcome(attack(), { ...r, executionComplete: false }), 'pending');
});

test('JSON extraction ignores unrelated code braces but refuses unfinished agent reports', () => {
  assert.deepEqual(parseObject('code { invalid; }\n```json\n{"summary":"done","value":"}"}\n```'), { summary: 'done', value: '}' });
  assert.throws(() => parseObject('Maximum steps reached. Return {"summary":"..."} when done'), /step-limit/);
});

test('.NET cache observes actual restored dependency hashes after building', async () => {
  const dir = temp(), artifacts = temp(); let dependency = 'v1', builds = 0, tests = 0;
  const tc = { kind: 'dotnet', testProjects: ['tests/Test/Test.csproj'], dependencyFiles: ['assets.json'],
    build: async () => { builds++; fs.writeFileSync(path.join(dir, 'assets.json'), dependency); return {ok:true,ms:1,log:'build'}; },
    test: async () => { tests++; return {ok:true,ran:1,passed:1,failed:0,executionComplete:true,tests:[{name:'KatseDiagnostic',outcome:'Passed'}],log:'test'}; }
  };
  const opts = { version: {id:'original',tree:'tree',dir}, attacks:[attack()], contract:contract(), tc, artifacts, environment:{sdk:'8'}, verifyCode:false };
  const first = await evaluate(opts); const reused = await evaluate(opts);
  assert.equal(reused.reused, true); assert.equal(builds, 2); assert.equal(tests, 1);
  dependency = 'v2'; const changed = await evaluate(opts);
  assert.notEqual(first.id, changed.id); assert.equal(tests, 2);
});

test('new symbols absent from base remain explicit behavior groups', () => {
  const it = { files: [{path:'src/Test.cs',kind:'source',hunks:[{oldStart:10,oldLines:1,added:['x = 1;'],removed:['x = 0;']},{oldStart:30,oldLines:0,added:['public void ReportDiagnostic() {}'],removed:[]}]}] };
  const groups = behaviorGroups(it, {symbols:[{file:'src/Test.cs',name:'OldMethod',start:8,end:15,references:[]}]}, contract());
  assert.equal(groups.length, 2); assert.equal(groups[1].fallback, true); assert.equal(groups[1].risk, 3);
});

test('scratch removal guard refuses source repository and outside paths', () => {
  const repo = temp(); assert.throws(() => assertScratch(repo, repo), /outside|contains/);
  assert.throws(() => assertScratch(repo, path.parse(repo).root), /outside/);
  assert.doesNotThrow(() => assertScratch(repo, path.join(temp(), 'candidate')));
});

test('token accounting includes reasoning and honors provider totals', () => {
  assert.equal(usageTokens({total:5955,input:3956,output:962,reasoning:1037}),5955);
  assert.equal(usageTokens({input:10,output:3,reasoning:2,cache:{read:5,write:0}}),20);
});

test('different failure signatures are unstable; historical failures are not labeled new regressions', () => {
  const x = judgeInput(); x.evidence = [result('original',true),result('original',true)];
  x.evidence[0].tests[0].error = 'failure one'; x.evidence[1].tests[0].error = 'failure two';
  assert.equal(adjudicate(x).status,'insufficient-evidence');
  x.evidence[1].tests[0].error = 'failure one'; x.evidence.push(result('historical-base',true));
  assert.equal(adjudicate(x).confirmed[0].attribution,'pre-existing-or-unfixed-contract-violation');
});
