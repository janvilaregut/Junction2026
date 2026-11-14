/* Katse UI. Plain JavaScript, no build step. Everything shown comes from the API; text from
   repositories is always escaped before it reaches the page.
   Three views: the branch tree (home), the full-screen graph of one branch, and its review (review.js). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => String(p).split('/').pop();
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/* The backend still answers in Spanish; the errors a person can actually hit are said in English here. */
const ERR = [
  [/^Ya hay una verificación en marcha/, () => 'Another verification is already running in this project. Wait for it to finish.'],
  [/^No existe la carpeta (.*)/, (m) => `That folder does not exist: ${m[1]}`],
  [/^(.*) no es un repositorio git$/, (m) => `${m[1]} is not a git repository`],
  [/^URL no válida/, () => 'Invalid URL (use https://…)'],
  [/^git clone falló: ([\s\S]*)/, (m) => `git clone failed: ${m[1]}`],
  [/^No encuentro el PR (.*)/, (m) => `Can't find the PR ${m[1]}`],
  [/^No encuentro esa verificación/, () => 'Can’t find that verification'],
  [/^Proyecto desconocido: (.*)/, (m) => `Unknown project: ${m[1]}`],
  [/^No existe la rama (.*)/, (m) => `The branch ${m[1]} does not exist`],
  [/^Esta verificación no tiene informe/, () => 'This verification has no report'],
  [/^Esta verificación ya está firmada/, () => 'This verification is already signed. Verify again to decide again.'],
];
const english = (msg) => { const s = String(msg ?? ''); for (const [re, f] of ERR) { const m = s.match(re); if (m) return f(m); } return s; };

async function api(path, opts) {
  const init = opts ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined;
  const r = await fetch('/api' + path, init);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(english(data.error || data || 'Request failed'));
  return data;
}

