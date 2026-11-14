/* Katse UI. Plain JavaScript, no build step. Everything shown comes from the API; text from
   repositories is always escaped before it reaches the page. */
const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => String(p).split('/').pop();
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 1000)} s`);

async function api(path, opts) {
  const init = opts ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined;
  const r = await fetch('/api' + path, init);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || 'Error');
  return data;
}

const PROFILES = { quick: { name: 'Quick', seconds: 90, tokens: 25000, detail: 'Primeras comprobaciones · sin alternativas' }, standard: { name: 'Standard', seconds: 300, tokens: 100000, detail: 'Dos alternativas · debate y pruebas' }, deep: { name: 'Deep', seconds: 900, tokens: 250000, detail: 'Exploración adicional ante dudas concretas' } };
const savedProfile = localStorage.getItem('katse.profile');
const S = { projects: [], agents: [], clis: {}, project: null, status: null, prs: { incoming: [], outgoing: [] }, side: 'incoming', cur: null, plan: null, run: null, mode: 'completo', profile: PROFILES[savedProfile] ? savedProfile : 'standard', agents_sel: null, mutants: 4, es: null, stageEls: {} };
const number = n => Number.isFinite(n) ? n.toLocaleString('es-ES') : '—';
const candidateStatus = status => ({ built: 'Parche generado', pending: 'En preparación', failed: 'Generación fallida', timeout: 'Tiempo agotado', duplicate: 'Propuesta duplicada', empty: 'Sin cambios' }[status] || status);
function pendingMessage(value) {
  const text = String(value || '');
  if (text.startsWith('Contract ambiguity unresolved: ')) return `Ambigüedad del contrato pendiente: ${text.slice('Contract ambiguity unresolved: '.length)}`;
  if (text === 'No contract behavior has executable support') return 'Ningún comportamiento del contrato tiene todavía evidencia ejecutada.';
  const labels = { 'No testable contract': 'No se ha podido construir un contrato comprobable.', 'Original relevant suite incomplete or failing': 'La suite pertinente del original no terminó correctamente.', 'Baseline/integration suite incomplete': 'La comprobación de la integración o de la base está incompleta.', 'Review budget exhausted or pipeline incomplete': 'El recorrido quedó incompleto o agotó su presupuesto.', 'Final missions incomplete': 'Faltan ataques finales por ejecutar.', 'Semantic review missing or unresolved': 'Falta la revisión semántica final o quedan ambigüedades.', 'Final candidate did not complete a passing relevant suite; this alone does not invalidate the original.': 'La alternativa final no superó toda la suite. Este resultado no demuestra un fallo del original.', 'No candidate Entire checkpoint recovered.': 'No se recuperó un checkpoint de Entire de los candidatos.', 'No valid mutation was executed; attack sensitivity remains unmeasured.': 'No se ejecutaron mutaciones válidas; queda pendiente medir la sensibilidad de los ataques.' };
  if (labels[text]) return labels[text];
  const json = text.indexOf('[{"type":"error"');
  if (json >= 0) {
    try { const errors = JSON.parse(text.slice(json)); const detail = errors[0]?.error?.data; return `${text.slice(0, json)}El proveedor rechazó la petición${detail?.statusCode ? ` (HTTP ${detail.statusCode})` : ''}: ${detail?.message || 'error de API'}`; } catch {}
  }
  return text.length > 450 ? `${text.slice(0, 450)}… Detalle completo en el expediente.` : text;
}
const pid = () => S.project.id;
const TONE = { ok: 't-ok', warn: 't-warn', no: 't-no', bad: 't-bad' };
const CLAIM = { reproducido: ['ok', 'Reproducido'], parcial: ['warn', 'Parcial'], fallo: ['bad', 'Falla'], 'no-ejecutado': ['no', 'No ejecutado'] };

/* ── Chat ─────────────────────────────────────────────────────────────── */
function say(html, who = 'ai', src) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.innerHTML = html + (src ? `<span class="src">${h(src)}</span>` : '');
  $('chat').appendChild(d);
  $('chat').scrollTop = 1e9;
  return d;
}
function busy(on, label) {
  const eye = $('orb');
  if (!on && eye.classList.contains('busy')) { eye.classList.add('blink'); setTimeout(() => eye.classList.remove('blink'), 300); }
  eye.classList.toggle('busy', !!on);
  $('status').textContent = label || (on ? 'TRABAJANDO' : 'EN ESPERA');
}
function chips(list) {
  $('chips').innerHTML = list.map((x) => `<button type="button">${h(x)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => (b.onclick = () => ask(b.textContent)));
}
async function ask(q) {
  if (!S.cur) return;
  say(h(q), 'me');
  busy(true, 'PENSANDO');
  try {
    const r = await api(`/projects/${pid()}/chat`, { body: { pr: S.cur.id, runId: S.run?.brief ? S.run.id : null, mode: S.mode, question: q } });
    say(h(r.text), 'ai', r.source === 'modelo' ? 'Redactado por un modelo a partir del informe. La evidencia está en el panel.' : '');
  } catch (e) { say(h(e.message)); }
  busy(!!S.es, S.es ? 'VERIFICANDO' : null);
}

