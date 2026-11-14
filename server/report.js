// Human-facing outputs derived from a brief: the PR description / comment, the sign-off trailers,
// and the answers the assistant gives in the chat. Everything here is read straight from the brief.
import path from 'node:path';

const STATUS = { reproducido: '✅', parcial: '🟡', fallo: '❌', 'no-ejecutado': '⚪' };
const loc = (i) => `${path.basename(i.file)}:${i.start}${i.end !== i.start ? `–${i.end}` : ''}`;

export function markdown(brief, signoff) {
  const b = brief;
  const L = [];
  L.push(`## Informe de verificación · ${b.recommendation?.name || b.lane.name}`);
  if (b.recommendation) L.push('', `**Recomendación:** ${b.recommendation.name}. ${b.recommendation.why} · **Carril:** ${b.lane.name}`);
  L.push('');
  L.push(`**Requisito:** ${b.requirement?.title ? `${b.requirement.id} — ${b.requirement.title}` : 'sin requisito enlazado'}  `);
  L.push(`**Cambio:** \`${b.pr.branch}\` → \`${b.pr.base}\` · \`${b.pr.head.slice(0, 9)}\` · ${b.totals.files} ficheros · +${b.totals.added} −${b.totals.removed}  `);
  L.push(`**Para leer:** ${b.residue.lines} de ${b.totals.lines} líneas  `);
  L.push(`**Procedencia:** ${b.provenance.status === 'none' ? 'sin prompt guardado; intención reconstruida desde el requisito' : b.provenance.status === 'nota' ? 'prompt original guardado con el commit (git notes)' : 'prompt original guardado con el commit (Entire)'}`);
  L.push('');
  L.push('> La revisión automática es un consejo con evidencia. La aprobación es la firma de una persona.');
  if (b.version >= 2) {
    L.push('', '### Contrato, candidatos y juicio', `**Decisión:** ${b.verdict.label}`, `**Contrato:** ${b.contract?.hash || 'pendiente'}`, `**Presupuesto:** ${Math.round(b.budget.elapsedMs / 1000)} / ${Math.round(b.budget.limitMs / 1000)} segundos`);
    for (const e of b.contract?.expectations || []) L.push(`- ${e.id} [${e.status}]: ${e.behavior}`);
    L.push('', '| Candidato | Estado | Padres | Modelo | Checkpoint |', '|---|---|---|---|---|');
    for (const c of b.candidates || []) L.push(`| ${c.id} | ${c.status} | ${c.parents.join(', ') || 'base'} | ${c.model} | ${c.checkpoint?.id || 'pendiente'} |`);
    L.push('', '| Versión | Alcance | Resultado | Tests | Evidencia |', '|---|---|---|---|---|');
    for (const e of b.evidence || []) L.push(`| ${e.version} | ${e.scope} | ${e.status} | ${e.ran || 0} | ${e.artifact} |`);
    if (b.verdict.semantic?.explanation) L.push('', b.verdict.semantic.explanation);
    for (const f of b.verdict.confirmed) L.push(`- Incumplimiento reproducido: ${f.attack} (${f.expectations.join(', ')})`);
    for (const risk of b.verdict.residualRisks) L.push(`- Límite: ${risk}`);
  }
  L.push('');
  L.push('### Por qué este carril');
  for (const r of b.rules.fired) L.push(`- **${r.title}.** ${r.detail}`);
  if (!b.rules.fired.length) L.push('- Ninguna regla de riesgo se ha disparado.');
  L.push('');
  L.push('### Comprobado (con evidencia ejecutada)');
  for (const c of b.claims) L.push(`- ${STATUS[c.status] || '•'} ${c.text} — ${c.detail}`);
  L.push('');
  if (b.questions.length) {
    L.push('### Lo que la IA se ha negado a decidir');
    for (const q of b.questions) {
      L.push(`- **${q.text}**`);
      for (const w of q.why || []) L.push(`  - ${w}`);
      const ans = signoff?.answers?.[q.id];
      if (ans) L.push(`  - Respuesta de ${signoff.signer}: **${ans}**`);
    }
    L.push('');
  }
  if (b.residue.items.length) {
    L.push('### Residuo: lo que debe leer una persona');
    for (const i of b.residue.items.slice(0, 40)) L.push(`- \`${loc(i)}\` (${i.lines} líneas) — ${i.why.join('; ')}`);
    L.push('');
  }
  L.push('### No comprobado');
  for (const n of b.notChecked) L.push(`- **${n.what}.** ${n.why}`);
  L.push('');
  if (signoff) {
    L.push('### Firma');
    L.push(`- **Firmado por:** ${signoff.signer} · ${signoff.ts}`);
    L.push(`- **Decisión:** ${signoff.decision === 'aprobar' ? 'aceptado para merge' : 'devuelto al autor'}`);
    L.push(`- **Riesgo residual aceptado:** ${signoff.residualRisk}`);
    L.push(`- **Informe:** sha256:${signoff.briefHash}`);
    if (signoff.auditRequired) L.push('- **Auditoría:** el área está en prueba; una segunda persona debe auditar este cambio.');
  }
  return L.join('\n');
}