const NS = 'http://www.w3.org/2000/svg';
const mk = (t, a, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
/* Animation loops write through these: a write whose text did not change is skipped, because in SVG even an
   identical write can cost style, layout and a repaint. Use them for every attribute a loop animates. */
const setA = (el, k, v) => { const c = el.__a || (el.__a = {}); if (c[k] !== v) { c[k] = v; el.setAttribute(k, v); } };
const setS = (el, k, v) => { const c = el.__s || (el.__s = {}); if (c[k] !== v) { c[k] = v; el.style[k] = v; } };
const PAL = { ok: '#bfe3d0', warn: '#f3e2a6', bad: '#f2a99f', no: '#55555c', file: '#cde4ee', filedim: '#4d585d', agent: '#e3dcf4', core: '#f5f5f7' };
const S = { projects: [], agents: [], pid: null, prs: { incoming: [], outgoing: [] }, base: '', expanded: false, cur: null, run: null, plan: null, mode: 'quick', es: null, stage: '', t0: 0, timer: 0 };
/* The real review pipeline (server/pipeline/complete.js) runs with a profile: a time and token budget. */
const PROFILE = { quick: ['Quick', '90 s · first checks, no alternatives'], standard: ['Standard', '5 min · two alternatives from the base, debate and attacks'], deep: ['Deep', '15 min · extra exploration, mutations'] };
S.profile = PROFILE[store.get('katse.profile')] ? store.get('katse.profile') : 'standard';
S.vmode = 'graph'; // a branch always opens on its graph; Review & sign grows the review tree out of it (review.js)
const VERDICT = { 'ready-for-human': ['ok', 'Ready for your approval'], 'request-changes': ['bad', 'Request changes'], 'insufficient-evidence': ['warn', 'Not enough evidence'] };
const CAND = { built: 'patch built', pending: 'building', failed: 'failed', timeout: 'out of time', duplicate: 'duplicate', empty: 'no changes' };
const FIND = { 'confirmed-original': ['bad', 'Confirmed failure in the PR'], 'original-failure-unconfirmed': ['warn', 'PR failure, not confirmed'], 'candidate-only': ['no', 'Fails only in an alternative'], refuted: ['ok', 'Refuted: the PR passes'], 'invalid-test': ['no', 'Invalid test'], pending: ['no', 'Pending'], unstable: ['warn', 'Unstable result'] };
const modelName = (m) => { const x = String(m || '').split('/').pop().replace(/^gemini-\d+(\.\d+)?-/, ''); return x ? x[0].toUpperCase() + x.slice(1) : 'Model'; };

/* The backend reports with fixed ids; these give them English names. */
const LANE = {
  reproducido: ['Reproduced', 'Everything checkable is checked. Light sign-off.'],
  residuo: ['Residue only', 'Read only what could not be reproduced.'],
  decision: ['You decide', 'Read the residue and answer the questions. The rest is reproduced.'],
  completa: ['Full read', 'It touches something with no shortcut. The report only orders the reading.'],
  devolver: ['Send back', 'It cannot be reviewed like this. Back to the author or the requirement.'],
};
const RECO = { cambios: 'Request changes', insuficiente: 'Not enough evidence', lista: 'Ready for human approval' };
const STAGE = { entrada: 'Reading the PR and its requirement', l1: 'Derived files', merge: 'Merging onto the base', build: 'Building', l2: 'Tests: red before, green after', mutacion: 'Seeding defects', rebobinar: 'Rewinding each change', l3: 'Blind replicas', cruce: 'Cross-testing', juez: 'Writing what the AI won’t decide' };
const OPTION = {
  'Aceptar tal cual': 'Accept as is', 'Devolver al autor': 'Send back to the author', 'Separar en otro cambio': 'Split into another change',
  'Aceptar el diseño': 'Accept the design', 'Pedir revisión de diseño': 'Ask for a design review',
  'Aclarar el requisito y volver a verificar': 'Clarify the requirement and verify again', 'Aceptar con el requisito actual': 'Accept with the current requirement',
  'Está justificado sin test': 'It is justified without a test', 'Pedir un test que lo cubra': 'Ask for a test that covers it', 'Pedir que se quite': 'Ask to remove it',
  'Lo he probado yo': 'I tested it myself', 'Los he ejecutado yo y pasan': 'I ran them myself and they pass', 'Acepto no tener esa evidencia': 'I accept not having that evidence',
  'No falta: el PR es correcto así': 'Nothing is missing: the PR is right as it is',
};
const CLAIM = { reproducido: ['ok', 'Reproduced'], parcial: ['warn', 'Partial'], fallo: ['bad', 'Fails'], 'no-ejecutado': ['no', 'Not run'] };
const HARD = ['conflicto', 'no-compila', 'suite-rota', 'tests-propios-fallan'];
const laneName = (id, fallback) => LANE[id]?.[0] || fallback || id;
const laneTone = (id, tone) => (id === 'devolver' ? 'bad' : tone === 'ok' ? 'ok' : 'warn');

function state(p) {
  const l = p.last;
  if (p.running) return { tone: 'no', label: 'Verifying', end: 'open' };
  if (!l) return { tone: 'no', label: 'Not verified', end: 'open' };
  if (l.signedBy && !l.stale) return l.decision === 'devolver' ? { tone: 'bad', label: 'Sent back', end: 'cut' } : { tone: 'ok', label: 'Signed', end: 'merged' };
  if (l.stale) return { tone: 'no', label: 'Out of date', end: 'open' };
  return { tone: laneTone(l.lane, l.tone), label: laneName(l.lane, l.laneName), end: 'open' };
}
const name = (p) => (p.requirement && /^ju26|fix|issue/i.test(base(p.branch)) ? '#' + p.requirement : base(p.branch).slice(0, 16));

/* ── Projects ─────────────────────────────────────────────────────────── */
async function init() {
  const st = await api('/state');
  Object.assign(S, { projects: st.projects, agents: st.agents, workspace: st.workspace });
  showLanding(); // the first page is always the project picker
}
async function loadProject(id) {
  closeGraph();
  Object.assign(S, { pid: id, prs: { incoming: [], outgoing: [] }, prsKey: '', base: '', expanded: false, hl: [], cur: null, treeW: 0, focus: null, zoom: null, unfold: false, commits: {} });
  focusTok++; // a commits request still in flight belongs to the previous project
  store.set('katse.project', id);
  const op = opened(); op[id] = Date.now(); store.set('katse.opened', JSON.stringify(op));
  $('projName').textContent = S.projects.find((p) => p.id === id)?.name || id;
  $('tree').innerHTML = ''; $('tree').style.height = '0px'; $('more').hidden = true; // never show the previous project's branches
  $('sum').textContent = 'Loading branches…';
  try { await reloadPRs(); } catch (e) { $('sum').textContent = e.message; }
}
async function reloadPRs() {
  const pid = S.pid;
  const prs = await api(`/projects/${pid}/prs`);
  if (pid !== S.pid) return; // the project changed while this was loading
  const same = S.prsKey === pid + JSON.stringify(prs); // a reload that changed nothing redraws nothing
  S.prs = prs; S.base = prs.base; S.prsKey = pid + JSON.stringify(prs);
  if (S.cur) S.cur = [...prs.incoming, ...prs.outgoing].find((p) => p.id === S.cur.id) || S.cur;
  if (!same || S.treeStale || !$('tree').firstChild) renderTree(); else applyHighlight();
}
function projectsModal(first) {
  modal(`<h2>${first ? 'Pick a project' : 'Projects'}</h2><p class="lead">Katse works on a git repository. It never writes inside it: it uses throwaway copies.</p>
    ${S.projects.length ? `<div class="plist">${S.projects.map((p) => `<button data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div class="field"><label for="ppath">Open a local repository</label><input type="text" id="ppath" placeholder="/path/to/repo"></div>
    <div class="field"><label for="purl">Or clone from a URL</label><input type="text" id="purl" placeholder="https://github.com/org/repo"></div>
    <div class="btns"><button class="cta" id="padd">Open</button></div><div class="err" id="merr"></div>`);
  $('mbody').querySelectorAll('.plist button').forEach((b) => (b.onclick = () => { closeModal(); loadProject(b.dataset.id); }));
  $('padd').onclick = async () => {
    const path = $('ppath').value.trim(), url = $('purl').value.trim();
    if (!path && !url) return ($('merr').textContent = 'Give a path or a URL.');
    $('merr').textContent = url ? 'Cloning…' : 'Opening…';
    try {
      const p = await api('/projects', { body: url ? { url } : { path } });
      if (!S.projects.find((x) => x.id === p.id)) S.projects.push(p);
      closeModal(); await loadProject(p.id);
    } catch (e) { $('merr').textContent = e.message; }
  };
}
$('proj').onclick = () => projectsModal(false);

/* ── Landing (first page) and the projects sidebar ───────────────────── */
const TINTS = ['file', 'agent', 'warn', 'ok'];
const tint = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; };
const mono = (n) => { const w = String(n).split(/[^A-Za-z0-9]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase(); };
const tile = (p) => `<span class="ptile" data-t="${tint(p.id)}" aria-hidden="true">${esc(mono(p.name))}</span>`;
const source = (p) => (p.origin ? 'github.com/' + p.origin : p.path);
function opened() { try { return JSON.parse(store.get('katse.opened') || '{}') || {}; } catch { return {}; } }
const ago = (t) => { if (!t) return 'Not opened yet'; const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? 'Opened today' : d === 1 ? 'Opened yesterday' : `Opened ${d} days ago`; };
const BRANCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 6.5"/></svg>';
S.counts = {}; // per project: the state of each branch, read from the same local git as the home (no fetch)
const countAll = () => Promise.all(S.projects.map(async (p) => {
  try {
    const prs = await api(`/projects/${p.id}/prs`);
    const tones = [...prs.incoming, ...prs.outgoing].map((x) => state(x).tone);
    S.counts[p.id] = { tones, ok: tones.filter((t) => t === 'ok').length, review: tones.filter((t) => t === 'warn' || t === 'bad').length, open: tones.filter((t) => t === 'no').length };
  } catch { S.counts[p.id] = null; }
}));
function miniTree(tones) {
  const lanes = tones.slice(0, 5).map((t, i) => {
    const y = 34 - i * 6, x0 = 18 + i * 22, tip = 120 + i * 24;
    return `<path d="M${x0} 44C${x0 + 14} 44 ${x0 + 14} ${y} ${x0 + 30} ${y}L${tip} ${y}" stroke="${PAL[t]}"/><circle cx="${tip}" cy="${y}" r="3.5" stroke="${PAL[t]}"/>`;
  }).join('');
  return `<svg class="pmini" viewBox="0 0 240 56" aria-hidden="true"><line x1="4" y1="44" x2="236" y2="44"/>${lanes}</svg>`;
}
function landingCard(p, op) {
  const c = S.counts[p.id], cur = p.id === S.pid;
  const counts = c === undefined ? 'Reading branches…' : c === null ? 'Branches unavailable'
    : `<span><i style="background:var(--ok)"></i>${c.ok} reproduced</span><span><i style="background:var(--warn)"></i>${c.review} to review</span><span><i class="ring"></i>${c.open} not verified</span>`;
  return `<button class="pcard${cur ? ' on' : ''}" data-id="${esc(p.id)}"${cur ? ' aria-current="true"' : ''}>
    <span class="phead">${tile(p)}<span class="pname"><b>${esc(p.name)}</b><small>${esc(source(p))}</small></span>${cur ? '<span class="pnow"><i></i>Open</span>' : ''}</span>
    ${miniTree(c?.tones || [])}
    <span class="pcount">${counts}</span>
    <span class="pfoot"><span class="pbase">${BRANCH_SVG}<span>${esc(p.base || '')}</span></span><span>${ago(op[p.id])}</span></span></button>`;
}
function renderLanding() {
  const raw = $('lq').value.trim(), q = raw.toLowerCase(), op = opened();
  const list = S.projects.filter((p) => !q || `${p.name} ${source(p)}`.toLowerCase().includes(q));
  $('lgrid').innerHTML = list.map((p) => landingCard(p, op)).join('')
    + `<button class="pcard padd" id="laddb" aria-expanded="${!$('ladd').hidden}"><span class="pplus" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><b>Add a project</b><small>Clone a repository or open one on this computer</small></button>`;
  $('lnone').hidden = !(q && !list.length);
  $('lnone').textContent = `No project matches “${raw}”.`;
  $('lgrid').querySelectorAll('.pcard[data-id]').forEach((b) => (b.onclick = () => pickProject(b.dataset.id)));
  $('laddb').onclick = () => { $('ladd').hidden = !$('ladd').hidden; renderLanding(); if (!$('ladd').hidden) $('lsrc').focus(); };
}
function showLanding() {
  closeSide();
  $('landing').hidden = false;
  $('ladd').hidden = S.projects.length > 0; // nothing to pick yet: the add form is the page
  $('lerr').textContent = '';
  renderLanding();
  countAll().then(() => { if (!$('landing').hidden) renderLanding(); });
}
function pickProject(id) {
  const same = id === S.pid;
  $('landing').hidden = true; closeSide();
  if (!same) loadProject(id);
}
let addMode = 'url';
function setAddMode(m) {
  addMode = m;
  document.querySelectorAll('#ladd [data-m]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.m === m)));
  $('lsrcl').textContent = m === 'url' ? 'Repository URL' : 'Path to the repository';
  $('lsrc').placeholder = m === 'url' ? 'https://github.com/org/repo' : '/path/to/repo';
  $('lgo').textContent = m === 'url' ? 'Clone' : 'Open';
  $('lerr').textContent = '';
}
document.querySelectorAll('#ladd [data-m]').forEach((b) => (b.onclick = () => setAddMode(b.dataset.m)));
$('lq').oninput = renderLanding;
$('lsrc').onkeydown = (e) => { if (e.key === 'Enter') $('lgo').click(); };
$('lgo').onclick = async () => {
  const v = $('lsrc').value.trim();
  if (!v) return ($('lerr').textContent = addMode === 'url' ? 'Give a URL.' : 'Give a path.');
  $('lerr').textContent = addMode === 'url' ? 'Cloning…' : 'Opening…';
  $('lgo').disabled = true;
  try {
    const p = await api('/projects', { body: addMode === 'url' ? { url: v } : { path: v } });
    if (!S.projects.find((x) => x.id === p.id)) S.projects.push(p);
    $('lsrc').value = ''; $('lerr').textContent = '';
    pickProject(p.id);
  } catch (e) { $('lerr').textContent = e.message; } finally { $('lgo').disabled = false; }
};

function renderSide() {
  $('slist').innerHTML = S.projects.map((p) => {
    const c = S.counts[p.id], on = p.id === S.pid;
    return `<li><button class="sitem${on ? ' on' : ''}" data-id="${esc(p.id)}"${on ? ' aria-current="page"' : ''}>${tile(p)}<span class="pname"><b>${esc(p.name)}</b><small>${esc(p.base || '')}</small></span>${c?.review ? `<span class="sbadge" aria-label="${c.review} to review">${c.review}</span>` : ''}</button></li>`;
  }).join('');
  $('slist').querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => pickProject(b.dataset.id)));
}
const sideOpen = () => document.body.classList.contains('sideon');
function openSide() {
  renderSide();
  document.body.classList.add('sideon'); $('side').inert = false; $('sideBtn').setAttribute('aria-expanded', 'true');
  $('sideX').focus();
  countAll().then(() => { if (sideOpen()) renderSide(); });
}
function closeSide() {
  if (!sideOpen()) return;
  document.body.classList.remove('sideon'); $('side').inert = true; $('sideBtn').setAttribute('aria-expanded', 'false');
}
$('sideBtn').onclick = () => (sideOpen() ? closeSide() : openSide());
$('sideX').onclick = () => { closeSide(); $('sideBtn').focus(); };
$('sideScrim').onclick = closeSide;
$('sideAdd').onclick = () => { closeSide(); projectsModal(false); };
$('sideAll').onclick = showLanding;

/* ── Settings: which models the review may call (saved on the server) ── */
const MODELS = [
  ['hydrogen', 'Gemini Hydrogen', 'Fast model: reads the ticket, rebuilds the change, writes the attacks.'],
  ['carbon', 'Gemini Carbon', 'The judge: audits the contract and the evidence.'],
  ['nemotron', 'Nemotron · NVIDIA', 'A second model family for diversity, served by Verda. Off: Hydrogen takes its place and the report says so.'],
];
async function settingsModal() {
  modal('<h2>Settings</h2><p class="lead">Loading…</p>');
  let st;
  try { st = await api('/settings'); } catch (e) { $('mbody').innerHTML = `<h2>Settings</h2><div class="err">${esc(e.message)}</div>`; return; }
  const paint = () => {
    $('mbody').innerHTML = `<h2>Settings</h2><p class="lead">Models the review may call. Changes apply to the next verification.</p>
      <div class="sets">${MODELS.map(([id, n, d]) => {
        const lastGemini = id !== 'nemotron' && st.models[id] && !st.models[id === 'hydrogen' ? 'carbon' : 'hydrogen'];
        const nokey = id === 'nemotron' ? !st.keys.verda : !st.keys.gemini;
        return `<label class="set${lastGemini ? ' locked' : ''}"><span><b>${esc(n)}</b><small>${esc(d)}${nokey ? ' · <em>no API key set</em>' : ''}${lastGemini ? ' · <em>the last Gemini model stays on</em>' : ''}</small></span><input type="checkbox" class="sw" data-m="${id}" ${st.models[id] ? 'checked' : ''} ${lastGemini ? 'disabled' : ''}></label>`;
      }).join('')}</div><div class="err" id="serr2"></div>`;
    $('mbody').querySelectorAll('[data-m]').forEach((x) => (x.onchange = async () => {
      try { st = await api('/settings', { method: 'PATCH', body: { models: { [x.dataset.m]: x.checked } } }); paint(); }
      catch (e) { x.checked = !x.checked; $('serr2').textContent = e.message; }
    }));
  };
  paint();
}
$('gear').onclick = settingsModal;

/* ── Home: left = history, centre = you, right = merges still to come ── */
function renderTree() {
  S.treeStale = false;
  const svg = $('tree'); svg.innerHTML = '';
  svg.classList.remove('hl', 'zoomed'); $('card').classList.remove('on');
  const W = Math.max(svg.parentElement.clientWidth, 760);
  const recent = S.prs.incoming.filter((p) => p.last || p.running || (!p.behind && Date.now() - new Date(p.date) < 30 * 864e5));
  const old = S.prs.incoming.filter((p) => !recent.includes(p));
  const F = S.focus; // a branch unfolded to show its commits
  if (F && ![...S.prs.incoming, ...S.prs.outgoing].some((p) => p.id === F.id)) S.focus = null;
  if (S.zoom && ![...S.prs.incoming, ...S.prs.outgoing].some((p) => p.id === S.zoom.id)) S.zoom = null;
  // Unfolded or zoomed in, only the recent branches (plus the chosen one) are drawn: the others go away anyway.
  const one = S.focus || S.zoom;
  const inc = one ? [...recent, ...old.filter((p) => p.id === one.id)] : S.expanded ? [...recent, ...old] : recent;
  const out = S.prs.outgoing;
  if (!inc.length && !out.length && !old.length) {
    svg.style.height = '0px';
    $('sum').innerHTML = `No branches ahead of <b>${esc(base(S.base))}</b>. Push one and it shows up here.`;
    $('more').hidden = true;
    return;
  }
  const GAP = S.expanded ? 36 : 58;
  const mainY = 40 + inc.length * GAP + 14, H = mainY + out.length * GAP + 40;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.height = H + 'px';
  const xNow = Math.round(W * 0.4);

  mk('line', { x1: xNow, y1: 8, x2: xNow, y2: H - 8, stroke: 'rgba(255,255,255,.06)', 'stroke-dasharray': '2 6' }, svg);
  mk('line', { x1: 8, y1: mainY, x2: xNow, y2: mainY, stroke: '#f5f5f7', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-opacity': .8 }, svg);
  mk('line', { x1: xNow, y1: mainY, x2: W - 8, y2: mainY, stroke: 'rgba(255,255,255,.16)', 'stroke-width': 2, 'stroke-dasharray': '3 6', 'stroke-linecap': 'round' }, svg);
  for (let x = xNow - 64; x > 40; x -= 64) mk('circle', { cx: x, cy: mainY, r: 3.6, fill: '#0c0c0e', stroke: '#f5f5f7', 'stroke-opacity': .55, 'stroke-width': 1.6 }, svg);
  mk('text', { x: 8, y: mainY - 14, class: 'mono' }, svg).textContent = base(S.base || 'main');

  const lanes = mk('g', {}, svg);
  const geo = {};
  const draw = (list, dir) => {
    const step = Math.min(46, Math.max(6, (W - xNow - 380) / Math.max(list.length - 1, 1)));
    list.forEach((p, i) => {
      const st = state(p); const col = PAL[st.tone];
      const y = mainY + dir * (i + 1) * GAP; const dy = Math.abs(y - mainY);
      const xf = p.behind ? Math.max(40, xNow - (30 + 34 * Math.log2(1 + p.behind))) : xNow;
      const R = Math.min(34 + dy * 0.8, 150); // far lanes turn up more steeply instead of sweeping across the history
      const tipX = Math.min(Math.max(xNow + 150 + i * step, xf + R + 40), W - 70); // tips stay inside the view
      const M = Math.max(16, Math.min(44 + dy * 0.45, W - 16 - tipX));
      const mx = tipX + M;
      const faint = !recent.includes(p) && dir < 0;
      const g = mk('g', { class: 'lane' + (st.tone === 'warn' || st.tone === 'bad' ? ' pulse' : ''), 'data-pr': p.id, 'data-tx': tipX, 'data-ty': y, style: `transform-origin:0px ${mainY}px`, tabindex: 0, role: 'button', 'aria-label': `${name(p)}: ${p.title} (${st.label})` }, lanes);
      geo[p.id] = { p, st, col, dir, xf, y, tipX, R, g };
      const fork = `M${xf} ${mainY} C ${xf + R * .55} ${mainY}, ${xf + R * .45} ${y}, ${xf + R} ${y} L ${tipX} ${y}`;
      const merge = `M${tipX} ${y} C ${tipX + M * .55} ${y}, ${mx - M * .45} ${mainY}, ${mx} ${mainY}`;
      mk('path', { d: fork, fill: 'none', stroke: col, 'stroke-width': faint ? 1.4 : 2.2, 'stroke-linecap': 'round', 'stroke-opacity': faint ? .5 : .95 }, g);
      if (st.end !== 'cut' && !faint) { // stale branches are not merge candidates: no pending-merge curve
        mk('path', { d: merge, fill: 'none', stroke: col, 'stroke-width': 1.6, 'stroke-opacity': st.end === 'merged' ? .9 : .45, 'stroke-dasharray': st.end === 'merged' ? '' : '3 5', 'stroke-linecap': 'round' }, g);
        mk('circle', { cx: mx, cy: mainY, r: 5, fill: st.end === 'merged' ? col : '#0c0c0e', stroke: col, 'stroke-width': 1.8, 'stroke-opacity': st.end === 'merged' ? 1 : .6 }, g);
      }
      const c = Math.min(p.ahead || 1, 4) - 1; const a = xf + R + 16, b = tipX - 22;
      for (let k = 0; k < c && b > a; k++) mk('circle', { cx: a + ((b - a) * (k + 1)) / (c + 1), cy: y, r: 3.2, fill: '#0c0c0e', stroke: col, 'stroke-width': 1.6 }, g);
      if (st.end === 'cut') {
        const s = 5.5; mk('path', { d: `M${tipX - s} ${y - s}L${tipX + s} ${y + s}M${tipX + s} ${y - s}L${tipX - s} ${y + s}`, stroke: col, 'stroke-width': 2.2, 'stroke-linecap': 'round' }, g);
      } else {
        mk('circle', { cx: tipX, cy: y, r: faint ? 4 : 6.5, fill: col }, g);
        mk('circle', { cx: tipX, cy: y, r: faint ? 7 : 11, fill: 'none', stroke: col, 'stroke-opacity': .25, class: 'tipring' }, g);
      }
      mk('text', { x: tipX, y: dir < 0 ? y - (faint ? 11 : 17) : y + 25, 'text-anchor': 'middle', class: 'lbl' + (faint ? ' old' : '') }, g).textContent = dir > 0 ? name(p) + ' · yours' : name(p);
      mk('path', { d: faint ? fork : fork + ' ' + merge, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(GAP - 8, 18) }, g);
      // Moving from one branch to the next must not switch the dimming off and on: toggling 'hl' on the whole tree
      // restyles all of it, twice. Leaving clears it on the next frame, unless another branch was entered by then.
      const enter = () => { cancelAnimationFrame(S.hlRaf); if (!svg.classList.contains('hl')) svg.classList.add('hl'); g.classList.add('on'); showCard(p, st, tipX, y, dir); };
      const leave = () => { g.classList.remove('on'); $('card').classList.remove('on'); cancelAnimationFrame(S.hlRaf); S.hlRaf = requestAnimationFrame(applyHighlight); };
      const open = () => openGraph(p);
      g.onmouseenter = enter; g.onmouseleave = leave; g.onfocus = enter; g.onblur = leave; g.onclick = open;
      g.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } else if (e.key === 'c') showCommits(p.id); else if (e.key === 'z') zoomBranch(p.id); };
    });
  };
  draw(inc, -1); draw(out, 1);
  mk('circle', { cx: xNow, cy: mainY, r: 16, fill: 'none', stroke: '#f5f5f7', 'stroke-opacity': .12 }, svg);
  mk('circle', { cx: xNow, cy: mainY, r: 7.5, fill: '#f5f5f7' }, svg);
  mk('text', { x: xNow - 24, y: mainY - 14, 'text-anchor': 'end', class: 'here' }, svg).textContent = 'you are here';

  // On narrow screens the tree scrolls sideways: start at "you are here", where the branches are.
  // Only when the width changes, so a phone's URL bar showing or hiding doesn't snap the scroll back.
  const box = svg.parentElement;
  if (box.clientWidth < W && S.treeW !== W) box.scrollLeft = xNow - 112;
  S.treeW = W;
  applyHighlight();
  $('more').hidden = !old.length || !!S.focus || !!S.zoom;
  $('more').textContent = S.expanded ? 'Hide older branches' : `+${old.length} older branches`;

  // Folding: every other branch folds flat into the base line while the chosen one unfolds its commits.
  const all = [...lanes.children];
  const still = (fn) => { svg.classList.add('still'); fn(); void svg.getBoundingClientRect(); svg.classList.remove('still'); };
  S.focusTip = null; S.zoomTip = null;
  if (S.zoom && geo[S.zoom.id]) { drawZoom(svg, geo[S.zoom.id], mainY, W, H); return; }
  if (S.focus && geo[S.focus.id]) {
    const first = !S.focus.drawn;
    if (first) { void svg.getBoundingClientRect(); requestAnimationFrame(() => all.forEach((g) => g.classList.add('fold'))); }
    else still(() => all.forEach((g) => g.classList.add('fold')));
    drawRail(svg, geo[S.focus.id], mainY, W, H, first);
    if (box.clientWidth < W) box.scrollTo({ left: geo[S.focus.id].xf - 40, behavior: 'smooth' });
    const p = geo[S.focus.id].p, n = S.focus.total;
    $('sum').innerHTML = `<b>${esc(name(p))}</b> · ${n} ${n === 1 ? 'commit' : 'commits'} on top of ${esc(base(S.base))}. <button class="link" id="allBr">All branches</button>`;
    $('allBr').onclick = hideCommits;
    return;
  }
  if (S.unfold) { S.unfold = false; still(() => all.forEach((g) => g.classList.add('fold'))); requestAnimationFrame(() => all.forEach((g) => g.classList.remove('fold'))); }
  const pend = recent.filter((p) => state(p).end === 'open').length;
  $('sum').innerHTML = `<b>${pend} ${pend === 1 ? 'branch wants' : 'branches want'} in.</b> ${out.length ? `${out.length} of yours ${out.length === 1 ? 'wants' : 'want'} out.` : ''}`;
}

/* ── One branch, unfolded: its commits on a long rail, newest at the tip ── */
function drawRail(svg, f, mainY, W, H, anim) {
  const F = S.focus; F.drawn = true;
  const { p, st, col, dir, xf } = f;
  const yF = dir < 0 ? Math.max(96, mainY - 170) : Math.min(H - 64, mainY + 170);
  const dy = Math.abs(yF - mainY), R = Math.min(34 + dy * 0.8, 150), a = xf + R;
  const end = Math.max(a + 180, W - 130);
  const g = mk('g', { class: 'rail' + (anim ? ' anim' : '') }, svg);
  const path = mk('path', { d: `M${xf} ${mainY} C ${xf + R * 0.55} ${mainY}, ${xf + R * 0.45} ${yF}, ${a} ${yF} L ${end} ${yF}`, fill: 'none', stroke: col, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
  const M = Math.min(70, W - 16 - end);
  let mergeEl = null;
  if (M > 24 && st.end !== 'cut') {
    mergeEl = mk('path', { d: `M${end} ${yF} C ${end + M * 0.55} ${yF}, ${end + M * 0.45} ${mainY}, ${end + M} ${mainY}`, fill: 'none', stroke: col, 'stroke-width': 1.6, 'stroke-opacity': 0.45, 'stroke-dasharray': '3 5', 'stroke-linecap': 'round', class: 'rmerge' }, g);
    mk('circle', { cx: end + M, cy: mainY, r: 5, fill: '#0c0c0e', stroke: col, 'stroke-width': 1.8, 'stroke-opacity': 0.6, class: 'rmerge' }, g);
  }
  if (anim) {
    const len = path.getTotalLength();
    Object.assign(path.style, { strokeDasharray: len, strokeDashoffset: len });
    requestAnimationFrame(() => requestAnimationFrame(() => { path.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.6,0,.2,1) .12s'; path.style.strokeDashoffset = 0; g.classList.remove('anim'); }));
  }
  const list = F.commits, n = list.length;
  const x0 = n > 1 ? a + 48 : end, sp = n > 1 ? (end - x0) / (n - 1) : end - a;
  // Label every commit if there is room; otherwise every few, always the newest. Close labels take turns above and below.
  let step = 1; while (step < n && sp * step * 2 - 16 < 96) step++;
  const alt = n > 1 && sp * step < 190;
  const room = n > 1 ? sp * step * (alt ? 2 : 1) - 18 : Math.min(end - a - 20, 560);
  const chars = Math.max(10, Math.floor(room / 6.9));
  const clip = (s) => (s.length > chars ? s.slice(0, chars - 1) + '…' : s);
  let li = 0;
  list.forEach((c, i) => {
    const x = n > 1 ? x0 + sp * i : end, head = i === n - 1;
    const d = anim ? 520 + Math.min(i * 55, 900) : 0;
    const cg = mk('g', { class: 'cmt' + (head ? ' head' : ''), style: `--d:${d}ms`, tabindex: 0, role: 'button', 'aria-label': `${c.subject} (${c.sha.slice(0, 7)})` }, g);
    const pop = mk('g', { class: 'pop' }, cg);
    if (head) { mk('circle', { cx: x, cy: yF, r: 13, fill: 'none', stroke: col, 'stroke-opacity': 0.3 }, pop); mk('circle', { cx: x, cy: yF, r: 7, fill: col }, pop); }
    else mk('circle', { cx: x, cy: yF, r: 4.6, fill: '#0c0c0e', stroke: col, 'stroke-width': 2 }, pop);
    if ((n - 1 - i) % step === 0) {
      const up = alt ? li % 2 === 0 : dir < 0; li++;
      const t = mk('text', { x, y: up ? yF - 20 : yF + 28, 'text-anchor': n === 1 ? 'end' : 'middle', class: 'clab' }, cg);
      if (n === 1) t.setAttribute('x', x + 6);
      t.textContent = clip(c.subject);
      const s = mk('text', { x: n === 1 ? x + 6 : x, y: up ? yF - 36 : yF + 43, 'text-anchor': n === 1 ? 'end' : 'middle', class: 'csha' }, cg);
      s.textContent = c.sha.slice(0, 7) + (c.author ? ' · ' + c.author.split(' ')[0] : '');
    }
    mk('circle', { cx: x, cy: yF, r: 15, fill: 'transparent' }, cg);
    const show = () => commitCard(c, x, yF, dir, head);
    cg.onmouseenter = show; cg.onfocus = show;
    cg.onmouseleave = cg.onblur = () => $('card').classList.remove('on');
    if (head) { cg.onclick = () => openGraph(p); cg.onkeydown = (e) => { if (e.key === 'Enter') openGraph(p); }; }
  });
  if (F.total > n) mk('text', { x: a + 8, y: yF + (dir < 0 ? -20 : 28), class: 'csha' }, g).textContent = `+${F.total - n} earlier`;
  S.focusTip = [end, yF];
}
function commitCard(c, x, y, dir, head) {
  const svg = $('tree'); const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal; const card = $('card');
  const when = c.date ? new Date(c.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  card.innerHTML = `<div class="k">${esc(c.sha.slice(0, 9))}${c.author ? ' · ' + esc(c.author) : ''}</div><div class="t">${esc(c.subject)}</div><div class="r"><span>${esc(when)}</span><span>${head ? 'Newest · click to open' : ''}</span></div>`;
  const px = r.left + (x * r.width) / vb.width, py = r.top + (y * r.height) / vb.height;
  card.style.left = Math.min(Math.max(px - 150, 12), innerWidth - 312) + 'px';
  card.style.top = (dir < 0 ? py - card.offsetHeight - 52 : py + 56) + 'px';
  card.classList.add('on');
}
/* ── One branch, zoomed in: the tree is scaled around the point where the branch starts (a real camera
   zoom, so its line and dots grow to close-up size), then the close-up is drawn crisp on top: the fork,
   one thick glowing line, every commit as a big ring, small ticks between them. Wheel or drag slides along. ── */
const ZK = 2.2;
function drawZoom(svg, f, mainY, W, H) {
  const Z = S.zoom, first = !Z.drawn; Z.drawn = true;
  const { p, st, col, dir, y, xf, R, g: lane } = f;
  const cut = st.end === 'cut', up = dir < 0; // labels go on the side away from the base line
  const cam = mk('g', { class: 'cam' });
  while (svg.firstChild) cam.appendChild(svg.firstChild);
  svg.appendChild(cam);
  lane.classList.add('zl');
  const ax = xf + R; // where the branch turns flat
  const sx = Math.round(Math.max(120, Math.min(R * ZK * 0.55 + 40, W * 0.28))), sy = Math.round(H / 2);
  const tx = sx - ax * ZK, ty = sy - y * ZK;
  const T = (x, yy) => `${(x * ZK + tx).toFixed(1)} ${(yy * ZK + ty).toFixed(1)}`;
  const yBase = mainY * ZK + ty;

  const list = Z.commits, n = list.length, avail = W - sx - 200; // a short branch still gets a long line
  const lead = n > 1 ? 92 : Math.max(92, Math.round(avail * 0.55));
  const sp = n > 1 ? Math.max(170, Math.min(330, (avail - lead) / (n - 1))) : 0;
  const X = (i) => sx + lead + sp * i;
  const headX = X(n - 1), M = 150, endX = headX + (cut ? 30 : M + 30);
  Z.maxPan = Math.max(0, Math.round(endX + 40 - W));
  Z.pan = Math.max(-Z.maxPan, Math.min(0, Z.pan || 0));

  const defs = mk('defs', {}, svg);
  const glow = mk('filter', { id: 'zglow', filterUnits: 'userSpaceOnUse', x: -200, y: sy - 60, width: endX + 600, height: 120 }, defs);
  mk('feGaussianBlur', { stdDeviation: 6 }, glow);
  const zg = mk('g', { class: 'zoom' + (first ? ' anim' : '') }, svg);
  const pz = mk('g', {}, zg);
  const flat = `M${sx} ${sy} L${headX} ${sy}`;
  mk('path', { d: flat, class: 'zglow', fill: 'none', stroke: col, 'stroke-width': 11, 'stroke-opacity': 0.3, filter: 'url(#zglow)' }, pz);
  mk('path', { d: `M${T(xf, mainY)} C ${T(xf + R * 0.55, mainY)}, ${T(xf + R * 0.45, y)}, ${T(ax, y)}`, class: 'zfork', fill: 'none', stroke: col, 'stroke-width': 2.2 * ZK, 'stroke-linecap': 'round' }, pz);
  const line = mk('path', { d: flat, class: 'zline', fill: 'none', stroke: col, 'stroke-width': 2.2 * ZK, 'stroke-linecap': 'round' }, pz);
  if (!cut) {
    const merged = st.end === 'merged';
    mk('path', { d: `M${headX} ${sy} C ${headX + M * 0.55} ${sy}, ${headX + M * 0.45} ${yBase}, ${headX + M} ${yBase}`, class: 'zmerge', fill: 'none', stroke: col, 'stroke-width': 1.6 * ZK, 'stroke-opacity': merged ? 0.9 : 0.45, 'stroke-dasharray': merged ? '' : '7 11', 'stroke-linecap': 'round' }, pz);
    mk('circle', { cx: headX + M, cy: yBase, r: 5 * ZK, class: 'zmerge', fill: merged ? col : '#0c0c0e', stroke: col, 'stroke-width': 1.8 * ZK, 'stroke-opacity': merged ? 1 : 0.6 }, pz);
  }
  for (let x = sx + 16; x < headX - 6; x += 30) if (list.every((_, i) => Math.abs(X(i) - x) > 14)) mk('circle', { cx: x, cy: sy, r: 1.3, class: 'ztick' }, pz);

  const chars = Math.max(12, Math.floor((n > 1 ? sp - 24 : 420) / 6.9));
  const clip = (s) => (s.length > chars ? s.slice(0, chars - 1) + '…' : s);
  list.forEach((c, i) => {
    const x = X(i), head = i === n - 1;
    const d = first ? 980 + Math.min(i * 90, 1100) : 0;
    const cg = mk('g', { class: 'cmt' + (head ? ' head' : ''), style: `--d:${d}ms`, tabindex: 0, role: 'button', 'aria-label': `${c.subject} (${c.sha.slice(0, 7)})` }, pz);
    const pop = mk('g', { class: 'pop' }, cg);
    if (head && cut) { const s = 7; mk('path', { d: `M${x - s} ${sy - s}L${x + s} ${sy + s}M${x + s} ${sy - s}L${x - s} ${sy + s}`, stroke: col, 'stroke-width': 3.2, 'stroke-linecap': 'round' }, pop); }
    else if (head) { mk('circle', { cx: x, cy: sy, r: 17, fill: 'none', stroke: col, 'stroke-opacity': 0.3, 'stroke-width': 1.4 }, pop); mk('circle', { cx: x, cy: sy, r: 8.5, fill: col }, pop); }
    else mk('circle', { cx: x, cy: sy, r: 7.5, fill: '#0c0c0e', stroke: col, 'stroke-width': 3.2 }, pop);
    mk('text', { x, y: up ? sy - 28 : sy + 36, 'text-anchor': 'middle', class: 'clab' }, cg).textContent = clip(c.subject);
    mk('text', { x, y: up ? sy - 45 : sy + 53, 'text-anchor': 'middle', class: 'csha' }, cg).textContent = c.sha.slice(0, 7) + (c.author ? ' · ' + c.author.split(' ')[0] : '');
    mk('circle', { cx: x, cy: sy, r: 20, fill: 'transparent' }, cg);
    const show = () => commitCard(c, x + Z.pan, sy, dir, head);
    cg.onmouseenter = show; cg.onfocus = show;
    cg.onmouseleave = cg.onblur = () => $('card').classList.remove('on');
    if (head) { cg.onclick = () => openGraph(p); cg.onkeydown = (e) => { if (e.key === 'Enter') openGraph(p); }; }
  });
  if (Z.total > n) mk('text', { x: sx + 14, y: up ? sy + 30 : sy - 22, class: 'csha ztxt' }, pz).textContent = `+${Z.total - n} earlier`;

  const apply = () => {
    cam.style.transform = `translate(${(tx + Z.pan).toFixed(1)}px,${ty.toFixed(1)}px) scale(${ZK})`;
    pz.setAttribute('transform', `translate(${Z.pan} 0)`);
    S.zoomTip = [headX + Z.pan, sy];
  };
  Z.slide = (dx) => {
    const v = Math.max(-Z.maxPan, Math.min(0, Z.pan - dx));
    if (v === Z.pan) return false;
    svg.classList.add('panning'); Z.pan = v; apply(); $('card').classList.remove('on');
    clearTimeout(Z.pt); Z.pt = setTimeout(() => svg.classList.remove('panning'), 140);
    return true;
  };
  if (first) {
    cam.style.transform = 'none';
    const len = headX - sx + 1, seg = Math.min(len, (f.tipX - ax) * ZK); // the part the scaled branch already covers
    Object.assign(line.style, { strokeDasharray: len, strokeDashoffset: len - seg });
    void svg.getBoundingClientRect();
    requestAnimationFrame(() => {
      svg.classList.add('zoomed'); apply();
      requestAnimationFrame(() => { line.style.transition = 'stroke-dashoffset .8s cubic-bezier(.6,0,.2,1) .85s, opacity 0s linear .85s'; line.style.strokeDashoffset = 0; zg.classList.remove('anim'); });
    });
  } else { svg.classList.add('still', 'zoomed'); apply(); void svg.getBoundingClientRect(); svg.classList.remove('still'); }

  $('sum').innerHTML = `<b>${esc(name(p))}</b> up close · ${Z.total > n ? `the last ${n} of ${Z.total} commits` : `${n} ${n === 1 ? 'commit' : 'commits'} since it left ${esc(base(S.base))}`}. <button class="link" id="allBr">All branches</button>`;
  $('allBr').onclick = hideCommits;
}
/* Sliding along a zoomed branch: wheel (either direction) or drag. A drag never counts as a click. */
(() => {
  const svg = $('tree'); let drag = null, dragged = false;
  const scale = () => (svg.viewBox.baseVal?.width || 1) / (svg.getBoundingClientRect().width || 1);
  svg.addEventListener('wheel', (e) => {
    if (!S.zoom?.slide || !S.zoom.maxPan) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (S.zoom.slide(d * scale())) e.preventDefault();
  }, { passive: false });
  svg.addEventListener('pointerdown', (e) => { dragged = false; if (S.zoom?.maxPan && e.button === 0) drag = { x: e.clientX, moved: false }; });
  addEventListener('pointermove', (e) => {
    if (!drag || !S.zoom?.slide) return;
    const d = drag.x - e.clientX;
    if (!drag.moved && Math.abs(d) < 5) return;
    drag.moved = true; S.zoom.slide(d * scale()); drag.x = e.clientX;
  });
  addEventListener('pointerup', () => { dragged = !!drag?.moved; drag = null; });
  svg.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); dragged = false; } }, true);
})();
/* Unfold one branch to show its commits (oldest → newest). Resolves to what is shown, or null. */
let focusTok = 0;
async function showCommits(id) {
  const p = [...S.prs.incoming, ...S.prs.outgoing].find((x) => x.id === id);
  if (!p) return null;
  const tok = ++focusTok, pid = S.pid;
  if (!$('full').hidden) { closeGraph(); await new Promise((r) => setTimeout(r, 760)); }
  const data = await commitsOf(p, pid);
  if (tok !== focusTok || pid !== S.pid) return null;
  if (S.focus?.id === id) return { p, ...data };
  if (S.focus || S.zoom) { S.focus = null; S.zoom = null; renderTree(); await new Promise((r) => setTimeout(r, 60)); }
  S.hl = []; $('card').classList.remove('on');
  S.focus = { id, commits: data.commits, total: data.total, drawn: false };
  renderTree();
  return { p, ...data };
}
/* A branch's own commits (oldest first), fetched once per project. */
async function commitsOf(p, pid) {
  S.commits = S.commits || {};
  let data = S.commits[p.id];
  if (!data) {
    try { data = await api(`/projects/${pid}/commits?pr=${encodeURIComponent(p.id)}`); }
    catch { data = null; }
    if (!data?.commits?.length) data = { total: 1, commits: [{ sha: p.sha || '', subject: p.title, author: '', date: p.date }] };
    if (pid === S.pid) S.commits[p.id] = data;
  }
  return data;
}
/* "Zoom into this branch": the camera flies to where it starts and its first commits sit big on one line. */
async function zoomBranch(id) {
  const p = [...S.prs.incoming, ...S.prs.outgoing].find((x) => x.id === id);
  if (!p) return null;
  const tok = ++focusTok, pid = S.pid;
  if (!$('full').hidden) { closeGraph(); await new Promise((r) => setTimeout(r, 760)); }
  const data = await commitsOf(p, pid);
  if (tok !== focusTok || pid !== S.pid) return null;
  if (S.zoom?.id === id) return { p, ...data };
  if (S.focus || S.zoom) { S.focus = null; S.zoom = null; renderTree(); await new Promise((r) => setTimeout(r, 60)); }
  S.hl = []; $('card').classList.remove('on');
  S.zoom = { id, commits: data.commits, total: data.total, drawn: false, pan: 0 };
  renderTree();
  return { p, ...data };
}
/* Zooming out plays the zoom backwards: the close-up fades into the scaled tree, which shrinks back. */
function unzoomBranch() {
  if (!S.zoom) return;
  const tok = ++focusTok, svg = $('tree'), cam = svg.querySelector('.cam');
  $('card').classList.remove('on');
  svg.querySelector('.zoom')?.classList.add('out');
  svg.classList.remove('zoomed');
  setTimeout(() => { if (tok === focusTok && cam) cam.style.transform = 'none'; }, 140);
  setTimeout(() => { if (tok !== focusTok) return; S.zoom = null; renderTree(); }, 1020);
}
function hideCommits() {
  if (S.zoom) return unzoomBranch();
  if (!S.focus) return;
  const tok = ++focusTok;
  $('tree').querySelector('.rail')?.classList.add('out');
  $('card').classList.remove('on');
  setTimeout(() => { if (tok !== focusTok) return; S.focus = null; S.unfold = true; renderTree(); }, 260);
}
/* Where a branch's tip is on screen right now (the newest commit when it is unfolded), or null. */
function tipOf(id) {
  const svg = $('tree'), vb = svg.viewBox.baseVal;
  if (!vb || !vb.width || document.body.classList.contains('dive')) return null;
  let tx, ty;
  if (S.focus?.id === id && S.focusTip) [tx, ty] = S.focusTip;
  else if (S.zoom?.id === id && S.zoomTip) [tx, ty] = S.zoomTip;
  else { const g = svg.querySelector(`.lane[data-pr="${CSS.escape(id)}"]`); if (!g || S.focus || S.zoom) return null; tx = +g.dataset.tx; ty = +g.dataset.ty; }
  const r = svg.getBoundingClientRect();
  const x = r.left + (tx * r.width) / vb.width, y = r.top + (ty * r.height) / vb.height;
  return x > 0 && x < innerWidth && y > 0 && y < innerHeight ? [x, y] : null;
}
function showCard(p, st, x, y, dir) {
  const svg = $('tree'); const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
  const l = p.last; const card = $('card');
  card.innerHTML = `<div class="k">${esc(p.branch)}</div><div class="t">${esc(p.title)}</div>
    <div class="r"><span class="chip ${st.tone}" style="background:${PAL[st.tone]}">${esc(st.label)}</span><span>${l ? `${l.residue} of ${l.total} lines for you` : 'Open it to verify'}</span></div>`;
  const px = r.left + (x * r.width) / vb.width, py = r.top + (y * r.height) / vb.height;
  card.style.left = Math.min(Math.max(px - 150, 12), innerWidth - 312) + 'px';
  card.style.top = (dir < 0 ? py - card.offsetHeight - 34 : py + 40) + 'px';
  card.classList.add('on');
}
/* Light up some branches in the tree (by PR id) and dim the rest; no ids clears it.
   Used by the voice assistant to point at PRs. Older branches are unfolded if needed. */
function highlightLanes(ids) {
  if ((S.focus || S.zoom) && ids?.length) { S.focus = null; S.zoom = null; S.unfold = true; renderTree(); }
  S.hl = [...new Set(ids || [])];
  const want = new Set(S.hl);
  if (want.size && !S.expanded && S.prs.incoming.some((p) => want.has(p.id) && !document.querySelector(`#tree .lane[data-pr="${CSS.escape(p.id)}"]`))) { S.expanded = true; renderTree(); }
  applyHighlight();
}
/* The lasting highlight (S.hl) survives re-renders and hovers; a hover only adds to it for a moment. */
function applyHighlight() {
  const svg = $('tree'); const want = new Set(S.hl || []);
  if (svg.classList.contains('hl') !== want.size > 0) svg.classList.toggle('hl', want.size > 0);
  svg.querySelectorAll('.lane').forEach((g) => { const on = want.has(g.dataset.pr); if (g.classList.contains('on') !== on) g.classList.toggle('on', on); });
}
$('more').onclick = () => { S.expanded = !S.expanded; renderTree(); if (S.expanded) $('more').scrollIntoView({ block: 'end', behavior: 'smooth' }); };
let resizeTimer = 0, resizeRaf = 0;
addEventListener('resize', () => {
  G.fp = null; // the free area moved
  // Resize fires many times per frame while dragging a window edge: redraw the tree at most once per frame, and only when the home shows.
  if (S.pid && !resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; if (!document.body.classList.contains('dive')) renderTree(); else S.treeStale = true; });
  clearTimeout(resizeTimer); // the graph is fitted to the screen, so fit it again once resizing stops
  resizeTimer = setTimeout(() => { if (!$('full').hidden && S.model) renderGraph(S.model); }, 250);
});

/* ── Graph model, from the real report (or the plan if not verified yet) ── */
const overlaps = (a, b) => a.file === b.file && a.start <= b.end && b.start <= a.end;
const short = (s, n = 26) => (s.length <= n ? s : s.slice(0, 10) + '…' + s.slice(-(n - 11)));
const KIND = { source: 'Code', test: 'Tests', doc: 'Docs', config: 'Config', derived: 'Generated from code' };
function model(b, plan) {
  const N = [], L = []; const add = (n) => (N.push(n), n); const link = (a, c, t = '') => L.push([a, c, t]);
  add({ id: 'pr', label: 'PR', kind: 'core', tone: 'core', info: 'The whole change' });
  const raw = (b || plan)?.files || [];
  const der = raw.filter((f) => f.kind === 'derived');
  const files = raw.filter((f) => f.kind !== 'derived').sort((x, y) => y.add + y.del - (x.add + x.del)).slice(0, 9);
  if (der.length) files.push({ path: '__der', kind: 'derived', label: `${der.length} generated`, add: der.reduce((s, f) => s + f.add, 0), del: der.reduce((s, f) => s + f.del, 0) });
  files.forEach((f) => { add({ id: 'f:' + f.path, label: f.label || short(base(f.path)), kind: 'file', tone: f.kind === 'doc' || f.kind === 'derived' ? 'filedim' : 'file', info: `${KIND[f.kind] || f.kind} · +${f.add} −${f.del}` }); link('pr', 'f:' + f.path); });
  const derSet = new Set(der.map((f) => f.path));
  const fid = (p) => 'f:' + (derSet.has(p) ? '__der' : p);
  const has = (id) => N.some((n) => n.id === id);
  if (b) {
    const res = b.residue.items.map((i) => ({ file: i.file, start: i.start, end: i.end, why: i.why.join(' · ') }));
    const regs = (b.l3?.regions || []).map((r) => ({ rid: r.id, file: r.file, start: r.newStart, end: r.newEnd, verdict: r.verdict }));
    const zones = [...regs, ...res.filter((x) => !regs.some((r) => overlaps(r, x)))].slice(0, 16);
    zones.forEach((z) => {
      const r = res.find((x) => overlaps(x, z));
      const tone = r ? 'bad' : z.verdict === 'consensus' ? 'ok' : z.verdict === 'divergent' ? 'warn' : 'no';
      const id = 'z:' + z.file + ':' + z.start; z.nid = id;
      add({ id, label: ':' + z.start, kind: 'zone', tone, file: base(z.file), start: z.start, info: r ? `You read it · ${r.why}` : tone === 'ok' ? 'The replicas did the same' : tone === 'warn' ? 'The replicas did it differently' : 'Not compared' });
      link(id, has(fid(z.file)) ? fid(z.file) : 'pr', tone === 'bad' ? 'bad' : '');
    });
    b.questions.forEach((q) => {
      const m = q.text.match(/([\w.]+\.\w+):(\d+)/); if (!m) return;
      const z = N.filter((n) => n.kind === 'zone' && n.file === m[1]).sort((x, y) => Math.abs(x.start - m[2]) - Math.abs(y.start - m[2]))[0];
      if (z) { z.tone = 'warn'; z.info = 'You decide · ' + q.text; }
    });
    const claim = (re) => b.claims.find((c) => re.test(c.text));
    const ct = (c) => (c ? CLAIM[c.status][0] : 'no');
    const src = files.filter((f) => f.kind === 'source').map((f) => 'f:' + f.path), tst = files.filter((f) => f.kind === 'test').map((f) => 'f:' + f.path);
    [['v:build', 'Builds', /compila|build/i, ['pr']], ['v:tests', 'Tests', /tests nuevos|rompe|new tests|breaks/i, tst.length ? tst : ['pr']], ['v:mut', 'Mutation', /defecto|defect/i, src.length ? src : ['pr']]].forEach(([id, label, re, to]) => {
      const c = claim(re); add({ id, label, kind: 'check', tone: ct(c), info: c ? `${CLAIM[c.status][1]} · ${c.text}` : 'Not run' }); to.forEach((t) => link(id, t, ct(c) === 'bad' ? 'bad' : ''));
    });
    (b.l3?.replicas || []).forEach((r) => {
      const id = 'r:' + r.id; add({ id, label: r.label.split(' ')[0], kind: 'agent', tone: r.ok ? 'agent' : 'no', info: r.ok ? 'Replica: redid the change blind' : 'Replica did not finish' });
      let any = false;
      if (r.ok) (b.l3.regions || []).forEach((g) => { const c = g.cells.find((x) => x.replica === r.id)?.status; const z = zones.find((x) => x.rid === g.id); if (z && (c === 'same' || c === 'different')) { link(id, z.nid, c === 'different' ? 'warn' : ''); any = true; } });
      if (!any) link(id, 'pr');
    });
    if (b.version >= 2) {
      const fnd = (id) => (b.verdict?.findings || []).find((f) => f.attack === id);
      (b.candidates || []).forEach((c) => { const id = 'c:' + c.id; add({ id, label: c.id, kind: 'agent', tone: c.status === 'built' ? 'agent' : 'no', info: `Alternative from the base · ${modelName(c.model)} · ${CAND[c.status] || c.status}` }); link(id, 'pr'); });
      (b.attacks || []).forEach((a) => {
        const f = fnd(a.id), [tone, what] = FIND[f?.classification] || ['no', a.status];
        const id = 'a:' + a.id; add({ id, label: a.id, kind: 'check', tone, info: `Attack · ${what} · ${a.hypothesis || a.mission || ''}` }); link(id, 'pr', tone === 'bad' ? 'bad' : '');
      });
    }
  } else {
    ['Builds', 'Tests', 'Mutation'].forEach((l, i) => { add({ id: 'v' + i, label: l, kind: 'check', tone: 'no', info: 'Waiting for verification' }); link('v' + i, 'pr'); });
  }
  return { N, L };
}

/* Layout is computed before anything is drawn (no jitter), then fitted to the screen. */
function layout({ N, L }, W, H) {
  const by = Object.fromEntries(N.map((n) => [n.id, { ...n, vx: 0, vy: 0 }]));
  const links = L.filter(([a, b]) => by[a] && by[b]).map(([a, b, t]) => ({ a: by[a], b: by[b], t }));
  const adj = {}; Object.keys(by).forEach((k) => (adj[k] = []));
  links.forEach((l) => { adj[l.a.id].push(l.b.id); adj[l.b.id].push(l.a.id); });
  const order = ['pr']; by.pr.depth = 0;
  for (let i = 0; i < order.length; i++) for (const v of adj[order[i]]) if (by[v].depth == null) { by[v].depth = by[order[i]].depth + 1; by[v].parent = order[i]; order.push(v); }
  Object.values(by).forEach((n) => { if (n.depth == null) { n.depth = 1; order.push(n.id); } });
  const d1 = order.filter((id) => by[id].depth === 1);
  d1.forEach((id, i) => (by[id].ang = (i / d1.length) * Math.PI * 2 - Math.PI / 2));
  by.pr.ang = 0;
  const kids = {}; order.filter((id) => by[id].depth > 1).forEach((id) => (kids[by[id].parent] = kids[by[id].parent] || []).push(id));
  order.forEach((id) => { const ks = kids[id]; if (!ks) return; const sp = Math.min(1.3, .32 * ks.length); ks.forEach((k, j) => (by[k].ang = by[id].ang + (ks.length > 1 ? (j / (ks.length - 1) - .5) * sp : 0))); });
  const P = Object.values(by);
  P.forEach((n) => { n.x = Math.cos(n.ang) * n.depth * 160; n.y = Math.sin(n.ang) * n.depth * 160; });
  const small = (n) => n.kind === 'zone' || n.kind === 'sym' || n.kind === 'ctx';
  const len = (l) => (l.t && l.t.startsWith('dep') ? 120 : l.a.kind === 'core' || l.b.kind === 'core' ? 170 : small(l.a) || small(l.b) ? 80 : 140);
  for (let it = 0; it < 600; it++) {
    const t = 1 - it / 600;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j]; let dx = b.x - a.x, dy = b.y - a.y; const d2 = Math.max(dx * dx + dy * dy, 100), d = Math.sqrt(d2); const f = (small(a) && small(b) ? 2100 : 4800) / d2; dx /= d; dy /= d;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
    links.forEach((l) => { const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const f = ((d - len(l)) / d) * .08; l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f; });
    P.forEach((n) => { n.vx -= n.x * .004; n.vy -= n.y * .004; if (n.kind === 'core') { n.vx -= n.x * .2; n.vy -= n.y * .2; } n.x += n.vx * t; n.y += n.vy * t; n.vx *= .55; n.vy *= .55; });
  }
  const xs = P.map((n) => n.x), ys = P.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // Fit to the free area (minus the header, the bottom bar and room for labels). The graph may stretch
  // up to 1.5x along the longer side of the screen so it uses the space instead of staying a small circle.
  const narrow = W < 600;
  const barTop = $('fbar').getBoundingClientRect().top || H - 100;
  const L0 = narrow ? 40 : 110, R0 = W - L0, T0 = narrow ? 100 : 120;
  const B0 = Math.max(T0 + 140, Math.min(H - 150, barTop - 44)); // never a negative area on short screens
  const fx = (R0 - L0) / Math.max(maxX - minX, 1), fy = (B0 - T0) / Math.max(maxY - minY, 1);
  const s = Math.min(fx, fy, 1.5), sx = Math.min(fx, s * 1.5, 1.6), sy = Math.min(fy, s * 1.5, 1.6);
  const ox = (L0 + R0) / 2 - ((minX + maxX) / 2) * sx, oy = (T0 + B0) / 2 - ((minY + maxY) / 2) * sy;
  P.forEach((n) => { n.x = n.x * sx + ox; n.y = n.y * sy + oy; n.bx = n.x; n.by = n.y; });
  return { P, links };
}

/* ── Full-screen graph: one camera over a living layout ──────────────────
   Opening a branch is one continuous move: its dot in the tree becomes the graph's core, glides to the
   centre while the tree zooms away behind it, and the rest of the graph grows out of that core.
   Closing plays it backwards. Inside, a camera can fly to any node (the voice assistant uses it). */
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const G = { nodes: new Map(), links: [], cam: { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 }, focus: null, pin: null, hover: null, drag: null, pan: null, t: 0, raf: 0 };
const CORE_R = 22, TIP_S = 6.5 / CORE_R;
/* A damped spring: starts and stops at rest. z = 1 never overshoots; a little under 1 gives a soft settle. */
function spring(o, key, target, K, dt, z = 1) {
  const v = 'v' + key;
  o[v] = (o[v] || 0) + ((target - o[key]) * K - (o[v] || 0) * 2 * z * Math.sqrt(K)) * dt;
  o[key] += o[v] * dt;
}
/* In the mathematical graph (math.js) a changed function is as big as what depends on it (impact, 0..1). */
const radius = (n) => (n.kind === 'core' ? CORE_R : n.kind === 'sym' ? 5 + 15 * Math.sqrt(n.impact || 0) : n.kind === 'ctx' ? 3.5 + 8 * Math.sqrt(n.impact || 0) : n.kind === 'grp' ? 8 : n.kind === 'zone' ? 6 : n.kind === 'file' ? (S.math ? 4 : 9 + Math.min(n.deg || 0, 6) * 0.8) : 10);
const toScreen = (x, y) => [x * G.cam.k + G.cam.x, y * G.cam.k + G.cam.y];
const toWorld = (x, y) => [(x - G.cam.x) / G.cam.k, (y - G.cam.y) / G.cam.k];
/* The middle of the free area, between the header and the bar.
   It reads layout, so it is remembered for a moment: the camera loop asks for it every frame. */
function focusPoint() {
  const now = performance.now();
  if (G.fp && now - G.fpT < 250) return G.fp;
  const bar = $('fbar').getBoundingClientRect().top || innerHeight - 100;
  // With the code view open (codeview.js) the free area is what the panel leaves on the left.
  const cv = $('full').classList.contains('coding') && innerWidth >= 900 ? $('full').querySelector('.cview')?.offsetWidth || 0 : 0;
  G.fp = [cv ? (innerWidth - cv - 24) / 2 : innerWidth / 2, (90 + bar) / 2]; G.fpT = now;
  return G.fp;
}

function resetGraph() {
  const svg = $('g'); svg.innerHTML = ''; svg.classList.remove('hl', 'panning');
  Object.assign(G, { nodes: new Map(), links: [], focus: null, pin: null, hover: null, drag: null, pan: null });
  Object.assign(G.cam, { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1, vx: 0, vy: 0, vk: 0 });
  const defs = mk('defs', {}, svg); // arrow head of a dependency edge: it points at what is used
  mk('path', { d: 'M0 0L6 3L0 6z', fill: 'rgba(255,255,255,.42)' }, mk('marker', { id: 'arr', viewBox: '0 0 6 6', refX: 5.4, refY: 3, markerWidth: 5, markerHeight: 5, orient: 'auto' }, defs));
  G.camEl = mk('g', {}, svg); G.gl = mk('g', {}, G.camEl); G.gn = mk('g', {}, G.camEl);
}
/* A node is a group that only moves (translate) holding a shape that grows (scale) and a label that never scales.
   Blink lays out and reshapes SVG text again whenever the scale above it changes: with the label inside the scaled
   group, every frame of the bloom and of the collapse re-laid out every label. */
function nodeEl(n) {
  const mathKind = n.kind === 'sym' || n.kind === 'ctx' || n.kind === 'grp';
  const g = mk('g', { class: `nd ${n.kind}${mathKind || n.kind === 'zone' || (n.kind === 'file' && S.math) ? '' : ' big'}${n.verdict ? ' v-' + n.verdict : ''}${n.quiet ? ' quiet' : ''}` });
  const sh = (n.sh = mk('g', {}, g));
  const c = PAL[n.tone] || PAL.no, r = radius(n);
  if (n.kind === 'core') { mk('circle', { r: r + 12, fill: 'none', stroke: '#f5f5f7', 'stroke-opacity': 0.1 }, sh); n.body = mk('circle', { r, class: 'body', style: `fill:${c}` }, sh); }
  else if (n.kind === 'check' || n.kind === 'agent' || n.kind === 'grp' || n.test) mk('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: r * 0.5, fill: c, 'fill-opacity': n.verdict === 'cleared' ? 0.55 : 1 }, sh);
  else mk('circle', { r, fill: c, 'fill-opacity': n.verdict === 'cleared' ? 0.55 : 1 }, sh);
  // A proof is sealed with a ring; a spot settled later (by agents or by you) carries their colour; a risky one glows.
  if (n.verdict === 'proved') mk('circle', { r: r + 3.5, fill: 'none', stroke: PAL.ok, 'stroke-width': 1.3, 'stroke-opacity': 0.75 }, sh);
  else if (n.verdict === 'settled') mk('circle', { r: r + 3.5, fill: 'none', stroke: n.mark === 'read' ? PAL.core : PAL.agent, 'stroke-width': 1.3, 'stroke-opacity': 0.8 }, sh);
  else if (n.verdict === 'risky') mk('circle', { r: r + 5, fill: 'none', stroke: PAL.bad, 'stroke-width': 1.5, class: 'halo' }, sh);
  mk('text', { y: r + 17, 'text-anchor': 'middle' }, g).textContent = n.label;
  g.onmouseenter = () => hoverNode(n);
  g.onmouseleave = () => hoverNode(null);
  g.onpointerdown = (e) => { e.stopPropagation(); G.drag = n; G.down = { x: e.clientX, y: e.clientY }; $('g').setPointerCapture(e.pointerId); $('tip').classList.remove('on'); };
  n.el = g; n.lab = false;
  return g;
}
const place = (n) => { setA(n.el, 'transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`); setA(n.sh, 'transform', `scale(${Math.max(0.001, n.s).toFixed(3)})`); };

/* The branch's dot, already in the graph before anything has loaded: it is what the person clicked. */
function seedGraph(x, y, tone) {
  resetGraph(); G.paused = false; G.fp = null;
  const [cx, cy] = focusPoint();
  const n = { id: 'pr', label: 'PR', kind: 'core', tone: 'core', info: 'The whole change', depth: 0, i: 0, x, y, bx: cx, by: cy, s: TIP_S, ts: 1, at: 0, K: 0.016 };
  G.gn.appendChild(nodeEl(n)); n.body.style.fill = PAL[tone] || PAL.core;
  G.nodes.set('pr', n); place(n);
  requestAnimationFrame(() => requestAnimationFrame(() => { n.body.style.fill = PAL.core; })); // its colour melts into the core's white on the way
  startLoop();
}

function renderGraph(m) {
  S.model = m;
  const svg = $('g'); if (!G.camEl) resetGraph();
  const { P, links } = layout(m, svg.clientWidth, svg.clientHeight);
  const prev = G.nodes, core0 = prev.get('pr'), now = performance.now();
  const first = prev.size <= 1; // only the seeded core so far: the whole graph grows out of it
  const crowded = P.length > 26; // many nodes: the settled, unimportant ones keep their names for hover
  if (typeof mathLegend === 'function') mathLegend();
  const deg = {}; links.forEach((l) => { deg[l.a.id] = (deg[l.a.id] || 0) + 1; deg[l.b.id] = (deg[l.b.id] || 0) + 1; });
  G.links.forEach((l) => l.el.remove());
  prev.forEach((n) => { if (n !== core0) n.el.remove(); });
  G.nodes = new Map();
  P.forEach((p, i) => {
    const o = prev.get(p.id);
    const n = p.id === 'pr' && core0 ? core0 : { s: 0 };
    Object.assign(n, { id: p.id, label: p.label, kind: p.kind, tone: p.tone, info: p.info, file: p.file, start: p.start, depth: p.depth, parent: p.parent, deg: deg[p.id] || 0, i, bx: p.x, by: p.y, ts: 1, follow: null, K: 0.02,
      verdict: p.verdict, mark: p.mark, impact: p.impact, test: p.test, path: p.path, end: p.end, m: p.m, quiet: (p.kind === 'ctx' && crowded) || (p.kind === 'sym' && crowded && (p.impact || 0) < 0.3 && !['risky', 'uncertain'].includes(p.verdict)) });
    if (o) { // already on screen: keep where it is and move smoothly to its new place
      if (n !== o) Object.assign(n, { x: o.x, y: o.y, s: o.s, vx: o.vx, vy: o.vy, vs: o.vs });
      n.at = 0;
    } else { // new: grows out of its parent (or the core), outer rings a little later
      const from = prev.get(p.parent) || core0;
      Object.assign(n, { x: from ? from.x : p.x, y: from ? from.y : p.y, s: 0, vx: 0, vy: 0, vs: 0, at: now + (first ? p.depth * 130 + (i % 7) * 28 : 160) });
    }
    if (n !== core0) G.gn.appendChild(nodeEl(n));
    G.nodes.set(n.id, n); place(n);
  });
  const core = G.nodes.get('pr');
  if (core) G.gn.appendChild(core.el); // on top: the rest of the graph comes out from behind it
  G.links = links.map((l) => ({ a: G.nodes.get(l.a.id), b: G.nodes.get(l.b.id), t: l.t, dep: !!l.t && l.t.startsWith('dep'), op: -1, el: mk('line', { class: 'lk ' + l.t }, G.gl) }));
  if (G.focus) G.focus.ids = G.focus.ids.filter((id) => G.nodes.has(id));
  if (G.focus && !G.focus.ids.length) G.focus = null;
  paintHL();
  startLoop();
}

/* The loop runs at full rate only while something travels (a node, the camera, a hand on the graph). Once
   everything has arrived, only the breathing is left: a drift of a pixel or two that looks the same at
   ~20 updates a second, so the loop naps between frames and the page mostly rests.
   While Fix it covers the graph the loop stops altogether (pauseGraph). */
function startLoop() {
  if (G.paused) return;
  if (G.nap) { clearTimeout(G.nap); G.nap = 0; }
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}
function stopLoop() { cancelAnimationFrame(G.raf); clearTimeout(G.nap); G.raf = 0; G.nap = 0; G.t = 0; }
function pauseGraph(on) { G.paused = !!on; if (on) stopLoop(); else startLoop(); }
const NAP_MS = 40;
function frame(now) {
  G.raf = 0;
  const dt = G.t ? Math.min(3, (now - G.t) / 16.667) : 1; G.t = now;
  const ts = now / 1000;
  const fp = G.focus ? focusPoint() : null; // layout is read before anything is written this frame
  let moving = false;
  for (const n of G.nodes.values()) {
    if (now >= n.at) {
      const w = n.kind === 'core' || n.follow || RM ? 0 : 1.6; // a slow breathing so the graph feels alive
      const gx = n.follow ? n.follow.x : n.bx + Math.sin(ts * 0.7 + n.i * 1.3) * w;
      const gy = n.follow ? n.follow.y : n.by + Math.cos(ts * 0.6 + n.i * 0.9) * w;
      if (RM) { n.x = gx; n.y = gy; n.s = n.ts; }
      else {
        spring(n, 'x', gx, n.K, dt); spring(n, 'y', gy, n.K, dt); spring(n, 's', n.ts, n.K * 1.7, dt, 0.82);
        if (!moving && (Math.abs(n.vx) > 0.06 || Math.abs(n.vy) > 0.06 || Math.abs(n.vs) > 0.002 || Math.abs(n.ts - n.s) > 0.004 || Math.abs(gx - n.x) > 3 || Math.abs(gy - n.y) > 3)) moving = true;
      }
    } else moving = true; // still waiting to grow
    place(n);
    if (!n.lab && n.ts === 1 && n.s > 0.85) { n.lab = true; n.el.classList.add('lab'); }
    else if (n.lab && n.ts !== 1) { n.lab = false; n.el.classList.remove('lab'); }
  }
  for (const l of G.links) {
    setA(l.el, 'x1', l.a.x.toFixed(1)); setA(l.el, 'y1', l.a.y.toFixed(1));
    if (l.dep) { // stops at the rim of what it points at, so the arrow head shows
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1, cut = Math.min(d * 0.5, radius(l.b) * l.b.s + 3);
      setA(l.el, 'x2', (l.b.x - (dx / d) * cut).toFixed(1)); setA(l.el, 'y2', (l.b.y - (dy / d) * cut).toFixed(1));
    } else { setA(l.el, 'x2', l.b.x.toFixed(1)); setA(l.el, 'y2', l.b.y.toFixed(1)); }
    const o = Math.max(0, Math.min(1, l.a.s, l.b.s));
    setS(l.el, 'opacity', o > 0.98 ? '' : o.toFixed(2));
  }
  const c = G.cam;
  if (G.focus) {
    const list = G.focus.ids.map((id) => G.nodes.get(id)).filter(Boolean);
    if (list.length) {
      const xs = list.map((n) => n.x), ys = list.map((n) => n.y);
      const fx = (Math.min(...xs) + Math.max(...xs)) / 2, fy = (Math.min(...ys) + Math.max(...ys)) / 2;
      // While something is being talked about, the camera keeps drifting in, slowly.
      const drift = RM || G.focus.still ? 1 : 1 + 0.06 * Math.min(1, (now - G.focus.t0) / 9000);
      if (drift > 1 && now - G.focus.t0 < 9000) moving = true;
      const k = G.focus.k * drift;
      c.tk = k; c.tx = fp[0] - fx * k; c.ty = fp[1] - fy * k;
    }
  }
  if (RM) Object.assign(c, { x: c.tx, y: c.ty, k: c.tk });
  else {
    const K = G.focus?.K || 0.02; spring(c, 'x', c.tx, K, dt); spring(c, 'y', c.ty, K, dt); spring(c, 'k', c.tk, K, dt);
    if (Math.abs(c.vx) > 0.05 || Math.abs(c.vy) > 0.05 || Math.abs(c.vk) > 0.0002 || Math.abs(c.tx - c.x) > 0.5 || Math.abs(c.ty - c.y) > 0.5 || Math.abs(c.tk - c.k) > 0.001) moving = true;
  }
  setA(G.camEl, 'transform', `translate(${c.x.toFixed(1)},${c.y.toFixed(1)}) scale(${c.k.toFixed(4)})`);
  if (G.pin && !G.hover) { const n = G.nodes.get(G.pin); if (n) tipAt(n); }
  if (G.paused) return;
  if (moving || G.drag || G.pan) G.raf = requestAnimationFrame(frame);
  else G.nap = setTimeout(() => { G.nap = 0; G.raf = requestAnimationFrame(frame); }, RM ? 400 : NAP_MS);
}
function tipAt(n) {
  const tip = $('tip'); const [sx, sy] = toScreen(n.x, n.y);
  if (tip.dataset.id !== n.id) { tip.dataset.id = n.id; tip.innerHTML = `${esc(n.label)}<small>${esc(n.info)}</small>`; }
  // Moved with a transform, not left/top: no layout, and the compositor can do it.
  setS(tip, 'transform', `translate(${sx.toFixed(1)}px,${(sy - radius(n) * n.s * G.cam.k).toFixed(1)}px) translate(-50%,calc(-100% - 18px))`);
  if (!tip.classList.contains('on')) tip.classList.add('on');
}
function hoverNode(n) {
  if (G.drag || G.pan?.moved) return;
  G.hover = n ? n.id : null; paintHL();
  if (n) tipAt(n);
  else if (!G.pin) $('tip').classList.remove('on');
}
/* Light a node (or the focused group) and its neighbours; dim the rest. */
function paintHL() {
  const svg = $('g'); const ids = G.hover ? [G.hover] : G.focus?.ids || [];
  svg.classList.toggle('hl', ids.length > 0);
  const base0 = new Set(ids), lit = new Set(ids);
  G.links.forEach((l) => { const hit = base0.has(l.a.id) || base0.has(l.b.id); l.el.classList.toggle('on', hit); if (hit) { lit.add(l.a.id); lit.add(l.b.id); } });
  G.nodes.forEach((n) => n.el.classList.toggle('on', lit.has(n.id)));
}

/* ── Camera controls: voice, wheel, drag, double-click ─────────────────── */
function focusOn(ids, opts = {}) {
  const list = ids.map((id) => G.nodes.get(id)).filter(Boolean);
  if (!list.length || $('full').hidden) return false;
  const [px, py] = focusPoint();
  let k;
  if (opts.k) k = opts.k;
  else if (list.length === 1) k = list[0].kind === 'zone' ? 2.6 : list[0].kind === 'core' ? 1.6 : list[0].kind === 'sym' || list[0].kind === 'ctx' ? 1.45 : 2.1;
  else {
    const xs = list.map((n) => n.bx), ys = list.map((n) => n.by);
    const w = Math.max(...xs) - Math.min(...xs) + 220, h = Math.max(...ys) - Math.min(...ys) + 180;
    k = Math.max(0.9, Math.min(2.3, Math.min((px * 2 * 0.85) / w, (py * 2 * 0.8) / h)));
  }
  G.focus = { ids: list.map((n) => n.id), k, t0: performance.now(), K: opts.K, still: opts.still };
  G.pin = list.length === 1 && !opts.noTip ? list[0].id : null;
  if (!G.pin) $('tip').classList.remove('on');
  paintHL(); startLoop();
  return list;
}
function zoomGraph(action) {
  const c = G.cam;
  if (action === 'in' || action === 'out') {
    const f = action === 'in' ? 1.6 : 1 / 1.6;
    if (G.focus) { G.focus.k = Math.max(0.5, Math.min(5, G.focus.k * f)); G.focus.t0 = performance.now(); startLoop(); return true; }
    const [px, py] = focusPoint(); zoomAt(px, py, f); return true;
  }
  G.focus = null; G.pin = null; G.hover = null; paintHL(); $('tip').classList.remove('on');
  Object.assign(c, { tx: 0, ty: 0, tk: 1 }); startLoop();
  return true;
}
function zoomAt(sx, sy, f) {
  const c = G.cam;
  if (G.focus) { G.focus = null; G.pin = null; paintHL(); $('tip').classList.remove('on'); }
  const k = Math.min(5, Math.max(0.45, c.tk * f));
  const wx = (sx - c.tx) / c.tk, wy = (sy - c.ty) / c.tk;
  Object.assign(c, { tk: k, tx: sx - wx * k, ty: sy - wy * k }); startLoop();
}
/* Find graph nodes from words: a file, a check, a line ("Foo.cs:120"), an agent, or a group. */
const GROUPS = [
  [/residue|must read|have to read|to read|leer|rojo|red|bad|danger|peligro/i, (n) => n.tone === 'bad'],
  [/decid|question|pregunta|yellow|amarill|warn|diverg/i, (n) => n.tone === 'warn'],
  [/reproduc|green|verde|consensus|safe/i, (n) => n.tone === 'ok' && n.kind !== 'file'],
  [/check|verif|comprob|prueba/i, (n) => n.kind === 'check'],
  [/agent|replica|réplica|agente/i, (n) => n.kind === 'agent'],
  [/zone|zona|region|región|line|línea|function|función|method|método/i, (n) => n.kind === 'zone' || n.kind === 'sym'],
  [/file|fichero|archivo/i, (n) => n.kind === 'file'],
  [/whole|all|todo|overview|core|^pr$/i, (n) => n.kind === 'core'],
];
function findNodes(q) {
  const s = String(q || '').toLowerCase().trim(); if (!s) return [];
  const all = [...G.nodes.values()];
  const loc = s.match(/([\w.-]+\.\w+)\s*:\s*(\d+)/);
  if (loc) {
    const z = all.filter((n) => (n.kind === 'zone' || n.kind === 'sym') && n.file?.toLowerCase() === loc[1]).sort((a, b) => Math.abs(a.start - loc[2]) - Math.abs(b.start - loc[2]))[0];
    if (z) return [z];
  }
  const exact = all.filter((n) => n.label.toLowerCase() === s || n.id.toLowerCase() === s);
  if (exact.length) return exact;
  const word = s.replace(/^(the|el|la|los|las)\s+/, '');
  const named = all.filter((n) => n.kind !== 'zone' && word.length > 2 && (n.label.toLowerCase().includes(word) || word.includes(n.label.toLowerCase().replace(/…/g, '')) || n.id.toLowerCase().includes(word)));
  const lead = named.filter((n) => n.label.toLowerCase().startsWith(word) || base(n.id).toLowerCase().startsWith(word));
  if (lead.length) return lead; // "ResolverTemplate" means that file, not CompositeResolverTemplate
  if (named.length && named.length <= 4) return named;
  const stem = word.replace(/s$/, '');
  const byName = all.filter((n) => n.kind !== 'zone' && stem.length > 3 && n.label.toLowerCase().startsWith(stem));
  if (byName.length) return byName;
  for (const [re, fn] of GROUPS) if (re.test(s)) { const g = all.filter(fn); if (g.length) return g; }
  return named;
}
function focusGraph(q) { const list = findNodes(q); return list.length ? focusOn(list.map((n) => n.id)) : false; }

(() => {
  const svg = $('g');
  svg.onpointerdown = (e) => { if (e.button === 0) { G.pan = { x: e.clientX, y: e.clientY, cx: G.cam.tx, cy: G.cam.ty, moved: false }; svg.setPointerCapture(e.pointerId); } };
  svg.onpointermove = (e) => {
    if (G.drag) { const [wx, wy] = toWorld(e.clientX, e.clientY); G.drag.bx = wx; G.drag.by = wy; startLoop(); return; }
    if (!G.pan) return;
    const dx = e.clientX - G.pan.x, dy = e.clientY - G.pan.y;
    if (!G.pan.moved && Math.hypot(dx, dy) < 5) return;
    if (!G.pan.moved) { G.pan.moved = true; G.focus = null; G.pin = null; G.hover = null; paintHL(); $('tip').classList.remove('on'); svg.classList.add('panning'); }
    Object.assign(G.cam, { tx: G.pan.cx + dx, ty: G.pan.cy + dy });
    Object.assign(G.cam, { x: G.cam.tx, y: G.cam.ty, vx: 0, vy: 0 }); // the hand moves the world directly
    startLoop();
  };
  svg.onpointerup = svg.onpointercancel = (e) => {
    const click = G.pan && !G.pan.moved && e.type === 'pointerup' && e.target === svg;
    const tap = G.drag && G.down && e.type === 'pointerup' && Math.hypot(e.clientX - G.down.x, e.clientY - G.down.y) < 6 ? G.drag : null;
    G.drag = null; G.down = null; G.pan = null; svg.classList.remove('panning');
    if (tap) { nodeTap(tap); return; }
    if (click && (G.focus || G.cam.tk !== 1)) zoomGraph('fit'); // a click on empty space steps back out
  };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * (e.ctrlKey ? 0.01 : 0.0011))); }, { passive: false });
})();

