/* Katse · versions. The idea of the product in one picture: the same ticket goes to several AI agents, who
   rebuild the change from the base without seeing the PR. Each version is a lane from the base (left) to its
   end (right): the PR as written on top, one lane per agent below, its bubble writing at the tip. They talk
   (bubbles meet between lanes), an attacker runs the same test on every version, a judge scores the PR.
   Under the lanes, the code map: every region the PR changed, and who else wrote it. Where the versions
   converge you can trust it; where only the PR wrote code, that is what you read.
   Data: the real run (events, brief) and /runs/:id/versions. Uses app.js globals ($, esc, mk, base, S, PAL,
   spring, RM, CAND, VERDICT, modelName, secs, api, openGraph, attach, alive, openSeq, renderBar, store). */
(() => {
  const V = { on: false, p: null, lanes: [], regions: [], sel: null, beats: [], playing: false, live: false, raf: 0, t: 0, g: null, judge: null, atk: null, baseDot: null, cache: {}, tok: 0, hideT: 0, origin: null, runId: null };
  const sec = $('vers'), svg = $('vsvg'), L = $('vlanes'), BL = $('vblobs'), TOP = $('vtop'), MAP = $('vmap');
  const COL = ['#cde4ee', '#e3dcf4', '#bfe3d0', '#f2c6d9'], ATK = '#f2a99f', JUDGE = '#f3e2a6', PRC = '#f5f5f7';
  const brief = () => (S.run?.brief?.version >= 2 ? S.run.brief : null);

  /* ── Geometry: base on the left, lanes fan out to the right, the code map below ── */
  function geom(n) {
    const W = sec.clientWidth || innerWidth, H = sec.clientHeight || innerHeight, narrow = W < 760;
    const bar = $('fbar').getBoundingClientRect().top || H - 100;
    const y0 = narrow ? 130 : Math.max(160, H * 0.2);
    const gap = Math.max(48, Math.min(narrow ? 64 : 104, (H * (narrow ? 0.26 : 0.34)) / Math.max(1, n - 1)));
    const ys = Array.from({ length: n }, (_, i) => y0 + i * gap);
    const bx = narrow ? 26 : 120, by = (ys[0] + ys[ys.length - 1]) / 2;
    const xS = bx + (narrow ? 60 : 130), xE = W - (narrow ? 64 : 300);
    return { W, H, narrow, bar, gap, ys, bx, by, xS, xE, xJ: xE + 170, mapTop: ys[ys.length - 1] + (narrow ? 60 : 96) };
  }
  const lanePath = (g, y) => `M${g.bx} ${g.by} C ${g.bx + (g.xS - g.bx) * 0.55} ${g.by}, ${g.bx + (g.xS - g.bx) * 0.45} ${y}, ${g.xS} ${y} L ${g.xE} ${y}`;

  /* ── Lanes ────────────────────────────────────────────────────────── */
  function makeLane(id, label, color, kind) {
    return { id, label, color, kind, p: 0, tp: 0, status: '', said: '', result: null, ran: null, ghost: kind === 'ghost', dim: false, b: { x: 0, y: 0, r: 0, tr: 0, away: null } };
  }
  function layout(animate) {
    const g = (V.g = geom(V.lanes.length));
    L.innerHTML = ''; BL.innerHTML = ''; TOP.innerHTML = '';
    V.lanes.forEach((l, i) => {
      l.y = g.ys[i];
      const d = lanePath(g, l.y);
      l.path = mk('path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.kind === 'pr' ? 2.6 : 2.2, 'stroke-linecap': 'round', 'stroke-opacity': l.ghost ? 0.25 : 0.95, 'stroke-dasharray': l.ghost ? '3 7' : '', class: 'vlane' }, L);
      l.len = l.path.getTotalLength();
      if (!l.ghost) { l.path.style.strokeDasharray = l.len; l.path.style.strokeDashoffset = l.len * (1 - l.p); }
      l.lab = mk('text', { x: g.xS + 4, y: l.y - 11, class: 'vlab' + (l.ghost ? ' ghost' : '') }, L); l.lab.textContent = l.label;
      l.end = mk('g', { class: 'vend', transform: `translate(${g.xE + 26},${l.y})` }, L);
      l.endC = mk('circle', { r: 9, fill: 'none', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 1.4 }, l.end);
      l.endT = mk('text', { y: 4, 'text-anchor': 'middle', class: 'vendt' }, l.end);
      l.endN = mk('text', { x: 16, y: 4, class: 'vendn' }, l.end);
      l.st = mk('text', { class: 'vst' }, L);
      if (l.kind === 'agent' || l.kind === 'ghost') {
        l.b.el = mk('circle', { r: 0, fill: l.color, class: 'vbub' + (l.ghost ? ' ghost' : '') }, BL);
        l.b.el.onclick = (e) => { e.stopPropagation(); agentCard(l); };
        if (!animate || !l.b.x) { const pt = at(l, l.p); Object.assign(l.b, { x: pt.x, y: pt.y }); }
      }
      paintEnd(l);
    });
    // The base: where every version starts (and the dot the person clicked in the tree).
    V.baseDot = mk('circle', { r: 7, fill: PRC, class: 'vbase' }, TOP);
    mk('text', { x: g.bx, y: g.by + 26, 'text-anchor': 'middle', class: 'vlab dim' }, TOP).textContent = g.narrow ? 'base' : 'base + ticket';
    if (!g.narrow) {
      const j = mk('g', { class: 'vjudge', transform: `translate(${g.xJ},${g.by})` }, TOP);
      V.judgeC = mk('circle', { r: 26, fill: 'none', stroke: JUDGE, 'stroke-width': 1.6, 'stroke-opacity': 0.5 }, j);
      V.judgeT = mk('text', { y: 8, 'text-anchor': 'middle', class: 'vscore' }, j);
      mk('text', { y: 46, 'text-anchor': 'middle', class: 'vlab dim' }, j).textContent = 'judge';
      j.onclick = () => agentCard({ kind: 'judge' });
    }
    if (V.atk) {
      V.atk.el = mk('circle', { r: 0, fill: ATK, class: 'vbub' }, BL);
      V.atk.el.onclick = (e) => { e.stopPropagation(); agentCard({ kind: 'attacker' }); };
      V.atk.lab = mk('text', { 'text-anchor': 'middle', class: 'vlab dim' }, TOP); V.atk.lab.textContent = 'attacker';
      if (!V.atk.x) Object.assign(V.atk, { x: atkHome().x, y: atkHome().y });
    }
    paintJudge(); drawMap();
  }
  const at = (l, p) => { const q = Math.max(0, Math.min(1, p)); const pt = l.path.getPointAtLength(l.len * (l.ghost ? 0.08 : q)); return { x: pt.x, y: pt.y }; };
  const atkHome = () => ({ x: V.g.narrow ? V.g.xE + 26 : V.g.xJ, y: V.g.ys[0] - (V.g.narrow ? 44 : 58) });
  function paintEnd(l) {
    if (!l.endC) return;
    const ok = l.result === 'passed', bad = l.result && !ok;
    l.endC.setAttribute('fill', ok ? PAL.ok : bad ? PAL.bad : 'none');
    l.endC.setAttribute('stroke', ok || bad ? 'none' : 'rgba(255,255,255,.18)');
    l.endT.textContent = ok ? '✓' : bad ? '✕' : '';
    l.endN.textContent = l.ran != null ? `${l.ran} tests` : '';
  }
  function paintJudge() {
    if (!V.judgeT) return;
    const b = brief(), sc = V.score;
    V.judgeT.textContent = sc == null ? '·' : sc;
    V.judgeC.setAttribute('stroke-opacity', sc == null ? 0.35 : 1);
    V.judgeC.setAttribute('fill', sc == null ? 'none' : 'rgba(243,226,166,.12)');
    void b;
  }

  /* ── The code map: every region the PR changed, and who else wrote it ── */
  function regionsFor(data) {
    const kinds = Object.fromEntries([...(brief()?.files || []), ...(S.plan?.files || [])].map((f) => [f.path, f.kind]));
    const rs = (data?.regions || []).map((r) => ({ ...r, kind: kinds[r.file] || r.kind }));
    const merged = [];
    for (const r of rs) { // nearby hunks of the same file, written by the same versions, read as one region
      const m = merged[merged.length - 1];
      if (m && m.file === r.file && r.start - m.end <= 12 && m.who.join() === r.who.join()) Object.assign(m, { end: r.end, lines: m.lines + r.lines, removed: [...m.removed, ...r.removed].slice(0, 40), added: [...m.added, ...r.added].slice(0, 40) });
      else merged.push({ ...r });
    }
    return merged;
  }
  function verdictOf(r) {
    const agents = V.lanes.filter((l) => l.kind === 'agent' && !l.dim).length;
    if (r.kind === 'doc' || r.kind === 'derived') return 'quiet';
    if (r.kind === 'test') return 'tests';
    if (!agents) return 'none';
    return r.who.length >= agents ? 'same' : r.who.length ? 'some' : 'only';
  }
  const VCOL = { same: PAL.ok, some: PAL.file, only: PAL.warn, tests: '#e3dcf4', none: '#3a3a40', quiet: '#2a2a2e' };
  const VTXT = { same: 'every agent wrote this too: reproduced', some: 'some agents wrote this too', only: 'only the PR wrote this: read it', tests: 'the PR’s own tests: checked by running them, red before and green after', none: 'not compared yet', quiet: 'docs or generated' };
  function drawMap() {
    MAP.innerHTML = '';
    const g = V.g; if (!g || !V.regions.length) return;
    const room = g.bar - 34 - g.mapTop; if (room < 70) return;
    const code = V.regions.filter((r) => r.kind !== 'doc' && r.kind !== 'derived');
    const quiet = V.regions.filter((r) => r.kind === 'doc' || r.kind === 'derived');
    const files = [...new Set(code.map((r) => r.file))];
    const order = (f) => -code.filter((r) => r.file === f && verdictOf(r) === 'only').reduce((n, r) => n + r.lines, 0);
    files.sort((a, b) => order(a) - order(b));
    const rowH = 46, maxRows = Math.max(1, Math.floor((room - 30) / rowH) - (quiet.length ? 1 : 0));
    const x0 = g.narrow ? 16 : 110, x1 = g.W - (g.narrow ? 16 : 110), lw = g.narrow ? 0 : 170;
    mk('text', { x: x0, y: g.mapTop, class: 'vmh' }, MAP).textContent = 'Where to look';
    const lg = mk('g', { transform: `translate(${x1},${g.mapTop})` }, MAP);
    [['only', 'only the PR: read it'], ['same', 'agents wrote it too'], ['tests', 'the PR’s tests']].forEach(([k, t], i) => { const gx = -i * 170 - 150; mk('circle', { cx: gx, cy: -4, r: 4, fill: VCOL[k] }, lg); mk('text', { x: gx + 10, y: 0, class: 'vlab dim' }, lg).textContent = t; });
    V.pills = [];
    const rows = files.slice(0, maxRows).map((f) => ({ name: base(f), list: code.filter((r) => r.file === f) }));
    if (files.length > maxRows) rows[rows.length - 1].more = files.length - maxRows;
    if (quiet.length) rows.push({ name: 'docs & generated', list: [], quiet });
    rows.forEach((row, i) => {
      const y = g.mapTop + 26 + i * rowH;
      if (lw) mk('text', { x: x0, y: y + 4, class: 'vfile' }, MAP).textContent = row.name.length > 24 ? row.name.slice(0, 23) + '…' : row.name;
      let x = x0 + lw; const yy = lw ? y : y + 14;
      if (!lw) mk('text', { x: x0, y: y - 2, class: 'vfile' }, MAP).textContent = row.name;
      if (row.quiet) { mk('text', { x, y: yy + 4, class: 'vlab dim' }, MAP).textContent = `${row.quiet.length} ${row.quiet.length === 1 ? 'region' : 'regions'} · not compared`; return; }
      row.list.forEach((r) => {
        const v = verdictOf(r), label = r.start === r.end ? `:${r.start}` : `:${r.start}–${r.end}`;
        const w = Math.max(54, label.length * 7.8 + 22);
        if (x + w > x1) return;
        const pg = mk('g', { class: 'vpill ' + v, transform: `translate(${x},${yy})`, tabindex: 0, role: 'button', 'aria-label': `${base(r.file)} ${label}: ${VTXT[v]}` }, MAP);
        mk('rect', { x: 0, y: -13, width: w, height: 26, rx: 13, fill: VCOL[v] }, pg);
        mk('text', { x: w / 2, y: 4.5, 'text-anchor': 'middle', class: 'vpt' + (v === 'none' || v === 'quiet' ? ' dark' : '') }, pg).textContent = label;
        // who wrote it: one small dot per agent under the pill
        V.lanes.filter((l) => l.kind === 'agent').forEach((l, k, arr) => mk('circle', { cx: w / 2 + (k - (arr.length - 1) / 2) * 9, cy: 20, r: 2.8, fill: r.who.includes(l.id) ? l.color : 'none', stroke: l.color, 'stroke-width': 1 }, pg));
        pg.onclick = (e) => { e.stopPropagation(); showRegion(r); };
        pg.onkeydown = (e) => { if (e.key === 'Enter') showRegion(r); };
        r.el = pg; r.x = x + w / 2; r.y = yy; V.pills.push(r);
        x += w + 8;
      });
      if (row.more) mk('text', { x, y: yy + 4, class: 'vlab dim' }, MAP).textContent = `+${row.more} files`;
    });
    if (V.sel) V.sel.el?.classList.add('sel');
  }

  /* ── Popover: a region's code, or what an agent is doing ──────────── */
  const pop = $('vpop');
  function place(x, y) {
    pop.hidden = false;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(12, Math.min(innerWidth - w - 12, x - w / 2)) + 'px';
    pop.style.top = (y - h - 26 > 70 ? y - h - 26 : y + 30) + 'px';
    requestAnimationFrame(() => pop.classList.add('on'));
  }
  function closePop() { pop.classList.remove('on'); V.sel?.el?.classList.remove('sel'); V.sel = null; setTimeout(() => { if (!pop.classList.contains('on')) pop.hidden = true; }, 200); }
  function showRegion(r) {
    if (!r) return null;
    V.sel?.el?.classList.remove('sel'); V.sel = r; r.el?.classList.add('sel');
    const v = verdictOf(r), names = r.who.map((id) => V.lanes.find((l) => l.id === id)?.label || id);
    const lines = [...r.removed.map((x) => `<span class="r">- ${esc(x)}</span>`), ...r.added.map((x) => `<span class="a">+ ${esc(x)}</span>`)].slice(0, 16);
    pop.innerHTML = `<div class="vk">${esc(base(r.file))} · ${r.start === r.end ? 'line ' + r.start : `lines ${r.start}–${r.end}`}</div>
      <div class="vt"><i style="background:${VCOL[v]}"></i>${esc(VTXT[v])}</div>
      ${names.length ? `<div class="vw">Also written by ${esc(names.join(', '))}</div>` : ''}
      <pre class="code">${lines.join('\n')}${r.removed.length + r.added.length > 16 ? '\n<span class="h">…</span>' : ''}</pre>
      <div class="vb"><button class="cta ghost" id="vdeep">Look deeper here</button></div>`;
    $('vdeep').onclick = (e) => { e.stopPropagation(); lookDeeper(r); };
    place(r.x, r.y);
    return r;
  }
  function agentCard(l) {
    const b = brief();
    let h;
    if (l.kind === 'judge') {
      const v = b?.verdict;
      h = `<div class="vk">Judge · ${esc(modelName(b?.providers?.models?.review || 'gemini-4-carbon'))}</div><div class="vt">${v ? `${v.score?.value ?? '–'}/10 · ${esc(VERDICT[v.status]?.[1] || v.label)}` : 'Waits for the evidence'}</div>${v?.semantic?.explanation ? `<div class="vw">${esc(v.semantic.explanation.split(/(?<=\.)\s/)[0])}</div>` : ''}`;
    } else if (l.kind === 'attacker') {
      const a = b?.attacks?.[0];
      h = `<div class="vk">Attacker · ${esc(modelName(a?.attacker || ''))}</div><div class="vt">${esc(V.atk?.status || 'Writes tests to break the PR')}</div>${a?.hypothesis ? `<div class="vw">${esc(a.hypothesis)}</div>` : ''}`;
    } else {
      h = `<div class="vk">${esc(l.label)}</div><div class="vt">${esc(l.status || (l.ghost ? 'Rebuilds the change when you verify' : 'Waiting'))}</div>${l.said ? `<div class="vw">“${esc(l.said)}”</div>` : ''}<div class="vw dim">${l.kind === 'pr' ? 'The change as written.' : 'Rebuilt from the base with the same ticket, without seeing the PR.'}</div>`;
    }
    pop.innerHTML = h;
    const pt = l.kind === 'judge' ? { x: V.g.xJ, y: V.g.by - 20 } : l.kind === 'attacker' ? V.atk : l.b?.el ? l.b : { x: V.g.xS + 60, y: l.y };
    place(pt.x, pt.y);
  }

  /* ── Beats: what happened in the run, one after another ───────────── */
  const lane = (id) => V.lanes.find((l) => l.id === id);
  function ensureLane(id) {
    let l = lane(id); if (l) return l;
    const ghost = V.lanes.find((x) => x.ghost);
    const i = V.lanes.filter((x) => x.kind === 'agent').length;
    if (ghost) { Object.assign(ghost, { id, label: id, kind: 'agent', ghost: false, color: COL[i % COL.length] }); layout(true); return ghost; }
    l = makeLane(id, id, COL[i % COL.length], 'agent'); V.lanes.push(l); layout(true); return l;
  }
  function apply(e) {
    if (e.type === 'contract') setState(`Contract: ${e.expectations?.length || 0} expectations from the ticket`);
    else if (e.type === 'candidate') {
      const l = ensureLane(e.id);
      if (e.status === 'pending') { l.tp = 0.62; l.status = 'rebuilding from the ticket'; l.b.tr = 10; }
      else if (e.status === 'built') { l.tp = 1; l.status = 'version ready'; }
      else { l.tp = Math.max(l.tp, 0.4); l.status = CAND[e.status] || e.status; l.dim = true; l.b.tr = 6; }
      setState(`${l.label}: ${l.status}`);
    } else if (e.type === 'debate') {
      const l = ensureLane(e.candidate); l.said = (e.round === 'results' ? e.revision || e.risk : e.risk || e.strength) || ''; l.status = e.round === 'results' ? 'revising after the tests' : 'reviewing the other version';
      talk(l, e.round);
    } else if (e.type === 'attack') { attack(e); }
    else if (e.type === 'result') {
      const l = e.version === 'original' ? lane('PR') : lane(e.version);
      if (l) { l.result = e.status; l.ran = e.ran ?? null; if (l.kind === 'agent') l.status = `${e.status} · ${e.ran || 0} tests`; paintEnd(l); }
      setState(`${l?.label || e.version}: ${e.status} · ${e.ran || 0} tests`);
    } else if (e.type === 'judgment') {
      V.score = e.verdict?.score?.value ?? null; paintJudge();
      setState(`Judge: ${VERDICT[e.verdict?.status]?.[1] || e.verdict?.label || 'done'}${V.score != null ? ` · ${V.score}/10` : ''}`);
    }
  }
  const pend = new Map();
  function talk(l, round) { // the two versions meet between their lanes, say one thing each, and go back
    const key = round || 'proposals'; const other = pend.get(key);
    if (!other || other === l) { pend.set(key, l); return; }
    pend.delete(key);
    const mx = V.g.xE - Math.min(260, (V.g.xE - V.g.xS) * 0.35), my = (other.y + l.y) / 2;
    other.b.away = { x: mx, y: my - 12 }; l.b.away = { x: mx, y: my + 12 };
    say(other, other.said, -1); setTimeout(() => say(l, l.said, 1), 450);
    setTimeout(() => { other.b.away = null; l.b.away = null; other.status = l.status = round === 'results' ? 'revised' : 'version ready'; }, 2600);
  }
  function attack(e) {
    const a = V.atk || (V.atk = { x: 0, y: 0, r: 0, tr: 10, status: '' });
    if (!a.el) layout(true);
    a.status = `${e.id}: ${e.status === 'admitted' ? 'test admitted' : e.status === 'invalid' ? 'ruled invalid by the judge' : e.status}`;
    const ends = V.lanes.filter((l) => !l.ghost).map((l) => ({ x: V.g.xE + 26, y: l.y }));
    ends.forEach((pt, i) => setTimeout(() => { a.go = pt; }, i * 260));
    setTimeout(() => { a.go = null; }, ends.length * 260 + 300);
    setState(`Attacker: ${a.status}`);
  }
  function say(l, text, side) {
    if (!text) return;
    const el = document.createElement('div'); el.className = 'dmsg ' + (side < 0 ? 'l' : 'r below'); // one above the meeting, one below
    el.innerHTML = `<div><i style="background:${l.color}"></i><span><b>${esc(l.label)}</b>${esc(text.length > 120 ? text.slice(0, 119) + '…' : text)}</span></div>`;
    $('vsay').appendChild(el); const m = { el, l, below: side > 0 }; V.msgs = [...(V.msgs || []), m];
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
    setTimeout(() => { el.classList.remove('on'); el.classList.add('gone'); setTimeout(() => { el.remove(); V.msgs = V.msgs.filter((x) => x !== m); }, 400); }, 2300);
  }
  function setState(t) { $('vstate').textContent = t; }
  const DUR = { contract: 700, candidate: 650, debate: 1500, attack: 1500, result: 550, judgment: 1200 };
  /* A finished run plays back its own recorded events, compressed to a few seconds. */
  function replay() {
    const r = S.run; if (!r?.events?.length || !brief()) return false;
    resetRun(r);
    const evs = r.events.filter((e) => DUR[e.type]);
    V.playing = true; V.tok++; const tok = V.tok;
    let t = 500;
    $('vreplay').textContent = 'Skip';
    evs.forEach((e) => { setTimeout(() => { if (tok === V.tok && V.on) apply(e); }, t); t += DUR[e.type]; });
    setTimeout(() => { if (tok === V.tok) { V.playing = false; finish(); } }, t + 400);
    return true;
  }
  function skip() { V.tok++; V.playing = false; pend.clear(); resetRun(S.run); (S.run?.events || []).filter((e) => DUR[e.type]).forEach((e) => apply(e)); $('vsay').innerHTML = ''; V.msgs = []; finish(); }
  function finish() {
    const b = brief(); $('vreplay').textContent = 'Replay';
    V.lanes.forEach((l) => { l.b.away = null; if (l.kind === 'agent') l.status = l.dim ? l.status : l.result === 'passed' ? 'its version passes the tests' : l.result ? 'its version fails the tests' : 'version ready'; });
    const noAgents = b && !(b.candidates || []).length;
    if (b?.verdict) setState(`${noAgents ? 'No agent could rebuild it · ' : ''}${VERDICT[b.verdict.status]?.[1] || b.verdict.label}${b.verdict.score?.value != null ? ` · ${b.verdict.score.value}/10` : ''} · ${secs(b.timing?.totalMs || 0)} of real work`);
    drawMap();
  }
  function resetRun(run) {
    pend.clear();
    const b = run?.brief?.version >= 2 ? run.brief : null;
    const cands = (b?.candidates || []).filter((c) => c.status !== 'duplicate');
    V.lanes = [makeLane('PR', 'The PR · as written', PRC, 'pr'), ...cands.map((c, i) => makeLane(c.id, `${c.id} · ${modelName(c.model)}`, COL[i % COL.length], 'agent'))];
    V.lanes[0].p = V.lanes[0].tp = 1;
    V.atk = (b?.attacks?.length) ? { x: 0, y: 0, r: 0, tr: 10, status: 'waiting' } : null;
    V.score = null; layout(false);
  }
  /* No run yet (or one starting): the PR alone, and ghost lanes where the agents will rebuild it. */
  function resetEmpty(n) {
    V.lanes = [makeLane('PR', 'The PR · as written', PRC, 'pr'), ...Array.from({ length: n }, (_, i) => makeLane('ghost' + i, `agent ${i + 1} · rebuilds it from the base`, COL[i % COL.length], 'ghost'))];
    V.lanes[0].p = V.lanes[0].tp = 1; V.atk = null; V.score = null; layout(false);
  }

  /* ── Animation ────────────────────────────────────────────────────── */
  function frame(now) {
    V.raf = requestAnimationFrame(frame);
    const dt = V.t ? Math.min(3, (now - V.t) / 16.667) : 1; V.t = now; const ts = now / 1000;
    if (V.baseDot && V.baseFly) { // the branch's dot from the tree glides to the base
      const f = V.baseFly; spring(f, 'x', f.tx, 0.02, dt); spring(f, 'y', f.ty, 0.02, dt); spring(f, 'r', f.tr, 0.03, dt);
      V.baseDot.setAttribute('cx', f.x.toFixed(1)); V.baseDot.setAttribute('cy', f.y.toFixed(1)); V.baseDot.setAttribute('r', Math.max(0, f.r).toFixed(1));
    }
    V.lanes.forEach((l, i) => {
      if (!l.path) return;
      if (!l.ghost) { l.p += (l.tp - l.p) * (RM ? 1 : 0.035 * dt); l.path.style.strokeDashoffset = (l.len * (1 - l.p)).toFixed(1); }
      if (l.b.el) {
        const home = at(l, l.p), tgt = l.b.away || home, bob = l.ghost || l.p >= 0.99 ? 0 : Math.sin(ts * 3 + i) * 1.5;
        const tr = l.ghost ? 5 : l.b.tr || (l.p > 0.01 ? 10 : 0);
        spring(l.b, 'x', tgt.x, 0.05, dt, 0.8); spring(l.b, 'y', tgt.y + bob, 0.05, dt, 0.8); spring(l.b, 'r', l.b.away ? tr * 1.5 : tr, 0.05, dt, 0.75);
        l.b.el.setAttribute('cx', l.b.x.toFixed(1)); l.b.el.setAttribute('cy', l.b.y.toFixed(1)); l.b.el.setAttribute('r', Math.max(0, l.b.r).toFixed(1));
        l.b.el.style.opacity = l.dim ? 0.45 : 1;
      }
      // What it is doing right now, under its lane, following the tip
      const x = l.b.el ? Math.min(Math.max(l.b.x, V.g.xS + 4), V.g.xE - 120) : V.g.xS + 4;
      l.st.setAttribute('x', x.toFixed(1)); l.st.setAttribute('y', l.y + 20);
      if (l.st.textContent !== (l.kind === 'pr' ? '' : l.status)) l.st.textContent = l.kind === 'pr' ? '' : l.status;
    });
    if (V.atk?.el) {
      const a = V.atk, home = atkHome(), t = a.go || home;
      spring(a, 'x', t.x, 0.07, dt, 0.8); spring(a, 'y', t.y, 0.07, dt, 0.8); spring(a, 'r', a.tr, 0.05, dt);
      a.el.setAttribute('cx', a.x.toFixed(1)); a.el.setAttribute('cy', a.y.toFixed(1)); a.el.setAttribute('r', Math.max(0, a.r).toFixed(1));
      a.lab.setAttribute('x', home.x); a.lab.setAttribute('y', home.y - 18);
    }
    (V.msgs || []).forEach((m) => { m.el.style.left = m.l.b.x + 'px'; m.el.style.top = m.l.b.y + (m.below ? 24 : -22) + 'px'; });
  }
  const run = () => { if (!V.raf) { V.t = 0; V.raf = requestAnimationFrame(frame); } };

  /* ── Open, data, live, close ──────────────────────────────────────── */
  async function load(p) {
    const r = S.run, key = r?.brief?.version >= 2 ? `run:${r.id}` : `pr:${p.id}`;
    if (!V.cache[key]) {
      try { V.cache[key] = await api(r?.brief?.version >= 2 ? `/projects/${S.pid}/runs/${r.id}/versions` : `/projects/${S.pid}/versions?pr=${encodeURIComponent(p.id)}`); }
      catch { V.cache[key] = { regions: [] }; }
    }
    return V.cache[key];
  }
  /* Called by app.js when a branch opens (before its data arrives). */
  function openVersions(p, origin) {
    clearTimeout(V.hideT); V.tok++;
    Object.assign(V, { on: true, p, live: false, playing: false, regions: [], sel: null, origin, msgs: [] });
    $('vsay').innerHTML = ''; pop.hidden = true; pop.classList.remove('on');
    resetEmpty(0);
    const g = V.g;
    V.baseFly = { x: origin?.[0] ?? g.bx, y: origin?.[1] ?? g.by, r: 6.5, tx: g.bx, ty: g.by, tr: 7 };
    V.lanes[0].p = 0; V.lanes[0].tp = 0; setTimeout(() => { if (V.on && V.p === p) V.lanes[0].tp = 1; }, 380);
    setState(''); $('vreplay').hidden = true;
    sec.hidden = false; void sec.offsetWidth; sec.classList.add('on');
    run();
  }
  /* Called when the branch's run (or plan) is known: lanes for the agents, the code map, and a replay. */
  async function versionsData() {
    if (!V.on || !V.p) return;
    if (S.cur?.id === V.p.id) V.p = S.cur; // the list was reloaded: the fresh copy knows it is no longer running
    const p = V.p, tok = ++V.tok;
    const b = brief();
    if (S.es) { goLive(); }
    else if (b) { resetRun(S.run); V.lanes.forEach((l) => { if (l.kind === 'agent') { l.p = 0; l.tp = 0; } }); }
    else { resetEmpty(PROFILE_AGENTS()); setState(S.run?.brief ? 'Only an older quick check · Verify to have agents rebuild it' : `Not reviewed yet${S.plan ? ` · ${S.plan.totals.files} files, +${S.plan.totals.added} −${S.plan.totals.removed}` : ''} · Verify to have agents rebuild it`); }
    if (V.baseFly) Object.assign(V.baseFly, { tx: V.g.bx, ty: V.g.by });
    const data = await load(p);
    if (tok !== V.tok || V.p !== p) return;
    V.regions = regionsFor(data); drawMap();
    if (b && !S.es) { $('vreplay').hidden = false; setTimeout(() => { if (tok === V.tok) replay(); }, 300); }
  }
  const PROFILE_AGENTS = () => (S.profile === 'quick' ? 0 : 2);
  /* A verification is running: lanes follow its events as they arrive. */
  function goLive() {
    V.tok++; V.live = true; V.playing = false; pend.clear();
    resetEmpty(PROFILE_AGENTS()); setState('Starting the review…'); $('vreplay').hidden = true;
  }
  function onEvent(e) { if (V.on && V.live) apply(e); }
  function liveDone() { if (!V.on) return; V.live = false; V.cache = Object.fromEntries(Object.entries(V.cache).filter(([k]) => !k.startsWith('pr:'))); versionsData(); }
  function closeVersions(instant) {
    if (!V.on) return;
    V.on = false; V.tok++; V.live = false; closePop();
    sec.classList.remove('on');
    if (V.baseFly && V.origin) Object.assign(V.baseFly, { tx: V.origin[0], ty: V.origin[1], tr: 6.5 });
    V.lanes.forEach((l) => { l.tp = 0; l.b.away = null; l.b.tr = 0; });
    clearTimeout(V.hideT);
    V.hideT = setTimeout(() => { if (!V.on) { sec.hidden = true; cancelAnimationFrame(V.raf); V.raf = 0; } }, instant ? 0 : 700);
  }

  /* ── Look deeper: the agents go again, Deep, with this region in focus ── */
  async function lookDeeper(r) {
    const seq = openSeq, run0 = S.run;
    closePop(); V.focus = r;
    S.profile = 'deep'; store.set('katse.profile', 'deep');
    S.starting = true; renderBar();
    try {
      const res = run0?.brief?.version >= 2 && run0.brief.contract
        ? await api(`/projects/${S.pid}/runs/${run0.id}/continue`, { body: { profile: 'deep' } })
        : await api(`/projects/${S.pid}/verify`, { body: { pr: S.cur.id, options: { mode: 'completo', profile: 'deep', mutants: 4 } } });
      S.starting = false;
      if (alive(seq)) { goLive(); setState(`Deep review · focus on ${base(r.file)}:${r.start}`); attach(res.runId, seq); }
      return { started: true, runId: res.runId };
    } catch (e) { S.starting = false; if (alive(seq)) renderBar(e.message); return { started: false, error: e.message }; }
  }

  /* ── For the voice assistant ──────────────────────────────────────── */
  function findRegion(q) {
    const s = String(q || '').toLowerCase().trim(), rs = V.pills || [];
    if (!rs.length) return null;
    if (!s || /next|siguiente|first|primer|start|empieza/.test(s)) { const order = sortedRegions(); const i = V.sel ? order.indexOf(V.sel) : -1; return /next|siguiente/.test(s) ? order[(i + 1) % order.length] : order[0]; }
    const m = s.match(/(?:([\w.-]+\.\w+)\s*)?:?\s*(\d+)/);
    if (m) { const n = +m[2]; const pool = rs.filter((r) => !m[1] || base(r.file).toLowerCase().includes(m[1])); return pool.sort((a, b) => Math.min(Math.abs(a.start - n), Math.abs(a.end - n)) - Math.min(Math.abs(b.start - n), Math.abs(b.end - n)))[0] || null; }
    if (/only|solo|read|leer|pr/.test(s)) return rs.find((r) => verdictOf(r) === 'only') || null;
    return rs.find((r) => base(r.file).toLowerCase().includes(s)) || null;
  }
  const RANK = { only: 0, some: 1, none: 2, tests: 3, same: 4, quiet: 5 };
  const sortedRegions = () => [...(V.pills || [])].sort((a, b) => RANK[verdictOf(a)] - RANK[verdictOf(b)] || b.lines - a.lines);
  const regionInfo = (r) => r && { where: `${base(r.file)}:${r.start}${r.end !== r.start ? '-' + r.end : ''}`, file: r.file, lines: r.lines, verdict: verdictOf(r), meaning: VTXT[verdictOf(r)], alsoWrittenBy: r.who, code: [...r.removed.map((x) => '- ' + x), ...r.added.map((x) => '+ ' + x)].slice(0, 24).join('\n') };
  function info() {
    const b = brief();
    return {
      concept: 'The same ticket went to AI agents who rebuilt the change from the base without seeing the PR. Where their versions converge with the PR it is reproduced; where only the PR wrote code, the human reads it.',
      run: b ? { id: S.run.id, verdict: b.verdict?.status, score: b.verdict?.score?.value ?? null, replaying: V.playing } : null, live: V.live,
      versions: V.lanes.filter((l) => !l.ghost).map((l) => ({ id: l.id, name: l.label, doing: l.status || (l.kind === 'pr' ? 'the change as written' : ''), lastSaid: l.said || null, tests: l.result ? `${l.result} (${l.ran ?? '?'} tests)` : null })),
      attacker: V.atk ? V.atk.status : null,
      regions: sortedRegions().slice(0, 14).map(regionInfo),
    };
  }
  function askAgent(q) {
    const s = String(q || '').toLowerCase();
    if (/judge|juez/.test(s)) { agentCard({ kind: 'judge' }); return { agent: 'judge', score: V.score, verdict: VERDICT[brief()?.verdict?.status]?.[1] || brief()?.verdict?.label, says: brief()?.verdict?.semantic?.explanation || null }; }
    if (/attack|atac/.test(s)) { if (!V.atk) return { error: 'No attacker in this run.' }; agentCard({ kind: 'attacker' }); return { agent: 'attacker', doing: V.atk.status, hypothesis: brief()?.attacks?.[0]?.hypothesis || null }; }
    const l = V.lanes.find((x) => !x.ghost && (x.id.toLowerCase() === s || x.label.toLowerCase().includes(s) || s.includes(x.id.toLowerCase()))) || (/\bpr\b|original/.test(s) ? lane('PR') : null);
    if (!l) return { error: `No version called "${q}".`, versions: V.lanes.filter((x) => !x.ghost).map((x) => x.label) };
    agentCard(l);
    return { agent: l.label, doing: l.status || null, lastSaid: l.said || null, tests: l.result ? `${l.result} (${l.ran ?? '?'} tests)` : null };
  }

  $('vreplay').onclick = (e) => { e.stopPropagation(); if (V.playing) skip(); else replay(); };
  sec.addEventListener('click', (e) => { if (!e.target.closest('.vpop, .vpill, .vbub, button')) closePop(); });
  let rz = 0;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (V.on) { layout(false); if (V.baseFly) Object.assign(V.baseFly, { tx: V.g.bx, ty: V.g.by, x: V.g.bx, y: V.g.by }); } }, 150); });

  Object.assign(window, {
    openVersions, versionsData, versionsEvent: onEvent, versionsLiveDone: liveDone, versionsGoLive: () => V.on && goLive(), closeVersions,
    versionsReplay: () => (V.on ? replay() : false), versionsInfo: () => (V.on ? info() : null),
    versionsRegion: (q) => regionInfo(showRegion(findRegion(q))), versionsWhere: () => { const o = sortedRegions(); if (o[0]) showRegion(o[0]); return o.map(regionInfo); },
    versionsAgent: askAgent, versionsDeeper: (q) => { const r = findRegion(q) || V.sel; return r ? lookDeeper(r) : Promise.resolve({ started: false, error: 'Which part? Name a line or a file.' }); },
    versionsEscape: () => (!pop.hidden ? (closePop(), true) : false),
  });
})();
