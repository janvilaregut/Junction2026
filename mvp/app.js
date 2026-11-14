/* Katse UI. Plain JavaScript, no build step. Everything shown comes from the API; text from
   repositories is always escaped before it reaches the page.
   Three views: the branch tree (home), the full-screen graph of one branch, the review drawer. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => String(p).split('/').pop();
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function api(path, opts) {
  const init = opts ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined;
  const r = await fetch('/api' + path, init);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || 'Request failed');
  return data;
}

const NS = 'http://www.w3.org/2000/svg';
const mk = (t, a, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
const PAL = { ok: '#bfe3d0', warn: '#f3e2a6', bad: '#f2a99f', no: '#55555c', file: '#cde4ee', filedim: '#4d585d', agent: '#e3dcf4', core: '#f5f5f7' };
const S = { projects: [], agents: [], pid: null, prs: { incoming: [], outgoing: [] }, base: '', expanded: false, cur: null, run: null, plan: null, mode: 'quick', es: null, stage: '', t0: 0, timer: 0 };

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
  if (!S.projects.length) return projectsModal(true);
  const saved = store.get('katse.project');
  await loadProject(S.projects.find((p) => p.id === saved)?.id || S.projects[0].id);
}
async function loadProject(id) {
  S.pid = id; store.set('katse.project', id);
  $('projName').textContent = S.projects.find((p) => p.id === id)?.name || id;
  $('sum').innerHTML = '&nbsp;';
  await reloadPRs();
}
async function reloadPRs() {
  const prs = await api(`/projects/${S.pid}/prs`);
  S.prs = prs; S.base = prs.base;
  if (S.cur) S.cur = [...prs.incoming, ...prs.outgoing].find((p) => p.id === S.cur.id) || S.cur;
  renderTree();
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

/* ── Home: left = history, centre = you, right = merges still to come ── */
function renderTree() {
  const svg = $('tree'); svg.innerHTML = '';
  const W = Math.max(svg.parentElement.clientWidth, 760);
  const recent = S.prs.incoming.filter((p) => p.last || p.running || (!p.behind && Date.now() - new Date(p.date) < 30 * 864e5));
  const old = S.prs.incoming.filter((p) => !recent.includes(p));
  const inc = S.expanded ? [...recent, ...old] : recent;
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
  const draw = (list, dir) => {
    const step = Math.min(46, Math.max(14, (W - xNow - 300) / Math.max(list.length - 1, 1)));
    list.forEach((p, i) => {
      const st = state(p); const col = PAL[st.tone];
      const y = mainY + dir * (i + 1) * GAP; const dy = Math.abs(y - mainY);
      const xf = p.behind ? Math.max(40, xNow - (30 + 34 * Math.log2(1 + p.behind))) : xNow;
      const R = 34 + dy * 0.8;
      const tipX = Math.max(xNow + 150 + i * step, xf + R + 40);
      const M = Math.min(44 + dy * 0.45, W - 16 - tipX);
      const mx = tipX + M;
      const faint = !recent.includes(p) && dir < 0;
      const g = mk('g', { class: 'lane' + (st.tone === 'warn' || st.tone === 'bad' ? ' pulse' : ''), 'data-pr': p.id }, lanes);
      const fork = `M${xf} ${mainY} C ${xf + R * .55} ${mainY}, ${xf + R * .45} ${y}, ${xf + R} ${y} L ${tipX} ${y}`;
      const merge = `M${tipX} ${y} C ${tipX + M * .55} ${y}, ${mx - M * .45} ${mainY}, ${mx} ${mainY}`;
      mk('path', { d: fork, fill: 'none', stroke: col, 'stroke-width': faint ? 1.4 : 2.2, 'stroke-linecap': 'round', 'stroke-opacity': faint ? .5 : .95 }, g);
      if (st.end !== 'cut') {
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
      mk('path', { d: fork + ' ' + merge, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(GAP - 8, 18) }, g);
      g.onmouseenter = () => { svg.classList.add('hl'); g.classList.add('on'); showCard(p, st, tipX, y, dir); };
      g.onmouseleave = () => { svg.classList.remove('hl'); g.classList.remove('on'); $('card').classList.remove('on'); };
      g.onclick = () => { const r = svg.getBoundingClientRect(); openGraph(p, r.left + (tipX * r.width) / W, r.top + (y * r.height) / H); };
    });
  };
  draw(inc, -1); draw(out, 1);
  mk('circle', { cx: xNow, cy: mainY, r: 16, fill: 'none', stroke: '#f5f5f7', 'stroke-opacity': .12 }, svg);
  mk('circle', { cx: xNow, cy: mainY, r: 7.5, fill: '#f5f5f7' }, svg);
  mk('text', { x: xNow - 24, y: mainY - 14, 'text-anchor': 'end', class: 'here' }, svg).textContent = 'you are here';

  $('more').hidden = !old.length;
  $('more').textContent = S.expanded ? 'Hide older branches' : `+${old.length} older branches`;
  const pend = recent.filter((p) => state(p).end === 'open').length;
  $('sum').innerHTML = `<b>${pend} ${pend === 1 ? 'branch wants' : 'branches want'} in.</b> ${out.length ? `${out.length} of yours ${out.length === 1 ? 'wants' : 'want'} out.` : ''}`;
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
   Used by the voice mascot to point at PRs. Older branches are unfolded if needed. */
function highlightLanes(ids) {
  const want = new Set(ids || []);
  if (want.size && !S.expanded && S.prs.incoming.some((p) => want.has(p.id) && !document.querySelector(`#tree .lane[data-pr="${CSS.escape(p.id)}"]`))) { S.expanded = true; renderTree(); }
  const svg = $('tree');
  svg.classList.toggle('hl', want.size > 0);
  svg.querySelectorAll('.lane').forEach((g) => g.classList.toggle('on', want.has(g.dataset.pr)));
}
$('more').onclick = () => { S.expanded = !S.expanded; renderTree(); };
addEventListener('resize', () => S.pid && renderTree());

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
  const len = (l) => (l.a.kind === 'core' || l.b.kind === 'core' ? 170 : l.a.kind === 'zone' || l.b.kind === 'zone' ? 80 : 140);
  for (let it = 0; it < 600; it++) {
    const t = 1 - it / 600;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j]; let dx = b.x - a.x, dy = b.y - a.y; const d2 = Math.max(dx * dx + dy * dy, 100), d = Math.sqrt(d2); const f = (a.kind === 'zone' && b.kind === 'zone' ? 1800 : 4800) / d2; dx /= d; dy /= d;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
    links.forEach((l) => { const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const f = ((d - len(l)) / d) * .08; l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f; });
    P.forEach((n) => { n.vx -= n.x * .004; n.vy -= n.y * .004; if (n.kind === 'core') { n.vx -= n.x * .2; n.vy -= n.y * .2; } n.x += n.vx * t; n.y += n.vy * t; n.vx *= .55; n.vy *= .55; });
  }
  const xs = P.map((n) => n.x), ys = P.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const L0 = 110, R0 = W - 110, T0 = 120, B0 = H - 150;
  const s = Math.min((R0 - L0) / Math.max(maxX - minX, 1), (B0 - T0) / Math.max(maxY - minY, 1), 1.5);
  const ox = (L0 + R0) / 2 - ((minX + maxX) / 2) * s, oy = (T0 + B0) / 2 - ((minY + maxY) / 2) * s;
  P.forEach((n) => { n.x = n.x * s + ox; n.y = n.y * s + oy; n.bx = n.x; n.by = n.y; });
  return { P, links };
}

