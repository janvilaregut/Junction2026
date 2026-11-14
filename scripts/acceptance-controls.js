// Explicitly prepared controls, separate from discoveries made by the agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, writeJSON } from '../server/util.js';
import { getProject, listProjects, findPullRequest } from '../server/projects.js';
import { intake } from '../server/pipeline/run.js';
import { blindCopy } from '../server/pipeline/sandbox.js';
import { out, git } from '../server/git.js';
import { validateContract } from '../server/pipeline/contract.js';
import { evaluate, attackOutcome } from '../server/pipeline/evidence.js';
import { within } from '../server/execution.js';

const project = process.argv[2] ? getProject(process.argv[2]) : listProjects().find(p => /messagepack/i.test(p.origin || p.path));
if (!project) throw new Error('Open the Tieto MessagePack repository in Katse before running controls.');
const pr = await findPullRequest(project, 'in:ju26-issue-2283');
const it = await intake(project, pr);
const artifactDir = path.join(DATA, 'acceptance', `controls-${Date.now()}`); fs.mkdirSync(artifactDir, { recursive: true });
const base = path.join(os.tmpdir(), 'katse', path.basename(artifactDir));
const contract = validateContract({ expectations: [{ behavior: 'A local public unkeyed property still produces MsgPack004', critical: true, status: 'documented', sources: [{ id: 'prior-test', quote: 'public string {|MsgPack004:Member1|} { get; set; }' }] }] }, [{ id: 'prior-test', uri: `${it.mergeBase}:tests/MessagePack.SourceGenerator.Tests/MsgPack00xAnalyzerTests.cs`, text: await out(it.repo, ['show', `${it.mergeBase}:tests/MessagePack.SourceGenerator.Tests/MsgPack00xAnalyzerTests.cs`]) }]);
const attacks = [{ id: 'CONTROL-LOCAL-DIAGNOSTIC', control: true, hypothesis: 'The proposed patch suppresses diagnostics on local properties', scenario: 'A MessagePackObject in source has a public unkeyed property', expected: 'MsgPack004 on the property', expectations: ['E1'], names: ['KatsePreparedLocalDiagnostic'], status: 'admitted', files: [{ path: 'tests/MessagePack.SourceGenerator.Tests/KatsePreparedControl.cs', content: `using VerifyCS = CSharpCodeFixVerifier<MessagePack.SourceGenerator.Analyzers.MsgPack00xMessagePackAnalyzer, MessagePack.Analyzers.CodeFixes.MessagePackCodeFixProvider>;
public class KatsePreparedControl {
 [Fact] public async Task KatsePreparedLocalDiagnostic() {
  await new VerifyCS.Test { MarkupOptions = Microsoft.CodeAnalysis.Testing.MarkupOptions.UseFirstDescriptor, TestCode = @"using MessagePack;
 [MessagePackObject] public class Foo {
   public int {|MsgPack004:Value|} { get; set; }
 }" }.RunAsync();
 }
}` }] }];
await within(Date.now() + 240000, async () => {
  const originalDir = path.join(base, 'original'); const controlDir = path.join(base, 'control');
  await blindCopy(it.repo, originalDir, it.headSha); await blindCopy(it.repo, controlDir, it.headSha);
  const file = path.join(controlDir, 'src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs');
  const code = fs.readFileSync(file, 'utf8'); if (!code.includes('            report(diagnostic);')) throw new Error('Prepared control no longer matches #2283');
  fs.writeFileSync(file, code.replace('            report(diagnostic);', '            // KATSE PREPARED CONTROL: deliberately discard this diagnostic.'));
  await git(controlDir, ['add', '-A']);
  const versions = [{ id: 'original', dir: originalDir, tree: await out(it.repo, ['rev-parse', `${it.headSha}^{tree}`]) }, { id: 'prepared-control', dir: controlDir, tree: await out(controlDir, ['write-tree']), control: true }];
  const results = [];
  for (const version of versions) results.push(await evaluate({ version, attacks, contract, tc: it.toolchain, environment: { control: true, platform: process.platform }, artifacts: artifactDir }));
  const report = { prepared: true, purpose: 'Acceptance controls, not agent discoveries', original: it.headSha, contract, attacks, results, falseAllegationDiscarded: attackOutcome(attacks[0], results[0]) === 'passed', knownRegressionDetected: attackOutcome(attacks[0], results[1]) === 'failed' };
  writeJSON(path.join(artifactDir, 'controls.json'), report); console.log(JSON.stringify({ artifactDir, falseAllegationDiscarded: report.falseAllegationDiscarded, knownRegressionDetected: report.knownRegressionDetected, results: results.map(r => ({ status: r.status, ran: r.ran })) }));
  if (!report.falseAllegationDiscarded || !report.knownRegressionDetected) process.exitCode = 1;
});