/* ── Projects and PR list ─────────────────────────────────────────────── */
async function init() {
  const st = await api('/state');
  Object.assign(S, { projects: st.projects, agents: st.agents, clis: st.clis, workspace: st.workspace });
  renderProjects();
  if (!S.projects.length) return openAddProject(true);
  const saved = localStorage.getItem('katse.project');
  await loadProject(S.projects.find((p) => p.id === saved)?.id || S.projects[0].id);
}
function renderProjects() {
  $('project').innerHTML = S.projects.map((p) => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('');
  if (S.project) $('project').value = S.project.id;
}
async function loadProject(id, keep) {
  S.project = S.projects.find((p) => p.id === id);
  localStorage.setItem('katse.project', id);
  $('project').value = id;
  $('list').innerHTML = '<div class="empty">Cargando ramas…</div>';
  const [prs, status] = await Promise.all([api(`/projects/${id}/prs`), api(`/projects/${id}/status`)]);
  S.prs = prs; S.status = status;
  renderEnv();
  if (!S.prs[S.side].length && S.prs[S.side === 'incoming' ? 'outgoing' : 'incoming'].length) S.side = S.side === 'incoming' ? 'outgoing' : 'incoming';
  renderList();
  const all = [...prs.incoming, ...prs.outgoing];
  const again = keep && S.cur && all.find((p) => p.id === S.cur.id);
  if (again) { S.cur = again; renderList(); return; }
  const remembered = localStorage.getItem('katse.pr.' + id);
  const first = S.prs[S.side].find(p => p.id === remembered) || S.prs[S.side][0];
  if (first) selectPR(first); else { S.cur = null; $('panel').innerHTML = `<h3>Sin cambios pendientes</h3><p class="sub">No hay ramas por delante de <code>${h(prs.base)}</code>. Crea una rama o cambia la rama base en los ajustes.</p>`; $('chat').innerHTML = ''; chips([]); }
}
function renderEnv() {
  const s = S.status;
  const e = s.entire.enabled ? ['ok', 'Entire activo'] : s.entire.installed ? ['warn', 'Entire sin activar'] : ['no', 'Entire no instalado'];
  const n = S.agents.length;
  $('env').innerHTML = `<span class="pill">base ${h(S.prs.base)}</span><span class="pill ${e[0]}" title="Entire guarda el prompt de cada commit">${e[1]}</span><span class="pill ${n ? 'ok' : 'warn'}">${n} agentes</span>`;
}
function renderList() {
  $('tIn').classList.toggle('on', S.side === 'incoming');
  $('tOut').classList.toggle('on', S.side === 'outgoing');
  $('nIn').textContent = S.prs.incoming.length || '';
  $('nOut').textContent = S.prs.outgoing.length || '';
  const list = S.prs[S.side];
  if (!list.length) {
    $('list').innerHTML = `<div class="empty">${S.side === 'incoming' ? 'No hay ramas remotas pendientes de revisar.' : 'No tienes ramas locales por enviar. Crea una rama, haz commit y aparecerá aquí.'}</div>`;
    return;
  }
  $('list').innerHTML = list.map((p, i) => {
    const l = p.last;
    const chip = p.running ? '<span class="pill warn">verificando…</span>'
      : l ? `<span class="pill ${l.tone === 'ok' ? 'ok' : l.tone === 'warn' ? 'warn' : 'no'}">${h(l.laneName)}</span><span class="pill">${l.residue}/${l.total} líneas</span>${l.signedBy ? (l.stale ? '<span class="pill bad">firma caducada</span>' : `<span class="pill ok">${l.decision === 'devolver' ? 'devuelto' : 'firmado'}</span>`) : l.stale ? '<span class="pill bad">desactualizado</span>' : ''}`
        : '<span class="pill">sin verificar</span>';
    return `<button type="button" class="pr ${S.cur?.id === p.id ? 'on' : ''}" data-i="${i}"><div class="id">${p.requirement ? '#' + h(p.requirement) + ' · ' : ''}${h(p.branch)}</div><div class="t">${h(p.title)}</div><div class="meta">${chip}</div></button>`;
  }).join('');
  $('list').querySelectorAll('.pr').forEach((el) => (el.onclick = () => selectPR(list[el.dataset.i])));
}

async function selectPR(pr) {
  localStorage.setItem('katse.pr.' + pid(), pr.id);
  if (S.es) { S.es.close(); S.es = null; }
  Object.assign(S, { cur: pr, run: null, plan: null, signed: null });
  renderList();
  $('chat').innerHTML = '';
  $('panel').innerHTML = '<p class="sub">Cargando…</p>';
  busy(false);
  try {
    if (pr.running) return attach(pr.running);
    if (pr.last) {
      S.run = await api(`/projects/${pid()}/runs/${pr.last.runId}`);
      if (S.run.brief) { renderBrief(); greetBrief(); return; }
    }
    await loadPlan();
  } catch (e) { $('panel').innerHTML = `<p class="err">${h(e.message)}</p>`; }
}

/* ── Plan (before verifying) ──────────────────────────────────────────── */
async function loadPlan() {
  S.plan = await api(`/projects/${pid()}/plan?pr=${encodeURIComponent(S.cur.id)}&mode=${S.mode}&profile=${S.profile}`);
  renderPlan();
  const p = S.plan;
  say(`<b>${h(S.cur.branch)}</b> — ${h(S.cur.title)}\n${p.totals.files} ficheros, +${p.totals.added} −${p.totals.removed}. Todavía no lo he verificado. A la derecha tienes lo que voy a comprobar y lo que no.`);
  chips(['¿Qué vas a hacer?', '¿Qué no vas a comprobar?']);
}
function optionsHTML() {
  const p = PROFILES[S.profile];
  return `<div class="seg profiles" role="group" aria-label="Profundidad de revisión">${Object.entries(PROFILES).map(([id, x]) => `<button type="button" data-profile="${id}" aria-pressed="${S.profile === id}" class="${S.profile === id ? 'on' : ''}"><b>${x.name}</b><small>Hasta ${secs(x.seconds * 1000)}</small></button>`).join('')}</div>
    <p class="sub profile-description">${h(p.detail)}. Presupuesto: hasta <b>${number(p.tokens)} tokens</b>. Son límites de ejecución; las comprobaciones que no terminen quedarán pendientes.</p>`;
}
function bindOptions(rerender) {
  $('panel').querySelectorAll('[data-profile]').forEach((b) => (b.onclick = () => { S.mode = 'completo'; S.profile = b.dataset.profile; localStorage.setItem('katse.profile', S.profile); rerender(); }));
  $('panel').querySelectorAll('.agents input').forEach((c) => (c.onchange = () => { S.agents_sel = [...$('panel').querySelectorAll('.agents input:checked')].map((x) => x.value); }));
}
function renderPlan() {
  const p = S.plan;
  const req = p.requirement;
  const li = (items, cls) => items.map((x) => `<div class="item"><span class="dot ${cls}"></span><div><div class="ttl">${h(x.what || x)}</div>${x.why ? `<div class="d">${h(x.why)}</div>` : ''}</div></div>`).join('');
  $('panel').innerHTML = `
    <h3>${S.cur.direction === 'incoming' ? 'PR recibido' : 'Tu rama, antes de enviarla'}</h3>
    <div class="big">${p.totals.files} ficheros</div>
    <div class="sub">+${p.totals.added} −${p.totals.removed} · ${Object.entries(p.kinds).map(([k, v]) => `${v.files} ${kindName(k)}`).join(' · ')}</div>
    <dl class="kv" style="margin-top:12px">
      <dt>Requisito</dt><dd>${req?.title ? `${req.url ? `<a href="${h(req.url)}" target="_blank" rel="noopener">${h(req.id)}</a>` : h(req.id)} — ${h(req.title)}` : '<span class="t-warn">no encontrado</span>'}</dd>
      <dt>Procedencia</dt><dd>${p.provenance === 'none' ? 'sin prompt guardado (se usará el requisito)' : p.provenance === 'nota' ? '<span class="t-ok">prompt original guardado con el commit</span> (git notes)' : '<span class="t-ok">prompt original guardado con el commit</span> (Entire)'}</dd>
      <dt>Tests</dt><dd>${h(p.toolchain)}</dd>
    </dl>
    ${p.provenance === 'none' ? `<details style="margin-top:8px"><summary><span class="sub">Añadir el prompt con el que se generó este cambio</span></summary>
      <p class="sub" style="margin:6px 0">Se guarda con el commit como nota de git. Las réplicas recibirán este mismo prompt en lugar de solo la issue. Con Entire activo esto ocurre solo.</p>
      <textarea id="prompt" rows="4" placeholder="Pega aquí el prompt original que recibió el agente"></textarea>
      <button class="act quiet" id="savePrompt">Guardar con el commit</button><div id="prerr" class="err"></div></details>` : ''}
    <h3>Voy a comprobar</h3>${li(p.will, 'ok')}
    <h3>No voy a comprobar</h3>${li(p.wont, 'no')}
    <h3>Verificación</h3>${optionsHTML()}
    <button class="act solid" id="run">${S.cur.direction === 'incoming' ? 'Verificar' : 'Verificar antes de enviar'}</button>
    <div id="perr" class="err"></div>`;
  bindOptions(async () => { await refreshPlan(); });
  $('run').onclick = () => verify();
  if ($('savePrompt')) $('savePrompt').onclick = async () => {
    try { await api(`/projects/${pid()}/prompt`, { body: { pr: S.cur.id, prompt: $('prompt').value } }); await refreshPlan(); say('Prompt guardado con el commit. Las réplicas lo usarán como instrucción original.'); }
    catch (e) { $('prerr').textContent = e.message; }
  };
}
async function refreshPlan() { S.plan = await api(`/projects/${pid()}/plan?pr=${encodeURIComponent(S.cur.id)}&mode=${S.mode}&profile=${S.profile}`); renderPlan(); }
const kindName = (k) => ({ source: 'de código', test: 'de test', doc: 'de docs', config: 'de config', derived: 'derivados' }[k] || k);

/* ── Verification (live) ──────────────────────────────────────────────── */
async function verify() {
  const options = { mode: 'completo', profile: S.profile, mutants: S.mutants };
  if (S.mode === 'completo' && S.agents_sel) options.agents = S.agents_sel;
  try {
    const r = await api(`/projects/${pid()}/verify`, { body: { pr: S.cur.id, options } });
    say(`Empiezo con ${PROFILES[S.profile].name}: hasta ${secs(PROFILES[S.profile].seconds * 1000)} y ${number(PROFILES[S.profile].tokens)} tokens. Trabajo en copias locales del código.`);
    attach(r.runId);
  } catch (e) {
    const el = $('perr') || $('panel');
    el.innerHTML = `<span class="err">${h(e.message)}</span>`;
  }
}
function attach(runId) {
  S.stageEls = {};
  busy(true, 'VERIFICANDO');
  chips([]);
  $('panel').innerHTML = '<h3>Verificando</h3><p class="sub">Puedes seguir cada paso en el centro. Al terminar verás aquí el informe.</p><div id="steps"></div>';
  const prId = S.cur.id;
  const es = new EventSource(`/api/projects/${pid()}/runs/${runId}/events`);
  S.es = es;
  es.onmessage = async (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'stage') stageLine(e);
    else if (e.type === 'contract') stageLine({ id: 'contract', name: 'Contrato revisado', status: 'done', detail: `${e.expectations.length} expectativas · ${e.hash.slice(0, 10)}` });
    else if (e.type === 'candidate') stageLine({ id: `candidate-${e.id}`, name: `Alternativa ${e.id}`, status: e.status === 'pending' ? 'start' : e.status === 'built' ? 'done' : 'skip', detail: candidateStatus(e.status) });
    else if (e.type === 'attack') stageLine({ id: e.id, name: `Ataque ${e.id}`, status: e.status === 'admitted' ? 'done' : 'skip', detail: `${e.status} · ${e.mission}` });
    else if (e.type === 'result') line(e.status === 'passed' ? 'done' : 'skip', '·', `${h(e.version)}: ${h(e.status)} · ${e.ran || 0} tests ejecutados`);
    else if (e.type === 'debate') stageLine({ id: `debate-${e.id || e.candidate || 'round'}`, name: 'Mesa de debate', status: e.status === 'pending' ? 'start' : 'done', detail: e.summary || e.status || 'Decisiones y riesgos registrados' });
    else if (e.type === 'budget') stageLine({ id: 'budget', name: 'Presupuesto', status: 'start', detail: `${number(e.tokens ?? e.spent ?? e.used)} tokens contabilizados` });
    else if (e.type === 'judgment') stageLine({ id: 'judgment', name: 'Juicio final', status: 'done', detail: e.verdict.label });
    else if (e.type === 'log') line('start', '·', h(pendingMessage(e.text)));
    else if (e.type === 'error') line('fail', '✗', h(pendingMessage(e.text)));
    else if (e.type === 'end') {
      es.close(); S.es = null; busy(false);
      await loadProject(pid(), true);
      if (S.cur?.id !== prId) return;
      S.run = await api(`/projects/${pid()}/runs/${runId}`);
      if (S.run.brief) { renderBrief(); const b = S.run.brief; say(b.verdict ? `Revisión terminada en ${secs(b.timing.totalMs)}. <b>${h(b.verdict.label)}</b>${b.verdict.score ? ` · confianza ${b.verdict.score.value == null ? 'no evaluable' : h(b.verdict.score.value) + '/10'}` : ''}. ${b.verdict.pending?.length || 0} comprobaciones o dudas pendientes. Abre cada apartado para ver sus pruebas. La aprobación es tuya.` : `Listo en ${secs(b.timing.totalMs)}. Carril <b>${h(b.lane.name)}</b>: quedan ${b.residue.lines} de ${b.totals.lines} líneas por revisar.`); briefChips(); }
      else $('panel').innerHTML = `<p class="err">La verificación falló: ${h(S.run.error || 'error desconocido')}</p><button class="act" id="retry">Volver</button>`, ($('retry').onclick = () => loadPlan());
    }
  };
  es.onerror = () => { if (S.es === es) { es.close(); S.es = null; busy(false); } };
}
function line(cls, icon, html) {
  const d = document.createElement('div');
  d.className = 'ev ' + cls;
  d.innerHTML = `<i>${icon}</i><span>${html}</span>`;
  $('chat').appendChild(d);
  $('chat').scrollTop = 1e9;
  return d;
}
function stageLine(e) {
  let el = S.stageEls[e.id];
  const icon = { start: '◌', done: '●', skip: '○', fail: '✗' }[e.status];
  const html = `${h(e.name)}${e.detail ? ` <small>— ${h(e.detail)}</small>` : ''}${e.ms ? ` <small>(${secs(e.ms)})</small>` : ''}`;
  if (!el) el = S.stageEls[e.id] = line(e.status, icon, html);
  el.className = 'ev ' + (e.status === 'skip' ? '' : e.status);
  el.innerHTML = `<i>${icon}</i><span>${html}</span>`;
  const steps = $('steps');
  if (steps) steps.innerHTML = Object.values(S.stageEls).map((x) => `<div class="${x.className}">${x.innerHTML}</div>`).join('');
}