/* The home zooms toward the branch while the graph takes over; closing plays it backwards. */
function dive(x, y) {
  const home = $('home'); const r = home.getBoundingClientRect();
  home.style.setProperty('--ox', x - r.left + 'px'); home.style.setProperty('--oy', y - r.top + 'px');
  document.body.classList.add('dive');
}
function collapseGraph([x, y], tone) {
  const core = G.nodes.get('pr');
  G.focus = null; G.pin = null; G.hover = null; paintHL();
  Object.assign(G.cam, { tx: 0, ty: 0, tk: 1 });
  for (const n of G.nodes.values()) {
    n.at = 0;
    if (n === core) continue;
    Object.assign(n, { follow: core, ts: 0, K: 0.05 });
  }
  if (core) { Object.assign(core, { bx: x, by: y, ts: TIP_S, K: 0.03 }); if (core.body) core.body.style.fill = PAL[tone] || PAL.core; }
  G.paused = false; startLoop();
}

/* Every opening of a branch gets a number. Anything that comes back late (a fetch, a timer, the live
   stream) for a branch that is no longer the open one is dropped, so switching fast never mixes runs. */
let openSeq = 0, closeTimer = 0, renderTimer = 0;
const alive = (seq) => seq === openSeq && !$('full').hidden && $('full').classList.contains('open');
function stopStream() { if (S.es) { S.es.close(); S.es = null; } clearInterval(S.timer); }
const fetchPlan = (p) => api(`/projects/${S.pid}/plan?pr=${encodeURIComponent(p.id)}&mode=completo&profile=${S.profile}`);
/* The graph blooms once the core has mostly arrived in the middle, however fast the data came back. */
function scheduleGraph(seq, m) { clearTimeout(renderTimer); renderTimer = setTimeout(() => alive(seq) && renderGraph(m), Math.max(0, S.openedAt + 430 - performance.now())); }