/* ── Full-screen graph ────────────────────────────────────────────────── */
let raf = 0;
function renderGraph(m) {
  const svg = $('g'); svg.innerHTML = '';
  $('full').classList.remove('ready');
  const W = svg.clientWidth, H = svg.clientHeight;
  const { P, links } = layout(m, W, H);
  const deg = (n) => links.filter((l) => l.a === n || l.b === n).length;
  const R = (n) => (n.kind === 'core' ? 22 : n.kind === 'zone' ? 6 : n.kind === 'file' ? 9 + Math.min(deg(n), 6) * .8 : 10);
  const gl = mk('g', {}, svg), gn = mk('g', {}, svg);
  links.forEach((l) => {
    const d = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    l.el = mk('line', { class: 'lk ' + l.t, x1: l.a.x, y1: l.a.y, x2: l.b.x, y2: l.b.y, 'stroke-dasharray': d, 'stroke-dashoffset': d, style: `--d:${Math.max(l.a.depth, l.b.depth) * 160 - 80}ms` }, gl);
  });
  const tip = $('tip'); let drag = null;
  const els = P.map((n, i) => {
    const g = mk('g', { class: 'nd' + (n.kind !== 'zone' ? ' big' : ''), transform: `translate(${n.x},${n.y})` }, gn);
    const inn = mk('g', { class: 'in', style: `--d:${n.depth * 160 + (i % 7) * 25}ms` }, g);
    const c = PAL[n.tone] || PAL.no; const r = R(n);
    if (n.kind === 'core') { mk('circle', { r: r + 12, fill: 'none', stroke: '#f5f5f7', 'stroke-opacity': .1 }, inn); mk('circle', { r, fill: c }, inn); }
    else if (n.kind === 'check' || n.kind === 'agent') mk('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: r * .5, fill: c }, inn);
    else mk('circle', { r, fill: c }, inn);
    mk('text', { y: r + 17, 'text-anchor': 'middle' }, inn).textContent = n.label;
    g.onmouseenter = () => {
      if (drag) return;
      svg.classList.add('hl'); const on = new Set([n]);
      links.forEach((l) => { const hit = l.a === n || l.b === n; l.el.classList.toggle('on', hit); if (hit) { on.add(l.a); on.add(l.b); } });
      els.forEach((e) => e.g.classList.toggle('on', on.has(e.n)));
      tip.innerHTML = `${esc(n.label)}<small>${esc(n.info)}</small>`; tip.style.left = n.x + 'px'; tip.style.top = n.y - r + 'px'; tip.classList.add('on');
    };
    g.onmouseleave = () => { svg.classList.remove('hl'); tip.classList.remove('on'); };
    g.onpointerdown = (e) => { drag = n; svg.setPointerCapture(e.pointerId); tip.classList.remove('on'); };
    return { n, g };
  });
  svg.onpointermove = (e) => { if (drag) { drag.bx = e.clientX; drag.by = e.clientY; } };
  svg.onpointerup = () => { drag = null; };
  setTimeout(() => $('full').classList.add('ready'), 60);
  setTimeout(() => links.forEach((l) => { l.el.removeAttribute('stroke-dasharray'); l.el.removeAttribute('stroke-dashoffset'); }), 3200);
  cancelAnimationFrame(raf);
  (function idle() {
    const t = performance.now() / 1000;
    P.forEach((n, i) => { const k = n.kind === 'core' ? 0 : 1.6; n.x += (n.bx + Math.sin(t * .7 + i * 1.3) * k - n.x) * .2; n.y += (n.by + Math.cos(t * .6 + i * .9) * k - n.y) * .2; });
    els.forEach(({ n, g }) => g.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`));
    links.forEach((l) => { l.el.setAttribute('x1', l.a.x); l.el.setAttribute('y1', l.a.y); l.el.setAttribute('x2', l.b.x); l.el.setAttribute('y2', l.b.y); });
    raf = requestAnimationFrame(idle);
  })();
}

async function openGraph(p, x, y) {
  $('card').classList.remove('on');
  Object.assign(S, { cur: p, run: null, plan: null });
  const full = $('full');
  full.classList.remove('ready', 'open');
  full.style.setProperty('--cx', x + 'px'); full.style.setProperty('--cy', y + 'px');
  $('fid').textContent = name(p); $('fbr').textContent = p.branch;
  $('g').innerHTML = '';
  renderBar();
  full.hidden = false; void full.offsetWidth; full.classList.add('open');
  try {
    if (p.running) { await loadPlan(); setTimeout(() => renderGraph(model(null, S.plan)), 380); return attach(p.running); }
    if (p.last) S.run = await api(`/projects/${S.pid}/runs/${p.last.runId}`);
    if (!S.run?.brief) await loadPlan();
  } catch (e) { return renderBar(e.message); }
  renderBar();
  setTimeout(() => renderGraph(model(S.run?.brief, S.plan)), 380);
}
const loadPlan = async () => { S.plan = await api(`/projects/${S.pid}/plan?pr=${encodeURIComponent(S.cur.id)}&mode=${S.mode === 'full' ? 'completo' : 'rapido'}`); };
function closeGraph() {
  const full = $('full'); if (full.hidden) return;
  if (S.es) { S.es.close(); S.es = null; clearInterval(S.timer); }
  full.classList.remove('open'); $('tip').classList.remove('on');
  setTimeout(() => { full.hidden = true; full.classList.remove('ready'); cancelAnimationFrame(raf); }, 700);
  reloadPRs().catch(() => {});
}
$('back').onclick = closeGraph;

/* The one bar at the bottom of the graph: a number, a state, one action. */
function renderBar(error) {
  const p = S.cur, b = S.run?.brief;
  const seg = `<div class="seg" title="Full: ${S.agents.length ? `${Math.min(3, S.agents.length)} agents redo the change blind. Takes minutes.` : 'no agents available'}"><button data-m="quick" class="${S.mode === 'quick' ? 'on' : ''}">Quick</button><button data-m="full" class="${S.mode === 'full' ? 'on' : ''}" ${S.agents.length ? '' : 'disabled'}>Full</button></div>`;
  let h;
  if (error) h = `<span class="txt" style="color:var(--bad)">${esc(error)}</span><button class="cta ghost" id="bBack">Back</button>`;
  else if (S.es) h = `<span class="spin"></span><span class="txt" style="color:var(--fg)">${esc(S.stage)}</span><span class="txt">${secs(Date.now() - S.t0)}</span><button class="cta" disabled>Verifying…</button>`;
  else if (b) {
    const stale = p.sha && !b.pr.head.startsWith(p.sha);
    const tone = stale ? 'no' : laneTone(b.lane.id, b.lane.tone);
    h = `<span class="num">${b.residue.lines}<small> / ${b.totals.lines}</small></span><span class="txt">lines are yours</span><span class="chip ${tone}" style="background:${PAL[tone]}">${stale ? 'Out of date' : esc(laneName(b.lane.id, b.lane.name))}</span>`
      + (stale ? `${seg}<button class="cta" id="bVerify">Verify again</button>` : `<button class="cta" id="bReview">${S.run.signoff ? 'View sign-off' : 'Review & sign'}</button>`);
  } else if (S.plan) h = `<span class="num">${S.plan.totals.files}<small> files</small></span><span class="txt">+${S.plan.totals.added} −${S.plan.totals.removed} · not verified yet</span>${seg}<button class="cta" id="bVerify">Verify</button>`;
  else h = '<span class="txt">Loading…</span>';
  $('fbar').innerHTML = h;
  $('fbar').querySelectorAll('[data-m]').forEach((x) => (x.onclick = async () => { S.mode = x.dataset.m; renderBar(); }));
  if ($('bVerify')) $('bVerify').onclick = verify;
  if ($('bReview')) $('bReview').onclick = openReview;
  if ($('bBack')) $('bBack').onclick = closeGraph;
}

/* ── Verification, streamed live ──────────────────────────────────────── */
async function verify() {
  const options = { mode: S.mode === 'full' ? 'completo' : 'rapido', mutants: 4 };
  if (S.mode === 'full') options.agents = S.agents.slice(0, 3).map((a) => a.id);
  try { const r = await api(`/projects/${S.pid}/verify`, { body: { pr: S.cur.id, options } }); attach(r.runId); }
  catch (e) { renderBar(e.message); }
}
function attach(runId) {
  const prId = S.cur.id;
  Object.assign(S, { stage: 'Starting in an isolated copy', t0: Date.now() });
  const es = new EventSource(`/api/projects/${S.pid}/runs/${runId}/events`);
  S.es = es; renderBar();
  clearInterval(S.timer); S.timer = setInterval(() => S.es && renderBar(), 1000);
  es.onmessage = async (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'stage' && e.status === 'start') { S.stage = STAGE[e.id] || e.name; renderBar(); }
    else if (e.type === 'end') {
      es.close(); S.es = null; clearInterval(S.timer);
      await reloadPRs();
      if (S.cur?.id !== prId || $('full').hidden) return;
      S.run = await api(`/projects/${S.pid}/runs/${runId}`);
      if (!S.run.brief) return renderBar(`Verification failed: ${S.run.error || 'unknown error'}`);
      renderBar(); renderGraph(model(S.run.brief));
    }
  };
  es.onerror = () => { if (S.es === es) { es.close(); S.es = null; clearInterval(S.timer); renderBar(); } };
}

/* ── Review drawer: decide, read, sign ────────────────────────────────── */
function codeHTML(item) {
  if (!item.code?.length) return '';
  return `<pre class="code">${item.code.map((c) => `<span class="h">@@ line ${c.at}</span>\n${c.removed.map((l) => `<span class="r">- ${esc(l)}</span>`).join('\n')}${c.removed.length && c.added.length ? '\n' : ''}${c.added.map((l) => `<span class="a">+ ${esc(l)}</span>`).join('\n')}`).join('\n')}</pre>`;
}
const copyBlock = (title, text, id) => `<div class="copy"><label>${esc(title)}</label><button type="button" data-copy="${id}">Copy</button><pre id="${id}">${esc(text)}</pre></div>`;
function openReview() {
  const run = S.run, b = run.brief, so = run.signoff;
  $('dk').textContent = `${name(S.cur)} · ${S.cur.branch}`;
  $('dt').textContent = so ? (so.decision === 'aprobar' ? 'Signed' : 'Sent back') : laneName(b.lane.id, b.lane.name);
  const H = [`<p class="lead">${esc(LANE[b.lane.id]?.[1] || b.lane.summary)}</p>`];
  if (b.recommendation) H.push(`<p class="lead" style="margin-top:6px">Recommendation: <b style="color:var(--fg);font-weight:500">${esc(RECO[b.recommendation.id] || b.recommendation.name)}</b></p>`);
  if (b.questions.length) H.push(`<div class="sec"><h3>Decide <span>${b.questions.length}</span></h3>${b.questions.map((q) => `<div class="q"><p>${esc(q.text)}</p>${q.options.map((o) => `<label class="opt"><input type="radio" name="q-${esc(q.id)}" value="${esc(o)}" ${so?.answers?.[q.id] === o ? 'checked' : ''} ${so ? 'disabled' : ''}>${esc(OPTION[o] || o)}</label>`).join('')}</div>`).join('')}</div>`);
  if (b.residue.items.length) H.push(`<div class="sec"><h3>Read <span>${b.residue.lines} lines</span></h3>${b.residue.items.map((i) => `<details class="res"><summary>${esc(base(i.file))}:${i.start}${i.end !== i.start ? '–' + i.end : ''}<span>${i.lines} ${i.lines === 1 ? 'line' : 'lines'}</span></summary>${codeHTML(i)}</details>`).join('')}</div>`);
  H.push(`<div class="sec"><h3>Checked</h3><div class="list">${b.claims.map((c) => `<div class="li"><i style="background:${PAL[CLAIM[c.status][0]]}"></i><span><b>${CLAIM[c.status][1]}</b> · ${esc(c.text)}</span></div>`).join('')}</div></div>`);
  H.push(`<div class="sec"><details class="more2"><summary>Not checked · ${b.notChecked.length} ›</summary><div class="list">${b.notChecked.map((n) => `<div class="li"><i></i><span><b>${esc(n.what)}</b> · ${esc(n.why)}</span></div>`).join('')}</div></details></div>`);
  H.push(so ? signedHTML(run) : signHTML(b));
  H.push(`<div class="foot"><button class="link" id="mdlink">Full report</button><span>${secs(b.timing.totalMs)}${b.cost?.usd ? ` · $${b.cost.usd.toFixed(2)} in agents` : ''}</span></div>`);
  $('dbody').innerHTML = H.join('');
  $('dbody').scrollTop = 0;
  $('drawer').hidden = false;
  $('mdlink').onclick = async () => showText('Full report', await (await fetch(`/api/projects/${S.pid}/runs/${run.id}/report`)).text());
  if (so) bindSigned(); else bindSign();
}
function signHTML(b) {
  const hard = b.rules.fired.some((r) => HARD.includes(r.id));
  return `<div class="sec"><h3>Sign</h3><p class="lead">The automatic review is advice. Your signature is the approval.${b.audit ? ' This area is on probation: a second person will audit it.' : ''}</p>
    <div class="field"><label for="signer">Your name</label><input type="text" id="signer" value="${esc(store.get('katse.signer') || '')}" placeholder="Full name"></div>
    ${b.residue.items.length ? `<label class="ck"><input type="checkbox" id="ckRes"><span>I read the residue: ${b.residue.lines} lines</span></label>` : ''}
    <label class="ck"><input type="checkbox" id="ckNot"><span>I reviewed the ${b.notChecked.length} things that were not checked</span></label>
    <div class="field"><label for="risk">Residual risk I accept</label><textarea id="risk" rows="3" placeholder="In your words: what could still go wrong, and why you accept it."></textarea></div>
    <div class="btns"><button class="cta ghost" id="sendBack">Send back</button><button class="cta" id="sign" ${hard ? 'disabled title="A change that does not build or breaks tests cannot be accepted"' : ''}>Accept &amp; sign</button></div>
    <div class="err" id="serr"></div></div>`;
}
function bindSign() {
  const submit = async (decision) => {
    const b = S.run.brief; const answers = {};
    for (const q of b.questions) { const c = $('dbody').querySelector(`input[name="q-${CSS.escape(q.id)}"]:checked`); if (c) answers[q.id] = c.value; }
    const signer = $('signer').value.trim(); store.set('katse.signer', signer);
    try {
      const r = await api(`/projects/${S.pid}/runs/${S.run.id}/signoff`, { body: { signer, decision, answers, residualRisk: $('risk').value, checks: { residue: !!$('ckRes')?.checked, notChecked: !!$('ckNot')?.checked } } });
      S.run.signoff = r.signoff; S.run.signed = r;
      openReview(); renderBar(); reloadPRs().catch(() => {});
    } catch (e) { $('serr').textContent = e.message; }
  };
  $('sign').onclick = () => submit('aprobar');
  $('sendBack').onclick = () => submit('devolver');
}
function signedHTML(run) {
  const so = run.signoff, s = run.signed || {}, out = run.brief.pr.direction === 'outgoing';
  return `<div class="sec"><h3>Sign-off</h3>
    <div class="done"><b>${so.decision === 'aprobar' ? 'Accepted' : 'Sent back'} by ${esc(so.signer)}</b><p>${new Date(so.ts).toLocaleString('en-GB')} · report sha256:${esc(so.briefHash.slice(0, 12))}…${so.auditRequired ? ' · waiting for a second person to audit' : ''}</p><p>Accepted risk: ${esc(so.residualRisk)}</p></div>
    ${so.decision === 'aprobar' && s.commands?.length ? copyBlock(out ? 'To send it (you run this)' : 'To merge (you run this)', s.commands.join('\n'), 'c1') : ''}
    ${s.trailers ? copyBlock('Commit trailers', s.trailers, 'c2') : ''}
    ${s.markdown ? copyBlock(out ? 'PR description, with the report' : 'PR comment', s.markdown, 'c3') : ''}
    <p class="lead" style="margin-top:14px">Katse never merges. You do.</p>
    <button class="link" id="attach" style="margin-top:10px">Attach the report to the commit (git notes)</button><div class="err" id="aerr" style="color:var(--fg2)"></div></div>`;
}
function bindSigned() {
  $('dbody').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); }));
  $('attach').onclick = async () => {
    try { const r = await api(`/projects/${S.pid}/runs/${S.run.id}/attach`, { body: {} }); $('aerr').innerHTML = `Attached to ${esc(r.commit.slice(0, 9))} in <code>${esc(r.ref)}</code>. To share it: <code>${esc(r.push)}</code>`; }
    catch (e) { $('aerr').textContent = e.message; }
  };
}
$('dx').onclick = () => ($('drawer').hidden = true);

/* ── Modal ────────────────────────────────────────────────────────────── */
function modal(html) { $('mbody').innerHTML = html; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; }
function showText(title, text) { modal(`<h2>${esc(title)}</h2><pre class="log">${esc(text)}</pre>`); }
$('mx').onclick = closeModal;
$('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) closeModal(); else if (!$('drawer').hidden) $('drawer').hidden = true; else closeGraph();
});

init().catch((e) => { $('sum').textContent = e.message; });
