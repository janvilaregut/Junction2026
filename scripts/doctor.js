import fs from 'node:fs';
import path from 'node:path';
import { DATA, run, writeJSON } from '../server/util.js';
import { providerPreflight, setupCapture, models, session, checkpoint } from '../server/agents.js';

const dir = path.join(DATA, 'preflight', String(Date.now())); fs.mkdirSync(dir, { recursive: true });
const info = await providerPreflight();
await run('git', ['init', '-q'], { cwd: dir });
await run('git', ['config', 'user.name', 'Katse preflight'], { cwd: dir });
await run('git', ['config', 'user.email', 'katse@localhost'], { cwd: dir });
fs.writeFileSync(path.join(dir, 'probe.txt'), 'base');
await run('git', ['add', 'probe.txt'], { cwd: dir }); await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: dir });
await setupCapture(dir);
const sessions = [];
for (const [role, model] of Object.entries(models())) {
  const prompt = role === 'fast' ? 'Read probe.txt, replace its text with captured, and return {"ok":true}.' : 'No tools. Return exactly {"ok":true}.';
  const s = await session({ dir, artifacts: dir, model, role: role === 'fast' ? 'smoke-tools' : `defense-${role}`, prompt, timeout: 90000, validate: x => x.ok === true });
  sessions.push({ role, model, session: s.sessionId, ms: s.ms });
  if (role === 'fast') { await run('git', ['add', 'probe.txt'], { cwd: dir }); await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'captured preflight'], { cwd: dir }); }
}
const capture = await checkpoint(dir, 'HEAD', dir, 'capture');
const report = { ...info, sessions, capture, sdk: (await run('dotnet', ['--version'])).stdout.trim() };
writeJSON(path.join(dir, 'preflight.json'), report);
console.log(JSON.stringify({ ...info, sessions, capture: capture.status, artifact: path.join(dir, 'preflight.json') }, null, 2));
if (capture.status !== 'captured') process.exitCode = 1;