async function openGraph(p, x, y) {
  const seq = ++openSeq;
  clearTimeout(closeTimer); clearTimeout(renderTimer); stopStream();
  if (x == null) [x, y] = tipOf(p.id) || [innerWidth / 2, innerHeight * 0.55];
  $('card').classList.remove('on'); $('tip').classList.remove('on');
  Object.assign(S, { cur: p, run: null, plan: null, model: null, math: null, marks: {}, starting: false, hl: [], origin: [x, y], openedAt: performance.now() });
  // The mathematical pass (server/math): about a second, no model, nothing executed. It decides what the graph shows.
  const mathP = api(`/projects/${S.pid}/math?pr=${encodeURIComponent(p.id)}`).catch(() => null);
  const full = $('full');
  if (typeof closeTree === 'function') closeTree(true);
  Object.assign(S, { fixTarget: null });
  full.classList.remove('open', 'indebate', 'infix');
  $('fid').textContent = name(p); $('fbr').textContent = p.branch;
  renderBar();
  if (!document.body.classList.contains('dive')) dive(x, y);
  full.hidden = false;
  seedGraph(x, y, state(p).tone);
  void full.offsetWidth; full.classList.add('open');
  try {
    if (p.running) {
      const [plan, math] = await Promise.all([fetchPlan(p), mathP]);
      if (!alive(seq)) return;
      Object.assign(S, { plan, math, marks: math?.marks || {} }); scheduleGraph(seq, graphOf());
      attach(p.running, seq); return;
    }
    const run = p.last ? await api(`/projects/${S.pid}/runs/${p.last.runId}`) : null;
    const [plan, math] = await Promise.all([run?.brief ? null : fetchPlan(p), mathP]);
    if (!alive(seq)) return;
    Object.assign(S, { run, plan, math, marks: math?.marks || {} });
  } catch (e) { if (alive(seq)) renderBar(e.message, true); return; }
  renderBar();
  scheduleGraph(seq, graphOf());
}
/* What the open branch's graph shows: the dependency graph coloured by mathematics, or (if that pass failed) the files and checks of the report. */
const graphOf = () => (S.math && typeof mathModel === 'function' ? mathModel(S.math) : model(S.run?.brief, S.plan));
function closeGraph() {
  const full = $('full');
  if (full.hidden || !full.classList.contains('open')) return;
  openSeq++; // late answers for this branch are now ignored
  clearTimeout(renderTimer); stopStream();
  if (typeof closeDebate === 'function') closeDebate(true);
  if (typeof closeTree === 'function') closeTree(true);
  $('tip').classList.remove('on');
  full.classList.remove('open');
  collapseGraph(S.origin || [innerWidth / 2, innerHeight / 2], S.cur ? state(S.cur).tone : 'core');
  document.body.classList.remove('dive');
  Object.assign(S, { run: null, plan: null, model: null, math: null, marks: {}, starting: false });
  if (typeof hideNodeCard === 'function') hideNodeCard();
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { if (!full.classList.contains('open')) { full.hidden = true; stopLoop(); resetGraph(); } }, 760);
  // Reload once the home has zoomed back in: redrawing the tree mid-move costs a layout and a full repaint.
  setTimeout(() => { if (!document.body.classList.contains('dive')) reloadPRs().catch(() => {}); }, 980);
}
$('back').onclick = () => (typeof treeOpen === 'function' && treeOpen() ? closeTree() : closeGraph());
/* There is one view of a branch now, the graph. Kept for older callers. */
function setView(mode) { return mode === 'graph'; }
/* A click on a node (not a drag) flies the camera to it; a code region also becomes the spot Review & sign opens on. */
function nodeTap(n) {
  if (typeof mathTap === 'function' && mathTap(n)) return; // a node of the mathematical graph opens its evidence
  if (typeof hideNodeCard === 'function') hideNodeCard();
  focusOn([n.id]);
  S.fixTarget = n.kind === 'zone' ? n : null;
  renderBar();
}

