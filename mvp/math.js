/* Katse · the dependency graph of a pull request, coloured by mathematics (server/math).
   Every changed function is a node. Its SIZE is what depends on it; its COLOUR is what can be claimed about
   the change without running anything: proved (it cannot change behaviour), cleared (nothing flagged, not a
   proof), uncertain, risky. Grey nodes are unchanged neighbours: the code that uses, or is used by, the change.
   A click opens the node's evidence; "Review this spot" sends just that function to the agents (review.js),
   and the node turns green when they reproduce it. Mathematics first, agents only where it cannot decide.
   Uses app.js globals: $, esc, api, base, short, S, G, PAL, focusOn, focusPoint, renderBar, renderGraph,
   openReview, zoomGraph, startLoop, alive. */
const VWORD = { proved: 'Proved', cleared: 'Cleared', settled: 'Reviewed', uncertain: 'Uncertain', risky: 'Risky', context: 'Not changed' };
const VTONE = { proved: 'ok', cleared: 'ok', settled: 'ok', uncertain: 'warn', risky: 'bad', context: 'ctx' };
const MARK_WORD = { reproduced: 'Agents reproduced it', read: 'You read it', differs: 'Agents wrote it differently', unclear: 'Agents could not settle it' };
const mathNodes = () => (S.math?.nodes || []).filter((n) => n.verdict !== 'context');
/* What a node counts as now: the mathematics, unless an agent review or a person has since settled it. */
function nodeState(n) {
  const executed = S.math?.trust?.nodes?.find(x=>x.id===n.id);
  if (executed?.status==='verified') return 'settled';
  if (executed?.status==='failed') return 'risky';
  const m = S.marks?.[n.id]?.state;
  return m === 'differs' ? 'risky' : n.verdict;
}
/* The nodes still waiting for someone: most pressing first (flagged before unflagged, then by exposure x impact). */
function mathOpen() {
  return mathNodes().filter((n) => ['uncertain', 'risky'].includes(nodeState(n)) || S.math?.trust?.nodes?.some(t=>t.id===n.id && t.status!=='verified'))
    .sort((a, b) => (nodeState(b) === 'risky') - (nodeState(a) === 'risky') || b.priority - a.priority || (a.lines.added + a.lines.removed) - (b.lines.added + b.lines.removed));
}
const linesOfNode = (n) => (n.lines?.added || 0) + (n.lines?.removed || 0);

/* The graph model: PR core → file hubs → changed functions; dependency edges between functions and to the
   unchanged neighbours. layout() in app.js places it. */
function mathModel(M) {
  const N = [], L = [];
  const s = M.summary, total = mathNodes().length;
  N.push({ id: 'pr', label: 'PR', kind: 'core', tone: 'core', info: `${total} changed ${total === 1 ? 'spot' : 'spots'} · ${s.nodes.proved} proved · ${s.nodes.cleared} cleared · ${s.nodes.uncertain + s.nodes.risky} to review` });
  const hubs = new Map();
  const hub = (file) => {
    if (!hubs.has(file)) { const id = 'f:' + file; hubs.set(file, id); N.push({ id, label: short(base(file), 22), kind: 'file', tone: 'filedim', info: file }); L.push(['pr', id, 'in']); }
    return hubs.get(file);
  };
  for (const n of M.nodes) {
    const ctx = n.verdict === 'context', grp = ['doc', 'config', 'generated'].includes(n.kind), v = nodeState(n);
    N.push({
      id: n.id, label: n.name, kind: ctx ? 'ctx' : grp ? 'grp' : 'sym', tone: VTONE[v], verdict: v, mark: S.marks?.[n.id]?.state || null, impact: n.impact, test: n.kind === 'test',
      file: base(n.file), path: n.file, start: n.start, end: n.end, m: n,
      info: `${ctx ? '' : VWORD[v] + ' · '}${S.marks?.[n.id] && MARK_WORD[S.marks[n.id].state] ? MARK_WORD[S.marks[n.id].state] + '. ' : ''}${S.marks?.[n.id]?.note || n.claim}`,
    });
    if (!ctx) L.push([grp ? 'pr' : hub(n.file), n.id, 'in']);
  }
  const has = new Set(N.map((n) => n.id)), linked = new Set();
  for (const e of M.edges) if (has.has(e.from) && has.has(e.to)) { L.push([e.from, e.to, e.kind === 'tests' ? 'dep tst' : 'dep']); linked.add(e.from); linked.add(e.to); }
  // An unchanged neighbour is only there to show a dependency; without its edge it says nothing.
  return { N: N.filter((n) => n.kind !== 'ctx' || linked.has(n.id)), L };
}
const graphModel = () => (S.math ? mathModel(S.math) : model(S.run?.brief, S.plan));

