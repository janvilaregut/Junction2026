#!/usr/bin/env node
// Uso: node server/consensus/cli.js <repo> <rama> [--base main] [--agentes 5] [--prompt "..."]
// Sirve también como hook pre-push: sale con código 1 si el consenso no respalda la rama.
import { startConsensus, subscribeConsensus, getConsensus } from './run.js';

const [repo, branch, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
if (!repo || !branch) { console.error('Uso: node server/consensus/cli.js <repo> <rama> [--base main] [--agentes 5] [--prompt "..."] [--lang es|en]'); process.exit(2); }

const short = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const { id } = await startConsensus({ repo, branch, base: opt('base'), agents: opt('agentes'), prompt: opt('prompt'), lang: opt('lang') || 'es' });
console.log(`Verificación ${id}`);
for (const e of getConsensus(id).events) print(e);
await new Promise((resolve) => subscribeConsensus(id, (e) => { print(e); if (e.type === 'done' || e.type === 'error') resolve(); }));
const v = getConsensus(id).verdict;
setTimeout(() => process.exit(v?.verdict === 'coincide' ? 0 : 1), 400);

function print(e) {
  switch (e.type) {
    case 'start': return console.log(`Agentes: ${e.agents.map((a) => `${a.id}(t=${a.temperature},p=${a.topP},k=${a.topK})`).join(' ')} · modelo ${e.model}`);
    case 'phase': return console.log(`\n== ${e.phase.toUpperCase()}: ${e.text}`);
    case 'agent': return console.log(`  [${e.agent}] ${e.status}: ${short(e.text, 100)}`);
    case 'solution': return console.log(`  ✔ ${e.agent}: ${e.files.join(', ') || '(sin cambios)'} +${e.stats?.added}/-${e.stats?.removed} · ${short(e.summary)}`);
    case 'heatmap': {
      const h = e.heatmap;
      console.log(`  Zonas: ${h.zones.length}`);
      for (const z of h.zones) console.log(`   ${z.file}:${z.start}-${z.end}  acuerdo ${Math.round(z.agreement * 100)}%  ${h.agentIds.map((id) => `${id}${z.cells[id].touched ? z.cells[id].cluster : '·'}`).join(' ')}`);
      return console.log(`  Similitud: ${h.agentIds.map((a) => `${a}[${h.agentIds.map((b) => h.matrix[a][b].toFixed(2)).join(' ')}]`).join(' ')}`);
    }
    case 'groups': return console.log(`  Grupos (ronda ${e.round}): ${e.groups.map((g) => `{${g.members.join(',')}}`).join(' ')}`);
    case 'debate': return console.log(`  ⚔ ronda ${e.round}: ${e.pair.join(' vs ')}`);
    case 'argument': return console.log(`    ${e.from}→${e.to}: ${short(e.text, 220)}`);
    case 'convinced': return console.log(`    ★ ${e.winner} convence a ${e.loser}: ${short(e.reason)}`);
    case 'hold': return console.log(`    = ${e.pair.join(' y ')} se mantienen: ${short(e.reason, 200)}`);
    case 'verdict': {
      console.log(`\n>>> VEREDICTO: ${e.verdict} (confianza ${e.confidence}) · consenso {${e.members.join(',')}} · PR dentro: ${e.prInConsensus}${e.prConceded ? ' (se rindió en el debate)' : ''}`);
      console.log(`    ${e.summary}`);
      for (const i of e.issues || []) console.log(`    - ${i.file}: ${i.description}`);
      return undefined;
    }
    case 'error': return console.log(`ERROR: ${e.message}`);
    default: return undefined;
  }
}