/* The one bar at the bottom of the graph: a number, a state, one action.
   An error from loading the branch is fatal (only Back); an error from an action can be dismissed. */
const spotTag = () => (S.fixTarget ? ` <small class="spot">:${S.fixTarget.start}</small>` : '');
function renderBar(error, fatal) {
  const p = S.cur, b = S.run?.brief;
  const seg = `<div class="seg">${Object.entries(PROFILE).map(([id, [n, d]]) => `<button data-p="${id}" class="${S.profile === id ? 'on' : ''}" title="${esc(d)}">${n}</button>`).join('')}</div>`;
  let h;
  if (error) h = `<span class="txt" style="color:var(--bad);white-space:normal;max-width:520px">${esc(error)}</span>${fatal ? '<button class="cta ghost" id="bBack">Back</button>' : '<button class="cta ghost" id="bOk">OK</button>'}`;
  else if (S.starting) h = '<span class="spin"></span><span class="txt" style="color:var(--fg)">Starting…</span><button class="cta" disabled>Verifying…</button>';
  else if (S.es) h = `<span class="spin"></span><span class="txt live" style="color:var(--fg)">${esc(S.stage)}</span><span class="txt">${secs(Date.now() - S.t0)}</span><button class="cta" id="bReview">Watch the review</button>`;
  else if (S.math && typeof mathBar === 'function') h = mathBar();
  else if (b) {
    const stale = p.sha && !b.pr.head.startsWith(p.sha);
    const so = S.run.signoff;
    const v = b.version >= 2 && b.verdict, sc = v?.score;
    const [tone, label] = stale ? ['no', 'Out of date'] : so ? (so.decision === 'aprobar' ? ['ok', 'Signed'] : ['bad', 'Sent back']) : v ? VERDICT[v.status] || ['warn', v.label] : [laneTone(b.lane.id, b.lane.tone), laneName(b.lane.id, b.lane.name)];
    const num = v ? (sc && sc.value != null ? `<span class="num">${sc.value}<small> / 10</small></span><span class="txt">review score</span>` : '<span class="num">–</span><span class="txt">no score yet</span>') : `<span class="num">${b.residue.lines}<small> / ${b.totals.lines}</small></span><span class="txt">lines are yours</span>`;
    h = `${num}<span class="chip ${tone}" style="background:${PAL[tone]}">${esc(label)}</span>`
      + (stale ? `${seg}<button class="cta" id="bReview">Review again</button>` : `<button class="cta" id="bReview">${S.run.signoff ? 'View sign-off' : `Review &amp; sign${spotTag()}`}</button>`);
  } else if (S.plan) h = `<span class="num">${S.plan.totals.files}<small> files</small></span><span class="txt">+${S.plan.totals.added} −${S.plan.totals.removed} · not reviewed yet</span>${seg}<button class="cta" id="bReview">Review &amp; sign${spotTag()}</button>`;
  else h = '<span class="txt">Loading…</span>';
  $('fbar').innerHTML = h;
  $('fbar').querySelectorAll('[data-p]').forEach((x) => (x.onclick = () => { S.profile = x.dataset.p; store.set('katse.profile', S.profile); renderBar(); }));
  if (!error && !S.starting && !S.es && S.math && typeof bindMathBar === 'function') bindMathBar();
  else if ($('bReview')) $('bReview').onclick = () => openReview();
  if ($('bBack')) $('bBack').onclick = closeGraph;
  if ($('bOk')) $('bOk').onclick = () => renderBar();
}