/* ── Brief ────────────────────────────────────────────────────────────── */
function greetBrief() {
  const b = S.run.brief;
  say(`<b>${h(S.cur.branch)}</b> — ${h(S.cur.title)}\nRevisión del ${new Date(b.createdAt).toLocaleString()}. ${b.verdict ? `<b>${h(b.verdict.label)}</b>${b.verdict.score ? ` · confianza ${b.verdict.score.value == null ? 'no evaluable' : h(b.verdict.score.value) + '/10'}` : ''}. ${b.verdict.pending?.length || 0} comprobaciones o dudas pendientes.` : `Carril <b>${h(b.lane.name)}</b>: lees ${b.residue.lines} de ${b.totals.lines} líneas.`}${S.run.signoff ? `\nFirmado por ${h(S.run.signoff.signer)}.` : ''}`);
  briefChips();
}
const briefChips = () => chips(['¿Por qué esta nota?', '¿Qué problemas encontraste?', '¿Qué queda pendiente?', '¿Cuánto ha costado?', '¿Qué aportó el debate?']);
const ev = (e) => e.artifact ? `<button type="button" class="linkbtn" data-art="${h(e.artifact)}">${h(e.label)}</button>` : e.url ? `<a href="${h(e.url)}" target="_blank" rel="noopener">${h(e.label)}</a>` : `<span class="mono" style="color:var(--dim)">${h(e.label)}</span>`;
function codeHTML(item) {
  if (!item.code?.length) return '';
  return `<pre class="code">${item.code.map((c) => `<span class="h">@@ línea ${c.at}</span>\n${c.removed.map((l) => `<span class="r">- ${h(l)}</span>`).join('\n')}${c.removed.length && c.added.length ? '\n' : ''}${c.added.map((l) => `<span class="a">+ ${h(l)}</span>`).join('\n')}`).join('\n')}</pre>`;
}
function evidenceLinks(ids, b) {
  return [...new Set(ids || [])].map(id => {
    const e = (b.evidence || []).find(x => x.id === id || x.artifact === id);
    return e?.artifact ? ev({ artifact: e.artifact, label: `${e.version}: ${e.status}` }) : `<span class="mono">${h(id)}</span>`;
  }).join(' · ');
}
function scoreHTML(b) {
  const score = b.verdict?.score;
  if (!score) return '';
  const tone = b.verdict.status === 'request-changes' ? 'bad' : b.verdict.status === 'ready-for-human' ? 'ok' : 'warn';
  return `<section class="score-card" aria-label="Confianza de la revisión"><div class="score-heading"><div><div class="sub">Confianza de revisión</div><div class="score-number t-${tone}">${score.value == null ? '<span class="not-evaluable">No evaluable</span>' : `${h(score.value)}<small>/10</small>`}</div></div><span class="pill ${tone}">${h(b.verdict.label)}</span></div>
    <p class="sub">Evalúa el cambio original${b.pr?.head ? ` <span class="mono">${h(b.pr.head.slice(0, 9))}</span>` : ''}: ${h(score.scope)}. Los fallos exclusivos de alternativas no lo penalizan. Rúbrica heurística; la nota no es una probabilidad de ausencia de errores.</p>
    ${(score.components || []).map(c => `<details class="score-part"><summary><span>${h(c.label)}</span><b>${h(c.earned)} / ${h(c.max)}</b></summary><p class="sub">${h(c.reason)}</p><div class="links">${evidenceLinks(c.evidence, b)}</div>${c.expectations?.length ? `<div class="sub">Expectativas: ${c.expectations.map(h).join(', ')}</div>` : ''}</details>`).join('')}
    ${(score.caps || []).map(c => `<p class="sub t-warn">Límite ${h(c.max)}/10: ${h(c.reason)}</p>`).join('')}
    ${score.explanation ? `<p class="sub">${h(score.explanation)}</p>` : ''}
    <details ${b.verdict.pending?.length ? 'open' : ''}><summary>Qué queda pendiente · ${b.verdict.pending?.length || 0}</summary>${(b.verdict.pending || []).map(x => `<div class="item"><span class="dot no"></span><span class="sub">${h(pendingMessage(x))}</span></div>`).join('') || '<p class="sub">No hay comprobaciones obligatorias pendientes para este alcance. Revisa los riesgos residuales antes de firmar.</p>'}<div class="links">${ev({artifact:'pipeline.json',label:'Ver expediente y errores completos'})}</div></details>
    ${(b.verdict.residualRisks || []).length ? `<details><summary>Límites del alcance</summary>${b.verdict.residualRisks.map(x => `<p class="sub">${h(x)}</p>`).join('')}</details>` : ''}</section>`;
}
function findingsHTML(b) {
  const labels = { 'confirmed-original': 'Incumplimiento confirmado del original', 'original-failure-unconfirmed': 'Fallo del original pendiente de confirmar', 'candidate-only': 'Fallo exclusivo de una alternativa', refuted: 'Acusación refutada', 'invalid-test': 'Prueba inválida', pending: 'Pendiente', unstable: 'Resultado inestable' };
  return `<details open><summary>Hallazgos trazables · ${b.verdict.findings.length}</summary>${b.verdict.findings.map(f => `<details class="finding"><summary><span><b>${h(labels[f.classification] || f.classification)}</b><span class="why">${h(f.hypothesis)}</span></span></summary><dl class="kv"><dt>Origen</dt><dd>${h(f.agent || 'Agente')}${f.originCandidate ? ` · ${h(f.originCandidate)}` : ''}</dd><dt>Esperado</dt><dd>${h(f.expected)}</dd><dt>Escenario</dt><dd>${h(f.scenario)}</dd><dt>Fundamento</dt><dd>${(f.sources || []).map(s => `${h(s.id)}: ${h(s.quote)}`).join('<br>')}</dd></dl><table><tr><th>Versión</th><th>Prueba</th><th>Evidencia</th></tr>${(f.outcomes || []).map(o => `<tr><td>${h(o.version)}</td><td>${h({ passed:'Pasa',failed:'Falla',pending:'Pendiente' }[o.outcome] || o.outcome)}${o.reused ? ' · reutilizada' : ''}</td><td>${o.artifact ? ev({artifact:o.artifact,label:o.attempt === 'reproduction' ? 'Repetición' : 'Ejecución'}) : h(o.evidence)}</td></tr>`).join('')}</table><p class="sub">${h(f.reason)}</p>${f.attribution ? `<p class="sub">Atribución: ${h(f.attribution)}</p>` : ''}</details>`).join('')}</details>`;
}
function debateHTML(b) {
  const entries = Array.isArray(b.debate) ? b.debate : b.debate?.entries || [];
  if (!entries.length) return '<p class="sub">Sin intervenciones de debate registradas en esta revisión.</p>';
  return entries.map(d => `<div class="note"><b>${h(d.candidate || d.id || d.role || 'Intervención')}</b>${d.model ? ` · ${h(d.model)}` : ''}${d.round ? ` · ${d.round === 'results' ? 'Tras las pruebas' : 'Propuestas'}` : ''}${d.status ? ` · ${h(d.status)}` : ''}\n${h(d.summary || d.result?.summary || d.reason || '')}${d.strength ? `\n<b>Fortaleza:</b> ${h(d.strength)}` : ''}${d.risk ? `\n<b>Riesgo:</b> ${h(d.risk)}` : ''}${d.expectation ? `\n<b>Expectativa:</b> ${h(d.expectation)}` : ''}${d.scenario ? `\n<b>Escenario:</b> ${h(d.scenario)}` : ''}${d.revision ? `\n<b>Rectificación:</b> ${h(d.revision)}` : ''}${d.artifact ? `<div class="links">${ev({artifact:d.artifact,label:'Decisiones y argumentos'})}</div>` : ''}${d.error ? `<div class="sub">${h(d.error)}</div>` : ''}</div>`).join('');
}
function budgetHTML(b) {
  const budget = b.budget || {};
  const used = budget.accounting?.observed ?? budget.tokens ?? budget.tokenUsage?.spent ?? budget.usage?.spent;
  const limit = budget.accounting?.limit ?? budget.tokenLimit ?? budget.tokenBudget?.limit ?? (typeof budget.tokenBudget === 'number' ? budget.tokenBudget : null);
  const cumulative = budget.cumulativeTokens ?? (Number.isFinite(budget.inheritedTokens) && Number.isFinite(used) ? budget.inheritedTokens + used : null);
  return `<div class="budget-strip"><span>${h(PROFILES[b.options?.profile]?.name || b.options?.profile || 'Revisión')} · ${secs(budget.elapsedMs || 0)} / ${secs(budget.limitMs || 0)}</span><span>${number(used)}${limit ? ` / ${number(limit)}` : ''} tokens registrados</span></div><p class="sub">Consumo comunicado por los proveedores${budget.usageIncomplete || budget.accounting?.usageIncomplete ? ' · contabilización incompleta' : ''}. No equivale directamente a coste monetario.${budget.accounting?.unknownReserved ? ` Hay ${number(budget.accounting.unknownReserved)} tokens reservados para intentos cuyo consumo no se confirmó; no se cuentan como gasto cero.` : ''}</p>${b.continuation ? `<p class="sub">Continuación de <span class="mono">${h(b.continuation.runId)}</span>. ${Number.isFinite(cumulative) ? `${budget.cumulativeTokens == null ? 'Anterior + actual' : 'Acumulado de la investigación'}: <b>${number(cumulative)} tokens registrados</b>.` : 'Consumo acumulado pendiente.'} Las pruebas se validan de nuevo para esta ejecución.</p>` : ''}${budget.accounting?.exceeded ? '<p class="banner">El consumo comunicado superó la reserva estimada. Se detuvo la admisión de nuevas tareas; revisa el alcance pendiente.</p>' : ''}`;
}
function courtroomHTML(b) {
  return `<h3>Reconstrucción y juicio</h3>${budgetHTML(b)}<p class="sub">Contrato ${h(b.contract?.hash?.slice(0, 12) || 'pendiente')}</p>
  ${b.verdict.findings?.length ? findingsHTML(b) : ''}
  <details ${b.debate?.length ? 'open' : ''}><summary>Mesa de debate</summary>${debateHTML(b)}</details>
  <details open><summary>Contrato comprobable</summary>${(b.contract?.expectations || []).map(e => `<div class="note"><b>${h(e.id)} · ${h(e.status)}</b> ${h(e.behavior)}<div class="sub">${(e.sources || []).map(s => h(s.id + ': ' + s.quote)).join(' · ')}</div></div>`).join('')}</details>
  <details open><summary>Alternativas · ${b.candidates.length}</summary><table><tr><th>Candidato</th><th>Estado</th><th>Procedencia</th></tr>${b.candidates.map(c => `<tr><td>${h(c.id)}${c.final ? ' · final' : ''}<div class="sub">${h(c.model)} · padres: ${h(c.parents.join(', ') || 'base')}</div></td><td>${h(candidateStatus(c.status))}${c.patch ? `<br><button class="linkbtn" data-art="${h(c.patch)}">Parche</button>` : ''}</td><td>${c.checkpoint?.metadata ? `<button class="linkbtn" data-art="${h(c.checkpoint.metadata)}">Checkpoint</button> <button class="linkbtn" data-art="${h(c.checkpoint.transcript)}">Transcripción</button>` : 'Sin checkpoint'}${c.error ? `<div class="sub">${h(c.error)}</div>` : ''}</td></tr>`).join('')}</table></details>
  <details open><summary>Pruebas compartidas · ${b.attacks.length} propuestas</summary>${b.attacks.map(a => `<div class="note"><b>${h(a.id)} · ${h(b.verdict.semantic?.invalidAttacks?.some(x => x.id === a.id) ? "excluido por el juez" : a.status)}</b><div>${h(a.hypothesis || a.mission)}</div><button class="linkbtn" data-art="${h(a.id)}.json">Escenario y defensa</button></div>`).join('')}<table><tr><th>Versión</th><th>Resultado</th><th>Tests</th></tr>${b.evidence.map(e => `<tr><td>${h(e.version)}<div class="sub">${h(e.scope)}</div></td><td>${h(e.status)} <button class="linkbtn" data-art="${h(e.artifact)}">Evidencia</button>${e.log ? ` <button class="linkbtn" data-art="${h(e.log)}">Log</button>` : ''}</td><td>${e.ran || 0}</td></tr>`).join('')}</table></details>
  <details><summary>Explicación del juez</summary><p>${h(b.verdict.semantic?.explanation || 'Revisión semántica pendiente')}</p>${b.verdict.pending.map(p => `<p class="sub">· ${h(pendingMessage(p))}</p>`).join('')}${(b.verdict.auditWarnings || []).map(p => `<p class="sub">Observación: ${h(pendingMessage(p))}</p>`).join('')}<button class="linkbtn" data-art="pipeline.json">Expediente completo</button></details>`;
}

