// The judge. It can never approve or reject a change. Given the places where the replicas did not
// reproduce the PR, it only writes the question a person has to answer, and explains why the requirement
// does not settle it. Its wording is model output and is labelled as such; the evidence is the diffs.
import path from 'node:path';
import { ask, clis } from '../llm.js';

const fmt = (lines, sign) => lines.slice(0, 40).map((l) => `${sign} ${l}`).join('\n');

function replicaView(region, replica) {
  const f = replica.files.find((x) => x.path === region.file);
  if (!f) return '(no tocó este fichero)';
  const near = region.old ? f.hunks.filter((h) => h.oldStart >= region.old[0] - 12 && h.oldStart <= region.old[1] + 12) : f.hunks.slice(0, 3);
  if (!near.length) return '(tocó el fichero, pero no esta zona)';
  return near.slice(0, 3).map((h) => `${fmt(h.removed, '-')}\n${fmt(h.added, '+')}`.trim()).join('\n…\n');
}

export async function judge({ requirement, regions, replicas, crossNotes, cwd }) {
  const have = await clis();
  if (!regions.length || !(have.claude || have.opencode)) return { questions: [], skipped: true };
  const ok = replicas.filter((r) => r.ok);
  const blocks = regions.slice(0, 8).map((r) => {
    const per = ok.map((rep) => `· ${rep.label}:\n${replicaView(r, rep)}`).join('\n');
    return `[${r.id}] ${r.file}:${r.newStart}-${r.newEnd} — ${r.verdict === 'surplus' ? `ninguna de ${r.n} réplicas lo hizo` : `${r.same} de ${r.n} réplicas lo hicieron igual`}
${fmt(r.removed, '-')}
${fmt(r.added, '+')}
Qué hizo cada réplica en esa zona:
${per}`;
  }).join('\n\n');
  const decisions = ok.filter((r) => r.decisions && !/^none\.?$/i.test(r.decisions)).map((r) => `· ${r.label}: ${r.decisions.slice(0, 500)}`).join('\n');

  const prompt = `Eres el juez de una revisión de código en un entorno donde el margen de error es cero.
NO puedes aprobar ni rechazar el cambio, ni decir si el código es correcto. Tu único trabajo es formular, para la persona que firma, las decisiones que el requisito no determina.

REQUISITO ${requirement?.id || ''}: ${requirement?.title || '(sin título)'}
${(requirement?.body || '').slice(0, 5000)}

ZONAS DEL PR QUE AGENTES INDEPENDIENTES NO REPRODUJERON AL REHACER EL CAMBIO DESDE EL REQUISITO:

${blocks}

${decisions ? `DECISIONES QUE DECLARARON LAS RÉPLICAS (son afirmaciones suyas, no evidencia):\n${decisions}\n` : ''}${crossNotes ? `RESULTADOS EJECUTADOS:\n${crossNotes}\n` : ''}
Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:
{"questions":[{"regions":["R1"],"question":"…","why":["…","…"],"differ":["…"],"options":["Aceptar tal cual","Devolver al autor","…"]}]}

Reglas:
- Agrupa en una sola pregunta las zonas que responden a la misma decisión. Máximo 3 preguntas. Cada zona debe aparecer en alguna.
- "question": una pregunta concreta sobre el comportamiento, que se pueda responder sin leer todo el PR. En español.
- "why": 2 o 3 razones de por qué el requisito no lo decide y qué consecuencia tiene cada opción. Hechos, no opiniones.
- "differ": cómo lo resolvió cada réplica, en una frase por réplica.
- "options": 2 o 3 respuestas posibles; la primera siempre "Aceptar tal cual".
- No escribas que algo "está bien", "es correcto" o "es seguro".`;

  const res = await ask(prompt, { cwd, timeout: 4 * 60_000 });
  if (!res) return { questions: [], error: 'No hay ningún modelo disponible para redactar las preguntas' };
  const text = res.text;
  const cost = res.cost;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { questions: [], error: 'El juez no devolvió JSON', cost };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { questions: [], error: 'JSON del juez no válido', cost }; }
  const known = new Map(regions.map((x) => [x.id, x]));
  const questions = (parsed.questions || []).slice(0, 3).map((q, i) => {
    const ids = (q.regions || []).filter((id) => known.has(id));
    if (!ids.length || typeof q.question !== 'string') return null;
    const opts = (q.options || []).filter((o) => typeof o === 'string').slice(0, 3);
    if (!/^aceptar/i.test(opts[0] || '')) opts.unshift('Aceptar tal cual');
    return {
      id: `juez-${i + 1}`,
      text: q.question.trim(),
      why: (q.why || []).filter((w) => typeof w === 'string').slice(0, 4),
      differ: (q.differ || []).filter((w) => typeof w === 'string').slice(0, 6),
      options: opts.slice(0, 3),
      regions: ids,
      evidence: ids.map((id) => {
        const x = known.get(id);
        return { label: `${path.basename(x.file)}:${x.newStart}${x.newEnd !== x.newStart ? `–${x.newEnd}` : ''} · ${x.label}`, region: id };
      }),
      source: 'modelo', via: res.via,
    };
  }).filter(Boolean);
  return { questions, cost };
}
