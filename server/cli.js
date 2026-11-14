#!/usr/bin/env node
// Command-line entry: verify one branch of a repository and print the brief summary.
//   node server/cli.js <repo> <branch> [--completo] [--mutantes N] [--agentes a,b] [--base rama]
import path from 'node:path';
import { addProject, listPullRequests, updateProject } from './projects.js';
import { startRun, waitFor } from './runs.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [repo, branch] = args.filter((a) => !a.startsWith('--') && a !== flag('--mutantes') && a !== flag('--agentes') && a !== flag('--base'));
if (!repo || !branch) {
  console.error('Uso: node server/cli.js <repo> <rama> [--completo] [--mutantes N] [--agentes a,b] [--base rama]');
  process.exit(2);
}

let project = await addProject(path.resolve(repo));
if (flag('--base')) project = updateProject(project.id, { base: flag('--base') });
const prs = await listPullRequests(project);
const pr = [...prs.incoming, ...prs.outgoing].find((p) => p.branch === branch);
if (!pr) { console.error(`No hay ninguna rama «${branch}» por delante de ${project.base}`); process.exit(2); }

const options = { mode: args.includes('--completo') ? 'completo' : 'rapido' };
if (flag('--mutantes') !== undefined) options.mutants = Number(flag('--mutantes'));
if (flag('--agentes')) options.agents = flag('--agentes').split(',');

const run = await startRun(project, pr, options, (e) => {
  if (e.type === 'stage' && e.status !== 'start') console.log(`${e.status === 'done' ? '●' : e.status === 'skip' ? '○' : '✗'} ${e.name}${e.detail ? ` — ${e.detail}` : ''}${e.ms ? ` (${Math.round(e.ms / 1000)} s)` : ''}`);
  if (e.type === 'log') console.log(`   ${e.text}`);
});
const done = await waitFor(run.id);
if (done.status !== 'done') { console.error(`Falló: ${done.error}`); process.exit(1); }
const b = done.brief;
console.log(`\nCARRIL: ${b.lane.name} — lees ${b.residue.lines} de ${b.totals.lines} líneas`);
for (const r of b.rules.fired) console.log(`  regla: ${r.title} — ${r.detail}`);
for (const c of b.claims) console.log(`  [${c.status}] ${c.text} — ${c.detail}`);
for (const q of b.questions) console.log(`  ? ${q.text}`);
for (const n of b.notChecked) console.log(`  no comprobado: ${n.what} — ${n.why}`);
console.log(`\nInforme: ${done.dir}/artifacts/brief.json`);