function renderBrief(keepScroll) {
  const run = S.run; const b = run.brief; const so = run.signatureValid === false ? null : run.signoff;
  const scrollWas = $('panel').scrollTop;
  const stale = S.cur.sha && !b.pr.head.startsWith(S.cur.sha);
  const req = b.requirement;
  const P = [];
  if (stale) P.push(so ? `<div class="banner">Firma caducada. ${h(so.signer)} firmó el commit <span class="mono">${h(so.head.slice(0, 9))}</span> y la rama ya está en <span class="mono">${h(S.cur.sha)}</span>. Lo que se comprobó valía para ese commit: vuelve a verificar y a firmar.</div>` : '<div class="banner">La rama ha cambiado desde esta verificación. El informe ya no corresponde al código actual: vuelve a verificar.</div>');
  if (b.verdict?.score) P.push(scoreHTML(b));
  if (b.recommendation) { const rc = { cambios: 'bad', insuficiente: 'warn', lista: 'ok' }[b.recommendation.id] || (b.verdict?.status === 'request-changes' ? 'bad' : b.verdict?.status === 'ready-for-human' ? 'ok' : 'warn'); P.push(`<div class="reco t-${rc}"><span class="sub">Recomendación</span><b>${h(b.recommendation.name)}</b><span class="sub">${h(b.recommendation.why)}</span></div>`); }
  P.push(`<span class="lane ${TONE[b.lane.tone]}">${h(b.lane.name)}</span>
    <div class="big">${b.residue.lines} <span style="color:var(--dim)">de ${b.totals.lines} líneas</span></div>
    <div class="sub">${h(b.lane.summary)}</div>
    <dl class="kv" style="margin-top:12px">
      <dt>Requisito</dt><dd>${req?.title ? `${req.url ? `<a href="${h(req.url)}" target="_blank" rel="noopener">${h(req.id)}</a>` : h(req.id)} — ${h(req.title)}` : '<span class="t-warn">sin requisito enlazado</span>'}</dd>
      <dt>Cambio</dt><dd><span class="mono">${h(b.pr.branch)} → ${h(b.pr.base)} · ${h(b.pr.head.slice(0, 9))}</span> · ${b.totals.files} ficheros · +${b.totals.added} −${b.totals.removed}</dd>
      <dt>Procedencia</dt><dd>${b.provenance.status === 'none' ? '<span class="t-warn">sin prompt guardado</span>; intención reconstruida desde el requisito' : `<span class="t-ok">prompt original guardado con el commit</span> (${b.provenance.status === 'nota' ? 'git notes' : 'Entire'})`}</dd>
    </dl>`);

  if (b.version >= 2) P.push(courtroomHTML(b));
  P.push('<h3>Por qué este carril</h3>');
  P.push(b.rules.fired.length ? b.rules.fired.map((r) => `<div class="item"><span class="dot ${r.lane === 'devolver' ? 'bad' : r.lane === 'residuo' ? 'ok' : 'warn'}"></span><div><div class="ttl">${h(r.title)}</div><div class="d">${h(r.detail)}</div>${r.evidence?.length ? `<div class="links">${r.evidence.map(ev).join('')}</div>` : ''}</div></div>`).join('') : '<p class="sub">No se ha disparado ninguna regla de riesgo.</p>');
  P.push(`<details><summary><span class="sub">Reglas que no se han disparado (${(b.rules.notFired || []).length})</span></summary><div class="sub" style="padding:6px 0 0 18px">${(b.rules.notFired || []).map((r) => h(r.title)).join(' · ')}</div></details>`);

  if (b.questions.length) {
    P.push(`<h3>Decides tú · ${b.questions.length}</h3>`);
    P.push(b.questions.map((q) => `<div class="q" data-q="${h(q.id)}">
      <div class="text">${h(q.text)}</div>
      ${q.why?.length ? `<ul>${q.why.map((w) => `<li>${h(w)}</li>`).join('')}</ul>` : ''}
      ${q.differ?.length ? `<div class="note"><b>Cómo lo resolvió cada réplica</b>\n${q.differ.map((d) => '· ' + h(d)).join('\n')}</div>` : ''}
      ${q.evidence?.length ? `<div class="links">${q.evidence.map(ev).join('')}</div>` : ''}
      ${q.options.map((o) => `<label class="opt"><input type="radio" name="q-${h(q.id)}" value="${h(o)}" ${so?.answers?.[q.id] === o ? 'checked' : ''} ${so ? 'disabled' : ''}><span>${h(o)}</span></label>`).join('')}
      <div class="tag" style="margin-top:6px">${q.source === 'modelo' ? 'Pregunta redactada por un modelo. La evidencia son los diffs enlazados.' : 'Pregunta generada por una regla.'}</div>
    </div>`).join(''));
  }

  if (b.residue.items.length) {
    P.push(`<h3>Residuo · lo que lees tú</h3>`);
    P.push(b.residue.items.map((i) => `<details><summary><span><span class="mono">${h(base(i.file))}:${i.start}${i.end !== i.start ? '–' + i.end : ''}</span> <span class="sub">· ${i.lines} ${i.lines === 1 ? 'línea' : 'líneas'}</span><span class="why">${h(i.why.join(' · '))}</span></span></summary>${codeHTML(i)}<div class="sub mono" style="margin-top:4px;overflow-wrap:anywhere">${h(i.file)}</div></details>`).join(''));
  }

  P.push('<h3>Comprobado · con evidencia ejecutada</h3>');
  P.push(b.claims.map((c) => `<div class="item"><span class="dot ${CLAIM[c.status][0]}" title="${CLAIM[c.status][1]}"></span><div><div class="ttl">${h(c.text)} <span class="pill ${CLAIM[c.status][0]}">${CLAIM[c.status][1]}</span></div><div class="d">${h(c.detail)}</div>${c.evidence?.length ? `<div class="links">${c.evidence.map(ev).join('')}</div>` : ''}</div></div>`).join(''));

  if (b.l2?.newTests?.length) {
    const o = { Passed: 'pasa', Failed: 'falla', NoCompila: 'no compila', NoEjecutado: 'no ejecutado' };
    P.push(`<details><summary><span class="sub">Tests nuevos, uno a uno (${b.l2.newTests.length})</span></summary><table style="margin-top:6px"><tr><th>Test</th><th>Sin el cambio</th><th>Con el cambio</th></tr>${b.l2.newTests.map((t) => `<tr><td class="mono">${h(t.name)}</td><td class="${t.red === 'Passed' ? 't-warn' : ''}">${o[t.red] || h(t.red)}</td><td class="${t.green === 'Failed' ? 't-bad' : ''}">${o[t.green] || h(t.green)}</td></tr>`).join('')}</table></details>`);
  }
  if (b.mutation?.mutants?.length) {
    P.push(`<details><summary><span class="sub">Defectos sembrados, uno a uno (${b.mutation.mutants.length})</span></summary><table style="margin-top:6px"><tr><th>Dónde</th><th>Defecto</th><th>Resultado</th></tr>${b.mutation.mutants.map((m) => `<tr><td class="mono">${h(base(m.file))}:${m.line}</td><td>${h(m.op)}</td><td class="${m.status === 'sobrevive' ? 't-warn' : ''}">${m.status === 'detectado' ? `detectado por ${m.killerCount} test(s)` : m.status === 'sobrevive' ? `sobrevive${m.inResidue ? ' · está en lo que lees' : ''}` : h(m.status)}</td></tr>`).join('')}</table></details>`);
  }

  if (b.rewind?.steps?.length) {
    const R = { necesario: (x) => `necesario · fallan ${x.testCount} test(s) sin él`, 'sin-test': () => 'ningún test lo nota', 'no-compila-sin-el': () => 'sin él no compila', 'no-aplicado': () => 'no se pudo quitar' };
    P.push(`<details><summary><span class="sub">Rebobinar: cada cambio quitado de uno en uno (${b.rewind.steps.length})</span></summary><table style="margin-top:6px"><tr><th>Cambio</th><th>Sin él…</th></tr>${b.rewind.steps.map((x) => `<tr><td><span class="mono">${h(base(x.file))}:${x.start}${x.end !== x.start ? '–' + x.end : ''}</span><div class="sub mono">${h(x.label)}</div></td><td class="${x.status === 'sin-test' ? 't-warn' : x.status === 'necesario' ? 't-ok' : ''}">${(R[x.status] || (() => h(x.status)))(x)}</td></tr>`).join('')}</table></details>`);
  }

  if (b.l3) {
    const reps = b.l3.replicas.filter((r) => r.ok);
    P.push(`<h3>Réplicas · ${reps.length} de ${b.l3.replicas.length} válidas</h3>`);
    if (!reps.length) P.push('<p class="sub">Ninguna réplica cuenta como segunda opinión. Abajo tienes el motivo de cada una.</p>');
    if (reps.length) {
      const code = b.l3.regions;
      const V = { consensus: ['t-ok', (r) => `coinciden ${r.same}/${r.n}`], divergent: ['t-warn', (r) => `solo ${r.same}/${r.n}`], surplus: ['t-warn', () => 'ninguna'], trivial: ['t-no', () => 'comentario'], unknown: ['t-no', () => '—'] };
      const G = { same: '=', different: '≠', absent: '–' };
      P.push(`<div class="matrix" style="grid-template-columns:minmax(110px,1fr) repeat(${reps.length},30px) auto"><div class="hd" style="text-align:left">Zona del PR</div>${reps.map((r) => `<div class="hd" title="${h(r.label)}">${h(r.label.slice(0, 3))}</div>`).join('')}<div class="hd"></div>
        ${code.map((r) => `<div class="rg" title="${h(r.file)} · ${h(r.label)}">${h(base(r.file))}:${r.newStart}</div>${reps.map((rep) => { const c = r.cells.find((x) => x.replica === rep.id)?.status || 'absent'; return `<div class="cell ${c}" title="${h(rep.label)}">${G[c]}</div>`; }).join('')}<div class="vd ${V[r.verdict][0]}">${V[r.verdict][1](r)}</div>`).join('')}</div>
        <div class="legend"><span>= mismo cambio que el PR</span><span>≠ tocó la zona de otra forma</span><span>– no tocó esa zona</span></div>
        <p class="sub" style="margin:8px 0 0">Que coincidan no prueba que el código esté bien. Solo indica dónde el requisito no dejaba elegir.</p>`);
    }
    if (b.l3.omissions?.length) P.push(`<div class="note"><b>Cambios que hicieron las réplicas y el PR no</b>\n${b.l3.omissions.map((o) => `· ${h(base(o.file))}:${o.lines[0]} (${o.replicas.length} réplicas) ${h(o.sample)}`).join('\n')}</div>`);
    if (b.l3.cross?.length) {
      const cell = (x) => !x ? '—' : x.status !== 'ok' ? 'no compila' : `${x.passed}/${x.ran} pasan`;
      P.push(`<details><summary><span class="sub">Tests cruzados</span></summary><table style="margin-top:6px"><tr><th>Réplica</th><th>Tests del PR sobre su código</th><th>Sus tests sobre el PR</th></tr>${b.l3.cross.map((c) => `<tr><td>${h(c.label)}</td><td class="${c.prTestsOnReplica?.failed ? 't-warn' : ''}">${cell(c.prTestsOnReplica)}${c.prTestsOnReplica?.failedNames?.length ? `<div class="sub mono">${c.prTestsOnReplica.failedNames.slice(0, 4).map((n) => h(n.split('.').pop())).join(', ')}</div>` : ''}</td><td class="${c.replicaTestsOnPr?.failed ? 't-warn' : ''}">${cell(c.replicaTestsOnPr)}</td></tr>`).join('')}</table></details>`);
    }
    P.push(`<details><summary><span class="sub">Cada réplica: estado y lo que dice (sus afirmaciones no son evidencia)</span></summary>${b.l3.replicas.map((r) => `<div class="note"><b>${h(r.label)}</b>${r.mission ? ` <span class="sub">(${h(r.mission)})</span>` : ''} · <span class="${r.ok ? 't-ok' : 't-warn'}">${h(r.status)}</span>${r.lines ? ` · ${r.files} ficheros, ${r.lines} líneas, ${secs(r.ms)}` : ''}${r.patchFile ? ` · <button type="button" class="linkbtn" data-art="${h(r.patchFile)}">ver su parche</button>` : ''}${r.summary ? `\n${h(r.summary)}` : ''}${r.decisions && !/^none\.?$/i.test(r.decisions) ? `\n<b>Decisiones que dice haber tomado:</b> ${h(r.decisions)}` : ''}</div>`).join('')}</details>`);
  }

  P.push('<h3>No comprobado</h3>');
  P.push(b.notChecked.map((n) => `<div class="item"><span class="dot no"></span><div><div class="ttl">${h(pendingMessage(n.what))}</div><div class="d">${h(pendingMessage(n.why))}</div></div></div>`).join(''));

  P.push(so ? signedHTML(run) : signFormHTML(b));
  if (b.version >= 2 && b.contract && !stale) P.push('<h3>Ampliar la investigación</h3><p class="sub">Nueva ejecución Deep: hasta 15 minutos y 250.000 tokens. Recupera el contrato y las propuestas compatibles; vuelve a validar las pruebas sobre el entorno actual.</p><button class="act" id="continueRun">Continuar investigando</button>');
  P.push(`<h3>Volver a verificar</h3>${optionsHTML()}<button class="act quiet" id="run">Verificar de nuevo</button><div id="perr" class="err"></div>
    <p class="sub" style="margin-top:14px">Duró ${secs(b.timing.totalMs)}${b.cost?.usd ? ` · ${b.cost.usd.toFixed(2)} $ en agentes` : ''} · ${h(PROFILES[b.options.profile]?.name || (b.options.mode === 'completo' ? 'reconstrucción' : 'rápida'))} · <button type="button" class="linkbtn" id="mdlink">ver informe en Markdown</button></p>`);

  $('panel').innerHTML = P.join('');
  $('panel').scrollTop = keepScroll ? scrollWas : 0;
  bindOptions(() => renderBrief(true));
  $('run').onclick = () => verify();
  if ($('continueRun')) $('continueRun').onclick = async () => {
    const button = $('continueRun'); button.disabled = true;
    try {
      const result = await api(`/projects/${pid()}/runs/${run.id}/continue`, { body: { profile: 'deep' } });
      say('Amplío la investigación con Deep. El nuevo informe conservará la referencia a esta revisión y comprobará de nuevo la evidencia necesaria.');
      attach(result.runId);
    } catch (error) { $('perr').textContent = error.message; button.disabled = false; }
  };
  $('mdlink').onclick = async () => showText('Informe en Markdown', await (await fetch(`/api/projects/${pid()}/runs/${run.id}/report`)).text());
  $('panel').querySelectorAll('[data-art]').forEach((el) => (el.onclick = async () => {
    try { showText(el.textContent, await (await fetch(`/api/projects/${pid()}/runs/${run.id}/artifact?name=${encodeURIComponent(el.dataset.art)}`)).text()); } catch (e) { showText('Evidencia', e.message); }
  }));
  if (!so) bindSign();
  else bindSigned();
}

