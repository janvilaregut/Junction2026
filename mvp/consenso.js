// Katse · Consenso: live view of the multi-agent consensus verifier.
// Events arrive over SSE (/api/consenso/:id/events) and go through a paced queue so
// motion stays legible live, while a replay backlog fast-forwards.
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cut = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');

const PALETTE = ['#B7A4FF', '#7FC8F8', '#70E3B5', '#FFC27A', '#FF8E88', '#E7A8E0', '#9FB3D9', '#C3E88D', '#F2D49B'];
const PHASES = ['resolver', 'comparar', 'debatir', 'veredicto'];
const STATUS = { thinking: 'thinking…', reading: 'reading the code', writing: 'writing', testing: 'running tests', done: 'done', error: 'error' };
const VERDICT = {
  coincide: ['The PR matches the consensus', 'var(--ok)', 'ok'],
  difiere: ['The consensus proposes something else', 'var(--bad)', 'bad'],
  dudoso: ['Unclear', 'var(--warn)', 'warn'],
};
// Minimum time each event stays on screen before the next one is applied (ms).
const PACE = { start: 400, agent: 160, solution: 220, heatmap: 500, groups: 900, phase: 600, debate: 1100, argument: 2200, convinced: 1500, hold: 1100, verdict: 300 };

const arena = $('#arena'), link = $('#link');
let S = fresh();
let es = null, demoTimers = [];
const Q = []; let pumping = false;

function fresh() {
  return { agents: {}, order: [], groups: [], debate: null, solutions: {}, heat: null, debates: [], phase: null, done: false, verdict: null };
}

/* ---------- queue ---------- */
function push(ev) { if (ev && ev.type) { Q.push(ev); if (!pumping) pump(); } }
async function pump() {
  pumping = true;
  while (Q.length) {
    const ev = Q.shift();
    try { apply(ev); } catch (e) { console.error('event', ev.type, e); }
    const d = (PACE[ev.type] || 0) * (Q.length > 6 ? 0.03 : 1);
    if (d) await sleep(d);
  }
  pumping = false;
}

function apply(ev) {
  switch (ev.type) {
    case 'start': return onStart(ev);
    case 'agent': return onAgent(ev);
    case 'solution': return onSolution(ev);
    case 'heatmap': S.heat = ev.heatmap; return renderHeat();
    case 'groups': S.groups = (ev.groups || []).map(g => ({ leader: g.leader, members: uniq([g.leader, ...(g.members || [])]) })); return layout();
    case 'phase': return setPhase(ev.phase, ev.text);
    case 'debate': return onDebate(ev);
    case 'argument': return onArgument(ev);
    case 'convinced': return onConvinced(ev);
    case 'hold': return onHold(ev);
    case 'verdict': return onVerdict(ev);
    case 'done': return onDone();
    case 'error': return onError(ev.message);
  }
}
const uniq = a => [...new Set(a.filter(Boolean))];

/* ---------- run lifecycle ---------- */
function resetView() {
  S = fresh();
  arena.querySelectorAll('.bub').forEach(b => b.remove());
  arena.classList.remove('live');
  link.className = 'link';
  for (const id of ['verdict', 'heat', 'log']) $('#' + id).hidden = true;
  $('#logList').innerHTML = '';
  $('#drawer').hidden = true;
  setPhase(null, 'Connecting…');
}

function onStart(ev) {
  const keepPhase = S.phase;
  S = fresh(); S.phase = keepPhase;
  arena.querySelectorAll('.bub').forEach(b => b.remove());
  (ev.agents || []).forEach((a, i) => {
    const ag = { ...a, color: a.color || PALETTE[i % PALETTE.length], status: 'thinking', text: '' };
    S.agents[a.id] = ag; S.order.push(a.id);
    arena.appendChild(makeBubble(ag, i));
  });
  arena.classList.add('live');
  $('#meta').textContent = [ev.repo, ev.branch && `${ev.branch} → ${ev.base || 'main'}`].filter(Boolean).join(' · ');
  if (!S.phase) setPhase('resolver', ev.prompt ? `Task: ${cut(ev.prompt, 140)}` : 'The agents start solving the task.');
  layout();
}

function onDone() {
  S.done = true;
  setPhase(S.phase, S.verdict ? null : 'Finished.');
  busy(false); loadRuns();
}

function onError(msg) {
  S.done = true; busy(false);
  setPhase(S.phase, '');
  const v = $('#verdict');
  v.style.setProperty('--c', 'var(--bad)');
  v.innerHTML = `<h3>Something went wrong</h3><p class="sum">${esc(msg || 'Unknown error.')}</p>`;
  v.hidden = false;
}