/* ── Legend ── */
const LEGEND_OLD = $('full').querySelector('.flegend').innerHTML;
function mathLegend() {
  $('full').querySelector('.flegend').innerHTML = S.math
    ? '<span title="A proof that the edit cannot change behaviour"><i class="lg ring" style="background:var(--ok)"></i>Proved</span><span title="Nothing flagged. Not a proof"><i style="background:var(--ok);opacity:.55"></i>Cleared</span><span title="The mathematics cannot vouch for it"><i style="background:var(--warn)"></i>Uncertain</span><span title="A check failed, or high exposure"><i style="background:var(--bad)"></i>Risky</span><span class="lgsz" title="A bigger node has more code depending on it"><i></i><i></i>Depends on it</span>'
    : LEGEND_OLD;
}

/* ── The node card: the evidence for one node, next to it ── */
const NC = document.createElement('div');
NC.className = 'ncard'; NC.setAttribute('role', 'dialog'); NC.setAttribute('aria-label', 'Evidence for this spot');
$('full').appendChild(NC);
let ncId = null, ncRaf = 0, ncProof = false;
function hideNodeCard() {
  if (!ncId) return;
  ncId = null; ncProof = false; NC.classList.remove('on', 'wide'); cancelAnimationFrame(ncRaf);
  if (S.fixTarget) { S.fixTarget = null; if (S.cur && !$('full').hidden) renderBar(); }
}
function placeNodeCard() {
  const bar = $('fbar').getBoundingClientRect().top || innerHeight - 100;
  NC.style.maxHeight = ncProof ? `${Math.max(240, bar - 92 - 16)}px` : ''; // the proof is long: it scrolls inside the card, above the bar
  const [fx, fy] = focusPoint(), w = NC.offsetWidth || 320, h = NC.offsetHeight || 240, narrow = innerWidth < 760;
  const left = narrow ? (innerWidth - w) / 2 : Math.max(16, Math.min(innerWidth - w - 24, fx + 84));
  const top = narrow ? Math.max(84, bar - h - 12) : Math.max(92, Math.min(bar - h - 16, fy - h / 2));
  NC.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
}
/* The card lives exactly as long as the camera stays on its node: any pan, zoom-out, other focus or the review closes it. */
function watchNodeCard() {
  if (!ncId) return;
  const on = !$('full').hidden && $('full').classList.contains('open') && !$('full').classList.contains('infix') && G.focus && G.focus.ids.length === 1 && G.focus.ids[0] === ncId;
  if (!on) return hideNodeCard();
  ncRaf = requestAnimationFrame(watchNodeCard);
}
/* ── Prove it: the principles one function is held to, each with its state and how it was decided ── */
const PGROUP = { proof: 'Proved', fact: 'Checked', measure: 'Measured' };
const PICON = { pass: '✓', inherited: '✓', warn: '!', fail: '✕' };
const PTONE = { pass: 'ok', inherited: 'ok', warn: 'warn', fail: 'bad' };
/* The criteria view. Its headline is the node's colour said in words, so the card and the graph never disagree:
   green = every required criterion was measured and passed; amber/red names what is missing, or why not. */
