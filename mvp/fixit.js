/* Katse · Fix it. Asking to fix a spot (or whether it works) turns the graph into a tree that grows from the
   base: every agent that rebuilt the change from the ticket is a branch, its test run sprouts as a twig, the
   attacker crawls in from below, and when two branches meet the camera dives into the junction to watch the
   two agents argue. Everything merges into one trunk that ends in the verdict.
   The story is one timeline: each frame is a pure function of the time, so the camera, the branches and the
   bubbles always stay in step, and Skip / Replay are just a jump in time.
   Data: the real review run (brief v2: candidates, debate, evidence, attacks, verdict); without one, a sample.
   Uses app.js globals: $, esc, mk, base, api, S, G, PAL, CAND, VERDICT, modelName, toScreen, openReview,
   verify, renderBar, RM. */
(() => {
  const F = { open: false, story: null, tl: null, t: 0, raf: 0, last: 0, playing: false, origin: null, focus: null, code: '', hideT: 0, W: 0, H: 0, phone: false, stat: '' };
  const sec = $('fix'), CAM = $('fcam'), WORLD = $('fworld'), SCR = $('fscr'), BLOBS = $('fblobs'), BLUR = $('fgooblur'), SAYS = $('fsays');
  const COL = { PR: '#f5f5f7', ATK: '#f2a99f', cands: ['#cde4ee', '#e3dcf4', '#f2c6d9'] };

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const sm = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const grow = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => { const x = rgb(a), y = rgb(b), q = clamp01(k); return '#' + x.map((v, i) => Math.round(lerp(v, y[i], q)).toString(16).padStart(2, '0')).join(''); };
  const cut = (t, n = 120) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).replace(/[\s,;:]+\S*$/, '') + '…' : x; };
  const speakMs = (s) => Math.max(2000, Math.min(3800, 1100 + s.length * 22));

  /* ── The story: who rebuilt it, who argued with whom, how it ended ── */
  function realStory(b) {
    const ev = (v) => (b.evidence || []).filter((e) => e.version === v).pop();
    const deb = (Array.isArray(b.debate) ? b.debate : b.debate?.entries || []).filter((d) => d.status !== 'incomplete');
    const said = (id, round) => deb.find((d) => d.candidate === id && (d.round || 'proposals') === round);
    const cands = (b.candidates || []).filter((c) => c.status !== 'duplicate').slice(0, 3);
    const agents = cands.map((c, i) => {
      const e = ev(c.id);
      return { id: c.id, model: modelName(c.model), color: COL.cands[i], built: c.status === 'built', fail: c.status === 'built' ? null : CAND[c.status] || c.status, tests: e && e.ran != null ? { ok: e.status === 'passed', ran: e.ran } : null, summary: c.summary };
    });
    const built = agents.filter((a) => a.built), orig = ev('original');
    let j1 = null;
    if (built.length >= 2) {
      const [a, c] = built, L = [];
      const p1 = said(a.id, 'proposals'), p2 = said(c.id, 'proposals'), r1 = said(a.id, 'results'), r2 = said(c.id, 'results');
      L.push([a.id, cut(p1?.risk || p1?.strength || a.summary)]);
      L.push([c.id, cut(p2?.risk || p2?.strength || c.summary)]);
      if (r1) L.push([a.id, cut(r1.revision || r1.risk)]);
      if (r2) L.push([c.id, cut(r2.revision || r2.risk)]);
      j1 = { a: a.id, b: c.id, lines: L.filter((l) => l[1]), badgeAt: 2 };
    }
    const atk = (b.attacks || [])[0], finds = b.verdict?.findings || [];
    const f = atk && finds.find((x) => x.attack === atk.id);
    const onPR = f?.outcomes?.find((o) => o.version === 'original')?.outcome;
    const withTests = built.filter((a) => a.tests);
    const consOk = withTests.length ? withTests.every((a) => a.tests.ok) : null;
    const st = b.verdict?.status;
    const win = st === 'ready-for-human' ? 'PR' : st === 'request-changes' ? 'CONS' : 'none';
    const L2 = [['PR', orig ? (orig.status === 'passed' ? `I pass all ${orig.ran} tests in the suite.` : `My suite run: ${orig.status}, ${orig.ran} tests.`) : 'The change, as written.']];
    if (built.length) L2.push(['CONS', consOk === false ? `Our rebuilds fail the suite. ${cut(built[0].summary, 80)}` : consOk ? `Ours pass too. ${cut(built[0].summary, 80)}` : cut(built[0].summary), atk ? null : 'badge']);
    if (atk) {
      L2.push(['ATK', cut(atk.hypothesis || atk.mission)]);
      L2.push(['ATK', onPR === 'passed' ? 'Refuted. The PR passes it.' : onPR === 'failed' ? 'The PR fails it.' : 'It did not run on the PR in time.', 'badge']);
    }
    if (built.length || atk) L2.push(win === 'PR' ? [built.length ? 'CONS' : 'ATK', built.length ? 'The PR holds up. Take it.' : 'It holds up.'] : win === 'CONS' ? ['PR', 'Fair. I need changes.'] : [built.length ? 'CONS' : 'PR', 'Not enough evidence to decide.']);
    const prOk = atk ? (onPR === 'passed' ? true : onPR === 'failed' ? false : null) : orig ? orig.status === 'passed' : null;
    const facts = [
      orig && `The PR · ${orig.status} · ${orig.ran} tests`,
      ...withTests.map((a) => `${a.id} · ${a.tests.ok ? 'passed' : 'failed'} · ${a.tests.ran} tests`),
      ...agents.filter((a) => !a.built).map((a) => `${a.id} · ${a.fail}`),
      finds.length && `${finds.length} ${finds.length === 1 ? 'attack' : 'attacks'} · ${finds.filter((x) => x.classification === 'refuted').length} refuted`,
    ].filter(Boolean);
    return {
      sample: false, agents, prTests: orig && orig.ran != null ? { ok: orig.status === 'passed', ran: orig.ran } : null, j1, j2: { lines: L2 },
      atk: atk ? { model: modelName(atk.attacker) } : null, prOk, consOk,
      verdict: { score: b.verdict?.score?.value ?? null, label: VERDICT[st]?.[1] || b.verdict?.label || 'Pending', tone: VERDICT[st]?.[0] || 'warn', win, facts },
    };
  }
  function sampleStory() {
    return {
      sample: true,
      agents: [
        { id: 'C1', model: 'Hydrogen', color: COL.cands[0], built: true, tests: { ok: true, ran: 171 } },
        { id: 'C2', model: 'Carbon', color: COL.cands[1], built: true, tests: { ok: false, ran: 171 } },
        { id: 'C3', model: 'Flash', color: COL.cands[2], built: false, fail: 'out of time' },
      ],
      prTests: { ok: true, ran: 171 },
      j1: { a: 'C1', b: 'C2', badgeAt: 2, lines: [
        ['C1', 'Compare the strings, not the references. Two equal keys built at runtime slip through.'],
        ['C2', 'References are enough. Keys come from attributes, so they are interned.'],
        ['C2', 'Fair. Interned only at compile time. Yours passes, mine fails.'],
        ['C1', 'Then we keep the string comparison.'],
      ] },
      j2: { lines: [
        ['PR', 'I pass all 171 tests in the suite.'],
        ['CONS', 'The suite never builds a key at runtime. Our version handles it.'],
        ['ATK', 'Test: two members keyed "id", the second one built with string.Concat.'],
        ['ATK', 'The PR fails it.', 'badge'],
        ['PR', 'Fair. I need changes.'],
      ] },
      atk: { model: 'Hydrogen' }, prOk: false, consOk: true,
      verdict: { score: 4, label: 'Request changes', tone: 'bad', win: 'CONS', facts: ['The PR · fails the attacker’s test', 'C1 + C2 · pass it', 'C3 · out of time'] },
    };
  }

  /* ── The timeline: branches (world space, growing in time), bubbles riding their tips, lines, camera ── */
  function compile(s, W, H) {
    const br = {}, order = [], bub = {}, lines = [];
    const add = (o) => { br[o.id] = o; order.push(o); return o; };
    const B = (id, o) => (bub[id] = { id, r0: 8, segs: [id], wins: [], colors: [], names: [], badges: [], die: null, ...o });
    const ys = {}; s.agents.forEach((a, i) => (ys[a.id] = -60 + i * 120));
    const yA = -60 + Math.max(1, s.agents.length) * 120;
    const built = s.agents.filter((a) => a.built);
    const status = [[0, s.focus ? `Fix it · ${s.focus}` : 'Fix it · agents rebuild the change from the base']];
    let cur = 0;
    const speak = (who, text, role) => { const d = speakMs(text); const L = { who, text, role, t0: cur, t1: cur + d }; lines.push(L); cur += d + 160; return L; };

    add({ id: 'PR', pts: [[0, 0], [150, -180], [900, -180]], color: COL.PR, t0: 300, t1: 2000, w: 1.15, label: 'The PR · as written' });
    B('PR', { name: 'The PR', sub: 'as written', color: COL.PR });
    if (s.prTests) add({ id: 'PRs', pts: [[620, -180], [700, -232]], color: COL.PR, t0: 1600, t1: 2300, spur: s.prTests });
    const arrive = {};
    s.agents.forEach((a, i) => {
      const t0 = 1300 + i * 160, y = ys[a.id];
      B(a.id, { name: a.id, sub: a.model, color: a.color });
      if (a.built) {
        add({ id: a.id, pts: [[0, 0], [150, y], [520, y]], color: a.color, t0, t1: t0 + 2700, label: `${a.id} · ${a.model}` });
        arrive[a.id] = t0 + 2700;
        if (a.tests) add({ id: a.id + 's', pts: [[330, y], [410, y + (i === 0 ? -50 : 50)]], color: a.color, t0: t0 + 1700, t1: t0 + 2400, spur: a.tests });
      } else {
        add({ id: a.id, pts: [[0, 0], [150, y], [400, y]], color: a.color, t0, t1: t0 + 2300, label: `${a.id} · ${a.model}`, dead: a.fail });
        bub[a.id].die = t0 + 2400;
        status.push([t0 + 2300, `${a.id} · ${a.fail}`]);
      }
    });
    if (s.atk) { status.push([2200, 'The attacker writes a test against the PR']); }

    // First junction: the first two agents that built a version compare them and converge.
    let J1 = null, consId = null, consColor = null, yCons = null, m1 = null;
    if (s.j1) {
      const A = s.j1.a, Bb = s.j1.b;
      J1 = [640, (ys[A] + ys[Bb]) / 2];
      let reach = 0;
      built.forEach((a) => { const o = add({ id: a.id + 'j', pts: [[520, ys[a.id]], J1], color: a.color, t0: arrive[a.id], t1: arrive[a.id] + 700 }); bub[a.id].segs.push(o.id); reach = Math.max(reach, o.t1); });
      J1.start = reach + 300; cur = J1.start + 250;
      status.push([reach - 400, `${A} and ${Bb} compare their versions`]);
      s.j1.lines.forEach(([w, text], i) => { if (!bub[w]) return; const L = speak(w, text, w === A ? 'up' : 'down'); if (i === s.j1.badgeAt) L.badge = true; });
      const badgeT = (lines.find((l) => l.badge) || { t0: cur }).t0;
      m1 = [cur, cur + 1000]; cur = m1[1]; J1.end = m1[1];
      consId = A; yCons = J1[1]; consColor = mix(bub[A].color, bub[Bb].color, 0.5);
      built.forEach((a) => {
        const u = bub[a.id];
        u.wins.push({ a: J1.start - 500, b: m1[1], dir: a.id === A ? -1 : 1, big: a.id === A || a.id === Bb, m: m1 });
        u.colors.push({ t: m1[0], dur: 900, color: consColor });
        if (a.tests) u.badges.push({ t0: badgeT, t1: m1[0] + 200, ok: a.tests.ok });
        if (a.id !== A) u.die = m1[1] - 60;
      });
      bub[A].names.push({ t: m1[0] + 500, name: built.map((a) => a.id).join(' + '), sub: 'converged' });
      status.push([m1[0], `${built.map((a) => a.id).join(' and ')} converge`]);
    } else if (built.length === 1) { consId = built[0].id; yCons = ys[consId]; consColor = built[0].color; }

    // Second junction: what the agents agree on (or the attacker) against the PR.
    let J2 = null, m2 = null, END, tv;
    if (consId || s.atk) {
      J2 = [1000, (-180 + (consId ? yCons : yA)) / 2];
      let comeT1;
      if (consId) {
        const from = J1 || [520, yCons], t0 = J1 ? m1[1] - 200 : arrive[consId];
        add({ id: 'M', pts: [from, [800, from[1]], J2], color: consColor, t0, t1: t0 + 2000 });
        bub[consId].segs.push('M'); comeT1 = t0 + 2000;
      } else comeT1 = 5200;
      add({ id: 'PRj', pts: [[900, -180], J2], color: COL.PR, t0: comeT1 - 1300, t1: comeT1 });
      bub.PR.segs.push('PRj');
      if (s.atk) {
        add({ id: 'A', pts: [[0, 0], [150, yA], [800, yA], consId ? [J2[0] - 54, J2[1] + 52] : J2], color: COL.ATK, t0: 2200, t1: comeT1, w: 0.9, label: 'Attacker' });
        B('A', { name: 'Attacker', sub: s.atk.model, color: COL.ATK, r0: 6 });
      }
      J2.start = comeT1 + 300; cur = J2.start + 250;
      const consName = consId ? bub[consId].names.at(-1)?.name || consId : null;
      status.push([comeT1 - 700, consId ? `${consName} against the PR` : 'The attacker against the PR']);
      let badgeT2 = null, atkFirst = null;
      s.j2.lines.forEach(([w, text, flag]) => {
        const who = w === 'CONS' ? consId : w === 'ATK' ? (s.atk ? 'A' : null) : 'PR';
        if (!who || !bub[who]) return;
        const L = speak(who, text, who === 'PR' ? 'up' : who === 'A' && consId ? 'corner' : 'down');
        if (flag === 'badge') badgeT2 = L.t0;
        if (who === 'A' && atkFirst == null) { atkFirst = L.t0; status.push([L.t0, 'The attacker runs its test on every version']); }
      });
      if (s.atk && consId && atkFirst != null) br.A.t1 = Math.max(br.A.t0 + 2000, atkFirst - 300);
      m2 = [cur, cur + 1000]; cur = m2[1]; J2.end = m2[1];
      const win = s.verdict.win;
      const finalColor = win === 'PR' ? COL.PR : win === 'CONS' ? PAL.bad : PAL.warn;
      const winner = win === 'PR' ? 'PR' : consId || (win === 'CONS' && s.atk ? 'A' : 'PR');
      ['PR', consId, s.atk ? 'A' : null].filter(Boolean).forEach((id) => {
        const u = bub[id], dir = id === 'PR' ? -1 : id === 'A' && consId ? 0 : 1;
        u.wins.push({ a: J2.start - 500, b: m2[1], dir, big: dir !== 0, m: m2 });
        if (dir !== 0 || id === winner) u.colors.push({ t: m2[0], dur: 900, color: finalColor });
        if (id !== winner) u.die = m2[1] - 60;
      });
      if (badgeT2 != null) {
        if (s.prOk != null) bub.PR.badges.push({ t0: badgeT2, t1: m2[0] + 200, ok: s.prOk });
        if (consId && s.consOk != null) bub[consId].badges.push({ t0: badgeT2, t1: m2[0] + 200, ok: s.consOk });
      }
      status.push([m2[0], s.verdict.win === 'PR' ? 'They agree: the PR holds up' : s.verdict.win === 'CONS' ? 'They agree: the PR needs changes' : 'No agreement: not enough evidence']);
      END = [J2[0] + 240, J2[1]];
      add({ id: 'T', pts: [J2, END], color: finalColor, t0: m2[1] - 200, t1: m2[1] + 1300, w: 1.35 });
      bub[winner].segs.push('T'); bub[winner].die = br.T.t1 + 80;
      tv = br.T.t1;
    } else {
      END = [1140, -180];
      add({ id: 'T', pts: [[900, -180], END], color: COL.PR, t0: 2300, t1: 3600, w: 1.35 });
      bub.PR.segs.push('T'); bub.PR.die = br.T.t1 + 80; tv = br.T.t1;
    }
    status.push([tv, `Verdict · ${s.verdict.label}${s.verdict.score != null ? ` · ${s.verdict.score}/10` : ''}${s.sample ? ' · sample' : ''}`]);
    status.sort((a, b) => a[0] - b[0]);

    // Camera: frame the growth, dive into each junction, end on the whole tree.
    const sG = Math.min(W / 1050, (H - 150) / 700), sZ = Math.min(W / 470, H / 380);
    const minX = -100, maxX = END[0] + 50, minY = -260, maxY = yA + 30, midY = (minY + maxY) / 2;
    const panel = W >= 760 ? 360 : 0; // the verdict card sits right of the ring (below it on a phone)
    const sF = Math.min((W - 80 - panel) / (maxX - minX), (H - (panel ? 200 : 400)) / (maxY - minY));
    const cam = [{ t: 0, start: true, s: sG * 1.7 }, { t: 1300, x: 440, y: midY, s: sG }];
    const push = (t, x, y, sc) => { if (t > cam[cam.length - 1].t + 60) cam.push({ t, x, y, s: sc }); };
    if (J1) { push(J1.start - 1200, 480, midY, sG); push(J1.start + 150, J1[0] + 70, J1[1], sZ); push(J1.end, J1[0] + 70, J1[1], sZ * 1.07); push(J1.end + 1300, 840, (J1[1] + J2[1]) / 2, sG * 1.08); }
    if (J2) { push(J2.start - 1300, 780, midY, sG); push(J2.start + 150, J2[0] + 70, J2[1], sZ); push(J2.end, J2[0] + 70, J2[1], sZ * 1.07); }
    push(tv + 900, (minX + maxX) / 2 + panel / 2 / sF, midY + (panel ? 0 : (H / 2 - 200) / sF), sF);
    return { br, order, bub: Object.values(bub), lines, status, cam, END, tv, end: tv + 1400, sZ, ys, maxY };
  }

  /* ── Drawing ── */
  function pathD(pts) {
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (y0 === y1) d += ` L${x1} ${y1}`;
      else { const mx = (x0 + x1) / 2; d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`; }
    }
    return d;
  }
  function build() {
    const W = (F.W = innerWidth), H = (F.H = innerHeight); F.phone = W < 760;
    const tl = (F.tl = compile(F.story, W, H));
    $('fsvg').setAttribute('viewBox', `0 0 ${W} ${H}`);
    WORLD.innerHTML = ''; SCR.querySelectorAll(':scope > :not(#fblobs)').forEach((e) => e.remove()); BLOBS.innerHTML = ''; SAYS.innerHTML = '';
    const top = mk('g', {}, SCR);
    for (const b of tl.order) {
      b.g = mk('g', { opacity: 0 }, WORLD);
      const d = pathD(b.pts);
      b.glow = mk('path', { d, fill: 'none', stroke: b.color, 'stroke-opacity': 0.08, 'stroke-linecap': 'butt' }, b.g);
      b.el = mk('path', { d, fill: 'none', stroke: b.color, 'stroke-linecap': 'round' }, b.g);
      b.len = b.el.getTotalLength();
      for (const p of [b.el, b.glow]) { p.style.strokeDasharray = b.len; p.style.strokeDashoffset = b.len; }
      if (b.label) { b.lab = mk('text', { class: 'flab' }, top); b.lab.textContent = b.label; }
      if (b.spur) {
        b.mark = mk('g', { class: 'fbadge', opacity: 0 }, top);
        mk('circle', { r: 9, fill: b.spur.ok ? PAL.ok : PAL.bad }, b.mark);
        mk('text', { y: 4, fill: '#16161a' }, b.mark).textContent = b.spur.ok ? '✓' : '✕';
        mk('text', { x: 16, y: 4, class: 'fcap', 'text-anchor': 'start' }, b.mark).textContent = `${b.spur.ran} tests`;
        b.tip = mk('circle', { r: 3.2, fill: b.color, opacity: 0 }, top);
      }
      if (b.dead) { b.cap = mk('text', { class: 'fcap', opacity: 0 }, top); b.cap.textContent = `✕ ${b.dead}`; }
    }
    tl.baseDot = mk('circle', { r: 7, fill: F.focus ? PAL.bad : COL.PR }, top);
    tl.baseLab = mk('text', { class: 'fcap', 'text-anchor': 'middle' }, top); tl.baseLab.textContent = F.focus ? base(F.focus) : 'base + ticket';
    for (const u of tl.bub) {
      u.el = mk('circle', { r: 0, fill: u.color }, BLOBS);
      u.t1 = mk('text', { class: 'fblab' }, top); u.t2 = mk('text', { class: 'fblab sub' }, top);
      u.badge = mk('g', { class: 'fbadge', opacity: 0 }, top);
      u.badgeC = mk('circle', { r: 11 }, u.badge); u.badgeT = mk('text', { y: 4.5, fill: '#16161a' }, u.badge);
    }
    const v = F.story.verdict, tone = PAL[v.tone] || PAL.warn;
    tl.ring = mk('g', { class: 'fring', opacity: 0 }, top);
    tl.ringC = mk('circle', { r: 30, fill: tone, 'fill-opacity': 0.14, stroke: tone, 'stroke-width': 2 }, tl.ring);
    mk('text', { y: 8, fill: tone }, tl.ring).textContent = v.score ?? '·';
    for (const L of tl.lines) {
      const u = tl.bub.find((x) => x.id === L.who);
      L.el = document.createElement('div'); L.el.className = 'fsay';
      L.el.innerHTML = `<b><i></i><span></span></b>${esc(L.text)}`;
      L.el.querySelector('i').style.background = u.color;
      SAYS.appendChild(L.el); L.u = u;
    }
    renderVerdict();
  }
  function renderVerdict() {
    const s = F.story, v = s.verdict;
    $('fverd').innerHTML = `<div class="fvk">${s.sample ? 'Preview · sample data' : 'Verdict'}</div>
      <div class="fvs"><span class="fvn">${v.score ?? '–'}<small>/10</small></span><span class="fchip" style="background:${PAL[v.tone] || PAL.warn}">${esc(v.label)}</span></div>
      ${F.code ? `<pre class="fcode">${F.code}</pre>` : ''}
      <ul>${v.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="fvb">${s.sample ? '<button class="cta" id="fRun">Run it for real</button>' : `<button class="cta" id="fRev">${S.run?.signoff ? 'View sign-off' : 'Review & sign'}</button>`}<button class="cta ghost" id="fBack">Graph</button></div>`;
    if ($('fRun')) $('fRun').onclick = () => { closeFixit(); verify(); };
    if ($('fRev')) $('fRev').onclick = () => { closeFixit(); openReview(); };
    $('fBack').onclick = () => closeFixit();
  }

  function camAt(t) {
    const K = F.tl.cam;
    const k0 = (k) => (k.start ? { x: -(F.origin[0] - F.W / 2) / k.s, y: -(F.origin[1] - F.H / 2) / k.s, s: k.s } : k);
    if (t <= K[0].t) return k0(K[0]);
    for (let i = 0; i < K.length - 1; i++) {
      if (t < K[i + 1].t) {
        const a = k0(K[i]), b = K[i + 1], q = ease((t - K[i].t) / (b.t - K[i].t));
        return { x: lerp(a.x, b.x, q), y: lerp(a.y, b.y, q), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), q)) };
      }
    }
    return K[K.length - 1];
  }
  const at = (el, x, y) => { el.setAttribute('x', x.toFixed(1)); el.setAttribute('y', y.toFixed(1)); };
  const moveG = (el, x, y) => el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);

  function draw(t, now) {
    const tl = F.tl, W = F.W, H = F.H, c = camAt(t);
    CAM.setAttribute('transform', `translate(${(W / 2 - c.x * c.s).toFixed(2)} ${(H / 2 - c.y * c.s).toFixed(2)}) scale(${c.s.toFixed(4)})`);
    const P = (x, y) => [(x - c.x) * c.s + W / 2, (y - c.y) * c.s + H / 2];
    for (const b of tl.order) {
      const p = clamp01((t - b.t0) / (b.t1 - b.t0)), e = (b.e = grow(p));
      const off = (b.len * (1 - e)).toFixed(1);
      b.el.style.strokeDashoffset = off; b.glow.style.strokeDashoffset = off;
      b.el.setAttribute('stroke-width', ((2.3 * (b.w || 1)) / c.s).toFixed(3)); b.glow.setAttribute('stroke-width', (11 / c.s).toFixed(3));
      const fade = b.dead ? 1 - 0.72 * sm((t - b.t1) / 600) : 1;
      b.g.setAttribute('opacity', t < b.t0 ? 0 : fade);
      if (b.lab) { const [x, y] = P(165, b.pts[1][1] - 13 / c.s); at(b.lab, x, y); b.lab.setAttribute('opacity', (sm((e - 0.08) / 0.2) * fade).toFixed(2)); }
      if (b.spur) {
        const end = b.pts[b.pts.length - 1], [x, y] = P(end[0], end[1]);
        moveG(b.mark, x, y); b.mark.setAttribute('opacity', sm((t - b.t1) / 350).toFixed(2));
        if (p > 0 && p < 1) { const q = b.el.getPointAtLength(b.len * e), [tx, ty] = P(q.x, q.y); b.tip.setAttribute('cx', tx); b.tip.setAttribute('cy', ty); b.tip.setAttribute('opacity', 1); } else b.tip.setAttribute('opacity', 0);
      }
      if (b.cap) { const end = b.pts[b.pts.length - 1], [x, y] = P(end[0], end[1]); at(b.cap, x + 12, y + 4); b.cap.setAttribute('opacity', sm((t - b.t1) / 400).toFixed(2)); }
    }
    { const [x, y] = P(0, 0); tl.baseDot.setAttribute('cx', x); tl.baseDot.setAttribute('cy', y); at(tl.baseLab, x, y - 16); }

    let maxR = 0;
    for (const u of tl.bub) {
      let seg = null; for (const id of u.segs) { const b = tl.br[id]; if (b && t >= b.t0) seg = b; }
      if (!seg || (u.die != null && t > u.die + 420)) { u.el.setAttribute('r', 0); u.t1.setAttribute('opacity', 0); u.t2.setAttribute('opacity', 0); u.badge.setAttribute('opacity', 0); u.on = false; continue; }
      const q = seg.el.getPointAtLength(seg.len * seg.e); let [x, y] = P(q.x, q.y);
      let r = u.r0 * sm((t - tl.br[u.segs[0]].t0) / 450);
      for (const w of u.wins) {
        const ramp = sm((t - w.a) / 700) * (1 - sm((t - w.b) / 800));
        if (ramp <= 0) continue;
        const R = (F.phone ? 34 : 48) * (w.big ? 1 : 0.62);
        r = lerp(u.r0, R, ramp);
        if (w.dir) y += w.dir * R * 0.8 * ramp * (1 - sm((t - w.m[0]) / (w.m[1] - w.m[0])));
      }
      if (u.die != null) r *= 1 - sm((t - u.die) / 400);
      if (r > 20) r += Math.sin(now / 800 + x * 0.01) * r * 0.02;
      let col = u.color; for (const k of u.colors) col = mix(col, k.color, sm((t - k.t) / k.dur));
      u.el.setAttribute('cx', x.toFixed(1)); u.el.setAttribute('cy', y.toFixed(1)); u.el.setAttribute('r', Math.max(0, r).toFixed(1)); u.el.setAttribute('fill', col);
      let nm = { name: u.name, sub: u.sub }; for (const n of u.names) if (t >= n.t) nm = n;
      if (u.t1.textContent !== nm.name) { u.t1.textContent = nm.name; u.t2.textContent = nm.sub || ''; }
      at(u.t1, x, y + (r > 36 ? -1 : 5)); at(u.t2, x, y + 15);
      u.t1.setAttribute('opacity', r > 25 ? 1 : 0); u.t2.setAttribute('opacity', r > 36 ? 1 : 0);
      const bd = u.badges.find((k) => t >= k.t0 - 300 && t < k.t1 + 300);
      if (bd) {
        moveG(u.badge, x + r * 0.72, y - r * 0.72);
        u.badge.setAttribute('opacity', (sm((t - bd.t0) / 300) * (1 - sm((t - bd.t1) / 300))).toFixed(2));
        u.badgeC.setAttribute('fill', bd.ok ? PAL.ok : PAL.bad); u.badgeT.textContent = bd.ok ? '✓' : '✕';
      } else u.badge.setAttribute('opacity', 0);
      Object.assign(u, { sx: x, sy: y, sr: r, col: col, nm, on: true });
      maxR = Math.max(maxR, r);
    }
    BLUR.setAttribute('stdDeviation', Math.max(2.5, maxR * 0.09).toFixed(1));

    for (const L of tl.lines) {
      const on = t >= L.t0 && t < L.t1 && L.u.on;
      if (L.el.classList.contains('on') !== on) L.el.classList.toggle('on', on);
      if (!on) continue;
      const span = L.el.querySelector('span'), label = `${L.u.nm.name}${L.u.nm.sub ? ' · ' + L.u.nm.sub : ''}`;
      if (span.textContent !== label) span.textContent = label;
      const w = L.el.offsetWidth, h = L.el.offsetHeight, { sx: x, sy: y, sr: r } = L.u;
      let left, top;
      if (F.phone) { left = 16; top = H - 250 - h; }
      else if (L.role === 'up') { left = x + r + 18; top = y - h - 4; }
      else if (L.role === 'down') { left = x + r + 18; top = y + 4; }
      else { left = x - w / 2; top = y + r + 14; }
      L.el.style.left = Math.max(16, Math.min(W - w - 16, left)) + 'px';
      L.el.style.top = Math.max(84, Math.min(H - h - 16, top)) + 'px';
    }

    const [ex, ey] = P(tl.END[0], tl.END[1]);
    const rk = sm((t - tl.tv + 150) / 500);
    moveG(tl.ring, ex, ey); tl.ring.setAttribute('opacity', rk.toFixed(2)); tl.ringC.setAttribute('r', (30 * (0.6 + 0.4 * rk)).toFixed(1));
    const vc = $('fverd'), von = t >= tl.tv + 250;
    if (vc.classList.contains('on') !== von) vc.classList.toggle('on', von);
    if (von) {
      const cw = vc.offsetWidth, ch = vc.offsetHeight;
      vc.style.left = (F.phone ? 16 : Math.min(W - cw - 16, ex + 50)) + 'px';
      vc.style.top = (F.phone ? Math.min(H - ch - 16, Math.max(ey + 52, P(0, tl.maxY)[1] + 16)) : Math.max(90, Math.min(H - ch - 110, ey - ch / 2))) + 'px';
    }
    let st = ''; for (const [t0, txt] of tl.status) if (t >= t0) st = txt;
    if (st !== F.stat) { F.stat = st; $('fstat').textContent = st; }
  }

  function frame(now) {
    F.raf = requestAnimationFrame(frame);
    const dt = F.last ? Math.min(64, now - F.last) : 16; F.last = now;
    if (F.playing) { F.t += dt; if (F.t >= F.tl.end) { F.t = F.tl.end; F.playing = false; paintCtl(); } }
    draw(F.t, now);
  }
  function paintCtl() { $('fskip').textContent = F.playing ? 'Skip' : 'Replay'; }
  $('fskip').onclick = () => { if (F.playing) { F.t = F.tl.end; F.playing = false; } else { F.t = 1300; F.playing = true; } paintCtl(); };
  $('fclose').onclick = () => closeFixit();

  /* ── Open / close ── */
  function findZone(q) {
    const s = String(q || '').toLowerCase().trim(); if (!s) return null;
    const zones = [...G.nodes.values()].filter((n) => n.kind === 'zone');
    const m = s.match(/(?:([\w.-]+\.\w+)\s*)?:?\s*(\d+)/);
    if (m) { const n = +m[2]; const pool = zones.filter((z) => !m[1] || z.file.toLowerCase().includes(m[1])); return pool.sort((a, b) => Math.abs(a.start - n) - Math.abs(b.start - n))[0] || null; }
    return zones.find((z) => z.file.toLowerCase().includes(s)) || null;
  }
  async function loadCode(z) {
    F.code = '';
    if (!z) return;
    try {
      const r = S.run, url = r?.brief?.version >= 2 ? `/projects/${S.pid}/runs/${r.id}/versions` : `/projects/${S.pid}/versions?pr=${encodeURIComponent(S.cur.id)}`;
      const data = await api(url);
      const reg = (data.regions || []).filter((x) => base(x.file) === z.file).sort((a, b) => Math.abs(a.start - z.start) - Math.abs(b.start - z.start))[0];
      if (!reg || !F.open) return;
      F.code = [...reg.removed.slice(0, 3).map((x) => `<span class="r">- ${esc(x.trim())}</span>`), ...reg.added.slice(0, 4).map((x) => `<span class="a">+ ${esc(x.trim())}</span>`)].join('\n');
      renderVerdict();
    } catch { /* the code is a nice-to-have */ }
  }
  function openFixit(target = {}) {
    if ($('full').hidden || !S.cur) return null;
    clearTimeout(F.hideT);
    const zone = target.node?.kind === 'zone' ? target.node : findZone(target.query);
    const n = zone || target.node || G.nodes.get('pr');
    F.origin = n ? toScreen(n.x, n.y) : [innerWidth / 2, innerHeight / 2];
    F.focus = zone ? `${zone.file}:${zone.start}` : null;
    const b = S.run?.brief;
    F.story = b?.version >= 2 ? realStory(b) : sampleStory();
    F.story.focus = F.focus; F.code = ''; F.stat = '';
    G.pin = null; G.hover = null; $('tip').classList.remove('on'); $('drawer').hidden = true;
    $('g').style.transformOrigin = `${F.origin[0]}px ${F.origin[1]}px`;
    build();
    F.t = RM ? F.tl.end : 0; F.playing = !RM; F.open = true; paintCtl();
    $('full').classList.add('infix'); sec.hidden = false; void sec.offsetWidth; sec.classList.add('on');
    if (!F.raf) { F.last = 0; F.raf = requestAnimationFrame(frame); }
    loadCode(zone);
    return info();
  }
  function closeFixit(instant) {
    if (!F.open) return false;
    F.open = false; F.playing = false;
    $('full').classList.remove('infix'); sec.classList.remove('on'); $('fverd').classList.remove('on');
    clearTimeout(F.hideT);
    F.hideT = setTimeout(() => { if (!F.open) { sec.hidden = true; cancelAnimationFrame(F.raf); F.raf = 0; } }, instant ? 0 : 650);
    if (typeof renderBar === 'function' && S.cur) renderBar();
    return true;
  }
  function info() {
    const s = F.story; if (!s) return null;
    const who = (id) => F.tl?.bub.find((u) => u.id === id);
    return {
      sample: s.sample, focus: s.focus, playing: F.playing,
      agents: s.agents.map((a) => ({ id: a.id, model: a.model, rebuilt: a.built, failure: a.fail, tests: a.tests ? `${a.tests.ok ? 'passed' : 'failed'} (${a.tests.ran} tests)` : null })),
      debates: (F.tl?.lines || []).map((l) => ({ who: who(l.who)?.names.at(-1)?.name || who(l.who)?.name || l.who, says: l.text })),
      verdict: s.verdict,
    };
  }
  let rz = 0;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (F.open) build(); }, 150); });

  Object.assign(window, {
    openFixit, closeFixit, fixOpen: () => F.open, fixInfo: info,
    fixSkip: () => { if (!F.open) return false; F.t = F.tl.end; F.playing = false; paintCtl(); return true; },
    fixReplay: () => { if (!F.open) return false; F.t = 1300; F.playing = true; paintCtl(); return true; },
    fixEscape: () => (F.open ? closeFixit() : false),
    fixSeek: (t) => { if (!F.open) return false; F.t = Math.max(0, Math.min(F.tl.end, t)); return { t: F.t, end: F.tl.end, verdictAt: F.tl.tv }; },
  });
})();
