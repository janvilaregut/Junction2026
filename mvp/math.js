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
  const m = S.marks?.[n.id]?.state;
  return m === 'reproduced' || m === 'read' ? 'settled' : m === 'differs' ? 'risky' : n.verdict;
}
/* The nodes still waiting for someone: most pressing first (flagged before unflagged, then by exposure x impact). */
function mathOpen() {
  return mathNodes().filter((n) => ['uncertain', 'risky'].includes(nodeState(n)))
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
let ncId = null, ncRaf = 0;
function hideNodeCard() {
  if (!ncId) return;
  ncId = null; NC.classList.remove('on'); cancelAnimationFrame(ncRaf);
  if (S.fixTarget) { S.fixTarget = null; if (S.cur && !$('full').hidden) renderBar(); }
}
function placeNodeCard() {
  const [fx, fy] = focusPoint(), w = NC.offsetWidth || 320, h = NC.offsetHeight || 240, narrow = innerWidth < 760;
  const bar = $('fbar').getBoundingClientRect().top || innerHeight - 100;
  const left = narrow ? (innerWidth - w) / 2 : Math.min(innerWidth - w - 24, fx + 84);
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
function showNodeCard(n) {
  const d = n.m, v = nodeState(d), mark = S.marks?.[d.id];
  const where = d.kind === 'doc' || d.kind === 'config' || d.kind === 'generated' ? (d.files?.length > 1 ? `${d.files.length} files` : d.file) : `${base(d.file)}:${d.start}`;
  const kind = { function: 'function', method: 'method', ctor: 'constructor', property: 'property', type: 'declarations', test: 'test', doc: 'documentation', config: 'configuration', generated: 'generated' }[d.kind] || d.kind;
  const status = { added: 'new', removed: 'removed', affected: 'not changed, but affected', context: 'not changed' }[d.status] || '';
  const rows = (d.evidence || []).map((r) => `<div class="nrow" title="${esc(r.detail || '')}"><i style="background:${PAL[r.tone] || PAL.no}"></i><b>${esc(r.label)}</b><span>${esc(r.value)}</span></div>`).join('');
  const sens = d.sensitive ? `<div class="nrow" title="${esc(d.sensitive.why || '')}"><i style="background:var(--warn)"></i><b>Stakes</b><span>${esc(d.sensitive.label)}${d.sensitive.source === 'decision' ? ' · decision model' : ''}</span></div>` : '';
  const open = v === 'uncertain' || v === 'risky', ctx = d.verdict === 'context', byAgents = ['reproduced', 'differs', 'unclear'].includes(mark?.state);
  const code = !['doc', 'config', 'generated'].includes(d.kind) && d.status !== 'removed';
  NC.innerHTML = `<div class="nk">${esc(where)} · ${esc(kind)}${status ? ' · ' + status : ''}</div>
    <div class="nt"><span>${esc(d.qname || d.name)}</span><em class="fchip" style="background:${ctx ? 'var(--card3)' : PAL[VTONE[v]]};${ctx ? 'color:var(--fg2)' : ''}">${VWORD[v]}</em></div>
    <p class="ncl">${mark && MARK_WORD[mark.state] ? `<b>${esc(MARK_WORD[mark.state])}.</b> ` : ''}${esc(mark?.note || d.claim)}</p>
    ${rows || sens ? `<div class="nrows">${rows}${sens}</div>` : ''}
    ${ctx ? '' : `<div class="nb">${code ? `<button class="cta${open ? '' : ' ghost'}" id="nReview">${byAgents ? 'See the agents\' review' : open ? 'Review this spot' : 'Review anyway'}</button>` : ''}${open ? '<button class="cta ghost" id="nRead">I read it</button>' : mark?.state === 'read' ? '<button class="cta ghost" id="nUnread">Undo</button>' : ''}</div>`}`;
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
  const full = so ? 'View sign-off' : b ? 'Review & sign' : 'Full review';
  const todo = reviewable(open);
  if (BUSY.size || BUSY.total) return `<span class="spin"></span><span class="txt live" style="color:var(--fg)">Agents rebuild ${BUSY.total - BUSY.done > 1 ? `${BUSY.total - BUSY.done} spots` : 'the last spot'} blind</span><span class="txt">${BUSY.done} / ${BUSY.total}</span><button class="cta" disabled>Reviewing…</button>`;
  const cta = target ? `${['reproduced', 'differs', 'unclear'].includes(S.marks?.[target.id]?.state) ? 'See the review' : 'Review this spot'} <small class="spot">${esc(short(target.name, 18))}</small>` : todo.length ? `Review all <small class="spot">${todo.length} ${todo.length === 1 ? 'spot' : 'spots'}</small>` : open.length ? `Next <small class="spot">${open.length} left for you</small>` : full;
  return `<span class="num">${need}<small> / ${total}</small></span><span class="txt">${need === 1 ? 'line needs' : 'lines need'} a look</span><span class="chip ${lv[0]}" style="background:${PAL[lv[0]]}">${lv[1]}</span>`
    + (target || open.length ? `<button class="cta ghost" id="bFull">${full}</button>` : '') + `<button class="cta" id="bReview">${cta}</button>`;
}
function bindMathBar() {
  const open = mathOpen(), target = S.fixTarget;
  if ($('bFull')) $('bFull').onclick = () => { hideNodeCard(); openReview({ full: true }); };
  if ($('bReview')) $('bReview').onclick = () => (target ? openReview({ node: target }) : reviewable(open).length ? reviewAll() : open.length ? reviewNext() : openReview({ full: true }));
}
/* ── Review all: every open function goes to the agents at once, three at a time; the graph settles live ── */
const BUSY = new Set(); BUSY.total = 0; BUSY.done = 0;
/* What agents can rebuild: functions with code at the head that they have not reviewed yet. */
const reviewable = (open) => open.filter((n) => !['doc', 'config', 'generated', 'type'].includes(n.kind) && n.status !== 'removed' && !['differs', 'unclear'].includes(S.marks?.[n.id]?.state));
function paintBusy() { for (const n of G.nodes.values()) if (n.el) n.el.classList.toggle('busy', BUSY.has(n.id)); }
async function reviewAll() {
  if (BUSY.total || !S.math || !S.cur) return false;
  const seq = openSeq, pid = S.pid, pr = S.cur.id, queue = reviewable(mathOpen()).map((n) => n.id);
  if (!queue.length) return false;
  hideNodeCard(); zoomGraph('fit');
  BUSY.total = queue.length; BUSY.done = 0;
  const failed = [];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      BUSY.add(id); paintBusy(); renderBar();
      try {
        const r = await api(`/projects/${pid}/math/review`, { body: { pr, node: id } });
        if (alive(seq) && S.cur?.id === pr && r.marks) S.marks = r.marks;
      } catch (e) { failed.push(e.message); }
      BUSY.delete(id); BUSY.done++;
      if (!alive(seq) || S.cur?.id !== pr) continue;
      renderGraph(graphModel()); paintBusy(); renderBar();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const reviewed = BUSY.done;
  BUSY.total = 0; BUSY.done = 0; BUSY.clear();
  if (!alive(seq) || S.cur?.id !== pr) return false;
  paintBusy(); renderBar(failed.length ? `${failed.length} ${failed.length === 1 ? 'spot' : 'spots'} could not be reviewed: ${failed[0]}` : undefined);
  const left = mathOpen();
  if (left.length && !failed.length) { const n = G.nodes.get(left[0].id); if (n) setTimeout(() => alive(seq) && mathTap(n), 700); } // straight to what is left for the person
  return { reviewed, left: left.length };
}
/* For the voice assistant and for keys: where to look, in order. */
function mathQueue() {
  return mathOpen().map((n) => ({ id: n.id, name: n.qname, file: n.file, line: n.start, state: nodeState(n), why: n.claim, lines: linesOfNode(n), dependents: n.centrality?.dependents ?? null }));
}
addEventListener('keydown', (e) => {
  if (!S.math || $('full').hidden || e.target.closest?.('input, textarea') || !$('modal').hidden || $('full').classList.contains('infix')) return;
  if (e.key === 'n' || e.key === 'ArrowRight') { if (reviewNext()) e.preventDefault(); }
  else if (e.key === 'Enter' && ncId && $('nReview')) { e.preventDefault(); $('nReview').click(); }
});