function proofView(d, v) {
  const ps = d.principles || [], g = d.principleGate || { passed: 0, applicable: 0, failing: [] };
  const on = ps.filter((p) => p.state !== 'na'), off = ps.filter((p) => p.state === 'na');
  const failing = on.filter((p) => !p.info && (p.state === 'warn' || p.state === 'fail'));
  const mark = S.marks?.[d.id];
  const [tone, title, sub] = v === 'proved' ? ['ok', 'Proved: it behaves as before', d.claim]
    : v === 'cleared' ? ['ok', `Green: meets all ${g.applicable} criteria`, 'Each one below was measured on the code and passed. Not a proof that the new behaviour is right: that is what the agents check.']
    : v === 'settled' ? ['ok', mark?.state === 'read' ? 'Read by a person' : 'Checked with executable evidence', `${mark?.note ? mark.note + ' ' : ''}${g.passed} of ${g.applicable} criteria met on their own; the rest was settled by review.`]
    : failing.length ? [failing.some((p) => p.state === 'fail') || v === 'risky' ? 'bad' : 'warn', `Misses ${failing.length === 1 ? 'one criterion' : failing.length + ' criteria'}`, failing.map((p) => esc(p.name)).join(' · ')]
    : [v === 'risky' ? 'bad' : 'warn', `Meets all ${g.applicable} criteria, but not green`, mark && MARK_WORD[mark.state] ? `${esc(MARK_WORD[mark.state])}. ${esc(mark.note || '')}` : esc(d.claim)];
  const head = `<div class="pv-sum ${tone}"><b>${title}</b><span>${v === 'proved' || v === 'cleared' || v === 'settled' ? esc(sub) : sub}</span></div>`;
  const order = { fail: 0, warn: 1, inherited: 2, pass: 3 };
  const rows = ['proof', 'fact', 'measure'].map((grp) => {
    const xs = on.filter((p) => p.group === grp).sort((a, b) => (!!a.info - !!b.info) || order[a.state] - order[b.state]);
    if (!xs.length) return '';
    return `<div class="pv-g">${PGROUP[grp]}</div>` + xs.map((p) => {
      const info = p.info && p.state !== 'pass', t = info ? 'ctx' : PTONE[p.state];
      return `<div class="pv-r ${t}${p.info ? ' info' : ''}" title="${esc(p.basis || '')}"><i>${info ? '·' : PICON[p.state]}</i><b>${esc(p.name)}</b><span>${esc(p.value || '')}${p.state === 'inherited' ? ' · was already so' : ''}${p.info ? ' · not required' : ''}</span>${!p.info && (p.state === 'warn' || p.state === 'fail') ? `<p>${esc(p.detail || '')}</p>` : ''}${p.how ? `<p class="how">${esc(p.how)}</p>` : ''}</div>`;
    }).join('');
  }).join('');
  return `<div class="pv">${head}${rows}${off.length ? `<div class="pv-na" title="${esc(off.map((p) => `${p.name}: ${p.value}`).join('\n'))}">Not applicable: ${off.map((p) => esc(p.name)).join(', ')}</div>` : ''}<div class="pv-foot">${g.passed} / ${g.applicable} pass · green needs every one, low stakes and no high exposure</div></div>`;
}
function proveNode(id) {
  const n = G.nodes.get(id); if (!n?.m?.principles) return null;
  if (ncId !== id) { focusOn([id], { noTip: true }); S.fixTarget = n.kind === 'sym' ? n : null; }
  showNodeCard(n, true); renderBar();
  return n.m;
}
function showNodeCard(n, proof) {
  if (proof != null) ncProof = proof; else if (ncId !== n.id) ncProof = !!n.m?.principles && n.m.verdict !== 'context'; // the criteria first: why it has this colour
  const d = n.m, v = nodeState(d), mark = S.marks?.[d.id];
  const where = d.kind === 'doc' || d.kind === 'config' || d.kind === 'generated' ? (d.files?.length > 1 ? `${d.files.length} files` : d.file) : `${base(d.file)}:${d.start}`;
  const kind = { function: 'function', method: 'method', ctor: 'constructor', property: 'property', type: 'declarations', test: 'test', doc: 'documentation', config: 'configuration', generated: 'generated' }[d.kind] || d.kind;
  const status = { added: 'new', removed: 'removed', affected: 'not changed, but affected', context: 'not changed' }[d.status] || '';
  const rows = (d.evidence || []).map((r) => `<div class="nrow" title="${esc(r.detail || '')}"><i style="background:${PAL[r.tone] || PAL.no}"></i><b>${esc(r.label)}</b><span>${esc(r.value)}</span></div>`).join('');
  const sens = d.sensitive ? `<div class="nrow" title="${esc(d.sensitive.why || '')}"><i style="background:var(--warn)"></i><b>Stakes</b><span>${esc(d.sensitive.label)}${d.sensitive.source === 'decision' ? ' · decision model' : ''}</span></div>` : '';
  const open = v === 'uncertain' || v === 'risky', ctx = d.verdict === 'context', byAgents = ['reproduced', 'differs', 'unclear'].includes(mark?.state);
  const code = !['doc', 'config', 'generated', 'test'].includes(d.kind) && d.status !== 'removed'; // agents rebuild product code from the requirement; a test is read, not rebuilt
  const g = d.principleGate, prove = !ctx && d.principles ? `<button class="cta${open || ncProof ? ' ghost' : ''}" id="nProve">${ncProof ? 'Evidence' : 'Prove it'}${g && !ncProof ? ` <small class="spot">${g.passed}/${g.applicable}</small>` : ''}</button>` : '';
  NC.classList.toggle('wide', ncProof);
  NC.innerHTML = `<div class="nk">${esc(where)} · ${esc(kind)}${status ? ' · ' + status : ''}</div>
    <div class="nt"><span>${esc(d.qname || d.name)}</span><em class="fchip" style="background:${ctx ? 'var(--card3)' : PAL[VTONE[v]]};${ctx ? 'color:var(--fg2)' : ''}">${VWORD[v]}</em></div>
    ${ncProof ? '' : `<p class="ncl">${mark && MARK_WORD[mark.state] ? `<b>${esc(MARK_WORD[mark.state])}.</b> ` : ''}${esc(mark?.note || d.claim)}</p>`}
    ${ncProof ? proofView(d, v) : rows || sens ? `<div class="nrows">${rows}${sens}</div>` : ''}
    ${ctx ? '' : `<div class="nb">${prove}${code ? `<button class="cta${open ? '' : ' ghost'}" id="nReview">${open ? 'Review this spot' : 'Review with tests'}</button>` : ''}${open ? '<button class="cta ghost" id="nRead">I read it</button>' : mark?.state === 'read' ? '<button class="cta ghost" id="nUnread">Undo</button>' : ''}</div>`}`;
  if ($('nProve')) $('nProve').onclick = () => { ncProof = !ncProof; showNodeCard(n); };
  if ($('nReview')) $('nReview').onclick = () => openReview({ node: n });
  if ($('nRead')) $('nRead').onclick = () => markNode(d.id, 'read');
  if ($('nUnread')) $('nUnread').onclick = () => markNode(d.id, 'none');
  ncId = n.id; placeNodeCard(); NC.classList.add('on');
  cancelAnimationFrame(ncRaf); ncRaf = requestAnimationFrame(watchNodeCard);
}
addEventListener('resize', () => { if (ncId) placeNodeCard(); });

