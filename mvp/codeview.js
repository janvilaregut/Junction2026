/* Katse · the code view: what a click on the graph opens first.
   The node's code (or every changed function of a file), cut into chunks and coloured by attention: how much a
   reviewer should read each chunk, from Gemini's decision model (gemini-decision-1) and signals without a model
   (server/math/attention.js). By default only the chunks worth reading are open; filler folds into one line.
   From here a person can read it, open the evidence, or "Review with agents" (review.js).
   Uses app.js / math.js globals: $, esc, api, base, short, S, G, PAL, focusOn, renderBar, openReview, alive,
   openSeq, nodeState, VWORD, VTONE, MARK_WORD, showNodeCard, hideNodeCard, markNode, mathOpen. */
const CV = document.createElement('aside');
CV.className = 'cview'; CV.setAttribute('aria-label', 'Code, by attention');
$('full').appendChild(CV);
let cvId = null, cvRaf = 0, cvAll = false, cvData = null, cvOpen = new Set();
const CV_CACHE = new Map(); // `${pr}|${id}` → the attention answer, for this page's life
const LEVEL_WORD = { 3: 'Read this', 2: 'Worth a look', 1: 'Filler' };

function hideCode() {
  if (!cvId) return;
  cvId = null; cvData = null; cvOpen = new Set(); CV.classList.remove('on'); cancelAnimationFrame(cvRaf);
  $('full').classList.remove('coding'); G.fpT = 0;
}
/* The view lives while the camera stays on its node (or file): a pan, zoom-out, other focus or the review closes it. */
function watchCode() {
  if (!cvId) return;
  const full = $('full'), on = !full.hidden && full.classList.contains('open') && !full.classList.contains('infix') && !full.classList.contains('indebate') && G.focus && G.focus.ids.length === 1 && G.focus.ids[0] === cvId;
  if (!on) { hideCode(); if (S.fixTarget) { S.fixTarget = null; renderBar(); } return; }
  cvRaf = requestAnimationFrame(watchCode);
}

/* A click on a function or a file of the mathematical graph. Returns false when there is no code to show. */
function showCode(n) {
  const isFile = n.kind === 'file' && String(n.id).startsWith('f:');
  const d = n.m;
  if (!isFile && (!d || d.verdict === 'context' || ['doc', 'config', 'generated'].includes(d.kind) || d.status === 'removed')) return false;
  if (typeof hideNodeCard === 'function') hideNodeCard();
  cvId = n.id; cvAll = false; cvOpen = new Set();
  $('full').classList.add('coding'); G.fpT = 0; // the camera re-centres the node in what the panel leaves free
  focusOn([n.id], { noTip: true });
  S.fixTarget = !isFile && n.kind === 'sym' ? n : null;
  renderBar();
  paintCode(n, null);
  CV.classList.add('on');
  cancelAnimationFrame(cvRaf); cvRaf = requestAnimationFrame(watchCode);
  loadCode(n);
  return true;
}
async function loadCode(n, force) {
  const seq = openSeq, pr = S.cur?.id, key = `${pr}|${n.id}`;
  let data = !force && CV_CACHE.get(key);
  if (!data) {
    try { data = await api(`/projects/${S.pid}/math/attention?pr=${encodeURIComponent(pr)}&node=${encodeURIComponent(n.id)}${force ? '&force=1' : ''}`); }
    catch (e) { if (alive(seq) && cvId === n.id) paintCode(n, { error: /Ruta desconocida|Unknown route/i.test(e.message) ? 'this server started before the code view existed. Restart it.' : e.message }); return; }
    // A server started before the attention route answers with the whole mathematical pass instead.
    if (!Array.isArray(data?.sections)) { if (alive(seq) && cvId === n.id) paintCode(n, { error: 'this server started before the code view existed. Restart it.' }); return; }
    CV_CACHE.set(key, data);
  }
  if (!alive(seq) || cvId !== n.id || S.cur?.id !== pr) return;
  cvData = data; paintCode(n, data);
}

/* Chunks in reading order, with the filler between important ones folded into one line each. */
function codeChunks(sec) {
  const out = [];
  for (const c of sec.chunks) {
    const show = cvAll || c.level >= 2 || cvOpen.has(sec.node + '@' + c.start);
    const last = out[out.length - 1];
    if (show) out.push({ c });
    else if (last?.fold) { last.fold.push(c); }
    else out.push({ fold: [c] });
  }
  return out;
}
const heatTag = (c) => {
  const m = c.model ? `${c.model.choice} ${Math.round(c.model.confidence * 100)}%` : 'signals only';
  return `${LEVEL_WORD[c.level]} · ${m}${c.why?.length ? ' · ' + c.why.join(', ') : ''}`;
};
function chunkHTML(sec, c) {
  const rows = c.lines.map((l) => `<div class="cv-line${l.changed ? ' add' : ''}"><i>${l.n}</i><b>${l.changed ? '+' : ''}</b><code>${esc(l.text.replace(/\t/g, '  ')) || ' '}</code></div>`).join('');
  return `<div class="cv-chunk h${c.level}" data-heat="${c.heat}" title="${esc(heatTag(c))}"><div class="cv-head"><span>${LEVEL_WORD[c.level]}</span>${c.why?.length ? `<em>${esc(c.why.slice(0, 3).join(' · '))}</em>` : ''}</div>${rows}</div>`;
}
function sectionHTML(sec, many) {
  const parts = codeChunks(sec).map((p) => p.c ? chunkHTML(sec, p.c)
    : `<button class="cv-fold" data-k="${esc(p.fold.map((c) => sec.node + '@' + c.start).join('|'))}">⋯ ${p.fold.reduce((n, c) => n + c.end - c.start + 1, 0)} lines of filler <small>${p.fold[0].start}–${p.fold[p.fold.length - 1].end}</small></button>`).join('');
  const head = many ? `<div class="csec"><button data-node="${esc(sec.node)}">${esc(sec.name)}</button><small>:${sec.start}</small><i style="background:${PAL[VTONE[nodeState({ ...sec, id: sec.node })]] || PAL.no}"></i></div>` : '';
  return `<section class="cs">${head}${parts}</section>`;
}