/* ── Sign-off ─────────────────────────────────────────────────────────── */
function signFormHTML(b) {
  const hard = (b.version >= 2 && b.verdict.status !== 'ready-for-human') || b.rules.fired.some((r) => ['conflicto', 'no-compila', 'suite-rota', 'tests-propios-fallan'].includes(r.id));
  return `<h3>Firma</h3>
    <p class="sub">La revisión automática es un consejo. Tu firma es la aprobación.${b.audit ? ' Esta área está en prueba: una segunda persona auditará el cambio.' : ''}</p>
    <div class="field"><label for="signer">Tu nombre</label><input type="text" id="signer" value="${h(localStorage.getItem('katse.signer') || '')}" placeholder="Nombre y apellidos"></div>
    ${b.residue.items.length ? `<label class="ck"><input type="checkbox" id="ckResidue"><span>He leído el residuo: ${b.residue.lines} líneas en ${b.residue.items.length} ${b.residue.items.length === 1 ? 'zona' : 'zonas'}</span></label>` : ''}
    <label class="ck"><input type="checkbox" id="ckNot"><span>He revisado las ${b.notChecked.length} cosas que no se han comprobado</span></label>
    <div class="field"><label for="risk">Riesgo residual que acepto</label><textarea id="risk" rows="3" placeholder="Con tus palabras: qué podría fallar todavía y por qué lo aceptas."></textarea></div>
    <button class="act solid" id="sign" ${hard ? 'disabled title="Faltan comprobaciones o hay incumplimientos: revisa el informe"' : ''}>Firmar y aceptar</button>
    <button class="act quiet" id="sendBack">Devolver al autor</button>
    <div id="serr" class="err"></div>`;
}
function bindSign() {
  const submit = async (decision) => {
    const b = S.run.brief;
    const answers = {};
    for (const q of b.questions) { const c = $('panel').querySelector(`input[name="q-${CSS.escape(q.id)}"]:checked`); if (c) answers[q.id] = c.value; }
    const signer = $('signer').value.trim();
    localStorage.setItem('katse.signer', signer);
    try {
      const r = await api(`/projects/${pid()}/runs/${S.run.id}/signoff`, { body: { signer, decision, answers, residualRisk: $('risk').value, checks: { residue: !!$('ckResidue')?.checked, notChecked: !!$('ckNot')?.checked } } });
      S.run.signoff = r.signoff; S.run.signed = r;
      renderBrief();
      say(decision === 'aprobar' ? `Firma registrada a nombre de <b>${h(signer)}</b>. Yo no hago el merge: abajo tienes los comandos para hacerlo tú.` : `Devuelto al autor a nombre de <b>${h(signer)}</b>.`);
      $('panel').scrollTop = $('panel').scrollHeight;
    } catch (e) { $('serr').textContent = e.message; }
  };
  $('sign').onclick = () => submit('aprobar');
  $('sendBack').onclick = () => submit('devolver');
}
function copyBlock(title, text, id) {
  return `<div class="field copy"><label>${h(title)}</label><button type="button" data-copy="${id}">Copiar</button><pre id="${id}">${h(text)}</pre></div>`;
}
function signedHTML(run) {
  const so = run.signatureValid === false ? null : run.signoff; const s = run.signed || {};
  const out = run.brief.pr.direction === 'outgoing';
  return `<h3>Firma</h3>
    <div class="item"><span class="dot ${so.decision === 'aprobar' ? 'ok' : 'no'}"></span><div><div class="ttl">${so.decision === 'aprobar' ? 'Aceptado' : 'Devuelto al autor'} por ${h(so.signer)}</div><div class="d">${new Date(so.ts).toLocaleString()} · informe sha256:${h(so.briefHash.slice(0, 16))}…${so.auditRequired ? ' · pendiente de auditoría por una segunda persona' : ''}</div><div class="d">Riesgo aceptado: ${h(so.residualRisk)}</div></div></div>
    ${so.decision === 'aprobar' && s.commands?.length ? copyBlock(out ? 'Para enviarlo (lo ejecutas tú)' : 'Para hacer el merge (lo ejecutas tú)', s.commands.join('\n'), 'cmds') : ''}
    ${s.trailers ? copyBlock('Líneas de firma para el commit', s.trailers, 'trl') : ''}
    ${s.markdown ? copyBlock(out ? 'Descripción del PR, con el informe' : 'Comentario para el PR', s.markdown, 'md') : ''}
    <button class="act quiet" id="attach">Adjuntar el informe al commit (git notes)</button><div id="aerr" class="sub"></div>`;
}
function bindSigned() {
  $('panel').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = 'Copiado'; setTimeout(() => (b.textContent = 'Copiar'), 1200); }));
  $('attach').onclick = async () => {
    try { const r = await api(`/projects/${pid()}/runs/${S.run.id}/attach`, { body: {} }); $('aerr').innerHTML = `Adjuntado al commit ${h(r.commit.slice(0, 9))} en <code>${h(r.ref)}</code>. Para compartirlo: <code>${h(r.push)}</code>`; }
    catch (e) { $('aerr').textContent = e.message; }
  };
}