/* A click on a node of the mathematical graph: fly to it and open its evidence. */
function mathTap(n) {
  if (!S.math || !n.m) return false;
  focusOn([n.id], { noTip: true });
  S.fixTarget = n.kind === 'sym' ? n : null;
  showNodeCard(n); renderBar();
  return true;
}
/* Settle (or reopen) a node and repaint it where it stands. */
async function markNode(id, state, by) {
  const seq = openSeq, pid = S.pid, pr = S.cur?.id;
  try {
    const r = await api(`/projects/${pid}/math/mark`, { body: { pr, node: id, state, by: by || store.get('katse.signer') || '' } });
    if (!alive(seq) || S.cur?.id !== pr) return false;
    S.marks = r.marks || {};
  } catch (e) { if (alive(seq)) renderBar(e.message); return false; }
  const keep = G.focus ? [...G.focus.ids] : null;
  renderGraph(graphModel()); renderBar();
  const n = G.nodes.get(id);
  if (n && ncId === id) { if (keep) focusOn(keep, { noTip: true }); showNodeCard(n); }
  return true;
}
/* Fly to the most pressing open node. */
function reviewNext() {
  const next = mathOpen().find((n) => G.nodes.has(n.id) && n.id !== ncId) || mathOpen()[0];
  if (!next) return false;
  const n = G.nodes.get(next.id);
  return n ? mathTap(n) : false;
}