function paintCode(n, data) {
  const isFile = n.kind === 'file', d = n.m, v = d ? nodeState(d) : null, mark = d ? S.marks?.[d.id] : null;
  const kind = d ? ({ function: 'function', method: 'method', ctor: 'constructor', property: 'property', type: 'declarations', test: 'test' }[d.kind] || d.kind) : 'file';
  const status = d ? ({ added: 'new', affected: 'not changed, but affected' }[d.status] || '') : '';
  const where = isFile ? String(n.id).slice(2) : `${base(d.file)}:${d.start}`;
  const open = v === 'uncertain' || v === 'risky', byAgents = ['reproduced', 'differs', 'unclear'].includes(mark?.state);
  const canReview = !isFile && !['test', 'type'].includes(d.kind);
  const secs = data?.sections || [];
  const all = secs.flatMap((s) => s.chunks), hot = all.filter((c) => c.level === 3).length, warm = all.filter((c) => c.level === 2).length;
  const lines = all.reduce((k, c) => k + c.end - c.start + 1, 0), shown = all.filter((c) => c.level >= 2).reduce((k, c) => k + c.end - c.start + 1, 0);
  const m = data?.model;
  const source = !data ? '' : m?.status === 'used' ? `<span class="csrc" title="${esc(m.authority || '')}">Attention · ${esc(m.model)} · ${m.asked} chunks · ${m.ms} ms${data.cached ? ' · cached' : ''}</span>` : `<span class="csrc off" title="${esc(m?.reason || '')}">Attention from signals only · model ${esc(m?.reason || 'unavailable')}</span>`;
  const body = data?.error ? `<p class="cempty">Could not read the code: ${esc(data.error)}</p>`
    : !data ? '<div class="cload"><i></i><i></i><i></i><span>Weighing every chunk…</span></div>'
    : !secs.length ? '<p class="cempty">No code to show for this spot.</p>'
    : secs.map((s) => sectionHTML(s, isFile || secs.length > 1)).join('');
  CV.innerHTML = `<div class="chd">
      <div class="nk">${esc(where)} · ${esc(kind)}${status ? ' · ' + status : ''}</div>
      <div class="nt"><span>${esc(isFile ? base(where) : d.qname || d.name)}</span>${d ? `<em class="fchip" style="background:${PAL[VTONE[v]]}">${VWORD[v]}</em>` : ''}</div>
      ${mark && MARK_WORD[mark.state] ? `<p class="ncl"><b>${esc(MARK_WORD[mark.state])}.</b> ${esc(mark.note || '')}</p>` : ''}
      <div class="cbar">${data && !data.error ? `<span class="cnum"><b>${shown}</b> of ${lines} lines worth reading · <i class="hk h3"></i>${hot} <i class="hk h2"></i>${warm}</span>` : '<span class="cnum">&nbsp;</span>'}
        <div class="seg"><button data-all="0" class="${cvAll ? '' : 'on'}">Important</button><button data-all="1" class="${cvAll ? 'on' : ''}">All code</button></div></div>
    </div>
    <div class="cbody">${body}</div>
    <div class="cft">${source}<div class="nb">
      ${canReview ? `<button class="cta${open && !byAgents ? '' : ' ghost'}" id="cvReview">${byAgents ? 'See the agents\' review' : 'Review with agents'}</button>` : ''}
      ${d ? '<button class="cta ghost" id="cvEvidence">Evidence</button>' : ''}
      ${d && open ? '<button class="cta ghost" id="cvRead">I read it</button>' : d && mark?.state === 'read' ? '<button class="cta ghost" id="cvUnread">Undo</button>' : ''}
    </div></div>`;
  CV.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { cvAll = b.dataset.all === '1'; paintCode(n, cvData); }));
  CV.querySelectorAll('.cv-fold').forEach((b) => (b.onclick = () => { for (const k of b.dataset.k.split('|')) cvOpen.add(k); paintCode(n, cvData); }));
  CV.querySelectorAll('.csec button').forEach((b) => (b.onclick = () => { const t = G.nodes.get(b.dataset.node); if (t) showCode(t); }));
  if ($('cvReview')) $('cvReview').onclick = () => openReview({ node: n });
  if ($('cvEvidence')) $('cvEvidence').onclick = () => { hideCode(); focusOn([n.id], { noTip: true }); S.fixTarget = n.kind === 'sym' ? n : null; showNodeCard(n); renderBar(); };
  if ($('cvRead')) $('cvRead').onclick = async () => { if (await markNode(d.id, 'read')) { const t = G.nodes.get(d.id); if (t) showCode(t); } };
  if ($('cvUnread')) $('cvUnread').onclick = async () => { if (await markNode(d.id, 'none')) { const t = G.nodes.get(d.id); if (t) showCode(t); } };
}

addEventListener('keydown', (e) => {
  if (!cvId || e.target.closest?.('input, textarea') || !$('modal').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hideCode(); if (S.fixTarget) { S.fixTarget = null; renderBar(); } }
  else if (e.key === 'Enter' && $('cvReview')) { e.preventDefault(); e.stopImmediatePropagation(); $('cvReview').click(); }
  else if (e.key === 'a') { e.preventDefault(); cvAll = !cvAll; const n = G.nodes.get(cvId); if (n) paintCode(n, cvData); }
}, true);