export function trailers(brief, signoff) {
  return [
    `Reviewed-by: ${signoff.signer}`,
    `Katse-Brief: sha256:${signoff.briefHash}`,
    `Katse-Lane: ${brief.lane.id}`,
    `Katse-Read: ${brief.residue.lines}/${brief.totals.lines}`,
    brief.requirement?.id ? `Requirement: ${brief.requirement.id}` : null,
    `Residual-Risk: ${signoff.residualRisk.replace(/\s+/g, ' ').slice(0, 300)}`,
  ].filter(Boolean).join('\n');
}

/** Answer a question about a PR using only what the brief (or the pre-run plan) contains. */
export function answer(question, { brief, plan }) {
  const s = question.toLowerCase();
  const ul = (items) => (items.length ? items.map((x) => `• ${x}`).join('\n') : '• (nada)');
  if (!brief) {
    if (/no (vas|va|se)|no compr|sin compr|qué no|que no/.test(s)) return `Antes de ejecutar ya sé que no podré comprobar:\n${ul(plan.wont.map((w) => `${w.what} — ${w.why}`))}`;
    if (/hacer|compro|verific|plan|pasos/.test(s)) return `Esto es lo que voy a ejecutar:\n${ul(plan.will)}`;
    return `Todavía no he verificado este PR. Son ${plan.totals.files} ficheros (+${plan.totals.added} −${plan.totals.removed}). Pulsa Verificar y te digo qué queda para ti.`;
  }
  const b = brief;
  if (b.version >= 2) {
    if (/juez|juicio|decid|pregunt|duda|fiable/.test(s)) return `${b.verdict.label}.\n${b.verdict.semantic?.explanation || ''}\nPendiente:\n${ul(b.verdict.pending)}`;
    if (/r[eé]plica|agente|rehac|coincid|consenso/.test(s)) return `Alternativas reconstruidas desde la base:\n${ul(b.candidates.map(c => `${c.id}: ${c.status}${c.final ? ' (candidato final)' : ''} · ${c.model}`))}\nLas diferencias abren investigaciones; no se decide por votos.`;
    if (/prompt|procedenc|entire|sesi[oó]n/.test(s)) return `El prompt histórico: ${b.provenance.status === 'none' ? 'no está disponible; usamos el requisito' : b.provenance.status}.\nCheckpoints de nuestras alternativas:\n${ul(b.candidates.map(c => `${c.id}: ${c.checkpoint?.status || 'pendiente'}${c.checkpoint?.id ? ' · ' + c.checkpoint.id : ''}`))}`;
  }
  if (/apr[uo]eb|est[aá] bien|es correcto|puedo (hacer )?merge|mergeo|lo acepto|es seguro/.test(s)) {
    return `Eso no lo decido yo. Te digo lo que está comprobado y lo que no, y firmas tú.\nCarril: ${b.lane.name}. Te quedan ${b.residue.lines} líneas por leer y ${b.questions.length} pregunta(s) por responder.`;
  }
  if (/no (se )?(ha )?compr|no compro|qué no|que no|sin compro|falta/.test(s)) return `No comprobado, y por qué:\n${ul(b.notChecked.map((n) => `${n.what} — ${n.why}`))}`;
  if (/decid|pregunt|negad|duda/.test(s)) return b.questions.length ? `Esto no lo decido yo:\n${ul(b.questions.map((q) => `${q.text}${q.why?.[0] ? `\n   Por qué: ${q.why[0]}` : ''}`))}` : 'No ha quedado ninguna decisión abierta para ti en este PR.';
  if (/recomend|qu[eé] hago|qu[eé] har[ií]as/.test(s) && b.recommendation) return `Recomendación: ${b.recommendation.name}. ${b.recommendation.why}\nLa decisión es tuya.`;
  if (/rebobin|quitar|quita/.test(s)) return b.rewind?.steps?.length ? `Quité cada cambio de código de uno en uno y pasé los tests:\n${ul(b.rewind.steps.map((x) => `${path.basename(x.file)}:${x.start} — ${x.status === 'necesario' ? `necesario: fallan ${x.testCount} test(s) sin él` : x.status === 'sin-test' ? 'ningún test lo nota' : x.status === 'no-compila-sin-el' ? 'sin él no compila' : x.status}`))}` : 'En esta verificación no se ha rebobinado.';
  if (/carril|por qu[eé]|regla|riesgo/.test(s)) return `Carril «${b.lane.name}». Reglas que se han disparado:\n${ul(b.rules.fired.map((r) => `${r.title}: ${r.detail}`))}\nNo hay puntuación: son reglas que puedes leer.`;
  if (/leer|residuo|l[ií]neas|d[oó]nde mir/.test(s)) return b.residue.items.length ? `Tienes que leer ${b.residue.lines} de ${b.totals.lines} líneas:\n${ul(b.residue.items.slice(0, 12).map((i) => `${loc(i)} — ${i.why[0]}`))}` : 'No ha quedado residuo: todo lo comprobable está comprobado.';
  if (/r[eé]plica|agente|rehac|coincid|consenso/.test(s)) {
    if (!b.l3) return 'En esta verificación no se lanzaron réplicas. Usa la verificación completa para rehacer el cambio con agentes.';
    return `${b.l3.n} réplicas terminaron. Por zona del PR:\n${ul(b.l3.regions.filter((r) => r.kind === 'source').map((r) => `${path.basename(r.file)}:${r.newStart} — ${r.verdict === 'consensus' ? `coinciden ${r.same} de ${r.n}` : r.verdict === 'surplus' ? 'ninguna lo hizo' : r.verdict === 'trivial' ? 'solo comentarios' : `solo ${r.same} de ${r.n} igual`}`))}\nQue coincidan no prueba que esté bien: solo indica dónde no hubo que elegir.`;
  }
  if (/test|prueba|rojo|verde|mutant|defecto/.test(s)) return `Evidencia ejecutada:\n${ul(b.claims.filter((c) => ['rojo-verde', 'suite', 'mutacion', 'cruce'].includes(c.id)).map((c) => `[${c.status}] ${c.text} — ${c.detail}`))}`;
  if (/compro|verific|hecho|qu[eé] has|resum|estado/.test(s)) return `Comprobado con evidencia:\n${ul(b.claims.map((c) => `[${c.status}] ${c.text} — ${c.detail}`))}`;
  if (/requisit|issue|pide/.test(s)) return b.requirement?.title ? `Requisito ${b.requirement.id}: ${b.requirement.title}\n${b.requirement.excerpt}` : 'Este PR no tiene un requisito enlazado.';
  if (/prompt|procedenc|entire|sesi[oó]n/.test(s)) return b.provenance.status === 'none' ? 'El commit no trae el prompt guardado. He reconstruido la intención desde el requisito, y por eso cuenta como menos confianza.' : b.provenance.status === 'nota' ? 'El commit trae su prompt original guardado como nota de git. Las réplicas han recibido ese mismo prompt.' : `El commit trae su sesión guardada con Entire (${b.provenance.checkpoints.map((c) => c.checkpoint).join(', ')}).`;
  return null;
}