/* ---------- bubbles ---------- */
function makeBubble(a, i) {
  const el = document.createElement('div');
  el.className = 'bub in' + (a.role === 'advocate' ? ' adv' : '');
  el.dataset.id = a.id;
  el.style.setProperty('--c', a.color);
  el.style.setProperty('--d', (-i * 0.9) + 's');
  el.style.setProperty('--x', arena.clientWidth / 2 + 'px');
  el.style.setProperty('--y', arena.clientHeight / 2 + 'px');
  const pm = [a.temperature != null && `t${a.temperature}`, a.topP != null && `p${a.topP}`, a.topK != null && `k${a.topK}`].filter(Boolean).join(' · ');
  el.innerHTML = `<div class="say" role="status"></div>
    <button class="orb" type="button" title="${esc(`${a.name || a.id}${a.model ? ' · ' + a.model : ''}${pm ? ' · ' + pm : ''}`)}" aria-label="View solution by ${esc(a.name || a.id)}"><b>${esc(a.id)}</b><i class="st-dot thinking"></i></button>
    <div class="lab"><span class="nm">${esc(a.name || a.id)}</span>${pm ? `<span class="pm">${esc(pm)}</span>` : ''}<span class="st">${STATUS.thinking}</span></div>`;
  el.querySelector('.orb').onclick = () => openDrawer(a.id);
  const say = el.querySelector('.say');
  say.onclick = () => say.classList.toggle('full');
  return el;
}
const bub = id => arena.querySelector(`.bub[data-id="${CSS.escape(id)}"]`);

function setStatus(id, status, label) {
  const a = S.agents[id], el = bub(id); if (!a || !el) return;
  if (status) a.status = status;
  el.querySelector('.st-dot').className = 'st-dot ' + (a.status || '');
  el.querySelector('.st').textContent = label || STATUS[a.status] || a.status || '';
}

const sayTimers = {};
function say(id, text, { ms = 4200, arg = false } = {}) {
  const el = bub(id); if (!el || !text) return;
  const s = el.querySelector('.say');
  s.textContent = cut(text, 220);
  s.title = String(text);
  s.classList.remove('full');
  s.classList.toggle('arg', arg);
  s.classList.add('show');
  clearTimeout(sayTimers[id]);
  sayTimers[id] = setTimeout(() => { if (!s.matches(':hover') && !s.classList.contains('full')) s.classList.remove('show'); else sayTimers[id] = setTimeout(() => s.classList.remove('show'), ms); }, ms);
}

function groupOf(id) { return S.groups.find(g => g.members.includes(id)); }
function currentGroups() {
  const listed = new Set(S.groups.flatMap(g => g.members));
  return [...S.groups, ...S.order.filter(id => !listed.has(id)).map(id => ({ leader: id, members: [id] }))];
}

// Positions every bubble: groups on an ellipse, members stuck around their leader,
// and the current debate pair pulled to a horizontal face-off near the centre.
function layout() {
  const W = arena.clientWidth, H = arena.clientHeight; if (!W) return;
  const small = W < 560, base = small ? 50 : 66;
  const groups = currentGroups(), n = groups.length;
  const cx = W / 2, cy = H / 2 + (small ? 14 : 18);
  const rx = n < 2 ? 0 : Math.min(W / 2 - (small ? 46 : 96), 330);
  const ry = n < 2 ? 0 : H / 2 - (small ? 92 : 96);
  const P = {};
  groups.forEach((g, i) => {
    const ang = (n === 2 ? Math.PI : -Math.PI / 2) + (i * 2 * Math.PI) / n;
    const m = g.members.length, ls = Math.min(base + 11 * (m - 1), base * 1.6), ms = Math.round(base * 0.56);
    const pad = ls / 2 + (m > 1 ? ms * 0.75 : 0) + 6; // keep orbiting members inside the arena
    const gx = Math.max(pad, Math.min(W - pad, cx + rx * Math.cos(ang))), gy = cy + ry * Math.sin(ang);
    const color = S.agents[g.leader]?.color || PALETTE[0];
    P[g.leader] = { x: gx, y: gy, s: ls, color, leader: true, m, g };
    g.members.filter(id => id !== g.leader).forEach((id, k, arr) => {
      const a2 = -Math.PI / 2 + (k - (arr.length - 1) / 2) * 0.9; // upper arc keeps the label clear
      const r = ls / 2 + ms * 0.22;
      P[id] = { x: gx + r * Math.cos(a2), y: gy + r * Math.sin(a2), s: ms, color, leader: false, m: 1, g };
    });
  });
  const pair = S.debate;
  if (pair && P[pair[0]] && P[pair[1]] && P[pair[0]].g !== P[pair[1]].g) {
    let [a, b] = pair; if (P[a].x > P[b].x) [a, b] = [b, a];
    const mx = ((P[a].x + P[b].x) / 2 + cx) / 2, my = ((P[a].y + P[b].y) / 2 + cy) / 2;
    const gap = Math.max(P[a].s, P[b].s) / 2 + (small ? 30 : 56);
    const shift = (id, tx, ty) => {
      const dx = tx - P[id].x, dy = ty - P[id].y;
      for (const k in P) if (P[k].g === P[id].g) { P[k].x += dx; P[k].y += dy; }
    };
    shift(a, mx - gap, my); shift(b, mx + gap, my);
    const ra = P[a].s / 2, rb = P[b].s / 2, len = Math.max(0, P[b].x - P[a].x - ra - rb);
    link.style.width = len + 'px';
    link.style.transform = `translate(${P[a].x + ra}px, ${P[a].y}px)`;
    link.classList.add('on');
    P[a].side = 'r'; P[b].side = 'l';
  } else link.classList.remove('on', 'win');
  arena.classList.toggle('deb', !!pair);

  for (const id of S.order) {
    const el = bub(id), p = P[id]; if (!el || !p) continue;
    el.style.setProperty('--x', p.x.toFixed(1) + 'px');
    el.style.setProperty('--y', p.y.toFixed(1) + 'px');
    el.style.setProperty('--s', Math.round(p.s) + 'px');
    el.style.setProperty('--c', p.color);
    el.classList.toggle('member', !p.leader);
    el.classList.toggle('debating', !!pair && pair.includes(id));
    const side = p.side || (p.x < W * 0.3 ? 'l' : p.x > W * 0.7 ? 'r' : '');
    el.classList.toggle('l', side === 'l'); el.classList.toggle('r', side === 'r');
    let c = el.querySelector('.cnt');
    if (p.leader && p.m > 1) { if (!c) { c = document.createElement('span'); c.className = 'cnt'; el.querySelector('.orb').appendChild(c); } c.textContent = '×' + p.m; }
    else if (c) c.remove();
  }
}
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 120); });