/* ── Verification, streamed live ──────────────────────────────────────── */
/* Starts a run for the open branch. Resolves true if it started. One at a time: a second click, or a
   call while one is streaming, does nothing. The server picks how many agents a Full run gets. */
async function verify() {
  if (!S.cur || S.es || S.starting || $('full').hidden) return false;
  const seq = openSeq, p = S.cur;
  S.starting = true; renderBar();
  try {
    const r = await api(`/projects/${S.pid}/verify`, { body: { pr: p.id, options: { mode: 'completo', profile: S.profile, mutants: 4 } } });
    S.starting = false;
    p.running = r.runId; // the tree and a reopen show it as running until the next reload
    if (S.cur?.id === p.id) S.cur.running = r.runId;
    if (alive(seq) && S.cur?.id === p.id) attach(r.runId, seq);
    reloadPRs().catch(() => {});
    return true;
  } catch (e) {
    S.starting = false;
    if (alive(seq)) renderBar(e.message);
    return false;
  }
}
/* What the real pipeline is doing right now, in a few words (its events: contract, candidate, debate, attack, result, judgment). */
function liveText(e) {
  if (e.type === 'contract') return `Contract: ${e.expectations?.length || 0} expectations`;
  if (e.type === 'candidate') return `Alternative ${e.id}: ${CAND[e.status] || e.status}`;
  if (e.type === 'debate') return `Debate: ${e.candidate} ${e.round === 'results' ? 'after the tests' : 'reviews the other proposal'}`;
  if (e.type === 'attack') return `Attack ${e.id}: ${e.status}`;
  if (e.type === 'result') return `${e.version}: ${e.status} · ${e.ran || 0} tests`;
  if (e.type === 'intent') return `Requested / implemented: ${e.status}`;
  if (e.type === 'privacy') return `Privacy: ${e.mode}`;
  if (e.type === 'allocation') return `Orchestrator: ${e.population.admitted}/${e.population.proposed} alternatives within budget · Decisions ${e.routing.status}`;
  if (e.type === 'judgment') return `Judge: ${VERDICT[e.verdict?.status]?.[1] || e.verdict?.label || 'done'}`;
  return null;
}
function attach(runId, seq = openSeq) {
  stopStream();
  const prId = S.cur.id;
  Object.assign(S, { stage: 'Starting in an isolated copy', t0: Date.now(), liveEv: [] });
  const es = new EventSource(`/api/projects/${S.pid}/runs/${runId}/events`);
  S.es = es; renderBar();
  api(`/projects/${S.pid}/runs/${runId}`).then(meta => {
    if (S.es !== es || !alive(seq)) return;
    const started = Date.parse(meta.startedAt);
    if (Number.isFinite(started)) S.t0 = started;
    renderBar();
  }).catch(() => {});
  S.timer = setInterval(() => { if (S.es === es && alive(seq)) renderBar(); }, 1000);
  es.onmessage = async (m) => {
    if (S.es !== es) return;
    const e = JSON.parse(m.data);
    const live = liveText(e);
    S.liveEv.push(e); if (typeof treeEvent === 'function') treeEvent(e);
    if (e.type === 'stage' && e.status === 'start') { S.stage = STAGE[e.id] || e.name; renderBar(); }
    else if (live) { S.stage = live; renderBar(); }
    else if (e.type === 'end') {
      stopStream();
      try {
        await reloadPRs();
        if (!alive(seq) || S.cur?.id !== prId) return;
        const run = await api(`/projects/${S.pid}/runs/${runId}`);
        if (!alive(seq)) return;
        S.run = run;
        if (!run.brief) { renderBar(`Verification failed: ${english(run.error) || 'unknown error'}`); if (typeof treeLiveDone === 'function') treeLiveDone(); return; }
        renderBar(); renderGraph(graphOf());
        if (typeof treeLiveDone === 'function') treeLiveDone();
      } catch (err) { if (alive(seq)) renderBar(err.message); }
    }
  };
  es.onerror = () => {
    if (S.es !== es) return;
    // The browser reconnects by itself unless the stream is closed for good.
    if (es.readyState === EventSource.CLOSED) { stopStream(); renderBar('Lost the live connection. The verification may still be running: go back and open the branch again.', true); }
    else { S.stage = 'Reconnecting…'; renderBar(); }
  };
}