/* ── Modals ───────────────────────────────────────────────────────────── */
function modal(html) { $('modalBody').innerHTML = html; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; }
function showText(title, text) { modal(`<h2>${h(title)}</h2><pre class="log">${h(text)}</pre>`); }

function openAddProject(first) {
  modal(`<h2>${first ? 'Elige tu proyecto' : 'Abrir otro proyecto'}</h2><p class="sub">Katse trabaja sobre un repositorio git de tu equipo. No instala nada dentro: usa copias temporales.</p>
    <div class="field"><label for="ppath">Carpeta de un repositorio local</label><input type="text" id="ppath" placeholder="/ruta/a/tu/repo"></div><button class="act" id="padd">Abrir</button>
    <div class="field" style="margin-top:20px"><label for="purl">O clonar desde una URL</label><input type="text" id="purl" placeholder="https://github.com/usuario/repo"></div><button class="act quiet" id="pclone">Clonar en ${h(S.workspace || 'workspace')}</button>
    <div id="merr" class="err"></div>`);
  const go = async (body) => {
    $('merr').textContent = 'Abriendo…';
    try { const p = await api('/projects', { body }); if (!S.projects.find((x) => x.id === p.id)) S.projects.push(p); renderProjects(); closeModal(); await loadProject(p.id); }
    catch (e) { $('merr').textContent = e.message; }
  };
  $('padd').onclick = () => go({ path: $('ppath').value.trim() });
  $('pclone').onclick = () => go({ url: $('purl').value.trim() });
}
function openSettings() {
  const p = S.project; const s = S.status;
  modal(`<h2>Ajustes de ${h(p.name)}</h2><p class="sub mono">${h(p.path)}</p>
    <div class="field"><label for="sbase">Rama base (contra la que se comparan los PR)</label><input type="text" id="sbase" value="${h(p.base)}"></div>
    <div class="field"><label for="sissue">Repositorio de las issues (usuario/repo). Vacío: se deduce del origen</label><input type="text" id="sissue" value="${h(p.issueRepo || '')}" placeholder="${h(p.origin || '')}"></div>
    <div class="field"><label for="sbuild">Comando de compilación (opcional)</label><input type="text" id="sbuild" value="${h(p.commands?.build || '')}" placeholder="se detecta solo"></div>
    <div class="field"><label for="stest">Comando de tests (opcional)</label><input type="text" id="stest" value="${h(p.commands?.test || '')}" placeholder="se detecta solo"></div>
    <button class="act solid" id="ssave">Guardar</button>
    <h3>Guardar el prompt de cada commit (Entire)</h3>
    <p class="sub">${s.entire.enabled ? 'Entire está activo en este repositorio: cada commit hecho con un agente guarda su prompt y Katse lo usa para rehacer el cambio.' : s.entire.installed ? 'Entire está instalado pero no activo aquí. Ejecuta en el repositorio:' : 'Entire no está instalado. Sin él, Katse usa el texto del requisito y lo marca como menos confianza. Para activarlo:'}</p>
    ${s.entire.enabled ? '' : `<pre class="log">${s.entire.installed ? '' : 'brew install --cask entireio/tap/entire\n'}cd ${h(p.path)}\nentire enable</pre>`}
    <h3>Agentes para las réplicas</h3><p class="sub">${S.agents.length ? S.agents.map((a) => h(a.label)).join(' · ') : 'Ninguno disponible.'}${!S.clis.claude && S.clis.claudeInstalled ? ' · Claude: sesión caducada, ejecuta «claude auth login».' : ''}</p>
    <div id="merr" class="err"></div>`);
  $('ssave').onclick = async () => {
    try {
      const np = await api(`/projects/${p.id}`, { method: 'PATCH', body: { base: $('sbase').value, issueRepo: $('sissue').value, commands: { build: $('sbuild').value, test: $('stest').value } } });
      S.projects = S.projects.map((x) => (x.id === np.id ? np : x)); closeModal(); await loadProject(np.id);
    } catch (e) { $('merr').textContent = e.message; }
  };
}
async function openLedger() {
  const L = await api(`/projects/${pid()}/ledger`);
  const m = L.metrics;
  const ST = { prueba: ['no', 'En prueba'], ganada: ['ok', 'Ganada'], retirada: ['bad', 'Retirada'] };
  const card = (l, n, x, star) => `<div class="card ${star ? 'star' : ''}"><div class="l">${l}</div><div class="n">${n}</div><div class="x">${x}</div></div>`;
  const sd = m.seeded;
  modal(`<h2>Libro de confianza · ${h(S.project.name)}</h2>
    <p class="sub">La confianza se gana por área con lo que pasa después del merge y se retira tras un escape. El tiempo de revisión solo puede bajar mientras los escapes no suban.</p>
    <h3>Medidas</h3><div class="cards">
      ${card('Defectos sembrados', sd.total ? `${sd.byTests + sd.routed} de ${sd.total}` : '—', sd.total ? `${sd.byTests} los detectan los tests · ${sd.routed} llegan a la persona · ${sd.escaped} escaparían` : 'Verifica algún PR para medirlo', true)}
      ${card('Líneas que lee una persona', m.readRatio.total ? `${m.readRatio.read} de ${m.readRatio.total}` : '—', m.readRatio.total ? `${m.readRatio.pct} % del código cambiado (sin contar lo devuelto)` : '')}
      ${card('A lectura completa', `${m.fullRead.n} de ${m.fullRead.of}`, Object.entries(m.lanes).map(([k, v]) => `${v} ${k}`).join(' · ') || 'sin verificaciones')}
      ${card('Hallazgos que cambiaron algo', m.findings.answered ? `${m.findings.acted} de ${m.findings.answered}` : '—', 'Preguntas en las que la persona no respondió «aceptar»')}
      ${card('Estabilidad del revisor', m.stability.repeated ? `${m.stability.stable} de ${m.stability.repeated}` : '—', 'Mismo commit verificado dos veces, mismo carril')}
      ${card('Minutos hasta la firma', m.minutesToSign ?? '—', `${m.signoffs} cambios firmados`)}
      ${card('Coste', m.cost.usd ? `${m.cost.usd} $` : `${m.cost.minutes} min`, `${m.cost.minutes} min de cómputo en total`)}
      ${card('Escapes', m.escapes, m.signoffs ? 'Reverts e incidentes atribuidos' : 'Aún no se ha firmado nada: no demuestra nada')}
    </div>
    <h3>Confianza por área</h3>
    ${L.areas.length ? `<table><tr><th>Área</th><th>Estado</th><th>Firmados</th><th>Escapes</th><th>Qué implica</th></tr>${L.areas.map((a) => `<tr><td class="mono">${h(a.area)}</td><td><span class="pill ${ST[a.state][0]}">${ST[a.state][1]}</span></td><td>${a.signoffs}</td><td>${a.escapes}</td><td class="sub">${a.state === 'ganada' ? 'Firma ligera permitida; auditoría por muestreo' : a.state === 'retirada' ? `Lectura completa durante ${a.remaining} cambios más` : `Cada cambio lo audita una segunda persona; faltan ${a.remaining} para ganarla`}</td></tr>`).join('')}</table>` : '<p class="sub">Verifica algún PR para que aparezcan sus áreas.</p>'}
    <h3>Registrar un escape</h3><p class="sub">Un revert o un incidente atribuido a un área. Le retira la confianza durante los siguientes ${L.k} cambios.</p>
    <div class="row" style="margin-top:8px"><select id="earea">${L.areas.map((a) => `<option>${h(a.area)}</option>`).join('')}</select><input type="text" id="enote" placeholder="Qué ocurrió"></div>
    <button class="act quiet" id="eadd" ${L.areas.length ? '' : 'disabled'}>Registrar escape</button><div id="merr" class="err"></div>
    <h3>Historial</h3>${L.entries.length ? `<table><tr><th>Cuándo</th><th>Qué</th><th>Quién</th><th>Detalle</th></tr>${L.entries.map((e) => `<tr><td class="sub">${new Date(e.ts).toLocaleString()}</td><td>${e.type === 'signoff' ? 'Firma' : e.type === 'escape' ? '<span class="t-bad">Escape</span>' : 'Devuelto'}</td><td>${h(e.signer || e.by || '')}</td><td class="sub">${e.type === 'signoff' ? `${h(e.branch)} · ${h(e.lane)} · leyó ${e.read}/${e.total} · ${h(e.residualRisk)}` : e.type === 'escape' ? `${h(e.area)} · ${h(e.note)}` : h(e.pr || '')}</td></tr>`).join('')}</table>` : '<p class="sub">Todavía no hay firmas ni escapes.</p>'}`);
  $('eadd').onclick = async () => {
    try { await api(`/projects/${pid()}/escape`, { body: { area: $('earea').value, note: $('enote').value, by: localStorage.getItem('katse.signer') || '' } }); openLedger(); }
    catch (e) { $('merr').textContent = e.message; }
  };
}

/* ── Wiring ───────────────────────────────────────────────────────────── */
$('tIn').onclick = () => { S.side = 'incoming'; renderList(); if (S.prs.incoming[0] && S.cur?.direction !== 'incoming') selectPR(S.prs.incoming[0]); };
$('tOut').onclick = () => { S.side = 'outgoing'; renderList(); if (S.prs.outgoing[0] && S.cur?.direction !== 'outgoing') selectPR(S.prs.outgoing[0]); };
$('project').onchange = (e) => loadProject(e.target.value);
$('addProject').onclick = () => openAddProject(false);
$('settings').onclick = () => S.project && openSettings();
$('openLedger').onclick = () => S.project && openLedger();
$('modalClose').onclick = closeModal;
$('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('f').onsubmit = (e) => { e.preventDefault(); const v = $('q').value.trim(); if (v) { ask(v); $('q').value = ''; } };
init().catch((e) => { $('panel').innerHTML = `<p class="err">${h(e.message)}</p>`; });