/* ---------- event handlers ---------- */
function onAgent(ev) {
  if (!S.agents[ev.agent]) return;
  setStatus(ev.agent, ev.status);
  if (ev.text) say(ev.agent, ev.text);
}

function onSolution(ev) {
  S.solutions[ev.agent] = ev;
  const st = ev.stats || {};
  setStatus(ev.agent, 'done', `done · +${st.added ?? 0} −${st.removed ?? 0}`);
  if (!$('#drawer').hidden && $('#drawer').dataset.id === ev.agent) openDrawer(ev.agent);
}

function setPhase(phase, text) {
  if (phase) S.phase = phase;
  const idx = PHASES.indexOf(S.phase);
  $('#steps').querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('on', i === idx && !S.done);
    li.classList.toggle('past', i < idx || (S.done && i <= idx));
  });
  if (text != null) $('#phaseText').textContent = text;
}

// Each `debate` opens a log entry; later events attach to the latest entry of that round with that agent.
function entry(r, who) {
  for (let i = S.debates.length - 1; i >= 0; i--) { const d = S.debates[i]; if (d.round == r && (!who || d.pair.includes(who))) return d; }
  const d = { round: r, pair: [who, '?'], args: [], result: null }; S.debates.push(d); return d;
}

function onDebate(ev) {
  S.debate = ev.pair;
  S.debates.push({ round: ev.round, pair: ev.pair, args: [], result: null });
  ev.pair.forEach(id => setStatus(id, null, 'debating'));
  link.classList.remove('win');
  if (S.phase !== 'debatir') setPhase('debatir');
  $('#phaseText').textContent = `Round ${ev.round ?? ''}: ${nameOf(ev.pair[0])} and ${nameOf(ev.pair[1])} compare their solutions.`;
  layout(); renderLog();
}

function onArgument(ev) {
  entry(ev.round, ev.from).args.push(ev);
  say(ev.from, ev.text, { ms: 9000, arg: true });
  renderLog();
}

function onConvinced(ev) {
  entry(ev.round, ev.winner).result = { ...ev, kind: 'convinced', equivalent: ev.kind === 'equivalent' };
  const w = bub(ev.winner), l = bub(ev.loser);
  link.classList.add('win');
  w?.classList.remove('won'); l?.classList.remove('absorb'); void arena.offsetWidth;
  w?.classList.add('won'); l?.classList.add('absorb');
  // Merge locally; a later `groups` event stays authoritative.
  S.groups = currentGroups().map(g => ({ ...g, members: [...g.members] }));
  const wg = groupOf(ev.winner), lg = groupOf(ev.loser);
  if (wg && wg !== lg) {
    const moving = lg && lg.leader === ev.loser ? lg.members : [ev.loser];
    if (lg) lg.members = lg.members.filter(id => !moving.includes(id));
    S.groups = S.groups.filter(g => g.members.length);
    if (lg && lg.members.length && !lg.members.includes(lg.leader)) lg.leader = lg.members[0];
    wg.members = uniq([...wg.members, ...moving]);
  }
  setStatus(ev.winner, null, 'convinced');
  setStatus(ev.loser, null, `joins ${ev.winner}`);
  if (ev.reason) say(ev.winner, ev.reason, { ms: 5000 });
  $('#phaseText').textContent = `${nameOf(ev.winner)} convinces ${nameOf(ev.loser)}.`;
  S.debate = null;
  setTimeout(layout, 450);
  renderLog();
}