/* The bar of a branch, said with the mathematics: how many lines still need someone, and one action. */
function mathBar() {
  const M = S.math; if (!M) return null;
  const open = mathOpen(), s = M.summary, total = s.lines.total;
  const need = open.reduce((n, x) => n + linesOfNode(x), 0);
  const b = S.run?.brief, so = S.run?.signoff;
  const lv = !open.length ? ['ok', 'Settled'] : open.some((n) => nodeState(n) === 'risky') ? ['bad', `${open.filter((n) => nodeState(n) === 'risky').length} risky`] : ['warn', `${open.length} uncertain`];
  const target = S.fixTarget?.m;
  const trust = M.trust;
  const progress = trust ? `<span class="txt" title="Impact-weighted executable scope. Not probability of correctness.">${trust.percent ?? '—'}% backed by tests · ${trust.failed} failed · ${trust.pending} pending</span>` : '';
  const profiles = `<select id="graphProfile" aria-label="Review depth">${Object.entries(PROFILE).map(([id,[name]])=>`<option value="${id}" ${S.profile===id?'selected':''}>${name}</option>`).join('')}</select>`;
  const full = b?.graphReview ? 'View scoped report' : so ? 'View sign-off' : b ? 'Review & sign' : 'Full review';
  const todo = reviewable(open);
  if (BUSY.size || BUSY.total) return `<span class="spin"></span><span class="txt live" style="color:var(--fg)">Agents rebuild ${BUSY.total - BUSY.done > 1 ? `${BUSY.total - BUSY.done} spots` : 'the last spot'} blind</span><span class="txt">${BUSY.done} / ${BUSY.total}</span><button class="cta" disabled>Reviewing…</button>`;
  const cta = target ? `Review this spot <small class="spot">${esc(short(target.name, 18))}</small>` : todo.length ? `Review next <small class="spot">${todo.length} ${todo.length === 1 ? 'spot' : 'spots'}</small>` : open.length ? `Next <small class="spot">${open.length} left for you</small>` : full;
  return progress + profiles + `<span class="num">${need}<small> / ${total}</small></span><span class="txt">${need === 1 ? 'line needs' : 'lines need'} a look</span><span class="chip ${lv[0]}" style="background:${PAL[lv[0]]}">${lv[1]}</span>`
    + (b?.contract && !so ? '<button class="cta ghost" id="bContinue">Continue investigation</button>' : '') + (b?.graphReview ? '<button class="cta ghost" id="bGlobal">Review whole PR</button>' : '') + (target || open.length ? `<button class="cta ghost" id="bFull">${full}</button>` : '') + `<button class="cta" id="bReview">${cta}</button>`;
}
function bindMathBar() {
  const open = mathOpen(), target = S.fixTarget;
  if ($('graphProfile')) $('graphProfile').onchange=e=>{S.profile=e.target.value;store.set('katse.profile',S.profile);};
  if ($('bContinue')) $('bContinue').onclick=()=>{hideNodeCard();continueReview();};
  if ($('bGlobal')) $('bGlobal').onclick=()=>{hideNodeCard();openTree({force:true,focusNodes:'all'});};
  if ($('bFull')) $('bFull').onclick = () => { hideNodeCard(); S.run?.brief ? openReview({full:true}) : openTree({focusNodes:'all'}); };
  if ($('bReview')) $('bReview').onclick = () => (target ? openReview({ node: target }) : reviewable(open).length ? reviewAll() : open.length ? reviewNext() : openReview({ full: true }));
}
/* ── Review all: every open function goes to the agents at once, three at a time; the graph settles live ── */
const BUSY = new Set(); BUSY.total = 0; BUSY.done = 0;
/* What agents can rebuild: functions with code at the head that they have not reviewed yet. */
const reviewable = (open) => open.filter((n) => !['doc', 'config', 'generated', 'type', 'test'].includes(n.kind) && n.status !== 'removed');
function paintBusy() { for (const n of G.nodes.values()) if (n.el) n.el.classList.toggle('busy', BUSY.has(n.id)); }
async function reviewAll() {
  if (!S.math || !S.cur || S.es) return false;
  const next=reviewable(mathOpen()).sort((a,b)=>b.priority-a.priority)[0];
  return next ? openTree({focusNodes:[next.id]}) : false;
}
/* For the voice assistant and for keys: where to look, in order. */
function mathQueue() {
  return mathOpen().map((n) => ({ id: n.id, name: n.qname, file: n.file, line: n.start, state: nodeState(n), why: n.claim, lines: linesOfNode(n), dependents: n.centrality?.dependents ?? null }));
}
addEventListener('keydown', (e) => {
  if (!S.math || $('full').hidden || e.target.closest?.('input, textarea') || !$('modal').hidden || $('full').classList.contains('infix')) return;
  if (e.key === 'n' || e.key === 'ArrowRight') { if (reviewNext()) e.preventDefault(); }
  else if (e.key === 'Enter' && ncId && $('nReview')) { e.preventDefault(); $('nReview').click(); }
  else if (e.key === 'p' && ncId && $('nProve')) { e.preventDefault(); $('nProve').click(); }
  else if (e.key === 'Escape' && ncProof && ncId) { const n = G.nodes.get(ncId); if (n) { e.preventDefault(); ncProof = false; showNodeCard(n); } }
});
