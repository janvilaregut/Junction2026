// Human-facing outputs derived from a brief: the PR description / comment, the sign-off trailers,
// and the answers the assistant gives in the chat. Everything here is read straight from the brief.
import path from 'node:path';

const STATUS = { reproducido: '✅', parcial: '🟡', fallo: '❌', 'no-ejecutado': '⚪' };
const loc = (i) => `${path.basename(i.file)}:${i.start}${i.end !== i.start ? `–${i.end}` : ''}`;
const candidateStatus = status => ({ built: 'Parche generado', pending: 'En preparación', failed: 'Generación fallida', timeout: 'Tiempo agotado', duplicate: 'Propuesta duplicada', empty: 'Sin cambios' }[status] || status);
function budgetSummary(b) {
  const budget = b.budget || {}, used = budget.accounting?.observed ?? budget.tokens;
  const incomplete = budget.usageIncomplete || budget.accounting?.usageIncomplete;
  const cumulative = budget.cumulativeTokens ?? (Number.isFinite(budget.inheritedTokens) && Number.isFinite(used) ? budget.inheritedTokens + used : null);
  return `Tokens registrados en esta ejecución: ${used ?? 'pendiente'}${incomplete ? ' (contabilización incompleta)' : ''}.${budget.accounting?.unknownReserved ? ` Hay ${budget.accounting.unknownReserved} tokens reservados para intentos sin consumo confirmado; no representan gasto cero.` : ''}${b.continuation ? ` Continuación de ${b.continuation.runId}.${Number.isFinite(cumulative) ? ` ${budget.cumulativeTokens == null ? 'Anterior + actual' : 'Acumulado de la investigación'}: ${cumulative} tokens registrados.` : ''}` : ''} No equivalen directamente a coste monetario.`;
}
function pendingSummary(value) {
  const text = String(value || ''), start = text.indexOf('[{"type":"error"');
  if (text.startsWith('Contract ambiguity unresolved: ')) return `Ambigüedad del contrato pendiente: ${text.slice('Contract ambiguity unresolved: '.length)}`;
  if (text === 'No contract behavior has executable support') return 'Ningún comportamiento del contrato tiene todavía evidencia ejecutada.';
  if (start >= 0) { try { const e = JSON.parse(text.slice(start))[0]?.error?.data; return `${text.slice(0, start)}Error del proveedor${e?.statusCode ? ` (HTTP ${e.statusCode})` : ''}: ${e?.message || 'ver expediente'}`; } catch {} }
  return text.length > 450 ? `${text.slice(0, 450)}… Detalle completo en pipeline.json.` : text;
}

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
    if (b.verdict.score) {
      const score = b.verdict.score;
      L.push('', `**Confianza de revisión:** ${score.value == null ? 'No evaluable' : `${score.value}/10`}`, `**Alcance:** ${score.scope}`, '', 'Rúbrica heurística: la nota no representa una probabilidad de ausencia de errores.', '', '| Apartado | Puntos | Fundamento | Evidencia |', '|---|---|---|---|');
      for (const c of score.components || []) L.push(`| ${c.label} | ${c.earned}/${c.max} | ${(c.reason || '').replace(/\|/g, '/')} | ${(c.evidence || []).join(', ')} |`);
      for (const c of score.caps || []) L.push(`- Límite ${c.max}/10: ${c.reason}`);
      if (score.explanation) L.push('', score.explanation);
    }
    if (b.intentComparison) {
      L.push('', '### Lo solicitado / lo implementado', 'Interpretaciones con citas verificadas, sin puntos por coincidencia. No recuperan el prompt histórico ni prueban corrección.', `Entire del original: ${b.intentComparison.originalPromptStatus}.`, 'Artefactos: intent-comparison.json y original-change.patch.');
      for (const row of b.intentComparison.rows) L.push(`- ${row.expectation} [${row.assessment}]: solicitado: ${row.requested}; interpretado: ${row.implemented}. ${row.question || ''}`);
    }
    L.push('', budgetSummary(b));
    if (b.verdict.pending?.length) { L.push('', '**Pendiente:**'); for (const p of b.verdict.pending) L.push(`- ${pendingSummary(p)}`); }
    if (b.verdict.findings?.length) {
      L.push('', '### Hallazgos trazables');
      for (const f of b.verdict.findings) {
        L.push('', `**${f.attack}: ${f.classification}**`, `- Hipótesis: ${f.hypothesis}`, `- Origen: ${f.agent || 'agente'}${f.originCandidate ? ` · ${f.originCandidate}` : ''}`, `- Resultado esperado: ${f.expected}`, `- Fundamento: ${(f.sources || []).map(s => `${s.id}: ${s.quote}`).join('; ')}`);
        for (const o of f.outcomes || []) L.push(`- ${o.version}: ${o.outcome} · evidencia ${o.artifact || o.evidence}${o.reused ? ' (reutilizada)' : ''}`);
        L.push(`- Conclusión: ${f.reason}`);
      }
    }
    const debate = Array.isArray(b.debate) ? b.debate : b.debate?.entries || [];
    if (debate.length) {
      L.push('', '### Mesa de debate');
      for (const d of debate) {
        L.push(`- ${d.candidate || d.id || d.role || 'Intervención'} [${d.round || d.status || 'registrada'}]: ${d.summary || d.result?.summary || d.reason || ''}${d.artifact ? ` · ${d.artifact}` : ''}`);
        for (const [key, label] of [['strength', 'Fortaleza'], ['risk', 'Riesgo'], ['expectation', 'Expectativa'], ['scenario', 'Escenario'], ['revision', 'Rectificación']]) if (d[key]) L.push(`  - ${label}: ${d[key]}`);
      }
    }
    L.push('');
    for (const e of b.contract?.expectations || []) L.push(`- ${e.id} [${e.status}]: ${e.behavior}`);
    L.push('', '| Candidato | Estado | Padres | Modelo | Checkpoint |', '|---|---|---|---|---|');
    for (const c of b.candidates || []) L.push(`| ${c.id} | ${candidateStatus(c.status)} | ${c.parents.join(', ') || 'base'} | ${c.model} | ${c.checkpoint?.id || 'pendiente'} |`);
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
  for (const n of b.notChecked) L.push(`- **${pendingSummary(n.what)}.** ${pendingSummary(n.why)}`);
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
    if (/nota|score|puntuaci[oó]n|confianza|fiable/.test(s) && b.verdict.score) {
      const score = b.verdict.score;
      return `${score.value == null ? 'No evaluable' : `${score.value}/10`} · ${b.verdict.label}.\n${score.explanation || ''}\n${ul((score.components || []).map(c => `${c.label}: ${c.earned}/${c.max}. ${c.reason}`))}\n${ul((score.caps || []).map(c => `Límite ${c.max}/10: ${c.reason}`))}\nEs una rúbrica de evidencia para ${score.scope}, no una probabilidad de ausencia de errores.`;
    }
    if (/cost|token|tiempo|dur[oó]|presupuesto|gast/.test(s)) return `Duración: ${Math.round(b.budget.elapsedMs / 1000)} de ${Math.round(b.budget.limitMs / 1000)} segundos. ${budgetSummary(b)}`;
    if (/debate|mesa|intercambio/.test(s)) {
      const entries = Array.isArray(b.debate) ? b.debate : b.debate?.entries || [];
      return entries.length ? `Intervenciones registradas:\n${ul(entries.map(d => `${d.candidate || d.id || d.role || 'Agente'} (${d.round || d.status || 'propuesta'}): ${d.summary || d.result?.summary || d.reason || d.risk || 'ver artefacto'}${d.scenario ? ` Escenario: ${d.scenario}` : ''}${d.revision ? ` Rectificación: ${d.revision}` : ''}`))}\nEl acuerdo entre agentes no suma puntos: sus hipótesis necesitan ejecución.` : 'Esta revisión no tiene intervenciones de debate registradas.';
    }
    if (/problema|hallazgo|acusaci[oó]n|fallo/.test(s) && b.verdict.findings) return `Hallazgos:\n${ul(b.verdict.findings.map(f => `${f.attack} [${f.classification}]: ${f.reason}`))}\nUn fallo exclusivo de un candidato no penaliza al original.`;
    if (/pendiente|no (se )?(ha )?compr|no compro|qu[eé] no|falta/.test(s)) return `Bloqueos del veredicto en el alcance comprobado:\n${ul((b.verdict.pending || []).map(pendingSummary))}\nLimitaciones de la ejecución:\n${ul((b.verdict.auditWarnings || []).map(pendingSummary))}\nAspectos no comprobados:\n${ul((b.notChecked || []).map(n => `${pendingSummary(n.what)} — ${pendingSummary(n.why)}`))}\nRiesgos residuales:\n${ul(b.verdict.residualRisks || [])}`;
    if (/juez|juicio|decid|pregunt|duda|fiable/.test(s)) return `${b.verdict.label}.\n${b.verdict.semantic?.explanation || ''}\nPendiente:\n${ul(b.verdict.pending.map(pendingSummary))}`;
    if (/r[eé]plica|agente|rehac|coincid|consenso/.test(s)) return `Alternativas reconstruidas desde la base:\n${ul(b.candidates.map(c => `${c.id}: ${candidateStatus(c.status)}${c.final ? ' (candidato final)' : ''} · ${c.model}`))}\nGenerar un parche no demuestra que compile ni que pase las pruebas. Las diferencias abren investigaciones; no se decide por votos.`;
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