function onHold(ev) {
  entry(ev.round, ev.pair?.[0]).result = { kind: 'hold', ...ev };
  S.debate = null;
  (ev.pair || []).forEach(id => setStatus(id, null, 'holds its position'));
  $('#phaseText').textContent = `${nameOf(ev.pair?.[0])} and ${nameOf(ev.pair?.[1])} can't agree.`;
  if (ev.reason && ev.pair) say(ev.pair[0], ev.reason, { ms: 4500 });
  layout(); renderLog();
}

function onVerdict(ev) {
  S.verdict = ev;
  setPhase('veredicto', 'Verdict ready.');
  const [title, color] = VERDICT[ev.verdict] || VERDICT.dudoso;
  const conf = Math.round((ev.confidence > 1 ? ev.confidence / 100 : ev.confidence || 0) * 100);
  const v = $('#verdict');
  v.style.setProperty('--c', color);
  const members = (ev.members || []).map(nameOf).join(', ');
  v.innerHTML = `<h3>Verdict</h3>
    <div class="big">${esc(title)}</div>
    <div class="conf"><span>Confidence ${conf}%</span><span class="bar"><i style="width:${conf}%"></i></span></div>
    ${ev.summary ? `<p class="sum">${esc(ev.summary)}</p>` : ''}
    ${members ? `<div class="who">Majority group: ${esc(members)}${ev.prInConsensus != null ? ` · the PR ${ev.prInConsensus ? 'is in the majority group with its own code' : ev.prConceded ? 'conceded in the debate: its code was rejected' : 'is not in the majority group'}` : ''}</div>` : ''}
    ${(ev.issues || []).length ? `<ul class="issues">${ev.issues.map(i => `<li>${i.file ? `<code>${esc(i.file)}</code>` : ''}${esc(i.description)}</li>`).join('')}</ul>` : ''}
    ${ev.consensusDiff ? `<details><summary>Consensus diff</summary>${diffHtml(ev.consensusDiff)}</details>` : ''}`;
  v.hidden = false;
  const lead = new Set(ev.members || []);
  S.order.forEach(id => bub(id)?.style.setProperty('opacity', lead.size && !lead.has(id) ? '.55' : '1'));
  setTimeout(() => v.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
}

const nameOf = id => S.agents[id]?.name ? `${S.agents[id].name} (${id})` : (id ?? '?');

/* ---------- panels ---------- */
function diffHtml(diff) {
  const lines = String(diff).split('\n').map(l => {
    const c = /^(\+\+\+|---|diff |index )/.test(l) ? 'm' : l[0] === '+' ? 'a' : l[0] === '-' ? 'r' : l.startsWith('@@') ? 'h' : '';
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  });
  return `<pre class="diff">${lines.join('\n')}</pre>`;
}

function renderHeat() {
  const h = S.heat; if (!h) return;
  const ids = h.agentIds?.length ? h.agentIds : S.order;
  const zones = h.zones || [];
  const pct = v => v == null ? '–' : Math.round((v > 1 ? v / 100 : v) * 100) + '%';
  const rows = zones.map((z, i) => `<tr class="zone" data-i="${i}" title="See what each agent wrote">
      <th class="z">${esc(shortFile(z.file))}<small>${esc(z.start)}–${esc(z.end)}</small></th>
      <td class="pct">${pct(z.agreement)}</td>
      ${ids.map(id => { const c = z.cells?.[id];
        if (!c || !c.touched) return `<td class="c none" title="${esc(id)}: does not touch this zone"></td>`;
        const a = Math.max(0, Math.min(1, c.agree ?? 0));
        return `<td class="c" style="background:rgba(183,164,255,${(0.12 + a * 0.88).toFixed(2)})" title="${esc(id)}: ${Math.round(a * 100)}% agreement"></td>`; }).join('')}
    </tr>`).join('');
  const mx = h.matrix || {};
  const mids = ids.filter(id => mx[id]);
  const matrix = mids.length ? `<div><h3>Similarity between agents</h3>
    <div class="mx" style="grid-template-columns:repeat(${mids.length + 1},30px)"><span></span>${mids.map(id => `<span>${esc(id)}</span>`).join('')}
    ${mids.map(r => `<span>${esc(r)}</span>` + mids.map(c => { const v = r === c ? 1 : Number(mx[r]?.[c] ?? 0);
      return `<span class="v${v < 0.45 ? ' lo' : ''}" style="background:rgba(183,164,255,${(0.08 + v * 0.92).toFixed(2)})" title="${esc(r)}–${esc(c)}: ${Math.round(v * 100)}%">${r === c ? '' : Math.round(v * 100)}</span>`; }).join('')).join('')}
    </div></div>` : '';
  const el = $('#heat');
  el.innerHTML = `<div class="heat-grid"><div style="min-width:0">
      <h3>Where they agree</h3><p class="sub">Each row is a piece of code. Tap a row to see what each agent wrote.</p>
      <div class="hm-wrap"><table class="hm"><thead><tr><th class="z"></th><th></th>${ids.map(id => `<th style="color:${S.agents[id]?.color || ''}">${esc(id)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="legend"><span>less</span><span class="scale"></span><span>more agreement</span><span class="nil"></span><span>not touched</span></div>
    </div>${matrix}</div>`;
  el.hidden = false;
  el.querySelectorAll('tr.zone').forEach(tr => tr.onclick = () => toggleZone(tr, zones[tr.dataset.i], ids));
}
const shortFile = f => String(f ?? '').split('/').slice(-2).join('/');

function toggleZone(tr, z, ids) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains('det')) { next.remove(); tr.classList.remove('open'); return; }
  const cols = ids.filter(id => z.cells?.[id]?.touched).map(id => `<div style="--c:${S.agents[id]?.color || 'var(--acc)'}"><b>${esc(nameOf(id))}</b><pre>${esc(z.cells[id].text || '(empty)')}</pre></div>`);
  if (z.base != null) cols.unshift(`<div class="base"><b style="color:var(--mute)">Base · ${esc(z.file)}:${esc(z.start)}-${esc(z.end)}</b><pre>${esc(z.base || '(empty)')}</pre></div>`);
  const row = document.createElement('tr');
  row.className = 'det';
  row.innerHTML = `<td colspan="${ids.length + 2}"><div class="cmp">${cols.join('') || '<div>No agent touches this zone.</div>'}</div></td>`;
  tr.after(row); tr.classList.add('open');
}

function renderLog() {
  const list = S.debates; if (!list.length) return;
  const nr = new Set(list.map(d => d.round)).size;
  $('#log').hidden = false;
  $('#logN').textContent = `· ${nr} ${nr === 1 ? 'round' : 'rounds'}, ${list.length} ${list.length === 1 ? 'debate' : 'debates'}`;
  $('#logList').innerHTML = list.map(r => {
    const k = r.round ?? '', [a, b] = r.pair;
    const res = r.result?.kind === 'convinced'
      ? `<div class="res ok">${r.result.equivalent ? `${esc(nameOf(r.result.winner))} and ${esc(nameOf(r.result.loser))} are equivalent` : `${esc(nameOf(r.result.winner))} convinces ${esc(nameOf(r.result.loser))}`}${r.result.reason ? ': ' + esc(r.result.reason) : ''}</div>`
      : r.result?.kind === 'hold' ? `<div class="res hold">Each holds its position${r.result.reason ? ': ' + esc(r.result.reason) : ''}</div>` : '';
    return `<li><div class="rh"><small>Round ${esc(k)}</small><b>${esc(nameOf(a))}</b><span class="dim">vs</span><b>${esc(nameOf(b))}</b></div>
      ${r.args.map(x => `<p class="arg"><b style="color:${S.agents[x.from]?.color || 'var(--acc)'}">${esc(x.from)} →</b> ${esc(x.text)}</p>`).join('')}${res}</li>`;
  }).join('');
}

function openDrawer(id) {
  const a = S.agents[id]; if (!a) return;
  const s = S.solutions[id], d = $('#drawer');
  const pm = [a.model, a.temperature != null && `temp ${a.temperature}`, a.topP != null && `topP ${a.topP}`, a.topK != null && `topK ${a.topK}`].filter(Boolean).join(' · ');
  d.dataset.id = id;
  d.style.setProperty('--c', a.color);
  $('#drawerBody').innerHTML = `<div class="who"><span class="mini">${esc(id)}</span><div><h2>${esc(a.name || id)}${a.role === 'advocate' ? ' <span class="dim" style="font-size:12px;font-weight:400">· defends the PR</span>' : ''}</h2><p>${esc(pm)}</p></div></div>
    ${s ? `<h3>Solution</h3>${s.summary ? `<p class="sum">${esc(s.summary)}</p>` : ''}
      ${(s.files || []).length ? `<ul class="files">${s.files.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${s.stats ? `<div class="stat"><span class="a">+${esc(s.stats.added ?? 0)}</span> <span class="r">−${esc(s.stats.removed ?? 0)}</span></div>` : ''}
      ${s.diff ? diffHtml(s.diff) : ''}`
      : `<p class="sum dim">No solution proposed yet. Right now: ${esc(STATUS[a.status] || a.status || '…')}</p>`}`;
  d.hidden = false;
}
$('#drawerClose').onclick = () => { $('#drawer').hidden = true; };
addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').hidden = true; });

/* ---------- networking ---------- */
function busy(on) { const b = $('#go'); b.disabled = on; b.textContent = on ? 'Verifying…' : 'Verify'; }

function connect(id) {
  stopAll(); resetView(); busy(true);
  markRun(id);
  let opened = false;
  const src = new EventSource('/api/consenso/' + encodeURIComponent(id) + '/events');
  es = src;
  src.onopen = () => { if (opened) { Q.length = 0; resetView(); } opened = true; }; // reconnect = full replay
  src.onmessage = m => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    push(ev);
    if (ev.type === 'done' || ev.type === 'error') { src.close(); if (es === src) es = null; }
  };
  src.onerror = () => { if (src.readyState === EventSource.CLOSED && es === src) { es = null; push({ type: 'error', message: "Couldn't connect to this verification. Is the server still running?" }); } };
}

function stopAll() {
  if (es) { es.close(); es = null; }
  demoTimers.forEach(clearTimeout); demoTimers = [];
  Q.length = 0;
}

$('#form').onsubmit = async e => {
  e.preventDefault();
  const body = { repo: $('#repo').value.trim(), branch: $('#branch').value.trim(), base: $('#base').value.trim() || 'main', prompt: $('#prompt').value.trim(), agents: Number($('#agents').value) || 5, lang: 'en' };
  if (DEMO) return runDemo();
  busy(true);
  try {
    const r = await fetch('/api/consenso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new Error(j.error || j.message || `The server returned ${r.status}.`);
    history.replaceState(null, '', '?id=' + encodeURIComponent(j.id));
    connect(j.id); loadRuns();
  } catch (err) { resetView(); onError(err.message); }
};

async function loadRuns() {
  const nav = $('#runs');
  try {
    const r = await fetch('/api/consenso'); if (!r.ok) throw 0;
    const runs = await r.json(); if (!Array.isArray(runs) || !runs.length) throw 0;
    runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    nav.innerHTML = '<span class="lbl">Previous</span>' + runs.slice(0, 12).map(x => {
      const v = x.verdict && typeof x.verdict === 'object' ? x.verdict.verdict : x.verdict;
      const dot = v ? (VERDICT[v]?.[2] || '') : (x.status === 'running' || x.status === 'corriendo' ? 'live' : '');
      return `<button class="run" type="button" data-id="${esc(x.id)}" title="${esc([x.repo, x.status, v && (VERDICT[v]?.[0] || v)].filter(Boolean).join(' · '))}"><i class="${dot}"></i>${esc(x.branch || x.id)}<span class="dim">${esc(ago(x.createdAt))}</span></button>`;
    }).join('');
    nav.hidden = false;
    nav.querySelectorAll('.run').forEach(b => b.onclick = () => { history.replaceState(null, '', '?id=' + encodeURIComponent(b.dataset.id)); connect(b.dataset.id); });
    markRun(qs.get('id') || new URLSearchParams(location.search).get('id'));
  } catch { nav.hidden = true; }
}
function markRun(id) { $('#runs').querySelectorAll('.run').forEach(b => b.classList.toggle('on', b.dataset.id === id)); }
function ago(t) {
  const d = (Date.now() - new Date(t).getTime()) / 1000; if (!isFinite(d)) return '';
  return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : `${Math.floor(d / 86400)} d ago`;
}

/* ---------- demo (?demo=1) ---------- */
function demoScript() {
  const ag = (id, name, t, p, k, role = 'solver') => ({ id, name, model: 'claude-sonnet', temperature: t, topP: p, topK: k, role });
  const agents = [ag('A', 'Cautious', 0.2, 0.9, 20), ag('B', 'Balanced', 0.5, 0.95, 40), ag('C', 'Curious', 0.9, 0.98, 80), ag('D', 'Direct', 0.4, 0.9, 40), ag('E', 'Literal', 0.3, 0.85, 30), { ...ag('PR', 'PR advocate', 0.3, 0.9, 40, 'advocate') }];
  agents.forEach((a, i) => a.color = PALETTE[i]); agents[5].color = '#C9D1E3';
  const good = `diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -12,7 +12,9 @@ export function total(items, coupon) {\n-  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);\n-  return applyTax(subtotal) - discount(coupon);\n+  const cents = items.reduce((s, i) => s + Math.round(i.price * 100) * i.qty, 0);\n+  const net = Math.max(0, cents - discount(coupon) * 100);\n+  return applyTax(net) / 100;\n }`;
  const pr = `diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -12,7 +12,7 @@ export function total(items, coupon) {\n   const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);\n-  return applyTax(subtotal) - discount(coupon);\n+  return Number((applyTax(subtotal) - discount(coupon)).toFixed(2));\n }`;
  const sol = (agent, summary, diff, a, r) => ({ type: 'solution', agent, files: ['src/cart.js', ...(agent === 'B' || agent === 'D' ? ['test/cart.test.js'] : [])], summary, diff, stats: { added: a, removed: r } });
  const cell = (touched, text, cluster, agree) => ({ touched, text, cluster, agree });
  const zone = (id, file, start, end, base, cells, agreement) => ({ id, file, start, end, base, cells, agreement });
  const T1 = 'const cents = items.reduce((s, i) =>\n  s + Math.round(i.price * 100) * i.qty, 0);';
  const T2 = 'return Number((applyTax(subtotal) - discount(coupon)).toFixed(2));';
  const heat = {
    agentIds: ['A', 'B', 'C', 'D', 'E', 'PR'],
    zones: [
      zone('z1', 'src/cart.js', 12, 14, 'const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);', { A: cell(true, T1, 0, 0.9), B: cell(true, T1, 0, 1), C: cell(true, 'const subtotal = sumBy(items, i => i.price * i.qty);', 1, 0.2), D: cell(true, T1, 0, 0.95), E: cell(true, T1, 0, 0.85), PR: cell(false, '', null, 0) }, 0.8),
      zone('z2', 'src/cart.js', 15, 16, 'return applyTax(subtotal) - discount(coupon);', { A: cell(true, 'const net = Math.max(0, cents - discount(coupon) * 100);\nreturn applyTax(net) / 100;', 0, 0.8), B: cell(true, 'const net = Math.max(0, cents - discount(coupon) * 100);\nreturn applyTax(net) / 100;', 0, 1), C: cell(true, T2, 1, 0.4), D: cell(true, 'return applyTax(Math.max(0, cents - discount(coupon) * 100)) / 100;', 0, 0.9), E: cell(true, 'const net = cents - discount(coupon) * 100;\nreturn applyTax(net) / 100;', 0, 0.7), PR: cell(true, T2, 1, 0.35) }, 0.6),
      zone('z3', 'src/tax.js', 5, 9, 'export const applyTax = v => v * 1.21;', { A: cell(false, '', null, 0), B: cell(false, '', null, 0), C: cell(true, 'export const applyTax = v => Math.round(v * 1.21);', 2, 0.1), D: cell(false, '', null, 0), E: cell(false, '', null, 0), PR: cell(false, '', null, 0) }, 0.15),
      zone('z4', 'test/cart.test.js', 1, 30, '', { A: cell(false, '', null, 0), B: cell(true, "test('applies the coupon before VAT', ...)", 0, 0.75), C: cell(false, '', null, 0), D: cell(true, "test('discount before tax', ...)", 0, 0.7), E: cell(false, '', null, 0), PR: cell(false, '', null, 0) }, 0.35),
    ],
    matrix: { A: { B: 0.88, C: 0.31, D: 0.82, E: 0.79, PR: 0.28 }, B: { A: 0.88, C: 0.35, D: 0.91, E: 0.83, PR: 0.3 }, C: { A: 0.31, B: 0.35, D: 0.33, E: 0.3, PR: 0.62 }, D: { A: 0.82, B: 0.91, C: 0.33, E: 0.8, PR: 0.27 }, E: { A: 0.79, B: 0.83, C: 0.3, D: 0.8, PR: 0.25 }, PR: { A: 0.28, B: 0.3, C: 0.62, D: 0.27, E: 0.25 } },
  };
  const ev = [], at = (dt, e) => ev.push([dt, e]);
  at(200, { type: 'start', agents, prompt: 'Fix the cart total: the coupon must be applied before VAT, with no rounding errors.', repo: 'workspace/demo-consenso', branch: 'pr-con-fallo', base: 'main' });
  at(500, { type: 'phase', phase: 'resolver', text: 'Each agent solves the task independently, without seeing the PR.' });
  ['A', 'B', 'C', 'D', 'E'].forEach((id, i) => at(i ? 220 : 400, { type: 'agent', agent: id, status: 'reading', text: ['Opening src/cart.js', 'Reading total() and its tests', 'Checking tax.js too', 'Looking for where discount() is used', 'Reading the task carefully'][i] }));
  at(300, { type: 'agent', agent: 'PR', status: 'reading', text: 'Reading the PR diff to defend it' });
  ['A', 'B', 'C', 'D', 'E'].forEach((id, i) => at(i ? 260 : 1200, { type: 'agent', agent: id, status: 'writing', text: ['Switching everything to cents', 'Discount before VAT, in cents', 'Rounding inside applyTax', 'Adding a coupon test', 'Subtracting the coupon before applying VAT'][i] }));
  at(1400, sol('A', 'Works in cents and subtracts the coupon before VAT.', good, 3, 2));
  at(250, sol('B', 'Integer cents, coupon before VAT, and a test that locks it in.', good + `\ndiff --git a/test/cart.test.js b/test/cart.test.js\n+++ b/test/cart.test.js\n@@ -0,0 +1,3 @@\n+test('applies the coupon before VAT', () => {\n+  expect(total([{ price: 10, qty: 1 }], 'SAVE2')).toBe(9.68);\n+});`, 6, 2));
  at(250, sol('C', 'Rounds the result and moves the rounding into applyTax.', pr.replace('src/cart.js', 'src/cart.js'), 2, 1));
  at(250, sol('D', 'Same as B in a single line, with a test.', good, 5, 2));
  at(250, sol('E', 'Subtracts the coupon before VAT, in cents.', good, 3, 2));
  at(250, sol('PR', 'What the PR proposes: round the total with toFixed(2).', pr, 1, 1));
  at(700, { type: 'phase', phase: 'comparar', text: 'Comparing the solutions zone by zone.' });
  at(900, { type: 'heatmap', heatmap: heat });
  at(700, { type: 'groups', round: 0, groups: [{ leader: 'B', members: ['B', 'D', 'E'] }, { leader: 'A', members: ['A'] }, { leader: 'C', members: ['C'] }, { leader: 'PR', members: ['PR'] }] });
  at(1200, { type: 'phase', phase: 'debatir', text: 'Different groups debate in pairs.' });
  at(800, { type: 'debate', round: 1, pair: ['B', 'A'] });
  at(1200, { type: 'argument', round: 1, from: 'A', to: 'B', text: 'My version leaves the tests alone: the change is minimal and does what the task asks.' });
  at(2400, { type: 'argument', round: 1, from: 'B', to: 'A', text: 'We make the same code change, but without a test the coupon/VAT ordering bug can come back. A three-line test locks it in.' });
  at(2600, { type: 'convinced', round: 1, winner: 'B', loser: 'A', reason: 'Same fix, plus a test that protects it.' });
  at(1200, { type: 'groups', round: 1, groups: [{ leader: 'B', members: ['B', 'D', 'E', 'A'] }, { leader: 'C', members: ['C'] }, { leader: 'PR', members: ['PR'] }] });
  at(1300, { type: 'debate', round: 1, pair: ['PR', 'C'] });
  at(1200, { type: 'argument', round: 1, from: 'PR', to: 'C', text: 'toFixed(2) already drops the extra decimals; the total comes out right in every example in the ticket.' });
  at(2400, { type: 'argument', round: 1, from: 'C', to: 'PR', text: 'I round in applyTax, not at the end. Rounding at the end hides the error but does not fix it.' });
  at(2400, { type: 'hold', round: 1, pair: ['PR', 'C'], reason: 'Both round, but in different places.' });
  at(1500, { type: 'debate', round: 2, pair: ['C', 'PR'] });
  at(1200, { type: 'argument', round: 2, from: 'C', to: 'PR', text: 'Try a €2 coupon with 3 items at €0.10: yours gives 1.63 and the correct total is 1.62. Rounding has to happen earlier.' });
  at(2400, { type: 'argument', round: 2, from: 'PR', to: 'C', text: 'True, with that case my version is off by a cent.' });
  at(2200, { type: 'convinced', round: 2, winner: 'C', loser: 'PR', reason: 'A concrete counterexample breaks the final rounding.' });
  at(1200, { type: 'groups', round: 2, groups: [{ leader: 'B', members: ['B', 'D', 'E', 'A'] }, { leader: 'C', members: ['C', 'PR'] }] });
  at(1600, { type: 'phase', phase: 'veredicto', text: 'Comparing the consensus with the PR.' });
  at(1200, { type: 'verdict', verdict: 'difiere', confidence: 0.82, leader: 'B', members: ['B', 'D', 'E', 'A'], prInConsensus: false,
    summary: 'Four of five agents solve the task by switching to cents and subtracting the coupon before VAT. The PR only rounds the final result, so the coupon is still applied after tax.',
    issues: [{ file: 'src/cart.js', description: 'The coupon is subtracted after applyTax(); the task asks for it to be subtracted before.' }, { file: 'src/cart.js', description: 'toFixed(2) hides the floating-point error instead of avoiding it: some amounts end up off by a cent.' }, { file: 'test/cart.test.js', description: 'The PR adds no test for the coupon/VAT order.' }],
    consensusDiff: good });
  at(400, { type: 'done' });
  return ev;
}

function runDemo() {
  stopAll(); resetView(); busy(true);
  let t = 0;
  for (const [dt, e] of demoScript()) { t += dt; demoTimers.push(setTimeout(() => push(e), t)); }
}

/* ---------- boot ---------- */
setPhase(null);
loadRuns();
if (DEMO) runDemo();
else if (qs.get('id')) connect(qs.get('id'));