/* ── Review & sign: the review is the agents' tree (review.js), growing out of the spot you clicked; the
   verdict card at its end is where you sign. No review yet: it starts one and the tree grows live. */
function openReview(target) { return typeof openTree === 'function' ? openTree(target?.full ? {} : target || { node: S.fixTarget }) : null; }

/* ── Modal ────────────────────────────────────────────────────────────── */
function modal(html) { $('mbody').innerHTML = html; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; }
function showText(title, text) { modal(`<h2>${esc(title)}</h2><pre class="log">${esc(text)}</pre>`); }
$('mx').onclick = closeModal;
$('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const typing = e.target.closest?.('input, textarea');
  if (!$('modal').hidden) closeModal();
  else if (sideOpen()) { closeSide(); $('sideBtn').focus(); }
  else if (typing) e.target.blur(); // first Esc leaves the field; what you typed is not lost
  else if (typeof treeEscape === 'function' && treeEscape()) { /* the review, back to the graph */ }
  else if (typeof debateEscape === 'function' && debateEscape()) { /* the agent, then the debate */ }
  else if (!$('full').hidden) { if ((G.focus || Math.abs(G.cam.tk - 1) > 0.01 || G.cam.tx || G.cam.ty)) zoomGraph('fit'); else closeGraph(); } // step back out, then leave
  else if (S.focus || S.zoom) hideCommits();
});

init().catch((e) => { $('sum').textContent = e.message; });
